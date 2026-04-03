# Audio TTS Node (`audio_tts`)

Text-to-speech node for RocketRide pipelines.

## What it does

- Input lane: `text`
- Output lane: `audio` — streams container-format audio bytes (WAV or MP3) via `writeAudio` (BEGIN / WRITE / END) with the matching MIME type.

**WAV vs MP3** is determined by the engine: all engines produce WAV except ElevenLabs, which always returns MP3 from its API. For Piper and HF engines, MP3 conversion uses **`lameenc`** in-process (no ffmpeg subprocess or external binary required).

## Supported engines

- Local / model-based:
  - `piper`
  - `kokoro`
  - `bark` (`bak` is accepted as alias)
- Cloud:
  - `openai`
  - `elevenlabs`

## Configuration

This node uses the **standard `Config.getNodeConfig` interface** (same as `llm_openai`, `llm_anthropic`, and other nodes). Configuration is read from `services.json` `preconfig` profiles merged with the pipeline connector config.

- `engine` — set by the profile in `preconfig` (not a separate dropdown).
- **Piper:** **`piper_voice`** — Voice model dropdown (presets from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) via Hugging Face Hub). The ONNX file is downloaded and cached on first use.
- **Bark:** **`bark_model`** — Hugging Face model id. Legacy **`model`** still merges when the new key is absent.
- **Kokoro:** **`kokoro_voice`** — voice from the dropdown; `kokoro_lang_code` is derived automatically from the voice prefix (e.g. `af_*`/`am_*` → `a` American, `ef_*`/`em_*` → `e` Spanish).
- **OpenAI:** **`openai_model`**, **`openai_voice`**, **`api_key`** (or `OPENAI_API_KEY` environment variable). Legacy **`model`** / **`voice`** are still read if present.
- **ElevenLabs:** **`elevenlabs_model`**, **`elevenlabs_voice`**, **`api_key`** (or `ELEVENLABS_API_KEY` environment variable). Legacy **`model`** / **`voice`** still merge for old configs.

**API keys** for cloud engines must be set explicitly in the node config (`api_key` field) or via the corresponding environment variable. There is no fallback search across other config locations.

## Model server (automatic)

When the engine runs with **`--modelserver`**, this node routes local backends (Piper, Kokoro, Bark) through the model server where a matching loader exists. **Cloud engines (OpenAI, ElevenLabs) always call vendor APIs directly from the engine host** — they do not go through the model server.

**Placement rule:** Without a model server, each engine picks CPU vs GPU on the engine host. With **`--modelserver`**, Piper / Bark / Kokoro use the model server where implemented. **`depends(requirements.txt)`** still installs pip packages on the engine.

### Local / Hub model weights (GPU on the server)

**Bark** uses `ai.common.models.transformers.pipeline(..., device=None)` with Hugging Face `text-to-audio`. **Kokoro** uses **`kokoro.KPipeline`**. With **`--modelserver`**, Bark uses a remote HF pipeline; Kokoro uses **`KokoroLoader`**. Without **`--modelserver`**, both load locally.

### Piper (ONNX + `piper-tts`)

With **`--modelserver`**, the node uses **`model_type=piper`**: Hub ONNX cache and **`PiperVoice`** inference run in-process on the server; audio returns as base64 over DAP. Without **`--modelserver`**, the same library runs in the engine host process.

### Cloud APIs (no local model download)

**OpenAI** and **ElevenLabs** do not ship model weights; audio is generated on the vendor API. The engine calls the APIs directly from the engine host regardless of whether `--modelserver` is set.

## Python dependencies (`requirements.txt`)

On **`beginGlobal`**, the node calls **`depends(requirements.txt)`** so all profiles pull their declared pip deps:

| Area                          | Packages (see `requirements.txt`)                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Piper**                     | `piper-tts` — **`PiperVoice`** in-process                                                                                                                                                                                                                                         |
| **Bark**                      | `transformers` — HF **`pipeline`** `text-to-audio` (PyTorch from the engine image)                                                                                                                                                                                                |
| **Kokoro**                    | `kokoro` + `soundfile` + **`en_core_web_sm`** (spaCy model, installed dynamically via `ensure_spacy_en_model()` matching the installed spaCy version) — **`KPipeline`** + **misaki** English G2P. See [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md). |
| **OpenAI / ElevenLabs**       | `requests` — HTTPS to vendor APIs in-process                                                                                                                                                                                                                                      |
| **MP3 (Piper + HF + Kokoro)** | `lameenc` — WAV→MP3 in-process (no ffmpeg subprocess)                                                                                                                                                                                                                             |

The model server installs loader deps on demand (**`requirements_piper.txt`**, **`requirements_kokoro.txt`**, etc.); HF Bark uses the server's transformers/torch stack.

## Server / client note

The pipeline often runs on a **server**. This node:

- Puts the audio directly **in the `audio` lane** as container-format bytes.
- **Deletes** the temporary file after emitting so the server does not accumulate `tts_*` files.
- Periodically cleans up any stale `tts_*` temp files older than 1 hour (configurable via `temp_output_max_age_sec`).

## Troubleshooting Kokoro + `wasabi` / `Exception: 1`

If you see **`Exception: 1`** with a stack frame under **`wasabi/printer.py`** while using **Kokoro** (especially English `kokoro_lang_code` **`a`** / **`b`**): **misaki** initializes **spaCy** and, if **`en_core_web_sm`** is not installed, calls **`spacy.cli.download`**. That CLI path uses **wasabi** and may end with **`sys.exit(1)`**, which embedded pipeline hosts often report as a bare **`1`**.

**Fix:** The node installs the correct spaCy model version automatically via `ai.common.models.audio.spacy_en_model.ensure_spacy_en_model()`, which detects the installed spaCy version and fetches the matching wheel. Non-English Kokoro languages use other misaki paths (e.g. espeak) and may hit different missing-dependency errors.

## Cross-platform notes

- Python implementation is compatible with Windows, Linux, and macOS.
- **Piper:** `piper-tts` / `PiperVoice` in-process.
- **Bark:** `transformers` + torch (engine bundle).
- **Kokoro:** `kokoro` + torch (via that stack); **espeak-ng** may be needed for some languages (see Kokoro docs).
- **Cloud:** `requests` only.
- **MP3:** `lameenc` in-process — no ffmpeg or external binary needed.
