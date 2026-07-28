/** Resolves media attachments available to the current agent turn. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment } from "../../acp/control-plane/manager.types.js";
import {
  DEFAULT_VIDEO_INLINE_MAX_BYTES,
  type InlinePolicy,
  resolveVideoDeliveryPolicy,
} from "../../agents/sessions/tools/video-inline-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { logWarn } from "../../logger.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import { probeVideoMetadata, type VideoMetadata } from "../../media/media-services.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { MsgContext } from "../templating.js";
import {
  type RecentInboundHistoryImage,
  resolveRecentInboundHistoryImages,
} from "./history-media.js";

type AgentTurnAttachment = AcpTurnAttachment;
import { hasInboundMedia } from "./inbound-media.js";

const agentTurnMediaRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-media.runtime.js"),
);

/** Lazily loads media runtime dependencies for agent-turn attachments. */
export function loadAgentTurnMediaRuntime() {
  return agentTurnMediaRuntimeLoader.load();
}

/** Runtime surface needed to resolve agent-turn media attachments. */
type AgentTurnAttachmentRuntime = Pick<
  Awaited<ReturnType<typeof loadAgentTurnMediaRuntime>>,
  | "MediaAttachmentCache"
  | "isMediaUnderstandingSkipError"
  | "normalizeAttachments"
  | "resolveMediaAttachmentLocalRoots"
>;

const AGENT_TURN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_VIDEO_MAX_BYTES = DEFAULT_VIDEO_INLINE_MAX_BYTES;
const AGENT_TURN_ATTACHMENT_TIMEOUT_MS = 1_000;
const AGENT_TURN_ATTACHMENT_VIDEO_TIMEOUT_MS = 10_000;

type AttachmentKind = "image" | "video" | "unsupported";

function classifyAttachment(attachment: MediaAttachment): AttachmentKind {
  const mime = attachment.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "unsupported";
}

function attachmentMaxBytes(kind: AttachmentKind): number {
  return kind === "video" ? AGENT_TURN_ATTACHMENT_VIDEO_MAX_BYTES : AGENT_TURN_ATTACHMENT_MAX_BYTES;
}

/**
 * Provider ids that ship a hosted-files video upload helper compatible with
 * `mm_file://{file_id}` style references for minimax M3 video input. The
 * list is checked in order; the first provider that exposes `uploadVideo`
 * wins. Extend this list when adding new provider integrations.
 */
const VIDEO_UPLOAD_PROVIDER_IDS = ["minimax", "minimax-portal"] as const;

function hasInboundHistoryMedia(ctx: MsgContext): boolean {
  return (
    Array.isArray(ctx.InboundHistory) &&
    ctx.InboundHistory.some((entry) => Array.isArray(entry.media) && entry.media.length > 0)
  );
}

