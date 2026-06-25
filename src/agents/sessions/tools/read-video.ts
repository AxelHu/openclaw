/**
 * Built-in readVideo session tool.
 *
 * 6/24 PATCH: dedicated video read tool, independent from `read`.
 *
 * Why a separate tool (not an extension of `read`):
 * - `read` is restricted to text + image handling to keep the
 *   `AgentToolResult.content` type clean and avoid breaking the
 *   transport stream / list.rows / agent-harness / agent-session type
 *   constraints. Adding a `VideoContent` block through `read` triggers
 *   a cascade of type errors.
 * - The model needs a way to actually see video content (not just
 *   receive raw base64 bytes as text). This tool provides that.
 *
 * Behaviour:
 * - Reads a video file from the local filesystem
 * - Detects MIME type from the file's leading bytes (mp4, mov, webm, avi, 3gp)
 * - Inlines small files (<= 50MB by default) as base64 `VideoContent` blocks
 * - Rejects large files with a helpful error (large videos need to be
 *   uploaded through the chat channel so the inbound preflight can
 *   forward them to the provider's Files API as mm_file://{id})
 * - Returns a `VideoContent` block in the tool result, which the
 *   runtime's transport stream (`convertContentBlocks`) forwards
 *   to the model as a `type: "video"` content block (see commit
 *   f27b600ca27 and the parallel `transport-stream` patch).
 */
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentTool } from "../../runtime/index.js";
import { detectSupportedVideoMimeTypeFromFile } from "../../utils/mime.js";
import type { ToolDefinition } from "../extensions/types.js";
import { resolveReadPath } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const readVideoSchema = Type.Object({
  path: Type.String({ description: "Path to the video file to read (relative or absolute)" }),
  maxBytes: Type.Optional(
    Type.Number({
      description:
        "Inline base64 size limit in bytes. Default 50MB. Videos larger than this fail with a helpful error.",
    }),
  ),
});

