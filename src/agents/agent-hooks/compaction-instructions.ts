/**
 * Compaction instruction utilities.
 *
 * Provides default language-preservation instructions and a precedence-based
 * resolver for customInstructions used during context compaction summaries.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/**
 * Default instructions injected into every safeguard-mode compaction summary.
 * Preserves conversation language and persona while keeping the SDK's required
 * summary structure intact.
 */
const DEFAULT_COMPACTION_INSTRUCTIONS =
  "摘要正文使用对话的主要语言；中文会话默认使用中文。\n" +
  "聚焦事实内容：讨论了什么、做了哪些决定、当前状态如何。\n" +
  "保持要求的摘要结构与 section header 原样不变。\n" +
  "不要翻译或改写代码、文件路径、标识符或错误消息。";

/**
 * Upper bound on custom instruction length to prevent prompt bloat.
 * ~800 chars ≈ ~200 tokens — keeps summarization quality stable.
 */
const MAX_INSTRUCTION_LENGTH = 800;

/**
 * Resolve compaction instructions with precedence:
 *   event (SDK) → runtime (config) → DEFAULT constant.
 *
 * Each input is normalized first (trim + empty→undefined) so that blank
 * strings don't short-circuit the fallback chain.
 */
export function resolveCompactionInstructions(
  eventInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string {
  const resolved =
    normalizeOptionalString(eventInstructions) ??
    normalizeOptionalString(runtimeInstructions) ??
    DEFAULT_COMPACTION_INSTRUCTIONS;
  return Array.from(resolved).slice(0, MAX_INSTRUCTION_LENGTH).join("");
}
