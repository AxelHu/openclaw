import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { ImageContent, TextContent } from "../../../llm/types.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../../../media/media-facts.js";
import { emitSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { isSensitiveImageRejectionError } from "../../embedded-agent-helpers/image-rejection-error.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionManager } from "../../sessions/index.js";
import { log } from "../logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";
import { readPersistedMediaImageLayout } from "./prompt-image-metadata.js";

export const IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE = "openclaw:image-rejection-recovery";
export const IMAGE_REJECTION_PLACEHOLDER =
  "[image data removed after the provider rejected a recent image as sensitive; the original image is no longer included in prompt history]";
export const IMAGE_REJECTION_RECOVERY_MESSAGE =
  "System note: the provider rejected a recent image as sensitive. OpenClaw removed that image data from prompt history while retaining the surrounding text. Continue without assuming the removed image is visible.";

const DEFAULT_IMAGE_REJECTION_SCAN_MESSAGES = 12;

type RecoverableMessage =
  | Extract<AgentMessage, { role: "user" }>
  | Extract<AgentMessage, { role: "toolResult" }>;

type RewritePlan = {
  entryId: string;
  message: RecoverableMessage;
  imageBlocks: number;
  suppressedMediaFacts: number;
};

export type SensitiveImageRecoveryResult = {
  recovered: boolean;
  imageBlocks: number;
  suppressedMediaFacts: number;
  rewrittenEntries: number;
  reason?: string;
};

function isRecoverableMessage(message: AgentMessage): message is RecoverableMessage {
  return message.role === "user" || message.role === "toolResult";
}

function hasPlaceholder(content: string | readonly (TextContent | ImageContent)[]): boolean {
  return typeof content === "string"
    ? content.includes(IMAGE_REJECTION_PLACEHOLDER)
    : content.some(
        (block) => block.type === "text" && block.text.includes(IMAGE_REJECTION_PLACEHOLDER),
      );
}

function stripInlineImages(content: string | readonly (TextContent | ImageContent)[]): {
  content: string | (TextContent | ImageContent)[];
  imageBlocks: number;
} {
  if (typeof content === "string") {
    return { content, imageBlocks: 0 };
  }
  let imageBlocks = 0;
  let insertedPlaceholder = hasPlaceholder(content);
  const next: Array<TextContent | ImageContent> = [];
  for (const block of content) {
    if (block.type !== "image") {
      next.push(block);
      continue;
    }
    imageBlocks += 1;
    if (!insertedPlaceholder) {
      next.push({ type: "text", text: IMAGE_REJECTION_PLACEHOLDER });
      insertedPlaceholder = true;
    }
  }
  return { content: next, imageBlocks };
}

function appendPlaceholder(
  content: string | readonly (TextContent | ImageContent)[],
): string | (TextContent | ImageContent)[] {
  if (hasPlaceholder(content)) {
    return typeof content === "string" ? content : [...content];
  }
  if (typeof content === "string") {
    return content.trim().length > 0
      ? `${content}\n\n${IMAGE_REJECTION_PLACEHOLDER}`
      : IMAGE_REJECTION_PLACEHOLDER;
  }
  return [...content, { type: "text", text: IMAGE_REJECTION_PLACEHOLDER }];
}

function suppressPersistedImageFacts(message: RecoverableMessage): {
  metadata: Record<string, unknown>;
  suppressedIndexes: number[];
} {
  const metadata = { ...asNonArrayRecord(Reflect.get(message, "__openclaw")) };
  const facts = readPersistedMediaFacts(message) ?? [];
  const suppressedIndexes = facts.flatMap((fact, index) =>
    isImageMediaFact(fact) && fact.hydrationSuppressed !== true ? [index] : [],
  );
  if (suppressedIndexes.length === 0) {
    return { metadata, suppressedIndexes };
  }

  const suppressedSet = new Set(suppressedIndexes);
  metadata.media = facts.map((fact, index) =>
    suppressedSet.has(index) ? { ...fact, hydrationSuppressed: true } : fact,
  );
  const layout = readPersistedMediaImageLayout(message);
  const allSuppressedIndexes = [
    ...(layout?.suppressedFactIndexes ?? []),
    ...suppressedIndexes,
  ].toSorted((left, right) => left - right);
  metadata.mediaImageLayout = {
    slots: layout?.slots ?? [],
    suppressedFactIndexes: [...new Set(allSuppressedIndexes)],
  };
  delete metadata.mediaImageBlockFactIndexes;
  return { metadata, suppressedIndexes };
}

function buildRewritePlan(entryId: string, message: RecoverableMessage): RewritePlan | undefined {
  const stripped = stripInlineImages(message.content);
  const persisted = suppressPersistedImageFacts(message);
  if (stripped.imageBlocks === 0 && persisted.suppressedIndexes.length === 0) {
    return undefined;
  }

  const nextContent =
    stripped.imageBlocks > 0 ? stripped.content : appendPlaceholder(stripped.content);
  const replacement: RecoverableMessage =
    message.role === "toolResult"
      ? {
          ...message,
          content: Array.isArray(nextContent) ? nextContent : [{ type: "text", text: nextContent }],
        }
      : { ...message, content: nextContent };
  if (Object.keys(persisted.metadata).length > 0) {
    Reflect.set(replacement, "__openclaw", persisted.metadata);
  } else {
    Reflect.deleteProperty(replacement, "__openclaw");
  }
  return {
    entryId,
    message: replacement,
    imageBlocks: stripped.imageBlocks,
    suppressedMediaFacts: persisted.suppressedIndexes.length,
  };
}

function findLatestRewritePlan(
  sessionManager: SessionManager,
  maxMessagesToScan: number,
): RewritePlan | undefined {
  let scannedMessages = 0;
  for (const entry of sessionManager.getBranch().toReversed()) {
    if (entry.type !== "message") {
      continue;
    }
    scannedMessages += 1;
    if (isRecoverableMessage(entry.message)) {
      const plan = buildRewritePlan(entry.id, entry.message);
      if (plan) {
        return plan;
      }
    }
    if (scannedMessages >= maxMessagesToScan) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Removes the most recent provider-rejected image from the active transcript
 * branch and appends a hidden model-visible recovery note for the retry.
 */
export function recoverRecentSensitiveImageRejection(params: {
  sessionManager: SessionManager;
  rawError: string;
  sessionFile?: string;
  sessionKey?: string;
  runId?: string;
  sessionId?: string;
  maxMessagesToScan?: number;
}): SensitiveImageRecoveryResult {
  if (!isSensitiveImageRejectionError(params.rawError)) {
    return {
      recovered: false,
      imageBlocks: 0,
      suppressedMediaFacts: 0,
      rewrittenEntries: 0,
      reason: "error is not a sensitive image rejection",
    };
  }
  const requestedScanMessages = params.maxMessagesToScan;
  const maxMessagesToScan =
    typeof requestedScanMessages === "number" && Number.isFinite(requestedScanMessages)
      ? Math.max(1, Math.trunc(requestedScanMessages))
      : DEFAULT_IMAGE_REJECTION_SCAN_MESSAGES;
  const plan = findLatestRewritePlan(params.sessionManager, maxMessagesToScan);
  if (!plan) {
    return {
      recovered: false,
      imageBlocks: 0,
      suppressedMediaFacts: 0,
      rewrittenEntries: 0,
      reason: "no recent image-bearing transcript message",
    };
  }

  const rewritten = rewriteTranscriptEntriesInSessionManager({
    sessionManager: params.sessionManager,
    replacements: [{ entryId: plan.entryId, message: plan.message }],
  });
  if (!rewritten.changed) {
    return {
      recovered: false,
      imageBlocks: plan.imageBlocks,
      suppressedMediaFacts: plan.suppressedMediaFacts,
      rewrittenEntries: rewritten.rewrittenEntries,
      reason: rewritten.reason ?? "transcript rewrite did not change the active branch",
    };
  }

  params.sessionManager.appendCustomMessageEntry(
    IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE,
    IMAGE_REJECTION_RECOVERY_MESSAGE,
    false,
    {
      source: "provider_sensitive_image_rejection",
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      imageBlocks: plan.imageBlocks,
      suppressedMediaFacts: plan.suppressedMediaFacts,
      rewrittenEntries: rewritten.rewrittenEntries,
    },
  );
  emitSessionTranscriptUpdate({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
  });
  log.warn(
    `recovered provider-sensitive image rejection: imageBlocks=${plan.imageBlocks} ` +
      `suppressedMediaFacts=${plan.suppressedMediaFacts} ` +
      `rewrittenEntries=${rewritten.rewrittenEntries}` +
      (params.runId ? ` runId=${params.runId}` : "") +
      (params.sessionId ? ` sessionId=${params.sessionId}` : ""),
  );
  return {
    recovered: true,
    imageBlocks: plan.imageBlocks,
    suppressedMediaFacts: plan.suppressedMediaFacts,
    rewrittenEntries: rewritten.rewrittenEntries,
  };
}
