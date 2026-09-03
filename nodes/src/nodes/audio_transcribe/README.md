# audio_transcribe

A RocketRide audio filter node that transcribes spoken audio or video to text using OpenAI Whisper.

## What it does

Receives an audio or video stream, extracts the audio track as 16 kHz mono PCM, buffers it in 60-second chunks (configurable — see `chunk_duration`), and runs Whisper with built-in voice activity detection (VAD). Segments are merged until they end in terminal punctuation (`.`, `?`, `!`), so output arrives as whole sentences, each carrying the timestamp of its first segment.

Uses `ai.common.models.Whisper`: transcription routes to the model server when the engine is started with `--modelserver`, otherwise it runs locally via `faster-whisper`. No API key is required either way. Decoding and VAD are configurable per request — see `beam_size` and the `vad_*` fields below; the defaults reproduce the behaviour this node had before they were exposed. Transcription calls are serialized through a global lock so a single loaded model is shared safely across instances.

Models are downloaded from HuggingFace on first use. GPU is used automatically when available; `compute_type` picks the precision of the loaded weights and defaults to `float16`, which CTranslate2 downgrades to `int8` on CPU.

---

## Configuration

### Lanes

| Input lane | Output lane | Behaviour |
|------------|-------------|-----------|
| `audio`    | `text`      | Transcribed sentences, one per segment |
| `video`    | `text`      | Audio track is extracted from the video and transcribed |

