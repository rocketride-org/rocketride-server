# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import os
import threading
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from rocketlib import IGlobalBase, debug
from ai.common.config import Config
from ai.common.models import Whisper

_active: Optional['IGlobal'] = None


class IGlobal(IGlobalBase):
    """
    Global Whisper model and transcription settings for live microphone STT.

    Shared between the endpoint (mic capture) and any filter instances in the
    pipeline stack via :meth:`active`.
    """

    transcribe_lock: threading.Lock = None
    config: Dict[str, Any] = None

    @staticmethod
    def active() -> Optional['IGlobal']:
        """Return the active global instance for this node, if initialized."""
        return _active

    def transcribe(self, audio: bytes) -> List[SimpleNamespace]:
        """
        Transcribe a short PCM window for partial live results.

        Args:
            audio: PCM int16 bytes (16 kHz mono).

        Returns:
            Segment-like objects with ``text``, ``start``, and ``end``.
        """
        if not audio:
            return []

        with self.transcribe_lock:
            result = self._whisper.transcribe(
                audio,
                beam_size=1,
                vad_filter=True,
                vad_parameters={
                    'threshold': self._vad_threshold,
                    'min_silence_duration_ms': self._vad_min_silence_ms,
                    'max_speech_duration_s': self._vad_max_speech_s,
                },
                condition_on_previous_text=False,
            )

        segments = result.get('$segments') or []
        return [
            SimpleNamespace(text=s.get('text', ''), start=s.get('start', 0.0), end=s.get('end', 0.0))
            for s in segments
        ]

    def _normalize_conn_config(self, conn_config: Dict[str, Any]) -> Dict[str, Any]:
        """Flatten source-node parameters into the shape expected by Config.getNodeConfig."""
        config = dict(conn_config)
        parameters = config.get('parameters')
        if isinstance(parameters, dict):
            for key, value in parameters.items():
                if value is None:
                    continue
                short_key = key.split('.', 1)[-1]
                config.setdefault(short_key, value)
            profile = parameters.get('live_stt.profile')
            if profile is not None:
                config['profile'] = profile
        return config

    def _load_config(self, conn_config: Dict[str, Any]) -> Dict[str, Any]:
        """Resolve node configuration from the service connection config."""
        logical_type = getattr(getattr(self, 'glb', None), 'logicalType', 'audio_transcribe_live')
        return Config.getNodeConfig(logical_type, self._normalize_conn_config(conn_config))

    def _init_whisper(self, config: Dict[str, Any]) -> None:
        """Create the Whisper model from resolved configuration."""
        model_name = config.get('model', 'base')
        language = config.get('language', 'en')
        compute_type = config.get('compute_type', 'float16')

        self._whisper = Whisper(
            model_name,
            output_fields=['$text', '$segments'],
            language=language,
            compute_type=compute_type,
        )

        self._vad_threshold = config.get('vad_threshold', 0.35)
        self._vad_min_silence_ms = config.get('vad_min_silence_duration_ms', 300)
        self._vad_max_speech_s = config.get('vad_max_speech_duration_s', 8)

        debug(
            f'    Live transcribe: model={model_name}, language={language}, '
            f'interval={config.get("chunk_interval", 1.5)}s, window={config.get("window_seconds", 4)}s'
        )

    def beginGlobal(self):
        """Load dependencies, configuration, and the Whisper model."""
        global _active

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        self.transcribe_lock = threading.Lock()
        self.config = self._load_config(self.glb.connConfig)
        self._init_whisper(self.config)
        _active = self

    def endGlobal(self):
        """Release model resources."""
        global _active

        if getattr(self, '_whisper', None) and hasattr(self._whisper, 'disconnect'):
            try:
                self._whisper.disconnect()
            except Exception:
                pass
        self._whisper = None
        if _active is self:
            _active = None

    def ensure_initialized(self, conn_config: Dict[str, Any]) -> None:
        """
        Initialize Whisper when beginGlobal was not run (endpoint-only startup).

        Args:
            conn_config: Endpoint service configuration dictionary.
        """
        if getattr(self, '_whisper', None) is not None:
            return

        import os
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        self.transcribe_lock = threading.Lock()
        self.config = self._load_config(conn_config)
        self._init_whisper(self.config)

        global _active
        _active = self
