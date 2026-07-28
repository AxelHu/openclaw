/**
 * Video frame extraction helper (OpenClaw)
 *
 * 抽帧走 ffmpeg image2 muxer，作为 OpenClaw "video → multi-image" 兼容层的
 * 基础能力。**不改 model transport**，对调用方来说就是 N 张静帧。
 *
 * 用法:
 *   const frames = await extractVideoFrames({
 *     buffer: videoBuffer,        // 来自 web-media / fs / data:URL
 *     inputExtension: ".mp4",
 *     maxFrames: 6,
 *   });
 *   // frames: [{ buffer, mimeType: "image/jpeg", fileName, index }, ...]
 *
 * 设计目标:
 *   - 零 API 兼容性风险（M3 不用支持 video，model 看到 N 张图）
 *   - 抽帧数上限 6，FPS 1，宽度 720（够描述"在干啥"，不爆 token）
 *   - 失败 / 抽不到 → 返回空数组（不抛，调用方决定怎么办）
 */

import path from "node:path";
import { withTempWorkspace, type TempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg } from "./ffmpeg-exec.js";

const DEFAULT_MAX_FRAMES = 3;
const DEFAULT_FPS = 1;
const DEFAULT_MAX_WIDTH = 720;
const DEFAULT_JPEG_QUALITY = 3; // ffmpeg q:v scale: 2 (best) - 31 (worst)
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024; // 4MB per frame cap

export type VideoFrame = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  index: number;
};

export type ExtractVideoFramesParams = {
  buffer: Buffer;
  inputExtension?: string;
  inputFileName?: string;
  maxFrames?: number;
  fps?: number;
  maxWidth?: number;
  jpegQuality?: number;
  timeoutMs?: number;
};

function normalizeInputExtension(params: ExtractVideoFramesParams): string {
  const fromExt = params.inputExtension?.trim();
  if (fromExt) {
    return fromExt.startsWith(".") ? fromExt.toLowerCase() : `.${fromExt.toLowerCase()}`;
  }
  if (params.inputFileName) {
    const ext = path.extname(params.inputFileName);
    if (ext) return ext.toLowerCase();
  }
  return ".mp4";
}

function frameFileName(index: number): string {
  return `frame-${String(index).padStart(3, "0")}.jpg`;
}

// ffmpeg image2 muxer sequence pattern (writes frame-000.jpg, frame-001.jpg, ...).
function frameOutputPattern(): string {
  return "frame-%03d.jpg";
}

async function readFrameIfExists(
  workspace: TempWorkspace,
  index: number,
): Promise<VideoFrame | null> {
  const fileName = frameFileName(index);
  try {
    const buffer = await workspace.read(fileName);
    if (buffer.length === 0) return null;
    if (buffer.length > MAX_FRAME_BYTES) return null;
    return { buffer, mimeType: "image/jpeg", fileName, index };
  } catch {
    return null;
  }
}

/**
 * Extract up to `maxFrames` evenly-spaced frames from a video buffer.
 * Returns frames in temporal order (frame-000.jpg is earliest in the video).
 *
 * Best-effort: never throws on missing frames / zero-length video.
 * Only throws if ffmpeg itself fails (e.g., corrupt input).
 */
export async function extractVideoFrames(params: ExtractVideoFramesParams): Promise<VideoFrame[]> {
  const maxFrames = Math.max(1, Math.min(32, params.maxFrames ?? DEFAULT_MAX_FRAMES));
  const fps = Math.max(0.1, Math.min(4, params.fps ?? DEFAULT_FPS));
  const maxWidth = Math.max(64, Math.min(1920, params.maxWidth ?? DEFAULT_MAX_WIDTH));
  const jpegQuality = Math.max(2, Math.min(31, params.jpegQuality ?? DEFAULT_JPEG_QUALITY));
  const timeoutMs = Math.max(5_000, Math.min(120_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "video-frames-",
    },
    async (workspace) => {
      const ext = normalizeInputExtension(params);
      const inputPath = await workspace.write(`input${ext}`, params.buffer);
      // image2 muxer 需要 %03d 这种 pattern 才能写多文件。
      // workspace.path() 返回绝对路径，ffmpeg 用这个 path 作 pattern 即可。
      const outputPattern = workspace.path(frameOutputPattern());

      // ffmpeg image2 muxer: -vf "fps=N,scale=min(W,iw):-1" -frames:v N
      // -frames:v 限制总帧数；-q:v 控 JPEG 质量
      // -loglevel error: 静默 ffmpeg banner，只显示 error
      // -y: 覆盖已有输出
      // -start_number 0: image2 muxer 默认 1-based（写 frame-001.jpg），强制 0-based 与 readFrameIfExists 对齐
      await runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inputPath,
          "-vf",
          `fps=${fps},scale='min(${maxWidth},iw)':-1`,
          "-frames:v",
          String(maxFrames),
          "-q:v",
          String(jpegQuality),
          "-start_number",
          "0",
          outputPattern,
        ],
        { timeoutMs },
      );

      // Read back frames (frame-000.jpg, frame-001.jpg, ...).
      // Stop on first miss — ffmpeg writes them in order with %03d padding.
      const frames: VideoFrame[] = [];
      for (let i = 0; i < maxFrames; i++) {
        const frame = await readFrameIfExists(workspace, i);
        if (!frame) break;
        frames.push(frame);
      }
      return frames;
    },
  );
}
