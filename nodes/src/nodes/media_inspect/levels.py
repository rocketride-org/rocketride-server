# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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

"""
What an interval of a recording SOUNDS and LOOKS like, measured rather than
guessed: where it falls silent, how loud it is moment to moment, and where the
picture cuts to a different shot.

Three measurements, one decode each:

  silences  ffmpeg's `silencedetect` at `silence_db` for at least `silence_ms`
            — the intervals where nothing above the threshold happens.
  peaks     one RMS value per `peak_ms`, normalised to the loudest bucket of
            the interval (0..1), from a mono 16 kHz decode. A waveform to draw
            and a level to test a candidate cut against: a gap in an alignment
            is only really a pause when the waveform agrees with it.
  scenes    the timestamps where ffmpeg's scene score crosses
            `scene_threshold` on a downscaled decode of the picture.

and one measurement that decodes only what it is asked about:

  ranges    the RMS level (dBFS) of each named window — one short decode per
            window, no full-file pass. Asked for on its own (`scan: no`) it is
            the cheap way to compare the loudness either side of a candidate
            join; asked for beside the three above it rides the same run.

Every time in the answer is on the SOURCE clock: the scan seeks to the start of
the range, and the range's own offset is added back before anything is
reported. An interval with no picture reports no scenes and one with no sound
reports no silences and no peaks; that is an answer, not a failure.

Pure ffmpeg and the standard library — the same toolchain the rest of the node
runs on, no extra dependency.
"""

from __future__ import annotations
import array
import math
import wave
from pathlib import Path
from .measure import detect_scenes, detect_silences, rms_level
from ._support.media import run_ffmpeg

ANALYSIS_RATE = 16000  # mono analysis wav (what the level scan wants anyway)
PEAK_MS = 100  # one waveform peak per 100 ms
SILENCE_DB = -40.0  # below this is "nothing is happening"
SILENCE_MS = 700  # ...for at least this long, to be worth reporting
SCENE_THRESHOLD = 0.35  # ffmpeg scene score of a shot change
SCENE_SCALE_WIDTH = 320  # the scene score is measured on a small decode


