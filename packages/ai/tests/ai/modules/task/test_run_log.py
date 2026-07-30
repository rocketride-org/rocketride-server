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
Unit tests for the run-log writer (per-task JSONL event continuum).

Covers the L2 contract from the run-logging plan: seq seeding + floor lift,
size + backstop + run-end sealing at line boundaries, the continuum across
multiple runs (chapters, chapterStart flags, seq continuity), ring + age retention
deleting BOTH locations and advancing the horizon, control-file state
transitions with the flip-before-delete ordering, payload truncation that
preserves metadata, store-side-only recovery (spooled entries dropped,
uploaded entries trusted), the clock-anomaly belt-and-suspenders marker,
segment read leases with deferred deletes, and spool startup hygiene.
"""

import os
import json
import time
import shutil
import tempfile

import pytest

import ai.modules.task.run_log as run_log
from ai.modules.task.run_log import (
    LEASES,
    RunLogWriter,
    control_store_path,
    segment_store_path,
    spool_path,
    stream_name,
    sweep_spool_root,
    truncate_event,
)
from ai.account.file_store import FileStore
from ai.account.store import Store
from ai.account.models import RequestContext
from ai.account.store_providers.filesystem import FilesystemStore

CLIENT = 'user-1'
PROJECT = 'proj-1'
SOURCE = 'chat_1'
KIND = 'dev'
STREAM = stream_name(PROJECT, SOURCE, KIND)

# Raw-IStore prefix the account FileStore scopes everything under — tests
# reach BEHIND the FileStore with the raw istore to verify on-store layout.
STORE_PREFIX = f'users/{CLIENT}/files/'

# The continuum starts at 1 on a fresh stream (catalog-seeded thereafter:
# control.lastSeq + 1), matching production.
SEED = 1


# =============================================================================
# HELPERS
# =============================================================================


def make_stamp(start: int = SEED):
    """Build a fake task-side stamp: body eventTime + logSeq, floor-aware."""
    state = {'next': start, 'floor_calls': []}

    def stamp(message, *, event_time=None):
        # Mirror Task.stamp_log_event: the stamps ride in the BODY (the DAP
        # envelope is pure protocol); eventTime once; logSeq assigned once.
        body = message.get('body')
        if not isinstance(body, dict):
            body = {}
            message['body'] = body
        if 'eventTime' not in body:
            body['eventTime'] = event_time if event_time is not None else time.time()
        if 'logSeq' not in body:
            body['logSeq'] = state['next']
            state['next'] += 1
        return message

    def raise_floor(floor):
        # Mirror Task.raise_log_seq_floor: only ever move forward.
        state['floor_calls'].append(floor)
        if floor > state['next']:
            state['next'] = floor

    return stamp, raise_floor, state


def output_event(text: str = 'hello'):
    """A minimal loggable output event (unstamped)."""
    return {'type': 'event', 'event': 'output', 'body': {'category': 'console', 'output': text}}


def flow_event(data=None):
    """A minimal loggable flow event (unstamped)."""
    return {
        'type': 'event',
        'event': 'apaevt_flow',
        'body': {'id': 1, 'op': 'enter', 'pipes': ['base', 'x'], 'trace': {'lane': 'text', 'data': data or {}}},
    }


def flow_op(op, pid=1, component='x', data=None, pipes=None):
    """A flow event with an explicit op/component/data (unstamped)."""
    body = {'id': pid, 'op': op, 'component': component, 'pipes': pipes or ['base', component]}
    if op in ('enter', 'leave'):
        body['trace'] = {'lane': 'open', 'data': data}
    else:
        body['trace'] = {}
    return {'type': 'event', 'event': 'apaevt_flow', 'body': body}


def status_event(**fields):
    """A status-update event with the given body fields (unstamped)."""
    return {'type': 'event', 'event': 'apaevt_status_update', 'body': dict(fields)}


def make_file_store(istore) -> FileStore:
    """An internal-identity FileStore over the shared test istore.

    Each call deliberately wraps the istore in its OWN Store: separate
    handle/lock registries per consumer, modeling independent subsystems
    (writer vs reader vs a fresh process) coordinating only through the
    backend — the shape production has across processes.
    """
    return FileStore(Store(istore), CLIENT, RequestContext.internal('test'))


async def open_writer(istore, spool_root, stamp=None, raise_floor=None, kind=KIND):
    """Create + open a writer with fake stamping callbacks."""
    if stamp is None:
        stamp, raise_floor, _ = make_stamp()
    writer = RunLogWriter(
        make_file_store(istore),
        CLIENT,
        PROJECT,
        SOURCE,
        kind,
        stamp,
        raise_floor,
        spool_root=spool_root,
    )
    await writer.open(trigger='manual', user=CLIENT, pipeline_hash='abc123', trace_level='summary')
    return writer


def read_spool_lines(spool_root, stream=STREAM, *, decode=True, keep_keyframes=False):
    """
    Read every JSONL line currently spooled for the stream (flat files).

    Each spool file is one segment: by default its lines are decoded back to
    full events through a per-segment SegmentDecoder and keyframe preambles
    are dropped (pass decode=False / keep_keyframes=True for the raw form).
    """
    prefix = f'{CLIENT}.{stream}.'
    lines = []
    for name in sorted(os.listdir(spool_root)):
        if not (name.startswith(prefix) and name.endswith('.jsonl')):
            continue
        decoder = run_log.SegmentDecoder()
        with open(os.path.join(spool_root, name), encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                msg = json.loads(line)
                if msg.get('type') == 'keyframe':
                    if decode:
                        decoder.seed(msg)
                    if keep_keyframes:
                        lines.append(msg)
                    continue
                lines.append(decoder.decode(msg) if decode else msg)
    return lines


async def read_stream_lines(istore, spool_root, stream=STREAM, *, decode=True, keep_keyframes=False):
    """
    Read the ENTIRE stream's lines: uploaded store segments (by ascending
    segment id) followed by whatever is still spooled. Runs force-seal and
    upload at end_run, so post-run assertions must look at the store, not
    the (already flip-and-deleted) spool copy.

    v2 segments carry a keyframe preamble and delta bodies: by default the
    lines are DECODED back to full events (each segment through its own
    SegmentDecoder — which also exercises the codec round-trip), and
    keyframe lines are dropped. Pass decode=False for the raw stored form,
    keep_keyframes=True to receive keyframe lines too.
    """
    lines = []

    def consume(text: str) -> None:
        decoder = run_log.SegmentDecoder()
        for line in text.splitlines():
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get('type') == 'keyframe':
                if decode:
                    decoder.seed(msg)
                if keep_keyframes:
                    lines.append(msg)
                continue
            lines.append(decoder.decode(msg) if decode else msg)

    listing = await istore.list_files(f'{STORE_PREFIX}.logs/{PROJECT}')
    names = sorted(
        path for path in (listing or []) if f'{SOURCE}.{KIND}.' in path.rsplit('/', 1)[-1] and path.endswith('.jsonl')
    )
    for path in names:
        raw = await istore.read_file(path)
        consume(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else str(raw))
    lines.extend(read_spool_lines(spool_root, stream, decode=decode, keep_keyframes=keep_keyframes))
    return lines


# =============================================================================
# FIXTURES
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


# =============================================================================
# BASIC APPEND / MARKERS
# =============================================================================


class TestAppendAndMarkers:
    @pytest.mark.asyncio
    async def test_run_begin_marker_is_first_line_and_credential_free(self, istore, spool_root):
        writer = await open_writer(istore, spool_root)
        await writer.end_run('ok')

        lines = await read_stream_lines(istore, spool_root)
        begin = lines[0]
        assert begin['event'] == 'apaevt_log_lifecycle'
        assert begin['body']['action'] == 'run-begin'
        assert begin['body']['projectId'] == PROJECT
        assert begin['body']['runKind'] == KIND
        # Body stamps present; no token anywhere in the marker.
        assert begin['body']['logSeq'] >= SEED
        assert begin['body']['eventTime'] > 0
        assert 'token' not in json.dumps(begin).lower() or 'tk_' not in json.dumps(begin)

    @pytest.mark.asyncio
    async def test_append_records_all_types_and_samples_status(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        # It is a LOG: every event type delivered to clients is recorded.
        writer.append(stamp({'type': 'event', 'event': 'apaevt_status_object', 'body': {}}))
        # Two status snapshots inside one sample window: only the first lands.
        now = time.time()
        writer.append(stamp({'type': 'event', 'event': 'apaevt_status_update', 'body': {}, 'eventTime': now}))
        writer.append(stamp({'type': 'event', 'event': 'apaevt_status_update', 'body': {}, 'eventTime': now + 0.5}))
        writer.append(stamp(output_event('kept')))
        await writer.end_run('ok')

        events = [ln['event'] for ln in await read_stream_lines(istore, spool_root)]
        assert events.count('apaevt_status_object') == 1
        assert events.count('apaevt_status_update') == 1
        assert events.count('output') == 1

    @pytest.mark.asyncio
    async def test_seq_strictly_monotonic_within_run(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for i in range(5):
            writer.append(stamp(output_event(f'line {i}')))
        await writer.end_run('ok')

        seqs = [ln['body']['logSeq'] for ln in await read_stream_lines(istore, spool_root)]
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)


# =============================================================================
# SEGMENT CODEC (keyframes + deltas)
# =============================================================================


class TestSegmentCodec:
    @pytest.mark.asyncio
    async def test_every_segment_opens_with_keyframe(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 512)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for i in range(20):
            writer.append(stamp(output_event('x' * 100)))
        await writer._drain_uploads()
        await writer.end_run('ok')

        raw = await read_stream_lines(istore, spool_root, decode=False, keep_keyframes=True)
        # Group by segment: every stored segment file starts with a keyframe.
        listing = await istore.list_files(f'{STORE_PREFIX}.logs/{PROJECT}')
        seg_files = [p for p in (listing or []) if p.endswith('.jsonl')]
        keyframes = [m for m in raw if m.get('type') == 'keyframe']
        assert len(keyframes) == len(seg_files)
        for kf in keyframes:
            assert kf['ver'] == run_log.LOG_SCHEMA_VERSION
            assert 'status' in kf and 'openFrames' in kf and 'console' in kf

    @pytest.mark.asyncio
    async def test_golden_round_trip_status_and_leave_deltas(self, istore, spool_root, monkeypatch):
        """THE writer/reader golden test: reconstruct == exactly what was appended."""
        monkeypatch.setattr(run_log, 'CONST_LOG_STATUS_SAMPLE_SECONDS', 0.0)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        appended = []

        def log(msg):
            appended.append(json.loads(json.dumps(msg)))  # deep copy of the full form
            writer.append(msg)

        big = {'text': 'T' * 500, 'meta': {'name': 'doc.pdf', 'pages': 3}}
        log(stamp(status_event(totalCount=0, metrics={'cpu': 1.5, 'mem': 100})))
        log(stamp(flow_op('begin', pid=7, component='doc.pdf', pipes=['doc.pdf'])))
        log(stamp(flow_op('enter', pid=7, component='parse_1', data=big)))
        # Leave with a barely-changed payload => stored as a small delta
        changed = {'text': big['text'], 'meta': {'name': 'doc.pdf', 'pages': 4}}
        log(stamp(flow_op('leave', pid=7, component='parse_1', data=changed)))
        log(stamp(status_event(totalCount=1, metrics={'cpu': 2.0, 'mem': 100})))
        log(stamp(flow_op('end', pid=7, component='doc.pdf')))
        await writer.end_run('ok')

        # Raw form proves deltas were actually written (not just passthrough)
        raw = await read_stream_lines(istore, spool_root, decode=False)
        raw_leaves = [m for m in raw if m.get('event') == 'apaevt_flow' and m['body'].get('op') == 'leave']
        assert run_log.DELTA_KEY in raw_leaves[0]['body']['trace']['data']
        raw_statuses = [m for m in raw if m.get('event') == 'apaevt_status_update']
        assert run_log.DELTA_KEY in raw_statuses[1]['body']  # second status is a delta

        # Decoded form reconstructs the appended events EXACTLY
        decoded = await read_stream_lines(istore, spool_root)
        decoded_by_seq = {
            m['body']['logSeq']: m for m in decoded if isinstance(m.get('body'), dict) and 'logSeq' in m['body']
        }
        for original in appended:
            assert decoded_by_seq[original['body']['logSeq']] == original

    @pytest.mark.asyncio
    async def test_cross_segment_leave_stored_full(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 400)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        payload = {'text': 'P' * 120, 'k': 1}
        writer.append(stamp(flow_op('begin', pid=3, component='d.pdf', pipes=['d.pdf'])))
        writer.append(stamp(flow_op('enter', pid=3, component='parse_1', data=payload)))
        # Force a seal between enter and leave: the leave's base is now in a
        # previous segment => it must be stored FULL.
        for i in range(6):
            writer.append(stamp(output_event('pad-' + 'z' * 90)))
        writer.append(stamp(flow_op('leave', pid=3, component='parse_1', data={'text': 'P' * 120, 'k': 2})))
        await writer.end_run('ok')

        raw = await read_stream_lines(istore, spool_root, decode=False)
        leaves = [m for m in raw if m.get('event') == 'apaevt_flow' and m['body'].get('op') == 'leave']
        assert leaves and run_log.DELTA_KEY not in (leaves[0]['body']['trace'].get('data') or {})
        # And the decoded stream still carries the full leave payload
        decoded = await read_stream_lines(istore, spool_root)
        dec_leaves = [m for m in decoded if m.get('event') == 'apaevt_flow' and m['body'].get('op') == 'leave']
        assert dec_leaves[0]['body']['trace']['data'] == {'text': 'P' * 120, 'k': 2}

    @pytest.mark.asyncio
    async def test_keyframe_carries_open_frames_and_console(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 400)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        writer.append(stamp(output_event('console-line-1')))
        writer.append(stamp(flow_op('begin', pid=9, component='open.pdf', pipes=['open.pdf'])))
        writer.append(stamp(flow_op('enter', pid=9, component='parse_1', data={'a': 1})))
        # Pad to force a seal while pid 9 is still open
        for i in range(6):
            writer.append(stamp(output_event('pad-' + 'w' * 90)))
        writer.append(stamp(output_event('after-boundary')))
        await writer.end_run('ok')

        raw = await read_stream_lines(istore, spool_root, decode=False, keep_keyframes=True)
        keyframes = [m for m in raw if m.get('type') == 'keyframe']
        # Some later keyframe must list the still-open frame + carried console
        carried = [kf for kf in keyframes if kf.get('openFrames')]
        assert carried, 'expected a keyframe carrying the open frame across the boundary'
        frame = carried[0]['openFrames'][0]
        assert frame['id'] == 9 and frame['component'] == 'parse_1' and frame['doc'] == 'open.pdf'
        assert isinstance(frame['touched'], list) and frame['touched']
        assert any('console-line-1' in line for line in carried[0]['console']['lines'])

    @pytest.mark.asyncio
    async def test_resumed_stream_marks_first_keyframe_incomplete(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('run-1')))
        await writer.end_run('ok')

        # A FRESH process (new writer) resumes the stream: its first keyframe
        # must be marked incomplete (pre-existing open state is unknown).
        writer2 = RunLogWriter(
            make_file_store(istore),
            CLIENT,
            PROJECT,
            SOURCE,
            KIND,
            stamp,
            raise_floor,
            spool_root=spool_root,
        )
        await writer2.open(trigger='manual', user=CLIENT, pipeline_hash='h2', trace_level=None)
        writer2.append(stamp(output_event('run-2')))
        await writer2.end_run('ok')

        raw = await read_stream_lines(istore, spool_root, decode=False, keep_keyframes=True)
        keyframes = [m for m in raw if m.get('type') == 'keyframe']
        assert keyframes[0]['complete'] is True
        assert any(kf['complete'] is False for kf in keyframes[1:])


# =============================================================================
# SEALING
# =============================================================================


class TestSealing:
    @pytest.mark.asyncio
    async def test_size_seal_cuts_on_line_boundary_and_records_entry(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 512)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        for i in range(20):
            writer.append(stamp(output_event('x' * 100)))

        segments = writer._control['segments']
        assert len(segments) >= 1
        first = segments[0]
        assert first['state'] in ('spooled', 'uploaded')
        assert first['id'] == 0
        assert first['seq'] >= SEED
        assert first['startTime'] > 0 and first['endTime'] > 0
        # Chapter began in segment 0 (the run-begin marker lives there).
        assert first['chapterStart'] is True

        # Sealed spool file parses line-by-line (line-boundary cut).
        path = spool_path(spool_root, CLIENT, STREAM, 0)
        with open(path, encoding='utf-8') as f:
            for line in f:
                json.loads(line)
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_backstop_seal_fires_on_age(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_BACKSTOP_SEAL_SECONDS', 0.01)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('aged')))
        writer._active_start_time -= 1.0  # age the active segment past the backstop

        assert writer._maybe_backstop_seal() is True
        assert writer._control['segments'][-1]['state'] == 'spooled'
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_backstop_does_not_fire_when_young(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('young')))
        assert writer._maybe_backstop_seal() is False
        await writer.end_run('ok')


# =============================================================================
# UPLOAD / STATE TRANSITIONS
# =============================================================================


class TestUpload:
    @pytest.mark.asyncio
    async def test_drain_uploads_flips_state_then_deletes_spool(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for _ in range(10):
            writer.append(stamp(output_event('y' * 64)))
        await writer._drain_uploads()

        uploaded = [s for s in writer._control['segments'] if s['state'] == 'uploaded']
        assert uploaded, 'expected at least one uploaded segment'
        seg = uploaded[0]
        # Store object exists and matches the JSONL format.
        data = await istore.read_file(STORE_PREFIX + segment_store_path(PROJECT, SOURCE, KIND, seg['id']))
        for line in data.splitlines():
            json.loads(line)
        # Spool copy deleted (no lease held).
        assert not os.path.exists(spool_path(spool_root, CLIENT, STREAM, seg['id']))
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_upload_failure_keeps_spool_and_retries(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for _ in range(10):
            writer.append(stamp(output_event('z' * 64)))

        # First drain fails: state stays 'spooled', file stays, queue keeps
        # it. FileStore.write rides IStore.open_write — fail it there.
        original = istore.open_write

        async def boom(*args, **kwargs):
            raise RuntimeError('s3 down')

        monkeypatch.setattr(istore, 'open_write', boom)
        await writer._drain_uploads()
        seg = writer._control['segments'][0]
        assert seg['state'] == 'spooled'
        seg_spool = spool_path(spool_root, CLIENT, STREAM, seg['id'])
        assert os.path.exists(seg_spool)

        # Store recovers: retry succeeds and completes the transition.
        monkeypatch.setattr(istore, 'open_write', original)
        await writer._drain_uploads()
        assert writer._control['segments'][0]['state'] == 'uploaded'
        assert not os.path.exists(seg_spool)
        await writer.end_run('ok')


# =============================================================================
# CONTINUUM ACROSS RUNS
# =============================================================================


class TestContinuum:
    @pytest.mark.asyncio
    async def test_two_runs_share_stream_chapters_and_seq_continue(self, istore, spool_root):
        stamp, raise_floor, state = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('run1')))
        await writer.end_run('ok')
        run1_last = int(writer._control['lastSeq'])

        # Second run: same identity, new writer instance (fresh process).
        # A fresh counter always starts at 1 — below the persisted lastSeq —
        # so the catalog floor lift is what carries the continuum forward.
        stamp2, raise_floor2, state2 = make_stamp()
        writer2 = RunLogWriter(
            make_file_store(istore),
            CLIENT,
            PROJECT,
            SOURCE,
            KIND,
            stamp2,
            raise_floor2,
            spool_root=spool_root,
        )
        await writer2.open(trigger='manual', user=CLIENT, pipeline_hash='abc123', trace_level='summary')
        writer2.append(stamp2(output_event('run2')))
        await writer2.end_run('error', 'boom')

        control = writer2._control
        # Two completed chapters, in order, with outcomes.
        chapters = control['chapters']
        assert len(chapters) == 2
        assert chapters[0]['outcome'] == 'ok'
        assert chapters[1]['outcome'] == 'error'
        assert chapters[1]['beginSeq'] > chapters[0]['beginSeq']
        # Seq continued past run 1 via the catalog floor lift.
        assert raise_floor2 is not None
        assert state2['floor_calls'] and state2['floor_calls'][0] == run1_last + 1
        assert int(control['lastSeq']) > run1_last

    @pytest.mark.asyncio
    async def test_restart_marker_does_not_open_new_chapter(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.note_restart()
        await writer.end_run('ok')

        control = writer._control
        assert len(control['chapters']) == 1
        actions = [
            ln['body']['action']
            for ln in await read_stream_lines(istore, spool_root)
            if ln['event'] == 'apaevt_log_lifecycle'
        ]
        assert actions == ['run-begin', 'restart', 'run-end']


# =============================================================================
# RETENTION (RING + AGE) AND HORIZON
# =============================================================================


class TestRetention:
    @pytest.mark.asyncio
    async def test_ring_evicts_oldest_from_both_locations(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENTS', 2)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        # Force several seals; keep uploads drained so evictions hit the store.
        for _ in range(30):
            writer.append(stamp(output_event('r' * 64)))
            await writer._drain_uploads()
        # Let pending eviction tasks run.
        import asyncio

        await asyncio.sleep(0)
        await asyncio.sleep(0)

        control = writer._control
        assert len(control['segments']) <= 2
        assert int(control['horizonSeq']) > 0
        # Evicted ids are gone from the store; retained ids are present.
        retained = {s['id'] for s in control['segments']}
        evicted_id = 0
        assert evicted_id not in retained
        files = await istore.list_files(f'{STORE_PREFIX}.logs/{PROJECT}')
        assert segment_store_path(PROJECT, SOURCE, KIND, evicted_id).split('/')[-1] not in [
            f.split('/')[-1] for f in files
        ]
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_age_eviction_drops_old_segments_and_trims_chapters(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for _ in range(10):
            writer.append(stamp(output_event('a' * 64)))

        # Backdate everything past the dev history age, then retent.
        cutoff_shift = run_log.history_seconds(KIND) + 1000
        for seg in writer._control['segments']:
            seg['startTime'] -= cutoff_shift
            seg['endTime'] -= cutoff_shift
        for ch in writer._control['chapters']:
            ch['beginTime'] -= cutoff_shift
            if ch.get('endTime'):
                ch['endTime'] -= cutoff_shift
        writer._apply_retention()

        assert writer._control['segments'] == []
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_chapters_capped_at_constant(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_CHAPTERS', 3)
        stamp, raise_floor, _ = make_stamp()
        writer = None
        for i in range(5):
            writer = RunLogWriter(
                make_file_store(istore),
                CLIENT,
                PROJECT,
                SOURCE,
                KIND,
                stamp,
                raise_floor,
                spool_root=spool_root,
            )
            await writer.open(trigger='manual', user=CLIENT, pipeline_hash='h', trace_level=None)
            await writer.end_run('ok')
        assert len(writer._control['chapters']) == 3


# =============================================================================
# STORE-SIDE RECOVERY
# =============================================================================


class TestRecovery:
    @pytest.mark.asyncio
    async def test_recovery_trusts_uploaded_drops_spooled(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for _ in range(10):
            writer.append(stamp(output_event('u' * 64)))
        await writer._drain_uploads()

        # Simulate a crash mid-run WITH an un-uploaded sealed segment: craft
        # the control to contain one uploaded + one spooled entry, persist,
        # then "replace the container" (new writer, fresh spool root).
        writer._control['segments'].append(
            {
                'startTime': time.time(),
                'endTime': time.time(),
                'chapterStart': False,
                'seq': SEED + 500,
                'id': 99,
                'state': 'spooled',
            }
        )
        await writer._write_control()

        fresh_spool = tempfile.mkdtemp()
        try:
            stamp2, raise_floor2, state2 = make_stamp()
            writer2 = RunLogWriter(
                make_file_store(istore),
                CLIENT,
                PROJECT,
                SOURCE,
                KIND,
                stamp2,
                raise_floor2,
                spool_root=fresh_spool,
            )
            await writer2.open(trigger='manual', user=CLIENT, pipeline_hash='h', trace_level=None)

            segments = writer2._control['segments']
            ids = {s['id'] for s in segments}
            # The spooled entry from the "old container" died with it.
            assert 99 not in ids
            # Every entry that predates the recovery is trusted-as-uploaded;
            # entries the NEW process seals (the tiny test segment size seals
            # even the run-begin marker) are legitimately 'spooled'.
            assert all(s['state'] == 'uploaded' for s in segments if s['id'] < 6)
            # Floor lifted from the persisted lastSeq.
            assert state2['floor_calls'] and state2['floor_calls'][0] > 0
            await writer2.end_run('ok')
        finally:
            shutil.rmtree(fresh_spool, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_fresh_stream_initializes_control(self, istore, spool_root):
        writer = await open_writer(istore, spool_root)
        control_raw = await istore.read_file(STORE_PREFIX + control_store_path(PROJECT, SOURCE, KIND))
        control = json.loads(control_raw)
        assert control['schemaVer'] == run_log.LOG_SCHEMA_VERSION
        assert control['projectId'] == PROJECT
        assert control['runKind'] == KIND
        assert control['completed'] is False
        await writer.end_run('ok')
        control = json.loads(await istore.read_file(STORE_PREFIX + control_store_path(PROJECT, SOURCE, KIND)))
        assert control['completed'] is True


# =============================================================================
# TRUNCATION
# =============================================================================


class TestTruncation:
    def test_oversized_trace_data_truncated_metadata_survives(self):
        msg = flow_event(data={'blob': 'x' * 200_000})
        msg['body']['eventTime'] = 123.456
        msg['body']['logSeq'] = SEED
        clipped = truncate_event(msg, max_bytes=1024)
        assert clipped is not msg
        assert clipped['__truncated'] is True
        assert clipped['body']['eventTime'] == 123.456
        assert clipped['body']['logSeq'] == SEED
        assert clipped['body']['op'] == 'enter'
        assert clipped['body']['trace']['data']['__truncated'] is True

    def test_small_events_pass_untouched(self):
        msg = output_event('short')
        assert truncate_event(msg, max_bytes=1024) is msg


# =============================================================================
# LEASES + STARTUP HYGIENE
# =============================================================================


class TestLeasesAndSweep:
    def test_lease_defers_delete_until_release(self, tmp_path):
        path = str(tmp_path / 'seg.jsonl')
        with open(path, 'w') as f:
            f.write('{}\n')

        LEASES.acquire(path)
        LEASES.delete(path)
        assert os.path.exists(path), 'delete must defer while leased'
        LEASES.release(path)
        assert not os.path.exists(path), 'deferred delete must run at release'

    def test_unleased_delete_is_immediate(self, tmp_path):
        path = str(tmp_path / 'seg2.jsonl')
        with open(path, 'w') as f:
            f.write('{}\n')
        LEASES.delete(path)
        assert not os.path.exists(path)

    def test_sweep_spool_root_deletes_stale_files_only(self):
        root = tempfile.mkdtemp()
        try:
            # Our pattern: deleted. Foreign files in the shared temp: kept.
            stale = os.path.join(root, 'user-x.proj.src.dev.000003.jsonl')
            with open(stale, 'w') as f:
                f.write('{}\n')
            foreign = os.path.join(root, 'unrelated.txt')
            with open(foreign, 'w') as f:
                f.write('keep me')
            legacy = os.path.join(root, 'rocketride-runlog-spool', 'nested')
            os.makedirs(legacy)
            sweep_spool_root(root)
            assert os.path.isdir(root)
            assert not os.path.exists(stale)
            assert os.path.exists(foreign), 'sweep must never touch foreign files'
            assert not os.path.exists(os.path.join(root, 'rocketride-runlog-spool'))
        finally:
            shutil.rmtree(root, ignore_errors=True)
