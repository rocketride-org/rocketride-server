"""
Audio model loaders and user-facing APIs.

Currently includes:
- Whisper (transcription via faster-whisper)
- Piper TTS (ONNX via ``piper.PiperVoice`` / ``piper-tts``, in-process, model-server CPU worker)
"""

from .cloud_tts_loader import ElevenLabsTTSLoader, OpenAITTSLoader
from .piper_loader import PiperLoader
from .whisper import Whisper, WhisperLoader

__all__ = [
    'ElevenLabsTTSLoader',
    'OpenAITTSLoader',
    'PiperLoader',
    'Whisper',
    'WhisperLoader',
]
