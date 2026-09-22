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


"""Measure audio levels, silence and visual transitions in streamed media."""

from __future__ import annotations
import re
from pathlib import Path
from ._support.media import ffmpeg_exe as ffmpeg_exe, _run_process


_SILENCE_START = re.compile(r'silence_start:\s*([\d.]+)')

_SILENCE_END = re.compile(r'silence_end:\s*([\d.]+)')


def detect_silences(
    wav: str | Path,
    threshold_db: float = -40.0,
    min_silence_ms: int = 800,
    keep_pause_ms: int = 350,
) -> list[tuple[int, int]]:
    """
    Long silences via ffmpeg's silencedetect. Returns the *cuttable* part of
    each silence — a natural pause of keep_pause_ms is left in place so speech
    doesn't sound rushed.
    """
    cmd = [
        ffmpeg_exe(),
        '-hide_banner',
        '-nostdin',
        '-i',
        str(wav),
        '-af',
        f'silencedetect=noise={threshold_db}dB:d={min_silence_ms / 1000:.3f}',
        '-f',
        'null',
        '-',
    ]
    result = _run_process(cmd, check=True)
    starts = [float(m) for m in _SILENCE_START.findall(result.stderr)]
    ends = [float(m) for m in _SILENCE_END.findall(result.stderr)]
    cuttable = []
    pad = max(0, int(keep_pause_ms)) // 2
    floor = max(1, int(min_silence_ms))
    for start, end in zip(starts, ends):
        cut_start = int(start * 1000) + pad
        cut_end = int(end * 1000) - pad
        if cut_end - cut_start >= floor:
            cuttable.append((cut_start, cut_end))
    return cuttable


_RMS_RE = re.compile(r'RMS level dB:\s*(-?[\d.]+|-inf)')


def rms_level(path: str | Path, at_ms: int, window_ms: int = 60) -> float | None:
    """RMS level (dBFS) of a short window starting at at_ms; None when unmeasurable."""
    if at_ms < 0:
        return None
    result = _run_process(
        [
            ffmpeg_exe(),
            '-hide_banner',
            '-nostdin',
            '-ss',
            f'{at_ms / 1000:.3f}',
            '-t',
            f'{window_ms / 1000:.3f}',
            '-i',
            str(path),
            '-af',
            'astats=metadata=0:measure_perchannel=none:measure_overall=RMS_level',
            '-f',
            'null',
            '-',
        ],
        check=True,
    )
    values = _RMS_RE.findall(result.stderr or '')
    if not values:
        return None
    value = values[-1]
    return -120.0 if value == '-inf' else float(value)


_SCENE_PTS = re.compile(r'pts_time:\s*([0-9.]+)')


def detect_scenes(
    path: str | Path, threshold: float = 0.35, scale_width: int = 320, start_ms: int = 0, end_ms: int = 0
) -> list[int]:
    """
    Shot changes (ms) via ffmpeg's scene score on a downscaled decode.

    The whole file by default. `start_ms`/`end_ms` decode only that window —
    the seek is an INPUT seek, so ffmpeg's own timestamps restart at 0 and the
    offset is added back here: every cut this returns is on the file's clock,
    windowed or not.
    """
    start_ms, end_ms = max(0, int(start_ms or 0)), int(end_ms or 0)
    seek = ['-ss', f'{start_ms / 1000:.3f}'] if start_ms else []
    if end_ms > start_ms:
        seek += ['-t', f'{(end_ms - start_ms) / 1000:.3f}']
    result = _run_process(
        [
            ffmpeg_exe(),
            '-hide_banner',
            '-nostdin',
            *seek,
            '-i',
            str(path),
            '-an',
            '-vf',
            f"scale={scale_width}:-2,select='gt(scene,{threshold})',showinfo",
            '-f',
            'null',
            '-',
        ],
        check=True,
    )
    cuts = []
    for line in (result.stderr or '').splitlines():
        if 'Parsed_showinfo' not in line:
            continue
        m = _SCENE_PTS.search(line)
        if m:
            cuts.append(start_ms + int(float(m.group(1)) * 1000))
    return sorted(set(cuts))
