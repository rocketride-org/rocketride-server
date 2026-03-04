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

import threading
from types import SimpleNamespace
from typing import Any, List

import numpy as np
from rocketlib import IGlobalBase, debug
from ai.common.config import Config
from ai.common.models import Whisper


class IGlobal(IGlobalBase):
    """
    Global configuration and setup for transcription using the model server.

    Uses ai.common.models.Whisper, which routes to the model server when
    --modelserver is set, otherwise runs locally with faster-whisper.
    """

    def transcribe(self, audio: Any) -> List[SimpleNamespace]:
        """
        Transcribe the given audio using the Whisper model.

        Args:
            audio: PCM int16 bytes (16 kHz mono), or numpy float32 array in [-1, 1].

        Returns:
            List of segment-like objects with .text, .start, .end for downstream use.
        """
        audio_bytes = self._audio_to_pcm_bytes(audio)
        if not audio_bytes:
            return []

        with self.transcribe_lock:
            result = self._whisper.transcribe(
                audio_bytes,
                beam_size=5,
                vad_filter=True,
                vad_parameters={
                    'threshold': self._whisper_threshold,
                    'min_silence_duration_ms': self._whisper_min_silence_duration_ms,
                    'max_speech_duration_s': self._whisper_max_speech_duration_s,
                },
            )

        segments = result.get('$segments') or []
        return [
            SimpleNamespace(text=s.get('text', ''), start=s.get('start', 0.0), end=s.get('end', 0.0))
            for s in segments
        ]

    def _audio_to_pcm_bytes(self, audio: Any) -> bytes:
        """Convert audio (bytes or float32 numpy) to PCM int16 bytes (16 kHz mono)."""
        if isinstance(audio, bytes):
            return audio
        if isinstance(audio, (list, tuple)):
            return bytes(audio)
        try:
            if hasattr(audio, 'tobytes'):
                # numpy array
                arr = np.asarray(audio, dtype=np.float32)
                arr = np.clip(arr, -1.0, 1.0)
                int16_arr = (arr * 32767).astype(np.int16)
                return int16_arr.tobytes()
        except Exception:
            pass
        return b''

    def beginGlobal(self):
        """
        Initialize the global state.

        - Reading configuration values
        - Loading the Whisper model via ai.common.models (model server or local)
        - Preparing a thread-safe lock for transcription
        """
        self.transcribe_lock = threading.Lock()

        config = Config.getNodeConfig(
            self.glb.logicalType,
            self.glb.connConfig,
        )

        self.model_name = config.get('model', 'base')
        language = config.get('language', 'en')
        compute_type = config.get('compute_type', 'float16')

        # ai.common.models.Whisper: uses model server if --modelserver set, else local
        self._whisper = Whisper(
            self.model_name,
            output_fields=['$text', '$segments'],
            language=language,
            compute_type=compute_type,
        )

        self._whisper_threshold = config.get('vad_threshold', 0.5)
        self._whisper_min_silence_duration_ms = config.get('vad_min_silence_duration_ms', 500)
        self._whisper_max_speech_duration_s = config.get('vad_max_speech_duration_s', 20)

        debug(f'    Audio transcribe: model={self.model_name}, language={language}')

    def endGlobal(self):
        """Clean up global state."""
        if getattr(self, '_whisper', None) and hasattr(self._whisper, 'disconnect'):
            try:
                self._whisper.disconnect()
            except Exception:
                pass
        self._whisper = None
