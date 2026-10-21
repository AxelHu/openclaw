// Elevenlabs provider module implements model/runtime integration.
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import {
  ELEVENLABS_LOCAL_AUTH_SOURCE,
  executeElevenLabsApiKeyPool,
  resolveElevenLabsApiKeyPool,
  resolveElevenLabsLocalApiKeyPool,
  resolveElevenLabsProviderAuth,
} from "./api-keys.js";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

async function transcribeElevenLabsAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const explicitApiKey = req.apiKey?.trim();
  const apiKeys =
    req.auth?.source === ELEVENLABS_LOCAL_AUTH_SOURCE
      ? resolveElevenLabsLocalApiKeyPool().apiKeys
      : resolveElevenLabsApiKeyPool({ explicitApiKey }).apiKeys;
  if (apiKeys.length === 0) {
    throw new Error("ElevenLabs API key missing");
  }

  const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
  return await executeElevenLabsApiKeyPool({
    apiKeys,
    execute: async (apiKey) => {
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: normalizeElevenLabsBaseUrl(req.baseUrl),
          defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
          headers: req.headers,
          request: req.request,
          defaultHeaders: {
            "xi-api-key": apiKey,
          },
          provider: "elevenlabs",
          api: "elevenlabs-speech-to-text",
          capability: "audio",
          transport: "media-understanding",
        });
      const form = buildAudioTranscriptionFormData({
        buffer: req.buffer,
        fileName: req.fileName,
        mime: req.mime,
        fields: {
          model_id: model,
          language_code: req.language,
          prompt: req.prompt,
        },
      });
      const { response, release } = await postTranscriptionRequest({
        url: `${baseUrl}/v1/speech-to-text`,
        headers,
        body: form,
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        auditContext: "elevenlabs speech-to-text",
      });

      try {
        await assertOkOrThrowHttpError(response, "ElevenLabs audio transcription failed");
        const payload = await readProviderJsonObjectResponse(
          response,
          "ElevenLabs audio transcription failed",
        );
        const text = requireTranscriptionText(
          typeof payload.text === "string" ? payload.text : undefined,
          "ElevenLabs audio transcription response missing text",
        );
        return { text, model };
      } finally {
        await release();
      }
    },
  });
}

export const elevenLabsMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "elevenlabs",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
  autoPriority: { audio: 45 },
  resolveAuth: resolveElevenLabsProviderAuth,
  transcribeAudio: transcribeElevenLabsAudio,
};
