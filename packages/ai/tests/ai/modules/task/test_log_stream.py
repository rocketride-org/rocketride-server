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
Golden tests for the SDK DVR session (rocketride.LogEventStream).

The session is exercised against a REAL RunLogWriter-produced v2 stream
(keyframes + deltas across multiple sealed segments) through a stub client
that proxies rrext_log calls straight to RunLogReader — the same server code
path the wire uses. The hard contract under test: the session's play() must
reconstitute the information-identical event stream (== the server read()
golden), the seed watermark must splice get*()/play() with no gap and no
duplicate, and the pane reads (status/console/traces) must answer exactly
as-of the position.
"""

import asyncio
import shutil
import tempfile
import time

import pytest

import ai.modules.task.run_log as run_log
from ai.account.store_providers.filesystem import FilesystemStore
from rocketride import log_stream as rr_log_stream
from rocketride._log_codec import normalize_stamps
from rocketride.log_stream import LogEventStream

# Shared helpers from the writer test module.
from .test_run_log import (
    CLIENT,
    KIND,
    PROJECT,
    SOURCE,
    flow_op,
    make_file_store,
    make_stamp,
    open_writer,
    output_event,
    status_event,
)


# =============================================================================
# FIXTURES + STUB CLIENT
# =============================================================================


@pytest.fixture
def istore():
    temp_path = tempfile.mkdtemp()
    yield FilesystemStore(f'filesystem://{temp_path}')
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def spool_root():
    temp_path = tempfile.mkdtemp()
    yield temp_path
    shutil.rmtree(temp_path, ignore_errors=True)


class _StubLogApi:
    """client.log stand-in: proxies straight to a RunLogReader instance."""

    def __init__(self, reader):
        self._reader = reader

    async def chapters(self, project_id, source, *, team_id='', run_kind=''):
        return await self._reader.chapters()

    async def segment(self, project_id, source, segment, *, team_id='', run_kind='', offset=0, max_bytes=None):
        if max_bytes is None:
            return await self._reader.segment_raw(segment, offset=offset)
        return await self._reader.segment_raw(segment, offset=offset, max_bytes=max_bytes)


class _StubClient:
    """Minimal client shape the session needs (just the log namespace)."""

    def __init__(self, reader):
        self.log = _StubLogApi(reader)


def open_session(reader):
    """A session bound to the stub client over the standard test stream."""
    return LogEventStream(_StubClient(reader), PROJECT, SOURCE)


async def seed_rich(istore, spool_root, monkeypatch):
    """
    One completed run exercising the whole codec across several segments:
    status deltas, a cross-segment trace (begin early / end late), a
    second interior trace, and console output throughout.
    """
    # Tiny seal size forces multiple segments (and thus keyframes + the
    # same-segment-only delta rule) out of a small event count.
    monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 700)
    stamp, raise_floor, _ = make_stamp()
    writer = await open_writer(istore, spool_root, stamp, raise_floor)

    # Trace 7 opens near the start and closes near the end (cross-segment).
    writer.append(stamp(status_event(state='running', objects={'ok': 0, 'bad': 0})))
    writer.append(stamp(flow_op('begin', pid=7, component='loader')))
    writer.append(stamp(flow_op('enter', pid=7, component='loader', data={'doc': 'a.txt', 'step': 1})))
    for i in range(20):
        writer.append(stamp(output_event(f'line-{i:03d}-' + 'x' * 30)))
        if i % 4 == 0:
            # Overlapping status bodies so interior updates delta-encode.
            writer.append(stamp(status_event(state='running', objects={'ok': i, 'bad': 0})))
    writer.append(stamp(sse_event(7, 'embedding chunk 3/10')))
    writer.append(stamp(flow_op('leave', pid=7, component='loader', data={'doc': 'a.txt', 'step': 2})))
    writer.append(stamp(flow_op('end', pid=7, component='loader')))

    # Trace 9 lives in the tail of the stream.
    writer.append(stamp(flow_op('begin', pid=9, component='parser')))
    writer.append(stamp(flow_op('enter', pid=9, component='parser', data={'doc': 'b.txt'})))
    for i in range(10):
        writer.append(stamp(output_event(f'tail-{i:03d}-' + 'y' * 30)))
    writer.append(stamp(flow_op('leave', pid=9, component='parser', data={'doc': 'b.txt', 'done': True})))
    writer.append(stamp(flow_op('end', pid=9, component='parser')))

    # Slot RECYCLE: pid 7 begins a second, different request — slot ids are
    # reused, so only the begin seq can tell the two apart.
    writer.append(stamp(flow_op('begin', pid=7, component='loader')))
    writer.append(stamp(flow_op('enter', pid=7, component='loader', data={'doc': 'c.txt'})))
    writer.append(stamp(flow_op('leave', pid=7, component='loader', data={'doc': 'c.txt', 'again': True})))
    writer.append(stamp(flow_op('end', pid=7, component='loader')))

    await writer._drain_uploads()
    await writer.end_run('ok')
    return run_log.RunLogReader(
        make_file_store(istore),
        CLIENT,
        PROJECT,
        SOURCE,
        KIND,
        spool_root=spool_root,
    )


def sse_event(pid, message):
    """A node-authored SSE narration message on a pipe slot (unstamped)."""
    return {'type': 'event', 'event': 'apaevt_sse', 'body': {'pipe_id': pid, 'message': message}}


def golden_trace_windows(golden):
    """Every request's (beginSeq, [its events]) from the golden stream."""
    windows = []
    for i, ev in enumerate(golden):
        if ev.get('event') != 'apaevt_flow' or (ev.get('body') or {}).get('op') != 'begin':
            continue
        slot = ev['body'].get('id')
        window = []
        for later in golden[i:]:
            body = later.get('body') or {}
            is_flow = later.get('event') == 'apaevt_flow' and body.get('id') == slot
            is_sse = later.get('event') == 'apaevt_sse' and body.get('pipe_id') == slot
            if not is_flow and not is_sse:
                continue
            window.append(later)
            if is_flow and body.get('op') == 'end':
                break
        windows.append((seq_of(ev), window))
    return windows


