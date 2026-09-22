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


"""Media metadata, FFmpeg execution and source-time range helpers."""

from __future__ import annotations
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

SLICE_RATE = 48000  # a delivery slice keeps the band

SAR_EPSILON = 1e-6  # below this a pixel aspect ratio is square


def ffmpeg_exe() -> str:
    """Return the configured or bundled FFmpeg executable."""
    exe = os.environ.get('MEDIA_TOOLKIT_FFMPEG')
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return 'ffmpeg'


def ffmpeg_timeout() -> float:
    """Bound each encode, with a host-configurable positive finite timeout."""
    import math

    raw = os.environ.get('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT', '3600')
    try:
        timeout = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT must be a positive finite number') from exc
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 86400:
        raise ValueError('ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT must be greater than 0 and at most 86400 seconds')
    return timeout


def _run_process(
    cmd: list[str], *, check: bool, text: bool = True, timeout: float | None = None
) -> subprocess.CompletedProcess:
    timeout = min(timeout, ffmpeg_timeout()) if timeout is not None else ffmpeg_timeout()
    try:
        return subprocess.run(cmd, check=check, capture_output=True, text=text, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f'ffmpeg timed out after {timeout:g} seconds\ncommand: {shlex.join(cmd)}') from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode('utf-8', 'replace') if isinstance(exc.stderr, bytes) else (exc.stderr or '')
        tail = stderr.strip().splitlines()[-12:]
        raise RuntimeError(f'ffmpeg failed ({exc.returncode}): {" ".join(tail)}\ncommand: {shlex.join(cmd)}') from exc


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    """Execute FFmpeg with a bounded timeout and explicit failure reporting."""
    return _run_process([ffmpeg_exe(), '-hide_banner', '-nostdin', *args], check=True)


def stream_sar(stream) -> float:
    """
    The stream's sample (pixel) aspect ratio as a float, 1.0 when it is absent,
    unreadable or degenerate. Anamorphic sources (DV, HDV, many 4:3 broadcast
    masters) store non-square pixels: 720x480 at SAR 32:27 is a 853x480
    picture, and a decoder that ignores the ratio squeezes the people in it.
    """
    for holder in (stream, getattr(stream, 'codec_context', None)):
        ratio = getattr(holder, 'sample_aspect_ratio', None) if holder is not None else None
        if not ratio:
            continue
        try:
            value = float(ratio)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return 1.0


