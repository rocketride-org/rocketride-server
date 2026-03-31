# `audio_tts` — Implementation summary (for Rod / reviewers)

This document describes how the **Text To Speech** RocketRide node is wired: configuration, dependencies, runtime paths, and how audio reaches downstream lanes.

---

## Goals

- **Curated UI:** Every profile uses **dropdowns** (`services.json` enums) for models/voices — no free-text Hub/API ids in the form for normal use.
- **Pip-managed deps:** `beginGlobal` calls **`depends(requirements.txt)`** so the engine installs declared packages for this node (same pattern as other nodes).
- **In-process synthesis where possible:** Piper uses **`piper.PiperVoice`**. **Bark** uses **`transformers` pipeline** (`text-to-audio`). **Kokoro** uses **`kokoro.KPipeline`**. Cloud engines use **`requests`**.
- **MP3 without mandatory system ffmpeg:** Prefer **`lameenc`** (LAME in-process). Fallback: **`ffmpeg`** subprocess using **`imageio-ffmpeg`**’s bundled binary or `PATH`.
- **`--modelserver`:** When set, engines that have loaders are proxied through the **model server** (DAP); the node does not expose a separate “use model server” toggle.
- **GPU + downloads:** With **`--modelserver`**, **Bark** and **Kokoro** (and Piper/OpenAI/ElevenLabs where proxied) load on the **model server**. Without **`--modelserver`**, local engines download on the **engine** host.

### Model placement rule (every profile)

| Mode                                                        | Where the engine runs                                                                                                    | GPU / downloads                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No model server** (`get_model_server_address()` is unset) | Pipeline engine host (often “local”)                                                                                     | Each engine picks CPU vs GPU on **that** host; Hub / Piper / Kokoro caches download **there** on first use.                                                                                                                                          |
| **`--modelserver` active** (address is set)                 | Same engine process, but TTS **weights and voice files** are not loaded from Hub/cache in the node for supported engines | **Per profile:** Piper → `PiperLoader`; **Bark** → `transformers` `PipelineProxy`; Kokoro → `KokoroLoader`; OpenAI/ElevenLabs → cloud loaders when proxied. The engine still runs `depends(requirements.txt)` (pip packages for codecs/client code). |

CLI flag name in deployments is typically **`--modelserver`** (one word); behavior is “if a model-server endpoint is configured, route downloadable models there.”

---

## Layout (main files)

| Piece                                              | Role                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `services.json`                                    | Profiles, enums, `preconfig`, conditional forms (`audio_tts.form.*`).                                              |
| `IGlobal.py`                                       | `depends(requirements.txt)`, merge profile config → `TTSEngine` config, Piper Hub cache path when local.           |
| `tts_engine.py`                                    | Dispatch by `engine`: Piper / Kokoro / Bark / OpenAI / ElevenLabs; MP3 transcoding; optional model-server clients. |
| `piper_catalog.py`                                 | Thin re-export of Hub cache for Piper ONNX voices.                                                                 |
| `piper_native.py` (under `ai.common.models.audio`) | `PiperVoice.load` + `synthesize_wav` to file.                                                                      |
| `wav_to_mp3.py` (under `ai.common.models.audio`)   | `lameenc` WAV→MP3; boolean “try” for fallback.                                                                     |
| `piper_loader.py` (model server)                   | Lazy **`PiperVoice`** per loaded model; inference writes temp WAV in-process.                                      |
| `kokoro_loader.py` (model server)                  | **`KPipeline`** per `lang_code` / repo; GPU via `allocate_gpu`; WAV base64 like Piper.                             |
| `requirements.txt`                                 | Single manifest for the node’s pip installs (see table below).                                                     |

---

## `requirements.txt` (what gets installed via `depends`)

| Dependency             | Used by                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `requests`, `numpy`    | HTTP TTS, array handling                                                                                        |
| `huggingface_hub`      | Piper voice cache / Hub                                                                                         |
| `piper-tts`            | Piper **`PiperVoice`** (ONNX + espeak data in package)                                                          |
| `transformers`         | Bark **`pipeline(..., task='text-to-audio')`**                                                                  |
| `kokoro`, `soundfile`  | Kokoro **`KPipeline`** (Kokoro-82M weights via `kokoro` PyPI)                                                   |
| `en_core_web_sm` wheel | Kokoro EN G2P (**misaki** / **spaCy**); avoids `spacy.cli.download` → **wasabi** `sys.exit(1)` (“Exception: 1”) |
| `lameenc`              | MP3 encoding without external ffmpeg when possible                                                              |
| `imageio-ffmpeg`       | Locate bundled **ffmpeg** for fallback transcoding                                                              |

