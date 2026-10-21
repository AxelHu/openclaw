---
summary: "Use ElevenLabs speech, Scribe STT, and realtime transcription with OpenClaw"
read_when:
  - You want ElevenLabs text-to-speech in OpenClaw
  - You want ElevenLabs Scribe speech-to-text for audio attachments
  - You want ElevenLabs realtime transcription for Voice Call or Google Meet
title: "ElevenLabs"
---

OpenClaw uses ElevenLabs for text-to-speech, batch speech-to-text with Scribe
v2, and streaming STT with Scribe v2 Realtime. The plugin is bundled and
enabled by default; no `plugins install` step is needed.

| Capability               | OpenClaw surface                                                     | Default                  |
| ------------------------ | -------------------------------------------------------------------- | ------------------------ |
| Text-to-speech           | `tts` / `talk`                                                       | `eleven_multilingual_v2` |
| Batch speech-to-text     | `tools.media.audio`                                                  | `scribe_v2`              |
| Streaming speech-to-text | Voice Call streaming or Google Meet `realtime.transcriptionProvider` | `scribe_v2_realtime`     |

## Authentication

Set `ELEVENLABS_API_KEY` in the environment. `XI_API_KEY` is also accepted for
compatibility with existing ElevenLabs tooling.

```bash
export ELEVENLABS_API_KEY="..."
```

For a rotating pool, use a comma/semicolon-separated list or numbered variables:

```bash
export ELEVENLABS_API_KEYS="key-one,key-two"
# Or: ELEVENLABS_API_KEY_1=... and ELEVENLABS_API_KEY_2=...
```

To keep paid or otherwise preferred accounts ahead of free fallback accounts,
put those keys in `ELEVENLABS_PREFERRED_API_KEYS`. Preferred keys rotate only
among themselves and always stay before ordinary keys:

```bash
export ELEVENLABS_PREFERRED_API_KEYS="paid-key-one,paid-key-two"
```

When no environment key is set, OpenClaw also reads
`~/.config/elevenlabs/credentials.json` (`preferred_api_keys` for the preferred
group, `api_keys` for fallback, plus the legacy `api_key` field), individual non-hidden files in
`~/.config/elevenlabs/keys/`, and the legacy `~/.config/elevenlabs/key`.
Duplicate values are removed, with preferred membership winning. An explicit
provider `apiKey` stays pinned.

TTS and voice-list HTTP requests round-robin within the preferred group first,
then try fallback keys only after the preferred group has returned a definitive
authentication, permission, quota, or rate-limit rejection (HTTP
401/402/403/429). Transport and 5xx failures are not resubmitted with another
key. Batch STT uses OpenClaw's shared media-provider
rotation for environment keys and the same ElevenLabs rejection policy for the
local-file pool. Realtime STT chooses the next key when a new session is
created; reconnects inside that session keep the selected key so audio and
callbacks are not silently rebound to another account.

## Text-to-speech

```json5
{
  tts: {
    providers: {
      elevenlabs: {
        apiKey: "${ELEVENLABS_API_KEY}",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
    },
  },
}
```

Set `modelId` to `eleven_v3` to use ElevenLabs v3 TTS. OpenClaw keeps
`eleven_multilingual_v2` as the default for existing installs.

Discord voice channels use ElevenLabs' streaming TTS endpoint when ElevenLabs
is the selected `voice.tts`/`tts` provider: playback starts from the
returned audio stream instead of waiting for OpenClaw to download the whole
audio file first. `latencyTier` maps to ElevenLabs' `optimize_streaming_latency`
query parameter for models that accept it; OpenClaw omits that parameter for
`eleven_v3`, which rejects it.

## Speech-to-text

Use Scribe v2 for inbound audio attachments and short recorded voice segments:

```json5
{
  tools: {
    media: {
      models: [{ provider: "elevenlabs", model: "scribe_v2", capabilities: ["audio"] }],
      audio: {
        enabled: true,
      },
    },
  },
}
```

OpenClaw sends multipart audio to ElevenLabs `/v1/speech-to-text` with
`model_id: "scribe_v2"`. Language hints map to `language_code` when present.

## Streaming STT

The bundled `elevenlabs` plugin registers Scribe v2 Realtime for Voice Call and
Google Meet agent-mode streaming transcription.

| Setting         | Config path                                                               | Default                                           |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| API key         | `plugins.entries.voice-call.config.streaming.providers.elevenlabs.apiKey` | Falls back to `ELEVENLABS_API_KEY` / `XI_API_KEY` |
| Model           | `...elevenlabs.modelId`                                                   | `scribe_v2_realtime`                              |
| Audio format    | `...elevenlabs.audioFormat`                                               | `ulaw_8000`                                       |
| Sample rate     | `...elevenlabs.sampleRate`                                                | `8000`                                            |
| Commit strategy | `...elevenlabs.commitStrategy`                                            | `vad`                                             |
| Language        | `...elevenlabs.languageCode`                                              | (unset)                                           |

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                apiKey: "${ELEVENLABS_API_KEY}",
                audioFormat: "ulaw_8000",
                commitStrategy: "vad",
                languageCode: "en",
              },
            },
          },
        },
      },
    },
  },
}
```

<Note>
Voice Call receives Twilio media as 8 kHz G.711 u-law. The ElevenLabs realtime
provider defaults to `ulaw_8000`, so telephony frames can be forwarded without
transcoding.
</Note>

For Google Meet agent mode, set
`plugins.entries.google-meet.config.realtime.transcriptionProvider` to
`"elevenlabs"` and configure the same provider block under
`plugins.entries.google-meet.config.realtime.providers.elevenlabs`.

## Related

- [Text-to-speech](/tools/tts)
- [Google Meet](/plugins/google-meet)
- [Model selection](/concepts/model-providers)
