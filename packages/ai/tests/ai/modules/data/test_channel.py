"""
The task's channel to the engine, end to end over a loopback socket (T1a).

The task side is a real ``WebServer`` with the ``data`` module, served on
its own loop thread the way ``node.py`` does it; the engine side is a real
``Task.TaskData`` opened with ``Task._dial``. Requests go from the task
through ``task_channel`` (from another thread, as in production) to a
handler registered on the engine side, and back.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import threading
import time
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.common.dap import TransportWebSocket
from ai.modules.data import channel as channel_module
from ai.modules.data.channel import ChannelError, ChannelUnavailable, TaskChannel, task_channel
from ai.modules.data.data_conn import DataConn
from ai.modules.task import task_channel as registry
from ai.modules.task import task_engine
from ai.modules.task.task_channel import (
    ChannelRefused,
    ChannelReply,
    register_channel_command,
    unregister_channel_command,
)
from ai.modules.task.task_engine import Task
from ai.node import _channel_authenticator

TOKEN = 'run-token'
HASH = hashlib.sha256(TOKEN.encode()).hexdigest()
CHUNK = channel_module.CONST_CHANNEL_CHUNK


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


class TaskSide:
    """A task's web server on a real port, served on its own loop thread."""

    def __init__(self):
        """Build the server; ``start`` binds it."""
        from ai.web import WebServer

        self.closed: list = []
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.server = WebServer(config={'host': '127.0.0.1', 'port': 0}, load_env=False, standardEndpoints=False)
        self.server.add_authenticator(_channel_authenticator(HASH))
        self.server.use('data', {'token_sha256': HASH, 'on_closed': self.closed.append})
        self.port = None
        self.future = None

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def start(self):
        """Serve and wait for a bound listener; bind ``task_channel`` to the loop."""
        self.thread.start()
        self.future = asyncio.run_coroutine_threadsafe(self.server.serve(), self.loop)
        deadline = time.monotonic() + 10
        while not getattr(self.server.server, 'started', False):
            if self.future.done():
                self.future.result()
            assert time.monotonic() < deadline, 'listener never came up'
            time.sleep(0.01)
        self.port = self.server.server.servers[0].sockets[0].getsockname()[1]
        task_channel.bind(self.loop)
        return self

    def stop(self):
        """Stop serving and the loop; unbind ``task_channel``."""
        self.server.stop()
        try:
            self.future.result(timeout=5)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        task_channel.reset()

    def on_loop(self, coro):
        """Run ``coro`` on the task's loop, blocking this thread; for sync tests only."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(10)

    def run(self, coro):
        """Run ``coro`` on the task's loop; awaitable, so the engine's loop keeps turning."""
        return asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, self.loop))

    def http(self, path, bearer=None):
        """GET ``path`` on the task's server; return the status code."""
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}')
        if bearer is not None:
            request.add_header('Authorization', f'Bearer {bearer}')
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as e:
            return e.code


@pytest.fixture
def task_side():
    """The task's server, started and stopped around a test."""
    side = TaskSide().start()
    yield side
    side.stop()


def _engine_task(port):
    """The engine-side ``Task`` with what ``_dial`` and the request path consult."""
    t = Task.__new__(Task)
    t.id = 'task-1'
    t._is_terminating = False
    t._data_lock = asyncio.Lock()
    t._data_client = None
    t._data_token = TOKEN
    t._data_port = port
    t._engine_process = None
    t.debug_message = MagicMock()
    Task._reset_channel_state(t)
    return t


async def _connect(task_side, task=None):
    """Dial the task from the engine side and return ``(task, client)``."""
    task = task or _engine_task(task_side.port)
    client = await Task._dial(task)
    task._data_client = client
    task._data_connected.set()
    return task, client


@pytest.fixture
def commands():
    """Register handlers for a test and forget them after."""
    names = []

    def add(name, handler, phase='run'):
        register_channel_command(name, handler, phase)
        names.append(name)

    yield add
    for name in names:
        unregister_channel_command(name)


async def echo(task, arguments, data):
    """Return the arguments and payload as sent."""
    return ChannelReply(body={'echo': arguments, 'task': task.id}, data=data)


def ask(*args, **kwargs):
    """Call ``task_channel.request_sync`` from a worker thread, as a node would."""
    return asyncio.to_thread(task_channel.request_sync, *args, **kwargs)


# ---------------------------------------------------------------------------
# Round trips
# ---------------------------------------------------------------------------


async def test_round_trip_with_body_and_bytes_both_ways(task_side, commands):
    commands('echo', echo)
    task, client = await _connect(task_side)

    reply = await ask('echo', {'x': 1}, data=b'ping')

    assert reply.body == {'echo': {'x': 1}, 'task': 'task-1'}
    assert reply.data == b'ping'
    await client.disconnect()


