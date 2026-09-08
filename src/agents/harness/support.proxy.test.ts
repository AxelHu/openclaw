import { describe, expect, it } from "vitest";
import { mergeModelProviderRouteOverridePresence } from "../../config/model-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderModelRoutes } from "../../plugins/provider-model-routes.js";
import { resolveOpenAIImplicitAgentRuntime } from "../openai-routing.js";
import { buildAgentHarnessSupportContext } from "./support.js";

const config = {
  agents: {
    entries: {
      canary: {
        models: {
          "openai/gpt-6-astra": { agentRuntime: { id: "codex" }, params: { thinking: "xhigh" } },
        },
      },
    },
  },
  models: {
    providers: {
      openai: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        models: [
          {
            id: "gpt-6-astra",
            compat: {
              supportsReasoningEffort: true,
              supportedReasoningEfforts: ["high", "xhigh", "max"],
            },
          },
        ],
        request: {
          allowPrivateNetwork: true,
          proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:1080" },
        },
      },
    },
  },
} as OpenClawConfig;

describe("proxy-only configuration through provider and harness boundaries", () => {
  it("carries the proxy requirement across real provider route resolution", () => {
    expect(
      resolveProviderModelRoutes({ config, provider: "openai", modelId: "gpt-6-astra", env: {} }),
    ).toMatchObject({
      kind: "routes",
      routes: [
        {
          requestTransportOverrides: "environment-proxy",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });
  it("selects Codex for the eligible implicit route", () => {
    expect(
      resolveOpenAIImplicitAgentRuntime({
        config,
        provider: "openai",
        modelId: "gpt-6-astra",
        agentId: "canary",
        env: {},
      }),
    ).toBe("codex");
  });
  it("keeps proxy presence, route compatibility and thinking metadata at harness admission", () => {
    expect(
      buildAgentHarnessSupportContext({
        config,
        provider: "openai",
        modelId: "gpt-6-astra",
        agentId: "canary",
        requestedRuntime: "codex",
      }).modelProvider,
    ).toMatchObject({
      requestTransportOverrides: "environment-proxy",
      request: config.models!.providers!.openai.request,
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    });
  });
  it("does not erase a prepared transport override behind the configured proxy", () => {
    expect(
      buildAgentHarnessSupportContext({
        config,
        provider: "openai",
        modelId: "gpt-6-astra",
        agentId: "canary",
        requestedRuntime: "codex",
        modelProvider: { requestTransportOverrides: "present" },
      }).modelProvider,
    ).toMatchObject({
      requestTransportOverrides: "present",
      runtimePolicy: { compatibleIds: ["openclaw"] },
    });
  });
  it("keeps a finalized provider rejection authoritative", () => {
    expect(
      buildAgentHarnessSupportContext({
        config,
        provider: "openai",
        modelId: "gpt-6-astra",
        agentId: "canary",
        requestedRuntime: "codex",
        preparedModelProvider: true,
        modelProvider: {
          requestTransportOverrides: "environment-proxy",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      }).modelProvider?.runtimePolicy,
    ).toEqual({ compatibleIds: ["openclaw"] });
  });
  it("does not discard agent-specific payload overrides", () => {
    const changed = structuredClone(config);
    changed.agents!.entries!.canary.params = { temperature: 0.2 };
    expect(
      buildAgentHarnessSupportContext({
        config: changed,
        provider: "openai",
        modelId: "gpt-6-astra",
        agentId: "canary",
        requestedRuntime: "codex",
      }).modelProvider?.requestTransportOverrides,
    ).toBe("present");
  });
  it("merges prepared/configured facts conservatively and independent of ordering", () => {
    expect(mergeModelProviderRouteOverridePresence("none", "environment-proxy")).toBe(
      "environment-proxy",
    );
    expect(mergeModelProviderRouteOverridePresence("environment-proxy", "none")).toBe(
      "environment-proxy",
    );
    expect(mergeModelProviderRouteOverridePresence("environment-proxy", "present")).toBe("present");
    expect(mergeModelProviderRouteOverridePresence("present", "environment-proxy")).toBe("present");
    expect(mergeModelProviderRouteOverridePresence(undefined)).toBe("none");
  });
});
