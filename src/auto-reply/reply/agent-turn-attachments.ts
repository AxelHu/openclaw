/** Resolves media attachments available to the current agent turn. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment as AgentTurnAttachment } from "../../acp/control-plane/manager.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
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

  const resolveVideoViaUpload = async (attachment: MediaAttachment): Promise<boolean> => {
    const mediaType = attachment.mime ?? "application/octet-stream";
    const path = normalizeOptionalString(attachment.path);
    if (!path) {
      return false;
    }
    let buffer: Buffer;
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
        // `resolveInlineAgentImageAttachments` but carries a hosted URL
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
        logVerbose(
          `agent-turn-attachments: ${providerId} uploadVideo failed for attachment #${attachment.index + 1}: ${error instanceof Error ? error.message : String(error)}`,
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
    if (!normalizeOptionalString(attachment.path)) {
      return false;
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: attachmentMaxBytes(kind),
        timeoutMs: AGENT_TURN_ATTACHMENT_TIMEOUT_MS,
      });
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
      // Oversized video: fall back to provider-hosted Files API upload
      // (e.g. minimax `uploadVideo` → `mm_file://{file_id}`) so the model
      // still receives a video block instead of `[video]` placeholder.
      if (
        kind === "video" &&
        runtime.isMediaUnderstandingSkipError(error) &&
        /size|too large|exceeds/i.test(error.reason)
      ) {
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
export function resolveInlineAgentImageAttachments(
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
  return images
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
    .filter((image) => image.mediaType.startsWith("image/") && image.data.trim().length > 0);
}
