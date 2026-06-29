/** Resolves media attachments available to the current agent turn. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment as AgentTurnAttachment } from "../../acp/control-plane/manager.types.js";
import {
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
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { MsgContext } from "../templating.js";
import {
  type RecentInboundHistoryImage,
  resolveRecentInboundHistoryImages,
} from "./history-media.js";
import { hasInboundMedia } from "./inbound-media.js";

const agentTurnMediaRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-media.runtime.js"),
);

/** Lazily loads media runtime dependencies for agent-turn attachments. */
export function loadAgentTurnMediaRuntime() {
  return agentTurnMediaRuntimeLoader.load();
}

/** Runtime surface needed to resolve agent-turn media attachments. */
export type AgentTurnAttachmentRuntime = Pick<
  Awaited<ReturnType<typeof loadAgentTurnMediaRuntime>>,
  | "MediaAttachmentCache"
  | "isMediaUnderstandingSkipError"
  | "normalizeAttachments"
  | "resolveMediaAttachmentLocalRoots"
>;

const AGENT_TURN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_TIMEOUT_MS = 1_000;

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

/** True when current or recent inbound history may contain agent-turn attachments. */
export function hasPotentialAgentTurnAttachments(ctx: MsgContext): boolean {
  return hasInboundMedia(ctx) || hasInboundHistoryMedia(ctx);
}

/** Resolves image attachments for the current agent turn and recent image history. */
export async function resolveAgentTurnAttachments(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  runtime?: AgentTurnAttachmentRuntime;
  includeRecentHistoryImages?: boolean;
}): Promise<{
  attachments: AgentTurnAttachment[];
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
  const resolvedHistoryImages: RecentInboundHistoryImage[] = [];

  // Build the media-understanding provider registry once so we can route
  // oversized video attachments through the provider's hosted Files API
  // (e.g. minimax `uploadVideo` → `mm_file://{file_id}`) instead of dropping
  // them.
  const providerRegistry = buildMediaUnderstandingRegistry(undefined, params.cfg);

  // 6/26 PATCH: helper that takes an already-read buffer so the hosted
  // branch can re-use the inline read. Returns false on upload failure
  // (no silent fallback to inline).
  const resolveVideoViaUpload = async (
    attachment: MediaAttachment,
    preReadBuffer?: Buffer,
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
          // Read up to 512MB (matches minimax Files API upload cap). If the
          // file is larger we still want to surface the failure explicitly
          // rather than silently truncating.
          maxBytes: 512 * 1024 * 1024,
          timeoutMs: AGENT_TURN_ATTACHMENT_TIMEOUT_MS,
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
      const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
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
        // Encode the hosted file reference as data: URL with a special
        // "video/hosted" mediaType so downstream consumers can detect it
        // and forward it as a `{type: "video", source: {type: "url",
        // url: "mm_file://..."}}` block to the model. The shape mirrors
        // `resolveInlineAgentMediaAttachments` but carries a hosted URL
        // instead of base64 data.
        results.push({
          mediaType,
          data: "",
          hostedUrl: upload.url,
        });
        logVerbose(
          `agent-turn-attachments: uploaded oversized video attachment #${attachment.index + 1} (${buffer.byteLength} bytes) via ${providerId} -> ${upload.url}`,
        );
        return true;
      } catch (error) {
        // 6/26 PATCH: surface the real upload error so the failure is
        // visible in the gateway log (not buried in `logVerbose` only).
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
    // 6/26 PATCH: resolve the per-provider video delivery policy so
    // `media.video.mode` flips the inline-vs-hosted branch. Image
    // attachments are unaffected.
    let videoPolicy: InlinePolicy | undefined;
    if (kind === "video") {
      for (const providerId of VIDEO_UPLOAD_PROVIDER_IDS) {
        const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
        const hasUploadVideo = provider?.uploadVideo !== undefined;
        const policy = resolveVideoDeliveryPolicy(params.cfg, providerId, { hasUploadVideo });
        if (hasUploadVideo) {
          videoPolicy = policy;
          break;
        }
        if (policy.forceUseHostedUrl) {
          // Hosted mode requested but no helper on this provider; keep
          // looking so we don't pin to a provider that can't honour it.
          continue;
        }
        videoPolicy = policy;
        break;
      }
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: attachmentMaxBytes(kind),
        timeoutMs: AGENT_TURN_ATTACHMENT_TIMEOUT_MS,
      });
      // 6/26 PATCH: hosted mode forces the upload path even for small
      // videos that fit the inline cap. Re-use the buffer we just read
      // to avoid a second fs round trip.
      if (kind === "video" && videoPolicy?.forceUseHostedUrl) {
        const uploaded = await resolveVideoViaUpload(attachment, buffer);
        if (uploaded) {
          return true;
        }
        // 6/29 PATCH: hosted upload failed (e.g. Files API regression,
        // rate limit, network glitch). Fall back to inline base64 so the
        // model can still see the video. Previously this branch returned
        // false on failure, silently dropping the video and leaving only
        // a text placeholder in the prompt (Hunter session 6/29 00:20 was
        // the production case). Note: the 16MB inline cap is applied to
        // the raw read, so a true size-exceeded upload already errored
        // earlier in `cache.getBuffer`.
        logWarn(
          `agent-turn-attachments: video upload failed for #${attachment.index + 1} (${path}); falling back to inline base64`,
        );
        // Fall through to the inline push below.
      }
      results.push({
        mediaType,
        data: buffer.toString("base64"),
      });
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
        if (videoPolicy && !videoPolicy.forceUseHostedUrl) {
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
  return { attachments: results, recentHistoryImages: resolvedHistoryImages };
}

/** Resolves only the attachment payloads for callers that do not need history metadata. */
export async function resolveAgentAttachments(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  runtime?: AgentTurnAttachmentRuntime;
}): Promise<AgentTurnAttachment[]> {
  return (await resolveAgentTurnAttachments(params)).attachments;
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
