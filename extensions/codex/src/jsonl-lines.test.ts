import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { visitCompressedJsonlLines } from "./jsonl-lines.js";

describe("compressed JSONL streaming", () => {
  it("joins text and UTF-8 characters across frames while ignoring skippable metadata", async () => {
    await withTempDir("codex-zstd-frames-", async (root) => {
      const file = path.join(root, "rollout.jsonl.zst");
      const content = Buffer.from('{"text":"中文"}\r\n{"text":"last"}');
      const split = content.indexOf(Buffer.from("中")) + 1;
      const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
      await fs.writeFile(
        file,
        Buffer.concat([
          zstdCompressSync(content.subarray(0, split)),
          skippable,
          zstdCompressSync(content.subarray(split)),
        ]),
      );
      const lines: string[] = [];
      const result = await visitCompressedJsonlLines(
        file,
        (line) => {
          lines.push(line);
        },
        { chunkBytes: 64 },
      );
      expect(result).toEqual({ ok: true, lineCount: 2, bytes: content.length });
      expect(lines).toEqual(['{"text":"中文"}', '{"text":"last"}']);
    });
  });

  it("rejects a truncated later frame and closes the supplied descriptor", async () => {
    await withTempDir("codex-zstd-truncated-", async (root) => {
      const file = path.join(root, "rollout.jsonl.zst");
      const last = zstdCompressSync(Buffer.from('{"text":"partial"}\n'));
      await fs.writeFile(
        file,
        Buffer.concat([
          zstdCompressSync(Buffer.from('{"text":"complete"}\n')),
          last.subarray(0, -1),
        ]),
      );
      const handle = await fs.open(file, "r");
      const result = await visitCompressedJsonlLines(file, () => {}, { handle, chunkBytes: 64 });
      expect(result.ok).toBe(false);
      expect(handle.fd).toBe(-1);
    });
  });
});
