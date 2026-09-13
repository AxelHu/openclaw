import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import { recoverCandidateAuthProfiles } from "./model-fallback-auth-recovery.js";
import { probeThrottleInternals, resolveCooldownDecision } from "./model-fallback-cooldown.js";

const NOW = 1_800_000_000_000;
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const PROFILE_ID = "openai:default";

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
    usageStats: {
      [PROFILE_ID]: {
        blockedUntil: NOW + SIX_DAYS_MS,
        blockedReason: "subscription_limit",
        blockedSource: "codex_rate_limits",
        blockedModel: "gpt-6-astra",
        blockedScope: "model",
        lastProbeAt: NOW - 5 * 60 * 1000,
        codexRateLimitProbeStatus: "unknown",
      },
    },
  };
}

function makeRuntime(overrides: Partial<ModelFallbackAuthRuntime> = {}): ModelFallbackAuthRuntime {
  return {
    resolveAuthProfileEligibility: vi.fn(() => ({ eligible: true })),
    resolveAuthProfileOrder: vi.fn(() => [PROFILE_ID]),
    maybeRecoverProviderBlockedProfiles: vi.fn(async () => undefined),
    resolveProfilesUnavailableReason: vi.fn(() => "rate_limit"),
    getSoonestCooldownExpiry: vi.fn(() => NOW + SIX_DAYS_MS),
    ...overrides,
  } as unknown as ModelFallbackAuthRuntime;
}

describe("Codex fallback auth recovery", () => {
  beforeEach(() => {
    probeThrottleInternals.lastProbeAttempt.clear();
  });

  it("suggests one real probe only when this revalidation produced fresh unknown evidence", async () => {
    const store = makeStore();
    const runtime = makeRuntime({
      maybeRecoverProviderBlockedProfiles: vi.fn(async () => {
        const stats = store.usageStats?.[PROFILE_ID];
        if (stats) {
          stats.lastProbeAt = NOW;
          stats.codexRateLimitProbeStatus = "unknown";
        }
      }),
    });

    const result = await recoverCandidateAuthProfiles({
      authRuntime: runtime,
      authStore: store,
      cfg: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-6-astra",
      userLockedProfileId: PROFILE_ID,
    });

    expect(result).toEqual({
      profileIds: [PROFILE_ID],
      userLockedProfileEligible: true,
      suggestRealProbe: true,
    });
  });

  it("does not reuse an older persisted unknown outcome as a real-probe grant", async () => {
    const store = makeStore();
    const result = await recoverCandidateAuthProfiles({
      authRuntime: makeRuntime(),
      authStore: store,
      cfg: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-6-astra",
    });

    expect(result.suggestRealProbe).toBe(false);
  });

  it("lets fresh inconclusive evidence spend one normal primary cooldown-probe slot", () => {
    const store = makeStore();
    const runtime = makeRuntime();
    const decide = () =>
      resolveCooldownDecision({
        candidate: { provider: "openai", model: "gpt-6-astra" },
        isPrimary: true,
        requestedModel: true,
        hasFallbackCandidates: true,
        now: NOW,
        probeThrottleKey: "openai-test",
        authRuntime: runtime,
        authStore: store,
        profileIds: [PROFILE_ID],
        forcePrimaryProbe: true,
      });

    expect(decide()).toEqual({ type: "attempt", reason: "rate_limit", markProbe: true });

    probeThrottleInternals.lastProbeAttempt.set("openai-test", NOW - 10_000);
    expect(decide()).toMatchObject({ type: "suspend_session", reason: "rate_limit" });
  });
});
