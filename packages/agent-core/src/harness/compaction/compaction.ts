import {
  resolveClaudeFable5ModelIdentity,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
  type Usage,
} from "@openclaw/llm-core";
// Agent Core module implements compaction behavior.
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentReasoningOption } from "../../reasoning.js";
import {
  type AgentCoreCompletionRuntimeDeps,
  consumeAgentCoreStream,
  resolveAgentCoreCompleteFn,
} from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { convertToLlm, type HarnessMessage } from "../messages.js";
import { buildSessionContext, projectSessionEntryMessage } from "../session/session.js";
import { selectResetKeptEntries } from "../session/tool-result-pairing.js";
import {
  CompactionError,
  err,
  InvalidSummaryOutputError,
  ok,
  type Result,
  type SessionTreeEntry,
} from "../types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  extractSummaryText,
  type FileOperations,
  formatFileOperations,
  getCompactionContent,
  mergeSummaryFileOperations,
  serializeConversation,
  stringifyCompactionValue,
} from "./utils.js";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
  /** Files read in the compacted history. */
  readFiles: string[];
  /** Files modified in the compacted history. */
  modifiedFiles: string[];
  /** Run-owned request that remains active across another compaction generation. */
  latestUnresolvedUserRequest?: string;
}

function parseCompactionDetails(value: unknown): CompactionDetails | undefined {
  const details = asOptionalRecord(value);
  if (
    !details ||
    !Array.isArray(details.readFiles) ||
    !details.readFiles.every((file): file is string => typeof file === "string") ||
    !Array.isArray(details.modifiedFiles) ||
    !details.modifiedFiles.every((file): file is string => typeof file === "string")
  ) {
    return undefined;
  }
  const request = details.latestUnresolvedUserRequest;
  const latestUnresolvedUserRequest =
    typeof request === "string" && request.length <= MAX_LATEST_USER_REQUEST_CHARS
      ? request
      : undefined;
  return {
    readFiles: details.readFiles,
    modifiedFiles: details.modifiedFiles,
    ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
  };
}

function extractFileOperations(
  messages: AgentMessage[],
  entries: SessionTreeEntry[],
  prevBoundaryIndex: number,
): FileOperations {
  const fileOps = createFileOps();
  if (prevBoundaryIndex >= 0) {
    const prevCompaction = entries[prevBoundaryIndex];
    if (prevCompaction?.type === "compaction" && !prevCompaction.fromHook) {
      const details = parseCompactionDetails(prevCompaction.details);
      if (details) {
        mergeSummaryFileOperations(fileOps, details);
      }
    }
  }
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return fileOps;
}
function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return projectSessionEntryMessage(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Optional implementation-specific details stored with the compaction entry. */
  details?: T;
}

// Persisted summaries replay on every later request, so their owner enforces
// this provider-independent 16K hard bound.
export const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
export const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const MAX_LATEST_USER_REQUEST_CHARS = 800;
const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... latest user request truncated ...]\n";

function extractLatestUserRequest(messages: AgentMessage[]): string | undefined {
  let source = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      source = getCompactionContent(message.content).text.trim();
      if (source) {
        break;
      }
    }
  }
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

export function capCompactionSummary(
  summary: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
  preservedSuffix = "",
) {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const suffix = preservedSuffix && summary.endsWith(preservedSuffix) ? preservedSuffix : "";
  if (maxChars < SUMMARY_TRUNCATED_MARKER.length + suffix.length) {
    return truncateUtf16Safe(summary, maxChars);
  }
  const budget = maxChars - SUMMARY_TRUNCATED_MARKER.length - suffix.length;
  const prefix = suffix ? summary.slice(0, -suffix.length) : summary;
  return `${truncateUtf16Safe(prefix, budget)}${SUMMARY_TRUNCATED_MARKER}${suffix}`;
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  if (usage.contextUsage?.state === "available") {
    return usage.contextUsage.totalTokens;
  }
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg;
    if (
      assistantMsg.stopReason !== "aborted" &&
      assistantMsg.stopReason !== "error" &&
      assistantMsg.usage &&
      calculateContextTokens(assistantMsg.usage) > 0
    ) {
      return assistantMsg.usage;
    }
  }
  return undefined;
}

