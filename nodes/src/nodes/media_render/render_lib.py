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
The ffmpeg / PyAV library: every graph, encode and measurement the node
performs. Nothing here knows about a store, a caller or an application — it
takes local paths, millisecond timelines and plain dicts.

Everything runs on the engine's own toolchain: the ffmpeg bundled with
imageio_ffmpeg (libx264, libass, loudnorm) and PyAV for probing — no extra
dependencies to install.

Audio and video are cut from the *same* keep-segment list with hard cuts and
10 ms de-click fades on the audio. The sound is cut sample-accurately at the
list's millisecond values; the picture is snapped to its frame grid from the
sound's running total (`snap_segments`), so both streams come out the same
length to within half a frame however many cuts there are, and captions can
be timed through one plan.

"""

from __future__ import annotations
import json
import math
import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path
from ._support.media import (
    ffmpeg_exe,
    run_ffmpeg,
    _probe_ffmpeg,
    _run_process,
    slice_audio as slice_audio,
    sar_of as sar_of,
    display_dims as media_display_dims,
    probe as media_probe,
)

LAYOUTS = ('vertical', 'wide')

# The shapes a clip can be rendered in. 'vertical' and 'wide' are the two
# render passes; an aspect narrows what the vertical pass actually produces
# (9:16 as always, or 4:5 / 1:1 for the feed formats).
CLIP_ASPECTS = ('9:16', '4:5', '1:1', '16:9')

LOUDNESS_TARGET_LUFS = -16.0
TRUE_PEAK_DBTP = -1.0
LOUDNESS_RANGE_LU = 11.0
DECLICK_FADE_S = 0.01

# ------------------------------------------------------------------ colour
#
# THE HOUSE PICTURE is 8-bit 4:2:0, limited ("tv") range, Rec.709, and every
# deliverable is written in it and TAGGED with it. A camera source that is not
# already that is converted ONCE, right after the decode, before anything
# splits, crops or zooms it. Two reasons, and the first one is not cosmetic:
#
#   * `crop` offsets the chroma planes of a subsampled picture by
#     `x * bytes_per_sample >> hsub` BYTES. At 8 bits that is floor(x/2)
#     samples, which is right. At 10 bits it is `x` bytes, so an ODD x reads
#     every 16-bit chroma sample one byte out of phase: the panel comes out
#     solid magenta with posterised edges while its luma stays sharp. The
#     layout graph asks for `exact=1` — it has to place a crop on the pixel
#     the framing plan named — and `exact=1` is what lets x be odd at all.
#     Measured on a 3840x2160 yuv422p10le camera file: crop x=2071 gives
#     U/V averages of 205/216, x=2070 gives 130/130.
#   * a full-range ("pc") recording carried through to the encoder produces a
#     `yuvj420p` file tagged `pc`. Self-consistent, and wrong everywhere the
#     tag is ignored, which is most of the web.
#
# `source_normalize` is that conversion and it is EMPTY for a source already
# in the house format, so 8-bit 4:2:0 limited-range material renders through a
# byte-identical graph and produces a byte-identical picture.

HOUSE_PIX_FMT = 'yuv420p'
# the only decoded format that needs no conversion: 8-bit, 4:2:0, planar.
# `nv12` is 8-bit 4:2:0 too and is deliberately NOT here — its interleaved
# chroma plane has the same odd-offset hazard as a 10-bit plane.
HOUSE_PIX_FMTS = ('yuv420p',)
# the colour statement stamped on the frames. ffmpeg keeps `-colorspace` and
# `-color_range` from the command line but takes the primaries and the
# transfer from the FRAME, so a source that never said what it was would ship
# `unknown` for two of the four tags without this.
HOUSE_TAGS = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709'
# the last two filters of EVERY video graph. The stamp changes not one pixel,
# and it has to be there even when nothing was converted: `-color_range tv` on
# a command line whose frames say `unspecified` makes ffmpeg insert a scaler
# that reads them as FULL and compresses the levels — measured, a different
# picture out of an ordinary 8-bit recording. Stamped frames match what the
# encoder was told, so no scaler is inserted and the pixels are byte-identical.
HOUSE_TAIL = f'format={HOUSE_PIX_FMT},{HOUSE_TAGS}'
# the encoder side of the same statement, on every video render path
VIDEO_COLOUR_ARGS = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
FULL_RANGE_NAMES = ('pc', 'jpeg', 'full')
LIMITED_RANGE_NAMES = ('tv', 'mpeg', 'limited')
HDR_TRANSFERS = ('smpte2084', 'arib-std-b67')  # PQ and HLG


def range_name(value) -> str:
    """A colour range spelled the way ffmpeg's filters spell it: 'tv', 'pc' or '' (unknown)."""
    text = str(value or '').strip().lower()
    if text in FULL_RANGE_NAMES:
        return 'pc'
    if text in LIMITED_RANGE_NAMES:
        return 'tv'
    return ''


@lru_cache(maxsize=1)
def has_zscale() -> bool:
    """Whether this ffmpeg was built with libzimg — the only filter that tone-maps HDR properly."""
    try:
        listing = (
            subprocess.run(
                [ffmpeg_exe(), '-hide_banner', '-filters'], capture_output=True, text=True, timeout=60
            ).stdout
            or ''
        )
    except Exception:  # noqa: BLE001
        return False
    return re.search(r'^\s*\S+\s+zscale\s', listing, re.M) is not None


def source_normalize(media: dict | None) -> str:
    """
    The filter prefix that converts a decoded source into the house picture —
    8-bit 4:2:0, limited range — or an EMPTY string when the recording is
    already that. It goes FIRST in every video graph, ahead of `square_pixels`
    and therefore ahead of every split, crop, zoom and stack. (The Rec.709
    STATEMENT is `HOUSE_TAIL`, at the other end of the graph, on every render
    whether anything was converted or not.)

    A probe that could not say what the source is (`pix_fmt` missing) changes
    nothing: an unknown source renders exactly as it did before.
    """
    info = media if isinstance(media, dict) else {}
    pix = str(info.get('pix_fmt') or '')
    if not pix:
        return ''
    source_range = range_name(info.get('color_range'))
    if pix in HOUSE_PIX_FMTS and source_range != 'pc':
        return ''
    transfer = str(info.get('color_transfer') or '').strip().lower()
    if transfer in HDR_TRANSFERS and has_zscale():
        # PQ / HLG down to Rec.709: linearise, tone-map in float, come back
        return (
            'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,'
            'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,'
            f'format={HOUSE_PIX_FMT},'
        )
    # no `in_range` when the recording never said: swscale then reads the
    # range off the decoded frame, which is a better answer than a guess
    in_range = f'in_range={source_range}:' if source_range else ''
    return f'scale={in_range}out_range=tv,format={HOUSE_PIX_FMT},'


def source_colour_warning(media: dict | None) -> str | None:
    """
    What a caller should be TOLD about this recording's colour, in the
    producer's words, or None when there is nothing to say.

    Two things cannot be fixed by a conversion. HDR needs zscale, and a build
    without libzimg has to treat the recording as SDR. And a camera shooting a
    LOG gamma (S-Log, V-Log, C-Log, Log-C) writes a picture whose transfer is
    not Rec.709 but whose tags say nothing at all, so nothing downstream can
    tell it apart from an ordinary untagged recording: it is passed through as
    it is, and it needs its LUT applied before the file is uploaded.
    """
    info = media if isinstance(media, dict) else {}
    pix = str(info.get('pix_fmt') or '')
    if not pix:
        return None
    transfer = str(info.get('color_transfer') or '').strip().lower()
    if transfer in HDR_TRANSFERS:
        if not has_zscale():
            return (
                'This recording is HDR and this toolchain cannot tone-map it, so it was read as '
                'ordinary video: the picture will look flat and washed out.'
            )
        return None
    tagged = any(
        str(info.get(key) or '').strip().lower() not in ('', 'unknown', 'unspecified')
        for key in ('color_transfer', 'color_primaries', 'color_space')
    )
    if pix not in HOUSE_PIX_FMTS and not tagged:
        return (
            'This recording does not say what its colour is, so it was read as standard '
            'Rec.709. If the camera was shooting a log profile, apply its LUT before '
            'uploading — nothing here can tell a log picture from a flat one.'
        )
    return None


# `Video: hevc (Rext) (hvc1 / 0x31637668), yuv422p10le(pc), 3840x2160 [SAR …]`
# — and `yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)` for a tagged HDR file.

# ffmpeg's colour enums, by the numbers PyAV hands back, spelled the way
# ffmpeg's own filters and command line spell them.


def display_dims(coded_width, coded_height, sar=1.0):
    """Preserve the renderer's string-ratio input contract around the shared helper."""
    return media_display_dims(coded_width, coded_height, sar_of(sar))


def square_pixels(media: dict | None) -> str:
    """
    The filter prefix that turns a non-square-pixel decode into square pixels —
    `scale=<display w>:<display h>,setsar=1,` — and an empty string when the
    source already has square pixels. It goes FIRST in every video graph, so
    every crop path, panel and pad below it is in display pixels.
    """
    info = media if isinstance(media, dict) else {}
    ratio = sar_of(info.get('sar', 1.0))
    if abs(ratio - 1.0) < 1e-6:
        return ''
    width, height = int(info.get('width') or 0), int(info.get('height') or 0)
    if width <= 0 or height <= 0:
        width, height = display_dims(info.get('coded_width'), info.get('coded_height'), ratio)
    if width <= 0 or height <= 0:
        return ''
    return f'scale={width}:{height},setsar=1,'


COLOUR_KEYS = ('pix_fmt', 'color_range', 'color_space', 'color_primaries', 'color_transfer')


def _colour_probe(path: str | Path) -> dict:
    """Only the colour half of `_probe_ffmpeg`; {} when ffmpeg will not say either."""
    try:
        info = _probe_ffmpeg(path)
    except Exception:  # noqa: BLE001
        return {}
    return {key: info.get(key) or '' for key in COLOUR_KEYS}


def probe(path: str | Path) -> dict:
    """Use the shared media probe, with a colour fallback for older PyAV builds."""
    info = media_probe(path)
    if info.get('has_video') and not info.get('pix_fmt'):
        info.update(_colour_probe(path))
    return info


def dims(layout: str, size: int) -> tuple[int, int]:
    """
    Output geometry for a clip from the vertical long edge: vertical 9:16
    (1080x1920 at 1920) and wide 16:9 (1920x1080) as always, plus the two feed
    shapes, which keep the portrait WIDTH so a preview scales proportionally:
    4:5 -> 1080x1350 and 1:1 -> 1080x1080 at 1920, 540x674 / 540x540 at 960.
    """
    size = int(size) // 2 * 2
    short = int(round(size * 9 / 16)) // 2 * 2
    if layout in ('vertical', '9:16'):
        return short, size
    if layout in ('wide', '16:9'):
        return size, short
    if layout == '4:5':
        return short, int(round(short * 5 / 4)) // 2 * 2
    if layout == '1:1':
        return short, short
    raise ValueError(f'unknown layout {layout!r}')


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
    result = _run_process(cmd, check=False, text=True)
    starts = [float(m) for m in _SILENCE_START.findall(result.stderr)]
    ends = [float(m) for m in _SILENCE_END.findall(result.stderr)]
    cuttable = []
    pad = keep_pause_ms // 2
    for start, end in zip(starts, ends):
        cut_start = int(start * 1000) + pad
        cut_end = int(end * 1000) - pad
        if cut_end - cut_start > 100:
            cuttable.append((cut_start, cut_end))
    return cuttable


# ------------------------------------------------------------- the frame grid
#
# The sound is cut sample-accurately at the keep list's millisecond values; the
# picture is a whole number of frames per segment. A `trim` taken at the same
# millisecond values rounds every segment on its own — up to a frame each way —
# so forty cuts put the picture half a second past its sound (`-shortest` then
# hid it by throwing the end away). The picture is snapped ONCE, here, to the
# sound's running total: a segment gets exactly the frames that keep the output
# frame count on the audio's clock, and starts on the source frame nearest the
# sound that plays under it. Nothing accumulates: the two streams differ by at
# most half a frame at any cut, and by at most half a frame overall.


