/**
 * 6/26 PATCH: single decision point for "inline base64" vs "hosted URL" video
 * attachment policy. Wraps the 50MB threshold check so the readVideo tool,
 * agent-turn-attachments, and any future caller all agree on when to inline
 * base64 vs when to upload to the provider's Files API (e.g. minimax
 * `mm_file://{file_id}`).
 *
 * Why this exists: base64 video attachments bloat the session jsonl (5MB mp4 →
 * ~7MB base64), and WSL fs sync can corrupt large base64 writes (we've seen
 * 19 segments of video base64 replaced with `…` U+2026 by fs sync). Hosted
 * URL references stay compact (a few hundred bytes) and survive fs sync.
 *
 * Owner plan: once we've validated that hosted URL works for video across the
 * pipeline, flip `forceUseHostedUrl` (or set the inline max to 0) to migrate
 * everyone off base64 in one change.
 */

export const DEFAULT_VIDEO_INLINE_MAX_BYTES = 50 * 1024 * 1024;
// 6/26 PATCH: aligned with the minimax /anthropic endpoint inline video limit
// (50MB). See read-video.ts:50 for the historical rationale.

export type VideoDeliveryMode = "inline_base64" | "hosted_url";

export type InlinePolicy = {
  /** Per-call override for the inline cap (bytes). Used by readVideo({maxBytes}). */
  inlineMaxBytes?: number;
  /**
   * If true, always return "hosted_url" regardless of size. Lets a future
   * migration flip everyone off base64 in one place. Default: false.
   */
  forceUseHostedUrl?: boolean;
  /**
   * If true, allow base64 even when the file is larger than the cap. Used by
   * tests and by callers that have already committed to a particular shape
   * (e.g. providers that reject hosted URL references). Default: false.
   */
  allowBase64Override?: boolean;
};

/**
 * Returns the mode the readVideo pipeline should use for a given video file
 * size. Centralized here so all call sites stay in lockstep.
 *
 * Default behavior (no flags):
 *   - size <= inlineMaxBytes  → "inline_base64"  (small videos stay inline)
 *   - size >  inlineMaxBytes  → "hosted_url"     (large videos upload)
 *
 * With forceUseHostedUrl=true: always "hosted_url".
 * With allowBase64Override=true and size > cap: still "inline_base64".
 */
export function decideVideoDeliveryMode(
  sizeBytes: number,
  policy: InlinePolicy = {},
): VideoDeliveryMode {
  if (policy.forceUseHostedUrl) {
    return "hosted_url";
  }
  const cap = policy.inlineMaxBytes ?? DEFAULT_VIDEO_INLINE_MAX_BYTES;
  if (sizeBytes > cap && !policy.allowBase64Override) {
    return "hosted_url";
  }
  return "inline_base64";
}

/**
 * Convenience: "would this video use base64 given the current policy?" Mirrors
 * the readVideo tool's branch in one boolean so chat-bridge / attachment code
 * can decide whether to start an upload ahead of time.
 */
export function shouldUseHostedVideoUpload(sizeBytes: number, policy: InlinePolicy = {}): boolean {
  return decideVideoDeliveryMode(sizeBytes, policy) === "hosted_url";
}

import type { ModelProviderVideoMode } from "../../../config/types.models.js";
// 6/26 PATCH: helpers that resolve the readVideo/attachment inline-vs-hosted
// policy from OpenClaw config, so deployments can flip the behaviour without
// rebuilding. See `models.providers.<id>.media.video.mode` in openclaw.json.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export type ResolveVideoPolicyInput = {
  /**
   * Whether the provider's media-understanding plugin exposes a working
   * `uploadVideo` helper. When false, hosted mode degrades to inline because
   * there's no other path. The caller decides what "working" means; the
   * default is `true` so existing call sites stay opt-in.
   */
  hasUploadVideo?: boolean;
  /**
   * Override for the default 50MB inline cap. Useful for tests that want
   * to push the boundary.
   */
  defaultInlineMaxBytes?: number;
};

/**
 * Reads `cfg.models.providers.<providerId>.media.video.mode` and returns the
 * corresponding `InlinePolicy`. Defaults to "auto", which preserves the
 * pre-config behaviour: hosted when the provider exposes an upload helper,
 * inline otherwise.
 *
 * The helper never throws on missing keys (providers may not be configured,
 * or the user may have left the field unset). Unknown mode values fall
 * through to "auto" with a log line so we don't silently break the world
 * when the schema is loosened in the future.
 */
export function resolveVideoDeliveryPolicy(
  cfg: OpenClawConfig | undefined,
  providerId: string,
  input: ResolveVideoPolicyInput = {},
): InlinePolicy {
  const hasUploadVideo = input.hasUploadVideo ?? true;
  const inlineMaxBytes = input.defaultInlineMaxBytes ?? DEFAULT_VIDEO_INLINE_MAX_BYTES;
  const fallbackPolicy: InlinePolicy = {
    forceUseHostedUrl: hasUploadVideo,
    inlineMaxBytes,
  };
  if (!cfg) return fallbackPolicy;
  const mode = cfg.models?.providers?.[providerId]?.media?.video?.mode as
    | ModelProviderVideoMode
    | undefined;
  const cfgInlineMaxBytes = cfg.models?.providers?.[providerId]?.media?.video?.inlineMaxBytes;
  const resolvedInlineMaxBytes = cfgInlineMaxBytes ?? inlineMaxBytes;
  switch (mode) {
    case "inline":
      // Force inline base64 even when the file exceeds the cap. The
      // `allowBase64Override` flag tells `decideVideoDeliveryMode` to
      // skip the "size > cap → hosted" branch, so readVideo tool calls
      // return base64 regardless of file size.
      return {
        forceUseHostedUrl: false,
        allowBase64Override: true,
        inlineMaxBytes: resolvedInlineMaxBytes,
      };
    case "hosted":
      // Force hosted upload even when the file is small. If there's no
      // upload helper we can't actually host; fall through to inline so
      // the caller at least sees a clear "size > cap" error rather than
      // a generic upload failure.
      return {
        forceUseHostedUrl: hasUploadVideo,
        inlineMaxBytes: resolvedInlineMaxBytes,
      };
    case "auto":
    case undefined:
    default:
      // 6/27 PATCH: `auto` returns `forceUseHostedUrl: false` so the
      // caller (readVideo tool or attachment pipeline) goes through
      // `decideVideoDeliveryMode`'s size-based default: ≤ cap inline,
      // > cap hosted (provided the provider exposes an `uploadVideo`
      // helper, otherwise the caller reports "no helper"). This matches
      // the 6/25 legacy behaviour where small videos stay inline and
      // large ones upload. Previously this branch returned
      // `forceUseHostedUrl: hasUploadVideo` which forced all videos
      // through the upload path and dropped them on a minimax API
      // regression (response missing `file_id`).
      return {
        forceUseHostedUrl: false,
        inlineMaxBytes: resolvedInlineMaxBytes,
      };
  }
}
