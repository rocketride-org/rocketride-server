# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""WAV → MP3 without a separate ``ffmpeg`` install (``lameenc`` in-process)."""

from __future__ import annotations

import wave


def wav_to_mp3_lameenc(wav_path: str, mp3_path: str, *, bit_rate: int = 128) -> None:
    """
    Encode a PCM WAV to MP3 using LAME via ``lameenc`` (no subprocess).

    Expects 16-bit linear PCM (mono or stereo).
    """
    import lameenc

    with wave.open(wav_path, 'rb') as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise ValueError(f'lameenc path requires 16-bit WAV, got sample width {sampwidth}')
    if nchannels not in (1, 2):
        raise ValueError(f'lameenc path supports 1–2 channels, got {nchannels}')

    enc = lameenc.Encoder()
    enc.set_in_sample_rate(framerate)
    enc.set_channels(nchannels)
    enc.set_bit_rate(bit_rate)
    if hasattr(enc, 'silence'):
        enc.silence()

    mp3 = enc.encode(frames) + enc.flush()
    with open(mp3_path, 'wb') as out:
        out.write(mp3)


def try_wav_to_mp3_lameenc(wav_path: str, mp3_path: str, *, bit_rate: int = 128) -> bool:
    """Return True if ``mp3_path`` was written using ``lameenc``; False to fall back to ffmpeg."""
    try:
        wav_to_mp3_lameenc(wav_path, mp3_path, bit_rate=bit_rate)
        return True
    except Exception:
        return False