When a `documents` listener is attached, the node also emits one document per merged sentence with `chunkId` (sequential per stream, reset on each new stream) and `time_stamp` (seconds from stream start) in the document metadata, plus `metadata.source` (the source audio's media detail — `source_mime`, `duration`, `sample_rate`, …) and `metadata.name` = `<audio-stem>.segment<N>.txt` when the input carried a stream descriptor.

### Fields

| Field | Type | Description |
|---|---|---|
| `profile` | string | Default "default". The model preset this node runs. Every other field below is stored per profile |
| `model` | string | Defaults to the selected profile's model. Overrides it when set |
| `language` | string | Default "en". ISO 639-1 code of the spoken language |
| `compute_type` | string | Default "float16". CTranslate2 weight precision: `float16`, `int8`, `int8_float16` or `float32`. `float16` needs a GPU and falls back to `int8` on CPU |
| `chunk_duration` | number | Default 60. Seconds of audio to buffer before sending a chunk to Whisper |
| `beam_size` | number | Default 5. Beam size for decoding. 1 is greedy (fastest); higher is slower and usually more accurate |
| `vad_filter` | boolean | Default true. Use Whisper's built-in Silero VAD to drop non-speech before transcribing |
| `vad_threshold` | number | Default 0.5. Silero speech probability above which audio counts as speech (0-1) |
| `vad_min_silence_duration_ms` | number | Default 500. Silence this long ends a speech chunk |
| `vad_speech_pad_ms` | number | Default 400. Padding added to each side of a detected speech chunk |
| `vad_max_speech_duration_s` | number | Default 0. Split speech chunks longer than this. 0 means no limit |

The five `vad_*` fields map onto faster-whisper's `VadOptions`. They are merged over the
node's defaults rather than replacing them, so setting one leaves the others alone. Note
`vad_threshold` and `vad_speech_pad_ms` accept `0` as a real value; only
`vad_max_speech_duration_s` treats `0` specially, as "no limit".

### Removed fields

`silence_threshold`, `min_seconds`, `max_seconds` and `vad_level` were declared but read
by nothing, and are gone as of #1809. They predate the move to faster-whisper's built-in
Silero VAD:

| Removed | Replacement |
|---|---|
| `vad_level` (webrtcvad 0-3 aggressiveness) | `vad_threshold` (Silero 0-1 speech probability) |
| `silence_threshold` (seconds) | `vad_min_silence_duration_ms` |
| `min_seconds` / `max_seconds` | `chunk_duration`, which is actually wired up. There is no second, higher threshold: it would only mean something with a silence test between the two, and pause handling belongs to Whisper's VAD |

Configs that still carry them keep working: nothing validates node config keys, so the
unknown values are ignored. There is no automatic translation to the replacements, since
that would change transcripts for anyone who had set them.

---

## Models

| Model      | Notes |
|------------|-------|
| `tiny`     | Fastest, least accurate |
| `base`     | Fast, low accuracy (default) |
| `small`    | Medium speed and accuracy |
| `medium`   | Slower, high accuracy |
| `large-v3` | Slowest, highest accuracy |

---

## Profiles

The node ships one profile per model size (`tiny`, `base`, `small`, `medium`, `large-v3`) plus `default`, which is an alias for `base`. Only the model and `language: en` differ; everything else comes from the field defaults.

Pick one with the **Model Profile** selector. Each profile owns a full copy of the fields above, stored under its own key, so editing `beam_size` on `medium` leaves `tiny`'s settings untouched:

```json
{
  "profile": "medium",
  "medium": { "beam_size": 1, "language": "de" }
}
```

A config with no `profile` key keeps working: it resolves against `default`, whether its values sit at the top level or inside a `"default": { … }` object.

Two bugs are worth knowing about because their shape explains the current design:

- Before #1809 the profiles set `mode`, but the node reads `model` — so every profile silently loaded `base`, whichever one you picked.
- Before #2067 the selector was hidden and listed only `default`, so five of the six profiles were unreachable from the UI. The `model` field is declared once **per profile**, each defaulted to that profile's own model. A single shared field defaulted to `base` would be written into the selected profile's object on the first save and win the merge — silently downgrading `medium` to `base` with nothing logged.

---

## Language

Defaults to English (`en`). Change the `language` config value to transcribe other languages. Any language supported by Whisper is accepted.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `transcribe.base.model` | `string` | **Model**<br/>The Whisper model to use for transcription. Defaults to the model this profile selects | `"base"` |
| `transcribe.beam_size` | `number` | **Beam Size**<br/>Beam size for decoding. 1 is greedy (fastest); higher is slower and usually more accurate | `5` |
| `transcribe.chunk_duration` | `number` | **Chunk Duration (s)**<br/>Seconds of audio to buffer before sending a chunk to Whisper | `60` |
| `transcribe.compute_type` | `string` | **Compute Type**<br/>CTranslate2 weight precision. float16 needs a GPU and falls back to int8 on CPU; float32 is the most precise and the slowest | `"float16"` |
| `transcribe.default.model` | `string` | **Model**<br/>The Whisper model to use for transcription. Defaults to the model this profile selects | `"base"` |
| `transcribe.language` | `string` | **Language**<br/>ISO 639-1 code of the spoken language (e.g. en, ru, de). Must match the audio; a mismatch produces garbled half-translated text | `"en"` |
| `transcribe.large-v3.model` | `string` | **Model**<br/>The Whisper model to use for transcription. Defaults to the model this profile selects | `"large-v3"` |
| `transcribe.medium.model` | `string` | **Model**<br/>The Whisper model to use for transcription. Defaults to the model this profile selects | `"medium"` |
| `transcribe.profile` | `string` | **Model Profile**<br/>Whisper model preset. Each profile keeps its own copy of the settings below, so switching profiles does not disturb another profile's overrides | `"default"` |
| `transcribe.small.model` | `string` | **Model**<br/>The Whisper model to use for transcription. Defaults to the model this profile selects | `"small"` |
| `transcribe.tiny.model` | `string` | **Model**<br/>The Whisper model to use for transcription. Defaults to the model this profile selects | `"tiny"` |
| `transcribe.vad_filter` | `boolean` | **VAD Filter**<br/>Use Whisper's built-in Silero VAD to drop non-speech before transcribing | `true` |
| `transcribe.vad_max_speech_duration_s` | `number` | **VAD Maximum Speech (s)**<br/>Split speech chunks longer than this. 0 means no limit | `0` |
| `transcribe.vad_min_silence_duration_ms` | `number` | **VAD Minimum Silence (ms)**<br/>Silence this long ends a speech chunk | `500` |
| `transcribe.vad_speech_pad_ms` | `number` | **VAD Speech Padding (ms)**<br/>Padding added to each side of a detected speech chunk | `400` |
| `transcribe.vad_threshold` | `number` | **VAD Speech Threshold**<br/>Silero speech probability above which audio counts as speech (0-1) | `0.5` |

## Dependencies

- `faster-whisper`
- `ctranslate2`
- `av`
- `tokenizers`
- `huggingface-hub`
- `tqdm`
- `onnxruntime-gpu` `==1.22.0; platform_system != 'Darwin'`
- `onnxruntime` `==1.22.0; platform_system == 'Darwin'`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/audio_transcribe)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
