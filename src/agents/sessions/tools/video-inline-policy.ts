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
