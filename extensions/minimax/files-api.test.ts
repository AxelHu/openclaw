import { describe, expect, it, vi } from "vitest";
import {
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
} from "./provider-http.test-helpers.js";

installMinimaxProviderHttpMockCleanup();

const { postMultipartRequestMock, resolveApiKeyForProviderMock } = getMinimaxProviderHttpMocks();

const {
  DEFAULT_MINIMAX_FILE_MAX_BYTES,
  parseMinimaxUploadResponse,
  resolveMinimaxFilesBaseUrl,
  uploadMinimaxFile,
} = await import("./files-api.js");

function cfg(baseUrl = "https://api.minimax.io/anthropic") {
  return {
    models: {
      providers: {
        minimax: {
          baseUrl,
          models: [],
        },
      },
    },
  } as Parameters<typeof uploadMinimaxFile>[0]["cfg"];
}

describe("MiniMax Files API", () => {
  it("accepts numeric and nested file ids", () => {
    expect(
      parseMinimaxUploadResponse({
        file_id: 414244194570579,
        bytes: 28,
        base_resp: { status_code: 0 },
      }),
    ).toEqual({ fileId: "414244194570579", bytes: 28 });
    expect(
      parseMinimaxUploadResponse({
        file: { file_id: "abc", filename: "clip.mp4" },
        base_resp: { status_code: 0 },
      }),
    ).toEqual({ fileId: "abc", fileName: "clip.mp4" });
  });

  it("fails closed on API errors and malformed responses", () => {
    expect(() =>
      parseMinimaxUploadResponse({
        base_resp: { status_code: 1004, status_msg: "invalid file" },
      }),
    ).toThrow("invalid file");
    expect(() => parseMinimaxUploadResponse({ base_resp: { status_code: 0 } })).toThrow(
      "missing file_id",
    );
    expect(() => parseMinimaxUploadResponse(null)).toThrow("invalid response");
  });

  it("selects the regional Files API origin", () => {
    expect(resolveMinimaxFilesBaseUrl(cfg("https://api.minimaxi.com/anthropic"), "minimax")).toBe(
      "https://api.minimaxi.com",
    );
    expect(resolveMinimaxFilesBaseUrl(cfg(), "minimax")).toBe("https://api.minimax.io");
    expect(resolveMinimaxFilesBaseUrl(cfg(), "minimax-cn")).toBe("https://api.minimaxi.com");
    expect(resolveMinimaxFilesBaseUrl(cfg("https://proxy.example.test/minimax"), "minimax")).toBe(
      "https://proxy.example.test",
    );
  });

  it("uploads multipart video content with an explicit purpose", async () => {
    const release = vi.fn(async () => {});
    postMultipartRequestMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ file_id: 414244194570579, bytes: 28, filename: "clip.mp4" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      release,
    });

    const result = await uploadMinimaxFile({
      providerId: "minimax",
      cfg: cfg(),
      buffer: Buffer.from("video"),
      mimeType: "video/mp4",
      fileName: "clip.mp4",
      purpose: "video_understanding",
      timeoutMs: 120_000,
    });

    expect(result).toEqual({
      fileId: "414244194570579",
      bytes: 28,
      fileName: "clip.mp4",
    });
    expect(postMultipartRequestMock).toHaveBeenCalledTimes(1);
    const request = postMultipartRequestMock.mock.calls[0]?.[0] as {
      url: string;
      headers: Headers;
      body: FormData;
      timeoutMs: number;
    };
    expect(request.url).toBe("https://api.minimax.io/v1/files/upload");
    expect(request.headers.get("authorization")).toBe("Bearer provider-key");
    expect(request.headers.has("content-type")).toBe(false);
    expect(request.body.get("purpose")).toBe("video_understanding");
    expect(request.body.get("file")).toBeInstanceOf(File);
    expect(request.timeoutMs).toBe(120_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects missing credentials before issuing a request", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });
    await expect(
      uploadMinimaxFile({
        providerId: "minimax",
        cfg: cfg(),
        buffer: Buffer.from("video"),
        mimeType: "video/mp4",
        purpose: "video_understanding",
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow("API key not configured");
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
  });

  it("keeps the hosted upload hard limit at 512 MiB", () => {
    expect(DEFAULT_MINIMAX_FILE_MAX_BYTES).toBe(512 * 1024 * 1024);
  });
});
