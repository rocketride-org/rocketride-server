# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Global state for the cloud TTS node: one shared engine, vendor resolved from logicalType."""

import os
from typing import Any, Tuple

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config

from . import elevenlabs_tts, openai_tts

_MP3_MIME = 'audio/mpeg'

# One entry per cloud TTS vendor. The key is matched (substring) against the node
# logicalType to pick the vendor. Add a vendor by adding an entry here plus its
# <vendor>_tts.synthesize(text, model, voice, api_key) -> bytes module.
_ENGINES = {
    'openai': {
        'synthesize': openai_tts.synthesize,
        'default_model': 'gpt-4o-mini-tts',
        'default_voice': 'alloy',
        'env_key': 'OPENAI_API_KEY',
        'label': 'OpenAI TTS',
    },
    'elevenlabs': {
        'synthesize': elevenlabs_tts.synthesize,
        'default_model': 'eleven_multilingual_v2',
        'default_voice': 'EXAVITQu4vr4xnSDxMaL',
        'env_key': 'ELEVENLABS_API_KEY',
        'label': 'ElevenLabs',
    },
}


def _resolve_engine(logical_type: Any) -> str:
    """Pick the vendor whose id appears in the node logicalType.

    Longest id first so a vendor id that is a substring of another still resolves
    to the most specific match.
    """
    lt = str(logical_type).lower()
    for engine in sorted(_ENGINES, key=len, reverse=True):
        if engine in lt:
            return engine
    raise Exception(f'Unknown cloud TTS engine for logicalType: {logical_type}')


class IGlobal(IGlobalBase):
    """Cloud TTS node global state.

    Holds the resolved vendor, model, voice and API key. ``synthesize`` is safe
    to call repeatedly; the HTTP client (``requests``) is imported lazily.
    """

    _engine: str
    _model: str
    _voice: str
    _api_key: str

    def beginGlobal(self):
        """Resolve the vendor/model/voice/key from the node configuration.

        No-op in ``CONFIG`` mode (the UI only needs the schema). Otherwise
        installs the lightweight HTTP dependency and validates the API key.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._engine = _resolve_engine(self.glb.logicalType)
        spec = _ENGINES[self._engine]

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self._model = str(cfg.get('model') or spec['default_model']).strip()
        self._voice = str(cfg.get('voice') or spec['default_voice']).strip()
        self._api_key = (cfg.get('apikey') or os.environ.get(spec['env_key']) or '').strip()
        if not self._api_key:
            raise Exception(f'{spec["label"]} requires an API key (node config or {spec["env_key"]})')

        from depends import depends  # type: ignore

        depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

    def synthesize(self, text: str) -> Tuple[bytes, str]:
        """Synthesise ``text`` and return ``(mp3_bytes, mime_type)``.

        The cloud vendors return the whole clip in one response, so the bytes are
        handed straight to the caller — no temp file round-trip.
        """
        synth = _ENGINES[self._engine]['synthesize']
        return synth(text, self._model, self._voice, self._api_key), _MP3_MIME

    def endGlobal(self):
        """Nothing to release — the HTTP client is created per request."""
        self._api_key = ''