async def wait_until(condition, timeout=5.0):
    """Poll a condition (live pumps idle-loop; task-await would hang)."""
    deadline = time.time() + timeout
    while not condition():
        assert time.time() < deadline, 'condition not met in time'
        await asyncio.sleep(0.02)


def seq_of(ev):
    """The event's continuum seq — body.logSeq, the only place it lives."""
    return ev['body']['logSeq']


def time_of(ev):
    """The event's continuum emission time — body.eventTime."""
    return ev['body']['eventTime']


async def read_golden(reader, **kwargs):
    """Server read + client-side stamp normalization (what a session yields)."""
    return [normalize_stamps(e) for e in (await reader.read(**kwargs))['events']]


async def play_to_end(session, pos):
    """Seek, play at speed 0, and collect everything delivered."""
    played = []
    await session.seek(pos)
    await session.play(None, 0, lambda item: played.append(item['event']))
    await session._pump_task
    return played


# =============================================================================
# GOLDEN RECONSTRUCTION
# =============================================================================


class TestGoldenPlayback:
    @pytest.mark.asyncio
    async def test_play_from_start_reconstructs_stream(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        # Sanity: the scenario really produced multiple segments.
        timeline = await reader.chapters()
        assert len(timeline['segments']) >= 3

        session = open_session(reader)
        played = await play_to_end(session, time_of(golden[0]) - 1.0)
        # The hard contract: play() reproduces the server read() exactly —
        # every event, fully reconstructed, in seq order.
        assert played == golden
        session.close_event_stream()

    @pytest.mark.asyncio
    async def test_seek_splice_no_gap_no_duplicate(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)

        session = open_session(reader)
        mid_pos = time_of(golden[len(golden) // 2])
        await session.seek(mid_pos)
        # Capture the SEED watermark before play advances it.
        watermark = session._watermark
        played = []
        await session.play(None, 0, lambda item: played.append(item['event']))
        await session._pump_task

        # The watermark must actually sit inside the stream (not trivial).
        assert seq_of(golden[0]) <= watermark < seq_of(golden[-1])
        # Everything after the watermark arrives exactly once, in order.
        assert played == [e for e in golden if seq_of(e) > watermark]
        # And nothing below it is replayed: seed + played tile the stream.
        seeded = [e for e in golden if seq_of(e) <= watermark]
        assert len(seeded) + len(played) == len(golden)
        session.close_event_stream()

    @pytest.mark.asyncio
    async def test_lru_cap_evicts_and_still_reconstructs(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        timeline = await reader.chapters()
        assert len(timeline['segments']) > 2, 'scenario must exceed the test cap'

        # Cap below the segment count forces evictions DURING playback.
        monkeypatch.setattr(rr_log_stream, '_MAX_RESIDENT_SEGMENTS', 2)
        session = open_session(reader)
        played = await play_to_end(session, time_of(golden[0]) - 1.0)
        # Reconstruction is unharmed by eviction (re-fetch on demand)...
        assert played == golden
        # ...and residency respected the cap throughout (checked at the end;
        # the cap is enforced on every insert).
        assert len(session._cache) <= 2
        # Seeded reads after eviction re-materialize the covering segment.
        await session.seek(time_of(golden[-1]))
        expected = [e['body'] for e in golden if e['event'] == 'apaevt_status_update'][-1]
        assert await session.get_status() == expected
        assert len(session._cache) <= 2
        session.close_event_stream()

    @pytest.mark.asyncio
    async def test_closed_session_rejects_use(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        session = open_session(reader)
        session.close_event_stream()
        with pytest.raises(RuntimeError):
            await session.seek(0.0)


# =============================================================================
# SEEDED PANE READS
# =============================================================================


class TestSeededReads:
    @pytest.mark.asyncio
    async def test_get_chapters_matches_reader(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        session = open_session(reader)
        assert await session.get_chapters() == (await reader.chapters())['chapters']

    @pytest.mark.asyncio
    async def test_get_status_at_end_is_last_status(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        session = open_session(reader)
        await session.seek(time_of(golden[-1]))
        status = await session.get_status()
        expected = [e['body'] for e in golden if e['event'] == 'apaevt_status_update'][-1]
        assert status == expected

    @pytest.mark.asyncio
    async def test_get_status_analytics_exact_at_every_position(self, istore, spool_root, monkeypatch):
        """
        The run-analytics status fields (componentStats / slowestDocs /
        completionSeconds) reconstruct EXACTLY at every status position on
        the continuum — the keyframe+delta codec must carry the nested dict
        (per-component shallow-delta) and the list (wholesale) through
        multiple sealed segments with no fold-window or recency caveats.
        """
        # Tiny seal size forces the evolving statuses across several
        # segments, so mid-stream reads exercise keyframe + delta merging.
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 700)

        # EVERY event — run markers included — draws a strictly-increasing
        # time from one clock, so every seek position is unambiguous
        # (wall-clock stamps can collide within resolution and the markers
        # would otherwise stamp real now around the synthetic times).
        # Anchored just BEHIND now: retention and the backstop seal judge
        # segment times against the real clock, so a synthetic epoch would
        # read as ancient and be sealed/evicted out of the stream.
        base_stamp, raise_floor, _ = make_stamp()
        clock = [time.time() - 60.0]

        def stamp(message, *, event_time=None):
            clock[0] += 1.0
            return base_stamp(message, event_time=clock[0])

        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        def emit(ev):
            writer.append(stamp(ev))

        # Analytics evolve one component at a time so interior updates
        # delta-encode only the changed entries.
        emit(status_event(state='running', completionSeconds=0.0, componentStats={}, slowestDocs=[]))
        for i in range(1, 6):
            for j in range(6):
                emit(output_event(f'fill-{i}-{j}-' + 'x' * 30))
            stats = {'parse': {'calls': i, 'totalSeconds': round(i * 0.7, 2), 'maxSeconds': 0.7}}
            if i > 2:
                stats['llm'] = {'calls': i - 2, 'totalSeconds': round((i - 2) * 2.1, 2), 'maxSeconds': 2.1}
            docs = [
                {'name': f'doc-{k}.txt', 'elapsed': round(3.0 - k * 0.5, 2), 'beginTime': 900.0 + k, 'beginSeq': k}
                for k in range(min(i, 3))
            ]
            emit(
                status_event(
                    state='running', completionSeconds=round(i * 1.5, 2), componentStats=stats, slowestDocs=docs
                )
            )
        await writer._drain_uploads()
        await writer.end_run('ok')
        reader = run_log.RunLogReader(
            make_file_store(istore),
            CLIENT,
            PROJECT,
            SOURCE,
            KIND,
            spool_root=spool_root,
        )

        golden = await read_golden(reader, from_seq=0)
        # Sanity: the scenario really spans multiple segments.
        assert len((await reader.chapters())['segments']) >= 3

        session = open_session(reader)
        statuses = [e for e in golden if e['event'] == 'apaevt_status_update']
        assert len(statuses) == 6
        # As-of ANY status position, statusAt answers that exact body.
        for expected in statuses:
            await session.seek(time_of(expected))
            assert await session.get_status() == expected['body']
        session.close_event_stream()

    @pytest.mark.asyncio
    async def test_get_console_exact_at_position(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        session = open_session(reader)
        await session.seek(time_of(golden[-1]))
        lines = await session.get_console(2000)
        # Terminal semantics: exactly what the console printed, in order —
        # the keyframe scrollback folds seamlessly into interior output.
        expected = [e['body']['output'] for e in golden if e['event'] == 'output']
        assert lines == expected[-2000:]

    @pytest.mark.asyncio
    async def test_get_traces_window_and_limit(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        session = open_session(reader)
        await session.seek(time_of(golden[-1]))
        with pytest.raises(ValueError):
            await session.get_traces(51)
        result = await session.get_traces(50)
        # Both traces are closed at the end of the run; none are in flight.
        assert result['open'] == []
        closed_ids = [t['id'] for t in result['closed']]
        assert 7 in closed_ids and 9 in closed_ids

    @pytest.mark.asyncio
    async def test_get_trace_by_begin_seq(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        session = open_session(reader)
        # Identity contract: EVERY request resolves by its begin seq to
        # exactly its own begin..end window — including the two requests
        # sharing slot 7 (cross-segment first cycle, recycled second cycle)
        # — with NO dependence on the session position (never seeked).
        windows = golden_trace_windows(golden)
        assert len(windows) == 3, 'seed must contain three requests'
        slot7 = [w for w in windows if w[1][0]['body'].get('id') == 7]
        assert len(slot7) == 2, 'slot 7 must be recycled'
        assert any(e.get('event') == 'apaevt_sse' for _, w in windows for e in w), 'seed must narrate'
        for begin_seq, expected in windows:
            detail = await session.get_trace(begin_seq)
            assert detail['events'] == expected
            assert detail['summary']['id'] == begin_seq
            assert detail['summary']['open'] is False
        # A seq where nothing begins, and one below the horizon: both fail.
        with pytest.raises(KeyError):
            await session.get_trace(seq_of(golden[-1]) + 999)
        with pytest.raises(KeyError):
            await session.get_trace(1)

    @pytest.mark.asyncio
    async def test_get_trace_reaches_active_segment_growth(self, istore, spool_root, monkeypatch):
        # Rod's live scenario: the session caches the ACTIVE segment, then a
        # NEW request runs — its events exist only in the segment's growth
        # (and the live tail). get_trace must re-extend the stale cached
        # copy and resolve the new begin seq.
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 1 << 20)
        stamp, raise_floor, state = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(flow_op('begin', pid=3, component='x')))
        writer.append(stamp(flow_op('end', pid=3, component='x')))
        reader = run_log.RunLogReader(
            make_file_store(istore),
            CLIENT,
            PROJECT,
            SOURCE,
            KIND,
            spool_root=spool_root,
        )

        session = open_session(reader)
        # Cache the active segment NOW — it goes stale the moment more
        # events land behind it.
        await session.seek(time.time())

        begin_seq = state['next']
        writer.append(stamp(flow_op('begin', pid=3, component='y')))
        writer.append(stamp(flow_op('enter', pid=3, component='y', data={'k': 1})))
        writer.append(stamp(flow_op('leave', pid=3, component='y', data={'k': 2})))
        writer.append(stamp(flow_op('end', pid=3, component='y')))

        detail = await session.get_trace(begin_seq)
        assert [e['body']['op'] for e in detail['events']] == ['begin', 'enter', 'leave', 'end']
        # The growth decodes correctly too (leave deltas resolve against
        # their enter through the persisted per-segment decoder).
        assert detail['events'][2]['body']['trace']['data'] == {'k': 2}
        assert detail['summary']['open'] is False
        session.close_event_stream()


# =============================================================================
# LIVE INGEST
# =============================================================================


class TestLiveIngest:
    @pytest.mark.asyncio
    async def test_live_arrivals_deliver_through_the_pump(self, istore, spool_root, monkeypatch):
        # A LIVE (no end_run) stream: play drains the disk and auto-pins;
        # arrivals then POKE the pump, which is the one delivery path.
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 1 << 20)
        stamp, raise_floor, state = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('boot')))
        reader = run_log.RunLogReader(
            make_file_store(istore),
            CLIENT,
            PROJECT,
            SOURCE,
            KIND,
            spool_root=spool_root,
        )

        session = open_session(reader)
        delivered = []
        await session.seek(0.0)
        await session.play(None, 0, lambda item: delivered.append(item['event']))
        await session._pump_task
        assert session._pinned is True, 'exhausting the walk on a live stream flips to live mode'
        base = len(delivered)

        event = {
            'type': 'event',
            'event': 'output',
            'body': {
                'category': 'console',
                'output': 'live-line',
                'eventTime': time.time(),
                'logSeq': state['next'] + 100,
            },
        }
        # LIVE MODE: bucket append + direct, synchronous delivery.
        session.ingest_live(event)
        assert delivered[base:] == [event]
        session.ingest_live(event)  # duplicate seq must be dropped silently
        assert delivered[base:] == [event]
        assert session._watermark == event['body']['logSeq']
        session.close_event_stream()

    @pytest.mark.asyncio
    async def test_raced_fetch_still_delivers_through_poke(self, istore, spool_root, monkeypatch):
        # Rod's stop-the-job case: a disk fetch (getTrace) races ahead of
        # the wire — the arrivals are then "already on disk" and skipped,
        # but they MUST still deliver: the dropped arrival pokes the pump,
        # which serves the fetched growth from the cache in order.
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 1 << 20)
        stamp, raise_floor, state = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('boot')))
        reader = run_log.RunLogReader(
            make_file_store(istore),
            CLIENT,
            PROJECT,
            SOURCE,
            KIND,
            spool_root=spool_root,
        )

        session = open_session(reader)
        delivered = []
        await session.seek(0.0)
        await session.play(None, 0, lambda item: delivered.append(item['event']))
        await session._pump_task
        assert session._pinned is True
        base = len(delivered)

        # Disk grows: a whole trace lands in the spool...
        begin_seq = state['next']
        writer.append(stamp(flow_op('begin', pid=5, component='z')))
        writer.append(stamp(flow_op('enter', pid=5, component='z', data={'n': 1})))
        writer.append(stamp(flow_op('leave', pid=5, component='z', data={'n': 2})))
        writer.append(stamp(flow_op('end', pid=5, component='z')))
        # ...and a fetch pulls those bytes into the cache (getTrace).
        await session.get_trace(begin_seq)
        assert delivered[base:] == [], 'a fetch alone must not deliver'

        # The wire copies arrive as they always do — disk copies are
        # IRRELEVANT to live delivery: each arrival delivers directly,
        # exactly once, in order.
        golden = await read_golden(reader, from_seq=begin_seq)
        for wire_copy in golden:
            session.ingest_live(wire_copy)
        assert [e['body']['op'] for e in delivered[base:]] == ['begin', 'enter', 'leave', 'end']

        # And a HISTORY walk over the same range delivers each event once —
        # the cursor skips the disk/bucket overlap on its own.
        replayed = []
        await session.seek(0.0)
        await session.play(None, 0, lambda item: replayed.append(item['event']))
        await session._pump_task
        seqs = [seq_of(e) for e in replayed]
        assert seqs == sorted(set(seqs)), 'no duplicates, strict order'
        assert [seq_of(e) for e in golden] == seqs[-len(golden) :]
        session.close_event_stream()

    @pytest.mark.asyncio
    async def test_size_trigger_reconciles_tail_against_catalog(self, istore, spool_root, monkeypatch):
        reader = await seed_rich(istore, spool_root, monkeypatch)
        golden = await read_golden(reader, from_seq=0)
        timeline = await reader.chapters()
        # Catalog coverage cutoff: the newest segment's first seq — anything
        # below it lives in a sealed, cataloged segment.
        cutoff = timeline['segments'][-1]['seq']
        sealed = [e for e in golden if seq_of(e) < cutoff]
        assert sealed, 'scenario must span multiple segments'

        session = open_session(reader)
        # Tiny threshold so a handful of events trips the reconcile.
        monkeypatch.setattr(rr_log_stream, '_LIVE_BUCKET_SPLIT_BYTES', 200)
        for event in sealed:
            session.ingest_live(event)
        # One event beyond the catalog must SURVIVE the reconcile.
        fresh = dict(golden[-1])
        fresh['body'] = dict(fresh['body'])
        fresh['body']['logSeq'] = seq_of(golden[-1]) + 999
        session.ingest_live(fresh)
        # Await the reconcile task itself (yield loops cannot cover its
        # real file I/O deterministically).
        assert session._reconcile_task is not None
        await session._reconcile_task
        assert all(seq_of(e) >= cutoff for e in session._live.events)
        assert any(seq_of(e) == seq_of(fresh) for e in session._live.events)
        # Byte accounting matches what is actually retained.
        assert session._live_bytes > 0
        assert not session._reconciling
