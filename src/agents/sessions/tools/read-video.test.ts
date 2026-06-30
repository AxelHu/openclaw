// 6/24 PATCH: tests for the readVideo session tool.
//
// Coverage:
// - mp4 / webm / avi detection
// - Inline base64 for small files
// - Over-limit error for large files
// - Unsupported format rejection
// - Read failure handling
// - Abort signal handling
// - Tool surface (name, label, description, prompts)

import { mkdtempSync, openSync, rmSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadVideoToolDefinition, DEFAULT_READ_VIDEO_MAX_BYTES } from "./read-video.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "read-video-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ISO BMFF ftyp box: 4-byte size + 'ftyp' + 'mp42' brand + minor + compat brands
const MP4_FTYP = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftyp"),
  Buffer.from("mp42"),
  Buffer.alloc(4),
  Buffer.from("isommp42avc1"),
  Buffer.alloc(8),
]);

const WEBM_EBML = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);

const AVI_RIFF = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("AVI "),
  Buffer.alloc(20),
]);

function writeMockVideo(name: string, head: Buffer, totalSize: number): string {
  const filePath = join(tempDir, name);
  const fd = openSync(filePath, "w");
  try {
    writeSync(fd, head, 0, head.byteLength, 0);
    const padding = Buffer.alloc(Math.max(0, totalSize - head.byteLength), 0);
    writeSync(fd, padding, 0, padding.byteLength, head.byteLength);
  } finally {
    closeSync(fd);
  }
  return filePath;
}

function writeTextFile(name: string, content: string): string {
  const filePath = join(tempDir, name);
  const fs = require("node:fs");
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("readVideo tool - success path", () => {
  it("returns a video content block for a small mp4 file", async () => {
    const videoPath = writeMockVideo("clip.mp4", MP4_FTYP, 4096);
    const def = createReadVideoToolDefinition(tempDir);
    const result = await def.execute("call_1", { path: videoPath });
    expect(result.details.ok).toBe(true);
    if (!result.details.ok) throw new Error("expected ok");
    expect(result.details.mimeType).toBe("video/mp4");
    expect(result.details.bytes).toBe(4096);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toMatch(/Read video file/);
    expect(result.content[1].type).toBe("video");
    const videoBlock = result.content[1] as {
      type: "video";
      mimeType: string;
      data: string;
      bytes: number;
    };
    expect(videoBlock.mimeType).toBe("video/mp4");
    expect(typeof videoBlock.data).toBe("string");
    expect(Buffer.from(videoBlock.data, "base64").byteLength).toBe(4096);
  });

  it("handles webm files", async () => {
    const videoPath = writeMockVideo("clip.webm", WEBM_EBML, 1024);
    const def = createReadVideoToolDefinition(tempDir);
    const result = await def.execute("call_1", { path: videoPath });
    expect(result.details.ok).toBe(true);
    if (!result.details.ok) throw new Error("expected ok");
    expect(result.details.mimeType).toBe("video/webm");
  });

  it("handles avi files", async () => {
    const videoPath = writeMockVideo("clip.avi", AVI_RIFF, 1024);
    const def = createReadVideoToolDefinition(tempDir);
    const result = await def.execute("call_1", { path: videoPath });
    expect(result.details.ok).toBe(true);
    if (!result.details.ok) throw new Error("expected ok");
    expect(result.details.mimeType).toBe("video/x-msvideo");
  });

  it("honors custom maxBytes (lower than file size)", async () => {
    const videoPath = writeMockVideo("big.mp4", MP4_FTYP, 1024 * 1024);
    const def = createReadVideoToolDefinition(tempDir, {
      defaultMaxBytes: 64 * 1024,
    });
    const result = await def.execute("call_1", { path: videoPath });
    expect(result.details.ok).toBe(false);
    if (result.details.ok) throw new Error("expected not ok");
    expect(result.details.reason).toMatch(/too large/);
    expect(result.details.bytes).toBe(1024 * 1024);
    expect((result.content[0] as { text: string }).text).toMatch(
      /upload the video through the chat channel/i,
    );
  });
});

describe("readVideo tool - failure paths", () => {
  it("rejects non-video files (plain text)", async () => {
    const textPath = writeTextFile("notes.txt", "this is plain text, not a video");
    const def = createReadVideoToolDefinition(tempDir);
    const result = await def.execute("call_1", { path: textPath });
    expect(result.details.ok).toBe(false);
    if (result.details.ok) throw new Error("expected not ok");
    expect(result.details.reason).toMatch(/unsupported/);
  });

  it("rejects files larger than inlineMaxBytes (default 50MB)", async () => {
    // We don't actually allocate 50MB+ — just confirm the constant.
    expect(DEFAULT_READ_VIDEO_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it("rejects missing files", async () => {
    const def = createReadVideoToolDefinition(tempDir);
    await expect(def.execute("call_1", { path: "/nonexistent/path.mp4" })).rejects.toThrow();
  });
});

describe("readVideo tool - abort signal", () => {
  it("rejects immediately when signal is already aborted", async () => {
    const videoPath = writeMockVideo("clip.mp4", MP4_FTYP, 1024);
    const def = createReadVideoToolDefinition(tempDir);
    const controller = new AbortController();
    controller.abort();
    await expect(def.execute("call_1", { path: videoPath }, controller.signal)).rejects.toThrow(
      /aborted/,
    );
  });
});

describe("readVideo tool - tool surface", () => {
  it("declares the right name, label, and prompts", () => {
    const def = createReadVideoToolDefinition(tempDir);
    expect(def.name).toBe("readVideo");
    expect(def.label).toBe("readVideo");
    expect(def.description).toMatch(/video file/i);
    expect(def.description).toMatch(/do NOT use the regular `read`/);
    expect(def.promptSnippet).toMatch(/Read video file/);
    expect(def.promptGuidelines?.length).toBeGreaterThan(0);
  });

  it("does not collide with the read tool name", () => {
    const def = createReadVideoToolDefinition(tempDir);
    expect(def.name).not.toBe("read");
  });
});
