# cloud_tts

A RocketRide audio node with OpenAI, ElevenLabs, and Rime registrations that converts text into MP3 audio. Pick it when pipeline text, documents, questions, or answers should be spoken through one of these cloud text-to-speech APIs.

## About OpenAI, ElevenLabs, and Rime

OpenAI, ElevenLabs, and Rime each publish a cloud text-to-speech API. This directory implements all three as separate registrations over one shared RocketRide engine, which selects the vendor from the node logical type and sends synthesis requests from the engine host over HTTPS.

## What it does

Accepts content on any of four lanes, turns the resulting text into speech through the selected cloud vendor, and writes the returned MP3 bytes to `audio`. Choose the OpenAI registration for the OpenAI text-to-speech API, the ElevenLabs registration for the ElevenLabs text-to-speech API, or the Rime registration for the Rime text-to-speech API; their lane wiring is identical, while their model, voice, and credential settings are separate. Unlike a local TTS node, this node makes an HTTPS request directly from the engine host and needs vendor credentials before it can start.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | `audio` | Synthesize non-empty text input as MP3 audio. |
| `documents` | `audio` | Join eligible document page content, then synthesize it as MP3 audio. |
| `questions` | `audio` | Join the question text entries, then synthesize them as MP3 audio. |
| `answers` | `audio` | Read answer text, then synthesize it as MP3 audio. |

## Profiles

The directory registers three providers and each keeps its own default: the
OpenAI service defaults to **GPT-4o mini TTS - Fast, steerable, multilingual**
(`gpt-4o-mini-tts`), the ElevenLabs service to **Multilingual v2 - High
quality, 29 languages** (`eleven_multilingual_v2`), and the Rime service to
**Coda - Flagship, best quality** (`coda`). All three are marked below;
which one applies depends on the service you added to the pipeline.

| Profile | Vendor model | Default voice |
| --- | --- | --- |
| GPT-4o mini TTS - Fast, steerable, multilingual **(default)** | `gpt-4o-mini-tts` | `alloy` |
| TTS-1 - Low latency, standard quality | `tts-1` | `alloy` |
| TTS-1 HD - Higher quality, slower | `tts-1-hd` | `alloy` |
| Multilingual v2 - High quality, 29 languages **(default)** | `eleven_multilingual_v2` | `EXAVITQu4vr4xnSDxMaL` |
| Turbo v2.5 - Low latency, 32 languages | `eleven_turbo_v2_5` | `EXAVITQu4vr4xnSDxMaL` |
| Flash v2.5 - Lowest latency | `eleven_flash_v2_5` | `EXAVITQu4vr4xnSDxMaL` |
| Eleven v3 - Most expressive | `eleven_v3` | `EXAVITQu4vr4xnSDxMaL` |
| Coda - Flagship, best quality **(default)** | `coda` | `astra` |
| Arcana - Expressive, multilingual | `arcana` | `astra` |
| Mist v3 - Lowest latency | `mistv3` | `astra` |
| Mist v2 - Pronunciation control | `mistv2` | `astra` |


## Configuration

Select the registration first, then choose a model profile and a compatible voice for that vendor. The shared engine reads `model`, `voice`, and `apikey` from the selected configuration and falls back to its vendor-specific default model and voice only when those values are blank.

| Registration | Node | Endpoint | Key env |
| --- | --- | --- | --- |
| `services.tts_openai.json` | OpenAI TTS | `api.openai.com/v1/audio/speech` | `OPENAI_API_KEY` |
| `services.tts_elevenlabs.json` | ElevenLabs TTS | `api.elevenlabs.io/v1/text-to-speech/{voice}` | `ELEVENLABS_API_KEY` |
| `services.tts_rime.json` | Rime TTS | `users.rime.ai/v1/rime-tts` | `RIME_API_KEY` |

The per-vendor HTTPS call lives in `openai_tts.py`, `elevenlabs_tts.py`, and `rime_tts.py`; each returns MP3 bytes.

### OpenAI model and voice

The OpenAI registration offers the `gpt-4o-mini-tts`, `tts-1`, and `tts-1-hd` profiles, defaulting to `gpt-4o-mini-tts` with `alloy`. Choose a profile to change the `model` sent to OpenAI; choose a voice from the OpenAI voice list to change the `voice` in that request. The `marin` and `cedar` voice choices require a GPT-4o TTS model according to the field metadata, so do not pair them with a non-GPT-4o profile.

