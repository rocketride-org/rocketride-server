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
  - `kokoro`
  - `bark` (`bak` is accepted as alias)
- Cloud:
  - `openai`
  - `elevenlabs`

## Model server (automatic)

When the engine runs with **`--modelserver`**, this node routes **every** backend through the model server where a matching loader exists. You do **not** toggle “use model server” per field.

**Placement rule:** Without a model server, the pipeline engine can run locally and each engine picks **CPU vs GPU on the engine host**. With **`--modelserver`**, Piper / Bark / Kokoro (and cloud loaders) use the **model server** where implemented. **`depends(requirements.txt)`** still installs **pip packages** on the engine.

### Local / Hub model weights (GPU on the server)

**Bark** uses `ai.common.models.transformers.pipeline(..., device=None)` with Hugging Face `text-to-audio`. **Kokoro** uses **`kokoro.KPipeline`**. With **`--modelserver`**, Bark uses a **remote HF pipeline**; Kokoro uses **`KokoroLoader`**. **Without** **`--modelserver`**, Bark loads HF locally; Kokoro uses **local `KPipeline` per `kokoro_lang_code`**.

### Piper (ONNX + `piper-tts`)

With **`--modelserver`**, the node uses **`model_type=piper`**: Hub ONNX cache and **`PiperVoice`** inference run **in-process on the server**; audio returns as base64 over DAP. Without **`--modelserver`**, the same library runs in the engine host process.

### Cloud APIs (no local model download)

**OpenAI** and **ElevenLabs** do not ship model weights to your machines; audio is generated on the vendor API. With **`--modelserver`**, HTTP calls are performed **from the model server** (`openai_tts` / `elevenlabs_tts` loaders) so egress and API keys are centered on that host. The engine still writes the temp file for the current lane behavior (same as local mode). Without **`--modelserver`**, the engine calls the APIs directly (existing behavior).

## Python dependencies (`requirements.txt`)

On **`beginGlobal`**, the node calls **`depends(requirements.txt)`** so **all profiles** pull their declared pip deps:

| Area                          | Packages (see `requirements.txt`)                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Piper**                     | `piper-tts` — **`PiperVoice`** in-process                                                                                                                                                                                                                                                                                                                            |
| **Bark**                      | `transformers` — HF **`pipeline`** `text-to-audio` (**PyTorch** from the engine image)                                                                                                                                                                                                                                                                               |
| **Kokoro**                    | `kokoro` + `soundfile` + **`en_core_web_sm`** (spaCy model wheel) — **`KPipeline`** + **misaki** English G2P. Without that model, misaki may run **`spacy.cli.download`**, which uses **wasabi** and can **`sys.exit(1)`**, surfacing as a cryptic **`Exception: 1`** in the engine. See [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md). |
| **OpenAI / ElevenLabs**       | `requests` — HTTPS to vendor APIs in-process                                                                                                                                                                                                                                                                                                                         |
| **MP3 (Piper + HF + Kokoro)** | `lameenc` — WAV→MP3 in-process; `imageio-ffmpeg` — bundled **ffmpeg** as fallback (subprocess)                                                                                                                                                                                                                                                                       |

The model server installs loader deps on demand (**`requirements_piper.txt`**, **`requirements_kokoro.txt`**, etc.); HF **Bark** uses the server’s transformers/torch stack.

## Key configuration fields

The UI uses **`audio_tts.*`** field ids; merged node config still exposes short keys (`piper_voice`, `model`, …) to Python.

- `engine` — set by the profile in `preconfig` (not a separate dropdown).
- **Piper:** **`piper_voice`** — **Voice model** dropdown (presets from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) via Hugging Face Hub). The ONNX file is downloaded and cached on first use; there is no custom path field in the form. Profile id **`piper`** matches the nested config key in the pipe (`piper: { … }`).
- **Bark:** **`bark_model`** — Hugging Face id (curated). Legacy **`model`** still merges when the new keys are absent.
- **Kokoro:** **`kokoro_voice`** — voice from the dropdown; `kokoro_lang_code` is derived automatically from the voice prefix (e.g. `af_*`/`am_*` → `a` American, `ef_*`/`em_*` → `e` Spanish). No separate language field in the form.
- **OpenAI:** **`openai_model`**, **`openai_voice`**, **`api_key`** (dropdowns for model and voice). Legacy **`model`** / **`voice`** are still read if present.
- **ElevenLabs:** **`elevenlabs_model`**, **`elevenlabs_voice`**, **`api_key`**. Legacy **`model`** / **`voice`** still merge for old configs.

## Server / client note

The pipeline often runs on a **server**. A filesystem path on that machine is **not** something a browser or another host can “download” by itself. This node therefore:

- Puts the audio **in the lane** (`audio` stream or `text` JSON with `base64`).
- **Deletes** the temporary file after emitting so the server does not accumulate `tts_*` files.

Downstream nodes (e.g. response / webhook) can turn `base64` into a download link or attachment if your product needs that.

## Troubleshooting Kokoro + `wasabi` / `Exception: 1`

If you see **`Exception: 1`** with a stack frame under **`wasabi/printer.py`** while using **Kokoro** (especially English `kokoro_lang_code` **`a`** / **`b`**): **misaki** initializes **spaCy** and, if **`en_core_web_sm`** is not installed, calls **`spacy.cli.download`**. That CLI path uses **wasabi** and may end with **`sys.exit(1)`**, which embedded pipeline hosts often report as a bare **`1`**.

**Fix:** Ensure the spaCy English small model is installed before running the pipeline. This repo’s **`requirements.txt`** pulls the **`en_core_web_sm-3.8.0`** wheel; re-run / redeploy so **`depends()`** installs it, or manually: `python -m spacy download en_core_web_sm` (match the **spaCy** version in your environment). Non-English Kokoro languages use other misaki paths (e.g. espeak) and may hit different missing-dependency errors.

## Cross-platform notes

- Python implementation is compatible with Windows, Linux, and macOS.
- **Piper:** **`piper-tts`** / **`PiperVoice`** in-process.
- **Bark:** **`transformers`** + **torch** (engine bundle).
- **Kokoro:** **`kokoro`** + **torch** (via that stack); **espeak-ng** may be needed for some languages (see Kokoro docs).
- **Cloud:** **`requests`** only.
- **MP3:** **`lameenc`** first (no ffmpeg); fallback **`ffmpeg`** via **`imageio-ffmpeg`** or `PATH`.
