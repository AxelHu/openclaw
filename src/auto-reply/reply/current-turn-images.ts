// Tracks image and video attachments that belong to the current reply turn.
//
// 6/25 PATCH: extends the image-only pipeline to also inline video
// attachments (mp4/mov/webm/avi/3gp) for direct multimodal processing by
// providers like minimax M3 that accept `type: "video"` blocks.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent, VideoContent } from "../../llm/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentMultimodalAttachment = {
  index: number;
  path: string;
  mediaType: string;
};

/** Per-attachment block that may be inline-injected into the agent prompt. */
export type CurrentTurnMediaBlock = ImageContent | VideoContent;

function isGenericMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) {
    return true;
  }
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

/** Resolves media types from current-turn attachment metadata or filenames. */
function resolveCurrentMediaType(pathValue: unknown, mediaType?: unknown): string | undefined {
  const mediaPath = normalizeOptionalString(pathValue);
  if (!mediaPath) {
    return undefined;
  }
  const normalizedMediaType = normalizeOptionalString(mediaType);
  if (normalizedMediaType?.startsWith("image/") || normalizedMediaType?.startsWith("video/")) {
    return normalizedMediaType;
  }
  if (!isGenericMediaType(normalizedMediaType)) {
    return undefined;
  }
  const inferredType = mimeTypeFromFilePath(mediaPath);
  if (inferredType?.startsWith("image/") || inferredType?.startsWith("video/")) {
    return inferredType;
  }
  return undefined;
}

function collectCurrentMultimodalAttachments(ctx: MsgContext): CurrentMultimodalAttachment[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : normalizeOptionalString(ctx.MediaPath)
        ? [ctx.MediaPath]
        : [];
  if (paths.length === 0) {
    return [];
  }
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const attachments: CurrentMultimodalAttachment[] = [];
  for (const [index, pathValue] of paths.entries()) {
    const mediaPath = normalizeOptionalString(pathValue);
    const mediaType = resolveCurrentMediaType(pathValue, types?.[index] ?? ctx.MediaType);
    if (mediaPath && mediaType) {
      attachments.push({ index, path: mediaPath, mediaType });
    }
  }
  return attachments;
}

function collectDescribedAttachmentIndexes(ctx: MsgContext): Set<number> {
  return new Set(
    ctx.MediaUnderstanding?.filter((output) => output.kind === "image.description").map(
      (output) => output.attachmentIndex,
    ) ?? [],
  );
}

function createUndescribedAttachmentContext(
  ctx: MsgContext,
  undescribedAttachments: CurrentMultimodalAttachment[],
): MsgContext {
  const first = undescribedAttachments[0];
  return {
    ...ctx,
    MediaPath: first?.path,
    MediaType: first?.mediaType,
    MediaPaths: undescribedAttachments.map((attachment) => attachment.path),
    MediaTypes: undescribedAttachments.map((attachment) => attachment.mediaType),
  };
}

/** Resolves current-turn multimodal attachments that were not already described by media understanding. */
export async function resolveCurrentTurnMedia(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  media?: CurrentTurnMediaBlock[];
  imageOrder?: PromptImageOrderEntry[];
}): Promise<{
  media?: CurrentTurnMediaBlock[];
  imageOrder?: PromptImageOrderEntry[];
}> {
  if (Array.isArray(params.media) && params.media.length > 0) {
    return { media: params.media, imageOrder: params.imageOrder };
  }

  const currentAttachments = collectCurrentMultimodalAttachments(params.ctx);
  if (currentAttachments.length === 0) {
    return { media: params.media, imageOrder: params.imageOrder };
  }
  const describedIndexes = collectDescribedAttachmentIndexes(params.ctx);
  const undescribedAttachments = currentAttachments.filter(
    (attachment) => !describedIndexes.has(attachment.index),
  );
  if (undescribedAttachments.length === 0) {
    return { media: params.media, imageOrder: params.imageOrder };
  }

  try {
    // Only send undescribed current attachments natively; described ones already exist as text context.
    const resolved = await resolveAgentTurnAttachments({
      ctx: createUndescribedAttachmentContext(params.ctx, undescribedAttachments),
      cfg: params.cfg,
      includeRecentHistoryImages: false,
    });
    const media = resolved.attachments.map((attachment): CurrentTurnMediaBlock => {
      if (attachment.mediaType.startsWith("video/")) {
        // Hosted (oversized) video attachments carry a `hostedUrl` instead
        // of base64 data; forward as a URL-style video block.
        if (attachment.hostedUrl) {
          return {
            type: "video",
            mimeType: attachment.mediaType,
            url: attachment.hostedUrl,
          };
        }
        return {
          type: "video",
          data: attachment.data,
          mimeType: attachment.mediaType,
        };
      }
      return {
        type: "image",
        data: attachment.data,
        mimeType: attachment.mediaType,
      };
    });
    if (media.length < undescribedAttachments.length) {
      logVerbose(
        `agent-runner: native OpenClaw media resolution produced ${media.length}/${undescribedAttachments.length} current attachment(s); falling back to prompt refs`,
      );
      return { media: params.media, imageOrder: params.imageOrder };
    }
    return media.length > 0
      ? { media, imageOrder: media.map(() => "inline" as const) }
      : { media: params.media, imageOrder: params.imageOrder };
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment resolution failed, proceeding without native media: ${formatErrorMessage(error)}`,
    );
    return { media: params.media, imageOrder: params.imageOrder };
  }
}

/**
 * @deprecated Use `resolveCurrentTurnMedia` instead. Kept for backwards
 * compatibility with callers that only consume image blocks.
 */
export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}> {
  const result = await resolveCurrentTurnMedia({
    ctx: params.ctx,
    cfg: params.cfg,
    media: params.images,
    imageOrder: params.imageOrder,
  });
  return {
    images: result.media?.filter((m): m is ImageContent => m.type === "image"),
    imageOrder: result.imageOrder,
  };
}
