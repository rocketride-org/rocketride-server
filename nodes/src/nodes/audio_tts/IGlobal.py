# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
import io
import os
import wave
from typing import Any, Iterator, Optional

import numpy as np

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config
from ai.common.models.base import ModelClient, get_model_server_address


_KOKORO_REPO_ID = 'hexgrad/Kokoro-82M'
_KOKORO_LOADER_TYPE = 'kokoro'
_KOKORO_SAMPLE_RATE = 24000
_INT16_MAX = 32767

# MP3, not WAV: a WAV header declares the total length up front, which a stream
# does not know, and no browser can play WAV progressively. MP3 frames are
# self-contained, so a listener hears the first one while the rest is still being
# synthesised. Matches the cloud_tts node, which already emits audio/mpeg.
MP3_MIME = 'audio/mpeg'
_MP3_BITRATE = 128
_MP3_QUALITY = 2


class IGlobal(IGlobalBase):
    """Kokoro-only TTS node global state.

    Holds either a local ``KPipeline`` (when no model server is configured) or a
    ``ModelClient`` bound to a remote Kokoro loader. The local path needs the
    ``kokoro``/``soundfile`` wheels and the ``en_core_web_sm`` spaCy model; the
    remote path only needs the base client libraries.
    """

    _voice: str
    _lang: str
    _pipeline: Optional[Any] = None
    _remote_client: Optional[Any] = None

    def beginGlobal(self):
        """Initialise local pipeline or remote client from the node configuration.

        No-op when the endpoint is opened in ``CONFIG`` mode (the UI only needs
        the schema). Otherwise validates that a voice is configured, then either
        connects to the model server — skipping the heavy local dependency
        install — or installs the local requirements and constructs a
        ``KPipeline``.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        voice = str(cfg.get('kokoro_voice') or '').strip()
        if not voice:
            raise Exception('Kokoro: choose a voice from the list')
        self._voice = voice
        self._lang = voice[0]

        addr = get_model_server_address()
        from depends import depends  # type: ignore

        _here = os.path.dirname(os.path.realpath(__file__))
        # The PCM->MP3 encode runs in-process in both modes (only synthesis is offloaded),
        # so lameenc must install on both paths — not only in the local else-branch below.
        depends(os.path.join(_here, 'requirements-encoder.txt'))
        if addr:
            self._remote_client = ModelClient(addr)
            self._remote_client.load_model(
                _KOKORO_REPO_ID,
                _KOKORO_LOADER_TYPE,
                {'lang_code': self._lang, 'repo_id': _KOKORO_REPO_ID},
            )
        else:
            depends(os.path.join(_here, 'requirements.txt'))

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

    def _encoder(self):
        """A fresh LAME encoder for one utterance, configured for Kokoro's output."""
        import lameenc

        encoder = lameenc.Encoder()
        encoder.set_bit_rate(_MP3_BITRATE)
        encoder.set_in_sample_rate(_KOKORO_SAMPLE_RATE)
        encoder.set_channels(1)
        encoder.set_quality(_MP3_QUALITY)
        return encoder

    @staticmethod
    def _to_pcm16(audio) -> bytes:
        """One Kokoro chunk (float samples, torch or numpy) as little-endian int16."""
        if hasattr(audio, 'detach'):
            arr = audio.detach().cpu().numpy().astype(np.float32)
        else:
            arr = np.asarray(audio, dtype=np.float32)
        if arr.size == 0:
            return b''
        if arr.ndim > 1:
            arr = arr.reshape(-1)
        return (np.clip(arr, -1.0, 1.0) * _INT16_MAX).astype(np.int16).tobytes()

    def _pcm_chunks(self, text: str) -> Iterator[bytes]:
        """Yield PCM as the model produces it: the local pipeline is a generator.
        The remote model server has no streaming endpoint and yields its WAV once.
        """
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
            with wave.open(io.BytesIO(base64.b64decode(rows[0]['wav_base64'])), 'rb') as wav:
                # The encoder is fixed to _KOKORO_SAMPLE_RATE / mono / 16-bit; a model server
                # that returns any other format would feed LAME mismatched bytes (wrong-pitch
                # audio or noise, silently). Fail loudly instead.
                fmt = (wav.getframerate(), wav.getnchannels(), wav.getsampwidth())
                if fmt != (_KOKORO_SAMPLE_RATE, 1, 2):
                    raise ValueError(
                        f'Kokoro model server WAV is {fmt[0]}Hz/{fmt[1]}ch/{fmt[2] * 8}-bit; '
                        f'the MP3 encoder expects {_KOKORO_SAMPLE_RATE}Hz mono 16-bit'
                    )
                yield wav.readframes(wav.getnframes())
            return

        produced = False
        for _gs, _ps, audio in self._pipeline(text, voice=self._voice, speed=1):
            if audio is None:
                continue
            if pcm := self._to_pcm16(audio):
                produced = True
                yield pcm
        if not produced:
            raise ValueError('Kokoro returned no audio samples')

    def synthesize_stream(self, text: str) -> Iterator[bytes]:
        """Synthesise ``text``, yielding MP3 frames as they are encoded.
        Nothing is buffered whole; the final flush() drains the encoder's last frame.
        """
        encoder = self._encoder()
        for pcm in self._pcm_chunks(text):
            if frames := bytes(encoder.encode(pcm)):
                yield frames
        if tail := bytes(encoder.flush()):
            yield tail

    def endGlobal(self):
        """Release the local pipeline and disconnect the remote client, if any."""
        self._pipeline = None
        client = self._remote_client
        if client is not None:
            try:
                client.disconnect()
            except Exception:
                pass
            self._remote_client = None
