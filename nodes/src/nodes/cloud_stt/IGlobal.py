# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Global state for the cloud STT node: one shared engine, vendor resolved from logicalType.

Mirrors cloud_tts's vendor-registry shape (nodes/src/nodes/cloud_tts/IGlobal.py) so a
second cloud STT vendor is a sibling entry here plus its own <vendor>_stt.transcribe(...)
module, not a rewrite.
"""

import os
from typing import Any

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config

from . import deepgram_stt

# One entry per cloud STT vendor. The key is matched (substring) against the node
# logicalType to pick the vendor. Add a vendor by adding an entry here plus its
# <vendor>_stt.transcribe(audio, mime_type, **opts) -> str module.
_ENGINES = {
    'deepgram': {
        'transcribe': deepgram_stt.transcribe,
        'default_model': 'nova-3',
        'default_language': 'en',
        'env_key': 'DEEPGRAM_API_KEY',
        'label': 'Deepgram',
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
    raise Exception(f'Unknown cloud STT engine for logicalType: {logical_type}')


class IGlobal(IGlobalBase):
    """Cloud STT node global state.

    Holds the resolved vendor, model, language, feature toggles and API key.
    ``transcribe`` is safe to call repeatedly; the HTTP client (``requests``) is
    imported lazily.
    """

    _engine: str
    _model: str
    _language: str
    _smart_format: bool
    _punctuate: bool
    _api_key: str

    def beginGlobal(self):
        """Resolve the vendor/model/language/key from the node configuration.

        No-op in ``CONFIG`` mode (the UI only needs the schema). Otherwise
        installs the lightweight HTTP dependency and validates the API key.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._engine = _resolve_engine(self.glb.logicalType)
        spec = _ENGINES[self._engine]

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self._model = str(cfg.get('model') or spec['default_model']).strip()
        self._language = str(cfg.get('language') or spec['default_language']).strip()
        self._smart_format = bool(cfg.get('smartFormat', True))
        self._punctuate = bool(cfg.get('punctuate', True))
        self._api_key = (cfg.get('apikey') or os.environ.get(spec['env_key']) or '').strip()
        if not self._api_key:
            raise Exception(f'{spec["label"]} requires an API key (node config or {spec["env_key"]})')

        from depends import depends  # type: ignore

        depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

    def transcribe(self, audio: bytes, mime_type: str) -> str:
        """Transcribe ``audio`` (raw bytes, as accumulated from BEGIN/WRITE/END) and
        return the transcript text.
        """
        engine = _ENGINES[self._engine]['transcribe']
        return engine(
            audio,
            mime_type,
            model=self._model,
            language=self._language,
            smart_format=self._smart_format,
            punctuate=self._punctuate,
            api_key=self._api_key,
        )

    def endGlobal(self):
        """Nothing to release — the HTTP client is created per request."""
        self._api_key = ''
