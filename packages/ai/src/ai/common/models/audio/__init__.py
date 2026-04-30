"""
Audio model loaders and user-facing APIs.

Currently includes:
- Whisper (transcription via faster-whisper)
- Kokoro TTS (Kokoro-82M via ``kokoro.KPipeline``, model-server GPU/CPU)

Future:
- Speech-to-text models
- Audio classification
- Speaker diarization
"""

from .kokoro_loader import KokoroLoader
from .whisper import Whisper, WhisperLoader

__all__ = [
    'KokoroLoader',
    'Whisper',
    'WhisperLoader',
]
