import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { prepareAgentRuntimeAuthWithRecovery } from "./prepare-auth-recovery.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

const recover = vi.hoisted(() => vi.fn());
vi.mock("../auth-profiles/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/usage.js")>()),
  maybeRecoverCodexRateLimitBlockedProfiles: recover,
}));
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

function fixture(blocked = true) {
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "openai:work": {
        type: "oauth",
        provider: "openai",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "test-account",
        email: "test@example.test",
      },
    },
    usageStats: blocked
      ? {
          "openai:work": {
            blockedUntil: Date.now() + 86_400_000,
            blockedReason: "subscription_limit",
            blockedSource: "codex_rate_limits",
            blockedModel: "model-a",
            blockedScope: "model",
          },
        }
      : {},
  };
  return {
    provider: "openai",
    modelId: "model-a",
    modelApi: "openai-chatgpt-responses",
    modelBaseUrl: "https://chatgpt.com/backend-api/codex",
    env: {},
    config: {},
    agentDir: "/tmp/test-auth-recovery-owner",
    authProfileStore: store,
    sessionAuthProfileId: "openai:work",
    sessionAuthProfileSource: "user" as const,
    harnessId: "codex",
    harnessRuntime: "codex",
  };
}

beforeEach(() => {
  recover.mockReset();
});

describe("runtime auth quota recovery", () => {
  it("waits for recovery before rejecting the selected profile on the same attempt", async () => {
    const params = fixture();
    expect(() => prepareAgentRuntimeAuth(params)).toThrow("temporarily unavailable");
    recover.mockImplementation(async ({ store }: { store: AuthProfileStore }) => {
      await Promise.resolve();
      store.usageStats = { "openai:work": {} };
    });
    const prepared = await prepareAgentRuntimeAuthWithRecovery(params);
    expect(prepared.attempts[0]).toMatchObject({ kind: "profile", profileId: "openai:work" });
    expect(prepared.transientCooldownProbeGranted).toBeUndefined();
    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({
        profileIds: ["openai:work"],
        forModel: "model-a",
        agentDir: params.agentDir,
      }),
    );
  });

  it("performs no recovery work for a healthy selected profile", async () => {
    await expect(prepareAgentRuntimeAuthWithRecovery(fixture(false))).resolves.toHaveProperty(
      "plan",
    );
    expect(recover).not.toHaveBeenCalled();
  });

  it("allows one real cooldown probe after this recovery just produced unknown Codex evidence", async () => {
    const params = fixture();
    const probeAt = Date.now() + 1;
    recover.mockImplementation(async ({ store }: { store: AuthProfileStore }) => {
      const stats = store.usageStats?.["openai:work"];
      if (stats) {
        stats.lastProbeAt = probeAt;
        stats.codexRateLimitProbeStatus = "unknown";
      }
    });

    const prepared = await prepareAgentRuntimeAuthWithRecovery(params);

    expect(prepared.attempts[0]).toMatchObject({ kind: "profile", profileId: "openai:work" });
    expect(prepared.transientCooldownProbeGranted).toBe(true);
    expect(params.authProfileStore.usageStats?.["openai:work"]).toMatchObject({
      lastProbeAt: probeAt,
      codexRateLimitProbeStatus: "unknown",
      blockedSource: "codex_rate_limits",
    });
  });

  it("does not reuse an older unknown Codex outcome as a real-probe grant", async () => {
    const params = fixture();
    const stats = params.authProfileStore.usageStats?.["openai:work"];
    if (!stats) {
      throw new Error("missing blocked usage fixture");
    }
    stats.lastProbeAt = Date.now() - 60_000;
    stats.codexRateLimitProbeStatus = "unknown";
    recover.mockResolvedValue(undefined);

    await expect(prepareAgentRuntimeAuthWithRecovery(params)).rejects.toThrow(
      "temporarily unavailable",
    );
  });

  it("does not real-probe when Codex recovery explicitly confirms the block", async () => {
    const params = fixture();
    recover.mockImplementation(async ({ store }: { store: AuthProfileStore }) => {
      const stats = store.usageStats?.["openai:work"];
      if (stats) {
        stats.lastProbeAt = Date.now() + 1;
        stats.codexRateLimitProbeStatus = "blocked";
      }
    });

    await expect(prepareAgentRuntimeAuthWithRecovery(params)).rejects.toThrow(
      "temporarily unavailable",
    );
  });

  it("preserves the block and never loops when recovery has no positive evidence", async () => {
    await expect(prepareAgentRuntimeAuthWithRecovery(fixture())).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not retry configuration or profile eligibility errors", async () => {
    const params = { ...fixture(), sessionAuthProfileId: "openai:missing" };
    await expect(prepareAgentRuntimeAuthWithRecovery(params)).rejects.toThrow("not configured");
    expect(recover).not.toHaveBeenCalled();
  });
});
