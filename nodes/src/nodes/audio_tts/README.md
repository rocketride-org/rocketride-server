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

## Cloud variant (`audio_tts_cloud`)

Registered separately via `services.cloud.json` — surfaces in the UI as
**Text To Speech (Cloud)** and uses the protocol `audio_tts_cloud://`. The
Python code (`IGlobal`, `IInstance`) is shared with the Kokoro service via
`path: "nodes.audio_tts"`; engine selection is driven by the active
profile's `engine` field.

| Profile      | Engine field | Backend                                                          | Output  |
| ------------ | ------------ | ---------------------------------------------------------------- | ------- |
| `openai`     | `openai`     | HTTPS POST to `api.openai.com/v1/audio/speech`                   | MP3/WAV |
| `elevenlabs` | `elevenlabs` | HTTPS POST to `api.elevenlabs.io/v1/text-to-speech/{voice_id}`   | MP3     |

Cloud engines run **directly on the engine host** and never go through the
model server. The HTTP implementation lives in `cloud_engine.py`
(`CloudTTSEngine`), keeping `IGlobal.py` to a thin dispatcher.

### API keys

Cloud engines require an API key, supplied via:

1. The `api_key` field of the profile (UI / pipeline connector config), or
2. The environment variables `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` when
   the field is blank.

No other config locations are searched.

### Dependencies (cloud)

Cloud paths additionally pull in `requests` via `depends()`; the package is
declared in `requirements.txt` alongside the Kokoro stack.
