import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createMinimaxFastModeWrapper,
  createMinimaxSafetyRetryWrapper,
  createMinimaxThinkingDisabledWrapper,
} from "./minimax.js";

function captureThinkingPayload(params: {
  provider: string;
  api: string;
  modelId: string;
}): unknown {
  let capturedThinking: unknown = undefined;
  const baseStreamFn: StreamFn = (model, context, options) => {
    const payload: Record<string, unknown> = {};
    options?.onPayload?.(payload, model);
    capturedThinking = payload.thinking;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
  void wrapped(
    {
      api: params.api,
      provider: params.provider,
      id: params.modelId,
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
    {},
  );

  return capturedThinking;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it("disables thinking for minimax anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("disables thinking for minimax-portal anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax-portal",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("does not affect non-minimax providers", () => {
    expect(
      captureThinkingPayload({
        provider: "anthropic",
        api: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it("does not affect minimax with non-anthropic-messages api", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "openai-completions",
        modelId: "MiniMax-M2.7",
      }),
    ).toBeUndefined();
  });

  it("preserves an already-set thinking value", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});

describe("createMinimaxFastModeWrapper", () => {
  it("rewrites MiniMax-M2.7 to highspeed variant in fast mode", () => {
    let capturedId = "";
    const baseStreamFn: StreamFn = (model) => {
      capturedId = model.id;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, true);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedId).toBe("MiniMax-M2.7-highspeed");
  });
});

describe("createMinimaxSafetyRetryWrapper", () => {
  function makeModel(provider = "minimax"): Model<"anthropic-messages"> {
    return {
      api: "anthropic-messages",
      provider,
      id: "MiniMax-M3",
    } as Model<"anthropic-messages">;
  }

  function makeContext(): Context {
    return { messages: [] } as unknown as Context;
  }

  function makeStream<T>(events: T[]): AsyncIterable<T> & AsyncIterator<T> {
    let i = 0;
    const it: AsyncIterable<T> & AsyncIterator<T> = {
      [Symbol.asyncIterator]() {
        return it;
      },
      async next() {
        if (i >= events.length) {
          return { value: undefined as unknown as T, done: true };
        }
        return { value: events[i++] as T, done: false };
      },
    };
    return it;
  }

  function safetyErrorEvent() {
    return {
      type: "error",
      reason: "error",
      error: {
        rawStopReason: "sensitive",
        provider: "minimax",
        errorMessage: "Stream ended with stop_reason: sensitive",
      },
    };
  }

  function textEvent(text: string) {
    return { type: "text", text };
  }

  it("retries once when first event is a safety (rawStopReason=sensitive)", async () => {
    let calls = 0;
    const baseStreamFn: StreamFn = async () => {
      calls += 1;
      if (calls === 1) {
        return makeStream([safetyErrorEvent()]) as unknown as Awaited<ReturnType<StreamFn>>;
      }
      return makeStream([textEvent("retry succeeded")]) as unknown as Awaited<ReturnType<StreamFn>>;
    };
    const wrapped = createMinimaxSafetyRetryWrapper(baseStreamFn);
    const result = (await wrapped(makeModel(), makeContext(), {})) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const ev of result) events.push(ev);
    expect(calls).toBe(2);
    expect(events).toEqual([{ type: "text", text: "retry succeeded" }]);
  });

  it("does not retry when first event is a normal text event", async () => {
    let calls = 0;
    const baseStreamFn: StreamFn = async () => {
      calls += 1;
      return makeStream([textEvent("hello")]) as unknown as Awaited<ReturnType<StreamFn>>;
    };
    const wrapped = createMinimaxSafetyRetryWrapper(baseStreamFn);
    const result = (await wrapped(makeModel(), makeContext(), {})) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const ev of result) events.push(ev);
    expect(calls).toBe(1);
    expect(events).toEqual([{ type: "text", text: "hello" }]);
  });

  it("does not retry when error is non-safety (rawStopReason != sensitive)", async () => {
    let calls = 0;
    const baseStreamFn: StreamFn = async () => {
      calls += 1;
      return makeStream([
        {
          type: "error",
          reason: "error",
          error: { rawStopReason: "max_tokens", errorMessage: "max_tokens" },
        },
      ]) as unknown as Awaited<ReturnType<StreamFn>>;
    };
    const wrapped = createMinimaxSafetyRetryWrapper(baseStreamFn);
    const result = (await wrapped(makeModel(), makeContext(), {})) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const ev of result) events.push(ev);
    expect(calls).toBe(1); // no retry
    expect(events[0]).toMatchObject({ type: "error" });
  });

  it("does not affect non-minimax providers (pass-through)", async () => {
    let calls = 0;
    const baseStreamFn: StreamFn = async () => {
      calls += 1;
      return makeStream([textEvent("ok")]) as unknown as Awaited<ReturnType<StreamFn>>;
    };
    const wrapped = createMinimaxSafetyRetryWrapper(baseStreamFn);
    const result = (await wrapped(
      makeModel("anthropic"),
      makeContext(),
      {},
    )) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const ev of result) events.push(ev);
    expect(calls).toBe(1);
    expect(events).toEqual([{ type: "text", text: "ok" }]);
  });

  it("retry stream is fully consumed (no infinite loop)", async () => {
    let calls = 0;
    const baseStreamFn: StreamFn = async () => {
      calls += 1;
      if (calls === 1) {
        return makeStream([safetyErrorEvent()]) as unknown as Awaited<ReturnType<StreamFn>>;
      }
      // Retry also fails with safety
      return makeStream([safetyErrorEvent()]) as unknown as Awaited<ReturnType<StreamFn>>;
    };
    const wrapped = createMinimaxSafetyRetryWrapper(baseStreamFn);
    const result = (await wrapped(makeModel(), makeContext(), {})) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const ev of result) events.push(ev);
    expect(calls).toBe(2); // exactly 2 attempts
    // The retry stream is the one we return — its events are what the caller
    // sees, including the final safety error event. No infinite loop.
    expect(events.length).toBe(1);
    expect((events[0] as any).error.rawStopReason).toBe("sensitive");
  });

  it("emits a diagnostic log line for detected safety errors", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    let calls = 0;
    const baseStreamFn: StreamFn = async () => {
      calls += 1;
      if (calls === 1) {
        return makeStream([safetyErrorEvent()]) as unknown as Awaited<ReturnType<StreamFn>>;
      }
      return makeStream([textEvent("ok")]) as unknown as Awaited<ReturnType<StreamFn>>;
    };
    try {
      const wrapped = createMinimaxSafetyRetryWrapper(baseStreamFn);
      const result = (await wrapped(makeModel(), makeContext(), {})) as AsyncIterable<unknown>;
      // drain
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of result) {
        /* drain */
      }
      const safetyLogs = warnings.filter(
        (w) => w.includes("minimax-safety-retry") || w.includes("anthropic-safety"),
      );
      expect(safetyLogs.length).toBeGreaterThanOrEqual(1);
    } finally {
      console.warn = origWarn;
    }
  });
});
