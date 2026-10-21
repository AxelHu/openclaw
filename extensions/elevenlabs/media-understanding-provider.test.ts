// Elevenlabs tests cover media understanding provider plugin behavior.
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { poolKeysMock } = vi.hoisted(() => ({
  poolKeysMock: vi.fn<() => string[]>(() => []),
}));

vi.mock("./api-keys.js", () => ({
  ELEVENLABS_LOCAL_AUTH_SOURCE: "ElevenLabs local credential pool",
  resolveElevenLabsApiKeyPool: ({ explicitApiKey }: { explicitApiKey?: string }) => {
    const explicit = explicitApiKey?.trim();
    return explicit
      ? { apiKeys: [explicit], source: "explicit" }
      : { apiKeys: poolKeysMock(), source: "environment" };
  },
  resolveElevenLabsLocalApiKeyPool: () => ({
    apiKeys: poolKeysMock(),
    source: poolKeysMock().length > 0 ? "local" : "missing",
  }),
  resolveElevenLabsProviderAuth: () => {
    const apiKey = poolKeysMock()[0];
    return apiKey
      ? {
          kind: "api-key",
          apiKey,
          mode: "api-key",
          source: "ElevenLabs local credential pool",
        }
      : undefined;
  },
  executeElevenLabsApiKeyPool: async <T>({
    apiKeys,
    execute,
  }: {
    apiKeys: readonly string[];
    execute: (apiKey: string) => Promise<T>;
  }) => {
    let lastError: unknown;
    for (const apiKey of apiKeys) {
      try {
        return await execute(apiKey);
      } catch (error) {
        lastError = error;
        const status = (error as { status?: unknown }).status;
        if (![401, 402, 403, 429].includes(Number(status))) {
          throw error;
        }
      }
    }
    throw lastError;
  },
}));

import { elevenLabsMediaUnderstandingProvider } from "./media-understanding-provider.js";

function requireFirstFetchCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const [call] = fetchMock.mock.calls;
  if (!call) {
    throw new Error("expected ElevenLabs media fetch call");
  }
  return call as [string, RequestInit];
}

describe("elevenLabsMediaUnderstandingProvider", () => {
  let ssrfMock: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    poolKeysMock.mockReset();
    poolKeysMock.mockReturnValue([]);
  });

  it("has expected provider metadata", () => {
    expect(elevenLabsMediaUnderstandingProvider.id).toBe("elevenlabs");
    expect(elevenLabsMediaUnderstandingProvider.capabilities).toEqual(["audio"]);
    expect(elevenLabsMediaUnderstandingProvider.defaultModels?.audio).toBe("scribe_v2");
    expect(elevenLabsMediaUnderstandingProvider.transcribeAudio).toBeTypeOf("function");
  });

  it("posts multipart audio to ElevenLabs speech-to-text", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));

    const result = await elevenLabsMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      mime: "audio/mpeg",
      apiKey: "eleven-key",
      model: "scribe_v2",
      language: "en",
      timeoutMs: 1000,
      fetchFn: fetchMock,
    });

    expect(result).toEqual({ text: "hello", model: "scribe_v2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = requireFirstFetchCall(fetchMock);
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("xi-api-key")).toBe("eleven-key");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("rotates pooled keys after a definitive transcription rejection", async () => {
    poolKeysMock.mockReturnValue(["key-a", "key-b"]);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ text: "fallback worked" }));

    const result = await elevenLabsMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      mime: "audio/mpeg",
      apiKey: "",
      model: "scribe_v2",
      timeoutMs: 1000,
      fetchFn: fetchMock,
    });

    expect(result.text).toBe("fallback worked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("xi-api-key")).toBe("key-a");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("xi-api-key")).toBe("key-b");
  });

  it("wraps malformed successful speech-to-text JSON with a stable provider error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{ nope"));

    await expect(
      elevenLabsMediaUnderstandingProvider.transcribeAudio!({
        buffer: Buffer.from("audio"),
        fileName: "voice.mp3",
        mime: "audio/mpeg",
        apiKey: "eleven-key",
        model: "scribe_v2",
        timeoutMs: 1000,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow("ElevenLabs audio transcription failed: malformed JSON response");
  });

  it("rejects non-object successful speech-to-text JSON with a stable provider error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([])));

    await expect(
      elevenLabsMediaUnderstandingProvider.transcribeAudio!({
        buffer: Buffer.from("audio"),
        fileName: "voice.mp3",
        mime: "audio/mpeg",
        apiKey: "eleven-key",
        model: "scribe_v2",
        timeoutMs: 1000,
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow("ElevenLabs audio transcription failed: malformed JSON response");
  });
});
