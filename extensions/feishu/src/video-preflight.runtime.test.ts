// 6/24 PATCH: Tests for feishu video preflight helper.
//
// Covers:
// - Filtering: only video/* MIME types are processed
// - Inline path: files <= inlineMaxBytes are returned as base64
// - Upload path: files > inlineMaxBytes are sent through uploadFile,
//   then referenced as mm_file://{file_id}
// - Failure modes: missing uploadFile for large files, read failure,
//   upload failure — all reported in `failed` list without throwing
// - Decoupling: works with any upload function (no direct minimax import)
//
// See: Agents/multimodal#4, memory/2026-06-24-video-routes.md

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightFeishuVideo } from "./video-preflight.runtime.js";

const emptyConfig = {} as Parameters<typeof preflightFeishuVideo>[0]["cfg"];

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "feishu-video-preflight-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTempFile(content: Buffer | string, ext = "mp4"): string {
  const path = join(tempDir, `video-${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(path, content);
  return path;
}

describe("preflightFeishuVideo - filtering", () => {
  it("returns empty when no video media is present", async () => {
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [
        { path: "/tmp/a.jpg", contentType: "image/jpeg", placeholder: "[Image]" },
        { path: "/tmp/b.mp3", contentType: "audio/mpeg", placeholder: "[Audio]" },
      ],
    });
    expect(result.blocks).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("processes only items with video/* MIME type", async () => {
    const videoPath = writeTempFile(Buffer.from("video-bytes"), "mp4");
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [
        { path: "/tmp/a.jpg", contentType: "image/jpeg", placeholder: "[Image]" },
        { path: videoPath, contentType: "video/mp4", placeholder: "[Video]" },
        { path: "/tmp/c.png", contentType: "image/png", placeholder: "[Image]" },
      ],
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].mimeType).toBe("video/mp4");
  });
});

describe("preflightFeishuVideo - inline path (small files)", () => {
  it("inlines files <= inlineMaxBytes as base64", async () => {
    const videoPath = writeTempFile(Buffer.alloc(1024, 0xab), "mp4"); // 1KB
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      type: "video",
      mimeType: "video/mp4",
      data: Buffer.alloc(1024, 0xab).toString("base64"),
    });
    expect(result.blocks[0].url).toBeUndefined();
  });

  it("inlines with default 50MB threshold when not configured", async () => {
    const videoPath = writeTempFile(Buffer.alloc(1024), "mp4");
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
    });
    // Default is 50MB; 1KB is well under it -> inline
    expect(result.blocks[0].data).toBeDefined();
    expect(result.blocks[0].url).toBeUndefined();
  });

  it("respects custom inlineMaxBytes", async () => {
    const videoPath = writeTempFile(Buffer.alloc(2048), "mp4");
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
      inlineMaxBytes: 1024, // < 2048 -> forces upload path
      uploadFile: vi.fn(async () => ({ file_id: "fake-id-123" })),
    });
    expect(result.blocks[0].url).toBe("mm_file://fake-id-123");
    expect(result.blocks[0].data).toBeUndefined();
  });
});

describe("preflightFeishuVideo - upload path (large files)", () => {
  it("uploads files > inlineMaxBytes and references via mm_file://", async () => {
    const videoPath = writeTempFile(Buffer.alloc(2048), "mp4");
    const uploadFile = vi.fn(async () => ({ file_id: "abc-123" }));
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
      inlineMaxBytes: 1024,
      uploadFile,
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      type: "video",
      mimeType: "video/mp4",
      url: "mm_file://abc-123",
    });
    expect(result.blocks[0].data).toBeUndefined();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const call = uploadFile.mock.calls[0][0];
    expect(call.purpose).toBe("video_understanding");
    expect(call.mimeType).toBe("video/mp4");
    expect(call.buffer.byteLength).toBe(2048);
  });

  it("uses custom videoPurpose when configured", async () => {
    const videoPath = writeTempFile(Buffer.alloc(2048), "mp4");
    const uploadFile = vi.fn(async () => ({ file_id: "abc" }));
    await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
      inlineMaxBytes: 1024,
      videoPurpose: "video_understanding",
      uploadFile,
    });
    expect(uploadFile.mock.calls[0][0].purpose).toBe("video_understanding");
  });

  it("reports failure when uploadFile is missing for oversized video", async () => {
    const videoPath = writeTempFile(Buffer.alloc(2048), "mp4");
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
      inlineMaxBytes: 1024,
      // uploadFile intentionally omitted
    });
    expect(result.blocks).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/exceeds 1024 bytes but no uploadFile/);
    expect(result.failed[0].index).toBe(0);
  });

  it("reports failure when upload throws", async () => {
    const videoPath = writeTempFile(Buffer.alloc(2048), "mp4");
    const uploadFile = vi.fn(async () => {
      throw new Error("network error");
    });
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [{ path: videoPath, contentType: "video/mp4", placeholder: "[Video]" }],
      inlineMaxBytes: 1024,
      uploadFile,
    });
    expect(result.blocks).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/upload failed: Error: network error/);
  });
});

describe("preflightFeishuVideo - mixed media", () => {
  it("processes multiple videos independently", async () => {
    const v1 = writeTempFile(Buffer.alloc(512), "mp4");
    const v2 = writeTempFile(Buffer.alloc(2048), "mp4");
    const uploadFile = vi.fn(async () => ({ file_id: "remote-id" }));
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [
        { path: v1, contentType: "video/mp4", placeholder: "[Video]" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg", placeholder: "[Image]" },
        { path: v2, contentType: "video/quicktime", placeholder: "[Video]" },
      ],
      inlineMaxBytes: 1024,
      uploadFile,
    });
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].data).toBeDefined();
    expect(result.blocks[1].url).toBe("mm_file://remote-id");
    expect(result.blocks[1].mimeType).toBe("video/quicktime");
  });

  it("continues after one media failure (partial success)", async () => {
    const v1 = writeTempFile(Buffer.alloc(1024), "mp4");
    const v2 = writeTempFile(Buffer.alloc(2048), "mp4");
    const uploadFile = vi.fn(async () => ({ file_id: "good" }));
    const result = await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [
        { path: v1, contentType: "video/mp4", placeholder: "[Video]" },
        { path: "/nonexistent/path.mp4", contentType: "video/mp4", placeholder: "[Video]" },
        { path: v2, contentType: "video/mp4", placeholder: "[Video]" },
      ],
      inlineMaxBytes: 512, // v1 also > 512, so all three go to upload
      uploadFile,
    });
    expect(result.blocks).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].index).toBe(1);
  });
});

describe("preflightFeishuVideo - fileName passthrough", () => {
  it("passes fileName to uploadFile when present", async () => {
    const v1 = writeTempFile(Buffer.alloc(2048), "mp4");
    const uploadFile = vi.fn(async () => ({ file_id: "x" }));
    await preflightFeishuVideo({
      cfg: emptyConfig,
      mediaList: [
        {
          path: v1,
          contentType: "video/mp4",
          placeholder: "[Video]",
          fileName: "garden-leak.mp4",
        },
      ],
      inlineMaxBytes: 1024,
      uploadFile,
    });
    expect(uploadFile.mock.calls[0][0].fileName).toBe("garden-leak.mp4");
  });
});