def display_dims(coded_width: int, coded_height: int, sar: float) -> tuple[int, int]:
    """
    Square-pixel (display) dimensions of a coded frame: the width stretched by
    the pixel aspect ratio and made even (encoders want even dimensions), the
    height unchanged. With square pixels the coded size is already the display
    size and is returned untouched.
    """
    coded_width, coded_height = int(coded_width or 0), int(coded_height or 0)
    if not coded_width or not coded_height or abs(float(sar) - 1.0) <= SAR_EPSILON:
        return coded_width, coded_height
    return max(2, int(round(coded_width * float(sar))) // 2 * 2), coded_height


_DURATION_RE = re.compile(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)')

_VIDEO_RE = re.compile(r'Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)', re.S)

_FPS_RE = re.compile(r'([\d.]+) fps')

_SAR_RE = re.compile(r'\[SAR (\d+):(\d+) DAR \d+:\d+\]')

_AUDIO_RE = re.compile(r'Stream #\d+:\d+.*?: Audio: (\w+).*?, (\d+) Hz, (\w+[\d.]*)')

_FORMAT_RE = re.compile(r'Input #0, ([^,]+(?:,[^,]+)*), from')

_CHANNEL_NAMES = {'mono': 1, 'stereo': 2, 'quad': 4, '5.0': 5, '5.1': 6, '7.1': 8}

_PIX_RE = re.compile(
    r',\s*([a-z][a-z0-9]*(?:p[0-9]*)?(?:[0-9]+(?:le|be))?)'
    r'(?:\(([^)]*)\))?,\s*\d+x\d+'
)

_RANGE_NAMES = {1: 'tv', 2: 'pc'}

_PRIMARIES_NAMES = {
    1: 'bt709',
    4: 'bt470m',
    5: 'bt470bg',
    6: 'smpte170m',
    7: 'smpte240m',
    8: 'film',
    9: 'bt2020',
    10: 'smpte428',
    11: 'smpte431',
    12: 'smpte432',
}

_TRANSFER_NAMES = {
    1: 'bt709',
    4: 'gamma22',
    5: 'gamma28',
    6: 'smpte170m',
    7: 'smpte240m',
    8: 'linear',
    9: 'log100',
    10: 'log316',
    11: 'iec61966-2-4',
    12: 'bt1361e',
    13: 'iec61966-2-1',
    14: 'bt2020-10',
    15: 'bt2020-12',
    16: 'smpte2084',
    17: 'smpte428',
    18: 'arib-std-b67',
}

_MATRIX_NAMES = {
    0: 'gbr',
    1: 'bt709',
    4: 'fcc',
    5: 'bt470bg',
    6: 'smpte170m',
    7: 'smpte240m',
    8: 'ycgco',
    9: 'bt2020nc',
    10: 'bt2020c',
}

_UNKNOWN_COLOUR = ('', 'unknown', 'unspecified', 'reserved', 'none')


def _colour_name(value, names: dict) -> str:
    """
    One of ffmpeg's colour enums as a plain name, whatever PyAV version handed
    it over: an int, an IntEnum, or an object with a `.name`. An unspecified
    value — the common case, and the one that must not be guessed at — is ''.
    """
    if value is None:
        return ''
    label = getattr(value, 'name', None)
    if isinstance(label, str) and not label.isdigit():
        low = label.strip().lower()
        if low in _UNKNOWN_COLOUR:
            return ''
        return {'mpeg': 'tv', 'jpeg': 'pc', 'video': 'tv'}.get(low, low)
    try:
        return names.get(int(value), '')
    except (TypeError, ValueError):
        return ''


def sar_of(value) -> float:
    """A sample aspect ratio (Fraction, 'a:b', number, None) as a float; 1.0 when unknown."""
    if value is None:
        return 1.0
    if isinstance(value, str):
        text = value.strip().replace('/', ':')
        if ':' in text:
            a, _, b = text.partition(':')
            try:
                a, b = float(a), float(b)
            except ValueError:
                return 1.0
            return a / b if a > 0 and b > 0 else 1.0
        value = text
    try:
        ratio = float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return 1.0
    return ratio if ratio > 0 else 1.0


def _colour_triple(parts: list[str]) -> list[str]:
    """
    The matrix / primaries / transfer out of ffmpeg's own parenthesis.

    ffmpeg writes `(tv, bt2020nc/bt2020/arib-std-b67)` when the three differ
    and COLLAPSES them to `(tv, bt709, progressive)` when they agree, so a
    reader that only knows the slashed form finds nothing on the commonest
    file there is.
    """
    skip = (
        'tv',
        'pc',
        'mpeg',
        'jpeg',
        'full',
        'limited',
        'progressive',
        'top first',
        'bottom first',
        'top coded first (swapped)',
    )
    for part in parts:
        if '/' in part:
            three = (part.split('/') + ['', ''])[:3]
            return [item.strip() for item in three]
        if part not in skip:
            return [part, part, part]
    return ['', '', '']


def _probe_ffmpeg(path: str | Path) -> dict:
    """
    The same metadata read from `ffmpeg -i` output. Only used where PyAV is not
    installed (the engine always has it — it is in requirements.txt); it keeps
    the node runnable, and testable, on a bare toolchain.
    """
    text = (
        _run_process([ffmpeg_exe(), '-hide_banner', '-nostdin', '-i', str(path)], check=False, timeout=60).stderr or ''
    )
    duration_ms = 0
    match = _DURATION_RE.search(text)
    if match:
        duration_ms = int((int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))) * 1000)
    video = _VIDEO_RE.search(text)
    fps = 0.0
    if video:
        line = text[video.start() : text.find('\n', video.start())]
        rate = _FPS_RE.search(line)
        fps = float(rate.group(1)) if rate else 0.0
    audio = _AUDIO_RE.search(text)
    fmt = _FORMAT_RE.search(text)
    sar = 1.0
    coded_w = int(video.group(2)) if video else 0
    coded_h = int(video.group(3)) if video else 0
    if video:
        line = text[video.start() : text.find('\n', video.start())]
        ratio = _SAR_RE.search(line)
        if ratio:
            sar = sar_of(f'{ratio.group(1)}:{ratio.group(2)}')
    width, height = display_dims(coded_w, coded_h, sar)
    pix_fmt, colour = '', []
    if video:
        line = text[video.start() : text.find('\n', video.start())]
        pixels = _PIX_RE.search(line)
        if pixels:
            pix_fmt = pixels.group(1)
            colour = [part.strip().lower() for part in (pixels.group(2) or '').split(',') if part.strip()]
    ranges = [part for part in colour if part in ('tv', 'pc', 'mpeg', 'jpeg', 'full', 'limited')]
    triple = _colour_triple(colour)
    return {
        'has_video': bool(video),
        'has_audio': bool(audio),
        'duration_ms': duration_ms,
        'width': width,
        'height': height,
        'coded_width': coded_w,
        'coded_height': coded_h,
        'sar': round(sar, 6),
        'fps': round(fps, 3),
        'video_codec': video.group(1) if video else None,
        'audio_codec': audio.group(1) if audio else None,
        'audio_channels': _CHANNEL_NAMES.get(audio.group(3), 2) if audio else 0,
        'audio_sample_rate': int(audio.group(2)) if audio else 0,
        'container': fmt.group(1) if fmt else '',
        'size_bytes': os.path.getsize(path),
        'pix_fmt': pix_fmt,
        'color_range': {'mpeg': 'tv', 'limited': 'tv', 'jpeg': 'pc', 'full': 'pc'}.get(ranges[0], ranges[0])
        if ranges
        else '',
        'color_space': triple[0] if triple[0] not in _UNKNOWN_COLOUR else '',
        'color_primaries': triple[1] if triple[1] not in _UNKNOWN_COLOUR else '',
        'color_transfer': triple[2] if triple[2] not in _UNKNOWN_COLOUR else '',
    }


