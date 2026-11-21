# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Global handler for the Kokoro text-to-speech node.

The voice is a per-call parameter. A Kokoro pipeline is built for one
language (the first letter of the voice) and takes the voice per synthesis,
so the control keeps one engine per language a call has asked for: a local
``KPipeline`` from the module-scope loader cache, or a model-server client
bound to that language's loader. The voice list names nine languages, which
bounds the cache.
"""

import base64
import os
import tempfile
import threading
import wave
from typing import Any, Dict

import numpy as np

from rocketlib import IGlobalBase
from ai.common.models.base import ModelClient, get_model_server_address
from ai.common.utils import LoaderCache


_KOKORO_REPO_ID = 'hexgrad/Kokoro-82M'
_KOKORO_LOADER_TYPE = 'kokoro'
_KOKORO_SAMPLE_RATE = 24000
_INT16_MAX = 32767
_WAV_MIME = 'audio/wav'

#: The local Kokoro pipelines the controls of this engine share, keyed by
#: (repo, language): the weights depend on nothing else; the voice is per call.
#: The last control to release one frees it.
_PIPELINES = LoaderCache()


class IGlobal(IGlobalBase):
    """Kokoro-only TTS node global state.

    Holds, per language a call has asked for, either a local ``KPipeline``
    (when no model server is configured) or a ``ModelClient`` bound to a remote
    Kokoro loader. The local path needs the ``kokoro``/``soundfile`` wheels and
    the ``en_core_web_sm`` spaCy model; the remote path only needs the base
    client libraries.
    """

    def beginGlobal(self):
        """Choose local or remote synthesis; the engines are built per language on first use.

        With a model server the heavy local dependency install is skipped;
        without one the local requirements are installed here, once.
        """
        self._lock = threading.Lock()
        self._address = get_model_server_address()
        self._pipelines: Dict[str, Any] = {}
        self._clients: Dict[str, Any] = {}

        if not self._address:
            from depends import depends  # type: ignore

            depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

    def _pipeline_for(self, lang: str) -> Any:
        """
        The local ``KPipeline`` of one language, acquired from the loader cache on first use.

        Args:
            lang: The Kokoro language code (the first letter of the voice).

        Returns:
            The pipeline; the voice is passed per synthesis.
        """
        with self._lock:
            pipeline = self._pipelines.get(lang)
            if pipeline is None:
                pipeline = _PIPELINES.acquire((_KOKORO_REPO_ID, lang), lambda: self._load_pipeline(lang))
                self._pipelines[lang] = pipeline
            return pipeline

    def _client_for(self, lang: str) -> Any:
        """
        The model-server client bound to one language's Kokoro loader, connected on first use.

        Args:
            lang: The Kokoro language code (the first letter of the voice).

        Returns:
            The ``ModelClient``; the voice is sent per inference.
        """
        with self._lock:
            client = self._clients.get(lang)
            if client is None:
                client = ModelClient(self._address)
                client.load_model(_KOKORO_REPO_ID, _KOKORO_LOADER_TYPE, {'lang_code': lang, 'repo_id': _KOKORO_REPO_ID})
                self._clients[lang] = client
            return client

    def _load_pipeline(self, lang: str) -> Any:
        """Build the local ``KPipeline`` for one language (once per process, via the cache)."""
        self._ensure_spacy_en_model()
        from kokoro import KPipeline

        return KPipeline(lang_code=lang)

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

    def synthesize(self, text: str, voice: str) -> Dict[str, Any]:
        """Synthesise ``text`` in one call's voice to a temporary WAV file and return its path.

        Writes a freshly-allocated file under the system temp dir and returns
        ``{'path': <abs path>, 'mime_type': 'audio/wav'}``. The caller owns the
        file and is responsible for deleting it once the bytes have been
        streamed. On any synthesis error the temp file is removed before the
        exception propagates so there are no orphans on disk.

        Args:
            text: The text to speak.
            voice: The call's Kokoro voice (one of the schema's); its first letter is the language.

        Returns:
            The temp file's path and MIME type.
        """
        lang = voice[0]
        fd, out_path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.close(fd)
        try:
            if self._address:
                body = self._client_for(lang).send_command(
                    'inference',
                    {
                        'inputs': [{'text': text, 'voice': voice, 'speed': 1}],
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
                for _gs, _ps, audio in self._pipeline_for(lang)(text, voice=voice, speed=1):
                    if audio is None:
                        continue
                    if hasattr(audio, 'detach'):
                        arr = audio.detach().cpu().numpy().astype(np.float32)
                    else:
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
        """Release every local pipeline to the loader cache and disconnect every remote client."""
        pipelines, self._pipelines = getattr(self, '_pipelines', None) or {}, {}
        for lang in pipelines:
            _PIPELINES.release((_KOKORO_REPO_ID, lang))
        clients, self._clients = getattr(self, '_clients', None) or {}, {}
        for client in clients.values():
            try:
                client.disconnect()
            except Exception:
                pass
        self._lock = None