def _frames_at(ms: int, fps: int) -> int:
    """The frame index nearest a time on the `fps` grid (half a frame rounds up)."""
    return int(math.floor(ms * fps / 1000 + 0.5))


def _frame_time(frame: int, fps: int) -> str:
    """
    A frame boundary as the seconds `trim` reads. Exact on the grid: a whole-
    millisecond boundary prints as it always has (three places), any other
    with the six that name it unambiguously (ffmpeg keeps microseconds).
    """
    us = round(frame * 1_000_000 / fps)
    return f'{us / 1_000_000:.3f}' if us % 1000 == 0 else f'{us / 1_000_000:.6f}'


def snap_segments(
    segments_ms: list[tuple[int, int]],
    fps: int,
    base_ms: int = 0,
    *,
    drop_empty: bool = True,
    output_start_ms: int = 0,
) -> list[tuple[int, int]]:
    """
    The keep segments (SOURCE ms) as frame ranges on the decode's grid: half-
    open `(first, last)` frame indices relative to `base_ms`, where the decode
    was seeked to — the frames `trim` sees after `fps=N,setpts=PTS-STARTPTS`.

    Each boundary is rounded once, on the OUTPUT clock the audio is cut on, so
    the running frame count follows the audio's running millisecond total and
    the picture never drifts from the sound; each segment's first frame is the
    source frame nearest the sound that plays under it. A segment too short to
    hold a frame is dropped (the audio keeps it; the next boundary absorbs the
    fraction) — or, with `drop_empty=False`, returned as an empty `(n, n)` so
    the list stays aligned with the input. `output_start_ms` is this part's
    position in the edited body: rounding continues from that clock rather
    than restarting at zero for every separately encoded part.
    """
    frames: list[tuple[int, int]] = []
    out_ms = int(output_start_ms)
    for s, e in segments_ms:
        start, end = int(s) - int(base_ms), int(e) - int(base_ms)
        if end <= start:
            if not drop_empty:
                frames.append((_frames_at(out_ms, fps), _frames_at(out_ms, fps)))
            continue
        # the material cut before this segment, in whole frames: the same
        # source frame stays under the same sound for the segment's whole length
        shift = _frames_at(start - out_ms, fps)
        first = _frames_at(out_ms, fps) + shift
        out_ms += end - start
        last = _frames_at(out_ms, fps) + shift
        if last > first or not drop_empty:
            frames.append((first, last))
    return frames


def _audio_graph(
    segments_ms: list[tuple[int, int]],
    mutes_ms: list[tuple[int, int]] | None = None,
    *,
    denoise: bool = True,
    highpass: bool = True,
    compress: bool = True,
) -> str:
    """
    Atrim + de-click fades + concat, then the mastering chain, ending in [pre].
    Muted ranges (a filler kept in the picture but silenced) are zeroed on the
    source timeline before the cuts, with tiny ramps so the mute never clicks.

    The cuts are taken at the millisecond values as given: this is the clock
    the picture is snapped to (`snap_segments`), not the other way round — one
    mastered track serves every output, whatever frame rate each renders at.
    """
    parts = []
    n = len(segments_ms)
    source = '[0:a]'
    if mutes_ms:
        volume = ','.join(
            f"volume=enable='between(t,{s / 1000:.3f},{e / 1000:.3f})':volume=0:eval=frame"
            for s, e in mutes_ms
            if e > s
        )
        parts.append(f'[0:a]{volume},asplit={n}' + ''.join(f'[m{i}]' for i in range(n)))
        source = None
    for i, (start, end) in enumerate(segments_ms):
        length = (end - start) / 1000
        fade_out_at = max(0.0, length - DECLICK_FADE_S)
        src = source if source else f'[m{i}]'
        parts.append(
            f'{src}atrim=start={start / 1000:.3f}:end={end / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'afade=t=in:d={DECLICK_FADE_S},afade=t=out:st={fade_out_at:.3f}:d={DECLICK_FADE_S}[a{i}]'
        )
    if n > 1:
        parts.append(''.join(f'[a{i}]' for i in range(n)) + f'concat=n={n}:v=0:a=1[cat]')
        cat = '[cat]'
    else:
        cat = '[a0]'
    # noise reduction -> rumble highpass -> gentle compression (threshold -18 dBFS)
    filters = []
    if denoise:
        filters.append('afftdn=nr=10:nf=-40')
    if highpass:
        filters.append('highpass=f=80')
    if compress:
        filters.append('acompressor=threshold=0.126:ratio=2.5:attack=5:release=120')
    chain = ','.join(filters) or 'anull'
    parts.append(f'{cat}{chain}[pre]')
    return ';'.join(parts)


_LOUDNORM_JSON = re.compile(r'\{[^{}]*"input_i"[^{}]*\}', re.S)


def _loudnorm_stats(stderr: str) -> dict | None:
    match = _LOUDNORM_JSON.search(stderr or '')
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


CHANNEL_LAYOUTS = {1: 'mono', 2: 'stereo', 6: '5.1'}


def channel_filter(channels: int) -> str:
    """
    `aformat=channel_layouts=…` for the layout the deliverable ships in. It has
    to run BEFORE the loudness pass: a mono track played as dual mono is 3 LU
    louder than the mono meter says, so the measurement has to see the file the
    way a listener hears it.
    """
    layout = CHANNEL_LAYOUTS.get(int(channels or 0))
    return f'aformat=channel_layouts={layout},' if layout else ''


def render_audio(
    src_wav: str | Path,
    segments_ms: list[tuple[int, int]],
    out_wav: str | Path,
    mutes_ms: list[tuple[int, int]] | None = None,
    loudness_lufs: float = LOUDNESS_TARGET_LUFS,
    true_peak: float = TRUE_PEAK_DBTP,
    channels: int = 2,
    denoise: bool = True,
    highpass: bool = True,
    compress: bool = True,
    master: bool = True,
    warnings: list[str] | None = None,
) -> Path:
    """
    Cut, clean and master a short piece of audio with ffmpeg only. Two-pass EBU
    R128 loudnorm to -16 LUFS / -1 dBTP (linear when the measurement allows it,
    ffmpeg's dynamic mode otherwise), in the deliverable's own channel layout.
    The second pass is `loudnorm_filter`'s — the one the programme path runs —
    so wide-range material keeps its range instead of being squeezed to 11 LU.
    Silence cannot be mastered (see `mastering_pass`); it is passed through
    and `warnings`, when given, says so.
    """
    out_wav = Path(out_wav)
    graph = _audio_graph(segments_ms, mutes_ms, denoise=denoise, highpass=highpass, compress=compress)
    layout = channel_filter(channels)
    tail = 'aresample=48000'
    if master:
        base = loudnorm_filter(loudness_lufs, true_peak=true_peak)
        measure = _run_process(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                '-i',
                str(src_wav),
                '-filter_complex',
                f'{graph};[pre]{layout}{base}:print_format=json[out]',
                '-map',
                '[out]',
                '-f',
                'null',
                '-',
            ],
            check=False,
            text=True,
        )
        second = mastering_pass(loudness_lufs, _loudnorm_stats(measure.stderr), true_peak, warnings)
        if second:
            tail = f'{second},aresample=48000'

    run_ffmpeg(
        [
            '-y',
            '-i',
            str(src_wav),
            '-filter_complex',
            f'{graph};[pre]{layout}{tail}[out]',
            '-map',
            '[out]',
            '-ar',
            '48000',
            '-ac',
            str(max(1, int(channels or 2))),
            '-c:a',
            'pcm_s16le',
            str(out_wav),
        ]
    )
    return out_wav


SILENT_AUDIO_WARNING = 'The sound is silent: no loudness could be measured, so it was not mastered.'

_MEASURED_KEYS = ('input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset')


def loudness_measurable(stats: dict | None) -> bool:
    """
    Whether loudnorm's first pass measured anything. Silence prints `-inf` for
    the integrated loudness and the peak and `inf` for the offset — values the
    second pass rejects outright (`Value -inf for parameter 'measured_I' out of
    range`), so they must never be copied into it.
    """
    if not stats:
        return False
    try:
        return all(math.isfinite(float(stats[key])) for key in _MEASURED_KEYS)
    except (KeyError, TypeError, ValueError):
        return False


def mastering_pass(
    target_lufs: float, stats: dict | None, true_peak: float = TRUE_PEAK_DBTP, warnings: list[str] | None = None
) -> str | None:
    """
    The loudnorm second pass for a first pass's JSON — or None when there is
    nothing to master: a silent piece has no loudness to bring to the target,
    and the render must not fail over it. A first pass that printed nothing at
    all still gets the single-pass filter, as it always has.
    """
    if stats is not None and not loudness_measurable(stats):
        if warnings is not None and SILENT_AUDIO_WARNING not in warnings:
            warnings.append(SILENT_AUDIO_WARNING)
        return None
    return loudnorm_filter(target_lufs, stats, true_peak=true_peak)


def loudnorm_filter(
    target_lufs: float = LOUDNESS_TARGET_LUFS, stats: dict | None = None, true_peak: float = TRUE_PEAK_DBTP
) -> str:
    """
    The loudnorm filter string. Without `stats` it is the measurement (first)
    pass; with the first pass's JSON it is the linear second pass that actually
    lands on the target. A first pass that measured nothing (silence: `-inf`)
    gets the measurement-less filter back, which loudnorm at least accepts.
    """
    if not stats or not loudness_measurable(stats):
        return f'loudnorm=I={float(target_lufs)}:TP={float(true_peak)}:LRA={LOUDNESS_RANGE_LU}'
    try:
        # loudnorm only honours `linear=true` when the material ALREADY sits
        # inside the requested loudness range; ask for a narrower one and it
        # silently switches to its dynamic mode, which on a short programme
        # lands ~1 LU off the target (a brand intro at -10 LUFS around a
        # quieter body measured 13.4 LU of range and came out -14.8 against
        # -16). The range of a finished programme is not ours to squeeze —
        # that is what the intro is FOR — so the second pass asks for the
        # range the programme actually has and gets the exact linear gain.
        wanted = max(float(LOUDNESS_RANGE_LU), float(stats['input_lra']))
        base = f'loudnorm=I={float(target_lufs)}:TP={float(true_peak)}:LRA={wanted}'
        return (
            f'{base}:measured_I={stats["input_i"]}:measured_TP={stats["input_tp"]}'
            f':measured_LRA={stats["input_lra"]}:measured_thresh={stats["input_thresh"]}'
            f':offset={stats["target_offset"]}:linear=true'
        )
    except (KeyError, TypeError, ValueError):
        return f'loudnorm=I={float(target_lufs)}:TP={float(true_peak)}:LRA={LOUDNESS_RANGE_LU}'


def master_wav(
    src_wav: str | Path,
    out_wav: str | Path,
    *,
    loudness_lufs: float = LOUDNESS_TARGET_LUFS,
    channels: int = 2,
    true_peak: float = TRUE_PEAK_DBTP,
) -> Path:
    """
    Two-pass EBU R128 mastering of a COMPLETE programme (intro, cards, body,
    outro — everything already joined). Nothing may be added to the audio after
    this or the finished file misses the target.

    The chain is the clip path's (`render_audio`): the deliverable's channel
    layout FIRST, so the meter hears the file the way a listener does, then the
    measured second pass.
    """
    src_wav, out_wav = Path(src_wav), Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    layout = channel_filter(channels)
    base = loudnorm_filter(loudness_lufs, true_peak=true_peak)
    measure = _run_process(
        [
            ffmpeg_exe(),
            '-hide_banner',
            '-nostdin',
            '-i',
            str(src_wav),
            '-vn',
            '-af',
            f'{layout}{base}:print_format=json',
            '-f',
            'null',
            '-',
        ],
        check=False,
        text=True,
    )
    second = loudnorm_filter(loudness_lufs, _loudnorm_stats(measure.stderr), true_peak=true_peak)
    run_ffmpeg(
        [
            '-y',
            '-i',
            str(src_wav),
            '-vn',
            '-af',
            f'{layout}{second},aresample=48000',
            '-ar',
            '48000',
            '-ac',
            str(int(channels)),
            '-c:a',
            'pcm_s16le',
            str(out_wav),
        ]
    )
    return out_wav


