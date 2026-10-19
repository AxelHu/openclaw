// Provider-local M3.1 policy: native efforts, mandatory adaptive thinking.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  MINIMAX_M31_EFFORTS,
  MINIMAX_M31_FLASH_FORMAL_MODEL_ID,
  isMinimaxM31Flash,
} from "./provider-models.js";

const FAST_MODE = buildProviderStreamFamilyHooks("minimax-fast-mode");

export function wrapMinimaxStream(ctx: ProviderWrapStreamFnContext, simple = false) {
  const isFlash = isMinimaxM31Flash(ctx.modelId);
  if (simple && !isFlash) {
    return ctx.streamFn;
  }
  const base = FAST_MODE.wrapStreamFn?.(ctx) ?? ctx.streamFn;
  if (!isFlash) {
    return base;
  }
  return createPayloadPatchStreamWrapper(
    base,
    ({ payload, options }) => {
      // Direct completions supply reasoning at invocation time, not hook setup.
      const level = ctx.thinkingLevel ?? options?.reasoning;
      // Adaptive inherits the documented provider default. Off is never silently Low.
      const effort = !level || level === "adaptive" ? "max" : level;
      if (!MINIMAX_M31_EFFORTS.some((candidate) => candidate === effort)) {
        throw new Error(
          "MiniMax M3.1 Flash thinking cannot be disabled; use low, medium, high, xhigh, or max",
        );
      }
      if (
        ctx.modelId.trim().toLowerCase() === MINIMAX_M31_FLASH_FORMAL_MODEL_ID.toLowerCase() &&
        "service_tier" in payload
      ) {
        throw new Error("MiniMax M3.1 Flash formal release does not support service_tier");
      }
      payload.thinking = { type: "adaptive" };
      const output = payload.output_config;
      payload.output_config = {
        ...(output && typeof output === "object" && !Array.isArray(output) ? output : {}),
        effort,
      };
      // Generic Anthropic transports can inflate a budget-thinking cap before
      // this provider hook runs. M3.1 uses native effort, not budget_tokens.
      if (
        typeof options?.maxTokens === "number" &&
        Number.isFinite(options.maxTokens) &&
        options.maxTokens > 0
      ) {
        payload.max_tokens = options.maxTokens;
      }
    },
    { shouldPatch: ({ model }) => (ctx.sourceApi ?? model.api) === "anthropic-messages" },
  );
}
