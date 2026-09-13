import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
// Codex usage tests cover the harness-owned provider-usage contribution.
import type { ProviderFetchUsageSnapshotContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { fetchCodexAppServerUsageSnapshot } from "./usage.js";

function usageContext(
  overrides: Partial<ProviderFetchUsageSnapshotContext> = {},
): ProviderFetchUsageSnapshotContext {
  return {
    config: {},
    env: {},
    provider: "openai",
    token: CODEX_APP_SERVER_AUTH_MARKER,
    timeoutMs: 3_500,
    fetchFn: fetch,
    ...overrides,
  };
}

describe("Codex app-server provider usage", () => {
  it("contributes OpenAI usage windows for the synthetic app-server credential", async () => {
    const readUsage = vi.fn(async () => ({
      rateLimits: {
        accountId: "observed-workspace",
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 9,
              windowDurationMins: 300,
              resetsAt: 1_700_003_600,
            },
          },
        },
      },
      accountEmail: "codex-account@example.com",
    }));

    await expect(fetchCodexAppServerUsageSnapshot(usageContext(), { readUsage })).resolves.toEqual({
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 9, resetAt: 1_700_003_600_000 }],
      plan: undefined,
      quotaAvailable: true,
      accountId: "observed-workspace",
      accountEmail: "codex-account@example.com",
    });
    expect(readUsage).toHaveBeenCalledWith({
      timeoutMs: 3_500,
      agentDir: undefined,
      config: {},
      startOptions: expect.objectContaining({
        command: "codex",
        commandSource: "managed",
      }),
    });
  });

  it("uses observed account identity instead of the requested profile label", async () => {
    const readUsage = vi.fn(async () => ({
      rateLimits: {},
      accountEmail: "observed@example.test",
    }));
    const result = await fetchCodexAppServerUsageSnapshot(
      usageContext({
        authProfileId: "openai:work",
        email: "requested@example.test",
      }),
      { readUsage },
    );
    expect(result?.accountEmail).toBe("observed@example.test");
    expect(readUsage).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:work" }),
    );
  });

  it("does not invent observed identity when account/read failed", async () => {
    const result = await fetchCodexAppServerUsageSnapshot(
      usageContext({ email: "requested@example.test" }),
      {
        readUsage: async () => ({ rateLimits: {} }),
      },
    );
    expect(result?.accountEmail).toBeUndefined();
  });

  it("ignores ordinary OpenAI credentials", async () => {
    const readUsage = vi.fn();

    await expect(
      fetchCodexAppServerUsageSnapshot(usageContext({ token: "test-token-placeholder" }), {
        readUsage,
      }),
    ).resolves.toBeNull();
    expect(readUsage).not.toHaveBeenCalled();
  });
});
