# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
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
    """Return the MIME type string corresponding to the given output format."""
    if output_format == 'mp3':
        return 'audio/mpeg'
    return 'audio/wav'


class TTSEngine:
    def __init__(self, config: Dict[str, Any]):
        """Initialize TTS engine wrapper with normalized node configuration."""
        self.config = config
        self._piper_remote_client: Optional[Any] = None
        self._kokoro_remote_client: Optional[Any] = None
        self._hf_pipeline: Optional[Any] = None
        self._hf_pipeline_key: Optional[tuple] = None
        self._piper_voice: Optional[Any] = None
        self._piper_voice_onnx: Optional[str] = None
        self._kokoro_pipeline: Optional[Any] = None
        self._kokoro_cache_lang: Optional[str] = None

    def _dispose_hf_pipeline(self) -> None:
        """Disconnect and release the cached HuggingFace pipeline client, if any."""
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
        """Release all cached models, pipelines, and remote clients held by this engine."""
        self._dispose_hf_pipeline()
        self._piper_voice = None
        self._piper_voice_onnx = None
        self._kokoro_pipeline = None
        self._kokoro_cache_lang = None
        for client in (self._piper_remote_client, self._kokoro_remote_client):
            if client is not None:
                try:
                    client.disconnect()
                except Exception:
                    pass
        self._piper_remote_client = None
        self._kokoro_remote_client = None

    def synthesize(self, text: str) -> Dict[str, Any]:
        """Dispatch synthesis to the configured TTS engine and return a path/mime_type dict."""
        engine = str(self.config.get('engine', 'piper') or 'piper').lower().strip()
        if engine == 'piper':
            return self._piper(text)
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
        """Return the ffmpeg binary path, preferring imageio-ffmpeg when available."""
        fb = str(self.config.get('ffmpeg_bin', '') or 'ffmpeg')
        if fb != 'ffmpeg':
            return fb
        try:
            import imageio_ffmpeg

            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return 'ffmpeg'

    def _transcode_wav_to_mp3(self, wav_path: str, mp3_path: str):
        """Convert a WAV file to MP3 using lameenc or ffmpeg as fallback."""
        if try_wav_to_mp3_lameenc(wav_path, mp3_path):
            return
        ffmpeg_bin = self._ffmpeg_executable()
        cmd = [ffmpeg_bin, '-y', '-i', wav_path, '-vn', '-acodec', 'libmp3lame', mp3_path]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError as e:
            raise RuntimeError(f'MP3 output needs ``lameenc`` (see node ``requirements.txt``) or ffmpeg ({ffmpeg_bin!r}). Install ``lameenc`` via depends(), or ffmpeg (e.g. brew install ffmpeg), or rely on ``imageio-ffmpeg`` when packaged with the engine.') from e

    def _save_mono_float_audio(self, audio_arr: np.ndarray, sampling_rate: int, out_path: str, output_format: str) -> None:
        """Write mono float32 [-1,1] samples to WAV or MP3 (via temp WAV + transcoding)."""
        output_format = output_format.lower()
        audio_arr = np.clip(np.asarray(audio_arr, dtype=np.float32), -1.0, 1.0)
        if audio_arr.size == 0:
            raise ValueError('TTS returned empty audio')
        wav_path = out_path
        if output_format == 'mp3':
            fd, wav_path = tempfile.mkstemp(suffix='.wav')
            os.close(fd)
        try:
            with wave.open(wav_path, 'wb') as wavf:
                wavf.setnchannels(1)
                wavf.setsampwidth(2)
                wavf.setframerate(int(sampling_rate))
                wavf.writeframes((audio_arr * 32767).astype(np.int16).tobytes())
            if output_format == 'mp3':
                self._transcode_wav_to_mp3(wav_path, out_path)
        finally:
            if output_format == 'mp3' and wav_path != out_path:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

    def _transformers_tts(self, text: str, model_default: str) -> Dict[str, Any]:
        """Run TTS inference via a HuggingFace transformers pipeline and save the output."""
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

        self._save_mono_float_audio(audio_arr, sampling_rate, out_path, output_format)

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _ensure_kokoro_remote_client(self) -> None:
        """Connect to the Kokoro model server, loading the model if not already done."""
        if self._kokoro_remote_client is not None:
            return
        from ai.common.models.base import ModelClient, get_model_server_address

        addr = get_model_server_address()
        if not addr:
            raise RuntimeError('Kokoro model server mode requires --modelserver')
        host, port = addr
        lang = str(self.config.get('kokoro_lang_code', 'a') or 'a').strip()
        client = ModelClient(port, host)
        client.load_model(
            'hexgrad/Kokoro-82M',
            'kokoro',
            {
                'lang_code': lang,
                'repo_id': 'hexgrad/Kokoro-82M',
            },
        )
        self._kokoro_remote_client = client

    def _kokoro(self, text: str) -> Dict[str, Any]:
        """Kokoro-82M via the ``kokoro`` PyPI package (not HuggingFace ``transformers`` AutoModel)."""
        voice = str(self.config.get('kokoro_voice', 'af_heart') or 'af_heart').strip()
        out_path = self.config.get('output_path')
        output_format = str(self.config.get('output_format', 'wav')).lower()
        sampling_rate = 24000

        if self.config.get('kokoro_use_model_server'):
            self._ensure_kokoro_remote_client()
            body = self._kokoro_remote_client.send_command(
                'inference',
                {
                    'inputs': [{'text': text, 'voice': voice, 'speed': 1}],
                    'output_fields': ['wav_base64', 'mime_type'],
                },
            )
            rows = body.get('result') or []
            if not rows:
                raise ValueError('Kokoro model server returned no result')
            row = rows[0]
            wav_bytes = base64.b64decode(row['wav_base64'])
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

        try:
            from kokoro import KPipeline
        except ImportError as e:
            raise RuntimeError('Kokoro requires ``kokoro`` (and usually ``soundfile``). Install ``nodes/audio_tts/requirements.txt`` via depends(). For some languages you may need extra misaki extras (see Kokoro docs).') from e

        lang = str(self.config.get('kokoro_lang_code', 'a') or 'a').strip()

        if self._kokoro_pipeline is None or self._kokoro_cache_lang != lang:
            self._kokoro_pipeline = KPipeline(lang_code=lang)
            self._kokoro_cache_lang = lang

        chunks: list[np.ndarray] = []
        for _gs, _ps, audio in self._kokoro_pipeline(text, voice=voice, speed=1):
            arr = np.asarray(audio, dtype=np.float32)
            if arr.size == 0:
                continue
            if arr.ndim > 1:
                arr = arr.reshape(-1)
            chunks.append(arr)

        if not chunks:
            raise ValueError('Kokoro returned no audio samples')
        audio_arr = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

        self._save_mono_float_audio(audio_arr, sampling_rate, out_path, output_format)

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _bark(self, text: str) -> Dict[str, Any]:
        """Synthesize speech with the Bark model via the transformers pipeline."""
        return self._transformers_tts(text, model_default='suno/bark-small')

    def _ensure_piper_remote_client(self) -> None:
        """Connect to the Piper model server and load the configured voice preset."""
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
        """Synthesize speech with Piper, using model server or local ONNX voice."""
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
        try:
            if self._piper_voice_onnx != model:
                self._piper_voice = load_piper_voice(model)
                self._piper_voice_onnx = model
            write_piper_wav(self._piper_voice, text, wav_path)
            if output_format == 'mp3':
                self._transcode_wav_to_mp3(wav_path, out_path)
        finally:
            if output_format == 'mp3' and wav_path != out_path:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _api_key_openai(self) -> str:
        """Return the OpenAI API key from config or the OPENAI_API_KEY environment variable."""
        k = (self.config.get('api_key') or '').strip()
        if k:
            return k
        return (os.environ.get('OPENAI_API_KEY') or '').strip()

    def _api_key_elevenlabs(self) -> str:
        """Return the ElevenLabs API key from config or the ELEVENLABS_API_KEY environment variable."""
        k = (self.config.get('api_key') or '').strip()
        if k:
            return k
        return (os.environ.get('ELEVENLABS_API_KEY') or '').strip()

    def _elevenlabs(self, text: str) -> Dict[str, Any]:
        """Synthesize speech via the ElevenLabs API and save the result."""
        api_key = self._api_key_elevenlabs()
        voice = self.config.get('voice', 'Rachel')
        model = self.config.get('model', 'eleven_multilingual_v2')
        output_format = str(self.config.get('output_format', 'mp3')).lower()
        out_path = self.config.get('output_path')

        if not api_key:
            raise ValueError('ElevenLabs requires "api_key" (node config or ELEVENLABS_API_KEY)')

        url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice}'
        payload = {'text': text, 'model_id': model}
        headers = {'xi-api-key': api_key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'}
        response = requests.post(url, json=payload, headers=headers, timeout=120)
        response.raise_for_status()

        with open(out_path, 'wb') as fout:
            fout.write(response.content)

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _openai(self, text: str) -> Dict[str, Any]:
        """Synthesize speech via the OpenAI TTS API and save the result."""
        api_key = self._api_key_openai()
        voice = self.config.get('voice', 'alloy')
        model = self.config.get('model', 'gpt-4o-mini-tts')
        output_format = str(self.config.get('output_format', 'mp3')).lower()
        out_path = self.config.get('output_path')

        if not api_key:
            raise ValueError('OpenAI TTS requires "api_key" (node config or OPENAI_API_KEY)')

        url = 'https://api.openai.com/v1/audio/speech'
        payload = {'model': model, 'voice': voice, 'input': text, 'response_format': output_format}
        headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
        response = requests.post(url, json=payload, headers=headers, timeout=120)
        response.raise_for_status()

        with open(out_path, 'wb') as fout:
            fout.write(response.content)

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}
