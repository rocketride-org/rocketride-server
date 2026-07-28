# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Run-log type definitions for the RocketRide Python SDK.

A task's run log is ONE continuous JSONL event stream per identity
(``projectId.source.runKind``); individual runs are chapters (tracks) inside
it. Streams are addressed by the plain identity tuple — never by token.

Types:
    LogRunKind:        The two run kinds ('dev' | 'deploy').
    LogChapter:        One run (track) inside the continuum.
    LogActivitySpan:   One segment time range for the activity bar.
    LogChaptersResult: Response of ``client.log.chapters()``.
    LogEvent:          One logged event line (stamped DAP event message).
    LogReadResult:     Response of ``client.log.read()``.
    LogSegmentResult:  Response of ``client.log.segment()`` (raw chunk).
    LogDeleteResult:   Response of ``client.log.delete()``.
    LogTraceSummary:   One trace summary at a session position.
    LogTracesResult:   Response of ``LogEventStream.get_traces()``.
    LogTraceDetail:    Response of ``LogEventStream.get_trace()``.
    LogPlayItem:       Item delivered to the ``play()`` callback.
"""

from typing import Any, Dict, List, Literal, Optional, TypedDict

# The two run kinds — separate continua per task identity.
LogRunKind = Literal['dev', 'deploy']


class LogChapter(TypedDict, total=False):
    """One chapter (track) — a run inside the continuum."""

    # Run start (epoch seconds).
    beginTime: float
    # First continuum seq of the run.
    beginSeq: int
    # Run end (epoch seconds); None while the run is live.
    endTime: Optional[float]
    # 'ok' | 'error' | 'cancelled'; None while the run is live.
    outcome: Optional[str]


class LogActivitySpan(TypedDict, total=False):
    """One activity span (segment time range) for the activity bar."""

    # Segment id — the raw segment fetch / DVR cache key.
    id: int
    # First continuum seq recorded in this segment.
    seq: int
    startTime: Optional[float]
    endTime: Optional[float]
    # A run begins within this span.
    chapterStart: bool


class LogChaptersResult(TypedDict, total=False):
    """Response of ``client.log.chapters()`` — the timeline in one read."""

    chapters: List[LogChapter]
    segments: List[LogActivitySpan]
    # Retained-window start (the horizon), epoch seconds.
    startTime: Optional[float]
    # Latest activity, epoch seconds.
    endTime: Optional[float]
    # First seq still retained after ring/age eviction.
    horizonSeq: int
    # True when no run is currently writing the stream.
    completed: bool


class LogEvent(TypedDict, total=False):
    """
    One logged event — a stamped DAP event message line.

    There is ONE representation of the continuum stamps: the BODY —
    ``body['eventTime']`` (epoch seconds, stamped at engine ingress) and
    ``body['logSeq']`` (catalog-seeded, strictly monotonic per stream),
    beside the ``project_id``/``source`` identity. The DAP envelope is pure
    protocol (its ``seq`` is per-connection bookkeeping); legacy v2
    segments that carried the stamps at the header are canonicalized into
    the body at decode.
    """

    type: str
    event: str
    body: Dict[str, Any]


class LogReadResult(TypedDict, total=False):
    """Response of ``client.log.read()``."""

    events: List[LogEvent]
    # Present when paged: pass as ``cursor`` to continue.
    nextSeq: int
    # Present when the request reached below the retention horizon.
    truncatedAtSeq: int


class LogDeleteResult(TypedDict, total=False):
    """Response of ``client.log.delete()``."""

    deletedSegments: int


class LogTraceSummary(TypedDict, total=False):
    """One trace (document) summary at the session position."""

    # Display id. For fold summaries this is the pipe SLOT (reused across
    # requests); for get_trace results it is the begin seq. Always pass
    # ``beginSeq`` (or a begin event's seq) to ``get_trace`` — that is the
    # trace's permanent identity.
    id: Any
    # The trace's begin-event continuum seq — its PERMANENT identity.
    beginSeq: int
    # Document/object name (the trace's display name).
    doc: str
    # Run start of this trace (epoch seconds).
    beginTime: float
    # Seconds from begin to close (closed traces only).
    elapsed: float
    # Number of component calls seen.
    calls: int
    # True while the trace is still in flight at the position.
    open: bool
    # Segment ids containing this trace's events (sparse expand list).
    touched: List[int]


class LogTracesResult(TypedDict, total=False):
    """Response of ``LogEventStream.get_traces()`` — state at the position."""

    # ALL in-flight traces at the position (bounded by real concurrency).
    open: List[LogTraceSummary]
    # The most recently completed traces before the position (≤ n).
    closed: List[LogTraceSummary]


class LogTraceDetail(TypedDict, total=False):
    """Response of ``LogEventStream.get_trace()`` — one trace's event set."""

    summary: LogTraceSummary
    # Every event belonging to this trace, seq-ordered, fully reconstructed.
    events: List[LogEvent]


class LogPlayItem(TypedDict, total=False):
    """Items delivered to the ``play()`` callback."""

    # One reconstructed event, delivered in seq order.
    event: LogEvent


class LogSegmentResult(TypedDict, total=False):
    """
    Response of ``client.log.segment()`` — one whole-line-aligned chunk of a
    segment's raw JSONL. Repeat with ``nextOffset`` until ``final``.
    """

    # Segment id within the stream.
    segment: int
    # Byte offset this chunk starts at.
    offset: int
    # Raw JSONL text — every chunk ends on a line boundary, parse standalone.
    data: str
    # Total segment size in bytes (grows while the segment is active).
    size: int
    # Pass back as ``offset`` to continue; None when exhausted.
    nextOffset: Optional[int]
    # True when this chunk reached the end of the segment.
    final: bool
