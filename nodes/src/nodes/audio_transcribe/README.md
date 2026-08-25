# audio_transcribe

A RocketRide audio node that transcribes incoming audio or video streams into
text with the configured Whisper backend.

## About Whisper

Whisper is the transcription backend constructed by this node. The node uses
it to turn buffered PCM audio into timestamped text segments.

## What it does

The node accepts `audio` or `video`, extracts the audio track as 16 kHz mono
PCM, buffers it in chunks of `chunk_duration` seconds (default 60), and
transcribes each chunk with Whisper using built-in Silero voice-activity
detection. Consecutive segments are merged until one ends in terminal
punctuation (`.`, `?`, `!`), so the `text` lane carries whole sentences, each
stamped with the timestamp of its first segment. Pick it when a pipeline
needs spoken content as text, rather than local playback or speech synthesis.
Transcription runs through `ai.common.models.Whisper`: it routes to the model
server when the engine is started with `--modelserver`, otherwise it runs
locally via `faster-whisper`; no API key is required either way. When a
`documents` listener is attached, it also writes one document per merged
sentence; the declared lanes remain the `text` outputs below.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `audio` | `text` | Transcribe the audio stream into merged text sentences. |
| `video` | `text` | Transcribe audio decoded from the video stream into merged text sentences. |

## Profiles

Default: **Default (Base)** (`default`), an alias for the `base` model.

| Profile | Model | Context |
| --- | --- | --- |
| `default` **(default)** | `base` | Alias for the base model. |
| `tiny` | `tiny` | Fastest, least accurate. |
| `base` | `base` | Fast, low accuracy. |
| `small` | `small` | Medium speed and accuracy. |
| `medium` | `medium` | Slower, high accuracy. |
| `large-v3` | `large-v3` | Slowest, highest accuracy. |

Each profile owns a full copy of the configuration fields below, stored under
its own key, so editing `beam_size` on `medium` leaves `tiny`'s settings
untouched. A config with no `profile` key keeps working: it resolves against
`default`, whether its values sit at the top level or inside a
`"default": { … }` object.

## Configuration

Pick a profile with the **Model Profile** selector; only the model and
`language: en` differ between profiles, and everything else comes from the
field defaults, which reproduce the behavior this node had before the
decoding and VAD fields were exposed. Most users only need the profile and
`language`. Models are downloaded from HuggingFace on first use, and the GPU
is used automatically when available.

### Model

Declared once per profile and defaulted to that profile's own model;
setting it overrides the profile's choice. It is deliberately not a single
shared field: a shared field defaulted to `base` would be written into the
selected profile's object on the first save and win the merge — silently
downgrading `medium` to `base` with nothing logged.

### Language

ISO 639-1 code of the spoken language (default `en`). It must match the
audio; a mismatch produces garbled, half-translated text.

### Compute Type

CTranslate2 weight precision for the loaded model: `float16` (default),
`int8`, `int8_float16`, or `float32`. `float16` needs a GPU; CTranslate2
downgrades it to `int8` on CPU.

### Chunk Duration

Seconds of audio to buffer before sending a chunk to Whisper (default 60).
Longer chunks give Whisper more context per call; shorter chunks reduce
latency to the first transcript.

### Beam Size

Beam size for decoding (default 5). `1` is greedy and fastest; higher values
are slower and usually more accurate.

### VAD fields

`vad_filter` (default true) uses Whisper's built-in Silero VAD to drop
non-speech before transcribing. The other four map onto faster-whisper's
`VadOptions`: `vad_threshold` (default 0.5, Silero speech probability above
which audio counts as speech), `vad_min_silence_duration_ms` (default 500,
silence this long ends a speech chunk), `vad_speech_pad_ms` (default 400,
padding added to each side of a detected speech chunk), and
`vad_max_speech_duration_s` (default 0, split speech chunks longer than
this). They are merged over the node's defaults rather than replacing them,
so setting one leaves the others alone. `vad_threshold` and
`vad_speech_pad_ms` accept `0` as a real value; only
`vad_max_speech_duration_s` treats `0` specially, as "no limit".

## Notes

### Segmentation and documents

Transcription calls are serialized through a global lock so a single loaded
model is shared safely across instances. The transcriber combines
consecutive segments until one ends in `.`, `?`, or `!`, then writes that
text with the timestamp of its first segment. For document output, each
document carries `chunkId` (sequential per stream, reset on each new stream)
and `time_stamp` (seconds from stream start) in its metadata, plus
`metadata.source` (the source audio's media detail — `source_mime`,
`duration`, `sample_rate`, …) and `metadata.name` =
`<audio-stem>.segment<N>.txt` when the input carried a stream descriptor.

### Removed fields

`silence_threshold`, `min_seconds`, `max_seconds` and `vad_level` were
declared but read by nothing, and are gone as of #1809. They predate the
move to faster-whisper's built-in Silero VAD: `vad_level` (webrtcvad 0-3
aggressiveness) is replaced by `vad_threshold` (Silero 0-1 speech
probability), `silence_threshold` (seconds) by
`vad_min_silence_duration_ms`, and `min_seconds`/`max_seconds` by
`chunk_duration`, which is actually wired up. Configs that still carry the
old keys keep working: nothing validates node config keys, so the unknown
values are ignored. There is no automatic translation to the replacements,
since that would change transcripts for anyone who had set them.

### Profile history

Two fixed bugs explain the current design. Before #1809 the profiles set
`mode`, but the node reads `model` — so every profile silently loaded
`base`, whichever one you picked. Before #2067 the profile selector was
hidden and listed only `default`, so five of the six profiles were
unreachable from the UI.

## Upstream docs

- [Whisper repository](https://github.com/openai/whisper)
- [faster-whisper repository](https://github.com/SYSTRAN/faster-whisper)


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
