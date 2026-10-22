"""
The engine's side of the task channel: when it dials, and when it must not (T1a).

The engine opens a task's ``/task/data`` only on the task's own signal,
and only when it has no client or the signal names the one it has. These
tests drive ``Task._on_channel_signal`` and friends with ``_open_data_channel``
replaced, so no socket is involved; the real dial is covered end to end in
``tests/ai/modules/data/test_channel.py``.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import tenacity

from ai.modules.task import task_engine
from ai.modules.task.task_engine import Task


def _engine(client=None):
    """A ``Task`` with what the channel code consults, ``__init__`` bypassed."""
    t = Task.__new__(Task)
    t.id = 'task-1'
    t._is_terminating = False
    t._data_lock = asyncio.Lock()
    t._data_client = client
    t._data_token = 'tok'
    t._data_port = 20001
    t._engine_process = None
    t._run_kind = 'dev'
    t._task_metrics = None
    t._service_up_notes = []
    t._status = SimpleNamespace(serviceUp=False, state=0, notes=None)
    t.debug_message = MagicMock()
    t.reset_idle_timer = MagicMock()
    t._forward_task_event = AsyncMock()
    t._send_status_update = AsyncMock()
    Task._reset_channel_state(t)
    return t


def _client(channel_id):
    """A connected data client, as the dial rule sees it."""
    client = MagicMock(name=f'client-{channel_id}')
    client.channel_id = channel_id
    client.disconnect = AsyncMock()
    client.cancel_handlers = MagicMock()
    return client


async def _settle():
    """Let tasks created by the signal run."""
    for _ in range(3):
        await asyncio.sleep(0)


class _Timer:
    """A pending ``call_later`` that runs only when the test's clock reaches it."""

    def __init__(self, due, callback, args):
        """Hold the callback until ``due``."""
        self.due, self.callback, self.args, self.cancelled = due, callback, args, False

    def when(self):
        """When it is due, on the test's clock."""
        return self.due

    def cancel(self):
        """Drop it."""
        self.cancelled = True


class _Clock:
    """The engine's clock and timers, moved only by the test: no test waits out a window."""

    def __init__(self, monkeypatch):
        """Replace ``task_engine``'s clock and the running loop's timers."""
        self.now = 0.0
        self.timers = []
        loop = asyncio.get_running_loop()
        monkeypatch.setattr(task_engine, 'time', SimpleNamespace(monotonic=lambda: self.now))
        monkeypatch.setattr(loop, 'time', lambda: self.now)
        monkeypatch.setattr(loop, 'call_later', self._call_later)

    def _call_later(self, delay, callback, *args):
        timer = _Timer(self.now + delay, callback, args)
        self.timers.append(timer)
        return timer

    @property
    def pending(self):
        """The timers not cancelled nor run."""
        return [timer for timer in self.timers if not timer.cancelled]

    def advance(self, seconds):
        """Move the clock and run every timer that falls due."""
        self.now += seconds
        for timer in self.pending:
            if timer.due <= self.now:
                self.timers.remove(timer)
                timer.callback(*timer.args)


# ---------------------------------------------------------------------------
# The dial rule
# ---------------------------------------------------------------------------


async def test_first_signal_dials_when_there_is_no_client():
    t = _engine()
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', None)
    await _settle()
    t._open_data_channel.assert_awaited_once_with(stale=None)
    assert t._channel_signalled is True


async def test_signal_naming_the_current_client_replaces_it():
    client = _client('c1')
    t = _engine(client)
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', 'c1')
    await _settle()
    t._open_data_channel.assert_awaited_once_with(stale=client)


@pytest.mark.parametrize('channel_id', ['other', None])
async def test_signal_not_naming_the_live_client_is_ignored(channel_id):
    t = _engine(_client('c1'))
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', channel_id)
    await _settle()
    t._open_data_channel.assert_not_awaited()


async def test_any_signal_dials_when_there_is_no_client():
    t = _engine()
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', 'ghost')
    await _settle()
    t._open_data_channel.assert_awaited_once_with(stale=None)


async def test_no_dial_while_terminating():
    t = _engine()
    t._is_terminating = True
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', None)
    await _settle()
    t._open_data_channel.assert_not_awaited()


async def test_signals_during_a_dial_coalesce_and_are_rechecked_after_it():
    t = _engine()
    release = asyncio.Event()
    calls = []

    async def open_channel(stale):
        calls.append(stale)
        await release.wait()

    t._open_data_channel = open_channel
    Task._on_channel_signal(t, '1', None)
    await _settle()
    Task._on_channel_signal(t, '1', 'a')
    Task._on_channel_signal(t, '1', 'b')
    assert calls == [None]
    assert t._dial_pending == ('b',)

    release.set()
    await _settle()
    await _settle()
    # Still no client, so the pending signal dials again — once
    assert calls == [None, None]
    assert t._dial_pending is None


async def test_dials_are_rate_limited(monkeypatch):
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_DIAL_LIMIT', 3)
    _Clock(monkeypatch)
    t = _engine()
    t._open_data_channel = AsyncMock()
    for _ in range(4):
        Task._on_channel_signal(t, '1', None)
        await _settle()
    assert t._open_data_channel.await_count == 3
    assert any('WARNING' in str(call) for call in t.debug_message.call_args_list)


