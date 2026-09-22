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
import math
from ._support.media import ffmpeg_exe as ffmpeg_exe, square_pixel_filters as square_pixel_filters, _run_process


SAR_EPSILON = 1e-6  # below this a pixel aspect ratio is square

HOUSE_PIX_FMTS = ('yuv420p',)

STILL_QUALITY = 2

FRAME_EPSILON_S = 0.0001

STILL_LOOKBACK_MS = 1000

STILLS_KIND = 'media_stills'


def _round_half_up(value: float) -> int:
    """
    JavaScript's `Math.round`: halves go UP, not to even.

    Python's own `round()` is banker's rounding, so `round(0.5)` is 0 where
    `Math.round(0.5)` is 1 — one frame time in a thousand differs by a
    millisecond, and a millisecond is a different frame. The grid this node
    hands out is the one every client used to compute for itself, so it has to
    keep answering the numbers those clients pinned.
    """
    return int(math.floor(value + 0.5))


def scaled_size(source_w, source_h, target_w) -> tuple[int, int]:
    """
    The size a picture is scaled to for a stated width — ffmpeg's
    `scale=<width>:-2`: the height follows the aspect and is then made even.
    """
    sw, sh = int(source_w or 0), int(source_h or 0)
    if sw <= 0 or sh <= 0:
        return 0, 0
    wanted = int(target_w or 0)
    width = wanted if wanted > 0 else sw
    exact = _round_half_up(width * sh / sw)
    return width, max(2, _round_half_up(exact / 2) * 2)


def crop_window(crop, width, height) -> tuple[int, int, int, int]:
    """
    The window a still is cut from, always inside the picture.

    Unclamped, a box against an edge asks for pixels that do not exist, and
    ffmpeg refuses the crop outright — one bad box used to take every later
    still of the run with it. An absent crop is the whole picture.
    """
    w, h = int(width or 0), int(height or 0)
    if not crop or w <= 0 or h <= 0:
        return 0, 0, max(0, w), max(0, h)
    cw = max(1, min(w, _round_half_up(float(crop[2]))))
    ch = max(1, min(h, _round_half_up(float(crop[3]))))
    x = max(0, min(w - cw, _round_half_up(float(crop[0]))))
    y = max(0, min(h - ch, _round_half_up(float(crop[1]))))
    return x, y, cw, ch


SOI, EOI = b'\xff\xd8', b'\xff\xd9'


def split_jpegs(blob: bytes) -> list[bytes]:
    """
    One MJPEG stream (`-f image2pipe -c:v mjpeg`) as the pictures in it.

    Every JPEG starts with SOI and ends with EOI, and neither marker can appear
    in entropy-coded data — a literal 0xFF there is always followed by 0x00 or
    by a restart marker (0xD0-0xD7). So splitting on SOI is exact.
    """
    out, at = [], blob.find(SOI)
    while at >= 0:
        nxt = blob.find(SOI, at + 2)
        piece = blob[at:] if nxt < 0 else blob[at:nxt]
        if piece.endswith(EOI) or nxt < 0:
            out.append(piece)
        at = nxt
    return out


def ffmpeg_pictures(args: list[str], what: str) -> list[bytes]:
    """One ffmpeg pass that writes JPEGs to stdout, as a list of pictures."""
    cmd = [ffmpeg_exe(), '-hide_banner', '-nostdin', '-loglevel', 'error', *args]
    done = _run_process(cmd, check=False, text=False)
    if done.returncode != 0 and not done.stdout:
        tail = ' '.join((done.stderr or b'').decode('utf-8', 'replace').strip().splitlines()[-6:])
        raise RuntimeError(f'ffmpeg failed ({done.returncode}) reading {what}: {tail}')
    return split_jpegs(done.stdout or b'')


def _fps_arg(fps) -> str:
    """`fps=` as ffmpeg spells it — `5`, or `1/2` for the whole-episode scan."""
    rate = float(fps)
    return f'{rate:g}' if rate >= 1 else f'1/{_round_half_up(1 / rate)}'


def picture_pass(src, a_ms, b_ms, fps, chain, *, quality, what) -> list[bytes]:
    """
    ONE ffmpeg pass over one range: the pictures a grid of `fps` asks for, on
    the grid `frame_grid` describes, chosen the way a VIDEO ELEMENT chooses.

    THE RULE, and why it is this shape (the alternative measured 28.7 dB PSNR
    against 41 dB — a whole frame out):

      * a media element shows, at time t, the decoded frame whose pts is <= t;
      * ffmpeg's `-ss t` hands back the first frame with pts >= t, which is the
        NEXT frame whenever t falls between two;
      * so the seek goes back one grid step and the `fps` filter is anchored
        there by hand (`start_time`), with `round=down`. `round=down` fills
        output slot k with the last input frame BEFORE slot k's time plus one
        step — i.e. the last frame at or before grid point k, which is the
        element's frame. `round=near`, and `fps` with no anchor at all, both
        land a frame late.
      * `settb=1/1000000` first, so that anchor is expressed in microseconds
        whatever timebase the container keeps, and FRAME_EPSILON_S survives it.
      * FRAME_EPSILON_S (0.1 ms) is what makes "before" mean "at or before": a
        frame sitting exactly ON a grid point (any integer frame rate with an
        exact timebase) is the element's frame and has to be included. It is
        far smaller than the ~0.2 ms by which a 23.976 fps frame can overshoot
        an integer millisecond, so it never reaches forward to the next one.

    Verified frame for frame against "last pts <= t" on eight ranges of six
    recordings (23.976 / 25 / 29.97 / 30 fps, 5 fps and 0.5 fps grids): 0
    misses. The pass answers one slot more than the grid asks for; the caller
    zips against the grid, which is the authority on time.
    """
    step = 1000.0 / float(fps)
    anchor = (float(a_ms) - step) / 1000.0
    return ffmpeg_pictures(
        [
            '-copyts',
            '-ss',
            f'{max(0.0, anchor):.6f}',
            '-to',
            f'{float(b_ms) / 1000:.6f}',
            '-i',
            str(src),
            '-an',
            '-vf',
            (f'settb=1/1000000,fps={_fps_arg(fps)}:start_time={anchor + FRAME_EPSILON_S:.6f}:round=down,{chain}'),
            '-q:v',
            str(quality),
            '-f',
            'image2pipe',
            '-c:v',
            'mjpeg',
            '-',
        ],
        what,
    )


