// Feishu plugin module implements video preflight behavior.
//
// 6/24 PATCH: Adds native video preflight for Feishu inbound video messages.
//
// Background:
// - OpenClaw's main Anthropic transport now supports the `type: "video"` content
//   block (see src/llm/providers/anthropic.ts convertContentBlocks). This
//   means the agent can send video files directly to models like minimax M3
//   via the standard chat completion flow (no frame extraction needed).
// - For minimax M3, two transport paths are supported:
//   * Files <= 50MB: send as `type: "video", source: {type: "base64", data}`
//   * Files > 50MB: upload to minimax /v1/files/upload with
//     `purpose: "video_understanding"`, get file_id, then reference via
//     `type: "video", source: {type: "url", url: "mm_file://{file_id}"}`
//
// Design note:
// - This module is intentionally decoupled from the minimax extension.
//   It accepts a `uploadFile` function as a parameter, so the caller
//   (bot.ts) injects the minimax implementation via dependency injection
//   rather than via cross-extension import. This matches the OpenClaw
//   plugin SDK conventions where extensions must not import each other
//   directly.
// - Mirrors the audio preflight pattern: see
//   extensions/feishu/src/audio-preflight.runtime.ts.

import { readRegularFile } from "openclaw/plugin-sdk/security-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";

/** Per the Feishu inbound media pipeline (bot-content.ts resolveFeishuMediaList). */
export type FeishuVideoMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
  fileName?: string;
};

/** The shape the agent's convertContentBlocks understands (see packages/llm-core/src/types.ts). */
export type PreflightedVideoBlock = {
  type: "video";
  mimeType: string;
  /** base64-encoded data for files <= 50MB. Mutually exclusive with url. */
  data?: string;
  /** Reference to uploaded file for files > 50MB (mm_file://{file_id}). */
  url?: string;
};

/** Minimal contract for the file upload helper, decoupled from any specific provider. */
export type UploadFileFn = (params: {
  cfg: ClawdbotConfig;
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  /** The provider-specific purpose, e.g. "video_understanding" for minimax. */
  purpose: string;
}) => Promise<{ file_id: string; bytes?: number; filename?: string }>;

export type PreflightFeishuVideoParams = {
  cfg: ClawdbotConfig;
  mediaList: FeishuVideoMediaInfo[];
  /**
   * File upload implementation. The caller (e.g. bot.ts) injects the
   * minimax upload function here. Required when the message contains
   * a video > inlineMaxBytes.
   */
  uploadFile?: UploadFileFn;
  /**
   * Purpose value to pass to `uploadFile` for video files.
   * Defaults to "video_understanding" (the minimax Files API purpose
   * for M3 native video input). Callers that wire in a different
   * provider should override this.
   */
  videoPurpose?: string;
  /**
   * OpenClaw provider id for the model that will receive the video.
   * Currently unused by the preflight itself; reserved for future
   * per-provider size thresholds.
   */
  providerId?: string;
  /**
   * Inline size threshold (in bytes). Videos <= this size are sent as
   * base64; videos > this size are uploaded via uploadFile. Defaults
   * to 50MB to match the minimax /anthropic endpoint limit.
   */
  inlineMaxBytes?: number;
  /** Optional log function for diagnostics. */
  log?: (msg: string) => void;
};

export type PreflightFeishuVideoResult = {
  /** Successfully preflighted video blocks ready for agent inbound. */
  blocks: PreflightedVideoBlock[];
  /** Indices into mediaList that could not be preflighted (oversized without upload, upload failed, etc.). */
  failed: Array<{ index: number; reason: string }>;
};

const DEFAULT_INLINE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_VIDEO_PURPOSE = "video_understanding";

function isVideoMime(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.startsWith("video/");
}

/**
 * Resolve a Feishu video message into one or more video content blocks the
 * agent can consume. The function is a no-op (returns empty blocks) when:
 * - the message has no video media
 *
 * Callers (e.g. bot.ts handleFeishuMessage) should splice the returned
 * blocks into the agent's content stream, replacing the original
 * "[Video]" placeholder.
 *
 * @throws Never throws — failures are returned in the `failed` list so
 *         the caller can decide whether to log, retry, or fall back.
 */
export async function preflightFeishuVideo(
  params: PreflightFeishuVideoParams,
): Promise<PreflightFeishuVideoResult> {
  const inlineMaxBytes = params.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  const videoPurpose = params.videoPurpose ?? DEFAULT_VIDEO_PURPOSE;
  const log = params.log ?? (() => {});

  const videoMedia = params.mediaList.filter((media) => isVideoMime(media.contentType));
  if (videoMedia.length === 0) {
    return { blocks: [], failed: [] };
  }

  const blocks: PreflightedVideoBlock[] = [];
  const failed: Array<{ index: number; reason: string }> = [];

  for (const media of videoMedia) {
    const originalIndex = params.mediaList.indexOf(media);
    const mimeType = media.contentType ?? "video/mp4";

    let buffer: Buffer;
    try {
      const readResult = await readRegularFile({ filePath: media.path });
      buffer = readResult.buffer;
    } catch (err) {
      failed.push({
        index: originalIndex,
        reason: `read failed: ${String(err)}`,
      });
      log(`feishu: video preflight read failed for media[${originalIndex}]: ${String(err)}`);
      continue;
    }

    if (buffer.byteLength > inlineMaxBytes) {
      if (!params.uploadFile) {
        failed.push({
          index: originalIndex,
          reason: `video exceeds ${inlineMaxBytes} bytes but no uploadFile function configured`,
        });
        log(
          `feishu: video preflight cannot upload ${buffer.byteLength} bytes (no uploadFile configured)`,
        );
        continue;
      }
      try {
        const upload = await params.uploadFile({
          cfg: params.cfg,
          buffer,
          mimeType,
          fileName: media.fileName,
          purpose: videoPurpose,
        });
        blocks.push({
          type: "video",
          mimeType,
          url: `mm_file://${upload.file_id}`,
        });
        log(
          `feishu: video preflight uploaded ${buffer.byteLength} bytes -> mm_file://${upload.file_id}`,
        );
      } catch (err) {
        failed.push({
          index: originalIndex,
          reason: `upload failed: ${String(err)}`,
        });
        log(`feishu: video preflight upload failed for media[${originalIndex}]: ${String(err)}`);
      }
      continue;
    }

    // Inline as base64
    blocks.push({
      type: "video",
      mimeType,
      data: buffer.toString("base64"),
    });
    log(
      `feishu: video preflight inlined ${buffer.byteLength} bytes as base64 (size <= ${inlineMaxBytes})`,
    );
  }

  return { blocks, failed };
}

// Internal exports for testing
export const __testing = {
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_VIDEO_PURPOSE,
  isVideoMime,
};