def measure_loudness(path: str | Path) -> dict | None:
    """Integrated loudness / true peak of a finished file (EBU R128, via loudnorm's analysis pass)."""
    result = _run_process(
        [
            ffmpeg_exe(),
            '-hide_banner',
            '-nostdin',
            '-i',
            str(path),
            '-vn',
            '-af',
            f'loudnorm=I={LOUDNESS_TARGET_LUFS}:TP={TRUE_PEAK_DBTP}:LRA={LOUDNESS_RANGE_LU}:print_format=json',
            '-f',
            'null',
            '-',
        ],
        check=False,
        text=True,
    )
    stats = _loudnorm_stats(result.stderr)
    if not stats:
        return None
    try:
        # a silent file measures `-inf`, which is not a number a report can
        # carry (JSON has no spelling for it): those fields are null
        return {
            'integrated_lufs': _finite_or_none(stats['input_i']),
            'true_peak_dbtp': _finite_or_none(stats['input_tp']),
            'loudness_range_lu': _finite_or_none(stats['input_lra']),
        }
    except (KeyError, ValueError):
        return None


def _finite_or_none(value) -> float | None:
    number = float(value)
    return round(number, 1) if math.isfinite(number) else None


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
        check=False,
        text=True,
    )
    values = _RMS_RE.findall(result.stderr or '')
    if not values:
        return None
    value = values[-1]
    return -120.0 if value == '-inf' else float(value)


def _escape_filter_path(path: str | Path) -> str:
    """
    A file name as a single-quoted filter option (`subtitles='…'`,
    `fontfile='…'`, `sendcmd=f='…'`). ffmpeg unescapes the value TWICE before
    the filter reads it: the graph parser keeps a quoted section verbatim, then
    the option parser turns `\\x` into `x` and reads a bare `'` as a quote of
    its own. So `\\` and `:` are escaped once, for that second pass — and a `'`
    has to step outside the quotes, arrive there as `\\'` and step back in:
    `'\\\\\\''`. (A `\\'` inside the quotes is two literal characters and the
    quote closes early; measured on ffmpeg 7.1 and 8.1.)
    """
    text = str(path).replace('\\', '\\\\')
    text = text.replace(':', '\\:')
    return text.replace("'", "'\\\\\\''")


def build_video_filter(
    segments_ms: list[tuple[int, int]],
    layout: str,
    width: int,
    height: int,
    fps: int,
    ass_path: str | Path | None,
    logo: dict | None = None,
    logo_input: int = 2,
    base_ms: int = 0,
    source: dict | None = None,
) -> str:
    """
    Cut the (already clip-seeked) video into the keep segments, concat, reframe,
    brand, caption.

    `segments_ms` are on the SOURCE timeline and `base_ms` is where the decode
    was seeked to, so the trims are taken relative to the piece that was
    actually decoded — and on the frame grid, from the audio's running total
    (`snap_segments`), so the picture stays on its sound across every cut.
    `source` is the probe of that file: a non-square-pixel recording is scaled
    to its display size first (C3), and every branch ends in square pixels so
    `concat` and the report agree on the shape.
    """
    usable = snap_segments(segments_ms, fps, base_ms)
    if not usable:
        raise ValueError('No segment is long enough to hold a single video frame')

    n = len(usable)
    square = square_pixels(source)
    parts = [
        f'[0:v]{source_normalize(source)}{square}fps={fps},setpts=PTS-STARTPTS,split={n}'
        + ''.join(f'[b{i}]' for i in range(n))
    ]
    for i, (first, last) in enumerate(usable):
        parts.append(
            f'[b{i}]trim=start={_frame_time(first, fps)}:end={_frame_time(last, fps)},setpts=PTS-STARTPTS,fps={fps}[v{i}]'
        )
    if n > 1:
        parts.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[joined]')
        current = '[joined]'
    else:
        current = '[v0]'

    if layout == 'original':
        # the recording's own picture, letter/pillarboxed into the frame on a
        # plain black ground — the producer asked for no reframing at all
        parts.append(
            f'{current}scale={width}:{height}:force_original_aspect_ratio=decrease,'
            f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[framed]'
        )
    elif layout in ('vertical', '9:16', '4:5', '1:1'):
        # blur-pad reframe: the full frame sits on a blurred, darkened copy of itself
        parts.append(f'{current}split[fgsrc][bgsrc]')
        parts.append(
            f'[bgsrc]scale={width}:{height}:force_original_aspect_ratio=increase,'
            f'crop={width}:{height},gblur=sigma=30,eq=brightness=-0.08[bg]'
        )
        parts.append(f'[fgsrc]scale={width}:{height}:force_original_aspect_ratio=decrease[fg]')
        parts.append('[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[framed]')
    else:
        parts.append(
            f'{current}scale={width}:{height}:force_original_aspect_ratio=decrease,'
            f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1[framed]'
        )

    tail = '[framed]'
    if logo:
        parts.extend(logo_chain(logo, width, height, logo_input, tail, '[logoed]'))
        tail = '[logoed]'
    if ass_path:
        parts.append(f"{tail}subtitles='{_escape_filter_path(ass_path)}'[captioned]")
        tail = '[captioned]'
    parts.append(f'{tail}{HOUSE_TAIL}[vout]')
    return ';'.join(parts)


def render_clip_video(
    video_path: str | Path,
    clip_start_ms: int,
    clip_end_ms: int,
    segments_ms: list[tuple[int, int]],
    audio_path: str | Path,
    out_path: str | Path,
    layout: str = 'vertical',
    size: int = 1920,
    ass_path: str | Path | None = None,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    logo: dict | None = None,
    logo_path: str | Path | None = None,
    width: int | None = None,
    height: int | None = None,
    source: dict | None = None,
) -> Path:
    # `layout` still decides the reframe STYLE (blur-pad for portrait shapes,
    # letterbox for wide, a plain black pad for `original`); an explicit
    # width/height overrides its geometry.
    width, height = (int(width), int(height)) if (width and height) else dims(layout, size)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    use_logo = logo if (logo and logo_path) else None
    graph = build_video_filter(
        segments_ms,
        layout,
        width,
        height,
        fps,
        ass_path,
        logo=use_logo,
        logo_input=2,
        base_ms=clip_start_ms,
        source=source,
    )
    seconds = (clip_end_ms - clip_start_ms) / 1000
    brand = ['-loop', '1', '-framerate', str(fps), '-t', f'{seconds:.3f}', '-i', str(logo_path)] if use_logo else []
    run_ffmpeg(
        [
            '-y',
            '-ss',
            f'{clip_start_ms / 1000:.3f}',
            '-t',
            f'{(clip_end_ms - clip_start_ms) / 1000:.3f}',
            '-i',
            str(video_path),
            '-i',
            str(audio_path),
            *brand,
            '-filter_complex',
            graph,
            '-map',
            '[vout]',
            '-map',
            '1:a',
            *video_codec_args(out_path, crf, preset),
            '-r',
            str(fps),
            '-pix_fmt',
            'yuv420p',
            *VIDEO_COLOUR_ARGS,
            *mux_audio_args(out_path),
            *(['-movflags', '+faststart'] if out_path.suffix.lower() in ('.mp4', '.mov') else []),
            '-shortest',
            str(out_path),
        ]
    )
    return out_path


def thumbnail_at_ms(at_ms: int, duration_ms: int, fps: float = 30) -> int:
    """
    A poster time that is inside the picture. `-ss` past the last frame gives
    ffmpeg nothing to encode ("No filtered frames for output stream") and the
    whole render fails AFTER every encode, so a time at or past the end is
    pulled back to the last frame — two frame periods before the file's end,
    which covers the fps quantisation of the picture and a container that
    outlasts it by a frame. An unknown duration changes nothing.
    """
    wanted = max(0, int(at_ms or 0))
    duration_ms = int(duration_ms or 0)
    if duration_ms <= 0:
        return wanted
    frame_ms = int(math.ceil(1000 / max(1.0, float(fps or 1))))
    return max(0, min(wanted, duration_ms - 2 * frame_ms))


def thumbnail(video_path: str | Path, out_jpg: str | Path, at_ms: int = 1000, source: dict | None = None) -> Path:
    """
    One frame as a JPEG, at its display shape (a non-square-pixel source is
    scaled first). `at_ms` has to be inside the picture: see `thumbnail_at_ms`.
    """
    out_jpg = Path(out_jpg)
    square = square_pixels(source).rstrip(',')
    scale = ['-vf', square] if square else []
    run_ffmpeg(
        ['-y', '-ss', f'{at_ms / 1000:.3f}', '-i', str(video_path), '-frames:v', '1', *scale, '-q:v', '3', str(out_jpg)]
    )
    return out_jpg


# --------------------------------------------------------------- shot changes

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
        check=False,
        text=True,
    )
    cuts = []
    for line in (result.stderr or '').splitlines():
        if 'Parsed_showinfo' not in line:
            continue
        m = _SCENE_PTS.search(line)
        if m:
            cuts.append(start_ms + int(float(m.group(1)) * 1000))
    return sorted(set(cuts))


def _interp(keyframes: list[list[int]], t_ms: float) -> tuple[float, float]:
    """Linear interpolation of [t, x, y] keyframes."""
    if t_ms <= keyframes[0][0]:
        return keyframes[0][1], keyframes[0][2]
    for a, b in zip(keyframes, keyframes[1:]):
        if a[0] <= t_ms <= b[0]:
            span = max(1, b[0] - a[0])
            f = (t_ms - a[0]) / span
            return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f
    return keyframes[-1][1], keyframes[-1][2]


def write_pan_commands(
    path: str | Path,
    target: str,
    keyframes: list[list[int]],
    start_ms: int,
    end_ms: int,
    fps: int,
    max_x: int,
    max_y: int,
) -> Path:
    """
    A sendcmd file moving one crop window frame by frame (times relative to
    the piece start). The last keyframe holds to the end.
    """
    path = Path(path)
    lines = []
    frames = int(round((end_ms - start_ms) / 1000 * fps)) + 1
    for k in range(frames):
        t = k / fps
        x, y = _interp(keyframes, start_ms + t * 1000)
        x = int(round(max(0, min(max_x, x))))
        y = int(round(max(0, min(max_y, y))))
        lines.append(f'{t:.4f} {target} x {x}, {target} y {y};')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return path


def _escape_cmd_path(path: str | Path) -> str:
    return _escape_filter_path(path)


# The shared picture never takes more than this much of the canvas height.
SCREEN_TOP_MAX = 0.58


