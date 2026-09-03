import { readFile as fsReadFile } from "node:fs/promises";
import { basename } from "node:path";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { Type } from "typebox";
import type { TextContent } from "../../../llm/types.js";
import { assertLocalMediaWithinRoots } from "../../../media/local-media-access.js";
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
import {
  DEFAULT_VIDEO_HOSTED_MAX_BYTES,
  DEFAULT_VIDEO_INLINE_MAX_BYTES,
  decideVideoDelivery,
  resolveVideoReadMaxBytes,
  type VideoDeliveryPolicy,
} from "./video-inline-policy.js";

const readVideoSchema = Type.Object({
  path: Type.String({
    description: "Local path, file/media URI, or HTTP(S) URL of the video to read",
  }),
  maxBytes: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: DEFAULT_VIDEO_HOSTED_MAX_BYTES,
      description: `Maximum video bytes to load. Inline delivery is capped separately; configured providers may host larger files up to ${DEFAULT_VIDEO_HOSTED_MAX_BYTES} bytes.`,
    }),
  ),
});

export const DEFAULT_READ_VIDEO_MAX_BYTES = DEFAULT_VIDEO_INLINE_MAX_BYTES;

type ReadVideoLoadedMedia = WebMediaResult & {
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
  deliveryPolicy?: VideoDeliveryPolicy;
  uploadVideo?: (request: {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    purpose: "video_understanding";
    signal?: AbortSignal;
  }) => Promise<{ url: string; fileId?: string; bytes?: number; fileName?: string }>;
  /** Exact provider execution id paired with uploadVideo. */
  hostedProviderId?: string;
  /** Host-local roots associated with this tool surface. */
  localRoots?: readonly string[];
  /** Treat localRoots as an authorization boundary instead of ordinary media preview hints. */
  enforceLocalRoots?: boolean;
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
      delivery: "inline" | "hosted";
      providerFileId?: string;
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
  options?: Pick<ReadVideoToolOptions, "localRoots" | "enforceLocalRoots" | "readFile">,
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
      if (options?.enforceLocalRoots) {
        await assertLocalMediaWithinRoots(absolutePath, options.localRoots ?? []);
      }
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
  const deliveryPolicy =
    options?.deliveryPolicy ??
    ({
      mode: "auto",
      inlineMaxBytes: defaultMaxBytes,
      hostedMaxBytes: DEFAULT_VIDEO_HOSTED_MAX_BYTES,
    } satisfies VideoDeliveryPolicy);
  const uploadVideo = options?.uploadVideo;
  const hostedProviderId = options?.hostedProviderId?.trim();
  const canHost = uploadVideo !== undefined && Boolean(hostedProviderId);

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
      if (deliveryPolicy.mode === "hosted" && !canHost) {
        const reason = "configured provider does not support hosted video uploads";
        return {
          content: [
            {
              type: "text",
              text: `readVideo: ${reason}: ${params.path}`,
            } satisfies TextContent,
          ],
          details: { ok: false, source: params.path, reason },
        };
      }
      const maxBytes = resolveVideoReadMaxBytes({
        policy: deliveryPolicy,
        canHost,
        requestedMaxBytes: params.maxBytes,
      });
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

      const delivery = decideVideoDelivery({
        sizeBytes: loaded.buffer.length,
        policy: deliveryPolicy,
        canHost,
      });
      if (delivery === "unsupported") {
        const reason =
          loaded.buffer.length > deliveryPolicy.inlineMaxBytes && !canHost
            ? `video exceeds inline limit (${deliveryPolicy.inlineMaxBytes} bytes) and no hosted upload is available`
            : loaded.buffer.length > deliveryPolicy.hostedMaxBytes
              ? `video exceeds hosted upload limit (${deliveryPolicy.hostedMaxBytes} bytes)`
              : `video exceeds inline limit (${deliveryPolicy.inlineMaxBytes} bytes)`;
        return {
          content: [
            {
              type: "text",
              text: `readVideo: ${reason}: ${params.path}`,
            } satisfies TextContent,
          ],
          details: {
            ok: false,
            source: params.path,
            reason,
            contentType,
            sizeBytes: loaded.buffer.length,
          },
        };
      }

      const hosted =
        delivery === "hosted" && uploadVideo && hostedProviderId
          ? await uploadVideo({
              buffer: loaded.buffer,
              mimeType: contentType,
              ...(loaded.fileName ? { fileName: loaded.fileName } : {}),
              purpose: "video_understanding",
              ...(signal ? { signal } : {}),
            })
          : undefined;
      signal?.throwIfAborted();
      if (hosted && !hosted.url.trim()) {
        throw new Error("Hosted video upload returned an empty URL");
      }

      const details = withToolResultMediaDetails(
        {
          ok: true as const,
          source: params.path,
          contentType,
          sizeBytes: loaded.buffer.length,
          ...(loaded.fileName ? { fileName: loaded.fileName } : {}),
          delivery,
          ...(hosted?.fileId ? { providerFileId: hosted.fileId } : {}),
        },
        [
          hosted
            ? {
                url: hosted.url,
                contentType,
                kind: "video",
                providerReference: hostedProviderId,
                fileName: hosted.fileName ?? loaded.fileName,
                sizeBytes: hosted.bytes ?? loaded.buffer.length,
              }
            : { ...loaded.fact, contentType, kind: "video", sizeBytes: loaded.buffer.length },
        ],
      );
      return {
        content: [
          {
            type: "text",
            text: `Read video [${contentType}] (${loaded.buffer.length} bytes, ${delivery}) from ${params.path}.`,
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
