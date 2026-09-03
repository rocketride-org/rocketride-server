# Cloud Speech To Text (`cloud_stt`)

A node directory for cloud STT vendor registrations sharing a single
`requests`-only engine, mirroring `cloud_tts`'s multi-vendor pattern (vendor
resolved from `logicalType` at runtime). Deepgram is the first (and currently
only) vendor. Calls go directly from the engine host over HTTPS, **not**
through the model server.

> Experimental: `services.stt_deepgram.json` marks its Deepgram registration
> `experimental`. The request/response shape is read directly from Deepgram's
> own API reference, not paraphrased, but has not been exercised against a
> live account.

| Registration                | Node     | Endpoint                              | Key env             |
| ---------------------------- | -------- | -------------------------------------- | -------------------- |
| `services.stt_deepgram.json` | Deepgram | `api.deepgram.com/v1/listen`           | `DEEPGRAM_API_KEY`  |

## What it does

Unlike `audio_transcribe` (local Whisper, buffered and processed in real-time
60-second chunks with voice-activity detection), cloud STT vendors take one
request per clip: this node buffers the entire streamed audio/video clip in
memory across `BEGIN`/`WRITE`/`END`, then sends the complete buffer to the
vendor in a single request at `END` and writes the resulting transcript on the
`text` lane. There is no incremental/partial output.

The `BEGIN` payload is the stream *descriptor* (a small JSON document
describing the incoming stream — see `ai.common.avi.descriptor`), not media
bytes; it is parsed and discarded. Only `WRITE`/`END` payloads carry real
audio bytes, appended to the buffer in order.

## Configuration

| Field         | Type    | Description                                                        |
| ------------- | ------- | -------------------------------------------------------------------- |
| `apikey`      | string  | Deepgram API key. Falls back to `DEEPGRAM_API_KEY` when blank.       |
| `model`       | string  | Default `nova-3`.                                                    |
| `language`    | string  | BCP-47 code, default `en`.                                          |
| `smartFormat` | boolean | Format dates/numbers/currency in the transcript. Default on.        |
| `punctuate`   | boolean | Add punctuation and capitalization. Default on.                     |

No profile selector: Deepgram's model choice needs no nested per-model
config the way `cloud_tts`'s per-model voice profiles do, so these fields sit
directly in the shape rather than behind a `profile` field — connConfig never
carries a `profile` key here, which keeps every field on
`Config.getNodeConfig`'s no-profile-key branch (top-level keys read
directly) instead of the profile branch that silently drops them (see #2070).

## Lanes

`audio`, `video` → `text`.

## Limits

One request per clip, no chunking — the whole buffered clip is sent to
Deepgram at `END`. A very long recording is one large request rather than a
stream of partial transcripts. A clip is capped at 200MB buffered
(`_MAX_BUFFER_BYTES` in `IInstance.py`) — exceeding it discards the buffer
and fails the stream with a clear error rather than growing unbounded, since
nothing here chunks the way `audio_transcribe`'s local processing does. See
Deepgram's own documented limits for pre-recorded audio for what it accepts
past that.

## Code layout

- `IGlobal.py` — resolves the vendor from `logicalType`, holds model/language/feature-flag/key config, dispatches `transcribe`.
- `deepgram_stt.py` — the Deepgram HTTPS call (`transcribe(audio, mime_type, **opts) -> str`).
- `IInstance.py` — buffers `BEGIN`/`WRITE`/`END` audio/video into one clip, transcribes at `END`, writes `text`.

## Adding a vendor

Add `services.<vendor>.json` (with `path: nodes.cloud_stt`), a `<vendor>_stt.py`
with `transcribe(audio, mime_type, **opts) -> str`, and register it in
`_ENGINES` in `IGlobal.py`.

## Related nodes

- `audio_transcribe` — local Whisper transcription (no vendor key), real-time chunked.
