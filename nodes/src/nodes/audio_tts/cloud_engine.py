# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Cloud TTS engines (OpenAI, ElevenLabs).

These engines call vendor APIs directly from the engine host via HTTPS;
they do not go through the model server. Each engine reads credentials
from the node config (``api_key`` field) and falls back to the
``OPENAI_API_KEY`` / ``ELEVENLABS_API_KEY`` environment variables.

``IGlobal`` only needs to know two things:

* ``SUPPORTED_CLOUD_ENGINES`` — the set of engine ids handled here.
* ``CloudTTSEngine(engine, cfg)`` — a stateless wrapper exposing
  ``synthesize(text) -> {'path', 'mime_type'}``.

Adding a new cloud provider (Azure, Polly, etc.) is a single-file change.
"""

import os
import tempfile
from typing import Any, Dict


_WAV_MIME = 'audio/wav'
_MP3_MIME = 'audio/mpeg'

_OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
_ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech/{voice}'
_HTTP_TIMEOUT_SEC = 120

SUPPORTED_CLOUD_ENGINES = frozenset({'openai', 'elevenlabs'})


class CloudTTSEngine:
    """Wrapper around the OpenAI / ElevenLabs HTTP TTS endpoints.

    A single instance is bound to one engine and one set of credentials.
    ``synthesize`` is safe to call repeatedly; the HTTP client
    (``requests``) is imported lazily so deployments that only use Kokoro
    never pay for it.
    """

    def __init__(self, engine: str, cfg: Dict[str, Any]):
        engine = (engine or '').strip().lower()
        if engine not in SUPPORTED_CLOUD_ENGINES:
            raise ValueError(
                f'cloud_engine: unsupported engine "{engine}". Supported: {", ".join(sorted(SUPPORTED_CLOUD_ENGINES))}'
            )
        self.engine = engine
        if engine == 'openai':
            self.api_key = (cfg.get('api_key') or os.environ.get('OPENAI_API_KEY') or '').strip()
            if not self.api_key:
                raise Exception('OpenAI TTS requires "api_key" (node config or OPENAI_API_KEY)')
            self.voice = str(cfg.get('openai_voice') or cfg.get('voice') or 'alloy').strip()
            self.model = str(cfg.get('openai_model') or cfg.get('model') or 'gpt-4o-mini-tts').strip()
            self.output_format = str(cfg.get('output_format') or 'mp3').strip().lower()
        else:  # elevenlabs
            self.api_key = (cfg.get('api_key') or os.environ.get('ELEVENLABS_API_KEY') or '').strip()
            if not self.api_key:
                raise Exception('ElevenLabs requires "api_key" (node config or ELEVENLABS_API_KEY)')
            self.voice = str(cfg.get('elevenlabs_voice') or cfg.get('voice') or 'EXAVITQu4vr4xnSDxMaL').strip()
            self.model = str(cfg.get('elevenlabs_model') or cfg.get('model') or 'eleven_multilingual_v2').strip()
            # ElevenLabs standard endpoint always returns MP3.
            self.output_format = 'mp3'

    def synthesize(self, text: str) -> Dict[str, Any]:
        """Synthesise ``text`` via the bound cloud engine."""
        if self.engine == 'openai':
            return self._synthesize_openai(text)
        return self._synthesize_elevenlabs(text)

    def _synthesize_openai(self, text: str) -> Dict[str, Any]:
        """POST to the OpenAI TTS endpoint and persist the response body."""
        import requests  # lazy: Kokoro-only deployments must not require it

        suffix = '.mp3' if self.output_format == 'mp3' else '.wav'
        fd, out_path = tempfile.mkstemp(prefix='tts_', suffix=suffix)
        os.close(fd)
        try:
            payload = {
                'model': self.model,
                'voice': self.voice,
                'input': text,
                'response_format': self.output_format,
            }
            headers = {
                'Authorization': f'Bearer {self.api_key}',
                'Content-Type': 'application/json',
            }
            response = requests.post(_OPENAI_TTS_URL, json=payload, headers=headers, timeout=_HTTP_TIMEOUT_SEC)
            response.raise_for_status()
            with open(out_path, 'wb') as f:
                f.write(response.content)
            return {
                'path': out_path,
                'mime_type': _MP3_MIME if self.output_format == 'mp3' else _WAV_MIME,
            }
        except Exception:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise

    def _synthesize_elevenlabs(self, text: str) -> Dict[str, Any]:
        """POST to the ElevenLabs TTS endpoint and persist the response body."""
        import requests

        fd, out_path = tempfile.mkstemp(prefix='tts_', suffix='.mp3')
        os.close(fd)
        try:
            url = _ELEVENLABS_TTS_URL.format(voice=self.voice)
            payload = {'text': text, 'model_id': self.model}
            headers = {
                'xi-api-key': self.api_key,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
            }
            response = requests.post(url, json=payload, headers=headers, timeout=_HTTP_TIMEOUT_SEC)
            response.raise_for_status()
            with open(out_path, 'wb') as f:
                f.write(response.content)
            return {'path': out_path, 'mime_type': _MP3_MIME}
        except Exception:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise
