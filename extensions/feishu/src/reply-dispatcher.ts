import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-runtime";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type OutboundIdentity,
  type ReplyPayload,
  type RuntimeEnv,
} from "./reply-dispatcher-runtime-api.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendStructuredCardFeishu, type CardHeaderConfig } from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

// --- Reply chain tracking for mention decay ---
// Tracks how many replies have been sent in each reply chain (keyed by chain context).
// This persists across individual dispatcher instances so that the Nth reply in a
// conversation chain correctly decays the @mention probability.
const replyChainCounters = new Map<string, { count: number; lastUsed: number }>();
const REPLY_CHAIN_TTL_MS = 60 * 60_000; // 60 minutes — agents may run long tasks before replying
const REPLY_CHAIN_CLEANUP_INTERVAL_MS = 10 * 60_000;
let lastChainCleanup = Date.now();

function cleanupStaleChains() {
  const now = Date.now();
  if (now - lastChainCleanup < REPLY_CHAIN_CLEANUP_INTERVAL_MS) return;
  lastChainCleanup = now;
  for (const [key, entry] of replyChainCounters) {
    if (now - entry.lastUsed > REPLY_CHAIN_TTL_MS) {
      replyChainCounters.delete(key);
    }
  }
}

/** Build a chain key from reply context.
 *  Both human and bot senders use the same thread/topic anchor so each
 *  conversation chain has its own independent counter.
 *
 *  - Human senders: policy is "never" (hardcoded), so chain counters are
 *    not consumed. The agent decides whether to @mention humans on its own.
 *  - Bot senders: policy is configurable (default: decay). The chain counter
 *    tracks how many replies have been sent in this thread to the same bot,
 *    allowing probability-based @mention decay to gradually break cascade.
 *    Different threads/topics get independent counters, so a bot starting
 *    a new conversation will still be @mentioned at full probability.
 *  - Includes agentId so each agent maintains independent counters. */
function buildReplyChainKey(params: {
  agentId: string;
  chatId: string;
  rootId?: string;
  replyToMessageId?: string;
  senderOpenId?: string;
}): string {
  const sender = params.senderOpenId || "unknown";
  const anchor = params.rootId || params.replyToMessageId || params.chatId;
  return `${params.agentId}:${params.chatId}:${anchor}:${sender}`;
}

function getAndIncrementChainCount(chainKey: string): number {
  cleanupStaleChains();
  const entry = replyChainCounters.get(chainKey);
  const count = entry?.count ?? 0;
  replyChainCounters.set(chainKey, { count: count + 1, lastUsed: Date.now() });
  return count;
}

/** Mention sender policy — parsed from config */
export type MentionSenderPolicy =
  | "always"
  | "decay"
  | "first-only"
  | "never"
  | { initialProbability: number; decayFactor: number; minProbability: number };

/** Resolve the mentionSender config into a normalized policy object. */
function resolveMentionSenderPolicy(
  raw: unknown,
): MentionSenderPolicy {
  if (raw === undefined || raw === null) {
    // Default: decay with sensible defaults (first reply always @, halve each time)
    return { initialProbability: 1.0, decayFactor: 0.5, minProbability: 0 };
  }
  if (typeof raw === "string") {
    if (raw === "always" || raw === "never" || raw === "first-only" || raw === "decay") {
      return raw;
    }
    return { initialProbability: 1.0, decayFactor: 0.5, minProbability: 0 };
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      initialProbability: typeof obj.initialProbability === "number" ? obj.initialProbability : 1.0,
      decayFactor: typeof obj.decayFactor === "number" ? obj.decayFactor : 0.5,
      minProbability: typeof obj.minProbability === "number" ? obj.minProbability : 0,
    };
  }
  return { initialProbability: 1.0, decayFactor: 0.5, minProbability: 0 };
}

/** Decide whether to @mention the sender for the Nth reply (0-based deliverIndex). */
function shouldMentionSender(policy: MentionSenderPolicy, deliverIndex: number): boolean {
  if (policy === "always") return true;
  if (policy === "never") return false;
  if (policy === "first-only") return deliverIndex === 0;
  if (policy === "decay") {
    // Built-in decay: 100% → 50% → 25% → …
    const prob = Math.pow(0.5, deliverIndex);
    return Math.random() < prob;
  }
  // Custom decay object
  const { initialProbability, decayFactor, minProbability } = policy;
  const prob = Math.max(minProbability, initialProbability * Math.pow(decayFactor, deliverIndex));
  return Math.random() < prob;
}

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;
const STREAMING_START_FAILURE_BACKOFF_MS = 60_000;
const streamingStartBackoffUntilByAccount = new Map<string, number>();

