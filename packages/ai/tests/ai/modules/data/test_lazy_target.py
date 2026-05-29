"""
Unit tests for the lazy-target contract in ai.modules.data.

After the shared-subprocess-web-server refactor (see plan), the `data`
module is eager-loaded by `node.py` before any source node has run.
That means `server.app.state.target` may be absent or `None` at module
init time and only become non-None later, when a source node (webhook
or telegram) executes its `_run()`.

This file pins down that contract:

- ``initModule`` must not crash when ``state.target`` is missing or
  ``None``.
- ``DataServer`` must expose ``_target`` lazily — reading the current
  ``state.target`` at access time, not capturing a snapshot at __init__.
- ``DataConn.__init__`` must tolerate ``target=None`` without
  dereferencing it (the bare ``AttributeError`` on ``None.taskConfig``
  is replaced with a safe default).
- ``DataConn._require_target()`` returns the target when set, and
  raises a controlled ``RuntimeError`` when not — *not* a bare
  ``AttributeError`` from ``None.putPipe()``.

These tests are characterization tests: they describe the NEW
contract introduced by the shared-webserver PR. Before the production
patch lands they fail; after it lands they pass.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_server_mock(target=None, *, omit_target_attr=False):
    """Build a WebServer-shaped mock with a controllable ``app.state.target``.

    Args:
        target: The value to assign to ``app.state.target``. Ignored when
            ``omit_target_attr`` is True.
        omit_target_attr: When True, ``app.state`` has no ``target``
            attribute at all (simulates the very-early-init case where
            no source has touched state).

    Returns:
        A SimpleNamespace standing in for WebServer with the attributes
        the data module touches at init / listen time.
    """
    state = SimpleNamespace()
    if not omit_target_attr:
        state.target = target

    app = SimpleNamespace(state=state)
    server = SimpleNamespace(
        app=app,
        add_socket=MagicMock(),
    )
    return server


def _make_data_conn_uninitialized():
    """Build a DataConn with __init__ bypassed, ready for attribute injection.

    `DataConn._target` is a lazy `@property` delegating to `self._server._target`,
    so callers configure target state via `conn._server._target = ...` rather
    than `conn._target = ...` (the latter raises AttributeError — property has
    no setter). Initial `_target` is None so tests get a clean baseline.

    Mirrors the helper pattern in test_data_conn.py.
    """
    from ai.modules.data.data_conn import DataConn

    conn = DataConn.__new__(DataConn)
    conn.debug_message = MagicMock()
    conn._server = MagicMock()
    conn._server._target = None
    return conn


# ---------------------------------------------------------------------------
# initModule — must not eagerly read state.target
# ---------------------------------------------------------------------------


def test_initModule_succeeds_when_state_target_attribute_absent():
    """Ensure ``initModule`` does not raise when ``app.state`` has no ``target`` attribute."""
    from ai.modules.data import initModule

    server = _make_server_mock(omit_target_attr=True)

    # Should not raise AttributeError, RuntimeError, or anything else.
    initModule(server, {})

    # And it should still register the /task/data socket.
    server.add_socket.assert_called_once()
    called_path = server.add_socket.call_args.args[0]
    assert called_path == '/task/data'


def test_initModule_succeeds_when_state_target_is_None():
    """Ensure ``initModule`` does not raise when ``app.state.target`` is explicitly None."""
    from ai.modules.data import initModule

    server = _make_server_mock(target=None)

    initModule(server, {})

    server.add_socket.assert_called_once()
    assert server.add_socket.call_args.args[0] == '/task/data'


def test_initModule_succeeds_when_state_target_is_set():
    """Verify ``initModule`` still works when a target happens to already be present."""
    from ai.modules.data import initModule

    target = MagicMock()
    target.taskConfig = {'threadCount': 8}
    server = _make_server_mock(target=target)

    initModule(server, {})

    server.add_socket.assert_called_once()
    assert server.add_socket.call_args.args[0] == '/task/data'


# ---------------------------------------------------------------------------
# DataServer._target — must read state.target lazily, not capture at init
# ---------------------------------------------------------------------------


def test_dataserver_target_is_None_when_state_target_absent():
    """DataServer._target returns None when state has no target attribute."""
    from ai.modules.data.data_server import DataServer

    server = _make_server_mock(omit_target_attr=True)
    ds = DataServer(server=server)

    assert ds._target is None


def test_dataserver_target_is_None_when_state_target_is_None():
    """DataServer._target returns None when state.target is explicitly None."""
    from ai.modules.data.data_server import DataServer

    server = _make_server_mock(target=None)
    ds = DataServer(server=server)

    assert ds._target is None


def test_dataserver_target_reflects_state_when_set_at_init_time():
    """DataServer._target returns whatever state.target was at construction."""
    from ai.modules.data.data_server import DataServer

    target = MagicMock(name='initial-target')
    server = _make_server_mock(target=target)
    ds = DataServer(server=server)

    assert ds._target is target


def test_dataserver_target_picks_up_later_state_writes():
    """DataServer._target reads lazily — picks up state.target set AFTER init.

    This is the key new behavior: node.py constructs the DataServer with
    state.target=None, then a source node (webhook/telegram) writes
    state.target later, and DataServer must see the new value without
    needing an explicit setter call.
    """
    from ai.modules.data.data_server import DataServer

    server = _make_server_mock(target=None)
    ds = DataServer(server=server)
    assert ds._target is None  # baseline

    # Simulate a source node assigning state.target later.
    late_target = MagicMock(name='late-target')
    server.app.state.target = late_target

    # DataServer's view of the target must update.
    assert ds._target is late_target


def test_dataserver_target_reflects_subsequent_overwrites():
    """If state.target is rewritten, DataServer sees the new value.

    Not a use case the codebase exercises today (one source per
    subprocess), but the lazy-read property should behave predictably.
    """
    from ai.modules.data.data_server import DataServer

    first = MagicMock(name='first')
    server = _make_server_mock(target=first)
    ds = DataServer(server=server)
    assert ds._target is first

    second = MagicMock(name='second')
    server.app.state.target = second
    assert ds._target is second


async def test_dataconn_target_picks_up_state_writes_after_construction():
    """DataConn._target is lazy too — reflects state.target writes AFTER __init__.

    This pins the fix for the Ubuntu CI race: previously DataConn captured
    target as a snapshot at WebSocket-connect time, locking in None whenever
    the connection opened before the source node bound state.target. Now
    DataConn._target delegates through DataServer._target to state.target,
    so a late source-node bind is visible to every subsequent data
    operation on that connection.

    Async because DataConn.__init__ schedules an asyncio task internally
    (the zombie-pipe monitor).
    """
    from ai.modules.data.data_conn import DataConn
    from ai.modules.data.data_server import DataServer

    transport_mock = MagicMock()

    # Construct with state.target=None — the broken race condition.
    server = _make_server_mock(target=None)
    ds = DataServer(server=server)
    conn = DataConn(server=ds, transport=transport_mock)
    try:
        assert conn._target is None  # baseline at construction

        # Source node binds state.target AFTER the WebSocket has already connected.
        late_target = MagicMock(name='source-bound-late')
        server.app.state.target = late_target

        # Without the lazy property this assertion would fail — the snapshot
        # would still report None for the connection's lifetime.
        assert conn._target is late_target
    finally:
        # `DataConn.__init__` schedules `_monitor_task` via asyncio.create_task;
        # `disconnect()` signals shutdown and awaits the task, preventing the
        # pending-task warnings + flaky teardown CodeRabbit flagged.
        await conn.disconnect()


def test_dataconn_target_setter_via_server_state_is_visible():
    """Direct sanity: setting server._target propagates to conn._target.

    Used by other tests in this file (via the `_make_data_conn_uninitialized`
    helper that swaps `conn._server._target`) — pin it explicitly.
    """
    conn = _make_data_conn_uninitialized()
    assert conn._target is None

    bound = MagicMock(name='bound-target')
    conn._server._target = bound
    assert conn._target is bound


# ---------------------------------------------------------------------------
# DataConn.__init__ — tolerate target=None
# ---------------------------------------------------------------------------


async def test_dataconn_init_with_server_target_None_does_not_AttributeError():
    """DataConn(server with `_target=None`, ...) must not raise on init.

    Before the lazy-target refactor, line ``self._thread_count =
    target.taskConfig.get(...)`` raised ``AttributeError: 'NoneType' object
    has no attribute 'taskConfig'``. After the fix, a `None` target from
    ``server._target`` falls back to a sensible default and `conn._target`
    (a property delegating to ``server._target``) is `None`.

    Async because DataConn.__init__ schedules an asyncio task internally.
    """
    from ai.modules.data.data_conn import DataConn

    server_mock = MagicMock()
    server_mock._target = None
    transport_mock = MagicMock()

    # Should not raise.
    conn = DataConn(server=server_mock, transport=transport_mock)
    try:
        # Sanity check: object constructed, lazy `_target` resolves to None.
        assert conn._target is None
    finally:
        await conn.disconnect()


async def test_dataconn_ensure_pipe_sem_defaults_thread_count_when_target_None(monkeypatch):
    """When `_ensure_pipe_sem` runs with no target bound, _thread_count falls back to 4."""
    from ai.modules.data import data_conn as data_conn_mod
    from ai.modules.data.data_conn import DataConn

    # Dial down the wait so the test doesn't block 5s on the missing target.
    monkeypatch.setattr(data_conn_mod, 'CONST_DATA_OPEN_TARGET_WAIT', 0.05)

    server_mock = MagicMock()
    server_mock._target = None
    transport_mock = MagicMock()
    conn = DataConn(server=server_mock, transport=transport_mock)
    try:
        # Deferred: not set at __init__ — only after _ensure_pipe_sem.
        assert conn._thread_count is None
        await conn._ensure_pipe_sem()
        assert conn._thread_count == 4
    finally:
        await conn.disconnect()


async def test_dataconn_ensure_pipe_sem_reads_taskConfig_threadCount():
    """When `_ensure_pipe_sem` runs with target bound, _thread_count comes from target.taskConfig."""
    from ai.modules.data.data_conn import DataConn

    target = MagicMock()
    target.taskConfig = {'threadCount': 16}
    server_mock = MagicMock()
    server_mock._target = target
    transport_mock = MagicMock()

    conn = DataConn(server=server_mock, transport=transport_mock)
    try:
        await conn._ensure_pipe_sem()
        assert conn._thread_count == 16
    finally:
        await conn.disconnect()


async def test_dataconn_ensure_pipe_sem_defaults_when_threadCount_missing():
    """When target exists but lacks a 'threadCount' entry, default to 4."""
    from ai.modules.data.data_conn import DataConn

    target = MagicMock()
    target.taskConfig = {}  # no 'threadCount' key
    server_mock = MagicMock()
    server_mock._target = target
    transport_mock = MagicMock()

    conn = DataConn(server=server_mock, transport=transport_mock)
    try:
        await conn._ensure_pipe_sem()
        assert conn._thread_count == 4
    finally:
        await conn.disconnect()


async def test_dataconn_ensure_pipe_sem_waits_for_late_target_bind():
    """_ensure_pipe_sem polls for `state.target` to appear within the wait window.

    Pins the race fix: webhook/telegram source nodes bind state.target from
    their _run() AFTER the data module is already serving /task/data on the
    shared subprocess server. EaaS's first data/open can arrive in that
    narrow window. `_ensure_pipe_sem` waits up to CONST_DATA_OPEN_TARGET_WAIT
    seconds and uses the late-bound target's threadCount once it appears.
    """
    from ai.modules.data.data_conn import DataConn

    server_mock = MagicMock()
    server_mock._target = None
    transport_mock = MagicMock()
    conn = DataConn(server=server_mock, transport=transport_mock)
    try:
        # Simulate source node binding target after a short async delay.
        target = MagicMock()
        target.taskConfig = {'threadCount': 8}

        async def _late_bind():
            await asyncio.sleep(0.1)
            server_mock._target = target

        asyncio.create_task(_late_bind())

        # _ensure_pipe_sem should poll, see the late bind, and use threadCount=8.
        await conn._ensure_pipe_sem()
        assert conn._thread_count == 8
    finally:
        await conn.disconnect()


# ---------------------------------------------------------------------------
# DataConn._require_target — controlled error when no target is set
# ---------------------------------------------------------------------------


def test_require_target_returns_target_when_set():
    """_require_target returns the stored target when it's not None."""
    conn = _make_data_conn_uninitialized()
    target = MagicMock(name='source-target')
    conn._server._target = target

    assert conn._require_target() is target


