# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
import os
import subprocess
import tempfile
import wave
from typing import Any, Dict, Optional

import numpy as np
import requests

from ai.common.models.audio.piper_native import load_piper_voice, write_piper_wav
from ai.common.models.audio.wav_to_mp3 import try_wav_to_mp3_lameenc


def _mime_from_format(output_format: str) -> str:
    if output_format == 'mp3':
        return 'audio/mpeg'
    return 'audio/wav'


class TTSEngine:
    def __init__(self, config: Dict[str, Any]):
        """Initialize TTS engine wrapper with normalized node configuration."""
        self.config = config
        self._piper_remote_client: Optional[Any] = None
        self._openai_remote_client: Optional[Any] = None
        self._elevenlabs_remote_client: Optional[Any] = None
        self._hf_pipeline: Optional[Any] = None
        self._hf_pipeline_key: Optional[tuple] = None
        self._piper_voice: Optional[Any] = None
        self._piper_voice_onnx: Optional[str] = None

    def _dispose_hf_pipeline(self) -> None:
        pipe = self._hf_pipeline
        if pipe is not None:
            client = getattr(pipe, '_client', None)
            if client is not None:
                try:
                    client.disconnect()
                except Exception:
                    pass
            self._hf_pipeline = None
            self._hf_pipeline_key = None

    def dispose(self) -> None:
        self._dispose_hf_pipeline()
        self._piper_voice = None
        self._piper_voice_onnx = None
        for client in (
            self._piper_remote_client,
            self._openai_remote_client,
            self._elevenlabs_remote_client,
        ):
            if client is not None:
                try:
                    client.disconnect()
                except Exception:
                    pass
        self._piper_remote_client = None
        self._openai_remote_client = None
        self._elevenlabs_remote_client = None

    def synthesize(self, text: str) -> Dict[str, Any]:
        engine = str(self.config.get('engine', 'piper')).lower()
        if engine == 'piper':
            return self._piper(text)
        if engine == 'coqui':
            return self._coqui(text)
        if engine == 'kokoro':
            return self._kokoro(text)
        if engine in ('bark', 'bak'):
            return self._bark(text)
        if engine == 'elevenlabs':
            return self._elevenlabs(text)
        if engine == 'openai':
            return self._openai(text)
        raise ValueError(f'Unsupported TTS engine: {engine}')

    def _ffmpeg_executable(self) -> str:
        fb = str(self.config.get('ffmpeg_bin', '') or 'ffmpeg')
        if fb != 'ffmpeg':
            return fb
        try:
            import imageio_ffmpeg

            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return 'ffmpeg'

    def _transcode_wav_to_mp3(self, wav_path: str, mp3_path: str):
        if try_wav_to_mp3_lameenc(wav_path, mp3_path):
            return
        ffmpeg_bin = self._ffmpeg_executable()
        cmd = [ffmpeg_bin, '-y', '-i', wav_path, '-vn', '-acodec', 'libmp3lame', mp3_path]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError as e:
            raise RuntimeError(f'MP3 output needs ``lameenc`` (see node ``requirements.txt``) or ffmpeg ({ffmpeg_bin!r}). Install ``lameenc`` via depends(), or ffmpeg (e.g. brew install ffmpeg), or rely on ``imageio-ffmpeg`` when packaged with the engine.') from e

    def _transformers_tts(self, text: str, model_default: str) -> Dict[str, Any]:
        from ai.common.models.transformers import pipeline as rr_pipeline

        model = self.config.get('model') or model_default
        out_path = self.config.get('output_path')
        output_format = str(self.config.get('output_format', 'wav')).lower()
        # device=None: model server when --modelserver is set; else local. Reuse one pipeline
        # per (model, task) so the server load is not repeated on every utterance.
        pipe_key = (model, 'text-to-audio')
        if self._hf_pipeline is None or self._hf_pipeline_key != pipe_key:
            self._dispose_hf_pipeline()
            self._hf_pipeline = rr_pipeline(
                task='text-to-audio',
                model=model,
                output_fields=['audio', 'sampling_rate', 'output'],
                device=None,
            )
            self._hf_pipeline_key = pipe_key
        result = self._hf_pipeline(text)
        if isinstance(result, list) and result:
            result = result[0]
        if not isinstance(result, dict):
            raise ValueError(f'Unexpected TTS pipeline result: {type(result)}')

        # ai.common extractor may return nested payload under "output"
        payload = result.get('output') if isinstance(result.get('output'), dict) else result
        audio = payload.get('audio')
        sampling_rate = int(payload.get('sampling_rate', 24000))
        if audio is None:
            raise ValueError('TTS model did not return audio samples')

        audio_arr = np.asarray(audio, dtype=np.float32)
        if audio_arr.size == 0:
            raise ValueError('TTS model returned empty audio')
        audio_arr = np.clip(audio_arr, -1.0, 1.0)

        wav_path = out_path
        if output_format == 'mp3':
            fd, wav_path = tempfile.mkstemp(suffix='.wav')
            os.close(fd)

        with wave.open(wav_path, 'wb') as wavf:
            wavf.setnchannels(1)
            wavf.setsampwidth(2)
            wavf.setframerate(sampling_rate)
            wavf.writeframes((audio_arr * 32767).astype(np.int16).tobytes())

        if output_format == 'mp3':
            self._transcode_wav_to_mp3(wav_path, out_path)
            try:
                os.remove(wav_path)
            except OSError:
                pass

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _coqui(self, text: str) -> Dict[str, Any]:
        return self._transformers_tts(text, model_default='coqui/XTTS-v2')

    def _kokoro(self, text: str) -> Dict[str, Any]:
        return self._transformers_tts(text, model_default='hexgrad/Kokoro-82M')

    def _bark(self, text: str) -> Dict[str, Any]:
        return self._transformers_tts(text, model_default='suno/bark-small')

    def _ensure_piper_remote_client(self) -> None:
        if self._piper_remote_client is not None:
            return
        from ai.common.models.base import ModelClient, get_model_server_address

        addr = get_model_server_address()
        if not addr:
            raise RuntimeError('Piper model server mode requires --modelserver')
        host, port = addr
        pv = str(self.config.get('piper_voice', '') or '').strip()
        piper_bin = self.config.get('piper_bin', 'piper')
        opts: Dict[str, Any] = {'piper_bin': piper_bin}
        if not pv:
            raise RuntimeError('Piper model server mode requires piper_voice preset')
        opts['piper_voice_key'] = pv
        opts['onnx_path'] = None
        model_name = 'piper'

        client = ModelClient(port, host)
        client.load_model(model_name, 'piper', opts)
        self._piper_remote_client = client

    def _piper(self, text: str) -> Dict[str, Any]:
        if self.config.get('piper_use_model_server'):
            self._ensure_piper_remote_client()
            body = self._piper_remote_client.send_command(
                'inference',
                {
                    'inputs': [text],
                    'output_fields': ['wav_base64', 'mime_type'],
                },
            )
            rows = body.get('result') or []
            if not rows:
                raise ValueError('Piper model server returned no result')
            row = rows[0]
            wav_bytes = base64.b64decode(row['wav_base64'])
            out_path = self.config.get('output_path')
            output_format = str(self.config.get('output_format', 'wav')).lower()
            if output_format == 'mp3':
                fd, wav_path = tempfile.mkstemp(suffix='.wav')
                os.close(fd)
                try:
                    with open(wav_path, 'wb') as f:
                        f.write(wav_bytes)
                    self._transcode_wav_to_mp3(wav_path, out_path)
                finally:
                    try:
                        os.remove(wav_path)
                    except OSError:
                        pass
            else:
                with open(out_path, 'wb') as f:
                    f.write(wav_bytes)
            return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

        model = self.config.get('voice_model', '')
        out_path = self.config.get('output_path')
        output_format = str(self.config.get('output_format', 'wav')).lower()

        if not model:
            raise ValueError('Piper requires a cached voice model path (pick a piper_voice preset)')

        wav_path = out_path
        if output_format == 'mp3':
            fd, wav_path = tempfile.mkstemp(suffix='.wav')
            os.close(fd)

        if self._piper_voice_onnx != model:
            self._piper_voice = load_piper_voice(model)
            self._piper_voice_onnx = model
        write_piper_wav(self._piper_voice, text, wav_path)

        if output_format == 'mp3':
            self._transcode_wav_to_mp3(wav_path, out_path)
            try:
                os.remove(wav_path)
            except OSError:
                pass

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _ensure_openai_remote_client(self) -> None:
        if self._openai_remote_client is not None:
            return
        from ai.common.models.base import ModelClient, get_model_server_address

        addr = get_model_server_address()
        if not addr:
            raise RuntimeError('OpenAI TTS model server mode requires --modelserver')
        host, port = addr
        client = ModelClient(port, host)
        client.load_model(
            self.config.get('model', 'gpt-4o-mini-tts'),
            'openai_tts',
            {
                'api_key': self.config.get('api_key'),
                'voice': self.config.get('voice', 'alloy'),
            },
        )
        self._openai_remote_client = client

    def _ensure_elevenlabs_remote_client(self) -> None:
        if self._elevenlabs_remote_client is not None:
            return
        from ai.common.models.base import ModelClient, get_model_server_address

        addr = get_model_server_address()
        if not addr:
            raise RuntimeError('ElevenLabs TTS model server mode requires --modelserver')
        host, port = addr
        client = ModelClient(port, host)
        client.load_model(
            self.config.get('model', 'eleven_multilingual_v2'),
            'elevenlabs_tts',
            {
                'api_key': self.config.get('api_key'),
                'voice': self.config.get('voice', ''),
            },
        )
        self._elevenlabs_remote_client = client

    def _elevenlabs(self, text: str) -> Dict[str, Any]:
        if self.config.get('elevenlabs_use_model_server'):
            self._ensure_elevenlabs_remote_client()
            output_format = str(self.config.get('output_format', 'mp3')).lower()
            body = self._elevenlabs_remote_client.send_command(
                'inference',
                {
                    'inputs': [{'text': text}],
                    'output_fields': ['audio_base64', 'mime_type'],
                },
            )
            rows = body.get('result') or []
            if not rows:
                raise ValueError('ElevenLabs TTS model server returned no result')
            row = rows[0]
            raw = base64.b64decode(row['audio_base64'])
            out_path = self.config.get('output_path')
            with open(out_path, 'wb') as f:
                f.write(raw)
            return {'path': out_path, 'mime_type': row.get('mime_type') or _mime_from_format(output_format)}

        api_key = self.config.get('api_key', '')
        voice = self.config.get('voice', 'Rachel')
        model = self.config.get('model', 'eleven_multilingual_v2')
        output_format = str(self.config.get('output_format', 'mp3')).lower()
        out_path = self.config.get('output_path')

        if not api_key:
            raise ValueError('ElevenLabs requires "api_key"')

        url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice}'
        payload = {'text': text, 'model_id': model}
        headers = {'xi-api-key': api_key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'}
        response = requests.post(url, json=payload, headers=headers, timeout=120)
        response.raise_for_status()

        with open(out_path, 'wb') as fout:
            fout.write(response.content)

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _openai(self, text: str) -> Dict[str, Any]:
        if self.config.get('openai_use_model_server'):
            self._ensure_openai_remote_client()
            output_format = str(self.config.get('output_format', 'mp3')).lower()
            body = self._openai_remote_client.send_command(
                'inference',
                {
                    'inputs': [{'text': text, 'output_format': output_format}],
                    'output_fields': ['audio_base64', 'mime_type'],
                },
            )
            rows = body.get('result') or []
            if not rows:
                raise ValueError('OpenAI TTS model server returned no result')
            row = rows[0]
            raw = base64.b64decode(row['audio_base64'])
            out_path = self.config.get('output_path')
            with open(out_path, 'wb') as f:
                f.write(raw)
            mime = row.get('mime_type') or _mime_from_format(output_format)
            return {'path': out_path, 'mime_type': mime}

        api_key = self.config.get('api_key', '')
        voice = self.config.get('voice', 'alloy')
        model = self.config.get('model', 'gpt-4o-mini-tts')
        output_format = str(self.config.get('output_format', 'mp3')).lower()
        out_path = self.config.get('output_path')

        if not api_key:
            raise ValueError('OpenAI TTS requires "api_key"')

        url = 'https://api.openai.com/v1/audio/speech'
        payload = {'model': model, 'voice': voice, 'input': text, 'format': output_format}
        headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
        response = requests.post(url, json=payload, headers=headers, timeout=120)
        response.raise_for_status()

        with open(out_path, 'wb') as fout:
            fout.write(response.content)

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}