def probe(path: str | Path) -> dict:
    """
    Normalized media metadata via PyAV (no ffprobe in the engine).

    `width`/`height` are DISPLAY (square-pixel) dimensions — what a viewer
    sees and what every framing plan, crop path and canvas is expressed in.
    `coded_width`/`coded_height` are the stream's own pixels and `sar` the
    ratio between them; a decode path that wants display pixels applies
    `scale=width:height,setsar=1` before anything else.
    """
    try:
        import av
    except ImportError:
        return _probe_ffmpeg(path)

    with av.open(str(path)) as container:
        duration_ms = int(container.duration / 1000) if container.duration else 0
        video, fps = None, 0.0
        for stream in container.streams.video:
            rate = float(stream.average_rate) if stream.average_rate else 0.0
            if rate > 0:
                video, fps = stream, rate
                break
        audio = container.streams.audio[0] if container.streams.audio else None
        sar = stream_sar(video) if video else 1.0
        coded_w, coded_h = (int(video.width), int(video.height)) if video else (0, 0)
        width, height = display_dims(coded_w, coded_h, sar)
        codec = video.codec_context if video else None
        fmt = getattr(video, 'format', None) or getattr(codec, 'format', None)
        pix_fmt = str(getattr(fmt, 'name', None) or getattr(codec, 'pix_fmt', None) or '') if video else ''
        return {
            'has_video': video is not None,
            'has_audio': audio is not None,
            'duration_ms': duration_ms,
            'width': width,
            'height': height,
            'sar': round(sar, 6),
            'coded_width': coded_w,
            'coded_height': coded_h,
            'fps': round(fps, 3),
            'video_codec': video.codec_context.name if video else None,
            'audio_codec': audio.codec_context.name if audio else None,
            'audio_channels': int(audio.codec_context.channels) if audio else 0,
            'audio_sample_rate': int(audio.codec_context.sample_rate) if audio else 0,
            'container': container.format.name,
            'size_bytes': os.path.getsize(path),
            'pix_fmt': pix_fmt,
            'color_range': _colour_name(getattr(codec, 'color_range', None), _RANGE_NAMES),
            'color_space': _colour_name(getattr(codec, 'colorspace', None), _MATRIX_NAMES),
            'color_primaries': _colour_name(getattr(codec, 'color_primaries', None), _PRIMARIES_NAMES),
            'color_transfer': _colour_name(getattr(codec, 'color_trc', None), _TRANSFER_NAMES),
        }


def parse_range(value) -> tuple[int, int] | None:
    """Parse a non-empty source range; malformed requests never imply a full scan."""
    if value is None or value == '':
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.startswith('['):
            try:
                pair = json.loads(text)
            except ValueError as exc:
                raise ValueError('range must be [start_ms, end_ms] or start_ms-end_ms') from exc
        else:
            pair = text.replace('..', '-').split('-')
    else:
        pair = value
    if not isinstance(pair, (list, tuple)) or len(pair) != 2 or any(isinstance(x, bool) for x in pair):
        raise ValueError('range must contain exactly two millisecond values')
    try:
        start, end = (int(float(x)) for x in pair)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError('range must contain finite millisecond values') from exc
    if start < 0 or end <= start:
        raise ValueError('range must be non-negative and end after it starts')
    return start, end


