// Memory Core plugin module implements flush plan behavior.
import {
  DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  parseNonNegativeByteSize,
  resolveCronStyleNow,
  resolveEffectiveCompactionReserveTokens,
  SILENT_REPLY_TOKEN,
  type MemoryFlushPlan,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { buildCanonicalDailyMemoryRelativePath } from "./daily-memory-paths.js";
import { resolveMemoryCoreNowMs } from "./time.js";

const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MEMORY_FLUSH_DAILY_PATH_TEMPLATE = "memory/daily/YYYY-MM/YYYY-MM-DD.md";

const MEMORY_FLUSH_TARGET_HINT = `仅将值得长期保留的记忆写入 ${MEMORY_FLUSH_DAILY_PATH_TEMPLATE}（如目录不存在请创建）。`;
const MEMORY_FLUSH_APPEND_ONLY_HINT = `若 ${MEMORY_FLUSH_DAILY_PATH_TEMPLATE} 已存在，只能追加（APPEND）新内容，不得覆盖、重写或截断已有条目。`;
const MEMORY_FLUSH_READ_ONLY_HINT =
  "本次刷新期间，将工作区引导/参考文件（如 MEMORY.md、DREAMS.md、SOUL.md、AGENTS.md）视为只读；不得覆盖、替换或编辑它们。";
const MEMORY_FLUSH_REQUIRED_HINTS = [
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
];

const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "压缩前记忆刷新。",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  "不要创建带时间戳或其他后缀的日记变体（例如 YYYY-MM-DD-HHMM.md）；始终使用上述规范日记路径。",
  `如果没有值得持久化的内容，回复 ${SILENT_REPLY_TOKEN}。`,
].join(" ");

const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "这是压缩前的记忆刷新回合。",
  "当前会话即将进入自动压缩；请把值得长期保留的信息写入磁盘。",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  `可以回复用户，但通常 ${SILENT_REPLY_TOKEN} 才是正确选择。`,
].join(" ");

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(resolveMemoryCoreNowMs(nowMs)).toISOString().slice(0, 10);
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\n如果不需要向用户显示回复，请以 ${SILENT_REPLY_TOKEN} 开头。`;
}

function ensureMemoryFlushSafetyHints(text: string): string {
  let next = text.trim();
  for (const hint of MEMORY_FLUSH_REQUIRED_HINTS) {
    if (!next.includes(hint)) {
      next = next ? `${next}\n\n${hint}` : hint;
    }
  }
  return next;
}

function appendCurrentTimeLine(text: string, timeLine: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return timeLine;
  }
  if (trimmed.includes("Current time:")) {
    return trimmed;
  }
  return `${trimmed}\n${timeLine}`;
}

export function buildMemoryFlushPlan(
  params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
    contextWindowTokens?: number;
  } = {},
): MemoryFlushPlan | null {
  const resolved = params;
  const nowMs = resolveMemoryCoreNowMs(resolved.nowMs);
  const cfg = resolved.cfg;
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (defaults?.enabled === false) {
    return null;
  }

  let softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  let reserveTokensFloor = DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR;
  const contextWindowTokens = normalizeNonNegativeInt(params.contextWindowTokens);
  if (contextWindowTokens !== null && contextWindowTokens > 0) {
    reserveTokensFloor = resolveEffectiveCompactionReserveTokens({
      contextTokenBudget: contextWindowTokens,
      reserveTokens: reserveTokensFloor,
    });
    softThresholdTokens = Math.min(
      softThresholdTokens,
      Math.floor((contextWindowTokens - reserveTokensFloor) / 2),
    );
  }

  const { timeLine, userTimezone } = resolveCronStyleNow(cfg ?? {}, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);
  const relativePath = buildCanonicalDailyMemoryRelativePath(dateStamp);

  const promptBase = ensureNoReplyHint(ensureMemoryFlushSafetyHints(DEFAULT_MEMORY_FLUSH_PROMPT));
  const systemPrompt = ensureNoReplyHint(
    ensureMemoryFlushSafetyHints(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT),
  );

  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    model: defaults?.model?.trim() || undefined,
    prompt: appendCurrentTimeLine(
      promptBase.replaceAll("YYYY-MM-DD", dateStamp).replaceAll("YYYY-MM", dateStamp.slice(0, 7)),
      timeLine,
    ),
    systemPrompt: systemPrompt
      .replaceAll("YYYY-MM-DD", dateStamp)
      .replaceAll("YYYY-MM", dateStamp.slice(0, 7)),
    relativePath,
  };
}
