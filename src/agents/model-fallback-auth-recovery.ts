import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";

export type CandidateAuthRecoveryResult = {
  profileIds: string[];
  userLockedProfileEligible: boolean;
  suggestRealProbe: boolean;
};

/**
 * Revalidates candidate auth blocks and reports whether this invocation ended
 * with fresh inconclusive Codex evidence that may spend one real probe slot.
 */
export async function recoverCandidateAuthProfiles(params: {
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  userLockedProfileId?: string;
}): Promise<CandidateAuthRecoveryResult> {
  const userLockedProfileEligible =
    params.userLockedProfileId !== undefined &&
    params.authRuntime.resolveAuthProfileEligibility({
      cfg: params.cfg,
      store: params.authStore,
      provider: params.provider,
      profileId: params.userLockedProfileId,
    }).eligible;
  const orderedProfileIds = params.authRuntime.resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.authStore,
    provider: params.provider,
    forModel: params.model,
  });
  const profileIds =
    userLockedProfileEligible && params.userLockedProfileId
      ? [
          params.userLockedProfileId,
          ...orderedProfileIds.filter((profileId) => profileId !== params.userLockedProfileId),
        ]
      : orderedProfileIds;
  const lastProbeBefore = new Map(
    profileIds.map((profileId) => [
      profileId,
      params.authStore.usageStats?.[profileId]?.lastProbeAt,
    ]),
  );

  await params.authRuntime.maybeRecoverProviderBlockedProfiles({
    store: params.authStore,
    profileIds,
    agentDir: params.agentDir,
    forModel: params.model,
    config: params.cfg,
  });

  const suggestRealProbe = profileIds.some((profileId) => {
    const after = params.authStore.usageStats?.[profileId];
    return (
      after?.blockedSource === "codex_rate_limits" &&
      after.blockedReason === "subscription_limit" &&
      after.codexRateLimitProbeStatus === "unknown" &&
      typeof after.lastProbeAt === "number" &&
      after.lastProbeAt !== lastProbeBefore.get(profileId)
    );
  });

  return { profileIds, userLockedProfileEligible, suggestRealProbe };
}
