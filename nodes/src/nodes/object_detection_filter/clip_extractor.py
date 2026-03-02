# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
FFmpeg-based clip extraction.

Given a cached source video and a list of temporal segments, trims out
individual video clips using stream-copy for speed.
"""

import subprocess
import tempfile
from dataclasses import dataclass
from typing import List, TYPE_CHECKING

if TYPE_CHECKING:
    from .segment_tracker import Segment


@dataclass
class ClipInfo:
    """Metadata for a single extracted clip file."""

    path: str
    start_time: float
    end_time: float
    duration: float
    segment: Segment


def extract_clips(
    video_path: str,
    segments: List[Segment],
    *,
    pre_roll_sec: float = 2.0,
    post_roll_sec: float = 2.0,
    min_clip_sec: float = 3.0,
    max_clip_sec: float = 60.0,
) -> List[ClipInfo]:
    """
    Extract one clip per segment from the source video.

    Each clip window is the segment span expanded by *pre_roll_sec* /
    *post_roll_sec*, clamped to *min_clip_sec* and *max_clip_sec*.
    Uses ``-c copy`` (stream-copy) so no re-encode is needed.

    Args:
        video_path:   Path to the cached source video file.
        segments:     Segments produced by :class:`SegmentTracker`.
        pre_roll_sec: Seconds to include before the first detection.
        post_roll_sec: Seconds to include after the last detection.
        min_clip_sec: Minimum clip duration (padded symmetrically if needed).
        max_clip_sec: Maximum clip duration (0 = unlimited).

    Returns:
        List of :class:`ClipInfo` with paths to temp clip files.
        Caller is responsible for deleting the files after use.
    """
    import imageio_ffmpeg as ffmpeg
    from .segment_tracker import Segment  # noqa: F811

    ffexec = ffmpeg.get_ffmpeg_exe()
    clips: List[ClipInfo] = []

    for idx, seg in enumerate(segments):
        start = max(0.0, seg.start_time - pre_roll_sec)
        end = seg.end_time + post_roll_sec
        duration = end - start

        if duration < min_clip_sec:
            centre = (start + end) / 2.0
            start = max(0.0, centre - min_clip_sec / 2.0)
            duration = min_clip_sec

        if max_clip_sec > 0 and duration > max_clip_sec:
            duration = max_clip_sec

        out_path = tempfile.mktemp(suffix='.mp4', prefix=f'objdet_clip{idx}_')

        cmd = [
            ffexec,
            '-y',
            '-ss', f'{start:.3f}',
            '-i', video_path,
            '-t', f'{duration:.3f}',
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            out_path,
            '-hide_banner',
            '-loglevel', 'error',
        ]

        try:
            subprocess.run(cmd, check=True, timeout=120)
        except subprocess.CalledProcessError as exc:
            print(f'[ClipExtractor] FFmpeg failed for clip {idx}: {exc}')
            continue
        except subprocess.TimeoutExpired:
            print(f'[ClipExtractor] FFmpeg timed out for clip {idx}')
            continue

        clips.append(
            ClipInfo(
                path=out_path,
                start_time=start,
                end_time=start + duration,
                duration=duration,
                segment=seg,
            )
        )

    return clips
