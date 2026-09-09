import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
} from "./session-binding.test-helpers.js";
import {
  buildCodexTurnSupplementalInstructions,
  injectCodexTurnSupplementalInstructions,
} from "./turn-instructions.js";

const identity = { kind: "session" as const, agentId: "fixture", sessionId: "context" };
const snapshot = (revision: string) =>
  buildCodexTurnSupplementalInstructions(
    {},
    {
      turnScopedDeveloperInstructions: `SOUL_${revision}\nIDENTITY_${revision}`,
      memoryDeveloperInstructions: `MEMORY_${revision}`,
      skillsDeveloperInstructions: `<available_skills><skill>skill-${revision}</skill></available_skills>`,
    },
  );
async function fixture() {
  const state = createCodexTestBindingStateStore();
  const store = createCodexAppServerBindingStore(state);
  await store.mutate(identity, {
    kind: "set",
    binding: {
      threadId: "thread-1",
      cwd: "/fixture",
      historyCoveredThrough: "2026-09-08T00:00:00.000Z",
    },
  });
  const client = createFakeCodexAppServerClient();
  const args = {
    client: client.client,
    threadId: "thread-1",
    bindingStore: store,
    bindingIdentity: identity,
    instructions: snapshot("A"),
    timeoutMs: 1000,
  };
  return { state, store, client, args };
}

describe("complete Codex supplemental context", () => {
  it("preserves Unicode and full catalog bytes without a native mode clone", () => {
    const skills =
      "<available_skills>" +
      Array.from(
        { length: 83 },
        (_, i) => `<skill>名称${i} ${"说明".repeat(150)} /fixture/${i}/SKILL.md</skill>`,
      ).join("\n") +
      "</available_skills>";
    const value = buildCodexTurnSupplementalInstructions(
      {},
      {
        turnScopedDeveloperInstructions: "SOUL",
        memoryDeveloperInstructions: "MEMORY",
        skillsDeveloperInstructions: skills,
      },
    );
    expect(value).toContain(skills);
    expect(value.length).toBeGreaterThan(20_701);
    expect(value.match(/<skill>/g)).toHaveLength(83);
    expect(value).not.toContain("# Collaboration Mode: Default");
    expect(value.indexOf("SOUL\n")).toBeLessThan(value.indexOf("MEMORY\n"));
    expect(value.indexOf("MEMORY\n")).toBeLessThan(value.indexOf("<available_skills>"));
  });

  it("deduplicates acknowledged snapshots across native and binding-store recreation", async () => {
    const f = await fixture();
    await injectCodexTurnSupplementalInstructions(f.args);
    await injectCodexTurnSupplementalInstructions(f.args);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    const restarted = createFakeCodexAppServerClient();
    await injectCodexTurnSupplementalInstructions({
      ...f.args,
      client: restarted.client,
      bindingStore: createCodexAppServerBindingStore(f.state),
    });
    expect(restarted.request).not.toHaveBeenCalled();
    const row = await f.store.read(identity);
    expect(row?.supplementalContextFingerprint).toBe(
      createHash("sha256").update(f.args.instructions).digest("hex"),
    );
    expect(row?.historyCoveredThrough).toBe("2026-09-08T00:00:00.000Z");
  });

  it("sends complete replacements for changes, clearing, and A-to-B-to-A", async () => {
    const f = await fixture();
    for (const instructions of [
      snapshot("A"),
      snapshot("B"),
      buildCodexTurnSupplementalInstructions({}, {}),
      snapshot("A"),
    ]) {
      await injectCodexTurnSupplementalInstructions({ ...f.args, instructions });
    }
    expect(f.client.request).toHaveBeenCalledTimes(4);
    const clear = JSON.stringify(f.client.request.mock.calls[2]?.[1]);
    expect(clear).toContain("There are no OpenClaw turn-specific supplements");
    expect(clear).not.toContain("skill-A");
    expect(clear).not.toContain("skill-B");
    expect(clear).toContain("Omitted sections are empty");
  });

  it("never records an unacknowledged injection or automatically retries it", async () => {
    const f = await fixture();
    f.client.request.mockRejectedValueOnce(new Error("fixture indeterminate response"));
    await expect(injectCodexTurnSupplementalInstructions(f.args)).rejects.toThrow(
      "fixture indeterminate response",
    );
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect((await f.store.read(identity))?.supplementalContextFingerprint).toBeUndefined();
  });

  it("does not stamp or inject into another durable thread owner", async () => {
    const f = await fixture();
    await expect(
      injectCodexTurnSupplementalInstructions({ ...f.args, threadId: "other-thread" }),
    ).rejects.toThrow("lost its native thread binding");
    expect(f.client.request).not.toHaveBeenCalled();
    expect((await f.store.read(identity))?.threadId).toBe("thread-1");
  });

  it("keeps an explicitly transient injection out of the preserved binding", async () => {
    const f = await fixture();
    const before = await f.store.read(identity);
    await injectCodexTurnSupplementalInstructions({
      ...f.args,
      threadId: "transient",
      transient: true,
    });
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect(await f.store.read(identity)).toEqual(before);
  });

  it("fences a receipt when ownership changes during the native acknowledgement", async () => {
    const f = await fixture();
    f.client.request.mockImplementationOnce(async () => {
      await f.store.mutate(identity, {
        kind: "set",
        binding: { threadId: "replacement", cwd: "/fixture" },
      });
      return {};
    });
    await expect(injectCodexTurnSupplementalInstructions(f.args)).rejects.toThrow(
      "acknowledgement lost its thread binding",
    );
    expect((await f.store.read(identity))?.supplementalContextFingerprint).toBeUndefined();
    expect((await f.store.read(identity))?.threadId).toBe("replacement");
  });

  it("resends after a compaction receipt is invalidated", async () => {
    const f = await fixture();
    await injectCodexTurnSupplementalInstructions(f.args);
    await f.store.mutate(identity, {
      kind: "patch",
      threadId: "thread-1",
      patch: { supplementalContextFingerprint: undefined },
    });
    await injectCodexTurnSupplementalInstructions(f.args);
    expect(f.client.request).toHaveBeenCalledTimes(2);
  });

  it("keeps cron guidance out of ordinary turns and native mode templates", () => {
    const cron = buildCodexTurnSupplementalInstructions({ trigger: "cron" }, {});
    expect(cron).toContain("This is an OpenClaw cron automation turn");
    expect(cron).not.toContain("# Collaboration Mode:");
    expect(buildCodexTurnSupplementalInstructions({}, {})).not.toContain(
      "This is an OpenClaw cron automation turn",
    );
  });
});
