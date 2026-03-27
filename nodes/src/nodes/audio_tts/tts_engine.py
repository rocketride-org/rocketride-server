# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import subprocess
import tempfile
import wave
from typing import Dict, Any

import numpy as np
import requests


def _mime_from_format(output_format: str) -> str:
    if output_format == 'mp3':
        return 'audio/mpeg'
    return 'audio/wav'


class TTSEngine:
    def __init__(self, config: Dict[str, Any]):
        """Initialize TTS engine wrapper with normalized node configuration."""
        self.config = config

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

    def _transcode_wav_to_mp3(self, wav_path: str, mp3_path: str):
        ffmpeg_bin = self.config.get('ffmpeg_bin', 'ffmpeg')
        cmd = [ffmpeg_bin, '-y', '-i', wav_path, '-vn', '-acodec', 'libmp3lame', mp3_path]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _transformers_tts(self, text: str, model_default: str) -> Dict[str, Any]:
        from ai.common.models.transformers import pipeline as rr_pipeline

        model = self.config.get('model') or model_default
        out_path = self.config.get('output_path')
        use_model_server = bool(self.config.get('use_model_server', False))
        output_format = str(self.config.get('output_format', 'wav')).lower()
        device = 'server' if use_model_server else None

        pipe = rr_pipeline(
            task='text-to-audio',
            model=model,
            output_fields=['audio', 'sampling_rate', 'output'],
            device=device,
        )
        result = pipe(text)
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

    def _piper(self, text: str) -> Dict[str, Any]:
        piper_bin = self.config.get('piper_bin', 'piper')
        model = self.config.get('voice_model', '')
        out_path = self.config.get('output_path')
        output_format = str(self.config.get('output_format', 'wav')).lower()

        if not model:
            raise ValueError('Piper requires "voice_model" to point to a .onnx voice model file')

        wav_path = out_path
        if output_format == 'mp3':
            fd, wav_path = tempfile.mkstemp(suffix='.wav')
            os.close(fd)

        cmd = [piper_bin, '--model', model, '--output_file', wav_path]
        subprocess.run(cmd, input=text.encode('utf-8'), check=True)

        if output_format == 'mp3':
            self._transcode_wav_to_mp3(wav_path, out_path)
            try:
                os.remove(wav_path)
            except OSError:
                pass

        return {'path': out_path, 'mime_type': _mime_from_format(output_format)}

    def _elevenlabs(self, text: str) -> Dict[str, Any]:
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
