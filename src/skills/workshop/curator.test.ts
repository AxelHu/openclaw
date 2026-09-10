import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getSkillCuratorStatus, registerSkillUsageTracking } from "./curator.js";
import { applySkillProposal, proposeCreateSkill } from "./service.js";

let testState: OpenClawTestState;

beforeEach(async () => {
  resetDiagnosticEventsForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-curator-",
  });
});

afterEach(async () => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
});

describe("skill curator usage tracking", () => {
  it("persists trusted skill usage by absolute file identity and increments repeated use", async () => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    const skillFile = testState.path("skills", "daily-brief", "SKILL.md");
    const unregister = registerSkillUsageTracking({ env: testState.env });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const event = {
      type: "skill.used",
      skillName: "Daily Brief",
      skillSource: "workspace",
      activation: "read",
      agentId: "first-agent",
    } as const;

    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();

    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 1_000,
      last_used_at_ms: 1_000,
      use_count: 1,
      last_agent_id: "first-agent",
    });

    now.mockReturnValue(2_000);
    emitTrustedSkillUsedDiagnosticEvent(
      { ...event, agentId: "second-agent" },
      { skillUsage: { skillFile } },
    );
    emitTrustedSkillUsedDiagnosticEvent(event, {
      skillUsage: { skillFile: "skills/relative/SKILL.md" },
    });
    emitDiagnosticEvent({ ...event, skillName: "Untrusted Skill" });
    await waitForDiagnosticEventsDrained();

    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 1_000,
      last_used_at_ms: 2_000,
      use_count: 2,
      last_agent_id: "second-agent",
    });
    expect(database.db.prepare("SELECT count(*) AS count FROM skill_usage").get()).toEqual({
      count: 1,
    });

    now.mockReturnValue(500);
    emitTrustedSkillUsedDiagnosticEvent(
      { ...event, agentId: "earlier-agent" },
      { skillUsage: { skillFile } },
    );
    await waitForDiagnosticEventsDrained();
    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 500,
      last_used_at_ms: 2_000,
      use_count: 3,
      last_agent_id: "second-agent",
    });

    unregister();
    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();
    expect(
      database.db.prepare("SELECT use_count FROM skill_usage WHERE skill_file = ?").get(skillFile),
    ).toEqual({ use_count: 3 });
  });

  it("atomically journals successful activations and deduplicates replay without leaking paths", async () => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    const skillFile = testState.path("skills", "observed", "SKILL.md");
    const unregister = registerSkillUsageTracking({ env: testState.env });
    const event = {
      type: "skill.used",
      skillName: "observed",
      skillSource: "workspace",
      activation: "read",
      runId: "fixture-run",
      toolCallId: "one-call",
      agentId: "one-agent",
      toolName: "read",
    } as const;
    try {
      emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
      emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
      emitTrustedSkillUsedDiagnosticEvent(
        { ...event, toolCallId: "two-call" },
        { skillUsage: { skillFile } },
      );
      await waitForDiagnosticEventsDrained();
      const rows = database.db
        .prepare(
          "SELECT payload_json FROM diagnostic_events WHERE scope = 'skill-usage.v2' AND event_key <> 'recording-state' ORDER BY sequence",
        )
        .all();
      expect(rows).toHaveLength(2);
      const first = JSON.parse(String(rows[0]?.payload_json));
      expect(first).toMatchObject({
        schemaVersion: 2,
        skillName: "observed",
        activation: "read",
        agentId: "one-agent",
      });
      expect(first.skillIdentity).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(rows)).not.toContain(skillFile);
      expect(JSON.stringify(rows)).not.toContain("fixture-run");
      expect(
        database.db
          .prepare("SELECT use_count FROM skill_usage WHERE skill_file = ?")
          .get(skillFile),
      ).toEqual({ use_count: 2 });
      expect(
        database.db
          .prepare(
            "SELECT count(*) AS count FROM diagnostic_events WHERE scope = 'skill-usage.v2' AND event_key = 'recording-state'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      unregister();
    }
  });

  it("reports live usage for existing applied workshop skills and excludes missing files", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.workspaceDir,
      env: testState.env,
      name: "Daily Brief",
      description: "Prepare a daily briefing",
      content: "# Daily Brief\nPrepare the daily briefing.\n",
    });
    const applied = await applySkillProposal({
      workspaceDir: testState.workspaceDir,
      env: testState.env,
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    const skillFile = proposal.record.target.skillFile;
    const database = openOpenClawStateDatabase({ env: testState.env });
    database.db
      .prepare(
        `INSERT INTO skill_usage (
          skill_file, skill_key, skill_name, skill_source,
          first_used_at_ms, last_used_at_ms, use_count, last_agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(skillFile, "daily-brief", "Daily Brief", "workspace", 1_000, 2_000, 3, "main");

    expect(getSkillCuratorStatus({ env: testState.env })).toMatchObject({
      counts: { active: 1, stale: 0, archived: 0 },
      overlaps: [],
      skills: [
        {
          skillFile,
          skillKey: "daily-brief",
          skillName: "Daily Brief",
          state: "active",
          pinned: false,
          createdAtMs: Date.parse(applied.record.appliedAt!),
          stateChangedAtMs: Date.parse(applied.record.appliedAt!),
          lastUsedAtMs: 2_000,
          useCount: 3,
          archivedReason: null,
        },
      ],
    });

    await fs.unlink(skillFile);
    expect(getSkillCuratorStatus({ env: testState.env })).toMatchObject({
      counts: { active: 0, stale: 0, archived: 0 },
      skills: [],
      overlaps: [],
    });
  });
});