### ElevenLabs model and voice

The ElevenLabs registration offers the `eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`, and `eleven_v3` profiles, defaulting to `eleven_multilingual_v2` with the `EXAVITQu4vr4xnSDxMaL` voice ID. Select a profile to change the `model_id` sent to ElevenLabs and a listed premade voice ID to change the voice placed in the request URL. Keep the model and voice within the ElevenLabs registration: the engine dispatches only from the registration's logical type and does not translate settings between vendors.

### Rime model and Speaker

The Rime registration offers the `coda`, `arcana`, `mistv3`, and `mistv2` profiles, defaulting to `coda` with the `astra` speaker. Rime speakers are model-specific, so each Rime profile carries its own `tts_rime.<model>.voice` enum and all of them merge under `voice` for the shared engine. Select a profile to change the `model` sent to Rime, then pick a speaker from that profile's own list; `astra` is valid across all four shipped models.

## Authentication

All three registrations require an API key at startup. Put it in the node configuration as `apikey`, or leave that value blank and set `OPENAI_API_KEY` for the OpenAI registration, `ELEVENLABS_API_KEY` for the ElevenLabs registration, or `RIME_API_KEY` for the Rime registration on the engine host. A missing key prevents startup; the requests use a bearer authorization header for OpenAI and Rime and the `xi-api-key` header for ElevenLabs.

## Notes

### Input handling and output

Whitespace-only input produces no audio request. Documents are converted by joining `page_content` from entries that have content and are not `Image`, `Audio`, or `Video`; questions are joined from their question text, and answers use `getText()` when available. Every successful vendor response is written as one `audio/mpeg` clip with a begin/write/end sequence; this node does not split an input into multiple synthesis calls.

### Per-request input caps

Each record is sent to the vendor in a single request, so the vendor's per-request input cap applies to the whole record: OpenAI roughly 4096 characters, ElevenLabs roughly 5000, and Rime 1,000 for `coda`, `mistv2`, and `mistv3` with no cap for `arcana`. Split long inputs upstream with a chunker node before this node; one record over the cap fails that record. The node checks the cap itself and fails the record with the character count, the limit, and what to do about it, because the vendor would otherwise return a bare `400` that never mentions length. Rime's cap is four to five times lower than the others, so a pipeline that worked on OpenAI can hit it simply by switching vendor.

### Request failures

Each vendor request has a 120-second HTTP timeout and raises for a non-success HTTP status. The lane handler logs a `Cloud TTS synthesis failed` warning and re-raises the exception, so a failed request does not emit a partial audio clip.

## Upstream docs

- [OpenAI text-to-speech documentation](https://platform.openai.com/docs/guides/text-to-speech)
- [ElevenLabs text-to-speech API documentation](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Rime text-to-speech API documentation](https://docs.rime.ai/api-reference/endpoint/streaming-mp3)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Text To Speech (ElevenLabs) (`services.tts_elevenlabs.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `tts_elevenlabs.profile` | `string` | **Model**<br/>ElevenLabs model | `"eleven_multilingual_v2"` |
| `tts_elevenlabs.voice` | `string` | **Voice**<br/>Premade ElevenLabs voice (voice_id). | `"EXAVITQu4vr4xnSDxMaL"` |

### Text To Speech (OpenAI) (`services.tts_openai.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `tts_openai.profile` | `string` | **Model**<br/>OpenAI TTS model | `"gpt-4o-mini-tts"` |
| `tts_openai.voice` | `string` | **Voice**<br/>OpenAI TTS voice. The newer voices (marin, cedar) require a GPT-4o TTS model. | `"alloy"` |

### Text To Speech (Rime) (`services.tts_rime.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `tts_rime.arcana.voice` | `string` | **Speaker**<br/>Rime voice for the Arcana model. | `"astra"` |
| `tts_rime.coda.voice` | `string` | **Speaker**<br/>Rime voice for the Coda model. | `"astra"` |
| `tts_rime.mistv2.voice` | `string` | **Speaker**<br/>Rime voice for the Mist v2 model. | `"astra"` |
| `tts_rime.mistv3.voice` | `string` | **Speaker**<br/>Rime voice for the Mist v3 model. | `"astra"` |
| `tts_rime.profile` | `string` | **Model**<br/>Rime TTS model | `"coda"` |

## Dependencies

- `requests` `>=2.34.2`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/cloud_tts)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
