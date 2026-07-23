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
Unit tests for RunLogReader — the rrext_log one-code-path over the continuum.

Covers: chapters shape (begin/end date-time + starting seq + outcome per
track, activity-bar segment spans), ranged reads by seq/time with type
filtering, cursor paging that terminates and reproduces the unpaged result,
retention-horizon truncation flags, spool-preferred/store-fallback segment
resolution, delete beforeTime + delete all against both locations, and the
live-writer control preference (fresh in-memory control while a run is
active, spooled-only segments still readable).
"""

import json
import os
import shutil
import tempfile

import pytest

import ai.modules.task.run_log as run_log
from ai.account.store_providers.filesystem import FilesystemStore

# Shared helpers from the writer test module.
from .test_run_log import (
    CLIENT,
    KIND,
    PROJECT,
    SEED,
    SOURCE,
    STORE_PREFIX,
    STREAM,
    make_stamp,
    open_writer,
    output_event,
)
from ai.account.file_store import FileStore


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


async def seed_stream(istore, spool_root, monkeypatch, events=30):
    """Two completed runs with sealed + uploaded segments; returns a reader."""
    monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 512)
    stamp, raise_floor, state = make_stamp()
    writer = await open_writer(istore, spool_root, stamp, raise_floor)
    for i in range(events):
        writer.append(stamp(output_event(f'run1-{i:03d}-' + 'x' * 40)))
    await writer._drain_uploads()
    await writer.end_run('ok')

    writer2 = run_log.RunLogWriter(
        FileStore(istore, CLIENT), CLIENT, PROJECT, SOURCE, KIND, stamp, raise_floor, spool_root=spool_root
    )
    await writer2.open(trigger='manual', user=CLIENT, pipeline_hash='h2', trace_level=None)
    for i in range(5):
        writer2.append(stamp(output_event(f'run2-{i:03d}')))
    await writer2._drain_uploads()
    await writer2.end_run('error', 'boom')

    return run_log.RunLogReader(FileStore(istore, CLIENT), CLIENT, PROJECT, SOURCE, KIND, spool_root=spool_root)


# =============================================================================
# CHAPTERS
# =============================================================================


class TestChapters:
    @pytest.mark.asyncio
    async def test_chapters_shape(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        body = await reader.chapters()
        assert len(body['chapters']) == 2
        first, second = body['chapters']
        assert first['outcome'] == 'ok' and second['outcome'] == 'error'
        assert first['beginSeq'] < second['beginSeq']
        assert first['beginTime'] <= first['endTime']
        assert body['completed'] is True
        assert body['segments'] and all('startTime' in s for s in body['segments'])

    @pytest.mark.asyncio
    async def test_missing_stream_raises(self, istore, spool_root):
        reader = run_log.RunLogReader(FileStore(istore, CLIENT), CLIENT, 'nope', SOURCE, KIND, spool_root=spool_root)
        with pytest.raises(FileNotFoundError):
            await reader.chapters()


# =============================================================================
# RAW SEGMENT FETCH
# =============================================================================


class TestSegmentRaw:
    @pytest.mark.asyncio
    async def test_whole_segment_matches_stored_lines(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        body = await reader.chapters()
        seg_id = 0
        # Fetch every chunk and reassemble
        text = ''
        offset = 0
        while True:
            chunk = await reader.segment_raw(seg_id, offset=offset)
            assert chunk['segment'] == seg_id
            text += chunk['data']
            if chunk['final']:
                assert chunk['nextOffset'] is None
                break
            offset = chunk['nextOffset']
        # Reassembly equals the raw stored object BYTE-exactly (segments are
        # platform-stable: the writer pins newline='\n')
        raw = await istore.read_bytes(f'{STORE_PREFIX}.logs/{PROJECT}/{SOURCE}.{KIND}.{seg_id:06d}.jsonl')
        assert text.encode('utf-8') == raw
        assert body['segments']  # sanity: the timeline knows this segment

    @pytest.mark.asyncio
    async def test_chunks_are_line_aligned(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        offset = 0
        while True:
            # Tiny ceiling forces multiple chunks; every chunk must end on \n
            chunk = await reader.segment_raw(0, offset=offset, max_bytes=200)
            if chunk['data']:
                assert chunk['data'].endswith('\n')
                for line in chunk['data'].splitlines():
                    json.loads(line)  # every chunk parses standalone
            if chunk['final']:
                break
            offset = chunk['nextOffset']

    @pytest.mark.asyncio
    async def test_jumbo_line_ships_whole(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 1 << 20)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        writer.append(stamp(output_event('big-' + 'y' * 5000)))
        await writer._drain_uploads()
        await writer.end_run('ok')
        reader = run_log.RunLogReader(FileStore(istore, CLIENT), CLIENT, PROJECT, SOURCE, KIND, spool_root=spool_root)
        # Ceiling smaller than the line: the line must still arrive whole
        chunk = await reader.segment_raw(0, offset=0, max_bytes=64)
        first_line = chunk['data'].splitlines()[0]
        json.loads(first_line)
        assert len(first_line) > 64

    @pytest.mark.asyncio
    async def test_store_fallback_when_spool_gone(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        # Wipe the spool: uploaded segments must still serve from the store
        for name in os.listdir(spool_root):
            os.remove(os.path.join(spool_root, name))
        chunk = await reader.segment_raw(0, offset=0)
        assert chunk['size'] > 0 and chunk['data']

    @pytest.mark.asyncio
    async def test_missing_segment_raises(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        with pytest.raises(FileNotFoundError):
            await reader.segment_raw(9999)


# =============================================================================
# RANGED READS
# =============================================================================


class TestRead:
    @pytest.mark.asyncio
    async def test_full_range_ordered_and_complete(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        body = await reader.read(from_seq=0)
        seqs = [e['body']['logSeq'] for e in body['events']]
        assert seqs == sorted(seqs)
        outputs = [e for e in body['events'] if e['event'] == 'output']
        assert any('run1-000' in e['body']['output'] for e in outputs)
        assert any('run2-004' in e['body']['output'] for e in outputs)

    @pytest.mark.asyncio
    async def test_seq_range_and_types_filter(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        run2_begin = (await reader.chapters())['chapters'][1]['beginSeq']
        body = await reader.read(from_seq=run2_begin, types=['output'])
        assert body['events']
        assert all(e['event'] == 'output' for e in body['events'])
        assert all(e['body']['logSeq'] >= run2_begin for e in body['events'])
        assert all('run2-' in e['body']['output'] for e in body['events'])

    @pytest.mark.asyncio
    async def test_time_range_covers_track(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        run2 = (await reader.chapters())['chapters'][1]
        body = await reader.read(from_time=run2['beginTime'], to_time=run2['endTime'])
        actions = [e['body']['action'] for e in body['events'] if e['event'] == 'apaevt_log_lifecycle']
        assert 'run-begin' in actions and 'run-end' in actions

    @pytest.mark.asyncio
    async def test_cursor_paging_terminates_and_matches_unpaged(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        collected, cursor, pages = [], None, 0
        while True:
            body = await reader.read(from_seq=0, cursor=cursor, max_events=7)
            collected.extend(body['events'])
            pages += 1
            cursor = body.get('nextSeq')
            if cursor is None:
                break
            assert pages < 50, 'paging must terminate'
        assert pages > 1
        full = await reader.read(from_seq=0)
        assert [e['body']['logSeq'] for e in collected] == [e['body']['logSeq'] for e in full['events']]

    @pytest.mark.asyncio
    async def test_below_horizon_flags_truncation(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        # Evict history through a tiny ring in a third run.
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENTS', 1)
        stamp, raise_floor, _ = make_stamp(start=SEED + 10**9)
        writer = run_log.RunLogWriter(
            FileStore(istore, CLIENT), CLIENT, PROJECT, SOURCE, KIND, stamp, raise_floor, spool_root=spool_root
        )
        await writer.open(trigger='manual', user=CLIENT, pipeline_hash='h3', trace_level=None)
        for _ in range(30):
            writer.append(stamp(output_event('evict-' + 'y' * 60)))
        await writer.end_run('ok')

        body = await reader.read(from_seq=1)
        assert body.get('truncatedAtSeq', 0) > 0

    @pytest.mark.asyncio
    async def test_store_fallback_when_spool_gone(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        for name in os.listdir(spool_root):
            if name.startswith(f'{CLIENT}.{STREAM}.'):
                os.remove(os.path.join(spool_root, name))
        body = await reader.read(from_seq=0)
        assert body['events'], 'store fallback must serve the full range'


# =============================================================================
# DELETE
# =============================================================================


class TestDelete:
    @pytest.mark.asyncio
    async def test_delete_before_time(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        before = [e for e in (await reader.read(from_seq=0))['events'] if e['event'] == 'output']
        run1_before = sum(1 for e in before if 'run1-' in e['body']['output'])

        cutoff = (await reader.chapters())['chapters'][1]['beginTime']
        result = await reader.delete(before_time=cutoff)
        assert result['deletedSegments'] >= 1
        after = await reader.chapters()
        assert all((ch.get('endTime') or cutoff) >= cutoff for ch in after['chapters'])

        # Deletion is SEGMENT-granular (drop segments wholly older than
        # the cutoff). Runs seal at end_run, so run1's segments all predate
        # the cutoff and drop; run2 stays intact.
        outputs = [e for e in (await reader.read(from_seq=0))['events'] if e['event'] == 'output']
        run1_after = sum(1 for e in outputs if 'run1-' in e['body']['output'])
        assert run1_after < run1_before
        assert sum(1 for e in outputs if 'run2-' in e['body']['output']) == 5

    @pytest.mark.asyncio
    async def test_delete_all_removes_everything(self, istore, spool_root, monkeypatch):
        reader = await seed_stream(istore, spool_root, monkeypatch)
        result = await reader.delete(delete_all=True)
        assert result['deletedSegments'] >= 1
        files = await istore.list_files(f'{STORE_PREFIX}.logs/{PROJECT}')
        # Ignore the filesystem backend's dot-prefixed lock files.
        leftovers = [f for f in files if not f.rsplit('/', 1)[-1].startswith('.') and f'{SOURCE}.{KIND}' in f]
        assert leftovers == []
        with pytest.raises(FileNotFoundError):
            await reader.chapters()


# =============================================================================
# LIVE-WRITER COORDINATION
# =============================================================================


class TestLiveCoordination:
    @pytest.mark.asyncio
    async def test_reader_prefers_live_writer_control(self, istore, spool_root, monkeypatch):
        monkeypatch.setattr(run_log, 'CONST_LOG_SEGMENT_BYTES', 256)
        stamp, raise_floor, _ = make_stamp()
        writer = await open_writer(istore, spool_root, stamp, raise_floor)
        for _ in range(10):
            writer.append(stamp(output_event('live-' + 'z' * 40)))
        # No drain, no end_run: sealed segments exist only as spool copies and
        # the freshest control lives on the writer, not in the store.
        reader = run_log.RunLogReader(FileStore(istore, CLIENT), CLIENT, PROJECT, SOURCE, KIND, spool_root=spool_root)
        chapters = await reader.chapters()
        assert chapters['completed'] is False
        body = await reader.read(from_seq=0)
        assert any(e['event'] == 'output' and 'live-' in e['body']['output'] for e in body['events'])
        await writer.end_run('ok')
