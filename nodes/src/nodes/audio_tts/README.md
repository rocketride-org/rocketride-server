# Audio TTS Node (`audio_tts`)

Text-to-speech node for RocketRide pipelines.

## What it does

- Input lane: `text`
- Output lanes:
  - `audio`: binary audio stream for downstream audio nodes
  - `text`: JSON payload with synthesis metadata:
    - `path` (always)
    - `mime_type` (always)
    - `base64` (when `output_mode=base64`)

## Supported engines

- Local / model-based:
  - `piper`
  - `coqui`
  - `kokoro`
  - `bark` (`bak` is accepted as alias)
- Cloud:
  - `openai`
  - `elevenlabs`

## Model server compatibility (RocketRide SaaS)

For `coqui`, `kokoro`, and `bark`, set:

- `use_model_server=true` to route inference through RocketRide `model_server`
- `use_model_server=false` to run locally (if local dependencies/models are available)

These engines use `ai.common.models.transformers.pipeline(task="text-to-audio", ...)`,
which supports local execution and model-server proxy mode.

## Audio format behavior

- `output_format=wav`
  - Produced directly by local/model-based engines
  - Also supported by OpenAI (provider response)
- `output_format=mp3`
  - OpenAI/ElevenLabs can return MP3 directly
  - `piper`, `coqui`, `kokoro`, `bark` generate WAV then transcode to MP3

## FFmpeg requirement

When `output_format=mp3` and engine is `piper`/`coqui`/`kokoro`/`bark`:

- `ffmpeg` is required
- The node validates this at config time
- You can override binary path with `ffmpeg_bin`

Examples:

- Linux/macOS: `ffmpeg`
- Windows: `ffmpeg.exe` (or full path)

## Key configuration fields

- `engine`
- `voice` (cloud and some local models)
- `voice_model` (Piper `.onnx` path)
- `model` (Coqui/Kokoro/Bark/OpenAI/ElevenLabs model ID)
- `output_mode` (`path` or `base64`)
- `output_format` (`wav` or `mp3`)
- `piper_bin`
- `ffmpeg_bin`
- `use_model_server`
- `ws_enabled`, `ws_host`, `ws_port`, `ws_route`

## WebSocket integration

Optional notification payload is sent to:

- `ws://<ws_host>:<ws_port><ws_route>`
- default port: `5565`

This is intended for downstream audio processing/orchestration nodes.

## Cross-platform notes

- Python implementation is compatible with Windows, Linux, and macOS.
- External runtime dependencies must be installed per platform:
  - `piper` for Piper engine
  - `ffmpeg` when MP3 transcoding is required