function isUnavailableContextBarrier(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const usage = "usage" in message ? message.usage : undefined;
  if (!usage) {
    return false;
  }
  if (message.api === "cli" && usage.contextUsage === undefined) {
    return true;
  }
  if (usage.contextUsage?.state !== "unavailable") {
    return false;
  }
  return calculateContextTokens(usage) === 0;
}

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type === "message") {
      if (isUnavailableContextBarrier(entry.message)) {
        return undefined;
      }
      const usage = getAssistantUsage(entry.message);
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens not covered by usable provider usage. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages.at(i);
    if (!message) {
      continue;
    }
    if (isUnavailableContextBarrier(message)) {
      // Synthetic CLI markers invalidate older usage without contributing a
      // replacement. Estimate the whole transcript instead of scanning past it.
      return undefined;
    }
    const usage = getAssistantUsage(message);
    if (usage && usage.contextUsage?.state !== "unavailable") {
      return { usage, index: i };
    }
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (const message of messages.slice(usageInfo.index + 1)) {
    trailingTokens += estimateTokens(message);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}

export const IMAGE_BLOCK_TOKENS = 2_000;
const IMAGE_BLOCK_CHARS = IMAGE_BLOCK_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

function countContentChars(
  content: string | Array<{ type: string; content?: unknown; text?: string }>,
): number {
  const { text, omissionText } = getCompactionContent(content);
  const images =
    typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
  // Charge the largest role/separator even for mixed text. Any suppressed message's
  // minimum 56-character charge also covers the serializer's single 55-character overflow.
  const omissionChars = omissionText ? omissionText.length + "\n\n[Tool result]: ".length : 0;
  return estimateStringChars(text) + images * IMAGE_BLOCK_CHARS + omissionChars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  if ("excludeFromContext" in message && message.excludeFromContext === true) {
    return 0;
  }
  let chars = 0;
  const harnessMessage = message as HarnessMessage;

  switch (harnessMessage.role) {
    case "assistant": {
      const assistant = harnessMessage;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += estimateStringChars(block.text);
        } else if (block.type === "thinking") {
          chars += estimateStringChars(block.thinking);
        } else if (block.type === "toolCall") {
          chars +=
            estimateStringChars(block.name) +
            estimateStringChars(stringifyCompactionValue(block.arguments));
        }
      }
      return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
    }
    case "user":
    case "custom":
    case "toolResult": {
      chars = countContentChars(harnessMessage.content);
      return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
    }
    case "bashExecution": {
      chars =
        estimateStringChars(harnessMessage.command) + estimateStringChars(harnessMessage.output);
      return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = estimateStringChars(harnessMessage.summary);
      return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
    }
  }

  return 0;
}
function isCutPointMessage(message: AgentMessage): boolean {
  switch (message.role) {
    case "user":
    case "assistant":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    case "toolResult":
      return false;
  }

  return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
  switch (message.role) {
    case "user":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    case "assistant":
    case "toolResult":
      return false;
  }

  return false;
}

function isTurnStartEntry(entry: SessionTreeEntry): boolean {
  const message = getMessageFromEntryForCompaction(entry);
  return message ? isTurnStartMessage(message) : false;
}