def parse_count(value, default: int = 0) -> int:
    """A whole count from the question context; 0 (or anything unreadable) means "no limit"."""
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError, OverflowError):
        return max(0, int(default))


def parse_ranges(text) -> list[tuple[int, int]]:
    """
    `[[a, b], …]` (ms) from one line of the question context.

    A context value may not contain a newline, so the whole document is one
    line of JSON. A malformed one is refused with the reason rather than read
    as "no ranges were asked for": a caller who asked for measurements and got
    an empty answer cannot tell the two apart.
    """
    if text in (None, ''):
        return []
    try:
        rows = json.loads(str(text))
    except (TypeError, ValueError) as exc:
        raise ValueError(f'ranges is not JSON: {exc}') from exc
    if not isinstance(rows, list):
        raise ValueError('ranges is not a JSON array of [start, end] pairs')
    out: list[tuple[int, int]] = []
    for i, row in enumerate(rows):
        if isinstance(row, dict):
            row = [row.get('start', row.get('s')), row.get('end', row.get('e'))]
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            raise ValueError(f'ranges[{i}] is not a [start, end] pair')
        try:
            start, end = int(float(row[0])), int(float(row[1]))
        except (TypeError, ValueError):
            raise ValueError(f'ranges[{i}] has a time that is not a number of milliseconds') from None
        out.append((max(0, start), max(0, end)))
    return out


def slice_audio(
    src: str | Path,
    start_ms: int,
    end_ms: int,
    out_path: str | Path,
    sample_rate: int = SLICE_RATE,
    channels: int | None = None,
) -> Path:
    """
    Sample-accurate audio slice; the codec follows the extension (.wav / .mp3).

    `sample_rate` and `channels` are what the READER of the slice asks for.
    A delivery slice keeps the band (48 kHz, the source's own channels); a
    slice made for a speech model is decoded the way that model wants it,
    because the encoding changes what it hears (see `align.ALIGN_RATE`).
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    codecs = {
        '.mp3': ['-c:a', 'libmp3lame', '-b:a', '128k'],
        '.m4a': ['-c:a', 'aac', '-b:a', '192k'],
        '.aac': ['-c:a', 'aac', '-b:a', '192k'],
        '.flac': ['-c:a', 'flac'],
    }
    codec = codecs.get(out_path.suffix.lower(), ['-c:a', 'pcm_s16le'])
    layout = ['-ac', str(int(channels))] if channels else []
    run_ffmpeg(
        [
            '-y',
            '-ss',
            f'{start_ms / 1000:.3f}',
            '-t',
            f'{(end_ms - start_ms) / 1000:.3f}',
            '-i',
            str(src),
            '-vn',
            *layout,
            '-ar',
            str(int(sample_rate)),
            *codec,
            str(out_path),
        ]
    )
    return out_path


def probe_payload(media: dict, source: str) -> dict:
    """
    The JSON `probe` writes and forwards: what the file is, plus where it came
    from. `width`/`height` are display pixels; `sar` and the coded dimensions
    travel with them so a caller can tell an anamorphic source from a square
    one without probing again.
    """
    return {
        'schema_version': 1,
        'source': source,
        'duration_ms': int(media.get('duration_ms') or 0),
        'width': int(media.get('width') or 0),
        'height': int(media.get('height') or 0),
        'sar': float(media.get('sar') or 1.0),
        'coded_width': int(media.get('coded_width') or media.get('width') or 0),
        'coded_height': int(media.get('coded_height') or media.get('height') or 0),
        'fps': media.get('fps'),
        'has_video': bool(media.get('has_video')),
        'has_audio': bool(media.get('has_audio')),
        'size': int(media.get('size_bytes') or 0),
        'video_codec': media.get('video_codec'),
        'audio_codec': media.get('audio_codec'),
        'audio_channels': media.get('audio_channels'),
        'audio_sample_rate': media.get('audio_sample_rate'),
        'container': media.get('container'),
        'size_bytes': int(media.get('size_bytes') or 0),
    }


def square_pixel_filters(media: dict | None) -> list[str]:
    """
    The filters that turn a decode into square pixels, or none when the source
    already has them. They must come FIRST in any chain whose output is
    measured: everything downstream is then in display pixels and a box
    measured on a frame maps back onto the picture by a single scale factor.
    """
    media = media or {}
    sar = float(media.get('sar') or 1.0)
    width, height = int(media.get('width') or 0), int(media.get('height') or 0)
    if abs(sar - 1.0) <= SAR_EPSILON or not width or not height:
        return []
    return [f'scale={width}:{height}', 'setsar=1']