async def test_request_before_the_engine_connects_waits_for_it(task_side, commands):
    commands('echo', echo)
    pending = asyncio.ensure_future(ask('echo', {'n': 2}))
    await asyncio.sleep(0.2)
    assert not pending.done()

    task, client = await _connect(task_side)
    reply = await pending
    assert reply.body['echo'] == {'n': 2}
    await client.disconnect()


async def test_request_without_a_connection_times_out(task_side, monkeypatch):
    monkeypatch.setattr(channel_module, 'CONST_CHANNEL_CONNECT_TIMEOUT', 0.1)
    with pytest.raises(ChannelUnavailable, match='has not connected'):
        await ask('echo')


async def test_request_without_a_server_fails_at_once():
    unbound = TaskChannel()
    with pytest.raises(ChannelUnavailable, match='no data channel'):
        await unbound.request('echo')
    with pytest.raises(ChannelUnavailable):
        unbound.request_sync('echo')


def test_request_sync_on_the_servers_own_loop_is_refused(task_side):
    async def on_loop():
        return task_channel.request_sync('echo')

    with pytest.raises(RuntimeError, match='deadlock'):
        task_side.on_loop(on_loop())


async def test_request_data_larger_than_a_chunk_is_refused_locally(task_side):
    with pytest.raises(ValueError, match='one chunk'):
        await task_channel.request('echo', data=b'x' * (CHUNK + 1))


# ---------------------------------------------------------------------------
# The engine's rules
# ---------------------------------------------------------------------------


async def test_unregistered_command_is_refused_without_a_handler(task_side, commands):
    called = []

    async def handler(task, arguments, data):
        called.append(arguments)
        return ChannelReply()

    commands('allowed', handler)
    task, client = await _connect(task_side)

    with pytest.raises(ChannelError, match='not allowed'):
        await ask('on_disconnected')
    assert called == []
    await client.disconnect()


async def test_startup_command_is_refused_once_startup_is_over(task_side, commands):
    commands('node.resolve', echo, 'startup')
    task, client = await _connect(task_side)

    assert (await ask('node.resolve', {'names': []})).body['echo'] == {'names': []}
    Task._on_channel_signal(task, '2', None)
    with pytest.raises(ChannelError, match='closed'):
        await ask('node.resolve', {'names': []})
    # Only a new run reopens it
    Task._on_channel_signal(task, '1', None)
    with pytest.raises(ChannelError, match='closed'):
        await ask('node.resolve', {'names': []})
    await client.disconnect()


async def test_handler_exception_reaches_the_task_without_details(task_side, commands):
    async def handler(task, arguments, data):
        raise ValueError('the secret path')

    commands('boom', handler)
    task, client = await _connect(task_side)

    with pytest.raises(ChannelError) as info:
        await ask('boom')
    assert info.value.message == 'internal error'
    assert 'secret' not in str(info.value)
    await client.disconnect()


async def test_handler_refusal_reaches_the_task_verbatim(task_side, commands):
    async def handler(task, arguments, data):
        raise ChannelRefused('forbidden')

    commands('node.fetch', handler)
    task, client = await _connect(task_side)

    with pytest.raises(ChannelError, match='forbidden'):
        await ask('node.fetch', {'id': 'x'})
    await client.disconnect()


async def test_hung_handler_is_cut_by_the_timeout(task_side, commands, monkeypatch):
    monkeypatch.setattr(registry, 'CONST_CHANNEL_HANDLER_TIMEOUT', 0.1)

    async def handler(task, arguments, data):
        await asyncio.sleep(5)

    commands('slow', handler)
    task, client = await _connect(task_side)

    with pytest.raises(ChannelError, match='timeout'):
        await ask('slow')
    await client.disconnect()


async def test_requests_over_the_in_flight_cap_get_busy(task_side, commands, monkeypatch):
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_MAX_INFLIGHT', 1)
    release = asyncio.Event()

    async def handler(task, arguments, data):
        await release.wait()
        return ChannelReply(body={'ok': True})

    commands('hold', handler)
    task, client = await _connect(task_side)

    first = asyncio.ensure_future(ask('hold'))
    await asyncio.sleep(0.2)
    with pytest.raises(ChannelError, match='busy'):
        await ask('hold')
    release.set()
    assert (await first).body == {'ok': True}
    await client.disconnect()


async def test_requests_after_termination_are_refused(task_side, commands):
    commands('echo', echo)
    task, client = await _connect(task_side)
    task._is_terminating = True

    with pytest.raises(ChannelError, match='closed'):
        await ask('echo')
    await client.disconnect()


