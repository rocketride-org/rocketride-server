"""A spool the producer writes and the server reads along, plus the command that serves it.
The contract they share: a read at the end of a live artifact waits for the producer.
"""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account import live_media
from ai.account.live_media import LiveReader, LiveWriter
from ai.modules.task.commands.cmd_media import MediaCommands

CLIENT = 'user-1'
PATH = 'outputs/video/x.mp4'


@pytest.fixture(autouse=True)
def spool_dir(tmp_path, monkeypatch):
    """Isolate each test's spool directory."""
    monkeypatch.setenv('ROCKETRIDE_LIVE_MEDIA_DIR', str(tmp_path))
    yield tmp_path


# ===========================================================================
# The spool
# ===========================================================================


def _reader() -> LiveReader:
    r = LiveReader(CLIENT, PATH)
    r.open()
    return r


@pytest.mark.asyncio
async def test_read_waits_for_the_producer_instead_of_reporting_eof():
    """The core of the design: offset == available is 'not yet', not 'the end'."""
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    w.append(b'first')
    r = _reader()

    async def produce_later():
        await asyncio.sleep(0.1)
        w.append(b'second')

    try:
        assert await r.read(0, 99) == b'first'
        task = asyncio.create_task(produce_later())
        # Would be b'' (EOF) under the old semantics; must block until 'second' lands.
        assert await r.read(5, 99, timeout=5) == b'second'
        await task
    finally:
        r.close()
        w.discard()


@pytest.mark.asyncio
async def test_eof_only_after_finish():
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    w.append(b'abc')
    r = _reader()
    try:
        assert await r.read(0, 99) == b'abc'
        assert not r.complete()
        w.finish()
        assert r.complete()
        assert await r.read(3, 99) == b''
    finally:
        r.close()
        w.discard()


@pytest.mark.asyncio
async def test_read_times_out_on_a_stalled_producer():
    """A node that hangs must not hang the connection with it."""
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    w.append(b'abc')
    r = _reader()
    try:
        with pytest.raises(TimeoutError, match='stalled at offset 3'):
            await r.read(3, 99, timeout=0.1)
    finally:
        r.close()
        w.discard()


@pytest.mark.asyncio
async def test_final_chunk_is_never_missed_when_finish_races_the_reader():
    """finish() writes bytes then the sidecar; read() checks size then the sidecar."""
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    r = _reader()
    try:
        w.append(b'tail')
        w.finish()
        # complete() is already true — the read must still return the trailing bytes.
        assert r.complete()
        assert await r.read(0, 99) == b'tail'
        assert await r.read(4, 99) == b''
    finally:
        r.close()
        w.discard()


@pytest.mark.asyncio
async def test_rewind_while_still_producing():
    """The stream is rewindable: a reader may seek back to bytes it already passed."""
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    w.append(b'0123456789')
    r = _reader()
    try:
        assert await r.read(5, 99) == b'56789'
        assert await r.read(0, 3) == b'012'
    finally:
        r.close()
        w.discard()


@pytest.mark.skipif(os.name == 'nt', reason='Windows cannot unlink a file held open by a reader')
@pytest.mark.asyncio
async def test_reader_survives_the_spool_being_reclaimed():
    """discard() takes the .done sidecar with it; a reader must still find its end.
    Otherwise it waits at the last byte until the read times out.
    """
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    w.append(b'payload')
    r = _reader()
    try:
        w.finish()
        w.discard()
        assert not live_media.is_live(CLIENT, PATH)

        assert await r.read(0, 99) == b'payload'
        assert r.complete()
        assert await r.read(7, 99, timeout=0.5) == b'', 'end of stream survives the reclaim'
    finally:
        r.close()


def test_begin_discards_a_stale_spool():
    w = LiveWriter(CLIENT, PATH)
    w.begin()
    w.append(b'old')
    w.finish()

    w2 = LiveWriter(CLIENT, PATH)
    w2.begin()
    try:
        part, done = live_media.spool_paths(CLIENT, PATH)
        assert os.path.getsize(part) == 0
        assert not os.path.exists(done), 'a fresh stream must not inherit the old EOF marker'
    finally:
        w2.discard()


# ===========================================================================
# The rrext_media command that serves it
# ===========================================================================


def _make_conn(*, file_store=None, connection_id=7):
    """A MediaCommands with the real subcommand table and mocks for the rest."""
    conn = MediaCommands.__new__(MediaCommands)
    MediaCommands.__init__(conn, connection_id, MagicMock(), MagicMock())
    conn._connection_id = connection_id
    conn._account_info = MagicMock(userId='user-1')
    conn.verify_permission = MagicMock()
    conn.debug_message = MagicMock()
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn._get_file_store = MagicMock(return_value=file_store or MagicMock())
    return conn


def _req(**args):
    return {'arguments': args}


async def _call(conn, **args):
    return await conn.on_rrext_media(_req(**args))


