import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);

function resolveMinimaxFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}

function isMinimaxAnthropicMessagesModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
  );
}

/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      !fastMode ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveMinimaxFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

/**
 * MiniMax's Anthropic-compatible streaming endpoint returns reasoning_content
 * in OpenAI-style delta chunks ({delta: {content: "", reasoning_content: "..."}})
 * rather than the native Anthropic thinking block format. The shared Anthropic
 * provider cannot process this format and leaks the reasoning text as visible
 * content. Disable thinking in the outgoing payload so MiniMax does not produce
 * reasoning_content deltas during streaming.
 */
/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
export function createMinimaxThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          // Only inject if thinking is not already explicitly set.
          // This preserves unknown intentional override from other wrappers.
          if (payloadObj.thinking === undefined) {
            payloadObj.thinking = { type: "disabled" };
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

/**
 * MiniMax stream-level safety filter (error code 1027) returns mid-stream
 * with stop_reason "sensitive" and a partial response. The underlying
 * anthropic provider maps this to a generic {type:"error"} stream event
 * whose output.errorMessage says "Stream ended with stop_reason: sensitive".
 * Since the partial output context is gone, we cannot resume. We retry the
 * SAME request once with the SAME temperature (LLM sampling is non-deterministic
 * when temperature > 0, so the second attempt usually takes a different path
 * and ~30-50% of the time succeeds). If the second attempt also fails,
 * propagate the error so the caller can decide what to do.
 *
 * Detection strategy: the wrapper is the OUTERMOST layer in the minimax
 * streamFn chain, so it can inspect the FIRST event of the produced stream.
 * The previous sync try/catch approach was incorrect because the provider
 * never throws — it pushes {type:"error"} events.
 *
 * This wrapper is provider-owned and intentionally minimal: same temperature,
 * no prompt rewriting, single retry. Operators who want a different policy
 * can compose their own wrapper in front of this one.
 */
export function createMinimaxSafetyRetryWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return async (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }
    const subsys = (process.env.OPENCLAW_LOG_SUBSYS as string) || "minimax-safety-retry";
    const first = await underlying(model, context, options);
    // Inspect the first event; if it is a 1027 safety error, silently retry
    // once with identical parameters. Otherwise, return the stream as-is.
    const inspected = await inspectFirstEvent(first);
    if (inspected.kind === "safety") {
      // eslint-disable-next-line no-console
      console.warn(
        `[${subsys}] detected rawStopReason=${inspected.rawStopReason} provider=${model.provider} model=${model.id}; attempting 1 silent retry`,
      );
      const retried = await underlying(model, context, options);
      // eslint-disable-next-line no-console
      console.warn(`[${subsys}] retry stream issued (event-level success not yet known)`);
      return retried;
    }
    return inspected.restored;
  };
}

type InspectedStream =
  | { kind: "safety"; rawStopReason: string; message: string }
  | { kind: "ok"; restored: Awaited<ReturnType<StreamFn>> };

/**
 * Read the first event of a stream without consuming it. If the first event
 * is a minimax safety error (rawStopReason === "sensitive" with the model
 * produced from a minimax anthropic endpoint), returns a "safety" outcome.
 * Otherwise, returns a NEW stream that re-emits the buffered first event
 * followed by the rest of the original stream — so the caller still sees
 * every event exactly once.
 */
async function inspectFirstEvent(stream: Awaited<ReturnType<StreamFn>>): Promise<InspectedStream> {
  const iter = stream[Symbol.asyncIterator]();
  const first = await iter.next();
  if (first.done) {
    return { kind: "ok", restored: stream };
  }
  const ev = first.value as {
    type?: string;
    error?: { rawStopReason?: string; provider?: string; errorMessage?: string };
  };
  if (ev?.type === "error" && ev.error?.rawStopReason === "sensitive") {
    void iter.return?.();
    return {
      kind: "safety",
      rawStopReason: ev.error.rawStopReason,
      message: ev.error.errorMessage ?? "(no errorMessage)",
    };
  }
  // Not a safety error: build a restored stream that yields the buffered
  // first event, then the rest of the original iterator.
  const tailStream = wrapWithBufferedHead(iter, first.value);
  return {
    kind: "ok",
    restored: tailStream as unknown as Awaited<ReturnType<StreamFn>>,
  };
}

/**
 * Wraps a stream with a buffered first event. The first call to the returned
 * stream's iterator yields the buffered head event, then delegates to the
 * tail iterator for the rest of the events.
 *
 * We don't return the original stream object because EventStream is not
 * exposed in the public type, and we want to keep the wrapper self-contained.
 * Callers that rely on stream.result() should prefer inspecting
 * AssistantMessage.errorMessage / rawStopReason instead.
 */
function wrapWithBufferedHead<T>(
  tail: AsyncIterator<T>,
  head: T,
): AsyncIterable<T> & { result(): Promise<unknown> } {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      yield head;
      while (true) {
        const r = await tail.next();
        if (r.done) return;
        yield r.value;
      }
    },
    async result() {
      return undefined;
    },
  } as unknown as AsyncIterable<T> & { result(): Promise<unknown> };
}