function findValidCutPoints(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const message = getMessageFromEntryForCompaction(entry);
    if (message && isCutPointMessage(message)) {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(
  entries: SessionTreeEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (isTurnStartEntry(entry)) {
      return i;
    }
  }
  return -1;
}

/** Cut point selected for compaction. */
interface CutPointResult {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  const firstCutIndex = cutPoints.at(0);
  if (firstCutIndex === undefined) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let cutIndex = firstCutIndex;

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const message = getMessageFromEntryForCompaction(entry);
    if (!message) {
      continue;
    }
    const messageTokens = estimateTokens(message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      const lastCutIndex = cutPoints.at(-1);
      if (lastCutIndex === undefined) {
        throw new Error("compaction cut-point list became empty during selection");
      }
      cutIndex = lastCutIndex;
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (!prevEntry) {
      break;
    }
    if (prevEntry.type === "compaction" || prevEntry.type === "reset") {
      break;
    }
    // Metadata can follow the cut, but private persisted messages cannot become its boundary.
    if (prevEntry.type === "message" || getMessageFromEntryForCompaction(prevEntry)) {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  if (!cutEntry) {
    throw new Error("compaction cut point does not reference a session entry");
  }
  const startsTurn = isTurnStartEntry(cutEntry);
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}

export const SUMMARIZATION_SYSTEM_PROMPT = `你是上下文摘要助手。你的任务是阅读用户与 AI 助手之间的对话，并严格按照指定格式生成结构化摘要。

不要继续对话。不要回答对话中的任何问题。只输出结构化摘要。`;

const SUMMARIZATION_PROMPT = `上面的消息是一段需要摘要的对话。请生成结构化的上下文检查点摘要，供另一个 LLM 继续后续工作。

严格使用以下格式；section header 保持原样：

## Goal
[用户希望完成什么？如果会话包含多个不同任务，可以列多项。]

## Constraints & Preferences
- [用户提到的约束、偏好或要求]
- [若没有则写 "(none)"]

## Progress
### Done
- [x] [已完成的任务/改动]

### In Progress
- [ ] [当前正在进行的工作]

### Blocked
- [阻止继续推进的问题；没有则写明]

## Key Decisions
- **[Decision]**: [简要理由]

## Next Steps
1. [接下来应该发生什么，按顺序列出]

## Critical Context
- [继续工作所需的数据、示例或引用]
- [不适用则写 "(none)"]

每个 section 保持简洁。文件路径、函数名和错误消息必须逐字保留。`;

const UPDATE_SUMMARIZATION_PROMPT = `上面的消息是新的对话内容，需要合并进 <previous-summary> 标签中的既有摘要。

用新信息更新既有结构化摘要。规则：
- 保留上一份摘要中的全部仍然有效的信息
- 加入新消息中的进展、决定与上下文
- 更新 Progress section：完成的事项从 "In Progress" 移到 "Done"
- 根据实际完成情况更新 "Next Steps"
- 文件路径、函数名和错误消息必须逐字保留
- 已经不再相关的内容可以删除

严格使用以下格式；section header 保持原样：

## Goal
[保留既有目标；任务范围扩展时加入新目标]

## Constraints & Preferences
- [保留既有约束与偏好，并加入新发现的内容]

## Progress
### Done
- [x] [既包括此前已完成事项，也包括本轮新完成事项]

### In Progress
- [ ] [当前工作；根据最新进展更新]

### Blocked
- [当前阻塞；已解决的阻塞应移除]

## Key Decisions
- **[Decision]**: [简要理由]（保留之前的决定并加入新决定）

## Next Steps
1. [根据当前状态更新]

## Critical Context
- [保留重要上下文，必要时加入新内容]

每个 section 保持简洁。文件路径、函数名和错误消息必须逐字保留。`;

function createSummarizationOptions(
  model: Model,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
  const fableReasoning =
    (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model) !== undefined;
  if ((model.reasoning || fableReasoning) && thinkingLevel) {
    options.reasoning = resolveAgentReasoningOption(model, thinkingLevel);
  }
  return options;
}

/** Runs one summarization completion and maps abort/error stops to CompactionError. */
async function runSummarizationCompletion(params: {
  messages: AgentMessage[];
  prompt: string;
  customInstructions?: string;
  previousSummary?: string;
  model: Model;
  maxTokens: number;
  apiKey: string | undefined;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
  runtime?: AgentCoreCompletionRuntimeDeps;
  errorLabel: string;
}): Promise<Result<string, CompactionError>> {
  const conversationText = serializeConversation(convertToLlm(params.messages));
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (params.previousSummary) {
    promptText += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += params.prompt;
  // SDK callers also pass generated policy here; the host bounds raw operator focus.
  if (params.customInstructions) {
    promptText += `\n\nAdditional focus: ${params.customInstructions}`;
  }
  const context = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: promptText }],
        timestamp: Date.now(),
      },
    ],
  };
  const options = createSummarizationOptions(
    params.model,
    params.maxTokens,
    params.apiKey,
    params.headers,
    params.signal,
    params.thinkingLevel,
  );
  const response = params.streamFn
    ? await consumeAgentCoreStream(params.streamFn(params.model, context, options))
    : await resolveAgentCoreCompleteFn(params.runtime)(params.model, context, options);
  // Usage belongs to the completed provider request even when its summary is invalid.
  params.runtime?.internalUsageSink?.(response.usage);
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError("aborted", response.errorMessage || `${params.errorLabel} aborted`),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `${params.errorLabel} failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }

  const summary = extractSummaryText(response);
  if (summary === undefined) {
    return err(
      new InvalidSummaryOutputError(`${params.errorLabel} failed: model returned no summary text`),
    );
  }
  return ok(summary);
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<string, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const prompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  return await runSummarizationCompletion({
    messages: currentMessages,
    prompt,
    customInstructions,
    previousSummary,
    model,
    maxTokens,
    apiKey,
    headers,
    signal,
    thinkingLevel,
    streamFn,
    runtime,
    errorLabel: "Summarization",
  });
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  /** Whether compaction splits a turn. */
  isSplitTurn: boolean;
  /** Bounded request that the run owner will resume after compaction. */
  latestUnresolvedUserRequest?: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File metadata already appended to the previous compaction summary. */
  previousSummaryDetails?: CompactionDetails;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  /** Settings used to prepare compaction. */
  settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
  requestState?: "unresolved",
): Result<CompactionPreparation | undefined, CompactionError> {
  const lastEntry = pathEntries.at(-1);
  if (
    !lastEntry ||
    lastEntry.type === "reset" ||
    (lastEntry.type === "compaction" && lastEntry.fromHook)
  ) {
    // Safeguard-owned compactions are anti-loop boundaries for the current turn.
    return ok(undefined);
  }

  let prevBoundaryIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    const type = pathEntries.at(i)?.type;
    if (type === "compaction" || type === "reset") {
      prevBoundaryIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let previousSummaryDetails: CompactionDetails | undefined;
  let previousLatestUnresolvedUserRequest: string | undefined;
  let effectiveEntries = pathEntries;
  let resetPreludeMessages: AgentMessage[] = [];
  let boundaryStart = 0;
  if (prevBoundaryIndex >= 0) {
    const prevBoundary = pathEntries[prevBoundaryIndex];
    previousSummary = prevBoundary?.type === "compaction" ? prevBoundary.summary : undefined;
    if (prevBoundary?.type === "compaction") {
      const details = parseCompactionDetails(prevBoundary.details);
      previousLatestUnresolvedUserRequest = details?.latestUnresolvedUserRequest;
      if (!prevBoundary.fromHook) {
        previousSummaryDetails = details;
      }
    }
    const firstKeptEntryId =
      prevBoundary?.type === "compaction" || prevBoundary?.type === "reset"
        ? prevBoundary.firstKeptEntryId
        : undefined;
    const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (prevBoundary?.type === "reset") {
      const keptEntries =
        firstKeptEntryIndex >= 0
          ? selectResetKeptEntries(pathEntries.slice(firstKeptEntryIndex, prevBoundaryIndex))
          : [];
      resetPreludeMessages = keptEntries.flatMap((entry) => {
        const message = getMessageFromEntryForCompaction(entry);
        return message ? [message] : [];
      });
      effectiveEntries = pathEntries.slice(prevBoundaryIndex + 1);
      prevBoundaryIndex = -1;
    } else {
      boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevBoundaryIndex + 1;
    }
  }
  const boundaryEnd = effectiveEntries.length;

  const contextMessages = buildSessionContext(pathEntries).messages;
  const latestUnresolvedUserRequest = requestState
    ? (extractLatestUserRequest(contextMessages) ?? previousLatestUnresolvedUserRequest)
    : undefined;
  const contextUsage = estimateContextTokens(contextMessages);
  const tokensBefore = contextUsage.tokens;
  const totalEstimatedTokens = contextMessages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  // Provider usage includes prompt/schema tokens omitted by estimateTokens. Normalize its trigger
  // units to the cut walk, capped at a one-token retained tail; otherwise a small transcript
  // can leave the cut at the first entry and free nothing.
  const triggerUnitScale =
    totalEstimatedTokens > 0 &&
    Number.isFinite(totalEstimatedTokens) &&
    Number.isFinite(contextUsage.usageTokens)
      ? Math.min(
          Math.max(1, settings.keepRecentTokens),
          Math.max(1, contextUsage.usageTokens / totalEstimatedTokens),
        )
      : 1;
  const resetPreludeTokens = resetPreludeMessages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  // The reset prelude is always part of the summarization request. Count it like
  // other model-visible boundary context so a large kept tail moves the cut earlier.
  const keepRecentTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    settings.keepRecentTokens / triggerUnitScale + resetPreludeTokens,
  );

  const cutPoint = findCutPoint(effectiveEntries, boundaryStart, boundaryEnd, keepRecentTokens);
  const firstKeptEntry = effectiveEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [...resetPreludeMessages];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const entry = effectiveEntries.at(i);
    const msg = entry ? getMessageFromEntryForCompaction(entry) : undefined;
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const entry = effectiveEntries.at(i);
      const msg = entry ? getMessageFromEntryForCompaction(entry) : undefined;
      if (msg) {
        turnPrefixMessages.push(msg);
      }
    }
  }
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return ok(undefined);
  }
  const fileOps = extractFileOperations(messagesToSummarize, effectiveEntries, prevBoundaryIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    tokensBefore,
    previousSummary,
    previousSummaryDetails,
    fileOps,
    settings,
  });
}

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `这是一个因体积过大而无法完整保留的回合前缀；后缀（最近的工作）仍会保留。

