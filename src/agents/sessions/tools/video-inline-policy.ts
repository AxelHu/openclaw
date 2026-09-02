import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeMediaProviderId } from "../../../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export const DEFAULT_VIDEO_INLINE_MAX_BYTES = MAX_VIDEO_BYTES;
export const DEFAULT_VIDEO_HOSTED_MAX_BYTES = 512 * 1024 * 1024;

type VideoDeliveryMode = "auto" | "inline" | "hosted";
export type ResolvedVideoDelivery = "inline" | "hosted" | "unsupported";

export type VideoDeliveryPolicy = {
  mode: VideoDeliveryMode;
  inlineMaxBytes: number;
  hostedMaxBytes: number;
};

function resolveVideoByteLimit(value: unknown, fallback: number): number {
  return Math.min(asPositiveSafeInteger(value) ?? fallback, DEFAULT_VIDEO_HOSTED_MAX_BYTES);
}

export function resolveVideoDeliveryPolicy(
  cfg: OpenClawConfig | undefined,
  providerId: string | undefined,
): VideoDeliveryPolicy {
  const normalizedProviderId = providerId?.trim().toLowerCase();
  const canonicalProviderId = normalizedProviderId
    ? normalizeMediaProviderId(normalizedProviderId)
    : undefined;
  const providers = cfg?.models?.providers;
  const configured =
    (normalizedProviderId ? providers?.[normalizedProviderId] : undefined)?.media?.video ??
    (canonicalProviderId ? providers?.[canonicalProviderId] : undefined)?.media?.video;
  return {
    mode: configured?.mode ?? "auto",
    inlineMaxBytes: resolveVideoByteLimit(
      configured?.inlineMaxBytes,
      DEFAULT_VIDEO_INLINE_MAX_BYTES,
    ),
    hostedMaxBytes: resolveVideoByteLimit(
      configured?.hostedMaxBytes,
      DEFAULT_VIDEO_HOSTED_MAX_BYTES,
    ),
  };
}

export function decideVideoDelivery(params: {
  sizeBytes: number;
  policy: VideoDeliveryPolicy;
  canHost: boolean;
}): ResolvedVideoDelivery {
  const { sizeBytes, policy, canHost } = params;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return "unsupported";
  }
  if (policy.mode === "hosted") {
    return canHost && sizeBytes <= policy.hostedMaxBytes ? "hosted" : "unsupported";
  }
  if (sizeBytes <= policy.inlineMaxBytes) {
    return "inline";
  }
  if (policy.mode === "inline") {
    return "unsupported";
  }
  return canHost && sizeBytes <= policy.hostedMaxBytes ? "hosted" : "unsupported";
}

export function resolveVideoReadMaxBytes(params: {
  policy: VideoDeliveryPolicy;
  canHost: boolean;
  requestedMaxBytes?: number;
}): number {
  const supportedMaxBytes =
    params.policy.mode === "inline"
      ? params.policy.inlineMaxBytes
      : params.policy.mode === "hosted"
        ? params.policy.hostedMaxBytes
        : params.canHost
          ? Math.max(params.policy.inlineMaxBytes, params.policy.hostedMaxBytes)
          : params.policy.inlineMaxBytes;
  return Math.min(
    asPositiveSafeInteger(params.requestedMaxBytes) ?? supportedMaxBytes,
    supportedMaxBytes,
    DEFAULT_VIDEO_HOSTED_MAX_BYTES,
  );
}
