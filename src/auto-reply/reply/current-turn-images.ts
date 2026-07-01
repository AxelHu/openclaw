// Tracks image and video attachments that belong to the current reply turn.
//
// 6/25 PATCH: extends the image-only pipeline to also inline video
// attachments (mp4/mov/mkv/avi) for direct multimodal processing by
// providers like minimax M3 that accept `type: "video"` blocks.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent, TextContent, VideoContent } from "../../llm/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentMultimodalAttachment = {
  index: number;
  path: string;
  mediaType: string;
};

/** Per-attachment block that may be inline-injected into the agent prompt. */
// 6/29 PATCH: text block added so we can inject video metadata
// (duration / framerate / resolution) alongside the video content
// block. The model M3 hallucinates duration based on (sampled_frames
// / framerate) without this hint, so the metadata text acts as a
// ground-truth calibration.
export type CurrentTurnMediaBlock = ImageContent | VideoContent | TextContent;

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
  /**
   * 6/29 PATCH: video metadata lines (duration / framerate / resolution)
   * for the agent-runner to inject into the user message prompt
   * (concatenated with the user's text). The `media` array is typed
   * `Array<ImageContent | VideoContent>` which silently drops text
   * blocks via a downstream type filter, so we cannot piggyback on
   * `media` to inject the calibration text — the agent-runner has to
   * concatenate these into `params.prompt` directly. Without this hint
   * the model M3 hallucinates duration based on (sampled_frames /
   * framerate) and reports wildly wrong totals (8.8s for a 53s video).
   */
  videoMetadataText?: string;
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
    const media: CurrentTurnMediaBlock[] = [];
    const videoMetadataLines: string[] = [];
    for (const attachment of resolved.attachments) {
      if (attachment.metadata) {
        // 6/29 PATCH: inject a text block with the real video metadata
        // (duration / framerate / resolution) so the model uses the
        // correct total duration instead of hallucinating one based on
        // (sampled_frames / framerate). The minimax /anthropic
        // endpoint applies sparse frame sampling so without this hint
        // the model reports a wildly wrong duration (e.g. 8.8s for a
        // 53s video, 0.4s for a 4.7s video). The text is also where we
        // tell the model that sampled frames cover the full time range
        // (not a sub-window) and that precise timestamps within the
        // sampled sequence are not guaranteed.
        const m = attachment.metadata;
        const bits: string[] = [];
        if (m.duration !== undefined) bits.push(`duration=${m.duration.toFixed(2)}s`);
        if (m.framerate !== undefined) bits.push(`framerate=${m.framerate.toFixed(2)}fps`);
        if (m.width !== undefined && m.height !== undefined) {
          bits.push(`resolution=${m.width}x${m.height}`);
        }
        // 6/30 PATCH (5th): add linear scaling formula. M3 endpoint's frame
        // labels (e.g. "0.0 second" ~ "max_label second") are sample-window
        // relative positions, not actual video seconds. Verified via direct
        // M3 API curl test on a 139.30s parking-lot video: without the
        // formula M3 reported times in [1.2, 27.1]s literal range
        // (sample window). With this formula M3 applied actual ≈
        // label × (duration / max_label) correctly (e.g. label 1.2s ×
        // (139.30/27.6) ≈ 6.0s actual for person #1). The earlier
        // "frames 跨整个时长范围" claim was incorrect — M3 sparse
        // sampling does NOT cover the full duration. We can't pre-compute
        // max_label here (it depends on M3's per-video sampling choice),
        // so the hint tells the model to derive it from the largest
        // frame label it observes and apply the formula.
        //
        // 6/30 PATCH (6th): simplify to 3 explicit points (M3 samples,
        // label is relative, formula with how to get window max). Per
        // master 11:41 feedback: description in Chinese, brief. The
        // formula is forward-compatible: if M3 later fixes labels to
        // match actual seconds, `sample_window_max_label` will equal
        // `duration` and the formula degenerates to `actual ≈ label × 1`
        // (identity) without needing to revise the hint.
        const metaLine = `[视频元数据] ${bits.join(", ")}.\nM3 端点对视频 sparse frame sampling：帧带 "X.X second" label，label 是采样窗口内的相对时间（不是 actual 视频秒）。换算: actual ≈ label × (duration ÷ 采样窗口最大 label)，采样窗口最大 label = 你看到的所有 label 中的最大值。`;
        videoMetadataLines.push(metaLine);
        // 6/29 PATCH: do NOT push the text block into the `media` array.
        // The `images` field in the embedded agent runtime is typed
        // `Array<ImageContent | VideoContent>` and a downstream type
        // filter drops text blocks before they reach the model. The
        // text is returned via `videoMetadataText` instead so the
        // agent-runner can concatenate it into `params.prompt` (the
        // text body of the user message), where it survives alongside
        // the user's question.
        // Push the video content block as before.
        if (attachment.hostedUrl) {
          media.push({ type: "video", mimeType: attachment.mediaType, url: attachment.hostedUrl });
        } else {
          media.push({ type: "video", data: attachment.data, mimeType: attachment.mediaType });
        }
        continue;
      }
      if (attachment.mediaType.startsWith("video/")) {
        // 6/29 PATCH: the inner `if (attachment.metadata) { ... continue; }`
        // branch above already pushed the video block (and routed the
        // metadata text into `videoMetadataLines`). If we fell through
        // to here, the attachment is a video WITHOUT metadata (probe
        // failed) — still emit the content block so the model at least
        // sees the video, even without the duration hint.
        if (attachment.hostedUrl) {
          media.push({
            type: "video",
            mimeType: attachment.mediaType,
            url: attachment.hostedUrl,
          });
        } else {
          media.push({
            type: "video",
            data: attachment.data,
            mimeType: attachment.mediaType,
          });
        }
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
        `agent-runner: native OpenClaw media resolution produced ${media.length}/${undescribedAttachments.length} current attachment(s); falling back to prompt refs`,
      );
      return { media: params.media, imageOrder: params.imageOrder };
    }
    const videoMetadataText =
      videoMetadataLines.length > 0 ? videoMetadataLines.join("\n") : undefined;
    return media.length > 0
      ? { media, imageOrder: media.map(() => "inline" as const), videoMetadataText }
      : { media: params.media, imageOrder: params.imageOrder, videoMetadataText };
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