async def test_engine_and_task_requests_with_the_same_seq_both_get_answered(task_side, commands):
    """Both sides start their seq at 1; neither response may land on the other's future."""
    engine_reply = {}

    async def handler(task, arguments, data):
        # The task's request (seq 1) is in flight while the engine sends its own seq 1
        engine_reply['response'] = await client.dap_request('rrext_whoami', {})
        return ChannelReply(body={'answered': True})

    commands('nested', handler)
    task, client = await _connect(task_side)

    reply = await ask('nested')

    assert reply.body == {'answered': True}
    assert engine_reply['response']['success'] is True
    assert not client.did_fail(engine_reply['response'])
    await client.disconnect()


# ---------------------------------------------------------------------------
# Chunks
# ---------------------------------------------------------------------------


PAYLOAD = bytes(range(256)) * (2 * CHUNK // 256 + 1234)


def _spy_frames(client):
    """Record the binary size of every frame the engine sends on ``client``."""
    sizes = []
    original = client._transport.send

    async def send(message):
        sizes.append(len((message.get('arguments') or {}).get('data') or b''))
        await original(message)

    client._transport.send = send
    return sizes


@pytest.mark.parametrize('kind', ['bytes', 'path', 'iterator'])
async def test_large_reply_arrives_in_chunks_byte_for_byte(task_side, commands, tmp_path, kind):
    path = tmp_path / 'bundle.bin'
    path.write_bytes(PAYLOAD)

    async def pieces():
        for start in range(0, len(PAYLOAD), 700_001):
            yield PAYLOAD[start : start + 700_001]

    sources = {'bytes': lambda: PAYLOAD, 'path': lambda: str(path), 'iterator': pieces}

    async def handler(task, arguments, data):
        return ChannelReply(body={'kind': kind}, data=sources[kind]())

    commands('big', handler)
    task, client = await _connect(task_side)
    sizes = _spy_frames(client)

    reply = await ask('big')
    assert reply.data == PAYLOAD
    assert reply.body['kind'] == kind
    assert max(sizes) <= CHUNK
    assert len([s for s in sizes if s]) >= 3

    sink = io.BytesIO()
    reply = await ask('big', sink=sink)
    assert reply.data is None
    assert sink.getvalue() == PAYLOAD
    await client.disconnect()


async def test_small_reply_goes_to_the_sink_too(task_side, commands):
    commands('echo', echo)
    task, client = await _connect(task_side)
    sink = io.BytesIO()

    reply = await ask('echo', data=b'tiny', sink=sink)
    assert reply.data is None
    assert sink.getvalue() == b'tiny'
    await client.disconnect()


async def test_reply_too_large_for_memory_needs_a_sink(task_side, commands, monkeypatch):
    monkeypatch.setattr(channel_module, 'CONST_CHANNEL_MAX_INLINE', 10)

    async def handler(task, arguments, data):
        return ChannelReply(data=PAYLOAD)

    commands('big', handler)
    task, client = await _connect(task_side)

    with pytest.raises(ChannelError, match='use sink'):
        await ask('big')
    sink = io.BytesIO()
    await ask('big', sink=sink)
    assert sink.getvalue() == PAYLOAD
    await client.disconnect()


async def test_engine_request_completes_while_a_transfer_is_running(task_side, commands):
    async def trickle():
        for _ in range(6):
            await asyncio.sleep(0.1)
            yield b'z' * (CHUNK // 2)

    async def handler(task, arguments, data):
        return ChannelReply(data=trickle())

    commands('big', handler)
    task, client = await _connect(task_side)

    transfer = asyncio.ensure_future(ask('big', sink=io.BytesIO()))
    await asyncio.sleep(0.15)
    started = time.monotonic()
    response = await client.dap_request('rrext_whoami', {})
    assert response['success'] is True
    assert time.monotonic() - started < 0.3
    assert not transfer.done()
    await transfer
    await client.disconnect()


async def test_unknown_or_foreign_stream_is_refused(task_side, commands):
    async def handler(task, arguments, data):
        return ChannelReply(data=PAYLOAD)

    commands('big', handler)
    task, client = await _connect(task_side)
    conn = task_channel._conn

    async def read(stream):
        return await conn.send_request('channel.read', {'stream': stream}, timeout=5)

    response = await task_side.run(read('nope'))
    assert response['success'] is False
    assert response['message'] == 'unknown stream'

    # A stream opened on one connection is gone with it
    opened = await task_side.run(conn.send_request('big', {}, timeout=5))
    stream = opened['body']['stream']
    await client.disconnect()
    await asyncio.sleep(0.2)
    task, client = await _connect(task_side)
    conn = task_channel._conn
    response = await task_side.run(read(stream))
    assert response['message'] == 'unknown stream'
    await client.disconnect()


# ---------------------------------------------------------------------------
# Closing and the signal
# ---------------------------------------------------------------------------


async def test_closed_connection_is_signalled_by_id_and_pending_requests_fail(task_side, commands):
    release = asyncio.Event()

    async def handler(task, arguments, data):
        await release.wait()
        return ChannelReply()

    commands('hold', handler)
    task, client = await _connect(task_side)

    pending = asyncio.ensure_future(ask('hold'))
    await asyncio.sleep(0.2)
    await client.disconnect()

    with pytest.raises(ChannelUnavailable):
        await pending
    await asyncio.sleep(0.1)
    assert task_side.closed == [client.channel_id]
    release.set()

    # The next connection serves requests again
    task, client = await _connect(task_side)
    commands('echo', echo)
    assert (await ask('echo', {'again': 1})).body['echo'] == {'again': 1}
    await client.disconnect()


async def test_long_handler_in_the_task_does_not_delay_the_signal(task_side, commands):
    """The engine's own request is still running when the socket closes; the signal must not wait for it."""
    task, client = await _connect(task_side)
    conn = task_channel._conn
    release = asyncio.Event()

    async def on_rrext_slow(message):
        await release.wait()
        return conn.build_response(message)

    conn.on_rrext_slow = on_rrext_slow
    engine_request = asyncio.ensure_future(client.dap_request('rrext_slow', {}))
    await asyncio.sleep(0.1)

    client._transport.disconnect()
    await asyncio.sleep(0.3)
    assert task_side.closed == [client.channel_id]
    release.set()
    with pytest.raises(Exception):
        await engine_request


async def test_refused_handshakes_do_not_signal(task_side):
    for headers in ({}, {'Authorization': 'Bearer nope'}):
        with pytest.raises(ConnectionError):
            await TransportWebSocket(f'ws://127.0.0.1:{task_side.port}/task/data', headers=headers).connect()
    task, client = await _connect(task_side)
    with pytest.raises(ConnectionError):
        await _connect(task_side, task)  # busy
    await asyncio.sleep(0.1)
    assert task_side.closed == []
    await client.disconnect()


async def test_a_stopping_server_does_not_signal(task_side):
    task, client = await _connect(task_side)
    task_side.server.server.should_exit = True
    await client.disconnect()
    await asyncio.sleep(0.2)
    assert task_side.closed == []


async def test_new_connection_during_the_old_ones_drain_serves_requests(task_side, commands):
    commands('echo', echo)
    task, client = await _connect(task_side)
    old_conn = task_channel._conn
    release = asyncio.Event()

    async def on_rrext_slow(message):
        await release.wait()
        return old_conn.build_response(message)

    old_conn.on_rrext_slow = on_rrext_slow
    slow = asyncio.ensure_future(client.dap_request('rrext_slow', {}))
    await asyncio.sleep(0.1)
    client._transport.disconnect()
    await asyncio.sleep(0.2)

    task, client = await _connect(task_side)
    assert task_channel._conn is not old_conn
    assert (await ask('echo', {'new': 1})).body['echo'] == {'new': 1}
    release.set()
    await asyncio.sleep(0.2)
    assert task_channel._conn is not None
    with pytest.raises(Exception):
        await slow
    await client.disconnect()


# ---------------------------------------------------------------------------
# HTTP on the task's server
# ---------------------------------------------------------------------------


def test_status_accepts_only_the_channel_token(task_side, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'enginekey')
    assert task_side.http('/status', 'enginekey') == 401
    monkeypatch.delenv('ROCKETRIDE_APIKEY')
    assert task_side.http('/status', 'anything') == 401
    assert task_side.http('/status') == 401
    assert task_side.http('/status', TOKEN) == 200


# ---------------------------------------------------------------------------
# DataConn correlation, in isolation
# ---------------------------------------------------------------------------


def _conn():
    conn = DataConn.__new__(DataConn)
    conn._server = SimpleNamespace(_target=None)
    conn._pending = {}
    conn.debug_message = MagicMock()
    return conn


async def test_dataconn_resolves_a_response_to_its_request():
    conn = _conn()
    future = asyncio.get_running_loop().create_future()
    conn._pending[7] = future
    await conn.on_receive({'type': 'response', 'request_seq': 7, 'success': True})
    assert (await future)['success'] is True
    assert conn._pending == {}


async def test_dataconn_fails_pending_requests():
    conn = _conn()
    future = asyncio.get_running_loop().create_future()
    conn._pending[1] = future
    conn.fail_pending(ConnectionError('gone'))
    with pytest.raises(ConnectionError, match='gone'):
        await future
    assert conn._pending == {}
