"""
Audio model loaders and user-facing APIs.

Currently includes:
- Whisper (transcription via faster-whisper)

Future:
- Speech-to-text models
- Audio classification
- Speaker diarization
"""

from .whisper import Whisper, WhisperLoader

__all__ = [
    'Whisper',
    'WhisperLoader',
]
