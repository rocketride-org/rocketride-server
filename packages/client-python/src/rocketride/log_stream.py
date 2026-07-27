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
LogEventStream — the DVR session over one source continuum.

The PUBLIC replay/monitoring surface: consumers think in positions,
chapters, traces, and console — segments, keyframes, and deltas are
invisible internals (the codec lives in the internal ``_log_codec``
module and is never part of the SDK surface).

PROTOCOL (seed-then-stream): ``seek(pos)`` positions the session; the
``get_*()`` calls seed panels from state-at-position (each answer is "as
of seq S" — the watermark); ``play(speed, cb)`` then delivers
reconstructed events strictly AFTER the watermark, in order, paced by
speed (0 = as fast as possible, 1 = real time, 10 = 10x). Playing from a
past position AUTO-PINS on catching the wall clock — replay flows into
live with no seam. Live is not a separate mode: it is the position
pinned to now.

Usage:
    session = client.log.open_event_stream('proj-1', 'chat_1', 'dev')
    await session.seek('live')
    status = await session.get_status()
    await session.play(None, 0, lambda item: handle(item['event']))
    ...
    session.close_event_stream()
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Union

from ._log_codec import SegmentDecoder, normalize_stamps
from .types.log import (
    LogEvent,
    LogPlayItem,
    LogTraceDetail,
    LogTraceSummary,
    LogTracesResult,
)

if TYPE_CHECKING:
    from .client import RocketRideClient

# A position on the continuum: epoch seconds, or 'live' (pinned to now).
LogPosition = Union[float, str]


def _seq_of(ev: LogEvent) -> int:
    """The event's continuum seq — body.logSeq, the only place it lives."""
    return int((ev.get('body') or {}).get('logSeq') or 0)


def _time_of(ev: LogEvent) -> float:
    """The event's continuum emission time — body.eventTime."""
    return float((ev.get('body') or {}).get('eventTime') or 0.0)


# Timeline cache lifetime — chapters/segments are one small server read.
_TIMELINE_TTL_S = 5.0

# Max traces a get_traces() call may request (the recency-window contract).
_MAX_TRACES = 50

# Events delivered between event-loop yields when playing at speed 0.
_FLAT_OUT_BATCH = 250

# Live-bucket split trigger (approx serialized bytes retained): crossing it
# reloads the catalog and SPLITS the bucket — events provably covered by a
# SEALED server segment (seq below the active segment's first seq) drop out
# (they are fetchable as real segments now); the still-buffered suffix stays.
# Residue is therefore at most the active segment (~16MB), so the trigger
# always frees the sealed portion — the bucket stays bounded through an
# arbitrarily long live watch.
_LIVE_BUCKET_SPLIT_BYTES = 24 * 1024 * 1024

# The live bucket's segment id — sorts AFTER every server segment id, so
# ordered walks (pump, trace collection) reach it last, exactly like the
# newest segment it conceptually is.
_LIVE_BUCKET_ID = 2**53

# Resident decoded-segment cap. Eviction is LEAST RECENTLY USED — every real
# access pattern (playback, seeded folds, trace expansion) touches the
# segments that matter for the current position, so recency tracks the
# needle without position math. Evicted segments re-materialize with one raw
# fetch (sealed segments are immutable).
_MAX_RESIDENT_SEGMENTS = 6


@dataclass
class _CachedSegment:
    """One cached (decoded) segment; the decoder persists for active growth."""

    id: int
    keyframe: Optional[Dict[str, Any]] = None
    events: List[LogEvent] = field(default_factory=list)
    decoder: SegmentDecoder = field(default_factory=SegmentDecoder)
    # Byte offset to continue fetching from (active segments grow).
    next_offset: Optional[int] = 0
    # True when the fetch reached the segment's end at fetch time.
    final: bool = False


class LogEventStream:
    """
    A stateful DVR session over one source continuum.

    Create via ``client.log.open_event_stream()``; dispose with
    ``close_event_stream()``. Everything is relative to the session's
    position — a seek re-anchors it, the ``get_*()`` reads seed panels as
    of it, and ``play()`` streams forward from it.
    """

    def __init__(self, client: RocketRideClient, project_id: str, source: str, *, team_id: str = '') -> None:
        """
        Bind the session to its client and stream identity.

        Args:
            client: The owning RocketRideClient.
            project_id: Pipeline project id.
            source: Source component id.
            team_id: A team id addresses that team's deploy continuum;
                omitted = the caller's own dev stream (the scope IS the
                kind — there is no run-kind argument).
        """
        self._client = client
        self._project_id = project_id
        self._source = source
        self._team_id = team_id

        # Timeline (chapters + segment spans) cache.
        self._timeline: Optional[Dict[str, Any]] = None
        self._timeline_at = 0.0
        # Decoded-segment cache, keyed by segment id.
        self._cache: Dict[int, _CachedSegment] = {}
        # The LIVE BUCKET — incoming live events held as a segment like any
        # other: it sorts after every server segment, its span is its
        # events' seq range, and every read/walk iterates it uniformly. It
        # shrinks by SPLITTING: events the server provably holds (sealed
        # segments per the catalog, or a fetched active-segment prefix)
        # drop out; the still-buffered suffix remains.
        #
        # INVARIANT: the bucket is NEVER discarded. Nothing leaves it
        # except a PROVABLY server-backed prefix (sealed per a fresh
        # catalog, or bytes actually fetched from disk) and exact
        # duplicate arrivals — no size cap, no age cap, no drop-on-error.
        # Unbacked events outlive any failure short of closing the
        # session.
        self._live = _CachedSegment(id=_LIVE_BUCKET_ID, final=False)
        # Approximate serialized size of the bucket + split-in-flight guard.
        self._live_bytes = 0
        self._reconciling = False
        self._reconcile_task: Optional[asyncio.Task] = None
        # Highest seq ever fetched from disk — arrivals at/below it are
        # already stored.
        self._max_disk_seq = 0

        # The DVR position (epoch seconds) and whether it is pinned to now.
        self._base_pos = 0.0
        self._pinned = False
        # Seed watermark: get_*() answers are as-of this seq; play > it.
        self._watermark = 0

        self._playing = False
        self._speed = 1.0
        self._callback: Optional[Callable[[LogPlayItem], None]] = None
        self._pump_task: Optional[asyncio.Task] = None
        self._monitor_registered = False
        self._closed = False

    # =========================================================================
    # TIMELINE
    # =========================================================================

    async def get_chapters(self) -> List[Dict[str, Any]]:
        """
        The stream's chapters (runs) — begin/end/outcome per run.

        Returns:
            The chapters list (freshly fetched when the cache aged out).
        """
        await self._refresh_timeline()
        return list((self._timeline or {}).get('chapters', []))

    async def _refresh_timeline(self, force: bool = False) -> None:
        """Fetch/refresh the timeline (chapters + segment spans) when stale."""
        if not force and self._timeline is not None and time.time() - self._timeline_at < _TIMELINE_TTL_S:
            return
        self._timeline = await self._client.log.chapters(self._project_id, self._source, team_id=self._team_id)
        self._timeline_at = time.time()

    # =========================================================================
    # POSITION
    # =========================================================================

    async def _ensure_monitor(self) -> None:
        """
        Register this stream's monitors (all event classes) — streaming
        needs essentially every class and consumers should not have to
        know that. Best-effort: hosts without a live connection (or test
        stubs without a ``call`` method) simply stream from disk.
        """
        if self._monitor_registered:
            return
        self._monitor_registered = True
        try:
            await self._client.call(
                'rrext_monitor',
                projectId=self._project_id,
                source=self._source,
                types=['all'],
            )
        except Exception:
            pass

    async def seek(self, pos: LogPosition) -> None:
        """
        Position the session. Subsequent ``get_*()`` calls answer as of
        this position; ``play()`` continues from it.

        Args:
            pos: Epoch seconds, or 'live' to pin to now.
        """
        self._assert_open()
        await self._ensure_monitor()
        self._stop_pump()
        await self._refresh_timeline(force=True)

        if pos == 'live':
            self._pinned = True
            self._base_pos = time.time()
            seg = await self._ensure_covering_segment(self._base_pos)
            self._watermark = self._last_seq_at_or_before(seg, float('inf'))
            return

        self._pinned = False
        self._base_pos = float(pos)
        seg = await self._ensure_covering_segment(self._base_pos)
        self._watermark = self._last_seq_at_or_before(seg, self._base_pos)

    def position(self) -> float:
        """The current position (epoch seconds); rides the wall clock when live."""
        return time.time() if self._pinned else self._base_pos

    # =========================================================================
    # SEEDED READS (state AS OF the position)
    # =========================================================================

    async def get_status(self) -> Optional[Dict[str, Any]]:
        """
        The full status snapshot at the position.

        Returns:
            The reconstructed status body, or None before the first status.
        """
        self._assert_open()
        pos = self.position()
        seg = await self._ensure_covering_segment(pos)
        # Start from the keyframe base, then replay interior status updates.
        status: Optional[Dict[str, Any]] = None
        kf_status = (seg.keyframe or {}).get('status') if seg else None
        if kf_status:
            status = kf_status
        for ev in self._events_through(seg, pos):
            if ev.get('event') == 'apaevt_status_update' and ev.get('body'):
                status = ev['body']
        return status

    async def get_console(self, n: int) -> List[str]:
        """
        The console exactly as it read at the position (terminal
        semantics: the keyframe scrollback + everything printed since).

        Args:
            n: Number of trailing lines wanted.

        Returns:
            The last ``n`` console lines as of the position.
        """
        self._assert_open()
        pos = self.position()
        seg = await self._ensure_covering_segment(pos)
        lines: List[str] = list(((seg.keyframe or {}).get('console') or {}).get('lines', [])) if seg else []
        for ev in self._events_through(seg, pos):
            if ev.get('event') == 'output' and ev.get('body'):
                for line in str(ev['body'].get('output', '')).split('\n'):
                    if line != '':
                        lines.append(line)
        return lines[-max(0, n) :] if n > 0 else []

    async def get_traces(self, n: int) -> LogTracesResult:
        """
        Trace state at the position: ALL in-flight traces plus the ``n``
        most recently completed (the sliding recency window).

        Args:
            n: Closed-window size; must be <= 50.

        Returns:
            Open + recently-closed trace summaries.

        Raises:
            ValueError: When ``n`` exceeds the window contract.
        """
        self._assert_open()
        if n > _MAX_TRACES:
            raise ValueError(f'get_traces: n must be <= {_MAX_TRACES}')
        pos = self.position()
        seg = await self._ensure_covering_segment(pos)
        open_map, closed = self._fold_traces(seg, pos)
        return {'open': list(open_map.values()), 'closed': closed[-max(0, n) :] if n > 0 else []}

    async def get_trace(self, trace_id: int) -> LogTraceDetail:
        """
        One trace's complete event set (its call tree's raw material).

        IDENTITY CONTRACT: a trace is identified by its BEGIN event's
        continuum seq — the only key that is unique forever. The flow
        events' ``body.id`` is a pipe SLOT, reused across requests, and
        cannot name a trace. Resolution is deterministic and
        position-independent: locate the segment containing the seq (the
        span table carries each segment's first seq), find the begin
        event, then collect that slot's events forward until its matching
        ``end``, crossing segments and the live tail as needed. Fails when
        the seq has fallen below the retention horizon, or when no
        trace-begin event exists at that seq (a recycled slot id or a fold
        docId is NOT a trace identity).

        Args:
            trace_id: The trace's begin-event continuum seq.

        Returns:
            Summary + every event of the trace, seq-ordered.

        Raises:
            KeyError: When no trace begins at the seq (or it fell below
                the retention horizon).
        """
        self._assert_open()
        await self._refresh_timeline()
        spans = (self._timeline or {}).get('segments', [])

        # 1. The segment containing the begin: last span with firstSeq <= seq.
        begin_seg_id: Optional[int] = None
        for span in spans:
            span_id = span.get('id')
            span_seq = span.get('seq')
            if span_id is not None and isinstance(span_seq, int) and span_seq <= trace_id:
                begin_seg_id = span_id
        if begin_seg_id is None:
            raise KeyError(f'get_trace: trace {trace_id} is below the retention horizon')

        # 2. Find the begin event and its slot. A cached copy of the ACTIVE
        # segment goes stale (fetched once; live growth normally rides the
        # tail) — when the seq lies beyond what we hold, re-extend from the
        # stored offset: the writer spools every line before broadcasting,
        # so the disk always has it.
        begin_seg = await self._ensure_segment(begin_seg_id)
        if begin_seg is not None and begin_seg.events and _seq_of(begin_seg.events[-1]) < trace_id:
            await self._extend_segment(begin_seg)
        begin_event: Optional[LogEvent] = None
        if begin_seg is not None:
            idx = _first_seq_above(begin_seg.events, trace_id - 1)
            if idx < len(begin_seg.events):
                begin_event = begin_seg.events[idx]
        begin_body = (begin_event or {}).get('body') or {}
        if (
            begin_seg is None
            or begin_event is None
            or _seq_of(begin_event) != trace_id
            or begin_event.get('event') != 'apaevt_flow'
            or begin_body.get('op') != 'begin'
        ):
            # The bucket is the NEWEST segment: a begin not yet on disk (the
            # fetch raced the broadcast) is found there like anywhere else.
            tail_idx = _first_seq_above(self._live.events, trace_id - 1)
            tail_begin = self._live.events[tail_idx] if tail_idx < len(self._live.events) else None
            tail_body = (tail_begin or {}).get('body') or {}
            if (
                tail_begin is not None
                and _seq_of(tail_begin) == trace_id
                and tail_begin.get('event') == 'apaevt_flow'
                and tail_body.get('op') == 'begin'
            ):
                return await self._collect_trace(trace_id, tail_begin, tail_body, self._live.events, tail_idx, [])
            raise KeyError(f'get_trace: no trace begins at seq {trace_id}')

        # 3. Walk forward from the begin, crossing later segments in id order.
        later = [span['id'] for span in spans if span.get('id') is not None and span['id'] > begin_seg_id]
        return await self._collect_trace(
            trace_id, begin_event, begin_body, begin_seg.events, begin_seg.events.index(begin_event), later
        )

    async def _collect_trace(
        self,
        trace_id: int,
        begin_event: LogEvent,
        begin_body: Dict[str, Any],
        begin_list: List[LogEvent],
        begin_idx: int,
        later_seg_ids: List[int],
    ) -> LogTraceDetail:
        """
        Collect one trace's events from its begin forward: the begin's own
        list, then later segments, then the live tail — stopping at the
        slot's matching ``end`` (an in-flight trace has no end yet; return
        what exists).
        """
        slot = begin_body.get('id')
        events: List[LogEvent] = []
        state = {'ended': False, 'end_time': None, 'calls': 0}

        def consume(source: List[LogEvent], from_idx: int) -> None:
            for i in range(from_idx, len(source)):
                if state['ended']:
                    return
                ev = source[i]
                if _seq_of(ev) < trace_id:
                    continue
                body = ev.get('body') or {}
                # The trace's events: its flow ops (slot = body.id) and the
                # node's SSE narration on the same slot (body.pipe_id).
                is_flow = ev.get('event') == 'apaevt_flow' and body.get('id') == slot
                is_sse = ev.get('event') == 'apaevt_sse' and body.get('pipe_id') == slot
                if not is_flow and not is_sse:
                    continue
                # Seq-dedupe across sources (a tail copy may duplicate disk).
                if events and _seq_of(events[-1]) >= _seq_of(ev):
                    continue
                events.append(ev)
                if is_flow and body.get('op') == 'enter':
                    state['calls'] += 1
                if is_flow and body.get('op') == 'end':
                    state['ended'] = True
                    state['end_time'] = _time_of(ev)

        consume(begin_list, begin_idx)
        for seg_id in later_seg_ids:
            if state['ended']:
                break
            seg = await self._ensure_segment(seg_id)
            if seg is not None:
                consume(seg.events, 0)
        if not state['ended']:
            consume(self._live.events, 0)

        begin_time = _time_of(begin_event)
        summary: LogTraceSummary = {
            'id': trace_id,
            'doc': begin_body.get('component') or ((begin_body.get('pipes') or [None])[0]),
            'beginTime': begin_time,
            'calls': state['calls'],
            'open': not state['ended'],
        }
        if state['end_time'] is not None and begin_time is not None:
            summary['elapsed'] = max(0.0, state['end_time'] - begin_time)
        return {'summary': summary, 'events': events}

    # =========================================================================
    # TRANSPORT
    # =========================================================================

    async def play(self, pos: Optional[LogPosition], speed: float, cb: Callable[[LogPlayItem], None]) -> None:
        """
        Stream reconstructed events to ``cb``, in order, strictly after
        the seed watermark, paced by ``speed``. Auto-pins to live on
        catching the wall clock; while pinned, delivery follows arrival.

        Args:
            pos: Optional position to seek first (seconds | 'live' | None).
            speed: 0 = as fast as possible; 0.25/1/10 = time-scaled.
            cb: Receives ``{'event': ...}`` items.
        """
        self._assert_open()
        if pos is not None:
            await self.seek(pos)
        self._speed = speed
        self._callback = cb
        self._playing = True
        # Exactly ONE delivery loop: a replay of play() (resume, speed
        # change) cancels any pump still awaiting a fetch.
        self._stop_pump()
        self._pump_task = asyncio.get_running_loop().create_task(self._pump())

    def pause(self) -> None:
        """Freeze the position (unpins live; a later play resumes here)."""
        self._base_pos = self.position()
        self._pinned = False
        self._playing = False
        self._stop_pump()

    def ingest_live(self, msg: LogEvent) -> None:
        """
        Feed one live event from the host's subscription. While pinned and
        playing, it is delivered to the callback immediately (arrival
        paces live delivery); otherwise it is retained for catch-up.

        Args:
            msg: A stamped event message from the live feed.
        """
        # The continuum stamps ride in the BODY (the DAP header seq is the
        # connection's protocol counter — meaningless here). An event without
        # body stamps is not a stamped task event; drop it.
        body = msg.get('body')
        if (
            self._closed
            or not isinstance(body, dict)
            or not isinstance(body.get('logSeq'), int)
            or not isinstance(body.get('eventTime'), (int, float))
            or not math.isfinite(body['eventTime'])
        ):
            return
        seq = body['logSeq']
        # A duplicate of something already bucketed: nothing new.
        last = _seq_of(self._live.events[-1]) if self._live.events else 0
        if seq <= last:
            return
        self._live.events.append(msg)
        self._live_bytes += len(json.dumps(msg, separators=(',', ':')))
        # LIVE MODE: deliver the arrival directly — the wire is ordered, so
        # arrival order IS delivery order. Disk copies are irrelevant here;
        # the history walk's cursor skips any overlap on its own.
        if self._pinned and self._playing and self._callback and seq > self._watermark:
            self._watermark = seq
            self._callback({'event': msg})
        # Size backstop: past the threshold, split the bucket against a
        # fresh catalog (async — arrivals keep landing while it runs).
        if self._live_bytes > _LIVE_BUCKET_SPLIT_BYTES and not self._reconciling:
            self._reconciling = True
            try:
                self._reconcile_task = asyncio.get_running_loop().create_task(self._split_live_bucket())
            except RuntimeError:
                # No running loop (sync caller): retry on a later arrival.
                self._reconciling = False

    def close_event_stream(self) -> None:
        """Dispose the session (stops playback, clears caches)."""
        self._playing = False
        self._stop_pump()
        self._cache.clear()
        self._live.events = []
        self._live_bytes = 0
        self._closed = True

    async def _split_live_bucket(self) -> None:
        """
        Size-triggered bucket SPLIT: reload the catalog and drop the prefix
        the server provably holds — anything with seq below the ACTIVE
        segment's first seq lives in a sealed, cataloged segment and is
        fetchable as a real segment. The retained suffix is at most the
        active segment's worth of events.
        """
        try:
            await self._refresh_timeline(force=True)
            if self._closed:
                return
            spans = (self._timeline or {}).get('segments', [])
            cutoff = spans[-1].get('seq') if spans else None
            if not isinstance(cutoff, int):
                return
            self._drop_live_bucket_prefix(cutoff - 1)
        except Exception:
            # A failed catalog read leaves the bucket as-is; the next
            # arrival past the threshold retries.
            pass
        finally:
            self._reconciling = False

    def _drop_live_bucket_prefix(self, covered_seq: int) -> None:
        """Split operation: drop bucket events with seq <= covered_seq."""
        events = self._live.events
        from_idx = _first_seq_above(events, covered_seq)
        if from_idx == 0:
            return
        self._live.events = events[from_idx:]
        self._live_bytes = sum(len(json.dumps(e, separators=(',', ':'))) for e in self._live.events)

    # =========================================================================
    # PUMP (the delivery loop)
    # =========================================================================

    async def _pump(self) -> None:
        """Deliver events in order with speed pacing; pin or pause at the end."""
        delivered = 0
        while self._playing and not self._closed and self._callback is not None:
            nxt = await self._next_event()
            if nxt is None:
                # The history walk ran out of buckets. A still-writing
                # stream means we caught the wall clock: flip to LIVE MODE —
                # from here arrivals deliver directly in ingest_live. A
                # completed stream simply ran out of disc: pause at the end.
                await self._refresh_timeline()
                if self._timeline is not None and self._timeline.get('completed') is False:
                    self._pinned = True
                    self._base_pos = time.time()
                    # Drain arrivals that landed in the live bucket during
                    # the awaits above: ingest_live delivers only events
                    # arriving AFTER the pin flips, so anything buffered in
                    # that window must be delivered here or it is lost to
                    # the seam. Synchronous — no await may interleave an
                    # arrival mid-drain.
                    events = self._live.events
                    idx = _first_seq_above(events, self._watermark)
                    while idx < len(events) and self._playing and self._callback is not None:
                        ev = events[idx]
                        self._watermark = _seq_of(ev)
                        self._callback({'event': ev})
                        idx += 1
                else:
                    self._playing = False
                    self._pinned = False
                return

            event_time = _time_of(nxt)
            if self._speed > 0:
                # Pace by event-time delta scaled by speed; re-check state
                # after any real sleep (a pause may land mid-wait).
                delay = max(0.0, (event_time - self._base_pos) / self._speed)
                if delay > 0.004:
                    await asyncio.sleep(delay)
                    # Advance the playback clock past the wait so the
                    # re-checked delay converges to zero — without this the
                    # loop recomputes the same delay forever and timed
                    # playback stalls on the first inter-event gap.
                    self._base_pos = max(self._base_pos, event_time)
                    continue

            self._watermark = _seq_of(nxt)
            self._base_pos = max(self._base_pos, event_time)
            self._callback({'event': nxt})

            # At speed 0, yield between batches so catch-up cannot starve
            # the event loop.
            delivered += 1
            if self._speed == 0 and delivered % _FLAT_OUT_BATCH == 0:
                await asyncio.sleep(0)

    async def _next_event(self) -> Optional[LogEvent]:
        """The next undelivered event (seq > watermark), fetching forward."""
        # 1. From cached segments, in id order (touch on serve: the segment
        # being played must stay most-recently-used, never the LRU victim).
        ids = sorted(self._cache.keys())
        for seg_id in ids:
            seg = self._cache[seg_id]
            idx = _first_seq_above(seg.events, self._watermark)
            if idx < len(seg.events):
                self._touch(seg)
                return seg.events[idx]

        # 2. Grow the ACTIVE segment. "final" only means the last fetch
        # reached the then-current end — the segment regrows on disk, and
        # the log records more than the wire pushes, so the disk re-read is
        # the delivery guarantee for wire-less content.
        last = self._cache[ids[-1]] if ids else None
        if last is not None:
            await self._extend_segment(last)
            idx = _first_seq_above(last.events, self._watermark)
            if idx < len(last.events):
                return last.events[idx]

        # 3. A later segment we have not fetched yet.
        await self._refresh_timeline()
        for span in (self._timeline or {}).get('segments', []):
            span_id = span.get('id')
            if span_id is not None and (last is None or span_id > last.id):
                seg = await self._ensure_segment(span_id)
                if seg is not None:
                    idx = _first_seq_above(seg.events, self._watermark)
                    if idx < len(seg.events):
                        return seg.events[idx]

        # 4. The live tail (events newer than anything on disk yet).
        idx = _first_seq_above(self._live.events, self._watermark)
        if idx < len(self._live.events):
            return self._live.events[idx]

        return None

    # =========================================================================
    # SEGMENT MATERIALIZATION (internals — storage stays invisible)
    # =========================================================================

    async def _ensure_covering_segment(self, pos: float) -> Optional[_CachedSegment]:
        """Ensure the segment covering ``pos`` is cached; return it."""
        await self._refresh_timeline()
        spans = (self._timeline or {}).get('segments', [])
        covering_id: Optional[int] = None
        # The covering segment is the last span starting at or before pos.
        for span in spans:
            span_id = span.get('id')
            if span_id is None:
                continue
            if (span.get('startTime') or 0) <= pos:
                covering_id = span_id
        if covering_id is None and spans and spans[0].get('id') is not None:
            covering_id = spans[0]['id']
        if covering_id is None:
            return None
        return await self._ensure_segment(covering_id)

    def _touch(self, seg: _CachedSegment) -> None:
        """Move a segment to most-recently-used (dict order IS the LRU order)."""
        del self._cache[seg.id]
        self._cache[seg.id] = seg

    async def _ensure_segment(self, seg_id: int) -> Optional[_CachedSegment]:
        """Fetch + decode one segment (all chunks) into the cache (LRU-capped)."""
        cached = self._cache.get(seg_id)
        if cached is not None:
            self._touch(cached)
            return cached
        seg = _CachedSegment(id=seg_id)
        await self._extend_segment(seg)
        if seg.keyframe is None and not seg.events and seg.final:
            return None
        self._cache[seg_id] = seg
        # LRU eviction: drop from the front of the dict until under the cap
        # (evicted segments re-materialize with one raw fetch).
        while len(self._cache) > _MAX_RESIDENT_SEGMENTS:
            self._cache.pop(next(iter(self._cache)))
        return seg

    async def _extend_segment(self, seg: _CachedSegment) -> None:
        """Continue fetching a segment from its stored offset (active growth)."""
        offset = seg.next_offset or 0
        while True:
            chunk = await self._client.log.segment(
                self._project_id, self._source, seg.id, team_id=self._team_id, offset=offset
            )
            data = chunk.get('data') or ''
            for line in data.split('\n'):
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get('type') == 'keyframe':
                    seg.keyframe = msg
                    seg.decoder.seed(msg)
                    continue
                decoded = normalize_stamps(seg.decoder.decode(msg))
                seq = _seq_of(decoded)
                if seq > self._max_disk_seq:
                    self._max_disk_seq = seq
                seg.events.append(decoded)
            seg.final = bool(chunk.get('final'))
            # A final chunk carries nextOffset=None; resume any later growth
            # of the active segment from the size we have consumed so far.
            next_offset = chunk.get('nextOffset')
            seg.next_offset = next_offset if next_offset is not None else chunk.get('size')
            if seg.final or next_offset is None:
                break
            offset = next_offset
        # Disk coverage advanced: split the bucket's now-covered prefix out —
        # the same operation as the size-triggered catalog split.
        self._drop_live_bucket_prefix(self._max_disk_seq)

    # =========================================================================
    # FOLDS (state-at-position, keyframe + interior)
    # =========================================================================

    def _events_through(self, seg: Optional[_CachedSegment], pos: float) -> List[LogEvent]:
        """All events of ``seg`` plus the live bucket, eventTime <= pos, ordered."""
        events = [e for e in seg.events if _time_of(e) <= pos] if seg else []
        # The bucket is the stream's newest segment — it participates in the
        # fold exactly like disk events (dedupe is structural: the bucket
        # holds only seqs beyond _max_disk_seq).
        last_disk = _seq_of(events[-1]) if events else 0
        for ev in self._live.events:
            if _time_of(ev) <= pos and _seq_of(ev) > last_disk:
                events.append(ev)
        return events

    def _fold_traces(self, seg: Optional[_CachedSegment], pos: float) -> tuple:
        """Fold open/closed trace state from the keyframe + interior <= pos."""
        open_map: Dict[Any, LogTraceSummary] = {}
        closed: List[LogTraceSummary] = []

        # Seed from the keyframe: open frames collapse to one summary per
        # trace id; closedRecent maps straight into the closed window.
        for frame in (seg.keyframe or {}).get('openFrames', []) if seg else []:
            if frame.get('id') not in open_map:
                open_map[frame['id']] = {
                    'id': frame['id'],
                    'beginSeq': frame.get('enterSeq'),
                    'doc': frame.get('doc'),
                    'beginTime': frame.get('enterTime'),
                    'open': True,
                    'touched': frame.get('touched'),
                }
        for done in (seg.keyframe or {}).get('closedRecent', []) if seg else []:
            closed.append(
                {
                    'id': done.get('id'),
                    'beginSeq': done.get('beginSeq'),
                    'doc': done.get('doc'),
                    'beginTime': done.get('beginTime'),
                    'elapsed': done.get('elapsed'),
                    'calls': done.get('calls'),
                    'open': False,
                    'touched': done.get('touched'),
                }
            )

        # Replay interior flow events up to the position.
        for ev in self._events_through(seg, pos):
            if ev.get('event') != 'apaevt_flow' or not ev.get('body'):
                continue
            body = ev['body']
            pid = body.get('id')
            op = body.get('op')
            # An interior event proves this trace touches the covering
            # segment — the keyframe's touched list predates it.
            entry = open_map.get(pid)
            if entry is not None and seg is not None:
                if not entry.get('touched'):
                    entry['touched'] = []
                if seg.id not in entry['touched']:
                    entry['touched'].append(seg.id)
            if op == 'begin':
                open_map[pid] = {
                    'id': pid,
                    # The trace's PERMANENT identity — what get_trace resolves.
                    'beginSeq': _seq_of(ev),
                    'doc': body.get('component'),
                    'beginTime': _time_of(ev),
                    'calls': 0,
                    'open': True,
                    'touched': [seg.id] if seg else [],
                }
            elif op == 'enter':
                entry = open_map.get(pid)
                if entry is not None:
                    entry['calls'] = (entry.get('calls') or 0) + 1
            elif op == 'end':
                entry = open_map.pop(pid, None)
                if entry is not None:
                    done_entry = dict(entry)
                    done_entry['open'] = False
                    if entry.get('beginTime') is not None:
                        done_entry['elapsed'] = max(0.0, _time_of(ev) - entry['beginTime'])
                    closed.append(done_entry)
        return open_map, closed

    def _last_seq_at_or_before(self, seg: Optional[_CachedSegment], pos: float) -> int:
        """Highest seq at-or-before ``pos`` in the segment (0 when none)."""
        last = 0
        for ev in self._events_through(seg, pos):
            seq = _seq_of(ev)
            if seq > last:
                last = seq
        return last

    def _stop_pump(self) -> None:
        """Cancel the delivery task if one is running."""
        if self._pump_task is not None and not self._pump_task.done():
            self._pump_task.cancel()
        self._pump_task = None

    def _assert_open(self) -> None:
        """Reject use of a disposed session."""
        if self._closed:
            raise RuntimeError('LogEventStream is closed')


def _first_seq_above(events: List[LogEvent], after_seq: int) -> int:
    """Index of the first event with body.logSeq > ``after_seq`` (ascending)."""
    # Manual binary search — avoids materializing a seq list on every call.
    lo, hi = 0, len(events)
    while lo < hi:
        mid = (lo + hi) // 2
        if _seq_of(events[mid]) <= after_seq:
            lo = mid + 1
        else:
            hi = mid
    return lo
