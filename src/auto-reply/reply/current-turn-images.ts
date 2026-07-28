// Tracks image and video attachments that belong to the current reply turn.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent, VideoContent } from "../../llm/types.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentMultimodalAttachment = {
  index: number;
  path: string;
  mediaType: string;
};

export type CurrentTurnMediaBlock = ImageContent | VideoContent;

type OrderedTurnImage = {
  image?: CurrentTurnMediaBlock;
  imageOrder: PromptImageOrderEntry;
  sourceIndex?: number;
  sequence: number;
};

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

function appendOrderedImages(params: {
  entries: OrderedTurnImage[];
  images: CurrentTurnMediaBlock[] | undefined;
  imageOrder?: PromptImageOrderEntry[];
  sourceIndex?: number;
}) {
  const images = params.images ?? [];
  if (!params.imageOrder || params.imageOrder.length === 0) {
    for (const image of images) {
      params.entries.push({
        image,
        imageOrder: "inline",
        sourceIndex: params.sourceIndex,
        sequence: params.entries.length,
      });
    }
    return;
  }

  let inlineIndex = 0;
  for (const imageOrder of params.imageOrder) {
    params.entries.push({
      image: imageOrder === "inline" ? images[inlineIndex++] : undefined,
      imageOrder,
      sourceIndex: params.sourceIndex,
      sequence: params.entries.length,
    });
  }
  while (inlineIndex < images.length) {
    params.entries.push({
      image: images[inlineIndex++],
      imageOrder: "inline",
      sourceIndex: params.sourceIndex,
      sequence: params.entries.length,
    });
  }
}

function resolveMergedTurnImages(entries: OrderedTurnImage[]): {
  media?: CurrentTurnMediaBlock[];
  imageOrder?: PromptImageOrderEntry[];
} {
  if (entries.length === 0) {
    return {};
  }
  const merged = entries.toSorted((left, right) => {
    if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
      return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
    }
    if (left.sourceIndex !== undefined || right.sourceIndex !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.sequence - right.sequence;
  });
  const media = merged.flatMap((entry) => (entry.image ? [entry.image] : []));
  return {
    ...(media.length > 0 ? { media } : {}),
    imageOrder: merged.map((entry) => entry.imageOrder),
  };
}

/** Resolves current-turn media attachments that were not already described by media understanding. */
export async function resolveCurrentTurnMedia(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  media?: CurrentTurnMediaBlock[];
  imageOrder?: PromptImageOrderEntry[];
  extractedFileImages?: ExtractedFileImage[];
}): Promise<{
  media?: CurrentTurnMediaBlock[];
  imageOrder?: PromptImageOrderEntry[];
  videoMetadataText?: string;
}> {
  const entries: OrderedTurnImage[] = [];
  appendOrderedImages({
    entries,
    images: params.media,
    imageOrder: params.imageOrder,
  });
  for (const image of params.extractedFileImages ?? []) {
    appendOrderedImages({
      entries,
      images: [stripExtractedFileImageMetadata(image)],
      sourceIndex: image.attachmentIndex,
    });
  }

  const currentAttachments = collectCurrentMultimodalAttachments(params.ctx);
  if (currentAttachments.length === 0) {
    return resolveMergedTurnImages(entries);
  }
  const describedIndexes = collectDescribedAttachmentIndexes(params.ctx);
  const undescribedAttachments = currentAttachments.filter(
    (attachment) => !describedIndexes.has(attachment.index),
  );
  if (undescribedAttachments.length === 0) {
    return resolveMergedTurnImages(entries);
  }

  try {
    // Only send undescribed current attachments natively; described ones already exist as text context.
    const resolved = await resolveAgentTurnAttachments({
      ctx: createUndescribedAttachmentContext(params.ctx, undescribedAttachments),
      cfg: params.cfg,
      includeRecentHistoryImages: false,
    });
    const media: CurrentTurnMediaBlock[] = [];
    const videoMetadataLines: string[] = [];
    for (const attachment of resolved.attachments) {
      if (attachment.mediaType.startsWith("video/")) {
        if (attachment.metadata) {
          const m = attachment.metadata;
          const bits: string[] = [];
          if (m.duration !== undefined) bits.push(`duration=${m.duration.toFixed(2)}s`);
          if (m.framerate !== undefined) bits.push(`framerate=${m.framerate.toFixed(2)}fps`);
          if (m.width !== undefined && m.height !== undefined) {
            bits.push(`resolution=${m.width}x${m.height}`);
          }
          videoMetadataLines.push(
            `[视频元数据] ${bits.join(", ")}.\nM3 端点对视频 sparse frame sampling：帧带 "X.X second" label，label 是采样窗口内的相对时间（不是 actual 视频秒）。换算: actual ≈ label × (duration ÷ 采样窗口最大 label)，采样窗口最大 label = 你看到的所有 label 中的最大值。`,
          );
        }
        media.push(
          attachment.hostedUrl
            ? { type: "video", mimeType: attachment.mediaType, url: attachment.hostedUrl }
            : { type: "video", data: attachment.data, mimeType: attachment.mediaType },
        );
        continue;
      }
      media.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mediaType,
      });
    }
    if (media.length < undescribedAttachments.length) {
      logVerbose(
        `agent-runner: native OpenClaw media resolution produced ${media.length}/${undescribedAttachments.length} current attachment(s); falling back to prompt media refs`,
      );
      return resolveMergedTurnImages(entries);
    }
    for (const [index, image] of media.entries()) {
      appendOrderedImages({
        entries,
        images: [image],
        sourceIndex: undescribedAttachments[index]?.index,
      });
    }
    const merged = resolveMergedTurnImages(entries);
    return {
      ...merged,
      ...(videoMetadataLines.length > 0
        ? { videoMetadataText: videoMetadataLines.join("\n") }
        : {}),
    };
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment resolution failed, proceeding without native media: ${formatErrorMessage(error)}`,
    );
    return resolveMergedTurnImages(entries);
  }
}

/** Back-compat wrapper for image-only call sites and tests. */
export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  extractedFileImages?: ExtractedFileImage[];
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}> {
  const resolved = await resolveCurrentTurnMedia({
    ctx: params.ctx,
    cfg: params.cfg,
    media: params.images,
    imageOrder: params.imageOrder,
    extractedFileImages: params.extractedFileImages,
  });
  const images = resolved.media?.filter((block): block is ImageContent => block.type === "image");
  return {
    ...(images && images.length > 0 ? { images } : {}),
    imageOrder: resolved.imageOrder,
  };
}
