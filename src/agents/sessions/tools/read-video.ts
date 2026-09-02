import { readFile as fsReadFile } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { Type } from "typebox";
import type { TextContent } from "../../../llm/types.js";
import type { MediaFactInput } from "../../../media/media-facts.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
  resolveMediaReferenceLocalPath,
} from "../../../media/media-reference.js";
import { withToolResultMediaDetails } from "../../../media/tool-result-media-facts.js";
import { loadWebMediaRaw, type WebMediaResult } from "../../../media/web-media.js";
import type { AgentTool } from "../../runtime/index.js";
import type { ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const readVideoSchema = Type.Object({
  path: Type.String({
    description: "Local path, file/media URI, or HTTP(S) URL of the video to read",
  }),
  maxBytes: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_VIDEO_BYTES,
      description: `Maximum video bytes to load. Defaults to ${MAX_VIDEO_BYTES}; larger videos require a hosted provider file.`,
    }),
  ),
});

export const DEFAULT_READ_VIDEO_MAX_BYTES = MAX_VIDEO_BYTES;

export type ReadVideoLoadedMedia = WebMediaResult & {
  /** Stable source identity used by the provider-only media projection. */
  fact: MediaFactInput;
};

export interface ReadVideoOperations {
  load(
    source: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ReadVideoLoadedMedia>;
}

export interface ReadVideoToolOptions {
  defaultMaxBytes?: number;
  operations?: ReadVideoOperations;
  /** Host-local roots allowed for local reads. Omit to preserve unrestricted read-tool behavior. */
  localRoots?: readonly string[];
  /** Optional authorized reader, used by sandbox-backed tool surfaces. */
  readFile?: (
    filePath: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ) => Promise<Buffer>;
}

export type ReadVideoDetails =
  | {
      ok: true;
      source: string;
      contentType: string;
      sizeBytes: number;
      fileName?: string;
    }
  | {
      ok: false;
      source: string;
      reason: string;
      contentType?: string;
      sizeBytes?: number;
    };

async function resolveLocalVideoSource(source: string, cwd: string): Promise<string> {
  const normalized = normalizeMediaReferenceSource(source);
  if (classifyMediaReferenceSource(normalized).isMediaStoreUrl) {
    return await resolveMediaReferenceLocalPath(normalized);
  }
  return resolveToCwd(source, cwd);
}

function createDefaultReadVideoOperations(
  cwd: string,
  options?: Pick<ReadVideoToolOptions, "localRoots" | "readFile">,
): ReadVideoOperations {
  return {
    async load(source, loadOptions) {
      if (hasHttpUrlPrefix(source)) {
        const loaded = await loadWebMediaRaw(source, {
          maxBytes: loadOptions.maxBytes,
          requestInit: loadOptions.signal ? { signal: loadOptions.signal } : undefined,
        });
        return {
          ...loaded,
          fact: {
            url: source,
            contentType: loaded.contentType,
            kind: loaded.kind,
            fileName: loaded.fileName,
            sizeBytes: loaded.buffer.length,
          },
        };
      }

      const absolutePath = await resolveLocalVideoSource(source, cwd);
      const loaded = await loadWebMediaRaw(absolutePath, {
        maxBytes: loadOptions.maxBytes,
        workspaceDir: cwd,
        localRoots: options?.localRoots ?? "any",
        readFile: (filePath) =>
          options?.readFile
            ? options.readFile(filePath, loadOptions)
            : fsReadFile(filePath, { signal: loadOptions.signal }),
        sandboxValidated: options?.readFile !== undefined && options.localRoots === undefined,
      });
      return {
        ...loaded,
        fact: {
          path: absolutePath,
          contentType: loaded.contentType,
          kind: loaded.kind,
          fileName: loaded.fileName ?? basename(absolutePath),
          sizeBytes: loaded.buffer.length,
          workspaceDir: cwd,
        },
      };
    },
  };
}

export function createReadVideoToolDefinition(
  cwd: string,
  options?: ReadVideoToolOptions,
): ToolDefinition<typeof readVideoSchema, ReadVideoDetails> {
  const defaultMaxBytes = options?.defaultMaxBytes ?? DEFAULT_READ_VIDEO_MAX_BYTES;
  const operations = options?.operations ?? createDefaultReadVideoOperations(cwd, options);

  return {
    name: "readVideo",
    label: "readVideo",
    description:
      "Read a local or remote video and attach it to the next model call. Use this for video files; the regular read tool only handles text and images. The canonical tool result remains text-only while OpenClaw projects validated video media at the provider boundary.",
    promptSnippet: "Read a video attachment from a path or URL",
    promptGuidelines: [
      "Use readVideo instead of read for video files.",
      "If the video exceeds the byte limit, use a smaller clip or a provider-hosted file reference.",
    ],
    parameters: readVideoSchema,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const maxBytes = params.maxBytes ?? defaultMaxBytes;
      const loaded = await operations.load(params.path, { maxBytes, signal });
      signal?.throwIfAborted();
      const contentType = normalizeMimeType(loaded.contentType);
      if (loaded.kind !== "video" || !contentType?.startsWith("video/")) {
        const details: ReadVideoDetails = {
          ok: false,
          source: params.path,
          reason: "source is not a supported video",
          ...(contentType ? { contentType } : {}),
          sizeBytes: loaded.buffer.length,
        };
        return {
          content: [
            {
              type: "text",
              text: `readVideo: source is not a supported video: ${params.path}`,
            } satisfies TextContent,
          ],
          details,
        };
      }

      const details = withToolResultMediaDetails(
        {
          ok: true as const,
          source: params.path,
          contentType,
          sizeBytes: loaded.buffer.length,
          ...(loaded.fileName ? { fileName: loaded.fileName } : {}),
        },
        [{ ...loaded.fact, contentType, kind: "video", sizeBytes: loaded.buffer.length }],
      );
      return {
        content: [
          {
            type: "text",
            text: `Read video [${contentType}] (${loaded.buffer.length} bytes) from ${params.path}.`,
          } satisfies TextContent,
        ],
        details,
      };
    },
  };
}

export function createReadVideoTool(
  cwd: string,
  options?: ReadVideoToolOptions,
): AgentTool<typeof readVideoSchema, ReadVideoDetails> {
  return wrapToolDefinition(createReadVideoToolDefinition(cwd, options));
}
