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
size + backstop sealing at line boundaries, the continuum across multiple
runs (chapters, chapterStart flags, shared segments), ring + age retention
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
    segment_basename,
    segment_store_path,
    spool_dir,
    stream_name,
    sweep_spool_root,
    truncate_event,
)
from ai.account.store_providers.filesystem import FilesystemStore

CLIENT = 'user-1'
PROJECT = 'proj-1'
SOURCE = 'chat_1'
KIND = 'dev'
STREAM = stream_name(PROJECT, SOURCE, KIND)

# Epoch-us style seed far above CONST_LOG_SEQ_FLOOR, matching production.
SEED = 1_784_000_000_000_000


# =============================================================================
# HELPERS
# =============================================================================


def make_stamp(start: int = SEED):
    """Build a fake task-side stamp: counter + eventTime, floor-aware."""
    state = {'next': start, 'floor_calls': []}

    def stamp(message, *, event_time=None):
        # Mirror Task.stamp_log_event: eventTime once; re-stamp small seqs.
        if 'eventTime' not in message:
            message['eventTime'] = event_time if event_time is not None else time.time()
        if message.get('seq', 0) < 10**14:
            message['seq'] = state['next']
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


async def open_writer(istore, spool_root, stamp=None, raise_floor=None, kind=KIND):
    """Create + open a writer with fake stamping callbacks."""
    if stamp is None:
        stamp, raise_floor, _ = make_stamp()
    writer = RunLogWriter(istore, CLIENT, PROJECT, SOURCE, kind, stamp, raise_floor, spool_root=spool_root)
    await writer.open(trigger='manual', user=CLIENT, pipeline_hash='abc123', trace_level='summary')
    return writer