请摘要此前缀，为保留的后缀提供必要上下文：

## Original Request
[用户在这个回合要求什么？]

## Early Progress
- [前缀中已做的关键决定与工作]

## Context for Suffix
- [理解保留下来的近期工作所需的信息]

保持简洁，只保留理解后缀所必需的内容。`;

export { serializeConversation } from "./utils.js";

/** Generate compaction summary data from prepared session history. */
export async function compact(
  preparation: CompactionPreparation,
  model: Model,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<CompactionResult, CompactionError>> {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    previousSummaryDetails,
    fileOps,
    settings,
  } = preparation;
  if (!firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }

  const summarizeTurnPrefix = isSplitTurn && turnPrefixMessages.length > 0;
  const previousFileOperations = previousSummaryDetails
    ? formatFileOperations(previousSummaryDetails.readFiles, previousSummaryDetails.modifiedFiles)
    : "";
  const preservedPreviousSummary =
    previousFileOperations && previousSummary?.endsWith(previousFileOperations)
      ? previousSummary.slice(0, -previousFileOperations.length)
      : previousSummary;
  const historyResult =
    messagesToSummarize.length > 0 || !summarizeTurnPrefix
      ? await generateSummary(
          messagesToSummarize,
          model,
          settings.reserveTokens,
          apiKey,
          headers,
          signal,
          customInstructions,
          previousSummary,
          thinkingLevel,
          streamFn,
          runtime,
        )
      : ok<string, CompactionError>(preservedPreviousSummary ?? "No prior history.");
  if (!historyResult.ok) {
    return err(historyResult.error);
  }

  let latestContext = "";
  if (summarizeTurnPrefix) {
    const maxTokens = Math.min(
      Math.floor(0.5 * settings.reserveTokens),
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    );
    const turnPrefixResult = await runSummarizationCompletion({
      messages: turnPrefixMessages,
      prompt: TURN_PREFIX_SUMMARIZATION_PROMPT,
      customInstructions,
      model,
      maxTokens,
      apiKey,
      headers,
      signal,
      thinkingLevel,
      streamFn,
      runtime,
      errorLabel: "Turn prefix summarization",
    });
    if (!turnPrefixResult.ok) {
      return err(turnPrefixResult.error);
    }
    latestContext = `\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  const fileOperations = formatFileOperations(readFiles, modifiedFiles);
  const preservedHistoryChars = Math.min(
    historyResult.value.length,
    Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2),
  );
  const latestContextBudget =
    MAX_COMPACTION_SUMMARY_CHARS -
    SUMMARY_TRUNCATED_MARKER.length -
    fileOperations.length -
    preservedHistoryChars;
  latestContext = `${capCompactionSummary(latestContext, latestContextBudget)}${fileOperations}`;
  const unresolvedRequestContext = preparation.latestUnresolvedUserRequest
    ? `## Latest unresolved user request\n${JSON.stringify(preparation.latestUnresolvedUserRequest)}\n\n`
    : "";
  const summary = capCompactionSummary(
    `${unresolvedRequestContext}${historyResult.value}${latestContext}`,
    MAX_COMPACTION_SUMMARY_CHARS,
    latestContext,
  );

  return ok({
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: {
      readFiles,
      modifiedFiles,
      ...(preparation.latestUnresolvedUserRequest
        ? { latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest }
        : {}),
    } as CompactionDetails,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
