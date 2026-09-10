import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerSkillUsageTracking } from "./curator.js";
import {
  appendSkillUsageRecord,
  prepareSkillUsageRecord,
  SKILL_USAGE_SCOPE,
  SKILL_USAGE_RECEIPT_SCOPE,
} from "./usage-journal.js";

let state: OpenClawTestState;
beforeEach(async () => {
  resetDiagnosticEventsForTest();
  state = await createOpenClawTestState({ layout: "state-only", prefix: "skill-journal-" });
});
afterEach(async () => {
  resetDiagnosticEventsForTest();
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

function record(ts: number, call = "one", skill = "sample") {
  return prepareSkillUsageRecord(
    {
      type: "skill.used",
      ts,
      seq: 1,
      skillName: skill,
      skillSource: "workspace",
      activation: "read",
      runId: "run",
      toolCallId: call,
    },
    `/fixture/${skill}/SKILL.md`,
    skill,
  );
}
function append(value: ReturnType<typeof record>) {
  return runOpenClawStateWriteTransaction(({ db }) => appendSkillUsageRecord(db, value), {
    env: state.env,
  });
}

describe("skill activation journal", () => {
  it("uses stable replay keys but separates files and activations", () => {
    const a = record(1000);
    expect(record(2000).key).toBe(a.key);
    expect(record(1000, "two").key).not.toBe(a.key);
    expect(record(1000, "one", "other").key).not.toBe(a.key);
    expect(a.payload).not.toContain("/fixture/");
    expect(append(a)).toBe(true);
    expect(append(record(2000))).toBe(false);
  });

  it("advances temporal coverage and rejects evicted replay without touching other scopes", () => {
    const db = openOpenClawStateDatabase({ env: state.env }).db;
    db.prepare("INSERT INTO diagnostic_events VALUES('other','keep','{}',1,1)").run();
    expect(append(record(1_000))).toBe(true);
    const newer = 40 * 86400000;
    expect(append(record(newer, "new"))).toBe(true);
    expect(append(record(1_000))).toBe(false);
    // Diagnostic re-emission stamps now, not the original execution time.
    // The stable key must remain rejected even after the detail is gone.
    expect(append(record(newer + 1_000))).toBe(false);
    const rows = db
      .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
      .all(SKILL_USAGE_SCOPE);
    expect(rows).toHaveLength(2);
    const meta = JSON.parse(
      String(
        db
          .prepare(
            "SELECT payload_json FROM diagnostic_events WHERE scope=? AND event_key='recording-state'",
          )
          .get(SKILL_USAGE_SCOPE)?.payload_json,
      ),
    );
    expect(meta.startedAtMs).toBe(1_000);
    expect(meta.retainedFromMs).toBeGreaterThan(newer - 35 * 86400000);
    expect(
      db.prepare("SELECT count(*) AS n FROM diagnostic_events WHERE scope='other'").get(),
    ).toEqual({ n: 1 });
  });

  it("bounds count retention and does not imply coverage for partially evicted timestamps", () => {
    const db = openOpenClawStateDatabase({ env: state.env }).db;
    append(record(1_000));
    runOpenClawStateWriteTransaction(
      ({ db: transactionDb }) => {
        const insert = transactionDb.prepare(
          "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at,sequence) VALUES(?,?,'{}',1000,1000)",
        );
        for (let n = 0; n < 100_000; n++) {
          insert.run(SKILL_USAGE_SCOPE, `fixture-${n}`);
        }
      },
      { env: state.env },
    );
    expect(append(record(2_000, "new"))).toBe(true);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM diagnostic_events WHERE scope=? AND event_key<>'recording-state'",
        )
        .get(SKILL_USAGE_SCOPE),
    ).toEqual({ n: 1 });
    const meta = JSON.parse(
      String(
        db
          .prepare(
            "SELECT payload_json FROM diagnostic_events WHERE scope=? AND event_key='recording-state'",
          )
          .get(SKILL_USAGE_SCOPE)?.payload_json,
      ),
    );
    expect(meta.retainedFromMs).toBe(1_001);
    expect(append(record(3_000))).toBe(false);
  });

  it("rolls the journal back when the lifetime increment cannot commit", async () => {
    const db = openOpenClawStateDatabase({ env: state.env }).db;
    db.exec(
      "CREATE TRIGGER fixture_failure BEFORE INSERT ON skill_usage BEGIN SELECT RAISE(ABORT,'fixture transaction rejection'); END",
    );
    const off = registerSkillUsageTracking({ env: state.env });
    try {
      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "sample",
          skillSource: "workspace",
          activation: "read",
          runId: "run",
          toolCallId: "call",
        },
        { skillUsage: { skillFile: "/fixture/sample/SKILL.md" } },
      );
      await waitForDiagnosticEventsDrained();
      expect(
        db
          .prepare("SELECT count(*) AS n FROM diagnostic_events WHERE scope=?")
          .get(SKILL_USAGE_SCOPE),
      ).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM skill_usage").get()).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT count(*) AS n FROM diagnostic_events WHERE scope=?")
          .get(SKILL_USAGE_RECEIPT_SCOPE),
      ).toEqual({ n: 0 });
    } finally {
      off();
    }
  });
});