def read_spool_lines(spool_root, stream=STREAM):
    """Read every JSONL line currently in the stream's spool dir, in order."""
    directory = spool_dir(spool_root, CLIENT, stream)
    lines = []
    for name in sorted(os.listdir(directory)):
        with open(os.path.join(directory, name), encoding='utf-8') as f:
            lines.extend(json.loads(line) for line in f if line.strip())
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

        lines = read_spool_lines(spool_root)
        begin = lines[0]
        assert begin['event'] == 'apaevt_log_lifecycle'
        assert begin['body']['action'] == 'run-begin'
        assert begin['body']['projectId'] == PROJECT
        assert begin['body']['runKind'] == KIND
        # Header stamps present; no token anywhere in the marker.
        assert begin['seq'] >= SEED
        assert begin['eventTime'] > 0
        assert 'token' not in json.dumps(begin).lower() or 'tk_' not in json.dumps(begin)

    @pytest.mark.asyncio
    async def test_append_filters_unlogged_types_and_samples_status(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)

        # Unlogged type: dropped.
        writer.append(stamp({'type': 'event', 'event': 'apaevt_status_object', 'body': {}}))
        # Two status snapshots inside one sample window: only the first lands.
        now = time.time()
        writer.append(stamp({'type': 'event', 'event': 'apaevt_status_update', 'body': {}, 'eventTime': now}))
        writer.append(stamp({'type': 'event', 'event': 'apaevt_status_update', 'body': {}, 'eventTime': now + 0.5}))
        writer.append(stamp(output_event('kept')))
        await writer.end_run('ok')

        events = [ln['event'] for ln in read_spool_lines(spool_root)]
        assert events.count('apaevt_status_object') == 0
        assert events.count('apaevt_status_update') == 1
        assert events.count('output') == 1

    @pytest.mark.asyncio
    async def test_seq_strictly_monotonic_within_run(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for i in range(5):
            writer.append(stamp(output_event(f'line {i}')))
        await writer.end_run('ok')

        seqs = [ln['seq'] for ln in read_spool_lines(spool_root)]
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)


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
        path = os.path.join(spool_dir(spool_root, CLIENT, STREAM), segment_basename(STREAM, 0))
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
        data = await istore.read_file(segment_store_path(CLIENT, STREAM, seg['id']))
        for line in data.splitlines():
            json.loads(line)
        # Spool copy deleted (no lease held).
        assert not os.path.exists(
            os.path.join(spool_dir(spool_root, CLIENT, STREAM), segment_basename(STREAM, seg['id']))
        )
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_upload_failure_keeps_spool_and_retries(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for _ in range(10):
            writer.append(stamp(output_event('z' * 64)))

        # First drain fails: state stays 'spooled', file stays, queue keeps it.
        original = istore.write_bytes

        async def boom(*args, **kwargs):
            raise RuntimeError('s3 down')

        monkeypatch.setattr(istore, 'write_bytes', boom)
        await writer._drain_uploads()
        seg = writer._control['segments'][0]
        assert seg['state'] == 'spooled'
        spool_path = os.path.join(spool_dir(spool_root, CLIENT, STREAM), segment_basename(STREAM, seg['id']))
        assert os.path.exists(spool_path)

        # Store recovers: retry succeeds and completes the transition.
        monkeypatch.setattr(istore, 'write_bytes', original)
        await writer._drain_uploads()
        assert writer._control['segments'][0]['state'] == 'uploaded'
        assert not os.path.exists(spool_path)
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

        # Second run: same identity, new writer instance (fresh process),
        # fresh stamp whose epoch seed is BELOW the persisted lastSeq to
        # prove the floor lift (belt and suspenders) wins.
        stamp2, raise_floor2, state2 = make_stamp(start=SEED - 1_000_000)
        writer2 = RunLogWriter(istore, CLIENT, PROJECT, SOURCE, KIND, stamp2, raise_floor2, spool_root=spool_root)
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
        # Seq continued past run 1 despite the lower clock seed.
        assert raise_floor2 is not None
        assert state2['floor_calls'] and state2['floor_calls'][0] == run1_last + 1
        assert int(control['lastSeq']) > run1_last

    @pytest.mark.asyncio
    async def test_clock_anomaly_marker_written_when_clock_below_last_seq(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('run1')))
        await writer.end_run('ok')

        # Simulate a stream whose lastSeq sits ABOVE the real epoch-us clock
        # (i.e. the clock stepped backward since those seqs were issued): the
        # reopen must fall back to lastSeq + 1 AND record the anomaly in the
        # stream itself, never absorb it silently.
        future_seq = int(time.time() * 1_000_000) + 10**12
        writer._control['lastSeq'] = future_seq
        await writer._write_control()

        stamp2, raise_floor2, state2 = make_stamp()
        writer2 = RunLogWriter(istore, CLIENT, PROJECT, SOURCE, KIND, stamp2, raise_floor2, spool_root=spool_root)
        await writer2.open(trigger='manual', user=CLIENT, pipeline_hash='abc123', trace_level='summary')
        await writer2.end_run('ok')

        actions = [ln['body']['action'] for ln in read_spool_lines(spool_root) if ln['event'] == 'apaevt_log_lifecycle']
        assert 'clock-anomaly' in actions
        # The floor fell back to lastSeq + 1 (the belt won over the clock).
        assert state2['floor_calls'] and state2['floor_calls'][0] == future_seq + 1

    @pytest.mark.asyncio
    async def test_restart_marker_does_not_open_new_chapter(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.note_restart()
        await writer.end_run('ok')

        control = writer._control
        assert len(control['chapters']) == 1
        actions = [ln['body']['action'] for ln in read_spool_lines(spool_root) if ln['event'] == 'apaevt_log_lifecycle']
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
        files = await istore.list_files(f'users/{CLIENT}/logs/')
        assert segment_store_path(CLIENT, STREAM, evicted_id).split('/')[-1] not in [f.split('/')[-1] for f in files]
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
            writer = RunLogWriter(istore, CLIENT, PROJECT, SOURCE, KIND, stamp, raise_floor, spool_root=spool_root)
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
            writer2 = RunLogWriter(istore, CLIENT, PROJECT, SOURCE, KIND, stamp2, raise_floor2, spool_root=fresh_spool)
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
        control_raw = await istore.read_file(control_store_path(CLIENT, STREAM))
        control = json.loads(control_raw)
        assert control['schemaVer'] == run_log.LOG_SCHEMA_VERSION
        assert control['projectId'] == PROJECT
        assert control['runKind'] == KIND
        assert control['completed'] is False
        await writer.end_run('ok')
        control = json.loads(await istore.read_file(control_store_path(CLIENT, STREAM)))
        assert control['completed'] is True


# =============================================================================
# TRUNCATION
# =============================================================================


class TestTruncation:
    def test_oversized_trace_data_truncated_metadata_survives(self):
        msg = flow_event(data={'blob': 'x' * 200_000})
        msg['eventTime'] = 123.456
        msg['seq'] = SEED
        clipped = truncate_event(msg, max_bytes=1024)
        assert clipped is not msg
        assert clipped['__truncated'] is True
        assert clipped['eventTime'] == 123.456
        assert clipped['seq'] == SEED
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

    def test_sweep_spool_root_deletes_stale_dirs(self):
        root = tempfile.mkdtemp()
        try:
            stale = os.path.join(root, 'user-x', 'proj.src.dev')
            os.makedirs(stale)
            with open(os.path.join(stale, 'leftover.jsonl'), 'w') as f:
                f.write('{}\n')
            sweep_spool_root(root)
            assert os.path.isdir(root)
            assert not os.path.exists(stale)
        finally:
            shutil.rmtree(root, ignore_errors=True)
