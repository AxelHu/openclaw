// Video dimension helpers read video dimensions through ffprobe.
import { runFfprobe } from "./ffmpeg-exec.js";

/** Positive video dimensions reported by ffprobe for the first video stream. */
export type VideoDimensions = {
  width: number;
  height: number;
};

function parsePositiveDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/** Parses ffprobe JSON output, accepting only positive integer first-stream dimensions. */
export function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined {
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: unknown; height?: unknown }> };
  const stream = parsed.streams?.[0];
  const width = parsePositiveDimension(stream?.width);
  const height = parsePositiveDimension(stream?.height);
  return width && height ? { width, height } : undefined;
}

/** Probes a video buffer through ffprobe stdin and treats probe failures as unknown dimensions. */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  try {
    const stdout = await runFfprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: buffer },
    );
    return parseFfprobeVideoDimensions(stdout);
  } catch {
    return undefined;
  }
}

// 6/29 PATCH: full video metadata (duration + framerate + dimensions) for
// agent cognitive calibration. The model M3 hallucinates duration based on
// (frame_count / framerate) because the minimax /anthropic endpoint
// applies sparse frame sampling (sampled frames are distributed across
// the full time range, not concentrated in any sub-window). To correct
// the model's duration understanding, we inject the actual duration and
// framerate as a text block alongside the video content block so the
// model can use the real values as ground truth.
export type VideoMetadata = {
  width?: number;
  height?: number;
  /** Total video duration in seconds. */
  duration?: number;
  /** Original video frame rate (fps). */
  framerate?: number;
};

function parsePositiveFramerate(value: unknown): number | undefined {
  if (typeof value !== "number" || value <= 0 || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function parsePositiveDuration(value: unknown): number | undefined {
  // 6/29 PATCH (3rd): ffprobe always emits duration as a *string* in JSON
  // (e.g. `"53.916667"` / `"53.930000"` for stream/format). The previous
  // `typeof value !== "number"` short-circuit silently dropped that case,
  // so `m.duration` was always undefined → the `[视频元数据]` text shipped
  // to the model only carried framerate + resolution but no total length,
  // and M3 hallucinated duration (e.g. 8.8s for a 53s video). Coerce
  // strings via Number() and validate the result. Numbers still pass
  // through unchanged so any future numeric input is preserved.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  }
  if (typeof value !== "number" || value <= 0 || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function parseFfprobeVideoMetadata(stdout: string): VideoMetadata | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const stream = streams[0] ?? {};
  const width = parsePositiveDimension(stream.width);
  const height = parsePositiveDimension(stream.height);
  // r_frame_rate is a fraction like "12/1". We want the effective fps.
  let framerate: number | undefined;
  const rfr = stream.r_frame_rate;
  if (typeof rfr === "string") {
    const [num, den] = rfr.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      framerate = num / den;
    }
  } else {
    framerate = parsePositiveFramerate(rfr);
  }
  const duration =
    parsePositiveDuration(stream.duration) ?? parsePositiveDuration(parsed?.format?.duration);
  return { width, height, duration, framerate };
}

export async function probeVideoMetadata(buffer: Buffer): Promise<VideoMetadata | undefined> {
  try {
    const stdout = await runFfprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,duration:format=duration",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: buffer },
    );
    return parseFfprobeVideoMetadata(stdout);
  } catch {
    return undefined;
  }
}
