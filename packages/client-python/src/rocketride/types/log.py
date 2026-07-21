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
    LogDeleteResult:   Response of ``client.log.delete()``.
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
    """One logged event — a stamped DAP event message line."""

    type: str
    event: str
    # Server-stamped emission time (epoch seconds, float).
    eventTime: float
    # Server-stamped continuum seq (epoch-us seeded, monotonic).
    seq: int
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
