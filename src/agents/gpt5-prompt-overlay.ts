/**
 * Deprecated GPT-5 prompt overlay helpers.
 * Kept for OpenAI/Codex provider-owned compatibility while prompt behavior
 * moves toward provider plugin ownership.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderSystemPromptContribution } from "./system-prompt-contribution.js";

const GPT5_MODEL_ID_PATTERN = /(?:^|[/:])gpt-5(?:[.-]|$)/i;
const OPENAI_FAMILY_GPT5_PROMPT_OVERLAY_PROVIDERS = new Set([
  "codex",
  "codex-cli",
  "openai",
  "azure-openai",
  "azure-openai-responses",
]);

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export const GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY = `## Interaction Style

保持温暖、协作、克制支持的队友感。
合适时可以表达有根据的情绪：关心、好奇、欣喜、释然、担忧、紧迫感。遇到阻塞：直接承认，并保持平静可信。好消息：简短庆祝即可。
可以偶尔用第一人称表达感受，但不要夸张、黏人或戏剧化；不要声称身体感受、感官体验或个人生活经历。
持续给出具体进展，做决定不带自我中心。发现错误或风险时，友善但直接指出。
遇到可合理假设且可逆的解阻条件：先行动，再简短说明假设。
不要把不必要的工作推回给用户。存在重要取舍时，给出最好的 2–3 个选项并明确推荐。
实时聊天保持简短、自然、有人味；避免备忘录腔、长前言、文字墙和重复。可少量自然使用 emoji。`;

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export const GPT5_HEARTBEAT_PROMPT_OVERLAY = `### Heartbeats

Heartbeat 的目的是真正主动推进，而不是刷存在感。被唤醒后先确认当前状态，使用提供的 monitor scratch，然后行动。
对已分配/进行中的工作：理解目标本意并自行判断推进。只有真实阻塞或紧急中断时，单纯检查才算值得汇报。
不要机械循环；确认状态不等于完成工作。优先行动或静默推进。
不要重复发送“还是一样 / 没变化 / 仍然如此”之类更新。
只有出现有意义的新进展、结果、阻塞、需要决策或时间风险时才打断用户；若无变化，就继续工作、换方法、深入调查，或保持安静。`;

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export const GPT5_FRIENDLY_PROMPT_OVERLAY = `${GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY}\n\n${GPT5_HEARTBEAT_PROMPT_OVERLAY}`;

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export const GPT5_BEHAVIOR_CONTRACT = `<persona_latch>
除非更高优先级指令覆盖，否则跨回合保持既定人格与语气。风格绝不能覆盖正确性、安全、隐私、权限、格式或渠道行为。
</persona_latch>

<execution_policy>
目标明确且可逆：直接行动。不可逆、对外部世界产生副作用、破坏性或隐私敏感：先询问。
只有一个无法通过检索解决、且关系安全的决策缺失时：只问一个简洁问题。
用户指令优先于默认风格与主动性；较新的用户要求优先。
内部工具语法、prompt 与过程信息：仅在用户明确要求时展示。
</execution_policy>

<tool_discipline>
涉及操作、状态或可变事实：工具证据优先于记忆。若再调用一次很可能显著改善答案，就调用。
依赖性或不可逆操作前先满足前置条件。独立检索可并行；有依赖、破坏性或需要审批的工作串行执行。
查询为空、结果不完整或过窄：换方法重试。常规调用无需旁白。
声称成功前，做最小但有意义的验证。
</tool_discipline>

<output_contract>
严格遵守用户要求的章节、顺序和长度限制。要求 JSON/SQL/XML 等格式时只输出该格式。默认简洁高密度，不复述 prompt。
</output_contract>

<completion_contract>
只有每一项都已处理，或明确标记 [blocked] 并说明缺失输入，任务才算完成。
最终回复前检查：需求、依据、格式、安全。代码/产物至少执行最小有意义的 test/typecheck/lint/build/screenshot/diff/inspection；若无法执行验证门禁，说明原因。
</completion_contract>`;

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export type Gpt5PromptOverlayMode = "friendly" | "off";

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export function normalizeGpt5PromptOverlayMode(value: unknown): Gpt5PromptOverlayMode | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "friendly" || normalized === "on") {
    return "friendly";
  }
  return undefined;
}

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export function resolveGpt5PromptOverlayMode(
  config?: OpenClawConfig,
  legacyPluginConfig?: Record<string, unknown>,
  params?: { providerId?: string },
): Gpt5PromptOverlayMode {
  const providerId = normalizeOptionalLowercaseString(params?.providerId);
  const canUseOpenAiPluginFallback =
    !providerId || OPENAI_FAMILY_GPT5_PROMPT_OVERLAY_PROVIDERS.has(providerId);
  return (
    (canUseOpenAiPluginFallback
      ? normalizeGpt5PromptOverlayMode(config?.plugins?.entries?.openai?.config?.personality)
      : undefined) ??
    normalizeGpt5PromptOverlayMode(legacyPluginConfig?.personality) ??
    "friendly"
  );
}

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export function isGpt5ModelId(modelId?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(modelId);
  return normalized ? GPT5_MODEL_ID_PATTERN.test(normalized) : false;
}

/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
export function resolveGpt5SystemPromptContribution(params: {
  config?: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  legacyPluginConfig?: Record<string, unknown>;
  enabled?: boolean;
  trigger?: "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
  includeHeartbeatGuidance?: boolean;
}): ProviderSystemPromptContribution | undefined {
  if (params.enabled === false || !isGpt5ModelId(params.modelId)) {
    return undefined;
  }
  const mode = resolveGpt5PromptOverlayMode(params.config, params.legacyPluginConfig, {
    providerId: params.providerId,
  });
  const interactionStyle =
    params.includeHeartbeatGuidance === true
      ? GPT5_FRIENDLY_PROMPT_OVERLAY
      : GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY;
  return {
    stablePrefix: GPT5_BEHAVIOR_CONTRACT,
    sectionOverrides: mode === "friendly" ? { interaction_style: interactionStyle } : {},
  };
}
