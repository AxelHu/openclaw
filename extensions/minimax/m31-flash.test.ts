import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";
import { buildMinimaxProvider, buildMinimaxPortalProvider } from "./provider-catalog.js";
import {
  MINIMAX_M31_FLASH_MODEL_ID,
  MINIMAX_M31_FLASH_PREVIEW_MODEL_ID,
  MINIMAX_TEXT_MODEL_ORDER,
} from "./provider-models.js";
import { registerMinimaxProviders } from "./provider-registration.js";

const MODEL = "MiniMax-M3.1-Flash-Preview";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const plugin = { register: registerMinimaxProviders };

it("prefers the formal Flash ID while preserving the Preview compatibility entry", () => {
  expect(MINIMAX_M31_FLASH_MODEL_ID).toBe("MiniMax-M3.1-Flash");
  expect(MINIMAX_M31_FLASH_PREVIEW_MODEL_ID).toBe("MiniMax-M3.1-Flash-Preview");
  expect(MINIMAX_TEXT_MODEL_ORDER.indexOf(MINIMAX_M31_FLASH_MODEL_ID)).toBeLessThan(
    MINIMAX_TEXT_MODEL_ORDER.indexOf(MINIMAX_M31_FLASH_PREVIEW_MODEL_ID),
  );
});

async function provider(id = "minimax") {
  const { providers } = await registerProviderPlugin({ plugin, id: "minimax", name: "MiniMax" });
  return requireRegisteredProvider(providers, id);
}

async function payloadFor(effort?: string, id = "minimax", modelId = MODEL, simple = false) {
  const hooks = await provider(id);
  let payload: Record<string, unknown> = {};
  const capture: StreamFn = (model, _context, options) => {
    payload = { thinking: { type: "enabled", budget_tokens: 8192 }, max_tokens: 8692 };
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const hook = simple ? hooks.wrapSimpleCompletionStreamFn : hooks.wrapStreamFn;
  const wrapped = hook?.({
    streamFn: capture,
    modelId,
    provider: id,
    sourceApi: simple ? "anthropic-messages" : undefined,
    thinkingLevel: simple ? undefined : effort,
  } as never);
  expect(wrapped).toBeTypeOf("function");
  await wrapped?.(
    {
      id: modelId,
      provider: id,
      api: simple ? "openclaw-provider-simple:test" : "anthropic-messages",
    } as Model,
    { messages: [] } as Context,
    { maxTokens: 500, ...(simple ? { reasoning: effort } : {}) } as never,
  );
  return payload;
}

describe.each([MODEL, "MiniMax-M3.1-Flash"])(
  "MiniMax M3.1 Flash public provider contract: %s",
  (modelId) => {
    it.each(["minimax", "minimax-portal"])(
      "offers all five native efforts, no off, for %s",
      async (id) => {
        const hooks = await provider(id);
        const profile = hooks.resolveThinkingProfile?.({ modelId } as never);
        expect(profile?.levels.map((level) => level.id)).toEqual(EFFORTS);
        expect(profile?.defaultLevel).toBe("max");
      },
    );
    it.each(EFFORTS)(
      "sends native %s effort, adaptive thinking, and the caller's token cap",
      async (effort) => {
        expect(await payloadFor(effort, "minimax", modelId)).toEqual({
          thinking: { type: "adaptive" },
          output_config: { effort },
          max_tokens: 500,
        });
      },
    );
    it.each(EFFORTS)(
      "preserves native %s effort and token cap through direct completion aliases",
      async (effort) => {
        expect(await payloadFor(effort, "minimax", modelId, true)).toEqual({
          thinking: { type: "adaptive" },
          output_config: { effort },
          max_tokens: 500,
        });
      },
    );
    it("uses the direct-completion hook for portal OAuth", async () => {
      expect(await payloadFor("xhigh", "minimax-portal", modelId, true)).toMatchObject({
        output_config: { effort: "xhigh" },
      });
    });
    it("keeps legacy direct completions on their existing wire contract", async () => {
      expect(await payloadFor("high", "minimax", "MiniMax-M3", true)).toEqual({
        thinking: { type: "enabled", budget_tokens: 8192 },
        max_tokens: 8692,
      });
    });
    it("rejects disabled reasoning on direct completions before dispatch", async () => {
      await expect(payloadFor("off", "minimax", modelId, true)).rejects.toThrow(
        /cannot be disabled/i,
      );
    });
    it("uses the same effort contract for portal OAuth", async () => {
      expect(await payloadFor("xhigh", "minimax-portal", modelId)).toMatchObject({
        output_config: { effort: "xhigh" },
      });
    });
    it("uses documented max when the caller leaves effort unspecified", async () => {
      expect(await payloadFor(undefined, "minimax", modelId)).toMatchObject({
        output_config: { effort: "max" },
      });
    });
    it("rejects off before dispatch rather than claiming thinking can be disabled", async () => {
      await expect(payloadFor("off", "minimax", modelId)).rejects.toThrow(/cannot be disabled/i);
    });
    it("does not send M3.1 effort controls to the existing M3 model", async () => {
      expect(await payloadFor("adaptive", "minimax", "MiniMax-M3")).not.toHaveProperty(
        "output_config",
      );
    });
    it("adds an explicitly selectable multimodal model to both static catalogs", () => {
      for (const catalog of [buildMinimaxProvider(), buildMinimaxPortalProvider()]) {
        const model = catalog.models.find((m) => m.id === modelId);
        expect(model).toMatchObject({
          id: modelId,
          input: ["text", "image", "video"],
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: modelId === MODEL ? 32768 : 131072,
        });
        expect(catalog.models.some((m) => m.id === "MiniMax-M3")).toBe(true);
      }
      expect(buildMinimaxApiModelDefinition(modelId).compat?.supportedReasoningEfforts).toEqual(
        EFFORTS,
      );
    });
    it("preserves the same identity and limits through dynamic discovery", async () => {
      const hooks = await provider();
      const model = hooks.resolveDynamicModel?.({ modelId, providerConfig: {} } as never);
      expect(model).toMatchObject({
        id: modelId,
        contextWindow: 1_000_000,
        maxTokens: modelId === MODEL ? 32768 : 131072,
      });
    });
  },
);

it.each(["minimax", "minimax-portal"])(
  "preserves M3.1 and M3 native thinking/tool history for %s",
  async (id) => {
    const hooks = await provider(id);
    for (const modelId of [MODEL, "MiniMax-M3.1-Flash", "MiniMax-M3"]) {
      const policy = hooks.buildReplayPolicy?.({
        provider: id,
        modelId,
        modelApi: "anthropic-messages",
      });
      expect(policy).toMatchObject({
        preserveSignatures: true,
        repairToolUseResultPairing: true,
        validateAnthropicTurns: true,
      });
      // The shared transcript default is false; only older Claude IDs opt in.
      expect(policy).not.toHaveProperty("dropThinkingBlocks");
    }
  },
);