function isStreamingStartBackedOff(accountId: string, now = Date.now()): boolean {
  const backoffUntil = streamingStartBackoffUntilByAccount.get(accountId);
  if (backoffUntil === undefined) {
    return false;
  }
  if (backoffUntil <= now) {
    streamingStartBackoffUntilByAccount.delete(accountId);
    return false;
  }
  return true;
}

function rememberStreamingStartFailure(accountId: string, now = Date.now()): number {
  const backoffUntil = now + STREAMING_START_FAILURE_BACKOFF_MS;
  streamingStartBackoffUntilByAccount.set(accountId, backoffUntil);
  return backoffUntil;
}

export function clearFeishuStreamingStartBackoffForTests() {
  streamingStartBackoffUntilByAccount.clear();
}

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

/** Build a card header from agent identity config. */
function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig | undefined {
  const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
  const emoji = identity?.emoji?.trim();
  const title = (emoji ? `${emoji} ${name}` : name).trim();
  if (!title) {
    return undefined;
  }
  return {
    title,
    template: identity?.theme ?? "blue",
  };
}

/** Build a card note footer from agent identity and model context. */
function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  allowReasoningPreview?: boolean;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  /** @deprecated No longer used for reply mentions. Kept for type compatibility.
   *  Mention targets are now resolved dynamically based on sender policy. */
  mentionTargets?: MentionTarget[];
  accountId?: string;
  identity?: OutboundIdentity;
  /** Sender's open ID — used for auto @mention in replies */
  senderOpenId?: string;
  /** Sender's display name — used for auto @mention in replies */
  senderName?: string;
  /** Sender type from Feishu (e.g. "user" or "app"). When "app", @mention
   *  uses configurable decay policy to gradually break bot-to-bot cascade. */
  senderType?: string;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    // mentionTargets — no longer used in reply dispatch; see resolveEffectiveMentions
    accountId,
    identity,
    senderOpenId,
    senderName,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  // --- Mention sender policy ---
  // Human senders: "never" — no auto @mention. The agent can still choose to
  // @mention humans in its reply text. Cascade is impossible because humans
  // don't auto-reply, so there is no need for the system to force @mentions.
  // Bot/app senders: configurable via `mentionSender` (default: decay).
  // The first reply has 100% chance to @mention (ensuring delivery), then
  // probability halves each subsequent reply in the same thread, gradually
  // breaking potential bot-to-bot cascade loops while still allowing
  // occasional @mentions for long conversations.
  const senderIsBot = params.senderType === "app";
  const mentionPolicy: MentionSenderPolicy = senderIsBot
    ? resolveMentionSenderPolicy(
        (account.config as Record<string, unknown>)?.mentionSender,
      )
    : "never";
  // Build a sender MentionTarget if we have the info
  const senderMentionTarget: MentionTarget | undefined =
    senderOpenId
      ? { openId: senderOpenId, name: senderName || senderOpenId, key: "" }
      : undefined;
  // Chain key for cross-message reply chain tracking (per-agent)
  const chainKey = buildReplyChainKey({
    agentId, chatId, rootId, replyToMessageId, senderOpenId,
  });
  // Whether we've already resolved the mention decision for this dispatcher instance.
  // Within a single request-response cycle, the mention decision is made once
  // (on the first text delivery) and reused for all chunks/streaming closes.
  let chainMentionResolved = false;
  let chainMentionResult: MentionTarget[] | undefined;

  let typingState: TypingIndicatorState | null = null;
  const { typingCallbacks } = createChannelReplyPipeline({
    cfg,
    agentId,
    channel: "feishu",
    accountId,
    typing: {
      start: async () => {
        // Check if typing indicator is enabled (default: true)
        if (!(account.config.typingIndicator ?? true)) {
          return;
        }
        if (!replyToMessageId) {
          return;
        }
        // Skip typing indicator for old messages — likely replays after context
        // compaction that would flood users with stale notifications (#30418).
        const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
        if (
          messageCreateTimeMs !== undefined &&
          Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
        ) {
          return;
        }
        // Feishu reactions persist until explicitly removed, so skip keepalive
        // re-adds when a reaction already exists. Re-adding the same emoji
        // triggers a new push notification for every call (#28660).
        if (typingState?.reactionId) {
          return;
        }
        typingState = await addTypingIndicator({
          cfg,
          messageId: replyToMessageId,
          accountId,
          runtime: params.runtime,
        });
      },
      stop: async () => {
        if (!typingState) {
          return;
        }
        await removeTypingIndicator({
          cfg,
          state: typingState,
          accountId,
          runtime: params.runtime,
        });
        typingState = null;
      },
      onStartError: (err) =>
        logTypingFailure({
          log: (message) => params.runtime.log?.(message),
          channel: "feishu",
          action: "start",
          error: err,
        }),
      onStopError: (err) =>
        logTypingFailure({
          log: (message) => params.runtime.log?.(message),
          channel: "feishu",
          action: "stop",
          error: err,
        }),
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";
  const reasoningPreviewEnabled = streamingEnabled && params.allowReasoningPreview === true;

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  let statusLine = "";
  let snapshotBaseText = "";
  let lastSnapshotTextLength = 0;
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  type StreamTextUpdateMode = "snapshot" | "delta";

  const formatReasoningPrefix = (thinking: string): string => {
    if (!thinking) {
      return "";
    }
    const withoutLabel = thinking.replace(/^Reasoning:\n/, "");
    const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
    const lines = plain.split("\n").map((line) => `> ${line}`);
    return `> 💭 **Thinking**\n${lines.join("\n")}`;
  };

  const buildCombinedStreamText = (thinking: string, answer: string): string => {
    const parts: string[] = [];
    if (thinking) {
      parts.push(formatReasoningPrefix(thinking));
    }
    if (thinking && answer) {
      parts.push("\n\n---\n\n");
    }
    if (answer) {
      parts.push(answer);
    }
    if (statusLine) {
      parts.push(parts.length > 0 ? `\n\n${statusLine}` : statusLine);
    }
    return parts.join("");
  };

  const flushStreamingCardUpdate = (combined: string) => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(combined);
      }
    });
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
      mode?: StreamTextUpdateMode;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";
    if (mode === "delta") {
      streamText = `${streamText}${nextText}`;
    } else {
      const currentSnapshotText = snapshotBaseText
        ? streamText.slice(snapshotBaseText.length)
        : streamText;
      const startsNewSnapshotBlock =
        lastSnapshotTextLength >= 20 &&
        nextText.length < lastSnapshotTextLength * 0.5 &&
        !currentSnapshotText.includes(nextText);
      if (startsNewSnapshotBlock) {
        snapshotBaseText = streamText;
        streamText = `${snapshotBaseText}${nextText}`;
      } else {
        streamText = `${snapshotBaseText}${mergeStreamingText(currentSnapshotText, nextText)}`;
      }
      lastSnapshotTextLength = nextText.length;
    }
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) {
      return;
    }
    reasoningText = nextThinking;
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const startStreaming = () => {
    if (
      !streamingEnabled ||
      streamingStartPromise ||
      streaming ||
      isStreamingStartBackedOff(account.accountId)
    ) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote,
        });
        streamingStartBackoffUntilByAccount.delete(account.accountId);
      } catch (error) {
        rememberStreamingStartFailure(account.accountId);
        params.runtime.error?.(
          `feishu[${account.accountId}]: streaming start failed; using non-streaming card fallback for ${
            STREAMING_START_FAILURE_BACKOFF_MS / 1000
          }s: ${String(error)}`,
        );
        streaming = null;
        streamingStartPromise = null;
      }
    })();
  };

  /** Resolve effective mention targets for this reply.
   *  Uses the reply chain counter to determine mention probability.
   *  The decision is made once per dispatcher (i.e. per inbound message)
   *  and the chain counter is incremented only once. */
  const resolveEffectiveMentions = (replyText?: string): MentionTarget[] | undefined => {
    if (!senderMentionTarget) return undefined;
    // Dedupe: if the agent already @mentioned the sender in the text, skip auto-mention
    if (replyText && senderOpenId) {
      if (
        replyText.includes(`user_id="${senderOpenId}"`) ||
        replyText.includes(`id=${senderOpenId}`)
      ) {
        return undefined;
      }
    }
    if (!chainMentionResolved) {
      chainMentionResolved = true;
      const chainIndex = getAndIncrementChainCount(chainKey);
      chainMentionResult = shouldMentionSender(mentionPolicy, chainIndex)
        ? [senderMentionTarget]
        : undefined;
    }
    return chainMentionResult;
  };

  const closeStreaming = async () => {
    try {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      if (streaming?.isActive()) {
        statusLine = "";
        let text = buildCombinedStreamText(reasoningText, streamText);
        // Use sender mention for streaming card close (counts as first deliver)
        const streamingMentions = resolveEffectiveMentions(text);
        if (streamingMentions?.length) {
          text = buildMentionedCardContent(streamingMentions, text);
        }
        const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        await streaming.close(text, { note: finalNote });
        // Track the raw streamed text so the duplicate-final check in deliver()
        // can skip the redundant text delivery that arrives after onIdle closes
        // the streaming card.
        if (streamText) {
          deliveredFinalTexts.add(streamText);
        }
      }
    } finally {
      streaming = null;
      streamingStartPromise = null;
      partialUpdateQueue = Promise.resolve();
      streamText = "";
      lastPartial = "";
      reasoningText = "";
      statusLine = "";
      snapshotBaseText = "";
      lastSnapshotTextLength = 0;
    }
  };

  const updateStreamingStatusLine = (nextStatusLine: string) => {
    statusLine = nextStatusLine;
    if (!streaming?.isActive() && !streamingStartPromise && renderMode !== "card") {
      return;
    }
    startStreaming();
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const sendChunkedTextReply = async (params: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    sendChunk: (params: { chunk: string; isFirst: boolean }) => Promise<void>;
  }) => {
    const chunkSource = params.useCard
      ? params.text
      : core.channel.text.convertMarkdownTables(params.text, tableMode);
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      core.channel.text.chunkTextWithMode(chunkSource, textChunkLimit, chunkMode),
    );
    for (const [index, chunk] of chunks.entries()) {
      await params.sendChunk({
        chunk,
        isFirst: index === 0,
      });
    }
    if (params.infoKind === "final") {
      deliveredFinalTexts.add(params.text);
    }
  };

  const sendMediaReplies = async (payload: ReplyPayload) => {
    await sendMediaWithLeadingCaption({
      mediaUrls: resolveSendableOutboundReplyParts(payload).mediaUrls,
      caption: "",
      send: async ({ mediaUrl }) => {
        await sendMediaFeishu({
          cfg,
          to: chatId,
          mediaUrl,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          accountId,
          ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
        });
      },
    });
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: async () => {
        deliveredFinalTexts.clear();
        // Reset per-request mention resolution so each inbound re-evaluates
        chainMentionResolved = false;
        chainMentionResult = undefined;
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        await typingCallbacks?.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const reply = resolveSendableOutboundReplyParts(payload);
        const text = reply.text;
        const hasText = reply.hasText;
        const hasMedia = reply.hasMedia;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        // Resolve effective mentions for this delivery (sender-based with decay)
        const effectiveMentions = shouldDeliverText ? resolveEffectiveMentions(text) : undefined;

        if (shouldDeliverText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(text, { mode: "delta", dedupeWithLastPartial: true });
            }
            if (info?.kind === "final") {
              streamText = text;
              snapshotBaseText = "";
              lastSnapshotTextLength = text.length;
              flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              await sendMediaReplies(payload);
            }
            return;
          }

          if (useCard) {
            const cardHeader = resolveCardHeader(agentId, identity);
            const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
            await sendChunkedTextReply({
              text,
              useCard: true,
              infoKind: info?.kind,
              sendChunk: async ({ chunk, isFirst }) => {
                await sendStructuredCardFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: isFirst ? effectiveMentions : undefined,
                  accountId,
                  header: cardHeader,
                  note: cardNote,
                });
              },
            });
          } else {
            await sendChunkedTextReply({
              text,
              useCard: false,
              infoKind: info?.kind,
              sendChunk: async ({ chunk, isFirst }) => {
                await sendMessageFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: isFirst ? effectiveMentions : undefined,
                  accountId,
                });
              },
            });
          }
        }

        if (hasMedia) {
          await sendMediaReplies(payload);
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks?.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks?.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks?.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming: true,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            const cleaned = stripReasoningTagsFromText(payload.text, {
              mode: "strict",
              trim: "both",
            });
            if (!cleaned) {
              return;
            }
            queueStreamingUpdate(cleaned, {
              dedupeWithLastPartial: true,
              mode: "snapshot",
            });
          }
        : undefined,
      onReasoningStream: reasoningPreviewEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            startStreaming();
            queueReasoningUpdate(payload.text);
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => {} : undefined,
      onToolStart: streamingEnabled
        ? (payload: { name?: string; phase?: string }) => {
            updateStreamingStatusLine(
              `🔧 **Using: ${payload.name ?? payload.phase ?? "tool"}...**`,
            );
          }
        : undefined,
      onAssistantMessageStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("");
          }
        : undefined,
      onCompactionStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("📦 **Compacting context...**");
          }
        : undefined,
      onCompactionEnd: streamingEnabled
        ? () => {
            updateStreamingStatusLine("");
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
