import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DiagnosticSkillUsedEvent } from "../../infra/diagnostic-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

export const SKILL_USAGE_SCOPE = "skill-usage.v2";
export const SKILL_USAGE_RECEIPT_SCOPE = "skill-usage-receipts.v2";
const STATE_KEY = "recording-state";
const RETENTION_MS = 35 * 24 * 60 * 60 * 1_000;
const MAX_EVENTS = 100_000;
const PROCESS_EPOCH = randomUUID();
type Store = Pick<DB, "diagnostic_events">;
type RecordingState = {
  schemaVersion: 2;
  startedAtMs: number;
  retainedFromMs: number;
  prunedThroughMs: number;
  lastObservedAtMs: number;
};

export function prepareSkillUsageRecord(
  event: DiagnosticSkillUsedEvent,
  skillFile: string,
  skillKey: string,
) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const skillIdentity = hash(skillFile);
  // Runtime completion replays share run/call identity. Events without those
  // fields remain distinct emissions; their process-local seq is not a durable ID.
  const execution =
    event.runId && event.toolCallId
      ? [event.agentId ?? "", event.runId, event.toolCallId]
      : [PROCESS_EPOCH, event.seq];
  const key = hash(JSON.stringify([execution, skillIdentity, event.activation]));
  const value = {
    schemaVersion: 2,
    occurredAtMs: event.ts,
    skillIdentity,
    skillKey,
    skillName: event.skillName,
    skillSource: event.skillSource,
    activation: event.activation,
    agentId: event.agentId ?? null,
    toolName: event.toolName ?? null,
  };
  return { key, payload: JSON.stringify(value), occurredAtMs: event.ts };
}

/** Called inside the same transaction as the lifetime increment, never before it.
 * The existing scoped audit table supplies bounded detail without a schema change.
 * A separate minimal receipt outlives bounded detail. Trusted re-emission can
 * carry a fresh timestamp, so a time watermark alone cannot prevent old replay.
 */
export function appendSkillUsageRecord(
  db: DatabaseSync,
  record: ReturnType<typeof prepareSkillUsageRecord>,
): boolean {
  const k = getNodeSqliteKysely<Store>(db);
  const stored = executeSqliteQuerySync(
    db,
    k
      .selectFrom("diagnostic_events")
      .select("payload_json")
      .where("scope", "=", SKILL_USAGE_SCOPE)
      .where("event_key", "=", STATE_KEY),
  ).rows[0];
  const state: RecordingState = stored
    ? JSON.parse(stored.payload_json)
    : {
        schemaVersion: 2,
        startedAtMs: record.occurredAtMs,
        retainedFromMs: record.occurredAtMs,
        prunedThroughMs: 0,
        lastObservedAtMs: record.occurredAtMs,
      };
  if (state.schemaVersion !== 2 || !Number.isFinite(state.startedAtMs)) {
    throw new Error("Invalid skill usage recording state");
  }
  const newest = Math.max(state.lastObservedAtMs, record.occurredAtMs);
  const cutoff = Math.max(state.prunedThroughMs, newest - RETENTION_MS);
  if (record.occurredAtMs <= cutoff) {
    return false;
  }
  const receipt = executeSqliteQuerySync(
    db,
    k
      .insertInto("diagnostic_events")
      .values({
        scope: SKILL_USAGE_RECEIPT_SCOPE,
        event_key: record.key,
        payload_json: "{}",
        created_at: record.occurredAtMs,
        sequence: record.occurredAtMs,
      })
      .onConflict((c) => c.columns(["scope", "event_key"]).doNothing())
      .returning("event_key"),
  ).rows;
  if (receipt.length === 0) {
    return false;
  }
  const inserted = executeSqliteQuerySync(
    db,
    k
      .insertInto("diagnostic_events")
      .values({
        scope: SKILL_USAGE_SCOPE,
        event_key: record.key,
        payload_json: record.payload,
        created_at: record.occurredAtMs,
        sequence: record.occurredAtMs,
      })
      .onConflict((c) => c.columns(["scope", "event_key"]).doNothing())
      .returning("event_key"),
  ).rows;
  if (inserted.length === 0) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    k
      .deleteFrom("diagnostic_events")
      .where("scope", "=", SKILL_USAGE_SCOPE)
      .where("event_key", "!=", STATE_KEY)
      .where("sequence", "<=", cutoff),
  );
  const overflow = executeSqliteQuerySync(
    db,
    k
      .selectFrom("diagnostic_events")
      .select(["event_key", "created_at"])
      .where("scope", "=", SKILL_USAGE_SCOPE)
      .where("event_key", "!=", STATE_KEY)
      .orderBy("sequence", "desc")
      .orderBy("event_key", "desc")
      .offset(MAX_EVENTS)
      .limit(1),
  ).rows[0];
  const prunedThrough = Math.max(cutoff, overflow?.created_at ?? 0);
  if (overflow) {
    // Remove the whole timestamp bucket, conservatively marking that instant as
    // incomplete. Retained events never imply coverage for evicted siblings.
    executeSqliteQuerySync(
      db,
      k
        .deleteFrom("diagnostic_events")
        .where("scope", "=", SKILL_USAGE_SCOPE)
        .where("event_key", "!=", STATE_KEY)
        .where("sequence", "<=", prunedThrough),
    );
  }
  const next: RecordingState = {
    ...state,
    lastObservedAtMs: newest,
    prunedThroughMs: prunedThrough,
    retainedFromMs: Math.max(state.retainedFromMs, prunedThrough + 1),
  };
  executeSqliteQuerySync(
    db,
    k
      .insertInto("diagnostic_events")
      .values({
        scope: SKILL_USAGE_SCOPE,
        event_key: STATE_KEY,
        payload_json: JSON.stringify(next),
        created_at: state.startedAtMs,
        sequence: 0,
      })
      .onConflict((c) =>
        c.columns(["scope", "event_key"]).doUpdateSet({ payload_json: JSON.stringify(next) }),
      ),
  );
  return true;
}
