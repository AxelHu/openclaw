/** Resolves media attachments available to the current agent turn. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment as AgentTurnAttachment } from "../../acp/control-plane/manager.types.js";
import { DEFAULT_VIDEO_INLINE_MAX_BYTES } from "../../agents/sessions/tools/video-inline-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import { isVideoMediaFact, type MediaFact } from "../../media/media-facts.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
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
type AgentTurnAttachmentRuntime = Pick<
  Awaited<ReturnType<typeof loadAgentTurnMediaRuntime>>,
  | "MediaAttachmentCache"
  | "isImageAttachment"
  | "isMediaUnderstandingSkipError"
  | "normalizeAttachments"
  | "resolveMediaAttachmentLocalRoots"
>;

const AGENT_TURN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_TIMEOUT_MS = 1_000;
const AGENT_TURN_VIDEO_ATTACHMENT_MAX_BYTES = DEFAULT_VIDEO_INLINE_MAX_BYTES;
const AGENT_TURN_VIDEO_ATTACHMENT_TIMEOUT_MS = 10_000;

function hasInboundHistoryMedia(ctx: MsgContext): boolean {
  return (
    Array.isArray(ctx.InboundHistory) &&
    ctx.InboundHistory.some((entry) => Array.isArray(entry.media) && entry.media.length > 0)
  );
}

/** Current-turn image indexes already represented by media-understanding text. */
export function collectDescribedImageAttachmentIndexes(ctx: MsgContext): Set<number> {
  return new Set(
    ctx.MediaUnderstanding?.filter((output) => output.kind === "image.description").map(
      (output) => output.attachmentIndex,
    ) ?? [],
  );
}

/** Resolves image/video attachments for the current agent turn and recent image history. */
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
    ? resolveRecentInboundHistoryImages({
        ctx: params.ctx,
        isImageAttachment: runtime.isImageAttachment,
      })
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
    kind: image.kind,
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
  const resolveMultimodalAttachment = async (attachment: MediaAttachment): Promise<boolean> => {
    const isImage = runtime.isImageAttachment(attachment);
    const isVideo = attachment.mime?.startsWith("video/") === true;
    if (!isImage && !isVideo) {
      return false;
    }
    if (!normalizeOptionalString(attachment.path)) {
      return false;
    }
    try {
      const { buffer, mime: mediaType } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: isVideo ? AGENT_TURN_VIDEO_ATTACHMENT_MAX_BYTES : AGENT_TURN_ATTACHMENT_MAX_BYTES,
        timeoutMs: isVideo
          ? AGENT_TURN_VIDEO_ATTACHMENT_TIMEOUT_MS
          : AGENT_TURN_ATTACHMENT_TIMEOUT_MS,
      });
      // Declared kind selects the candidate; byte-aware cache detection owns the actual MIME.
      if (
        !mediaType ||
        (isImage && !mediaType?.startsWith("image/")) ||
        (isVideo && !mediaType?.startsWith("video/"))
      ) {
        return false;
      }
      results.push({
        mediaType,
        data: buffer.toString("base64"),
      });
      resultIndexes.push(attachment.index);
      const historyImage = isImage ? historyAttachmentByIndex.get(attachment.index) : undefined;
      if (historyImage) {
        resolvedHistoryImages.push(historyImage);
      }
      return true;
    } catch (error) {
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

  const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
  let currentImageResolved = false;
  const hasCurrentImageCandidate = currentAttachments.some(runtime.isImageAttachment);
  for (const attachment of currentAttachments) {
    if (describedImageIndexes.has(attachment.index) && runtime.isImageAttachment(attachment)) {
      // A described image satisfies this turn without rehydrating it or reviving image history.
      currentImageResolved = true;
      continue;
    }
    const resolved = await resolveMultimodalAttachment(attachment);
    currentImageResolved =
      (runtime.isImageAttachment(attachment) && resolved) || currentImageResolved;
  }
  if (
    includeRecentHistoryImages &&
    !currentImageResolved &&
    (currentAttachments.length === 0 || hasCurrentImageCandidate)
  ) {
    // History images are only used when the current turn did not already provide an image.
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
export function resolveInlineAgentImageAttachments(
  images: Array<{ data: string; mimeType: string }> | undefined,
): AgentTurnAttachment[] {
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .map((image) => ({
      mediaType: image.mimeType,
      data: image.data,
    }))
    .filter((image) => image.mediaType.startsWith("image/") && image.data.trim().length > 0);
}

/** Hydrates canonical current-turn video facts for ACP command ingress. */
export async function resolveAgentMediaFactVideoAttachments(
  media: readonly MediaFact[] | undefined,
  workspaceDir?: string,
): Promise<AgentTurnAttachment[]> {
  if (!Array.isArray(media)) {
    return [];
  }
  const attachments: AgentTurnAttachment[] = [];
  for (const fact of media) {
    if (!isVideoMediaFact(fact) || fact.hydrationSuppressed === true || fact.providerReference) {
      continue;
    }
    const mediaRef =
      fact.url?.startsWith("media://inbound/") === true
        ? fact.url
        : (normalizeOptionalString(fact.path) ?? normalizeOptionalString(fact.url));
    if (!mediaRef) {
      continue;
    }
    try {
      const loaded = await loadWebMediaRaw(mediaRef, {
        maxBytes: AGENT_TURN_VIDEO_ATTACHMENT_MAX_BYTES,
        workspaceDir: fact.workspaceDir ?? workspaceDir,
      });
      if (loaded.kind !== "video" || !loaded.contentType?.startsWith("video/")) {
        continue;
      }
      attachments.push({
        mediaType: loaded.contentType,
        data: loaded.buffer.toString("base64"),
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      logVerbose(`agent-turn-attachments: failed to hydrate ACP video fact (${errorName})`);
    }
  }
  return attachments;
}
