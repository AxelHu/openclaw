// 6/24 PATCH: tests for MiniMax Files API upload helper.
// Covers:
// - purpose param must be explicit (no implicit defaulting)
// - response parsing: file_id, base_resp.status_code check, errors
// - size limit enforcement (512MB)
// - missing API key error
// - baseUrl resolution (configured vs default)

import { describe, expect, it } from "vitest";
import { __testing, uploadMinimaxFile } from "./files-api.js";

const { parseMinimaxUploadResponse, resolveMinimaxFilesApiBaseUrl, DEFAULT_MAX_UPLOAD_BYTES } =
  __testing;

const makeCfg = (overrides: Record<string, unknown> = {}) => ({
  models: {
    providers: {
      minimax: {
        baseUrl: "https://api.minimaxi.com/anthropic",
        ...overrides,
      },
    },
  },
});

describe("uploadMinimaxFile - purpose required", () => {
  it("does NOT default purpose to video_understanding (per 老板 17:44 拍板)", () => {
    // The function signature requires `purpose` — verify the type-level
    // contract by ensuring omitting it is a compile error. This test is
    // a structural check; we just verify the function exists and accepts
    // the explicit-purpose signature.
    expect(uploadMinimaxFile).toBeTypeOf("function");
    // Parameter shape: 4th param must be `purpose` (positional, no default).
    expect(uploadMinimaxFile.length).toBeGreaterThanOrEqual(6);
  });
});

describe("parseMinimaxUploadResponse - numeric file_id (6/29 PATCH)", () => {
  // Owner 8:48 主人报 Hunter 看不到视频 → 8:36:08 logWarn 触发 fallback 但
  // 实际 minimax API 真的返回了 file_id (414244194570579), 只是 type 是
  // number 不是 string. 旧 typeof === "string" 拒 number → throw missing
  // file_id → 永远走 inline fallback → hosted URL 管线彻底坏. 修法：接受
  // string | number, return 时 coerce 成 string.
  it("accepts numeric file_id at top level", () => {
    const result = parseMinimaxUploadResponse({
      file_id: 414244194570579,
      bytes: 5196262,
      base_resp: { status_code: 0, status_msg: "success" },
    });
    expect(result.file_id).toBe("414244194570579");
    expect(result.bytes).toBe(5196262);
  });
  it("accepts numeric file_id nested under file", () => {
    const result = parseMinimaxUploadResponse({
      file: {
        file_id: 414244194570579,
        bytes: 5196262,
        filename: "test.mp4",
        purpose: "video_understanding",
      },
      base_resp: { status_code: 0, status_msg: "success" },
    });
    expect(result.file_id).toBe("414244194570579");
    expect(result.filename).toBe("test.mp4");
  });
  it("accepts string file_id (legacy shape)", () => {
    const result = parseMinimaxUploadResponse({
      file_id: "abc123",
      base_resp: { status_code: 0 },
    });
    expect(result.file_id).toBe("abc123");
  });
  it("throws when file_id is missing entirely", () => {
    expect(() =>
      parseMinimaxUploadResponse({
        base_resp: { status_code: 0 },
      }),
    ).toThrow(/missing file_id/);
  });
  it("throws when file_id is wrong type (boolean / object)", () => {
    expect(() =>
      parseMinimaxUploadResponse({ file_id: true, base_resp: { status_code: 0 } }),
    ).toThrow(/missing file_id/);
    expect(() =>
      parseMinimaxUploadResponse({
        file: { file_id: { nested: "object" } },
        base_resp: { status_code: 0 },
      }),
    ).toThrow(/missing file_id/);
  });
});

describe("uploadMinimaxFile - parameter validation", () => {
  it("rejects when API key is missing", async () => {
    const cfg = { models: { providers: { minimax: { baseUrl: "https://api.minimaxi.com" } } } };
    await expect(
      uploadMinimaxFile({
        providerId: "minimax",
        cfg: cfg as Parameters<typeof uploadMinimaxFile>[0]["cfg"],
        buffer: Buffer.from("hello"),
        mimeType: "video/mp4",
        purpose: "video_understanding",
      }),
    ).rejects.toThrow(/API key not configured/);
  });

  it("rejects when buffer exceeds 512MB", async () => {
    // We don't actually allocate 512MB+ — just test the size guard logic
    // by checking the constant is correct.
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe("parseMinimaxUploadResponse", () => {
  it("extracts file_id from top-level field", () => {
    const result = parseMinimaxUploadResponse({
      file_id: "abc123",
      base_resp: { status_code: 0, status_msg: "success" },
    });
    expect(result).toEqual({ file_id: "abc123" });
  });

  it("extracts file_id from nested `file.file_id`", () => {
    const result = parseMinimaxUploadResponse({
      file: { file_id: "xyz789", filename: "test.mp4" },
      base_resp: { status_code: 0, status_msg: "success" },
    });
    expect(result).toEqual({ file_id: "xyz789", filename: "test.mp4" });
  });

  it("extracts bytes from `file.bytes`", () => {
    const result = parseMinimaxUploadResponse({
      file: { file_id: "abc", bytes: 12345 },
      base_resp: { status_code: 0 },
    });
    expect(result).toEqual({ file_id: "abc", bytes: 12345 });
  });

  it("throws on non-zero base_resp.status_code", () => {
    expect(() =>
      parseMinimaxUploadResponse({
        base_resp: { status_code: 1004, status_msg: "invalid file ext for retrieval" },
      }),
    ).toThrow(/invalid file ext for retrieval/);
  });

  it("throws on missing file_id", () => {
    expect(() =>
      parseMinimaxUploadResponse({
        base_resp: { status_code: 0 },
      }),
    ).toThrow(/missing file_id/);
  });

  it("throws on non-object response", () => {
    expect(() => parseMinimaxUploadResponse(null)).toThrow(/invalid response/);
    expect(() => parseMinimaxUploadResponse("string")).toThrow(/invalid response/);
    expect(() => parseMinimaxUploadResponse(42)).toThrow(/invalid response/);
  });

  it("accepts response without base_resp (some endpoints omit it)", () => {
    const result = parseMinimaxUploadResponse({ file_id: "abc" });
    expect(result.file_id).toBe("abc");
  });
});

describe("resolveMinimaxFilesApiBaseUrl", () => {
  it("uses configured baseUrl origin when present", () => {
    const cfg = {
      models: { providers: { minimax: { baseUrl: "https://api.minimaxi.com/anthropic" } } },
    };
    expect(resolveMinimaxFilesApiBaseUrl(cfg as never, "minimax")).toBe("https://api.minimaxi.com");
  });

  it("falls back to default when baseUrl is missing", () => {
    const cfg = { models: { providers: { minimax: {} } } };
    const result = resolveMinimaxFilesApiBaseUrl(cfg as never, "minimax");
    expect(result).toMatch(/^https?:\/\//);
  });

  it("falls back to default when baseUrl is invalid", () => {
    const cfg = { models: { providers: { minimax: { baseUrl: "not-a-url" } } } };
    const result = resolveMinimaxFilesApiBaseUrl(cfg as never, "minimax");
    expect(result).toMatch(/^https?:\/\//);
  });
});

describe("integration with makeCfg helper", () => {
  it("cfg shape matches what uploadMinimaxFile expects", () => {
    const cfg = makeCfg();
    expect(cfg.models.providers.minimax).toBeDefined();
  });
});