async def test_a_dial_that_fails_is_tried_again(monkeypatch):
    clock = _Clock(monkeypatch)
    t = _engine()
    t._open_data_channel = AsyncMock()  # never connects
    Task._on_channel_signal(t, '1', None)
    await _settle()

    clock.advance(task_engine.CONST_CHANNEL_REDIAL_DELAY)
    await _settle()

    assert t._open_data_channel.await_count == 2


async def test_a_dial_held_back_by_the_limit_is_tried_once_the_window_passes(monkeypatch):
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_DIAL_LIMIT', 1)
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_REDIAL_DELAY', 600)  # only the window brings it back
    clock = _Clock(monkeypatch)
    t = _engine()
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', None)
    await _settle()
    Task._on_channel_signal(t, '1', None)
    await _settle()
    assert t._open_data_channel.await_count == 1

    clock.advance(task_engine.CONST_CHANNEL_DIAL_WINDOW + 0.001)
    await _settle()

    assert t._open_data_channel.await_count == 2


async def test_signals_held_back_by_the_limit_leave_one_pending_dial(monkeypatch):
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_DIAL_LIMIT', 1)
    clock = _Clock(monkeypatch)
    t = _engine()
    t._open_data_channel = AsyncMock()
    Task._on_channel_signal(t, '1', None)
    await _settle()
    t._data_client = None  # the dial never connected

    for _ in range(5):
        Task._on_channel_signal(t, '1', None)

    assert len(clock.pending) == 1


def test_a_refused_handshake_is_read_off_the_status_not_the_wording():
    try:
        try:
            raise RuntimeError('server rejected WebSocket connection')
        except RuntimeError as handshake:
            handshake.response = SimpleNamespace(status_code=403)
            raise ConnectionError(str(handshake))
    except ConnectionError as wrapped:
        refused = wrapped

    assert Task._dial_refused(refused)
    assert not Task._dial_refused(ConnectionError('Connection refused'))


# ---------------------------------------------------------------------------
# The phase
# ---------------------------------------------------------------------------


async def test_signal_two_closes_startup_and_one_does_not_reopen_it():
    t = _engine()
    t._open_data_channel = AsyncMock()
    assert t._channel_startup_open is True
    Task._on_channel_signal(t, '2', None)
    assert t._channel_startup_open is False
    Task._on_channel_signal(t, '1', None)
    assert t._channel_startup_open is False


async def test_running_closes_startup_without_the_signal():
    t = _engine()
    await Task.on_event(t, {'event': 'apaevt_status_state', 'body': {'service': True}})
    assert t._channel_startup_open is False


async def test_channel_event_is_consumed_not_forwarded_and_not_activity():
    t = _engine()
    t._open_data_channel = AsyncMock()
    await Task.on_event(t, {'event': 'apaevt_channel', 'body': {'state': '1', 'id': None}})
    await _settle()
    t._open_data_channel.assert_awaited_once()
    t._forward_task_event.assert_not_awaited()
    t.reset_idle_timer.assert_not_called()


def test_a_new_start_resets_the_channel_state():
    t = _engine(_client('c1'))
    Task._on_channel_signal(t, '2', None)
    t._channel_signalled = True
    t._dial_times.extend([1.0, 2.0])
    Task._reset_channel_state(t)
    assert t._channel_startup_open is True
    assert t._channel_signalled is False
    assert not t._dial_times
    assert not t._data_connected.is_set()


# ---------------------------------------------------------------------------
# Opening the connection
# ---------------------------------------------------------------------------


async def test_open_closes_the_stale_client_then_installs_the_new_one():
    stale = _client('old')
    t = _engine(stale)
    t._data_connected.set()
    fresh = _client('new')
    t._dial = AsyncMock(return_value=fresh)

    await Task._open_data_channel(t, stale=stale)

    stale.cancel_handlers.assert_called_once()
    stale.disconnect.assert_awaited_once()
    assert t._data_client is fresh
    assert t._data_connected.is_set()


async def test_open_that_fails_leaves_no_client_and_does_not_raise():
    t = _engine()
    t._dial = AsyncMock(side_effect=ConnectionError('HTTP 403'))
    await Task._open_data_channel(t, stale=None)
    assert t._data_client is None
    assert not t._data_connected.is_set()


async def test_open_does_nothing_while_terminating():
    t = _engine()
    t._is_terminating = True
    t._dial = AsyncMock()
    await Task._open_data_channel(t, stale=None)
    t._dial.assert_not_awaited()


async def test_a_late_disconnect_of_an_old_client_keeps_the_new_one():
    old, new = _client('old'), _client('new')
    t = _engine(new)
    t._data_connected.set()
    Task._on_data_client_gone(t, old)
    assert t._data_client is new
    assert t._data_connected.is_set()
    Task._on_data_client_gone(t, new)
    assert t._data_client is None
    assert not t._data_connected.is_set()