**PyTorch** is **not** pinned here: it is expected from the **engine / model-server** image (same as other HF nodes).

---

## High-level flow

```mermaid
flowchart LR
  subgraph cfg["Configuration"]
    Pipe["Pipe / profile"]
    Merge["Config.getNodeConfig + profile merge"]
    Pipe --> Merge
  end

  subgraph boot["Node boot"]
    Dep["depends(requirements.txt)"]
    IG["IGlobal.beginGlobal"]
    Merge --> IG
    Dep --> IG
    IG --> TE["TTSEngine"]
  end

  subgraph run["Per utterance"]
    IInst["IInstance.writeText"]
    Syn["IGlobal.synthesize"]
    TE2["TTSEngine.synthesize"]
    Out["Temp file → audio/text lanes"]
    IInst --> Syn --> TE2 --> Out
  end

  TE --> TE2
```

---

## Engine dispatch (local vs model server)

```mermaid
flowchart TB
  A["TTSEngine.synthesize(text)"] --> B{engine?}

  B -->|piper| P{piper_use_model_server?}
  P -->|yes| PM["ModelClient → PiperLoader on server\n(base64 WAV back)"]
  P -->|no| PL["piper_native: PiperVoice\n→ WAV file"]

  B -->|bark| H{HF remote?}
  H -->|model server| HM["transformers pipeline\non server host"]
  H -->|local| HL["transformers pipeline\nin engine process"]

  B -->|kokoro| K{kokoro_use_model_server?}
  K -->|yes| KM["ModelClient → KokoroLoader\n(base64 WAV back)"]
  K -->|no| KL["kokoro.KPipeline\n(in engine process)"]

  B -->|openai| O{openai_use_model_server?}
  O -->|yes| OM["ModelClient → openai_tts loader"]
  O -->|no| OL["requests → OpenAI Audio API"]

  B -->|elevenlabs| E{elevenlabs_use_model_server?}
  E -->|yes| EM["ModelClient → elevenlabs_tts loader"]
  E -->|no| EL["requests → ElevenLabs API"]

  PL --> M["MP3? lameenc → else ffmpeg"]
  HL --> M
  KL --> M
  KM --> M2
  PM --> M2["MP3? lameenc → else ffmpeg"]
  HM --> M
  OM --> OM2["Usually already MP3"]
  OL --> OM2
  EM --> OM2
  EL --> OM2
```

---

## Piper (local) — detail

```mermaid
sequenceDiagram
  participant UI as Profile / piper_voice
  participant IG as IGlobal
  participant Hub as huggingface_hub cache
  participant PV as PiperVoice
  participant WAV as Temp WAV
  participant MP3 as lameenc / ffmpeg

  UI->>IG: profile piper + preset
  IG->>Hub: ensure_voice_cached → .onnx path
  IG->>PV: load(onnx) cached on TTSEngine
  PV->>WAV: synthesize_wav(text)
  alt wiring asks MP3
    WAV->>MP3: try lameenc; else ffmpeg
  end
```

---

## Model server Piper loader

```mermaid
flowchart LR
  L["PiperLoader.load"] --> B["Bundle: onnx_path + lock"]
  B --> I["inference: lazy PiperVoice"]
  I --> W["temp WAV bytes"]
  W --> R["base64 in DAP response"]
```

---

## Rod review checklist (suggested)

- **End-to-end:** Form → merged config → `IGlobal` → `TTSEngine` / model server → `IInstance` lanes (audio PCM + text JSON base64).
- **Regression:** Old pipes with legacy `model`/`voice` keys should still merge via `_resolve_tts_model` / `_resolve_tts_voice`.
- **Fallback:** MP3 path tries `lameenc` first; exotic WAV formats may still need ffmpeg.
- **Cross-platform:** `lameenc` ships wheels for common platforms; ffmpeg fallback uses `imageio-ffmpeg` or system `PATH`.
- **Optional features:** Without `--modelserver`, HF/Piper run in the engine host; with it, loaders run where the model server is started.

---

## References

- Node README: `README.md` in this folder.
- Service definition: `services.json`.
- Model server Piper deps: `packages/ai/src/ai/common/models/audio/requirements_piper.txt`.
