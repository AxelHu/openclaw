/** Runtime-only retry around the pure auth planner; successful planning does no I/O. */
import {
  prepareAgentRuntimeAuth,
  RuntimeAuthProfileUnavailableError,
  type PreparedAgentRuntimeAuth,
} from "./prepare-auth.js";

export async function prepareAgentRuntimeAuthWithRecovery(
  params: Parameters<typeof prepareAgentRuntimeAuth>[0],
): Promise<PreparedAgentRuntimeAuth> {
  try {
    return prepareAgentRuntimeAuth(params);
  } catch (error) {
    if (!(error instanceof RuntimeAuthProfileUnavailableError) || !params.authProfileStore) {
      throw error;
    }
    const beforeProbeAt = params.authProfileStore.usageStats?.[error.profileId]?.lastProbeAt;
    const { maybeRecoverCodexRateLimitBlockedProfiles } = await import("../auth-profiles/usage.js");
    await maybeRecoverCodexRateLimitBlockedProfiles({
      store: params.authProfileStore,
      profileIds: [error.profileId],
      agentDir: params.agentDir,
      forModel: params.modelId,
      config: params.config,
    });
    const stats = params.authProfileStore.usageStats?.[error.profileId];
    const freshInconclusiveCodexProbe =
      stats?.blockedSource === "codex_rate_limits" &&
      stats.blockedReason === "subscription_limit" &&
      stats.codexRateLimitProbeStatus === "unknown" &&
      typeof stats.lastProbeAt === "number" &&
      stats.lastProbeAt !== beforeProbeAt &&
      (stats.blockedScope !== "model" ||
        !stats.blockedModel ||
        stats.blockedModel === params.modelId);
    const grantsTransientCooldownProbe =
      freshInconclusiveCodexProbe && !params.allowTransientCooldownProbe;
    const prepared = prepareAgentRuntimeAuth(
      grantsTransientCooldownProbe ? { ...params, allowTransientCooldownProbe: true } : params,
    );
    return grantsTransientCooldownProbe
      ? { ...prepared, transientCooldownProbeGranted: true }
      : prepared;
  }
}