# ---------------------------------------------------------------------------
# Retries on the handshake
# ---------------------------------------------------------------------------


def _failing_dial(monkeypatch, error):
    """Make every connect attempt raise ``error``; return the attempt counter."""
    attempts = []

    class Client:
        def __init__(self, **kwargs):
            attempts.append(kwargs['channel_id'])

        async def connect(self):
            raise ConnectionError(error)

    monkeypatch.setattr(task_engine, 'TransportWebSocket', MagicMock())
    monkeypatch.setattr(Task, 'TaskData', Client)
    return attempts


async def test_a_refused_handshake_is_not_retried(monkeypatch):
    attempts = _failing_dial(monkeypatch, 'server rejected WebSocket connection: HTTP 403')
    with pytest.raises(ConnectionError, match='403'):
        await Task._dial(_engine())
    assert len(attempts) == 1


async def test_connection_refused_is_retried(monkeypatch):
    monkeypatch.setattr(task_engine, 'wait_fixed', lambda seconds: tenacity.wait_none())
    attempts = _failing_dial(monkeypatch, '[Errno 111] Connection refused')
    with pytest.raises(ConnectionError, match='refused'):
        await Task._dial(_engine())
    assert len(attempts) == 10
    assert len(set(attempts)) == 1, 'one channel id per dial'


# ---------------------------------------------------------------------------
# _send_data in the signalled mode
# ---------------------------------------------------------------------------


async def test_send_data_dials_itself_when_the_signalled_dial_never_connected(monkeypatch):
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_DATA_WAIT', 0.05)
    client = _client('c1')
    client.dap_request = AsyncMock(return_value={'success': True})
    client.did_fail = MagicMock(return_value=False)
    t = _engine()
    t._channel_signalled = True
    t._provider = None
    t._dial = AsyncMock(return_value=client)

    response = await Task._send_data(t, {'command': 'x', 'arguments': {}})

    assert response == {'success': True}
    t._dial.assert_awaited_once()
    assert t._data_client is client


async def test_send_data_uses_the_connection_the_signal_opened():
    client = _client('c1')
    client.dap_request = AsyncMock(return_value={'success': True})
    client.did_fail = MagicMock(return_value=False)
    t = _engine(client)
    t._channel_signalled = True
    t._data_connected.set()
    t._provider = None
    t._dial = AsyncMock()

    response = await Task._send_data(t, {'command': 'x', 'arguments': {}})
    assert response == {'success': True}
    t._dial.assert_not_awaited()


async def test_send_data_waiting_during_a_reconnect_gets_the_new_client():
    t = _engine()
    t._channel_signalled = True
    t._provider = None
    client = _client('c1')
    client.dap_request = AsyncMock(return_value={'success': True})
    client.did_fail = MagicMock(return_value=False)

    async def connect_later():
        await _settle()  # _send_data is waiting by now
        async with t._data_lock:
            t._data_client = client
            t._data_connected.set()

    asyncio.ensure_future(connect_later())
    response = await Task._send_data(t, {'command': 'x', 'arguments': {}})
    assert response == {'success': True}


# ---------------------------------------------------------------------------
# TaskData: requests from the task
# ---------------------------------------------------------------------------


def _task_data(parent):
    client = Task.TaskData(parent_task=parent, channel_id='c1', module='DATA', transport=MagicMock())
    client._transport.send = AsyncMock()
    return client


async def test_task_requests_run_as_tracked_tasks(monkeypatch):
    parent = _engine()
    parent._on_channel_request = AsyncMock()
    client = _task_data(parent)
    await client.on_receive({'type': 'request', 'seq': 1, 'command': 'node.resolve'})
    assert len(client._handlers) == 1
    await _settle()
    parent._on_channel_request.assert_awaited_once()
    assert not client._handlers


async def test_requests_over_the_cap_are_refused_as_busy(monkeypatch):
    monkeypatch.setattr(task_engine, 'CONST_CHANNEL_MAX_INFLIGHT', 1)
    parent = _engine()
    release = asyncio.Event()

    async def handle(client, message):
        await release.wait()

    parent._on_channel_request = handle
    client = _task_data(parent)
    await client.on_receive({'type': 'request', 'seq': 1, 'command': 'a'})
    await client.on_receive({'type': 'request', 'seq': 2, 'command': 'b'})
    sent = client._transport.send.await_args.args[0]
    assert sent['request_seq'] == 2 and sent['success'] is False and sent['message'] == 'busy'
    release.set()


async def test_disconnect_cancels_handlers_and_forgets_the_client():
    parent = _engine()
    started = asyncio.Event()

    async def handle(client, message):
        started.set()
        await asyncio.sleep(10)

    parent._on_channel_request = handle
    client = _task_data(parent)
    parent._data_client = client
    parent._data_connected.set()
    await client.on_receive({'type': 'request', 'seq': 1, 'command': 'a'})
    await started.wait()
    handler = next(iter(client._handlers))

    await client.on_disconnected('gone')
    await _settle()
    assert handler.cancelled()
    assert parent._data_client is None
    assert not parent._data_connected.is_set()
