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
Temporal segment tracker.

Collects per-frame detection hits and merges temporally adjacent frames
into contiguous segments that later become clip windows.
"""

from dataclasses import dataclass, field
from typing import List

from .detector import Detection


@dataclass
class FrameHit:
    """A single frame where at least one detection matched."""

    frame_number: int
    timestamp: float
    detections: List[Detection]


@dataclass
class Segment:
    """A contiguous run of matching frames that will become one clip."""

    start_time: float
    end_time: float
    start_frame: int
    end_frame: int
    frame_count: int
    avg_confidence: float
    avg_similarity: float
    peak_confidence: float
    peak_similarity: float


class SegmentTracker:
    """
    Accumulates per-frame detection hits and merges them into segments.

    Two consecutive hits are merged into the same segment when the gap
    between their timestamps is ≤ ``max_gap_sec``.  After all frames have
    been added, call :meth:`get_segments` to retrieve the final list.
    """

    def __init__(self, max_gap_sec: float = 2.0):
        self._max_gap_sec = max_gap_sec
        self._hits: List[FrameHit] = []

    def add_frame(
        self, frame_number: int, timestamp: float, detections: List[Detection]
    ):
        """Record a frame that had at least one matched detection."""
        if detections:
            self._hits.append(FrameHit(frame_number, timestamp, detections))

    def get_segments(self) -> List[Segment]:
        """
        Merge accumulated hits into contiguous segments and return them
        sorted by start time.
        """
        if not self._hits:
            return []

        self._hits.sort(key=lambda h: h.timestamp)

        segments: List[Segment] = []
        group: List[FrameHit] = [self._hits[0]]

        for i in range(1, len(self._hits)):
            gap = self._hits[i].timestamp - self._hits[i - 1].timestamp
            if gap <= self._max_gap_sec:
                group.append(self._hits[i])
            else:
                segments.append(_build_segment(group))
                group = [self._hits[i]]

        segments.append(_build_segment(group))
        return segments


def _build_segment(hits: List[FrameHit]) -> Segment:
    """Compute aggregate stats for a group of adjacent frame hits."""
    confidences: List[float] = []
    similarities: List[float] = []

    for hit in hits:
        for det in hit.detections:
            confidences.append(det.score)
            similarities.append(det.similarity)

    return Segment(
        start_time=hits[0].timestamp,
        end_time=hits[-1].timestamp,
        start_frame=hits[0].frame_number,
        end_frame=hits[-1].frame_number,
        frame_count=len(hits),
        avg_confidence=sum(confidences) / len(confidences) if confidences else 0.0,
        avg_similarity=sum(similarities) / len(similarities) if similarities else 0.0,
        peak_confidence=max(confidences) if confidences else 0.0,
        peak_similarity=max(similarities) if similarities else 0.0,
    )
