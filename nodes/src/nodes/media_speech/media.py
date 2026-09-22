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


"""Media extraction and reference helpers."""

from __future__ import annotations
import json
from pathlib import Path
from ._support.media import run_ffmpeg, probe

MAX_PIECE_SECONDS = 58

MIN_PIECE_SECONDS = 10

PIECE_RATE = 16000  # what speech models want anyway

PIECE_CHANNELS = 1


PIECES_KIND = 'media_pieces'


def clamp_piece_seconds(value, default: int = 45) -> int:
    """Convert seconds to an integer clamped to 10–58; invalid values use default."""
    try:
        seconds = int(float(value))
    except (TypeError, ValueError, OverflowError):
        seconds = int(default)
    return max(MIN_PIECE_SECONDS, min(MAX_PIECE_SECONDS, seconds))


def piece_name(index: int) -> str:
    """Return the stable WAV filename for a zero-based piece index."""
    return f'piece{index:04d}.wav'


def parse_ordinals(value) -> set[int]:
    """Parse JSON arrays or comma-separated non-negative whole piece indices."""
    if value is None or value == '':
        return set()
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return set()
        try:
            values = json.loads(text) if text.startswith('[') else text.replace(';', ',').split(',')
        except ValueError as exc:
            raise ValueError('skip_pieces must be an array of whole indices') from exc
    else:
        values = value
    if not isinstance(values, (list, tuple)):
        raise ValueError('skip_pieces must be an array of whole indices')
    result = set()
    for value in values:
        try:
            number = float(value)
            index = int(number)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError('skip_pieces contains an invalid ordinal') from exc
        if isinstance(value, bool) or index < 0 or number != index:
            raise ValueError('skip_pieces indices must be non-negative whole numbers')
        result.add(index)
    return result


def split_audio(local: Path, work: Path, piece_seconds: int) -> list[dict]:
    """
    Fixed-length mono 16 kHz WAV pieces of a recording with their exact start
    offsets. The offsets are measured (probed) rather than assumed: ffmpeg's
    segmenter cuts on frame boundaries, so a piece is rarely exactly
    `piece_seconds` long and a nominal grid would drift over an hour.
    """
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(
        [
            '-y',
            '-i',
            str(local),
            '-vn',
            '-ac',
            str(PIECE_CHANNELS),
            '-ar',
            str(PIECE_RATE),
            '-c:a',
            'pcm_s16le',
            '-f',
            'segment',
            '-segment_time',
            str(piece_seconds),
            '-reset_timestamps',
            '1',
            str(work / 'piece%04d.wav'),
        ]
    )
    pieces, offset = [], 0
    for index, path in enumerate(sorted(work.glob('piece*.wav'), key=lambda path: int(path.stem[5:]))):
        duration = int(probe(path)['duration_ms'])
        pieces.append({'index': index, 'path': path, 'offset_ms': offset, 'duration_ms': duration})
        offset += duration
    return pieces


def build_reference(
    *,
    source: str,
    mode: str,
    media: dict,
    kind: str = PIECES_KIND,
    context: dict | None = None,
    question: str = '',
    streamed: list[dict] | None = None,
    piece_seconds: int = 0,
    pieces_total: int = 0,
    skipped=None,
) -> dict:
    """
    The JSON the reading modes forward on the text lane. `pieces` are the
    intervals of the SOURCE that were streamed in this run, in stream order:
    stream 0 is
    pieces[0], stream 1 is pieces[1] and so on, so a consumer places a
    timestamp with `pieces[stream_index][0] + in_stream_ms`. `piece_indices`
    says which ordinals of the full grid those are, for a run that skipped
    pieces a previous run already handled.

    `streamed` and `remaining` are the same story as a to-do list: what this
    run handed on, and the ordinals of the grid that have neither been skipped
    nor streamed. A caller reading a long recording a batch at a time adds
    `streamed` to the `skip_pieces:` of its next run and stops when
    `remaining` comes back empty; it never has to keep its own tally.
    """
    streamed = streamed or []
    indices = [int(p['index']) for p in streamed]
    done = set(indices) | {int(i) for i in (skipped or [])}
    ref = {
        'schema_version': 1,
        'kind': str(kind),
        'source': source,
        'mode': mode,
        # display width/height, with the pixel aspect ratio and the coded size
        # beside them so a consumer can rebuild the square-pixel decode (C3)
        'media': {
            **{k: media.get(k) for k in ('duration_ms', 'width', 'height', 'fps', 'has_video', 'has_audio')},
            'sar': float(media.get('sar') or 1.0) or 1.0,
            'coded_width': int(media.get('coded_width') or media.get('width') or 0),
            'coded_height': int(media.get('coded_height') or media.get('height') or 0),
        },
        'duration_ms': int(media.get('duration_ms') or 0),
        'pieces': [[int(p['offset_ms']), int(p['offset_ms']) + int(p['duration_ms'])] for p in streamed],
        'piece_indices': list(indices),
        'streamed': list(indices),
        'remaining': [i for i in range(int(pieces_total)) if i not in done],
        'pieces_total': int(pieces_total),
        'piece_seconds': int(piece_seconds),
        'skipped': sorted(int(i) for i in (skipped or [])),
        'context': dict(context or {}),
        'question': str(question or ''),
    }
    return ref
