# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""In-process Piper synthesis via ``piper.PiperVoice`` (no subprocess)."""

from __future__ import annotations

import wave
from typing import Any


def load_piper_voice(onnx_path: str) -> Any:
    """Load ONNX + JSON config from ``piper-tts`` (same process as the engine)."""
    try:
        from piper import PiperVoice
    except ImportError as e:
        raise RuntimeError('Package ``piper-tts`` is required for Piper TTS. Install node requirements (e.g. ``nodes/audio_tts/requirements.txt`` / ``requirements_piper.txt`` on the model server).') from e
    return PiperVoice.load(onnx_path)


def write_piper_wav(voice: Any, text: str, wav_path: str) -> None:
    """Synthesize ``text`` to a 16-bit mono WAV file using a loaded ``PiperVoice``."""
    with wave.open(wav_path, 'wb') as wav_file:
        voice.synthesize_wav(text, wav_file)
