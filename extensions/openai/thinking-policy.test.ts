import { describe, expect, it } from "vitest";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

function levelIds(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  efforts: string[];
}) {
  return resolveUnifiedOpenAIThinkingProfile(
    "gpt-5.6-sol",
    "codex",
    { supportedReasoningEfforts: params.efforts },
    params.api,
  ).levels.map((level) => level.id);
}

describe("OpenAI thinking route provenance", () => {
  it("keeps native fallback capabilities for a direct OpenAI route", () => {
    expect(
      levelIds({
        api: "openai-responses",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toContain("ultra");
  });

  it("retains known native capabilities when ChatGPT metadata is incomplete", () => {
    expect(
      levelIds({
        api: "openai-chatgpt-responses",
        efforts: ["low", "high"],
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });
});

describe("GPT-6 subscription effort contract", () => {
  it.each([
    ["gpt-6-sol", ["off", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-6-luna", ["off", "low", "medium", "high", "xhigh", "max"]],
  ])(
    "retains account-supported tiers for %s without inheriting the other variant",
    (modelId, expected) => {
      const profile = resolveUnifiedOpenAIThinkingProfile(
        modelId as string,
        "codex",
        undefined,
        "openai-chatgpt-responses",
      );
      expect(profile.levels.map((level) => level.id)).toEqual(expected);
      expect(profile.defaultLevel).toBe("medium");
    },
  );
  it("keeps an explicitly empty GPT-6 account capability list authoritative", () => {
    const profile = resolveUnifiedOpenAIThinkingProfile(
      "gpt-6-sol",
      "codex",
      { supportedReasoningEfforts: [] },
      "openai-chatgpt-responses",
    );
    expect(profile.levels.map((level) => level.id)).toEqual(["off"]);
  });
});
