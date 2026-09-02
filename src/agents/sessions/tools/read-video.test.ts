import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { readToolResultMediaFacts } from "../../../media/tool-result-media-facts.js";
import { createCoreCodingTools } from "../../core-coding-tools.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createReadVideoTool,
  DEFAULT_READ_VIDEO_MAX_BYTES,
  type ReadVideoOperations,
} from "./read-video.js";

const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftyp"),
  Buffer.from("mp42"),
  Buffer.alloc(4),
  Buffer.from("isommp42avc1"),
]);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempDir(): string {
  return tempDirs.make("openclaw-read-video-");
}

function asToolResultMessage(details: unknown): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "readVideo",
    content: [{ type: "text", text: "video ready" }],
    details,
    isError: false,
    timestamp: 1,
  } satisfies Extract<AgentMessage, { role: "toolResult" }>;
}

describe("readVideo session tool", () => {
  it("returns a text-only canonical result plus a managed local video fact", async () => {
    const cwd = makeTempDir();
    const videoPath = path.join(cwd, "clip.mp4");
    await fs.writeFile(videoPath, MP4);
    const tool = createReadVideoTool(cwd);

    const result = await tool.execute("call_1", { path: "clip.mp4" });

    expect(result.content).toEqual([
      {
        type: "text",
        text: `Read video [video/mp4] (${MP4.length} bytes, inline) from clip.mp4.`,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(MP4.toString("base64"));
    expect(readToolResultMediaFacts(asToolResultMessage(result.details))).toMatchObject([
      {
        path: videoPath,
        contentType: "video/mp4",
        kind: "video",
        sizeBytes: MP4.length,
        workspaceDir: cwd,
      },
    ]);
  });

  it("rejects non-video content without attaching a media fact", async () => {
    const cwd = makeTempDir();
    await fs.writeFile(path.join(cwd, "notes.txt"), "not a video");
    const tool = createReadVideoTool(cwd);

    const result = await tool.execute("call_1", { path: "notes.txt" });

    expect(result.details).toMatchObject({
      ok: false,
      source: "notes.txt",
      reason: "source is not a supported video",
    });
    expect(readToolResultMediaFacts(asToolResultMessage(result.details))).toBeUndefined();
  });

  it("preserves a remote URL as the replayable media identity", async () => {
    const source = "https://media.example.test/clip.mp4";
    const operations: ReadVideoOperations = {
      load: async () => ({
        buffer: MP4,
        contentType: "video/mp4",
        kind: "video",
        fileName: "clip.mp4",
        fact: { url: source },
      }),
    };
    const tool = createReadVideoTool("/workspace", { operations });

    const result = await tool.execute("call_1", { path: source });

    expect(readToolResultMediaFacts(asToolResultMessage(result.details))).toMatchObject([
      {
        url: source,
        contentType: "video/mp4",
        kind: "video",
        sizeBytes: MP4.length,
      },
    ]);
  });

  it("passes per-call maxBytes and abort signals to the loader", async () => {
    const controller = new AbortController();
    let observedMaxBytes: number | undefined;
    let observedSignal: AbortSignal | undefined;
    const operations: ReadVideoOperations = {
      load: async (_source, options) => {
        observedMaxBytes = options.maxBytes;
        observedSignal = options.signal;
        return {
          buffer: MP4,
          contentType: "video/mp4",
          kind: "video",
          fact: { path: "/workspace/clip.mp4" },
        };
      },
    };
    const tool = createReadVideoTool("/workspace", { operations });

    await tool.execute("call_1", { path: "clip.mp4", maxBytes: 1234 }, controller.signal);

    expect(observedMaxBytes).toBe(1234);
    expect(observedSignal).toBe(controller.signal);
    expect(DEFAULT_READ_VIDEO_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("uploads videos selected for hosted delivery and persists only the compact provider URL", async () => {
    const source = "/workspace/large.mp4";
    let uploadSignal: AbortSignal | undefined;
    const operations: ReadVideoOperations = {
      load: async () => ({
        buffer: MP4,
        contentType: "video/mp4",
        kind: "video",
        fileName: "large.mp4",
        fact: { path: source },
      }),
    };
    const controller = new AbortController();
    const tool = createReadVideoTool("/workspace", {
      operations,
      deliveryPolicy: { mode: "hosted", inlineMaxBytes: 1, hostedMaxBytes: 1024 },
      hostedProviderId: "minimax",
      uploadVideo: async (request) => {
        uploadSignal = request.signal;
        expect(request.buffer).toBe(MP4);
        expect(request.purpose).toBe("video_understanding");
        return { url: "provider-file://42", fileId: "42", bytes: MP4.length };
      },
    });

    const result = await tool.execute("call_1", { path: source }, controller.signal);

    expect(uploadSignal).toBe(controller.signal);
    expect(result.details).toMatchObject({
      ok: true,
      delivery: "hosted",
      providerFileId: "42",
    });
    expect(JSON.stringify(result)).not.toContain(MP4.toString("base64"));
    expect(readToolResultMediaFacts(asToolResultMessage(result.details))).toMatchObject([
      {
        url: "provider-file://42",
        contentType: "video/mp4",
        providerReference: "minimax",
        kind: "video",
        fileName: "large.mp4",
        sizeBytes: MP4.length,
      },
    ]);
  });

  it("fails closed before reading when the selected hosted path is unavailable", async () => {
    let loaded = false;
    const operations: ReadVideoOperations = {
      load: async () => {
        loaded = true;
        return {
          buffer: MP4,
          contentType: "video/mp4",
          kind: "video",
          fact: { path: "/workspace/clip.mp4" },
        };
      },
    };
    const tool = createReadVideoTool("/workspace", {
      operations,
      deliveryPolicy: { mode: "hosted", inlineMaxBytes: 1, hostedMaxBytes: 1024 },
    });

    const result = await tool.execute("call_1", { path: "clip.mp4" });

    expect(result.details).toMatchObject({
      ok: false,
      reason: "configured provider does not support hosted video uploads",
    });
    expect(loaded).toBe(false);
    expect(readToolResultMediaFacts(asToolResultMessage(result.details))).toBeUndefined();
  });

  it("fails before loading when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operations: ReadVideoOperations = {
      load: async () => {
        throw new Error("loader should not run");
      },
    };
    const tool = createReadVideoTool("/workspace", { operations });

    await expect(tool.execute("call_1", { path: "clip.mp4" }, controller.signal)).rejects.toThrow(
      /aborted/i,
    );
  });

  it("is omitted from the core surface for a text-only active model", async () => {
    const workspace = makeTempDir();
    const tools = createCoreCodingTools({
      codingRoot: workspace,
      containmentRoot: workspace,
      includeBaseCodingTools: true,
      includeShellTools: false,
      workspaceOnly: true,
      readOnly: true,
      modelHasVideo: false,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      execDefaults: {},
      processDefaults: { scopeKey: "read-video-text-only-test" },
    });

    expect(tools.some((entry) => entry.name === "readVideo")).toBe(false);
  });

  it("is exposed by the core surface and honors workspace-only roots", async () => {
    const workspace = makeTempDir();
    const outside = makeTempDir();
    await fs.writeFile(path.join(workspace, "inside.mp4"), MP4);
    await fs.writeFile(path.join(outside, "outside.mp4"), MP4);
    const tools = createCoreCodingTools({
      codingRoot: workspace,
      containmentRoot: workspace,
      includeBaseCodingTools: true,
      includeShellTools: false,
      workspaceOnly: true,
      readOnly: true,
      modelHasVideo: true,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      execDefaults: {},
      processDefaults: { scopeKey: "read-video-test" },
    });
    const tool = tools.find((entry) => entry.name === "readVideo");
    expect(tool).toBeDefined();

    await expect(tool!.execute("inside", { path: "inside.mp4" })).resolves.toMatchObject({
      details: { ok: true, contentType: "video/mp4" },
    });
    await expect(
      tool!.execute("outside", { path: path.join(outside, "outside.mp4") }),
    ).rejects.toThrow(/not under an allowed|not allowed|outside allowed|root/i);
  });
});
