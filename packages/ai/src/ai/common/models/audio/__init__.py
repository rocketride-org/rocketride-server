"""
Audio model loaders and user-facing APIs.

Currently includes:
- Whisper (transcription via faster-whisper)
- Piper TTS (ONNX via ``piper.PiperVoice`` / ``piper-tts``, in-process, model-server CPU worker)
- Kokoro TTS (Kokoro-82M via ``kokoro.KPipeline``, model-server GPU/CPU)
"""

from .cloud_tts_loader import ElevenLabsTTSLoader, OpenAITTSLoader
from .kokoro_loader import KokoroLoader
from .piper_loader import PiperLoader
from .whisper import Whisper, WhisperLoader

__all__ = [
    'ElevenLabsTTSLoader',
    'OpenAITTSLoader',
    'KokoroLoader',
    'PiperLoader',
    'Whisper',
    'WhisperLoader',
]
