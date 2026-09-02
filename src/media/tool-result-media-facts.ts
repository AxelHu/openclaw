import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../agents/runtime/index.js";
import { normalizeMediaFacts, type MediaFact, type MediaFactInput } from "./media-facts.js";

const TOOL_RESULT_MEDIA_DETAILS_KEY = "openclawProviderMedia";
const RUNTIME_TOOL_RESULT_MEDIA_FACTS = Symbol.for("openclaw.runtimeToolResultMediaFacts");

type ToolResultMediaCarrier = {
  v: 1;
  media: MediaFactInput[];
};

function readPersistedToolResultMediaFacts(message: AgentMessage): MediaFact[] | undefined {
  if (message.role !== "toolResult" || message.toolName !== "readVideo") {
    return undefined;
  }
  const details = asNonArrayRecord(message.details);
  const carrier = asNonArrayRecord(details[TOOL_RESULT_MEDIA_DETAILS_KEY]);
  if (carrier.v !== 1 || !Array.isArray(carrier.media)) {
    return undefined;
  }
  const media = normalizeMediaFacts(carrier.media as MediaFactInput[]);
  return media.length > 0 ? media : undefined;
}

/** Adds a validated, transcript-persisted carrier to a readVideo tool result. */
export function withToolResultMediaDetails<T extends Record<string, unknown>>(
  details: T,
  media: readonly MediaFactInput[],
): T & { openclawProviderMedia: ToolResultMediaCarrier } {
  return {
    ...details,
    [TOOL_RESULT_MEDIA_DETAILS_KEY]: {
      v: 1,
      media: normalizeMediaFacts(media),
    },
  };
}

/** Attaches trusted runtime facts without exposing them as model-visible message bytes. */
export function attachRuntimeToolResultMediaFacts<T extends object>(
  message: T,
  media: readonly MediaFact[],
): T {
  Object.defineProperty(message, RUNTIME_TOOL_RESULT_MEDIA_FACTS, {
    configurable: true,
    value: normalizeMediaFacts(media),
  });
  return message;
}

/** Reads current-turn facts or the persisted readVideo carrier before replay stripping. */
export function readToolResultMediaFacts(message: AgentMessage): MediaFact[] | undefined {
  const runtime = (message as Record<PropertyKey, unknown>)[RUNTIME_TOOL_RESULT_MEDIA_FACTS];
  if (Array.isArray(runtime)) {
    return runtime as MediaFact[];
  }
  return readPersistedToolResultMediaFacts(message);
}

/**
 * Reattaches validated readVideo facts after generic replay hygiene removes toolResult.details.
 * Source and target are index-aligned because stripToolResultDetails never reorders messages.
 */
export function restoreRuntimeToolResultMediaFacts(
  source: readonly AgentMessage[],
  target: readonly AgentMessage[],
): void {
  for (const [index, sourceMessage] of source.entries()) {
    const media = readPersistedToolResultMediaFacts(sourceMessage);
    const targetMessage = target[index];
    if (!media || !targetMessage || targetMessage.role !== "toolResult") {
      continue;
    }
    attachRuntimeToolResultMediaFacts(targetMessage, media);
  }
}
