# Audio TTS Node (`audio_tts`)

Text-to-speech node for RocketRide pipelines.

## What it does

- Input lane: `text`
- Outputs depend on **what you connect** (not a separate “output mode” setting):
  - **`audio` lane connected:** streams PCM chunks via `writeAudio` (BEGIN / WRITE / END) for downstream audio nodes.
  - **`text` lane connected:** emits one JSON string per utterance with `mime_type` and **`base64`** (no `path` — the file lived only briefly on the server host and is removed after handoff).
  - **Both connected:** same bytes are streamed on `audio` and embedded as `base64` on `text` (one read, then temp file deleted).
  - **Neither connected:** synthesis is skipped (warning logged).

**WAV vs MP3** is not configurable in the form: it is inferred from wiring — **audio lane connected → WAV** (except ElevenLabs, which stays MP3 from the API); **text lane only → MP3** for a smaller base64 payload. For Piper and HF engines, MP3 is produced with **`lameenc`** in-process when possible; otherwise **`ffmpeg`** (system or **`imageio-ffmpeg`** bundle).

## Supported engines

- Local / model-based:
  - `piper`
  - `coqui`
  - `kokoro`
  - `bark` (`bak` is accepted as alias)
- Cloud:
  - `openai`
  - `elevenlabs`

## Model server (automatic)

When the engine runs with **`--modelserver`**, this node routes **every** backend through the model server where a matching loader exists. You do **not** toggle “use model server” per field.

### Local / Hub model weights (GPU on the server)

**Coqui, Kokoro, Bark** use `ai.common.models.transformers.pipeline(..., device=None)`. Weights download on the **model server host** (Hugging Face cache there), and inference runs there. The node **reuses a single pipeline client** per loaded global (same HF `model` id) so the server is not asked to load once per utterance.

### Piper (ONNX + `piper-tts`)

With **`--modelserver`**, the node uses **`model_type=piper`**: Hub ONNX cache and **`PiperVoice`** inference run **in-process on the server**; audio returns as base64 over DAP. Without **`--modelserver`**, the same library runs in the engine host process.

### Cloud APIs (no local model download)

**OpenAI** and **ElevenLabs** do not ship model weights to your machines; audio is generated on the vendor API. With **`--modelserver`**, HTTP calls are performed **from the model server** (`openai_tts` / `elevenlabs_tts` loaders) so egress and API keys are centered on that host. The engine still writes the temp file for the current lane behavior (same as local mode). Without **`--modelserver`**, the engine calls the APIs directly (existing behavior).

## Python dependencies (`requirements.txt`)

On **`beginGlobal`**, the node calls **`depends(requirements.txt)`** so **all profiles** pull their declared pip deps:

| Area                      | Packages (see `requirements.txt`)                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Piper**                 | `piper-tts` — **`PiperVoice`** in-process                                                                    |
| **Coqui / Kokoro / Bark** | `transformers` — HF **`pipeline`** in-process (**PyTorch** still comes from the engine / model-server image) |
| **OpenAI / ElevenLabs**   | `requests` — HTTPS to vendor APIs in-process                                                                 |
| **MP3 (Piper + HF)**      | `lameenc` — WAV→MP3 in-process; `imageio-ffmpeg` — bundled **ffmpeg** only as fallback (subprocess)          |

The model server’s Piper worker installs **`requirements_piper.txt`** (`piper-tts`, Hub helpers); HF loads use the server’s transformers/torch stack.

## Key configuration fields

The UI uses **`audio_tts.*`** field ids; merged node config still exposes short keys (`piper_voice`, `model`, …) to Python.

- `engine` — set by the profile in `preconfig` (not a separate dropdown).
- **Piper:** **`piper_voice`** — **Voice model** dropdown (presets from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) via Hugging Face Hub). The ONNX file is downloaded and cached on first use; there is no custom path field in the form. Profile id **`piper`** matches the nested config key in the pipe (`piper: { … }`).
- **Coqui / Kokoro / Bark:** **`coqui_model`**, **`kokoro_model`**, **`bark_model`** — each profile has its own dropdown of Hugging Face ids (curated list in `services.json`). Legacy pipes may still use the single key **`model`**; the node maps it when the new keys are absent.
- **OpenAI:** **`openai_model`**, **`openai_voice`**, **`api_key`** (dropdowns for model and voice). Legacy **`model`** / **`voice`** are still read if present.
- **ElevenLabs:** **`elevenlabs_model`**, **`elevenlabs_voice`**, **`api_key`**. Legacy **`model`** / **`voice`** still merge for old configs.

## Server / client note

The pipeline often runs on a **server**. A filesystem path on that machine is **not** something a browser or another host can “download” by itself. This node therefore:

- Puts the audio **in the lane** (`audio` stream or `text` JSON with `base64`).
- **Deletes** the temporary file after emitting so the server does not accumulate `tts_*` files.

Downstream nodes (e.g. response / webhook) can turn `base64` into a download link or attachment if your product needs that.

## Cross-platform notes

- Python implementation is compatible with Windows, Linux, and macOS.
- **Piper:** **`piper-tts`** / **`PiperVoice`** in-process.
- **Coqui / Kokoro / Bark:** **`transformers`** pipeline in-process; **torch** from the engine bundle.
- **Cloud:** **`requests`** only.
- **MP3:** **`lameenc`** first (no ffmpeg); fallback **`ffmpeg`** via **`imageio-ffmpeg`** or `PATH`.
