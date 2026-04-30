# Audio TTS Node (`audio_tts`) — Kokoro (RR-411 phase 1)

Text-to-speech node using **Kokoro-82M** only. Additional engines (Piper, Bark, cloud) land in follow-up PRs.

## Behavior (aligned with reference branch for `engine: kokoro`)

- **Input:** `text` lane
- **Output:** `audio` lane — WAV bytes via `writeAudio` (BEGIN / WRITE / END) with MIME `audio/wav`
- **Local:** `kokoro.KPipeline`, spaCy `en_core_web_sm` via `ensure_spacy_en_model()`
- **`--modelserver`:** `ModelClient` + `KokoroLoader` on the server

## Configuration

- Profile **`kokoro`** — `kokoro_voice` dropdown in `services.json`
- Language code is the **first character** of the voice id (`af_*` → `a`, etc.), same as reference

## Dependencies

See `requirements.txt`: `numpy`, `kokoro`, `soundfile`.

## Troubleshooting (`Exception: 1` / wasabi)

If misaki/spaCy initialization fails, see the full multi-engine README on the reference branch; this node uses the same `spacy_en_model` helper as reference.