def screen_share_split(out_w: int, out_h: int, src_w: int, src_h: int) -> tuple[int, int]:
    """
    The screen_share canvas split: the shared screen on top at the source's own
    aspect (never more than `SCREEN_TOP_MAX` of the height), the speaker
    underneath. Returns (top_h, bottom_h), both even.

    The planner has to size its crop window from the SAME split the renderer
    lays out, or the speaker panel comes out taller than the window that was
    planned for it (C-D4 measured 1.62x). The two live in different nodes so
    each can be upstreamed on its own, so they are not one import — they are
    two copies held together by a contract test
    (`test_contracts.ScreenShareSplitTests`). Change one, change the other.
    """
    out_w, out_h = int(out_w), int(out_h)
    src_w, src_h = int(src_w or 0), int(src_h or 0)
    cap = max(2, int(out_h * SCREEN_TOP_MAX) // 2 * 2)
    # a source that never said how big it is gets the cap: guessing 1:1 from
    # nothing puts a square screen above a sliver of speaker
    top_h = int(out_w * src_h / src_w) // 2 * 2 if (src_w and src_h and src_w >= src_h) else cap
    top_h = max(2, min(top_h, cap, out_h - 2))
    return top_h, out_h - top_h


def panel_fit(crop_w: int, crop_h: int, panel_w: int, panel_h: int) -> tuple[int, int, int, int]:
    """
    A crop placed into a panel rect the way a picture is placed in a frame:
    scaled to FIT (never stretched), centred, with the leftover space reported
    as the offsets to pad. Sizes are even, so every chroma-subsampled encode
    accepts them, and the aspect is held to within a pixel.
    """
    crop_w, crop_h = max(1, int(crop_w)), max(1, int(crop_h))
    panel_w, panel_h = max(2, int(panel_w)), max(2, int(panel_h))
    scale = min(panel_w / crop_w, panel_h / crop_h)

    def even(value: float, limit: int) -> int:
        return max(2, min(limit, int(round(value / 2)) * 2))

    out_w = even(crop_w * scale, panel_w)
    out_h = even(crop_h * scale, panel_h)
    return out_w, out_h, (panel_w - out_w) // 2, (panel_h - out_h) // 2


def panel_rects(segment: dict, out_w: int, out_h: int) -> list[dict]:
    """
    The per-subject panel rectangles of a segment, in canvas pixels, as the
    framing plan states them. An incomplete or out-of-canvas set is ignored, so
    a plan from before panels existed still renders through the legacy split.
    """
    rects: list[dict] = []
    for item in (segment or {}).get('panels') or []:
        if not isinstance(item, dict):
            return []
        try:
            x, y = int(item['x']), int(item['y'])
            w, h = int(item['w']), int(item['h'])
        except (KeyError, TypeError, ValueError):
            return []
        if w < 2 or h < 2 or x < 0 or y < 0 or x + w > out_w or y + h > out_h:
            return []
        rects.append(
            {'subject': item.get('subject'), 'x': x // 2 * 2, 'y': y // 2 * 2, 'w': w // 2 * 2, 'h': h // 2 * 2}
        )
    return rects


def _panel_chains(
    i: int,
    base: str,
    rects: list[dict],
    seg_paths: list[dict],
    pan_chain,
    out_w: int,
    out_h: int,
    src_w: int,
    src_h: int,
) -> list[str]:
    """
    One piece composed from the plan's panel rects: a blurred copy of the whole
    frame fills the canvas, and every panel's picture is scaled to FIT its rect
    and overlaid there. A rect with no crop path of its own (a shared screen)
    gets the whole frame, fitted the same way.
    """
    by_subject: dict[str, dict] = {}
    for path in seg_paths:
        by_subject.setdefault(str(path.get('subject')), path)
    plan_for = [by_subject.get(str(rect.get('subject'))) for rect in rects]

    parts = [f'{base},split={1 + len(rects)}[c{i}bg]' + ''.join(f'[c{i}p{n}]' for n in range(len(rects)))]
    parts.append(
        f'[c{i}bg]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},'
        f'gblur=sigma=30,eq=brightness=-0.08[c{i}g]'
    )
    stage = f'[c{i}g]'
    for n, (rect, path) in enumerate(zip(rects, plan_for)):
        if path is not None:
            chain = pan_chain(path, f'p{i}n{n}', rect['w'], rect['h'], True)
            parts.append(f'[c{i}p{n}]{chain}[c{i}t{n}]')
        else:
            fit_w, fit_h, pad_x, pad_y = panel_fit(src_w, src_h, rect['w'], rect['h'])
            parts.append(f'[c{i}p{n}]scale={fit_w}:{fit_h},pad={rect["w"]}:{rect["h"]}:{pad_x}:{pad_y}[c{i}t{n}]')
        label = f'[v{i}]' if n == len(rects) - 1 else f'[c{i}o{n}]'
        parts.append(f'{stage}[c{i}t{n}]overlay={rect["x"]}:{rect["y"]}{label}')
        stage = label
    return parts


def build_layout_graph(
    pieces: list[dict],
    layout: dict,
    width: int,
    height: int,
    fps: int,
    ass_path: str | Path | None,
    work: Path,
    logo: dict | None = None,
    logo_input: int = 2,
    base_ms: int = 0,
    source: dict | None = None,
    output_start_ms: int = 0,
) -> str:
    """
    The video filter graph for a layout plan: each piece (a keep segment
    intersected with a layout segment, on the SOURCE clock) is trimmed from the
    decoded clip, reframed by its layout — crops driven per frame by sendcmd
    files written next to the graph — placed on the canvas and concatenated;
    captions and pixel format last.

    `base_ms` is where the decode was seeked to (the piece times are relative to
    it); `source` is that file's probe, so a non-square-pixel recording is
    squared up before any crop is taken (C3). A segment that carries `panels`
    has each subject's crop scaled to FIT its rect — never stretched — on a
    blurred copy of the frame; a segment without them uses the legacy split.
    """
    out_w, out_h = int(layout['canvas']['width']), int(layout['canvas']['height'])
    paths = layout.get('paths') or []
    square = square_pixels(source)
    # every piece on the frame grid, from the audio's running total; a piece
    # too short to hold a frame renders nothing (its sound is under a neighbour)
    spans = snap_segments(
        [(p['start_ms'], p['end_ms']) for p in pieces],
        fps,
        base_ms,
        drop_empty=False,
        output_start_ms=output_start_ms,
    )
    framed = [(piece, span) for piece, span in zip(pieces, spans) if span[1] > span[0]]
    if not framed:
        raise ValueError('No piece is long enough to hold a single video frame')
    parts = [
        f'[0:v]{source_normalize(source)}{square}fps={fps},setpts=PTS-STARTPTS,'
        f'tpad=stop_mode=clone:stop=1,split={len(framed)}' + ''.join(f'[b{i}]' for i in range(len(framed)))
    ]
    outs = []
    for i, (piece, (first, last)) in enumerate(framed):
        s, e = int(piece['start_ms']), int(piece['end_ms'])  # the SOURCE clock, as the plan is
        seg = piece['segment']
        layout_name = seg['layout']
        base = f'[b{i}]trim=start={_frame_time(first, fps)}:end={_frame_time(last, fps)},setpts=PTS-STARTPTS'
        seg_paths = [p for p in paths if p['segment'] == piece['segment_index']]
        rects = panel_rects(seg, out_w, out_h)

        def pan_chain(p: dict, label: str, panel_w: int, panel_h: int, fit: bool = False, _s=s, _e=e, _i=i) -> str:
            cmd = write_pan_commands(
                work / f'pan_{_i}_{label}.cmd',
                f'crop@{label}',
                p['keyframes'],
                _s,
                _e,
                fps,
                width - p['w'],
                height - p['h'],
            )
            x0, y0 = _interp(p['keyframes'], _s)
            tail = f'scale={panel_w}:{panel_h}'
            if fit:
                scaled_w, scaled_h, pad_x, pad_y = panel_fit(p['w'], p['h'], panel_w, panel_h)
                tail = f'scale={scaled_w}:{scaled_h},pad={panel_w}:{panel_h}:{pad_x}:{pad_y}'
            return (
                f"sendcmd=f='{_escape_cmd_path(cmd)}',crop@{label}={p['w']}:{p['h']}:{int(x0)}:{int(y0)}:exact=1,{tail}"
            )

        if rects:
            parts.extend(_panel_chains(i, base, rects, seg_paths, pan_chain, out_w, out_h, width, height))
        elif layout_name == 'solo_follow' and seg_paths:
            parts.append(f'{base},{pan_chain(seg_paths[0], f"p{i}a", out_w, out_h)}[v{i}]')
        elif layout_name in ('stacked_two', 'side_by_side') and len(seg_paths) >= 2:
            a, b = seg_paths[0], seg_paths[1]
            if layout_name == 'stacked_two':
                pw, ph, join = out_w, out_h // 2, 'vstack'
            else:
                pw, ph, join = out_w // 2, out_h, 'hstack'
            parts.append(f'{base},split[s{i}a][s{i}b]')
            parts.append(f'[s{i}a]{pan_chain(a, f"p{i}a", pw, ph)}[t{i}a]')
            parts.append(f'[s{i}b]{pan_chain(b, f"p{i}b", pw, ph)}[t{i}b]')
            parts.append(f'[t{i}a][t{i}b]{join}[v{i}]')
        elif layout_name == 'screen_share' and seg_paths:
            top_h, bot_h = screen_share_split(out_w, out_h, width, height)
            parts.append(f'{base},split[s{i}a][s{i}b]')
            parts.append(
                f'[s{i}a]scale={out_w}:{top_h}:force_original_aspect_ratio=decrease,pad={out_w}:{top_h}:(ow-iw)/2:(oh-ih)/2[t{i}a]'
            )
            # the speaker crop FITS its panel: the plan sizes that crop for a
            # different split than this one, and a stretched face is the most
            # visible failure the renderer can ship
            parts.append(f'[s{i}b]{pan_chain(seg_paths[0], f"p{i}b", out_w, bot_h, True)}[t{i}b]')
            parts.append(f'[t{i}a][t{i}b]vstack[v{i}]')
        elif layout_name == 'fixed_crop' and seg_paths:
            p = seg_paths[0]
            k = p['keyframes'][0]
            parts.append(f'{base},crop={p["w"]}:{p["h"]}:{k[1]}:{k[2]}:exact=1,scale={out_w}:{out_h}[v{i}]')
        elif layout_name == 'original':
            # the recording's own picture, letter/pillarboxed on a plain black
            # ground: the producer asked for no reframing at all
            parts.append(
                f'{base},scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=black[v{i}]'
            )
        elif out_w >= out_h:
            parts.append(
                f'{base},scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2[v{i}]'
            )
        else:  # full_frame: blur-pad
            parts.append(f'{base},split[f{i}a][f{i}b]')
            parts.append(
                f'[f{i}b]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},gblur=sigma=30,eq=brightness=-0.08[g{i}]'
            )
            parts.append(f'[f{i}a]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[h{i}]')
            parts.append(f'[g{i}][h{i}]overlay=(W-w)/2:(H-h)/2[v{i}]')
        # a crop window is rarely the exact output aspect, so scale keeps the
        # picture's shape by giving each piece its own (near-square) pixel
        # aspect — and concat refuses to join pieces whose SARs differ.
        # Square pixels everywhere: the sub-0.1 % stretch is invisible.
        parts.append(f'[v{i}]setsar=1[u{i}]')
        outs.append(f'[u{i}]')
    if len(outs) > 1:
        parts.append(''.join(outs) + f'concat=n={len(outs)}:v=1:a=0[joined]')
        tail = '[joined]'
    else:
        tail = outs[0]
    if logo:
        parts.extend(logo_chain(logo, out_w, out_h, logo_input, tail, '[logoed]'))
        tail = '[logoed]'
    if ass_path:
        parts.append(f"{tail}subtitles='{_escape_filter_path(ass_path)}'[captioned]")
        tail = '[captioned]'
    parts.append(f'{tail}{HOUSE_TAIL}[vout]')
    return ';'.join(parts)


MIN_PIECE_MS = 40  # a piece of the picture is at least about a frame long


def _cover_gap(pieces: list[dict], first: int, start_ms: int, end_ms: int) -> int:
    """
    A stretch of a keep range the plan does not describe. A real gap is
    rendered full frame and flagged `fallback`; a sliver too short to hold a
    frame is folded into the piece before it (or the one after, when it leads
    the range) rather than flashing another layout for one frame. `first` is
    where this keep range's pieces begin. Returns where the next piece starts.
    """
    if end_ms <= start_ms:
        return start_ms
    if end_ms - start_ms < MIN_PIECE_MS:
        if len(pieces) > first:
            pieces[-1]['end_ms'] = end_ms
            return end_ms
        return start_ms
    pieces.append(
        {
            'start_ms': start_ms,
            'end_ms': end_ms,
            'segment_index': None,
            'fallback': True,
            'segment': {'layout': 'full_frame', 'subjects': []},
        }
    )
    return end_ms


def layout_pieces(keep: list[tuple[int, int]], segments: list[dict]) -> list[dict]:
    """
    Keep segments split at layout boundaries: the units the layout graph
    renders, covering the keep list EXACTLY — the sound is cut from the same
    list, so any stretch the picture skipped would play under the wrong sound.
    Both lists are on the SAME clock — the plan has to be shifted onto the
    source timeline first (`plan.shift_framing`).

    Whatever the plan does not describe — a hole between its segments, a lead-
    in or a tail it never reached, a keep range it misses altogether — is
    rendered full frame and says so with `fallback`, so the caller can warn
    instead of silently shipping the wrong stretch of the recording. A plan
    segment that overlaps the one before it starts where that one ends.
    """
    ordered = sorted(
        ((int(seg['start_ms']), int(seg['end_ms']), idx, seg) for idx, seg in enumerate(segments)),
        key=lambda item: (item[0], item[1]),
    )
    pieces: list[dict] = []
    for s, e in keep:
        s, e = int(s), int(e)
        first, cursor = len(pieces), s
        for seg_start, seg_end, idx, seg in ordered:
            a, b = max(cursor, seg_start), min(e, seg_end)
            if b - a < MIN_PIECE_MS:
                continue
            a = _cover_gap(pieces, first, cursor, a)
            pieces.append({'start_ms': a, 'end_ms': b, 'segment_index': idx, 'segment': seg})
            cursor = b
        _cover_gap(pieces, first, cursor, e)
    return pieces


def render_layout_video(
    video_path: str | Path,
    clip_start_ms: int,
    clip_end_ms: int,
    keep: list[tuple[int, int]],
    layout: dict,
    audio_path: str | Path,
    out_path: str | Path,
    work: Path,
    ass_path: str | Path | None = None,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    logo: dict | None = None,
    logo_path: str | Path | None = None,
    source: dict | None = None,
) -> Path:
    """
    Render a clip through its layout plan (the audio is already cut and
    mastered). `keep` and the plan's segments/paths are both on the SOURCE
    clock; `clip_start_ms` is where the decode is seeked to.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    planned = layout.get('source') or {}
    width = int(planned.get('width') or (source or {}).get('width') or 0)
    height = int(planned.get('height') or (source or {}).get('height') or 0)
    if width <= 0 or height <= 0:
        raise ValueError('the framing plan does not say how big the recording is')
    pieces = layout_pieces(keep, layout['segments'])
    use_logo = logo if (logo and logo_path) else None
    graph = build_layout_graph(
        pieces,
        layout,
        width,
        height,
        fps,
        ass_path,
        work,
        logo=use_logo,
        logo_input=2,
        base_ms=clip_start_ms,
        source=source,
    )
    seconds = (clip_end_ms - clip_start_ms) / 1000
    brand = ['-loop', '1', '-framerate', str(fps), '-t', f'{seconds:.3f}', '-i', str(logo_path)] if use_logo else []
    run_ffmpeg(
        [
            '-y',
            '-ss',
            f'{clip_start_ms / 1000:.3f}',
            '-t',
            f'{(clip_end_ms - clip_start_ms) / 1000:.3f}',
            '-i',
            str(video_path),
            '-i',
            str(audio_path),
            *brand,
            '-filter_complex',
            graph,
            '-map',
            '[vout]',
            '-map',
            '1:a',
            *video_codec_args(out_path, crf, preset),
            '-r',
            str(fps),
            '-pix_fmt',
            'yuv420p',
            *VIDEO_COLOUR_ARGS,
            *mux_audio_args(out_path),
            *(['-movflags', '+faststart'] if out_path.suffix.lower() in ('.mp4', '.mov') else []),
            '-shortest',
            str(out_path),
        ]
    )
    return out_path


# --------------------------------------------------------- long programmes
#
# Rendering a whole timeline (a programme, a lecture, a stream) rather than a
# short piece: the picture in parts, lead-in / tail-out material, ducked music and
# mastering over the finished programme. Everything below is additive — the
# single-pass path above is untouched — and the same rules apply: trim +
# concat (never chained xfade), audio and video cut from the same keep list,
# mutes/bleeps on the source timeline, setsar=1 before every concat.
#
# `programme_*` are the long-timeline helpers.

PROGRAMME_PART_MS = 300_000  # ~5 minutes of output per rendered video part
PROGRAMME_MIN_PART_MS = 20_000  # a shorter tail is folded into the previous part
BLEEP_HZ = 1000
BLEEP_DB = -14.0
DUCK_THRESHOLD = 0.03
DUCK_ATTACK_MS = 20
DUCK_RELEASE_MS = 400
PROGRAMME_DECLICK_MS = 30

ASPECTS = {
    '16:9': (16, 9),
    '9:16': (9, 16),
    '1:1': (1, 1),
    '4:5': (4, 5),
    '5:4': (5, 4),
    '4:3': (4, 3),
    '3:4': (3, 4),
    '21:9': (21, 9),
}

# Friendly caption names mapped onto the burn-in presets in captions.py.
# (captions.resolve_caption_style knows the same aliases.)
CAPTION_STYLE_PRESETS = {
    'clean': 'minimal',
    'classic': 'classic',
    'bold': 'yellow-bold',
    'yellow': 'yellow-bold',
    'outline': 'white-outline',
    'minimal': 'minimal',
}

_WINDOWS_FONTS = (os.environ.get('WINDIR') or 'C:/Windows').replace('\\', '/') + '/Fonts'
_CARD_FONTS = (
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    f'{_WINDOWS_FONTS}/arial.ttf',
    f'{_WINDOWS_FONTS}/segoeui.ttf',
    f'{_WINDOWS_FONTS}/verdana.ttf',
)
NO_CARD_FONT_NOTE = (
    'media_render: no font file found for the title cards; drawtext is relying on '
    "ffmpeg's own font lookup (fontconfig), which some builds do not have"
)


def _matplotlib_font() -> str | None:
    """DejaVu Sans as matplotlib ships it — only if the engine happens to have it."""
    try:
        import matplotlib  # noqa: F401

        path = Path(matplotlib.get_data_path()) / 'fonts/ttf/DejaVuSans.ttf'
        return str(path) if path.exists() else None
    except Exception:  # noqa: BLE001
        return None


@lru_cache(maxsize=1)
def _note_no_card_font() -> None:
    """Said once per process, to the engine log when there is one."""
    try:
        from rocketlib import warning
    except Exception:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning(NO_CARD_FONT_NOTE)
        return
    warning(NO_CARD_FONT_NOTE)


def card_font_file() -> str | None:
    """
    A TTF for drawtext (ffmpeg has no fontconfig in some builds): the usual
    macOS, Linux and Windows system fonts, then matplotlib's. None = let ffmpeg
    pick, which is noted once — a card that then cannot draw its text is
    rendered blank with a warning (`render_card`), and the note says why.
    """
    for candidate in _CARD_FONTS:
        if os.path.exists(candidate):
            return candidate
    path = _matplotlib_font()
    if path:
        return path
    _note_no_card_font()
    return None


def parse_aspect(aspect: str | None) -> tuple[int, int]:
    if isinstance(aspect, str) and aspect in ASPECTS:
        return ASPECTS[aspect]
    text = str(aspect or '16:9').replace('x', ':').strip()
    try:
        w, h = text.split(':')
        wi, hi = int(float(w)), int(float(h))
        if wi > 0 and hi > 0:
            return wi, hi
    except (ValueError, TypeError):
        pass
    return 16, 9


def aspect_dims(aspect: str | None, short_edge: int = 1080) -> tuple[int, int]:
    """Output geometry from the SHORT edge: 16:9 -> 1920x1080, 9:16 -> 1080x1920, 1:1 -> 1080x1080."""
    w, h = parse_aspect(aspect)
    short_edge = int(short_edge) // 2 * 2
    if w <= h:
        width, height = short_edge, int(round(short_edge * h / w))
    else:
        height, width = short_edge, int(round(short_edge * w / h))
    return width // 2 * 2, height // 2 * 2


def capped_dims(aspect: str | None, max_edge: int) -> tuple[int, int]:
    """Same shape, long edge capped (range previews and the rough pass)."""
    w, h = parse_aspect(aspect)
    long_edge = int(max_edge) // 2 * 2
    if w >= h:
        width, height = long_edge, int(round(long_edge * h / w))
    else:
        height, width = long_edge, int(round(long_edge * w / h))
    return max(2, width // 2 * 2), max(2, height // 2 * 2)


def quality_block(
    tier: str,
    check: dict | None,
    *,
    crf: int,
    preset: str,
    channels: int,
    source_width=None,
    source_height=None,
    fps=None,
    width=None,
    height=None,
) -> dict:
    """
    The report's `quality` record: what the file REALLY is (probed), next to
    the settings it was encoded with and the source it came from. `upscaled`
    is a measurement, not a promise — it is True only if the output really is
    larger than the recording.
    """
    check = check if isinstance(check, dict) else {}
    out_w = int(check.get('width') or width or 0)
    out_h = int(check.get('height') or height or 0)
    src_w = int(source_width or 0)
    src_h = int(source_height or 0)
    measured_fps = check.get('fps') or fps
    return {
        'tier': str(tier),
        'width': out_w,
        'height': out_h,
        'fps': round(float(measured_fps), 3) if measured_fps else None,
        'video_codec': check.get('video_codec') or ('h264' if out_w else None),
        'crf': int(crf),
        'preset': str(preset),
        'audio_channels': int(check.get('audio_channels') or channels or 0),
        'source_width': src_w or None,
        'source_height': src_h or None,
        'upscaled': bool(src_w and src_h and out_w and out_h and max(out_w, out_h) > max(src_w, src_h)),
    }


def caption_layout_for(width: int, height: int) -> str:
    """Which caption geometry (captions.CAPTION_LAYOUTS) fits an output frame."""
    return 'vertical' if height > width else 'wide'


# ------------------------------------------------------------------- ranges


def range_to_keep(map_rows: list, out_a: int, out_b: int) -> list[tuple[int, int]]:
    """
    Output-timeline window -> the source keep slices that produce it, using the
    prepared spec's map ([src_start, src_end, out_start] per kept segment).
    """
    out_a, out_b = int(out_a), int(out_b)
    if out_b <= out_a:
        return []
    slices: list[tuple[int, int]] = []
    for row in map_rows or []:
        src_s, src_e, out_s = int(row[0]), int(row[1]), int(row[2])
        out_e = out_s + (src_e - src_s)
        a, b = max(out_a, out_s), min(out_b, out_e)
        if b <= a:
            continue
        slices.append((src_s + (a - out_s), src_s + (b - out_s)))
    return slices


def shift_groups(groups: list[list[dict]], offset_ms: int, window_ms: int | None = None) -> list[list[dict]]:
    """Caption groups moved onto a part's / range's local timeline, dropping what falls outside."""
    out: list[list[dict]] = []
    for group in groups or []:
        words = []
        for w in group:
            start = int(w['start_ms']) - offset_ms
            end = int(w['end_ms']) - offset_ms
            if end <= 0 or (window_ms is not None and start >= window_ms):
                continue
            start = max(0, start)
            if window_ms is not None:
                end = min(window_ms, end)
            if end > start:
                words.append({**w, 'start_ms': start, 'end_ms': end})
        if words:
            out.append(words)
    return out


# ----------------------------------------------------- source -> output time


class TimelineMap:
    """
    Maps a time in the clip's source audio to the rendered output timeline,
    given the keep segments and the crossfade applied at each join.
    """

    def __init__(self, segments: list[tuple[int, int]], crossfades: list[int] | None = None):
        self.segments = [tuple(s) for s in segments]
        crossfades = crossfades or [0] * max(0, len(self.segments) - 1)
        self.offsets: list[int] = []
        out = 0
        for i, (start, end) in enumerate(self.segments):
            if i > 0:
                out -= crossfades[i - 1]
            self.offsets.append(out)
            out += end - start
        self.total_ms = out

    def to_output(self, t_ms: int) -> int | None:
        for (start, end), offset in zip(self.segments, self.offsets):
            if start <= t_ms <= end:
                return offset + (t_ms - start)
        return None


def map_words_to_output(words: list[dict], timeline: TimelineMap) -> list[dict]:
    """Re-time words onto the rendered timeline; words inside a cut are dropped."""
    mapped = []
    for w in words:
        start = timeline.to_output(w['start_ms'])
        end = timeline.to_output(w['end_ms'])
        if start is None or end is None or end <= start:
            continue
        mapped.append({**w, 'start_ms': start, 'end_ms': end})
    return mapped


# -------------------------------------------------------------- programme audio


def _range_expr(ranges: list[tuple[int, int]]) -> str:
    return '+'.join(f'between(t,{s / 1000:.3f},{e / 1000:.3f})' for s, e in ranges)


def programme_audio_graph(
    keep: list[tuple[int, int]],
    mutes: list[tuple[int, int]] | None = None,
    bleeps: list[tuple[int, int]] | None = None,
    *,
    noise_reduction: bool = True,
    high_pass: bool = True,
    compression: bool = True,
    music: dict | None = None,
    music_input: int = 1,
    fade_in_ms: int = PROGRAMME_DECLICK_MS,
    fade_out_ms: int = PROGRAMME_DECLICK_MS,
    source: str = '[0:a]',
    out_label: str = '[pre]',
) -> str:
    """
    The whole programme's audio in one graph, ending in `out_label` (before any
    loudnorm): mutes + bleeps on the SOURCE timeline, then the keep-list cuts,
    then clean-up, then music ducked under the speech with sidechaincompress.

    The cuts are taken at the millisecond values as given: this is the clock
    the picture parts are snapped to (`snap_segments`, `programme_part_graph`).
    """
    keep = [(int(s), int(e)) for s, e in keep if e > s]
    if not keep:
        raise ValueError('programme audio needs at least one keep segment')
    mutes = [(int(s), int(e)) for s, e in (mutes or []) if e > s]
    bleeps = [(int(s), int(e)) for s, e in (bleeps or []) if e > s]
    n = len(keep)
    parts: list[str] = []

    # 1. source-timeline gating: muted ranges and the speech under every bleep go to zero
    silenced = mutes + bleeps
    head = f'{source}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
    if silenced:
        head += ''.join(
            f",volume=enable='between(t,{s / 1000:.3f},{e / 1000:.3f})':volume=0:eval=frame" for s, e in silenced
        )
    parts.append(f'{head}[speech_src]')
    src = '[speech_src]'

    # 2. the bleep tone itself: a 1 kHz sine at -14 dB, audible only inside the bleep ranges
    if bleeps:
        tone_ms = max(e for _, e in bleeps)
        parts.append(
            f'sine=frequency={BLEEP_HZ}:sample_rate=48000:duration={tone_ms / 1000:.3f},'
            f'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
            f'volume={BLEEP_DB}dB,'
            f"volume=enable='not({_range_expr(bleeps)})':volume=0:eval=frame[tone]"
        )
        parts.append(f'{src}[tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[bleeped]')
        src = '[bleeped]'

    # 3. the cuts: atrim per keep segment + de-click ramps, then concat
    if n > 1:
        parts.append(f'{src}asplit={n}' + ''.join(f'[k{i}]' for i in range(n)))
    for i, (start, end) in enumerate(keep):
        length = (end - start) / 1000
        fade_out_at = max(0.0, length - DECLICK_FADE_S)
        piece_src = f'[k{i}]' if n > 1 else src
        parts.append(
            f'{piece_src}atrim=start={start / 1000:.3f}:end={end / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'afade=t=in:d={DECLICK_FADE_S},afade=t=out:st={fade_out_at:.3f}:d={DECLICK_FADE_S}[a{i}]'
        )
    if n > 1:
        parts.append(''.join(f'[a{i}]' for i in range(n)) + f'concat=n={n}:v=0:a=1[cat]')
        tail = '[cat]'
    else:
        tail = '[a0]'

    # 4. clean-up chain (each stage is a spec flag)
    chain = []
    if noise_reduction:
        chain.append('afftdn=nr=10:nf=-40')
    if high_pass:
        chain.append('highpass=f=80')
    if compression:
        chain.append('acompressor=threshold=0.126:ratio=2.5:attack=5:release=120')
    if chain:
        parts.append(f'{tail}{",".join(chain)}[clean]')
        tail = '[clean]'

    total_ms = sum(e - s for s, e in keep)

    # 5. music under the speech, ducked by a sidechain fed from the speech itself
    if music:
        gain_db = float(music.get('gain_db', -22))
        duck_db = abs(float(music.get('duck_db', -12)))
        fade_ms = int(music.get('fade_ms', 1500))
        ratio = max(2.0, min(20.0, round(duck_db / 1.5, 2)))
        parts.append(f'{tail}asplit=2[spk][sc]')
        music_fade_out = max(0.0, (total_ms - fade_ms) / 1000)
        parts.append(
            f'[{music_input}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
            f'aloop=loop=-1:size={total_ms * 48 + 48000},atrim=end={total_ms / 1000:.3f},asetpts=PTS-STARTPTS,'
            f'volume={gain_db}dB,'
            f'afade=t=in:d={fade_ms / 1000:.3f},afade=t=out:st={music_fade_out:.3f}:d={fade_ms / 1000:.3f}[mus]'
        )
        parts.append(
            f'[mus][sc]sidechaincompress=threshold={DUCK_THRESHOLD}:ratio={ratio}:'
            f'attack={DUCK_ATTACK_MS}:release={DUCK_RELEASE_MS}[duck]'
        )
        parts.append('[spk][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]')
        tail = '[mixed]'

    # 6. programme fades
    fade_out_at = max(0.0, (total_ms - fade_out_ms) / 1000)
    parts.append(
        f'{tail}afade=t=in:d={max(0, fade_in_ms) / 1000:.3f},'
        f'afade=t=out:st={fade_out_at:.3f}:d={max(0, fade_out_ms) / 1000:.3f}{out_label}'
    )
    return ';'.join(parts)


def render_programme_audio(
    src_media: str | Path,
    keep: list[tuple[int, int]],
    out_wav: str | Path,
    *,
    mutes: list[tuple[int, int]] | None = None,
    bleeps: list[tuple[int, int]] | None = None,
    noise_reduction: bool = True,
    high_pass: bool = True,
    compression: bool = True,
    music_path: str | Path | None = None,
    music: dict | None = None,
    master: bool = True,
    loudness_lufs: float = LOUDNESS_TARGET_LUFS,
    true_peak: float = TRUE_PEAK_DBTP,
    channels: int = 2,
    warnings: list[str] | None = None,
) -> Path:
    """
    One full-length audio pass for an programme: cuts, mutes, bleeps, clean-up,
    ducked music and (when `master`) the two-pass loudnorm to the target LUFS —
    `loudnorm_filter`'s second pass, silence passed through (`mastering_pass`).
    """
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    music_cfg = music if (music and music_path) else None
    graph = programme_audio_graph(
        keep,
        mutes,
        bleeps,
        noise_reduction=noise_reduction,
        high_pass=high_pass,
        compression=compression,
        music=music_cfg,
        music_input=1,
    )
    inputs = ['-i', str(src_media)]
    if music_cfg:
        inputs += ['-i', str(music_path)]

    tail = 'aresample=48000'
    if master:
        base = loudnorm_filter(loudness_lufs, true_peak=true_peak)
        measure = _run_process(
            [
                ffmpeg_exe(),
                '-hide_banner',
                '-nostdin',
                *inputs,
                '-filter_complex',
                f'{graph};[pre]{base}:print_format=json[out]',
                '-map',
                '[out]',
                '-f',
                'null',
                '-',
            ],
            check=False,
            text=True,
        )
        second = mastering_pass(loudness_lufs, _loudnorm_stats(measure.stderr), true_peak, warnings)
        if second:
            tail = f'{second},aresample=48000'

    run_ffmpeg(
        [
            '-y',
            *inputs,
            '-filter_complex',
            f'{graph};[pre]{tail}[out]',
            '-map',
            '[out]',
            '-ar',
            '48000',
            '-ac',
            str(int(channels)),
            '-c:a',
            'pcm_s16le',
            str(out_wav),
        ]
    )
    return out_wav


def assemble_programme_audio(pieces: list[dict], out_wav: str | Path, channels: int = 2) -> Path:
    """
    Join the mastered body with the intro/outro audio and the silent card gaps,
    in the order the video parts are concatenated. `pieces` items are either
    {'path': ...} or {'silence_ms': n}.
    """
    out_wav = Path(out_wav)
    if len(pieces) == 1 and pieces[0].get('path'):
        return Path(pieces[0]['path'])
    inputs: list[str] = []
    labels: list[str] = []
    parts: list[str] = []
    for i, piece in enumerate(pieces):
        if piece.get('path'):
            inputs += ['-i', str(piece['path'])]
        else:
            seconds = max(0.001, int(piece.get('silence_ms') or 0) / 1000)
            inputs += ['-f', 'lavfi', '-t', f'{seconds:.3f}', '-i', 'anullsrc=r=48000:cl=stereo']
        parts.append(
            f'[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[p{i}]'
        )
        labels.append(f'[p{i}]')
    parts.append(''.join(labels) + f'concat=n={len(labels)}:v=0:a=1[out]')
    run_ffmpeg(
        [
            '-y',
            *inputs,
            '-filter_complex',
            ';'.join(parts),
            '-map',
            '[out]',
            '-ar',
            '48000',
            '-ac',
            str(int(channels)),
            '-c:a',
            'pcm_s16le',
            str(out_wav),
        ]
    )
    return out_wav


def audio_codec_args(out_path: str | Path, mp3_bitrate: str = '192k') -> list[str]:
    """Select a codec supported by the requested audio delivery container."""
    extension = Path(out_path).suffix.lower()
    if extension == '.mp3':
        return ['-c:a', 'libmp3lame', '-b:a', mp3_bitrate]
    if extension in ('.m4a', '.aac'):
        return ['-c:a', 'aac', '-b:a', '192k']
    if extension == '.flac':
        return ['-c:a', 'flac']
    return ['-c:a', 'pcm_s16le']


def video_codec_args(out_path: str | Path, crf: int, preset: str) -> list[str]:
    """Select compatible video encoding options without changing MP4 defaults."""
    if Path(out_path).suffix.lower() == '.webm':
        return [
            '-c:v',
            'libvpx-vp9',
            '-b:v',
            '0',
            '-crf',
            str(max(0, min(63, crf))),
            '-deadline',
            'good',
            '-cpu-used',
            '4',
        ]
    return ['-c:v', 'libx264', '-preset', preset, '-crf', str(crf)]


def mux_audio_args(out_path: str | Path, bitrate: str = '192k') -> list[str]:
    """Use Opus for WebM and AAC for the existing video containers."""
    return ['-c:a', 'libopus' if Path(out_path).suffix.lower() == '.webm' else 'aac', '-b:a', bitrate]


def encode_audio_deliverable(src_wav: str | Path, out_path: str | Path) -> Path:
    """Encode finished audio as MP3, WAV, M4A, AAC or FLAC."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    codec = audio_codec_args(out_path)
    run_ffmpeg(['-y', '-i', str(src_wav), '-vn', '-ar', '48000', *codec, str(out_path)])
    return out_path


# -------------------------------------------------------------- programme video


def plan_programme_parts(
    keep: list[tuple[int, int]], part_ms: int = PROGRAMME_PART_MS, min_part_ms: int = PROGRAMME_MIN_PART_MS
) -> list[dict]:
    """
    Split the keep list into ~`part_ms` chunks of OUTPUT time. A keep segment
    longer than a part is split inside itself (an exact source cut — the audio
    is rendered separately in one pass, so nothing can drift).
    """
    keep = [(int(s), int(e)) for s, e in keep if e > s]
    if not keep:
        return []
    part_ms = max(1000, int(part_ms))
    chunks: list[list[tuple[int, int]]] = []
    current: list[tuple[int, int]] = []
    used = 0
    for start, end in keep:
        cursor = start
        while cursor < end:
            room = part_ms - used
            if room <= 0:
                chunks.append(current)
                current, used, room = [], 0, part_ms
            take = min(end - cursor, room)
            if (end - cursor) - take < 200:  # never leave a sub-frame sliver behind
                take = end - cursor
            current.append((cursor, cursor + take))
            used += take
            cursor += take
    if current:
        chunks.append(current)
    if len(chunks) > 1 and sum(e - s for s, e in chunks[-1]) < min_part_ms:
        chunks[-2].extend(chunks.pop())
    parts = []
    out = 0
    for i, segments in enumerate(chunks):
        duration = sum(e - s for s, e in segments)
        parts.append(
            {
                'n': i + 1,
                'keep': [[s, e] for s, e in segments],
                'out_start_ms': out,
                'out_end_ms': out + duration,
                'duration_ms': duration,
            }
        )
        out += duration
    return parts


# Fields that measure a RUN rather than describe an edit. They travel inside
# plans, reports and specs (`seconds` is how long a node took, `*_at` is when),
# and two identical renders differ in every one of them — so an identity that
# hashed them would call one edit two different renders.
# (`reused` is one of these: a plan that was kept rather than made again
# describes exactly the same edit.)
VOLATILE_KEYS = ('seconds', 'status_meta', 'reused')
VOLATILE_SUFFIX = '_at'
# …except inside a card, where `seconds` is how long the card is on screen.
OPAQUE_KEYS = ('cards',)


def strip_volatile(value, keys: tuple[str, ...] = VOLATILE_KEYS):
    """A document with its runtime measurements removed, at every depth."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            name = str(key)
            if name in keys or name.endswith(VOLATILE_SUFFIX):
                continue
            out[key] = item if name in OPAQUE_KEYS else strip_volatile(item, keys)
        return out
    if isinstance(value, list):
        return [strip_volatile(item, keys) for item in value]
    return value


# A float this size or larger is past the point where every integer is still
# exactly a float, and past where a JSON writer prints one without an exponent.
# Below it, `1.0` and `1` are the same number written twice; above it, whatever
# the document says is left exactly as it stands.
WHOLE_FLOAT_LIMIT = 2**53


def canonical_numbers(value):
    """
    The same number spelled the same way, whoever wrote the document.

    JSON has one number type. Python spells a whole float `1.0` and every other
    JSON writer — the browser's spec builder included — spells it `1`, so the
    identical spec hashed on the two sides of the wire produced two different
    keys, and one clip was two renders depending on who had prepared it. Whole
    floats become ints before the hash is taken, at every depth, which is what
    the wire does to them anyway. Nothing else moves: a fraction, an infinity, a
    NaN, an int, a bool and a string are all left alone.
    """
    if isinstance(value, float):
        return int(value) if value.is_integer() and abs(value) < WHOLE_FLOAT_LIMIT else value
    if isinstance(value, dict):
        return {key: canonical_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonical_numbers(item) for item in value]
    return value


def spec_hash(spec: dict, exclude: tuple[str, ...] = ('range', 'quality', 'prepared_at', 'warnings')) -> str:
    """
    Identity of a render: the prepared spec minus the fields that do not change
    the picture (the requested range, the quality preset, and — at every depth —
    the runtime measurements a node stamps into its own output). This hash only
    names a render; it selects nothing and provides no render cache. Every
    render executes.

    The spec is canonicalised first (`canonical_numbers`), so a document and its
    JSON round trip are one identity and not two.
    """
    import hashlib

    trimmed = {k: v for k, v in (spec or {}).items() if k not in exclude}
    blob = json.dumps(canonical_numbers(strip_volatile(trimmed)), sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:16]


def reframe_chain(out_w: int, out_h: int, fit: str = 'fit', background: str = 'blur') -> list[str]:
    """
    Aspect conversion as a list of graph statements taking [rf_in] to [rf_out]:
    `fill` crops to cover, `fit` letterboxes on a blurred copy or a flat colour.
    Always ends in setsar=1 so concat accepts every piece.
    """
    if str(fit).lower() == 'fill':
        return [
            f'[rf_in]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},setsar=1[rf_out]'
        ]
    if str(background or 'blur').lower() == 'blur':
        return [
            '[rf_in]split[rf_fg][rf_bg]',
            f'[rf_bg]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},'
            f'gblur=sigma=30,eq=brightness=-0.08[rf_bgo]',
            f'[rf_fg]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[rf_fgo]',
            '[rf_bgo][rf_fgo]overlay=(W-w)/2:(H-h)/2,setsar=1[rf_out]',
        ]
    colour = str(background or 'black')
    if colour.startswith('#'):
        colour = '0x' + colour[1:]
    return [
        f'[rf_in]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,'
        f'pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color={colour},setsar=1[rf_out]'
    ]


def logo_chain(logo: dict, out_w: int, out_h: int, logo_input: int, video_label: str, out_label: str) -> list[str]:
    """A watermark scaled to a fraction of the frame height, in one of the four corners."""
    height = max(8, int(round(out_h * float(logo.get('height', 0.10) or 0.10))))
    opacity = max(0.0, min(1.0, float(logo.get('opacity', 1.0) if logo.get('opacity') is not None else 1.0)))
    margin = max(8, int(round(out_h * 0.04)))
    corner = str(logo.get('corner') or 'tr').lower()
    x = f'W-w-{margin}' if corner in ('tr', 'br') else f'{margin}'
    y = f'H-h-{margin}' if corner in ('bl', 'br') else f'{margin}'
    return [
        f'[{logo_input}:v]scale=-1:{height},format=rgba,colorchannelmixer=aa={opacity:.3f}[lg]',
        f'{video_label}[lg]overlay={x}:{y}:format=auto:shortest=1{out_label}',
    ]


def programme_part_graph(
    segments_ms: list[tuple[int, int]],
    out_w: int,
    out_h: int,
    fps: int,
    *,
    fit: str = 'fit',
    background: str = 'blur',
    ass_path: str | Path | None = None,
    logo: dict | None = None,
    logo_input: int = 1,
    base_ms: int = 0,
    source: dict | None = None,
    output_start_ms: int = 0,
) -> str:
    """
    One part of the programme: its keep slices trimmed out of the
    (already seeked) decode on the frame grid (`snap_segments`, so the part
    holds exactly the frames its slice of the one-pass audio does), squared up
    if the recording has non-square pixels (C3), concatenated, reframed to the
    output aspect, the logo overlaid and the captions burned in. Ends in [vout].
    """
    usable = snap_segments(segments_ms, fps, base_ms, output_start_ms=output_start_ms)
    if not usable:
        raise ValueError('No keep slice in this part is long enough to hold a video frame')
    n = len(usable)
    # A seek between source frames can leave the last rounded frame beyond
    # EOF. Hold the last picture for at most one frame; the trims below still
    # enforce the exact cumulative frame budget, including on the final part.
    parts = [
        f'[0:v]{source_normalize(source)}{square_pixels(source)}fps={fps},setpts=PTS-STARTPTS,'
        f'tpad=stop_mode=clone:stop=1,split={n}' + ''.join(f'[b{i}]' for i in range(n))
    ]
    for i, (first, last) in enumerate(usable):
        parts.append(
            f'[b{i}]trim=start={_frame_time(first, fps)}:end={_frame_time(last, fps)},'
            f'setpts=PTS-STARTPTS,setsar=1[v{i}]'
        )
    if n > 1:
        parts.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[joined]')
        tail = '[joined]'
    else:
        tail = '[v0]'
    parts.append(f'{tail}null[rf_in]')
    parts.extend(reframe_chain(out_w, out_h, fit, background))
    tail = '[rf_out]'
    if logo:
        parts.extend(logo_chain(logo, out_w, out_h, logo_input, tail, '[logoed]'))
        tail = '[logoed]'
    if ass_path:
        parts.append(f"{tail}subtitles='{_escape_filter_path(ass_path)}'[captioned]")
        tail = '[captioned]'
    parts.append(f'{tail}{HOUSE_TAIL}[vout]')
    return ';'.join(parts)


def render_programme_part(
    video_path: str | Path,
    segments_ms: list[tuple[int, int]],
    out_path: str | Path,
    out_w: int,
    out_h: int,
    *,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    fit: str = 'fit',
    background: str = 'blur',
    ass_path: str | Path | None = None,
    logo: dict | None = None,
    logo_path: str | Path | None = None,
    source: dict | None = None,
    output_start_ms: int = 0,
) -> Path:
    """Encode one video-only part (captions burned in; the audio is a separate pass)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = int(min(s for s, _ in segments_ms))
    last = int(max(e for _, e in segments_ms))
    use_logo = logo if (logo and logo_path) else None
    graph = programme_part_graph(
        segments_ms,
        out_w,
        out_h,
        fps,
        fit=fit,
        background=background,
        ass_path=ass_path,
        logo=use_logo,
        logo_input=1,
        base_ms=base,
        source=source,
        output_start_ms=output_start_ms,
    )
    inputs = ['-ss', f'{base / 1000:.3f}', '-t', f'{(last - base) / 1000:.3f}', '-i', str(video_path)]
    if use_logo:
        # a looped still never ends on its own: bound it and let overlay finish with the picture
        inputs += ['-loop', '1', '-framerate', str(fps), '-t', f'{(last - base) / 1000:.3f}', '-i', str(logo_path)]
    run_ffmpeg(
        [
            '-y',
            *inputs,
            '-filter_complex',
            graph,
            '-map',
            '[vout]',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            preset,
            '-crf',
            str(crf),
            '-r',
            str(fps),
            '-pix_fmt',
            'yuv420p',
            *VIDEO_COLOUR_ARGS,
            '-movflags',
            '+faststart',
            str(out_path),
        ]
    )
    return out_path


def render_layout_part(
    video_path: str | Path,
    keep: list[tuple[int, int]],
    layout: dict,
    out_path: str | Path,
    work: Path,
    *,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    ass_path: str | Path | None = None,
    logo: dict | None = None,
    logo_path: str | Path | None = None,
    source: dict | None = None,
    output_start_ms: int = 0,
) -> Path:
    """
    One video-only programme part rendered THROUGH the framing plan — the
    programme path's answer to `render_layout_video`, so a reframed clip can
    still have an intro and an outro concatenated around it.

    `keep` and the plan are both on the SOURCE clock; the decode is seeked to
    the part's first keep start and the graph's trims are relative to it, the
    same contract `render_programme_part` keeps. Video only: a programme's
    sound is one full-length pass, mastered after the parts are joined.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = int(min(s for s, _ in keep))
    last = int(max(e for _, e in keep))
    # the display size the crops were planned against; a plan that never stated
    # it is read off the probe rather than failing a whole programme export
    planned = layout.get('source') or {}
    width = int(planned.get('width') or (source or {}).get('width') or 0)
    height = int(planned.get('height') or (source or {}).get('height') or 0)
    if width <= 0 or height <= 0:
        raise ValueError('the framing plan does not say how big the recording is')
    pieces = layout_pieces(keep, layout.get('segments') or [])
    use_logo = logo if (logo and logo_path) else None
    graph = build_layout_graph(
        pieces,
        layout,
        width,
        height,
        fps,
        ass_path,
        work,
        logo=use_logo,
        logo_input=1,
        base_ms=base,
        source=source,
        output_start_ms=output_start_ms,
    )
    inputs = ['-ss', f'{base / 1000:.3f}', '-t', f'{(last - base) / 1000:.3f}', '-i', str(video_path)]
    if use_logo:
        # a looped still never ends on its own: bound it and let overlay finish with the picture
        inputs += ['-loop', '1', '-framerate', str(fps), '-t', f'{(last - base) / 1000:.3f}', '-i', str(logo_path)]
    run_ffmpeg(
        [
            '-y',
            *inputs,
            '-filter_complex',
            graph,
            '-map',
            '[vout]',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            preset,
            '-crf',
            str(crf),
            '-r',
            str(fps),
            '-pix_fmt',
            'yuv420p',
            *VIDEO_COLOUR_ARGS,
            '-movflags',
            '+faststart',
            str(out_path),
        ]
    )
    return out_path


def _escape_drawtext(text: str) -> str:
    """
    A title as drawtext's `text='…'` value. The value is unescaped TWICE before
    drawtext reads it — by the graph parser, which leaves a single-quoted
    section alone, then by the option parser, which turns `\\x` into `x` and
    reads a bare `'` as a quote of its own — and drawtext then expands `\\x`
    and `%{…}` a third time. So `:` is escaped once (for the option parser),
    `%` and `\\` twice (one backslash for the option parser, one for drawtext)
    and a `'` steps outside the quotes and back: `'\\\\\\''`. Measured, not
    reasoned (ffmpeg 7.1 and 8.1): `\\'` inside the quotes closes them early
    (rc=8, blank card), a single `\\%` is a "Stray %" and a blank card, and a
    single `\\\\` draws nothing where the backslash was.
    """
    out = str(text or '').replace('\\', '\\\\\\\\')
    out = out.replace("'", "'\\\\\\''")
    out = out.replace(':', '\\:')
    return out.replace('%', '\\\\%')


def card_graph(text: str, subtitle: str, out_w: int, out_h: int, font: str | None = None, colour: str = 'white') -> str:
    """Drawtext over a flat colour source: the title / end card."""
    font_arg = f":fontfile='{_escape_filter_path(font)}'" if font else ''
    size = max(24, int(out_h * 0.075))
    sub_size = max(18, int(out_h * 0.040))
    parts = [
        f"[0:v]drawtext=text='{_escape_drawtext(text)}':fontcolor={colour}:fontsize={size}"
        f'{font_arg}:x=(w-text_w)/2:y=(h-text_h)/2-{int(out_h * 0.03)}[t1]'
    ]
    tail = '[t1]'
    if subtitle:
        parts.append(
            f"{tail}drawtext=text='{_escape_drawtext(subtitle)}':fontcolor=0xBBBBBB:fontsize={sub_size}"
            f'{font_arg}:x=(w-text_w)/2:y=(h+text_h)/2+{int(out_h * 0.05)}[t2]'
        )
        tail = '[t2]'
    parts.append(f'{tail}setsar=1,{HOUSE_TAIL}[vout]')
    return ';'.join(parts)


def render_card(
    text: str,
    subtitle: str,
    seconds: float,
    out_path: str | Path,
    out_w: int,
    out_h: int,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    background: str = '0x111111',
    warnings: list[str] | None = None,
) -> Path:
    """
    A silent title / end card part, generated with lavfi (no assets needed). A
    build that cannot draw text at all (no drawtext filter, no usable font)
    still gets the card, blank, and `warnings` — when given — says so; any
    other failure is the render's, and is raised.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    seconds = max(0.5, float(seconds or 3))
    source = f'color=c={background}:s={out_w}x{out_h}:r={fps}:d={seconds:.3f}'
    encode = [
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-crf',
        str(crf),
        '-r',
        str(fps),
        '-pix_fmt',
        'yuv420p',
        *VIDEO_COLOUR_ARGS,
        '-movflags',
        '+faststart',
        str(out_path),
    ]
    graph = card_graph(text, subtitle, out_w, out_h, card_font_file())
    try:
        run_ffmpeg(
            [
                '-y',
                '-f',
                'lavfi',
                '-i',
                source,
                '-filter_complex',
                graph,
                '-map',
                '[vout]',
                '-an',
                '-t',
                f'{seconds:.3f}',
                *encode,
            ]
        )
    except RuntimeError as exc:
        # a build without drawtext (no libfreetype) or without a font it can
        # use still gets the timing right — and the producer is told the card
        # is blank. A timeout is not retried: the fallback would only spend a
        # second full timeout on the same machine.
        if not card_text_unavailable(exc):
            raise
        if warnings is not None and BLANK_CARD_WARNING not in warnings:
            warnings.append(BLANK_CARD_WARNING)
        run_ffmpeg(
            ['-y', '-f', 'lavfi', '-i', source, '-vf', f'setsar=1,{HOUSE_TAIL}', '-an', '-t', f'{seconds:.3f}', *encode]
        )
    return out_path


BLANK_CARD_WARNING = 'This toolchain cannot draw text on the title cards, so they were rendered without it.'

# what ffmpeg says when drawtext is not built in, or is but has no font to draw with
_NO_CARD_TEXT = re.compile(
    r"No such filter: 'drawtext'|Filter not found|No font filename provided|Cannot find a valid font"
    r'|Could not load font|Could not load FreeType|impossible to init fontconfig|Cannot load default config file',
    re.I,
)


def card_text_unavailable(exc: Exception) -> bool:
    """
    Whether a failed card render is the one `render_card` may retry without
    text: ffmpeg's own words on a missing drawtext filter or an unusable font.
    Only the stderr tail is read — the command line after it names the filter
    and the font file itself. A timeout is never that case.
    """
    text = str(exc).split('\ncommand:', 1)[0]
    if text.startswith('ffmpeg timed out'):
        return False
    return _NO_CARD_TEXT.search(text) is not None


def render_asset_part(
    asset_path: str | Path,
    out_path: str | Path,
    out_w: int,
    out_h: int,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    fit: str = 'fit',
    background: str = 'blur',
    source: dict | None = None,
) -> Path:
    """An intro / outro clip conformed to the programme's geometry (video only, SAR 1)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    parts = [f'[0:v]{source_normalize(source)}{square_pixels(source)}fps={fps},setpts=PTS-STARTPTS,null[rf_in]']
    parts.extend(reframe_chain(out_w, out_h, fit, background))
    parts.append(f'[rf_out]{HOUSE_TAIL}[vout]')
    run_ffmpeg(
        [
            '-y',
            '-i',
            str(asset_path),
            '-filter_complex',
            ';'.join(parts),
            '-map',
            '[vout]',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            preset,
            '-crf',
            str(crf),
            '-r',
            str(fps),
            '-pix_fmt',
            'yuv420p',
            *VIDEO_COLOUR_ARGS,
            '-movflags',
            '+faststart',
            str(out_path),
        ]
    )
    return out_path


def concat_parts(paths: list[str | Path], out_path: str | Path, work: Path) -> Path:
    """
    Join the encoded parts with the concat demuxer (stream copy — every part was
    encoded with the same settings). Falls back to a re-encode if copy fails.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if len(paths) == 1:
        shutil_copy(paths[0], out_path)
        return out_path
    listing = Path(work) / 'parts.txt'
    listing.write_text('\n'.join(f"file '{Path(p).as_posix()}'" for p in paths) + '\n', encoding='utf-8')
    try:
        run_ffmpeg(
            [
                '-y',
                '-f',
                'concat',
                '-safe',
                '0',
                '-i',
                str(listing),
                '-c',
                'copy',
                '-movflags',
                '+faststart',
                str(out_path),
            ]
        )
    except RuntimeError:
        run_ffmpeg(
            [
                '-y',
                '-f',
                'concat',
                '-safe',
                '0',
                '-i',
                str(listing),
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-crf',
                '20',
                '-pix_fmt',
                'yuv420p',
                *VIDEO_COLOUR_ARGS,
                '-movflags',
                '+faststart',
                str(out_path),
            ]
        )
    return out_path


def shutil_copy(src: str | Path, dst: str | Path) -> Path:
    import shutil

    shutil.copyfile(str(src), str(dst))
    return Path(dst)


def mux_programme(
    video_path: str | Path, audio_path: str | Path, out_path: str | Path, audio_bitrate: str = '192k'
) -> Path:
    """Final mux: the concatenated picture + the one-pass mastered audio."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(
        [
            '-y',
            '-i',
            str(video_path),
            '-i',
            str(audio_path),
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            *(video_codec_args(out_path, 20, 'veryfast') if out_path.suffix.lower() == '.webm' else ['-c:v', 'copy']),
            *mux_audio_args(out_path, audio_bitrate),
            *(['-movflags', '+faststart'] if out_path.suffix.lower() in ('.mp4', '.mov') else []),
            '-shortest',
            str(out_path),
        ]
    )
    return out_path


def transcode_aspect(
    src_path: str | Path,
    out_path: str | Path,
    out_w: int,
    out_h: int,
    fps: int = 30,
    crf: int = 20,
    preset: str = 'veryfast',
    fit: str = 'fit',
    background: str = 'blur',
    audio_bitrate: str = '192k',
) -> Path:
    """An extra aspect of a finished programme (same audio, reframed picture)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    parts = ['[0:v]null[rf_in]']
    parts.extend(reframe_chain(out_w, out_h, fit, background))
    parts.append(f'[rf_out]{HOUSE_TAIL}[vout]')
    run_ffmpeg(
        [
            '-y',
            '-i',
            str(src_path),
            '-filter_complex',
            ';'.join(parts),
            '-map',
            '[vout]',
            '-map',
            '0:a?',
            *video_codec_args(out_path, crf, preset),
            '-r',
            str(fps),
            '-pix_fmt',
            'yuv420p',
            *VIDEO_COLOUR_ARGS,
            *mux_audio_args(out_path, audio_bitrate),
            *(['-movflags', '+faststart'] if out_path.suffix.lower() in ('.mp4', '.mov') else []),
            str(out_path),
        ]
    )
    return out_path


# ------------------------------------------------------------------ chapters


def ffmetadata_chapters(chapters: list[dict], total_ms: int, title: str | None = None) -> str:
    """
    ;FFMETADATA1 chapter list (TIMEBASE 1/1000) — the file media hosts and
    `ffmpeg -i chapters.txt` accept.
    """

    def esc(text: str) -> str:
        out = str(text or '')
        for ch in ('\\', '=', ';', '#'):
            out = out.replace(ch, '\\' + ch)
        return out.replace('\n', ' ')

    lines = [';FFMETADATA1']
    if title:
        lines.append(f'title={esc(title)}')
    marks = sorted(
        (
            {'title': c.get('title') or f'Chapter {i + 1}', 'out_ms': max(0, int(c.get('out_ms') or 0))}
            for i, c in enumerate(chapters or [])
        ),
        key=lambda c: c['out_ms'],
    )
    for i, mark in enumerate(marks):
        end = marks[i + 1]['out_ms'] if i + 1 < len(marks) else max(int(total_ms), mark['out_ms'] + 1)
        if end <= mark['out_ms']:
            continue
        lines += [
            '',
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            f'START={mark["out_ms"]}',
            f'END={end}',
            f'title={esc(mark["title"])}',
        ]
    return '\n'.join(lines) + '\n'


def chapters_payload(chapters: list[dict], total_ms: int) -> dict:
    """chapters.json — the same marks with end times and hh:mm:ss labels."""
    marks = sorted(
        (
            {'title': c.get('title') or f'Chapter {i + 1}', 'start_ms': max(0, int(c.get('out_ms') or 0))}
            for i, c in enumerate(chapters or [])
        ),
        key=lambda c: c['start_ms'],
    )
    out = []
    for i, mark in enumerate(marks):
        end = marks[i + 1]['start_ms'] if i + 1 < len(marks) else max(int(total_ms), mark['start_ms'])
        out.append(
            {'title': mark['title'], 'start_ms': mark['start_ms'], 'end_ms': end, 'start': _hhmmss(mark['start_ms'])}
        )
    return {'schema_version': 1, 'duration_ms': int(total_ms), 'chapters': out}


def _hhmmss(ms: int) -> str:
    s = max(0, int(ms)) // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{sec:02d}'


def conform_audio(src: str | Path, out_wav: str | Path, duration_ms: int) -> Path:
    """An asset's audio padded/trimmed to exactly its rendered part's length."""
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    seconds = max(0.001, int(duration_ms) / 1000)
    run_ffmpeg(
        [
            '-y',
            '-i',
            str(src),
            '-vn',
            '-af',
            'apad',
            '-t',
            f'{seconds:.3f}',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-c:a',
            'pcm_s16le',
            str(out_wav),
        ]
    )
    return out_wav
