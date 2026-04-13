# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
import os
import tempfile
import wave
from typing import Any, Dict, Optional

import numpy as np

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config
from ai.common.models.base import ModelClient, get_model_server_address


_KOKORO_REPO_ID = 'hexgrad/Kokoro-82M'
_KOKORO_LOADER_TYPE = 'kokoro'
_KOKORO_SAMPLE_RATE = 24000
_INT16_MAX = 32767
_WAV_MIME = 'audio/wav'


class IGlobal(IGlobalBase):
    _voice: str
    _lang: str
    _pipeline: Optional[Any] = None
    _remote_client: Optional[Any] = None

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        voice = str(cfg.get('kokoro_voice') or '').strip()
        if not voice:
            raise Exception('Kokoro: choose a voice from the list')
        self._voice = voice
        self._lang = voice[0]

        from depends import depends  # type: ignore

        depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

        addr = get_model_server_address()
        if addr:
            host, port = addr
            self._remote_client = ModelClient(port, host)
            self._remote_client.load_model(
                _KOKORO_REPO_ID,
                _KOKORO_LOADER_TYPE,
                {'lang_code': self._lang, 'repo_id': _KOKORO_REPO_ID},
            )
        else:
            self._ensure_spacy_en_model()
            from kokoro import KPipeline

            self._pipeline = KPipeline(lang_code=self._lang)

    @staticmethod
    def _ensure_spacy_en_model() -> None:
        """Install ``en_core_web_sm`` matching the installed spaCy version (GitHub wheel)."""
        try:
            import en_core_web_sm  # noqa: F401
            return
        except ImportError:
            pass
        try:
            import spacy
        except ImportError:
            return
        import subprocess
        import sys

        major, minor = spacy.__version__.split('.')[:2]
        model_ver = f'{major}.{minor}.0'
        url = f'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-{model_ver}/en_core_web_sm-{model_ver}-py3-none-any.whl'
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', url],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def synthesize(self, text: str) -> Dict[str, Any]:
        fd, out_path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.close(fd)
        try:
            if self._remote_client is not None:
                body = self._remote_client.send_command(
                    'inference',
                    {
                        'inputs': [{'text': text, 'voice': self._voice, 'speed': 1}],
                        'output_fields': ['wav_base64'],
                    },
                )
                rows = body.get('result') or []
                if not rows:
                    raise ValueError('Kokoro model server returned no result')
                wav_bytes = base64.b64decode(rows[0]['wav_base64'])
                with open(out_path, 'wb') as f:
                    f.write(wav_bytes)
            else:
                chunks: list[np.ndarray] = []
                for _gs, _ps, audio in self._pipeline(text, voice=self._voice, speed=1):
                    arr = np.asarray(audio, dtype=np.float32)
                    if arr.size == 0:
                        continue
                    if arr.ndim > 1:
                        arr = arr.reshape(-1)
                    chunks.append(arr)
                if not chunks:
                    raise ValueError('Kokoro returned no audio samples')
                audio_arr = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
                audio_arr = np.clip(audio_arr, -1.0, 1.0)
                with wave.open(out_path, 'wb') as wavf:
                    wavf.setnchannels(1)
                    wavf.setsampwidth(2)
                    wavf.setframerate(_KOKORO_SAMPLE_RATE)
                    wavf.writeframes((audio_arr * _INT16_MAX).astype(np.int16).tobytes())
            return {'path': out_path, 'mime_type': _WAV_MIME}
        except Exception:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise

    def endGlobal(self):
        self._pipeline = None
        client = self._remote_client
        if client is not None:
            try:
                client.disconnect()
            except Exception:
                pass
            self._remote_client = None