def test_require_target_raises_RuntimeError_when_target_is_None():
    """_require_target raises a controlled RuntimeError, not AttributeError, on None."""
    conn = _make_data_conn_uninitialized()
    conn._server._target = None

    with pytest.raises(RuntimeError) as exc_info:
        conn._require_target()

    # Message should be informative, mentioning that no source is registered.
    msg = str(exc_info.value)
    assert 'target' in msg.lower()
    assert 'source' in msg.lower()


def test_require_target_called_by_cleanup_pipe(monkeypatch):
    """_cleanup_pipe routes through _require_target so a None target raises cleanly."""
    from ai.modules.data import data_conn as data_conn_mod

    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: None)
    monkeypatch.setattr(data_conn_mod, 'monitorFailed', lambda s: None)

    conn = _make_data_conn_uninitialized()
    conn._server._target = None
    pipe_conn = SimpleNamespace(
        pipe=MagicMock(),
        pipe_id='p-x',
        size=None,
        written=0,
        has_failed=False,
        entry=None,
    )

    # _cleanup_pipe catches and logs exceptions (see existing
    # test_cleanup_pipe_swallows_target_errors), so we look for the
    # logged debug_message rather than expecting a raised exception.
    conn._cleanup_pipe(pipe_conn)
    conn.debug_message.assert_called()
    # The logged message should reference the underlying error (no source target).
    logged_args = [call.args for call in conn.debug_message.call_args_list]
    assert any('target' in str(args).lower() or 'source' in str(args).lower() for args in logged_args)
