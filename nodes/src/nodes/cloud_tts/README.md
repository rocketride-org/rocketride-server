# Cloud Text To Speech (`cloud_tts`)

One node directory that backs two cloud TTS vendor registrations sharing a single
`requests`-only engine. The vendor is resolved from the node `logicalType` at
runtime (same pattern as `index_search`). Audio is emitted as MP3 on the `audio`
lane; calls go directly from the engine host over HTTPS, **not** through the
model server.

| Registration                  | Node              | Endpoint                                          | Key env             |
| ----------------------------- | ----------------- | ------------------------------------------------- | ------------------- |
| `services.tts_openai.json`     | OpenAI TTS        | `api.openai.com/v1/audio/speech`                  | `OPENAI_API_KEY`    |
| `services.tts_elevenlabs.json` | ElevenLabs TTS    | `api.elevenlabs.io/v1/text-to-speech/{voice}`     | `ELEVENLABS_API_KEY`|

## Configuration

| Field   | Source            | Notes                                                              |
| ------- | ----------------- | ------------------------------------------------------------------ |
| Model   | profile           | One profile per model. Model lists maintained manually.            |
| Voice   | `<prefix>.voice`  | Static per-vendor list.                                            |
| API key | `apikey` / env    | Falls back to the vendor environment variable when blank.         |

## Lanes

`text`, `documents`, `questions`, `answers` → `audio` (MP3).

## Limits

Each record is sent to the vendor in a single request — there is no chunking.
The vendor caps per-request input length (OpenAI rejects text over ~4096
characters with a 400; ElevenLabs ~5000), so split long inputs upstream (e.g. a
chunker node) before this node. One record over the cap fails that record.

## Code layout

- `IGlobal.py` — resolves the vendor from `logicalType`, holds model/voice/key, dispatches `synthesize`.
- `openai_tts.py` / `elevenlabs_tts.py` — the per-vendor HTTPS call (returns MP3 bytes).
- `IInstance.py` — shared lane plumbing (text/documents/questions/answers → audio).

## Adding a vendor

Add `services.<vendor>.json` (with `path: nodes.cloud_tts`), a `<vendor>_tts.py`
with `synthesize(text, model, voice, api_key) -> bytes`, and register it in
`_ENGINES` in `IGlobal.py`.

## Related nodes

- `audio_tts` — local Kokoro-82M TTS (no vendor key).