/** Resolves multimodal attachments for the current agent turn and recent media history. */
export async function resolveAgentTurnAttachments(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  runtime?: AgentTurnAttachmentRuntime;
  includeRecentHistoryImages?: boolean;
  includeAttachmentIndexes?: boolean;
}): Promise<{
  attachments: AgentTurnAttachment[];
  attachmentIndexes?: number[];
  recentHistoryImages: RecentInboundHistoryImage[];
}> {
  const includeRecentHistoryImages = params.includeRecentHistoryImages ?? true;
  if (
    !hasInboundMedia(params.ctx) &&
    !(includeRecentHistoryImages && hasInboundHistoryMedia(params.ctx))
  ) {
    return { attachments: [], recentHistoryImages: [] };
  }
  const runtime = params.runtime ?? (await loadAgentTurnMediaRuntime());
  const currentAttachments = runtime
    .normalizeAttachments(params.ctx)
    .map((attachment) =>
      normalizeOptionalString(attachment.path)
        ? Object.assign({}, attachment, { url: undefined })
        : attachment,
    );
  const recentHistoryImages = includeRecentHistoryImages
    ? resolveRecentInboundHistoryImages({ ctx: params.ctx })
    : [];
  const firstHistoryAttachmentIndex =
    currentAttachments.reduce(
      (maxIndex, attachment) =>
        Number.isFinite(attachment.index) ? Math.max(maxIndex, attachment.index) : maxIndex,
      -1,
    ) + 1;
  const historyAttachments: MediaAttachment[] = recentHistoryImages.map((image, index) => ({
    path: image.path,
    mime: image.contentType,
    index: firstHistoryAttachmentIndex + index,
  }));
  const historyAttachmentByIndex = new Map(
    historyAttachments.map((attachment, index) => [attachment.index, recentHistoryImages[index]]),
  );
  const mediaAttachments = [...currentAttachments, ...historyAttachments];
  const cache = new runtime.MediaAttachmentCache(mediaAttachments, {
    localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx: params.ctx,
    }),
  });
  const results: AgentTurnAttachment[] = [];
  const resultIndexes: number[] = [];
  const resolvedHistoryImages: RecentInboundHistoryImage[] = [];

  let providerRegistry: ReturnType<typeof buildMediaUnderstandingRegistry> | undefined;
  const getProviderRegistry = () => {
    providerRegistry ??= buildMediaUnderstandingRegistry(undefined, params.cfg);
    return providerRegistry;
  };

  const resolveVideoViaUpload = async (
    attachment: MediaAttachment,
    preReadBuffer?: Buffer,
    videoMetadata?: VideoMetadata,
  ): Promise<boolean> => {
    const mediaType = attachment.mime ?? "application/octet-stream";
    const path = normalizeOptionalString(attachment.path);
    if (!path) {
      return false;
    }
    let buffer = preReadBuffer;
    if (!buffer) {
      try {
        const fetched = await cache.getBuffer({
          attachmentIndex: attachment.index,
          maxBytes: 512 * 1024 * 1024,
          timeoutMs: AGENT_TURN_ATTACHMENT_VIDEO_TIMEOUT_MS,
        });
        buffer = fetched.buffer;
      } catch (error) {
        const errorName = error instanceof Error ? error.name : typeof error;
        logVerbose(
          `agent-turn-attachments: failed to read oversized video attachment #${attachment.index + 1} (${errorName})`,
        );
        return false;
      }
    }
    for (const providerId of VIDEO_UPLOAD_PROVIDER_IDS) {
      const provider = getMediaUnderstandingProvider(providerId, getProviderRegistry());
      if (!provider?.uploadVideo) {
        continue;
      }
      try {
        const upload = await provider.uploadVideo({
          buffer,
          mimeType: mediaType,
          fileName: path.split(/[\\/]/).pop(),
          purpose: "video_understanding",
          cfg: params.cfg,
        });
        results.push({
          mediaType,
          data: "",
          hostedUrl: upload.url,
          metadata: videoMetadata,
        });
        resultIndexes.push(attachment.index);
        logVerbose(
          `agent-turn-attachments: uploaded oversized video attachment #${attachment.index + 1} (${buffer.byteLength} bytes) via ${providerId} -> ${upload.url}`,
        );
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logWarn(
          `agent-turn-attachments: ${providerId} uploadVideo failed for video attachment #${attachment.index + 1} (${buffer.byteLength} bytes): ${reason}. Dropping the video; set \`models.providers.${providerId}.media.video.mode = "inline"\` in openclaw.json to fall back to inline base64.`,
        );
      }
    }
    return false;
  };

  const resolveMultimodalAttachment = async (attachment: MediaAttachment): Promise<boolean> => {
    const kind = classifyAttachment(attachment);
    if (kind === "unsupported") {
      return false;
    }
    const mediaType = attachment.mime ?? "application/octet-stream";
    const path = normalizeOptionalString(attachment.path);
    if (!path) {
      return false;
    }
    let videoPolicy: InlinePolicy | undefined;
    if (kind === "video") {
      for (const providerId of VIDEO_UPLOAD_PROVIDER_IDS) {
        const policy = resolveVideoDeliveryPolicy(params.cfg, providerId, { hasUploadVideo: true });
        if (policy.forceUseHostedUrl) {
          videoPolicy = policy;
          break;
        }
        if (!videoPolicy) {
          videoPolicy = policy;
          continue;
        }
      }
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: attachmentMaxBytes(kind),
        timeoutMs:
          kind === "video"
            ? AGENT_TURN_ATTACHMENT_VIDEO_TIMEOUT_MS
            : AGENT_TURN_ATTACHMENT_TIMEOUT_MS,
      });
      const videoMetadata: VideoMetadata | undefined =
        kind === "video" ? await probeVideoMetadata(buffer) : undefined;
      if (kind === "video" && videoPolicy?.forceUseHostedUrl) {
        const uploaded = await resolveVideoViaUpload(attachment, buffer, videoMetadata);
        if (uploaded) {
          return true;
        }
        logWarn(
          `agent-turn-attachments: video upload failed for #${attachment.index + 1} (${path}); falling back to inline base64`,
        );
      }
      results.push({
        mediaType,
        data: buffer.toString("base64"),
        metadata: videoMetadata,
      });
      resultIndexes.push(attachment.index);
      const historyImage = historyAttachmentByIndex.get(attachment.index);
      if (historyImage) {
        resolvedHistoryImages.push(historyImage);
      }
      return true;
    } catch (error) {
      // 6/26 PATCH: only fall back to the hosted upload for video when
      // the per-provider policy allows it. Inline mode drops the
      // attachment with a clear log instead of silently re-routing it
      // (which previously hid real upload errors behind the misleading
      // "5MB exceeds 50MB" message in the readVideo tool).
      if (
        kind === "video" &&
        runtime.isMediaUnderstandingSkipError(error) &&
        /size|too large|exceeds/i.test(error.reason)
      ) {
        if (videoPolicy?.allowBase64Override) {
          logWarn(
            `agent-turn-attachments: video attachment #${attachment.index + 1} (${path}) exceeds inline cap and \`media.video.mode\` is "inline" — dropping attachment rather than uploading. Raise \`inlineMaxBytes\` or switch to mode "auto"/"hosted" in openclaw.json to keep the video in the prompt.`,
          );
          return false;
        }
        return await resolveVideoViaUpload(attachment);
      }
      if (runtime.isMediaUnderstandingSkipError(error)) {
        logVerbose(
          `agent-turn-attachments: skipping attachment #${attachment.index + 1} (${error.reason})`,
        );
      } else {
        const errorName = error instanceof Error ? error.name : typeof error;
        logVerbose(
          `agent-turn-attachments: failed to read attachment #${attachment.index + 1} (${errorName})`,
        );
      }
      return false;
    }
  };

  let currentMultimodalResolved = false;
  const hasCurrentMedia = currentAttachments.length > 0;
  const hasCurrentMultimodalCandidate = currentAttachments.some(
    (attachment) => classifyAttachment(attachment) !== "unsupported",
  );
  for (const attachment of currentAttachments) {
    currentMultimodalResolved =
      (await resolveMultimodalAttachment(attachment)) || currentMultimodalResolved;
  }
  if (
    includeRecentHistoryImages &&
    !currentMultimodalResolved &&
    (!hasCurrentMedia || hasCurrentMultimodalCandidate)
  ) {
    // History attachments are only used when the current turn did not already provide one.
    for (const attachment of historyAttachments) {
      await resolveMultimodalAttachment(attachment);
    }
  }
  return {
    attachments: results,
    ...(params.includeAttachmentIndexes ? { attachmentIndexes: resultIndexes } : {}),
    recentHistoryImages: resolvedHistoryImages,
  };
}