# ---------------------------------------------------------------------------
# Permission gate + dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gates_on_task_data_not_task_store():
    fs = MagicMock()
    fs.open_read = AsyncMock(return_value={'handle': 'h1', 'size': 0})
    conn = _make_conn(file_store=fs)
    await _call(conn, subcommand='media_open', path=PATH)
    conn.verify_permission.assert_called_once_with('task.data')


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'path',
    ['secrets/key.pem', '/secrets/key.pem', 'outputs-evil/x.mp4', 'outputs/../secrets/key.pem', 'outputs\\..\\x'],
)
async def test_open_rejects_paths_outside_outputs(path):
    conn = _make_conn()
    with pytest.raises(PermissionError, match='media path'):
        await _call(conn, subcommand='media_open', path=path)


@pytest.mark.asyncio
async def test_finished_artifact_opens_from_the_store_and_is_complete():
    fs = MagicMock()
    fs.open_read = AsyncMock(return_value={'handle': 'h1', 'size': 1234})
    conn = _make_conn(file_store=fs)

    resp = await _call(conn, subcommand='media_open', path=PATH)

    fs.open_read.assert_awaited_once_with(PATH)  # real FileStore.open_read takes only the path
    assert resp['body'] == {'handle': resp['body']['handle'], 'size': 1234, 'complete': True}
    assert resp['body']['handle'].startswith('store-')


@pytest.mark.asyncio
async def test_finished_read_returns_bytes_in_arguments_and_size_in_body():
    fs = MagicMock()
    fs.open_read = AsyncMock(return_value={'handle': 'h1', 'size': 3})
    fs.read_chunk = AsyncMock(return_value=b'abc')
    conn = _make_conn(file_store=fs)

    handle = (await _call(conn, subcommand='media_open', path=PATH))['body']['handle']
    resp = await _call(conn, subcommand='media_read', handle=handle, offset=0, length=99)

    assert resp['arguments']['data'] == b'abc'
    assert resp['body'] == {'size': 3, 'complete': True}


@pytest.mark.asyncio
async def test_live_artifact_opens_from_the_spool_and_is_incomplete():
    """A producing node's artifact never touches the store, and size is a snapshot."""
    writer = LiveWriter(CLIENT, PATH)
    writer.begin()
    writer.append(b'partial')
    fs = MagicMock()
    fs.open_read = AsyncMock()
    conn = _make_conn(file_store=fs)

    try:
        resp = await _call(conn, subcommand='media_open', path=PATH)
        assert resp['body']['size'] == 7
        assert resp['body']['complete'] is False
        assert resp['body']['handle'].startswith('live-')
        fs.open_read.assert_not_awaited()
    finally:
        await _call(conn, subcommand='media_close', handle=resp['body']['handle'])
        writer.discard()


@pytest.mark.asyncio
async def test_live_read_waits_for_the_producer_rather_than_reporting_eof():
    """The whole point: an empty chunk must never mean 'not yet'."""
    writer = LiveWriter(CLIENT, PATH)
    writer.begin()
    writer.append(b'first')
    conn = _make_conn()

    handle = (await _call(conn, subcommand='media_open', path=PATH))['body']['handle']
    try:
        assert (await _call(conn, subcommand='media_read', handle=handle, offset=0))['arguments']['data'] == b'first'

        async def produce_later():
            await asyncio.sleep(0.1)
            writer.append(b'second')

        task = asyncio.create_task(produce_later())
        resp = await _call(conn, subcommand='media_read', handle=handle, offset=5)
        await task

        assert resp['arguments']['data'] == b'second'
        assert resp['body']['complete'] is False
    finally:
        await _call(conn, subcommand='media_close', handle=handle)
        writer.discard()


@pytest.mark.asyncio
async def test_live_read_returns_eof_only_once_the_node_finishes():
    writer = LiveWriter(CLIENT, PATH)
    writer.begin()
    writer.append(b'abc')
    conn = _make_conn()

    handle = (await _call(conn, subcommand='media_open', path=PATH))['body']['handle']
    try:
        await _call(conn, subcommand='media_read', handle=handle, offset=0)
        writer.finish()
        resp = await _call(conn, subcommand='media_read', handle=handle, offset=3)
        assert resp['arguments']['data'] == b''
        assert resp['body'] == {'size': 0, 'complete': True}
    finally:
        await _call(conn, subcommand='media_close', handle=handle)
        writer.discard()


@pytest.mark.asyncio
async def test_open_refuses_to_exceed_the_handle_budget():
    fs = MagicMock()
    fs.open_read = AsyncMock(return_value={'handle': 'h1', 'size': 1})
    conn = _make_conn(file_store=fs)
    conn._media_store_handles = {f'h{i}': f's{i}' for i in range(64)}

    with pytest.raises(ValueError, match='Too many open media handles'):
        await _call(conn, subcommand='media_open', path=PATH)