/** 50MB matches the minimax /anthropic endpoint inline video limit. */
export const DEFAULT_READ_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export interface ReadVideoOperations {
  /** Resolve a user-supplied path for this read backend. */
  resolvePath?: (filePath: string, cwd: string) => string | Promise<string>;
  /** Read file contents as a Buffer. */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if file is readable (throw if not). */
  access: (absolutePath: string) => Promise<void>;
  /** Detect video MIME type from the file's leading bytes. */
  detectVideoMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadVideoOperations: ReadVideoOperations = {
  resolvePath: async (filePath, cwd) => resolveReadPath(filePath, cwd),
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectVideoMimeType: detectSupportedVideoMimeTypeFromFile,
};

export interface ReadVideoToolOptions {
  /**
   * Default inline base64 size limit. Videos <= this are inlined;
   * videos > this cause the tool to fail with a helpful error
   * instructing the user to upload via the chat channel.
   */
  defaultMaxBytes?: number;
  /** Custom operations for file reading. Default: local filesystem. */
  operations?: ReadVideoOperations;
}

type ReadVideoRenderArgs = { path?: string; max_bytes?: number };

type ReadVideoResultBlock =
  | { type: "text"; text: string }
  | { type: "video"; mimeType: string; data: string; bytes: number };

type ReadVideoDetails =
  | { ok: true; mimeType: string; bytes: number; filePath: string }
  | { ok: false; reason: string; filePath: string; bytes?: number; mimeType?: string };

type ReadVideoToolResult = {
  content: ReadVideoResultBlock[];
  details: ReadVideoDetails;
};

function formatReadVideoCall(
  args: ReadVideoRenderArgs | undefined,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
): string {
  const rawPath = str(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  const invalidArg = invalidArgText(theme as never);
  const pathDisplay =
    path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
  return `${theme.fg("toolTitle", theme.bold("readVideo"))} ${pathDisplay}`;
}

function formatReadVideoResult(
  _args: ReadVideoRenderArgs | undefined,
  result: ReadVideoDetails,
  theme: { fg: (color: string, text: string) => string },
  isError: boolean,
): string {
  if (isError || !result.ok) {
    const bytesInfo = typeof result.bytes === "number" ? ` (${result.bytes} bytes)` : "";
    // 6/24 PATCH: details is a union of {ok:true} | {ok:false, reason}; after
    // !result.ok narrows to the {ok:false} branch but the parameter
    // `result: ReadVideoDetails` was passed in un-narrowed, so we use an
    // explicit cast for the reason field to satisfy the type checker.
    const reason =
      "reason" in result && typeof result.reason === "string" ? result.reason : "unknown error";
    return `\n${theme.fg("error", `[readVideo failed] ${reason}${bytesInfo}`)}`;
  }
  const kb = Math.round(result.bytes / 1024);
  return `\n${theme.fg("muted", `[video] ${result.mimeType} · ${kb} KB`)}`;
}

async function resolveReadVideoPath(
  ops: ReadVideoOperations,
  filePath: string,
  cwd: string,
): Promise<string> {
  return await (ops.resolvePath?.(filePath, cwd) ?? resolveReadPath(filePath, cwd));
}

export function createReadVideoToolDefinition(
  cwd: string,
  options?: ReadVideoToolOptions,
): ToolDefinition<typeof readVideoSchema> {
  const defaultMaxBytes = options?.defaultMaxBytes ?? DEFAULT_READ_VIDEO_MAX_BYTES;
  const ops = options?.operations ?? defaultReadVideoOperations;

  return {
    name: "readVideo",
    label: "readVideo",
    description:
      "Read a video file from the local filesystem and load it into the model's context as a video attachment. " +
      "Use this when the user wants the model to actually see the video (mp4, mov, webm, avi, 3gp). " +
      "Important: do NOT use the regular `read` tool for video files — `read` will treat the video as raw text/base64, " +
      "which the model cannot meaningfully use. Always use `readVideo` for video files. " +
      "Maximum inline size is 50MB by default (set `maxBytes` to override); larger videos require the chat channel " +
      "inbound preflight to upload to the provider's Files API first (mm_file://{file_id}).",
    promptSnippet: "Read video file as a video attachment (mp4/mov/webm/avi/3gp)",
    promptGuidelines: [
      "Use readVideo for video files, never the regular read tool.",
      "If readVideo fails because the file is too large, ask the user to upload via the chat channel instead.",
    ],
    parameters: readVideoSchema,
    async execute(toolCallId, params, signal) {
      void toolCallId;
      const { path, maxBytes: paramMaxBytes } = params;
      const inlineMaxBytes = paramMaxBytes ?? defaultMaxBytes;

      return await new Promise<ReadVideoToolResult>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const absolutePath = await resolveReadVideoPath(ops, path, cwd);
            await ops.access(absolutePath);
            if (aborted) return;
            const mimeType = ops.detectVideoMimeType
              ? await ops.detectVideoMimeType(absolutePath)
              : undefined;
            if (!mimeType) {
              signal?.removeEventListener("abort", onAbort);
              resolve({
                content: [
                  {
                    type: "text",
                    text: `readVideo: file does not look like a supported video format (mp4, mov, webm, avi, 3gp): ${path}`,
                  },
                ],
                details: { ok: false, reason: "unsupported video format", filePath: absolutePath },
              });
              return;
            }
            const buffer = await ops.readFile(absolutePath);
            if (aborted) return;
            if (buffer.byteLength > inlineMaxBytes) {
              const mb = Math.round(buffer.byteLength / 1024 / 1024);
              signal?.removeEventListener("abort", onAbort);
              resolve({
                content: [
                  {
                    type: "text",
                    text:
                      `readVideo: file is ${mb}MB which exceeds the inline limit of ${Math.round(
                        inlineMaxBytes / 1024 / 1024,
                      )}MB. ` +
                      "Upload the video through the chat channel (e.g. Feishu inbound preflight will upload to the provider's Files API), " +
                      "or pass a smaller file (maxBytes override).",
                  },
                ],
                details: {
                  ok: false,
                  reason: "video too large for inline base64",
                  bytes: buffer.byteLength,
                  mimeType,
                  filePath: absolutePath,
                },
              });
              return;
            }
            const base64 = buffer.toString("base64");
            signal?.removeEventListener("abort", onAbort);
            resolve({
              content: [
                {
                  type: "text",
                  text: `Read video file [${mimeType}] (${buffer.byteLength} bytes)`,
                },
                {
                  type: "video",
                  mimeType,
                  data: base64,
                  bytes: buffer.byteLength,
                },
              ],
              details: { ok: true, bytes: buffer.byteLength, mimeType, filePath: absolutePath },
            });
          } catch (err) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
      });
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatReadVideoCall(args, theme as never));
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        formatReadVideoResult(
          context.args as ReadVideoRenderArgs | undefined,
          result.details as ReadVideoDetails,
          theme as never,
          context.isError,
        ),
      );
      return text;
    },
  };
}

export function createReadVideoTool(
  cwd: string,
  options?: ReadVideoToolOptions,
): AgentTool<typeof readVideoSchema> {
  return wrapToolDefinition(createReadVideoToolDefinition(cwd, options));
}

export const __testing = {
  DEFAULT_READ_VIDEO_MAX_BYTES,
  formatReadVideoCall,
  formatReadVideoResult,
};