/** Converts inline image content into ACP attachment payloads. */
export function resolveInlineAgentMediaAttachments(
  /**
   * 6/25 PATCH: multimodal current-turn blocks (image + video). The legacy
   * ACP attachment payload only carries `data` + `mimeType`; video blocks
   * are forwarded with an empty `data` field so the downstream ACP runtime
   * can attach the hosted URL (set via `hostedUrl` on the attachment)
   * when assembling the final block. Image blocks pass through as before.
   */
  images:
    | Array<
        | { type?: "image"; data: string; mimeType: string }
        | { type?: "video"; data?: string; mimeType: string; url?: string }
      >
    | undefined,
): AgentTurnAttachment[] {
  if (!Array.isArray(images)) {
    return [];
  }
  return (
    images
      .map((image) => {
        const block = image as {
          type?: "image" | "video";
          mimeType: string;
          data?: string;
          url?: string;
        };
        // Video blocks carry a hosted URL (mm_file://{file_id}) instead of
        // inline base64 data. Forward them with an empty `data` field and
        // attach the hosted URL so the ACP runtime can include them in the
        // multimodal content assembly.
        if (block.type === "video") {
          return {
            mediaType: block.mimeType,
            data: block.data ?? "",
            hostedUrl: block.url,
          };
        }
        return {
          mediaType: block.mimeType,
          data: block.data ?? "",
        };
      })
      // 6/27 PATCH: keep video attachments through the same filter as
      // images. The previous filter (`mediaType.startsWith("image/")`)
      // silently dropped inline-base64 videos; only the hosted-URL path
      // survived because it sets `hostedUrl`. With `media.video.mode`
      // supporting inline base64 (commit 59d3106) and the transport
      // routing video blocks (commit bdda47b), the multimodal-image
      // helper needs to forward video blocks too. Symmetric with the
      // attachment pipeline's `classifyAttachment` (which already
      // recognises both image/* and video/*).
      .filter((image) => {
        const isImageOrVideo =
          image.mediaType.startsWith("image/") || image.mediaType.startsWith("video/");
        const hasPayload = image.data.trim().length > 0 || !!image.hostedUrl;
        return isImageOrVideo && hasPayload;
      })
  );
}

/** Back-compat alias for image-only callers; video-capable behavior lives in the media variant. */
export const resolveInlineAgentImageAttachments = resolveInlineAgentMediaAttachments;