def analysis_wav(
    src: str | Path, out_path: str | Path, start_ms: int = 0, end_ms: int = 0, sample_rate: int = ANALYSIS_RATE
) -> Path:
    """One mono decode of an interval — shared by the silence scan and the waveform."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    args = ['-y']
    if start_ms:
        args += ['-ss', f'{start_ms / 1000:.3f}']
    if end_ms > start_ms:
        args += ['-t', f'{(end_ms - start_ms) / 1000:.3f}']
    args += ['-i', str(src), '-vn', '-ac', '1', '-ar', str(int(sample_rate)), '-c:a', 'pcm_s16le', str(out_path)]
    run_ffmpeg(args)
    return out_path


def _rms(samples) -> float:
    if not len(samples):
        return 0.0
    try:
        import numpy as np

        block = (
            np.frombuffer(samples, dtype='<i2').astype('float32')
            if isinstance(samples, (bytes, bytearray))
            else np.asarray(samples, dtype='float32')
        )
        return float(math.sqrt(float((block * block).mean()))) / 32768.0
    except Exception:  # noqa: BLE001 - numpy is optional, the pure path is fine
        total = 0
        for s in samples:
            total += s * s
        return math.sqrt(total / len(samples)) / 32768.0


def peaks_from_wav(path: str | Path, bucket_ms: int = PEAK_MS) -> list[float]:
    """One RMS value per `bucket_ms`, normalised to the loudest bucket (0..1)."""
    with wave.open(str(path), 'rb') as wf:
        if wf.getsampwidth() != 2:
            return []
        rate, channels = wf.getframerate(), wf.getnchannels()
        per_bucket = max(1, rate * bucket_ms // 1000)
        raw: list[float] = []
        while True:
            frames = wf.readframes(per_bucket)
            if not frames:
                break
            block = array.array('h')
            block.frombytes(frames[: (len(frames) // 2) * 2])
            if channels > 1:
                block = array.array('h', block[::channels])
            raw.append(_rms(block))
    top = max(raw) if raw else 0.0
    if top <= 0:
        return [0.0 for _ in raw]
    return [round(min(1.0, v / top), 4) for v in raw]


def measure_ranges(src: str | Path, ranges) -> list[dict]:
    """
    The RMS level (dBFS) of each window, in the order they were asked for.

    One short decode per window — the level of the window ITSELF, not of a
    bucket it happens to fall in — so a caller can ask about a handful of
    candidate joins in a long recording without decoding any of the rest of
    it. A window that cannot be measured (past the end of the sound, or no
    sound at all) reports `None` rather than a number nobody measured.
    """
    out: list[dict] = []
    for row in ranges or []:
        start, end = int(row[0]), int(row[1])
        level = rms_level(src, start, max(1, end - start)) if end > start else None
        out.append({'start': start, 'end': end, 'rms_db': level})
    return out


def scan_levels(
    local: str | Path,
    work: str | Path,
    *,
    start_ms: int = 0,
    end_ms: int = 0,
    silence_db: float = SILENCE_DB,
    silence_ms: int = SILENCE_MS,
    peak_ms: int = PEAK_MS,
    scene_threshold: float = SCENE_THRESHOLD,
    has_video: bool = True,
    has_audio: bool = True,
    scene_scale_width: int = SCENE_SCALE_WIDTH,
    scan: bool = True,
    scan_scenes: bool = True,
) -> dict:
    """
    The three measurements over one interval, on the source's own clock.

    `silences` and `scenes` are absolute milliseconds; `peaks[i]` covers
    `start_ms + i * peak_ms` to `start_ms + (i + 1) * peak_ms`, so a reader
    needs the range and the bucket length and nothing else to place them.

    `scan=False` answers the same shape with nothing measured and decodes
    NOTHING: it is how a caller that only wants `measure_ranges` avoids the
    full-file pass (the scene detector alone is about a minute per ten
    minutes of picture).
    """
    start_ms = max(0, int(start_ms or 0))
    end_ms = int(end_ms or 0)
    peak_ms = max(10, int(peak_ms or PEAK_MS))
    # `has_audio` / `has_video` describe the FILE and are reported as such;
    # what is measured is that and the caller's `scan`
    scan_audio = bool(has_audio) and bool(scan)
    scan_video = bool(has_video) and bool(scan) and bool(scan_scenes)
    measured: list = []
    peaks: list = []
    if scan_audio:
        wav = analysis_wav(local, Path(work) / 'levels.wav', start_ms, end_ms)
        try:
            # keep_pause_ms=0: the raw silence, not the part of it that would be
            # safe to cut — what to leave of a pause is the caller's decision
            measured = detect_silences(
                wav, threshold_db=float(silence_db), min_silence_ms=int(silence_ms), keep_pause_ms=0
            )
            peaks = peaks_from_wav(wav, peak_ms)
        finally:
            Path(wav).unlink(missing_ok=True)
    scenes = (
        detect_scenes(local, float(scene_threshold), scene_scale_width, start_ms=start_ms, end_ms=end_ms)
        if scan_video
        else []
    )
    return {
        'range': [start_ms, end_ms] if end_ms > start_ms else [start_ms, start_ms + len(peaks) * peak_ms],
        'silences': [[start_ms + int(a), start_ms + int(b)] for a, b in measured],
        'peaks': peaks,
        'peak_ms': peak_ms,
        'scenes': [int(ms) for ms in scenes],
        'scenes_measured': scan_video,
        'silence_db': float(silence_db),
        'silence_ms': int(silence_ms),
        'scene_threshold': float(scene_threshold),
        'has_video': bool(has_video),
        'has_audio': bool(has_audio),
    }