def sample_filters(media: dict | None) -> list[str]:
    """
    The filters that put a decode into 8-bit 4:2:0 — none when it is already
    there, so an ordinary recording reads through an unchanged chain. They go
    FIRST, ahead of the square-pixel scale and therefore ahead of every crop.
    """
    pix = str((media or {}).get('pix_fmt') or '')
    return [] if (not pix or pix in HOUSE_PIX_FMTS) else ['format=yuv420p']


def frame_filter(media: dict | None, width: int) -> str:
    """
    `scale` to the sampling size, in DISPLAY pixels.

    The recording is unsqueezed first — a 32:27 stream is 650 coded pixels wide
    and 770 on screen — so a box measured on the small copy maps back onto the
    picture by ONE factor, which is the whole reason the square-pixel filters
    come before the scale and not after it (C3). A 10-bit or 4:2:2 decode is
    put into 8-bit 4:2:0 ahead of even that: everything downstream — this
    scale, and the crop `cut_still` adds after it — then works on samples the
    width of a byte.
    """
    media = media or {}
    w, h = scaled_size(media.get('width'), media.get('height'), width)
    scale = f'scale={w}:{h}' if w and h else f'scale={int(width)}:-2'
    return ','.join([*sample_filters(media), *square_pixel_filters(media), scale, 'setsar=1'])


def cut_still(
    src, t_ms, crop=None, *, media: dict | None = None, width: int = 0, quality: int = STILL_QUALITY
) -> bytes:
    """
    One picture at one time, cut to `crop` (display pixels) and scaled to
    `width` — the same picture `read_frames` answers for that millisecond, cut
    a notch finer because this one is looked at rather than measured.
    """
    media = media or {}
    x, y, w, h = crop_window(crop, media.get('width'), media.get('height'))
    if w <= 0 or h <= 0:
        raise RuntimeError('the still has no box to cut')
    at = max(0, int(t_ms))
    chain = [frame_filter(media, int(media.get('width') or 0)), f'crop={w}:{h}:{x}:{y}']
    if width and int(width) > 0:
        out_w, out_h = scaled_size(w, h, int(width))
        chain.append(f'scale={out_w}:{out_h}')
    pictures = picture_pass(
        src, at, at + 1, 1000.0 / STILL_LOOKBACK_MS, ','.join(chain), quality=quality, what=f'a still at {at} ms'
    )
    if not pictures:
        raise RuntimeError(f'no frame at {at} ms')
    return pictures[0]


def parse_stills(text) -> list:
    """
    `[{"id": …, "t_ms": …, "crop": [x, y, w, h], "width": …}, …]` from one line
    of the question context — the DOCUMENT only. Each row is checked where it
    is cut (`still_entry`), so one unusable row costs one still instead of the
    run.
    """
    if text in (None, ''):
        return []
    try:
        rows = json.loads(str(text))
    except (TypeError, ValueError) as exc:
        raise ValueError(f'stills is not JSON: {exc}') from exc
    if not isinstance(rows, list):
        raise ValueError('stills is not a JSON array of {id, t_ms, crop} entries')
    return rows


def still_entry(row) -> tuple[str, int, tuple[int, int, int, int] | None, int]:
    """
    One checked `{id, t_ms, crop, width}` row: (id, t_ms, crop or None, width).

    `id` is the file the still is written as, so it has to be a plain name — a
    value with a path separator in it would write outside the directory the
    caller named. `crop` is already the window the caller wants (whatever pad
    or squaring it applied is its own arithmetic, done where the box was
    measured); an absent crop is the whole picture, and an absent width leaves
    the crop at its own size.
    """
    if not isinstance(row, dict):
        raise ValueError('an entry is not a {id, t_ms, crop} object')
    name = row.get('id')
    if not isinstance(name, str) or not name.strip():
        raise ValueError('an entry has no id')
    name = name.strip()
    if '/' in name or '\\' in name or name in ('.', '..') or any(ord(c) < 32 for c in name):
        raise ValueError(f'{name!r} is not a plain file name')
    try:
        t_ms = max(0, int(float(row.get('t_ms'))))
    except (TypeError, ValueError):
        raise ValueError(f'{name}: t_ms is not a number of milliseconds') from None
    crop = row.get('crop')
    window = None
    if crop is not None:
        if not isinstance(crop, (list, tuple)) or len(crop) < 4:
            raise ValueError(f'{name}: crop is not [x, y, w, h]')
        try:
            x, y, w, h = (int(float(v)) for v in crop[:4])
        except (TypeError, ValueError):
            raise ValueError(f'{name}: crop has a value that is not a number') from None
        if w <= 0 or h <= 0:
            raise ValueError(f'{name}: crop has no width or no height')
        window = (x, y, w, h)
    try:
        width = max(0, int(float(row.get('width') or 0)))
    except (TypeError, ValueError):
        width = 0
    return name, t_ms, window, width
