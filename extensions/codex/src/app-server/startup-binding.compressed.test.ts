import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import {
  resolveCodexAppServerStartupBinding,
  rotateOversizedCodexAppServerStartupBinding,
  writeExistingBinding,
} from "./startup-binding.test-support.js";

describe("Codex compressed startup binding", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compressed-binding-")),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([".jsonl", ".jsonl.zst"])(
    "checks the native %s rollout path without walking the session directories",
    async (suffix) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const rolloutDir = path.join(agentDir, "codex-home", "sessions", "2026", "07", "27");
      const rolloutPath = path.join(rolloutDir, `rollout-thread-existing${suffix}`);
      await fs.mkdir(rolloutDir, { recursive: true });
      const content = Buffer.from("x".repeat(2_000));
      await fs.writeFile(
        rolloutPath,
        suffix.endsWith(".zst") ? zstdCompressSync(content) : content,
      );
      await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
      const readDirectories = vi.spyOn(fs, "readdir");

      const binding = await rotateOversizedCodexAppServerStartupBinding({
        binding: await readCodexAppServerBinding(sessionFile),
        sessionFile,
        agentDir,
        config: {
          agents: {
            defaults: {
              compaction: {
                maxActiveTranscriptBytes: "1k",
              },
            },
          },
        } as never,
      });

      expect(binding).toBeUndefined();
      expect(readDirectories).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
    },
  );

  it.each([".jsonl", ".jsonl.zst", undefined])(
    "reads compressed token snapshots with rollout hint %s",
    async (hintSuffix) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      const plainPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        `${plainPath}.zst`,
        zstdCompressSync(
          Buffer.from(
            [
              JSON.stringify({
                payload: {
                  type: "token_count",
                  info: {
                    last_token_usage: { total_tokens: 390_000 },
                    model_context_window: 400_000,
                  },
                },
              }),
              JSON.stringify({
                payload: {
                  type: "token_count",
                  info: { last_token_usage: { total_tokens: 12_000 } },
                },
              }),
            ].join("\n"),
          ),
        ),
      );
      await writeExistingBinding(
        sessionFile,
        workspaceDir,
        hintSuffix
          ? { rolloutPath: path.join(rolloutDir, `rollout-thread-existing${hintSuffix}`) }
          : {},
      );
      const result = await resolveCodexAppServerStartupBinding({
        binding: await readCodexAppServerBinding(sessionFile),
        sessionFile,
        agentDir,
        config: undefined,
      });
      expect(result.binding?.threadId).toBe("thread-existing");
      expect(result.startupContextTokens).toBe(400_000);
      await expect(fs.readdir(rolloutDir)).resolves.toEqual([path.basename(`${plainPath}.zst`)]);
    },
  );

  it.each([".jsonl.zst", undefined])(
    "prefers a resumed plain rollout over compressed history, hint=%s",
    async (hintSuffix) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      const plainPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
      await fs.mkdir(rolloutDir, { recursive: true });
      const snapshot = (tokens: number) =>
        JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: tokens },
              model_context_window: 400_000,
            },
          },
        });
      await fs.writeFile(`${plainPath}.zst`, zstdCompressSync(Buffer.from(snapshot(390_000))));
      await fs.writeFile(plainPath, snapshot(12_000));
      await writeExistingBinding(
        sessionFile,
        workspaceDir,
        hintSuffix ? { rolloutPath: `${plainPath}.zst` } : {},
      );
      const result = await resolveCodexAppServerStartupBinding({
        binding: await readCodexAppServerBinding(sessionFile),
        sessionFile,
        agentDir,
        config: undefined,
      });
      expect(result.binding?.threadId).toBe("thread-existing");
      expect(result.startupContextTokens).toBe(400_000);
    },
  );

  it.each(["invalid", "truncated"])(
    "fails closed on %s compressed history without clearing the binding",
    async (corruption) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl.zst");
      await fs.mkdir(rolloutDir, { recursive: true });
      const compressed = zstdCompressSync(
        Buffer.from('{"payload":{"type":"token_count","info":{"model_context_window":400000}}}\n'),
      );
      await fs.writeFile(
        rolloutPath,
        corruption === "invalid" ? Buffer.from("not zstd") : compressed.subarray(0, -1),
      );
      await writeExistingBinding(sessionFile, workspaceDir, { rolloutPath });
      await expect(
        resolveCodexAppServerStartupBinding({
          binding: await readCodexAppServerBinding(sessionFile),
          sessionFile,
          agentDir,
          config: undefined,
        }),
      ).rejects.toThrow("Cannot inspect compressed Codex rollout");
      expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-existing");
    },
  );
});
