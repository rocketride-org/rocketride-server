"""
Unit tests for ai.modules.task.task_server.TaskServer.

TaskServer is the central orchestrator. Its ``__init__`` spawns two
background asyncio tasks (``_cleanup_tasks`` and ``_monitor_ttl``) and
binds to a WebServer instance, so real construction touches a lot of
machinery. Tests therefore bypass ``__init__`` via ``__new__`` and seed
just the attributes the method under test consults.

Focus areas:

- ``release_unauthed_slot`` — IP rate-limit slot accounting
- ``_next_connection_id`` — monotonic id generator
- ``assign_port`` / ``release_port`` — managed port pool
- ``get_task_control`` / ``get_task_control_by_public_key`` / ``get_task``
- ``_dapbase_on_connected`` / ``_dapbase_on_disconnected``
- ``broadcast_server_event`` / ``broadcast_task_event`` — error tolerance
- ``store`` property — lazy initialization
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.task_server import TaskServer


def _make_server(*, config=None, web_server=None):
    """
    Build a TaskServer with ``__init__`` bypassed.

    Tests seed the attributes the method under test actually reads. Background
    tasks are not started (no asyncio.create_task call), so there is nothing
    to cancel at teardown.

    Args:
        config: optional config dict the server should expose as ``_config``.
        web_server: optional parent WebServer stand-in (sets ``_server``).

    Returns:
        TaskServer: a test-ready instance.
    """
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._store_instance = None
    ts._config = config if config is not None else {}
    ts._server = web_server or MagicMock()
    ts.debug_message = MagicMock()
    return ts


def _make_control(*, token='tk_1', user_id='user-1', team_id='team-1', public_auth=None, task=None):
    """
    Build a TASK_CONTROL-shaped stand-in carrying the attributes
    TaskServer.get_task_control / get_task / get_task_control_by_public_key
    read.

    Args:
        token: task token (lookup key in ``_task_control``).
        user_id: owner user id (used by cross-tenant checks).
        team_id: owning team id (used by permission resolution).
        public_auth: pk_-style public auth key, if any.
        task: the underlying Task stand-in (defaults to a MagicMock).

    Returns:
        SimpleNamespace: control structure stand-in.
    """
    return SimpleNamespace(
        id='task-name',
        token=token,
        userId=user_id,
        teamId=team_id,
        public_auth=public_auth,
        task=task or MagicMock(),
    )


# ---------------------------------------------------------------------------
# release_unauthed_slot
# ---------------------------------------------------------------------------


def test_release_unauthed_slot_decrements_count():
    """A non-final release reduces the per-IP count by 1."""
    ts = _make_server()
    ts._unauthed_by_ip = {'1.2.3.4': 3}
    ts.release_unauthed_slot('1.2.3.4')
    assert ts._unauthed_by_ip['1.2.3.4'] == 2


def test_release_unauthed_slot_removes_entry_at_one():
    """When the count is 1, the entry is removed entirely (no zero-valued keys)."""
    ts = _make_server()
    ts._unauthed_by_ip = {'1.2.3.4': 1}
    ts.release_unauthed_slot('1.2.3.4')
    assert '1.2.3.4' not in ts._unauthed_by_ip


def test_release_unauthed_slot_handles_missing_ip():
    """Releasing an IP that was never tracked is a no-op (no KeyError)."""
    ts = _make_server()
    ts.release_unauthed_slot('5.6.7.8')  # must not raise
    assert ts._unauthed_by_ip == {}


def test_release_unauthed_slot_ignores_empty_ip():
    """Empty-string IP is a no-op (defensive guard)."""
    ts = _make_server()
    ts._unauthed_by_ip = {'1.2.3.4': 2}
    ts.release_unauthed_slot('')
    assert ts._unauthed_by_ip == {'1.2.3.4': 2}


# ---------------------------------------------------------------------------
# _next_connection_id
# ---------------------------------------------------------------------------


def test_next_connection_id_starts_at_one_and_monotonic():
    """First call returns 1; subsequent calls strictly increase."""
    ts = _make_server()
    assert ts._next_connection_id() == 1
    assert ts._next_connection_id() == 2
    assert ts._next_connection_id() == 3


# ---------------------------------------------------------------------------
# assign_port / release_port
# ---------------------------------------------------------------------------


def test_assign_port_uses_default_base_port():
    """Without a configured base_port, allocation starts at 20000."""
    ts = _make_server()
    assert ts.assign_port() == 20000
    assert ts._allocated_ports == [20000]


def test_assign_port_respects_configured_base_port():
    """`_config['base_port']` overrides the default starting port."""
    ts = _make_server(config={'base_port': 30000})
    assert ts.assign_port() == 30000


def test_assign_port_returns_next_free_in_range():
    """Allocations skip already-taken ports and return the next free one."""
    ts = _make_server()
    ts._allocated_ports = [20000, 20001, 20002]
    assert ts.assign_port() == 20003


def test_release_port_frees_allocated_port():
    """release_port removes the entry from `_allocated_ports`."""
    ts = _make_server()
    ts._allocated_ports = [20000, 20001]
    ts.release_port(20000)
    assert ts._allocated_ports == [20001]


def test_release_port_unknown_is_noop():
    """Releasing a port that was never allocated is a no-op."""
    ts = _make_server()
    ts._allocated_ports = [20000]
    ts.release_port(99999)  # must not raise
    assert ts._allocated_ports == [20000]


def test_assign_port_exhausts_after_10000():
    """When every port in the 10000-wide window is taken, allocation raises."""
    ts = _make_server()
    ts._allocated_ports = list(range(20000, 30000))
    with pytest.raises(RuntimeError, match='No available ports'):
        ts.assign_port()


# ---------------------------------------------------------------------------
# get_task_control / get_task_control_by_public_key / get_task
# ---------------------------------------------------------------------------


def test_get_task_control_returns_registered_control():
    """A valid token returns the matching TASK_CONTROL structure."""
    ts = _make_server()
    control = _make_control(token='tk_1')
    ts._task_control['tk_1'] = control
    assert ts.get_task_control('tk_1') is control


def test_get_task_control_missing_token_raises():
    """An empty token raises ValueError before lookup."""
    ts = _make_server()
    with pytest.raises(ValueError, match='Task token is required'):
        ts.get_task_control('')


def test_get_task_control_unknown_token_raises_runtime():
    """An unknown but non-empty token raises RuntimeError."""
    ts = _make_server()
    with pytest.raises(RuntimeError, match='not running'):
        ts.get_task_control('tk_unknown')


def test_get_task_control_with_require_enforces_permission(monkeypatch):
    """When account_info+require are provided, missing perms raise PermissionError."""
    from ai.modules.task import task_server as ts_mod

    monkeypatch.setattr(ts_mod, 'resolve_team_permissions', lambda info, team: set())

    ts = _make_server()
    ts._task_control['tk_1'] = _make_control()
    account = SimpleNamespace(userId='u', defaultTeam='t')

    with pytest.raises(PermissionError, match="'task.debug' denied"):
        ts.get_task_control('tk_1', account_info=account, require='task.debug')


def test_get_task_control_with_require_passes_when_granted(monkeypatch):
    """A granted permission lets get_task_control return the control unmodified."""
    from ai.modules.task import task_server as ts_mod

    monkeypatch.setattr(ts_mod, 'resolve_team_permissions', lambda info, team: {'task.debug'})

    ts = _make_server()
    control = _make_control()
    ts._task_control['tk_1'] = control
    account = SimpleNamespace(userId='u', defaultTeam='t')

    assert ts.get_task_control('tk_1', account_info=account, require='task.debug') is control


def test_get_task_returns_underlying_task():
    """get_task is a thin wrapper over get_task_control.task."""
    ts = _make_server()
    inner_task = SimpleNamespace(name='my-task')
    ts._task_control['tk_1'] = _make_control(token='tk_1', task=inner_task)
    assert ts.get_task('tk_1') is inner_task


def test_get_task_control_by_public_key_finds_match():
    """The first control whose public_auth equals the argument is returned."""
    ts = _make_server()
    ctrl_a = _make_control(token='tk_a', public_auth='pk_zzz')
    ctrl_b = _make_control(token='tk_b', public_auth='pk_xyz')
    ts._task_control = {'tk_a': ctrl_a, 'tk_b': ctrl_b}
    assert ts.get_task_control_by_public_key('pk_xyz') is ctrl_b


def test_get_task_control_by_public_key_missing_raises():
    """No matching public key raises RuntimeError with a clear message."""
    ts = _make_server()
    ts._task_control['tk_a'] = _make_control(token='tk_a', public_auth='pk_other')
    with pytest.raises(RuntimeError, match='not running'):
        ts.get_task_control_by_public_key('pk_does-not-exist')


# ---------------------------------------------------------------------------
# Connection registry — _dapbase_on_connected / _dapbase_on_disconnected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dapbase_on_connected_registers_connection():
    """_dapbase_on_connected adds the conn to `_connections` keyed by its id."""
    ts = _make_server()
    conn = MagicMock()
    conn.get_connection_id.return_value = 42
    conn._client_ip = '127.0.0.1'

    await TaskServer._dapbase_on_connected(ts, conn)

    assert ts._connections[42] is conn


# ---------------------------------------------------------------------------
# broadcast_server_event / broadcast_task_event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_broadcast_server_event_calls_each_connection():
    """Every connection receives the event payload."""
    ts = _make_server()
    a, b, c = MagicMock(), MagicMock(), MagicMock()
    a.send_server_event = AsyncMock()
    b.send_server_event = AsyncMock()
    c.send_server_event = AsyncMock()
    ts._connections = {1: a, 2: b, 3: c}

    payload = {'event': 'dashboard', 'body': {'action': 'x'}}
    await TaskServer.broadcast_server_event(ts, type='etype', event=payload, user_id='user-1')

    for conn in (a, b, c):
        conn.send_server_event.assert_awaited_once_with('etype', event=payload, user_id='user-1', org_id=None)


@pytest.mark.asyncio
async def test_broadcast_server_event_isolates_failures():
    """A single connection raising must not stop the broadcast to others."""
    ts = _make_server()
    bad = MagicMock()
    bad.send_server_event = AsyncMock(side_effect=RuntimeError('boom'))
    good = MagicMock()
    good.send_server_event = AsyncMock()
    ts._connections = {1: bad, 2: good}

    await TaskServer.broadcast_server_event(ts, type='etype', event={'event': 'x', 'body': None})

    good.send_server_event.assert_awaited_once()
    ts.debug_message.assert_called_once()  # logged the bad connection


@pytest.mark.asyncio
async def test_broadcast_task_event_skips_when_token_unknown():
    """If the token is not in the task registry, the broadcast short-circuits."""
    ts = _make_server()
    conn = MagicMock()
    conn.send_task_event = AsyncMock()
    ts._connections = {1: conn}

    await TaskServer.broadcast_task_event(ts, event_type='etype', token='tk_x', event={'event': 'x'})

    conn.send_task_event.assert_not_called()


@pytest.mark.asyncio
async def test_broadcast_task_event_calls_each_subscriber():
    """All connections receive the event when the task token is registered."""
    ts = _make_server()
    ts._task_control['tk_x'] = _make_control(token='tk_x')

    a, b = MagicMock(), MagicMock()
    a.send_task_event = AsyncMock()
    b.send_task_event = AsyncMock()
    ts._connections = {1: a, 2: b}

    payload = {'event': 'summary', 'body': {}}
    await TaskServer.broadcast_task_event(ts, event_type='etype', token='tk_x', event=payload)

    a.send_task_event.assert_awaited_once_with('etype', token='tk_x', event=payload)
    b.send_task_event.assert_awaited_once_with('etype', token='tk_x', event=payload)


@pytest.mark.asyncio
async def test_broadcast_task_event_silently_skips_permission_errors():
    """PermissionError from a connection is treated as normal (not logged)."""
    ts = _make_server()
    ts._task_control['tk_x'] = _make_control(token='tk_x')

    pk_conn = MagicMock()
    pk_conn.send_task_event = AsyncMock(side_effect=PermissionError('no monitor'))
    other = MagicMock()
    other.send_task_event = AsyncMock()
    ts._connections = {1: pk_conn, 2: other}

    await TaskServer.broadcast_task_event(ts, event_type='etype', token='tk_x', event={'event': 'x'})

    other.send_task_event.assert_awaited_once()
    ts.debug_message.assert_not_called()  # permission errors are normal


@pytest.mark.asyncio
async def test_broadcast_task_event_logs_other_exceptions():
    """Non-permission errors are logged but the broadcast continues."""
    ts = _make_server()
    ts._task_control['tk_x'] = _make_control(token='tk_x')

    bad = MagicMock()
    bad.send_task_event = AsyncMock(side_effect=RuntimeError('boom'))
    good = MagicMock()
    good.send_task_event = AsyncMock()
    ts._connections = {1: bad, 2: good}

    await TaskServer.broadcast_task_event(ts, event_type='etype', token='tk_x', event={'event': 'x'})

    good.send_task_event.assert_awaited_once()
    ts.debug_message.assert_called_once()


# ---------------------------------------------------------------------------
# store property — lazy initialization
# ---------------------------------------------------------------------------


def test_store_property_creates_once_and_caches(monkeypatch):
    """First access creates a Store via Store.create(); subsequent access reuses it."""
    from ai.modules.task import task_server as ts_mod

    fake_store = MagicMock(name='store')
    create_mock = MagicMock(return_value=fake_store)
    monkeypatch.setattr(ts_mod.Store, 'create', create_mock)

    ts = _make_server()
    s1 = ts.store
    s2 = ts.store

    assert s1 is fake_store
    assert s2 is fake_store
    create_mock.assert_called_once()  # cached


# ---------------------------------------------------------------------------
# _cleanup_tasks / _monitor_ttl — one-iteration tests
# ---------------------------------------------------------------------------


class _LoopBreak(BaseException):
    """Sentinel BaseException used to break out of background loops.

    The bodies of ``_cleanup_tasks`` and ``_monitor_ttl`` wrap each
    iteration in ``except Exception`` to keep the server resilient. We need
    to escape the loop without being caught — BaseException subclasses
    (like ``KeyboardInterrupt``) bypass ``except Exception``.
    """


@pytest.mark.asyncio
async def test_cleanup_tasks_removes_completed_expired_task(monkeypatch):
    """
    A completed task whose endTime is older than the grace window is removed.

    The loop normally runs forever; we patch ``asyncio.sleep`` to raise
    ``StopAsyncIteration`` after one cycle so the test terminates.
    """
    from ai.modules.task import task_server as ts_mod

    # End the loop after one iteration.
    async def _stop_after_one(_delay):
        """Sleep stub that raises to break the otherwise-infinite loop."""
        raise _LoopBreak

    monkeypatch.setattr(ts_mod.asyncio, 'sleep', _stop_after_one)
    monkeypatch.setattr(ts_mod.time, 'time', lambda: 10_000.0)
    monkeypatch.setattr(ts_mod, 'CONST_CLEANUP_DELAY_TIME', 60.0)

    ts = _make_server()
    ts.remove_task = AsyncMock()

    task = MagicMock()
    task.is_task_complete = MagicMock(return_value=True)
    # endTime well in the past: 10000 - 200 -> grace window expired
    task.get_status = MagicMock(return_value=SimpleNamespace(endTime=9_000.0))
    ts._task_control['tk_old'] = _make_control(token='tk_old', task=task)

    with pytest.raises(_LoopBreak):
        await TaskServer._cleanup_tasks(ts)

    ts.remove_task.assert_awaited_once_with('tk_old')


@pytest.mark.asyncio
async def test_cleanup_tasks_skips_running_task(monkeypatch):
    """A still-running (incomplete) task is NOT removed by the cleanup loop."""
    from ai.modules.task import task_server as ts_mod

    async def _stop_after_one(_delay):
        """Stop the loop after the first iteration."""
        raise _LoopBreak

    monkeypatch.setattr(ts_mod.asyncio, 'sleep', _stop_after_one)

    ts = _make_server()
    ts.remove_task = AsyncMock()

    task = MagicMock()
    task.is_task_complete = MagicMock(return_value=False)
    ts._task_control['tk_run'] = _make_control(token='tk_run', task=task)

    with pytest.raises(_LoopBreak):
        await TaskServer._cleanup_tasks(ts)

    ts.remove_task.assert_not_awaited()


# ---------------------------------------------------------------------------
# _monitor_ttl — one-iteration test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_monitor_ttl_terminates_idle_task(monkeypatch):
    """A task whose idle_time crosses ``_ttl`` is terminated by the TTL monitor."""
    from ai.modules.task import task_server as ts_mod

    counter = {'n': 0}

    async def _sleep_one_then_stop(_delay):
        """Sleep once, then raise to break the loop on the next iteration."""
        counter['n'] += 1
        if counter['n'] > 1:
            raise _LoopBreak

    monkeypatch.setattr(ts_mod.asyncio, 'sleep', _sleep_one_then_stop)
    monkeypatch.setattr(ts_mod, 'CONST_TTL_CHECK', 60)

    ts = _make_server()
    ts.stop_task = AsyncMock()

    task = MagicMock()
    task.is_task_complete = MagicMock(return_value=False)
    task._ttl = 100
    task._idle_time = 50  # 50 + 60 (check interval) > 100 -> terminate
    ts._task_control['tk_idle'] = _make_control(token='tk_idle', task=task)

    with pytest.raises(_LoopBreak):
        await TaskServer._monitor_ttl(ts)

    ts.stop_task.assert_awaited_once_with('tk_idle')


@pytest.mark.asyncio
async def test_monitor_ttl_skips_task_with_zero_ttl(monkeypatch):
    """A task with ``_ttl == 0`` has no timeout and is never terminated."""
    from ai.modules.task import task_server as ts_mod

    counter = {'n': 0}

    async def _sleep_one_then_stop(_delay):
        """Sleep once, then raise to break the loop."""
        counter['n'] += 1
        if counter['n'] > 1:
            raise _LoopBreak

    monkeypatch.setattr(ts_mod.asyncio, 'sleep', _sleep_one_then_stop)

    ts = _make_server()
    ts.stop_task = AsyncMock()

    task = MagicMock()
    task.is_task_complete = MagicMock(return_value=False)
    task._ttl = 0
    task._idle_time = 999_999
    ts._task_control['tk_immortal'] = _make_control(token='tk_immortal', task=task)

    with pytest.raises(_LoopBreak):
        await TaskServer._monitor_ttl(ts)

    ts.stop_task.assert_not_awaited()


# ---------------------------------------------------------------------------
# remove_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remove_task_calls_stop_and_broadcasts():
    """remove_task pops the control, stops the task, and broadcasts a dashboard event."""
    ts = _make_server()
    ts.broadcast_server_event = AsyncMock()

    task = MagicMock()
    task.stop_task = AsyncMock()
    control = SimpleNamespace(
        id='task-name',
        token='tk_rm',
        userId='u1',
        teamId='t1',
        task=task,
        project_id='proj-1',
        source='src-1',
        apikey='ak_x',
    )
    ts._task_control['tk_rm'] = control

    result = await TaskServer.remove_task(ts, 'tk_rm')

    assert result is control
    assert 'tk_rm' not in ts._task_control
    task.stop_task.assert_awaited_once()
    ts.broadcast_server_event.assert_awaited_once()


# ---------------------------------------------------------------------------
# push_account_update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_push_account_update_skips_other_users(monkeypatch):
    """Connections owned by a different user are not notified."""
    from ai.modules.task import task_server as ts_mod

    fresh_info = MagicMock()
    fresh_info.to_connect_result = MagicMock(return_value={'user_id': 'u1'})
    service = MagicMock()
    service.get_authentication_result = AsyncMock(return_value=fresh_info)
    fake_account = SimpleNamespace(_service=service)
    monkeypatch.setitem(sys.modules, 'ai.account.account', fake_account)
    monkeypatch.setattr(ts_mod, 'account', fake_account, raising=False)

    ts = _make_server()
    other = MagicMock()
    other._account_info = SimpleNamespace(userId='u-other', auth='ak_o')
    other.send_event = AsyncMock()
    other.get_connection_id = MagicMock(return_value=99)
    ts._connections = {99: other}

    await TaskServer.push_account_update(ts, 'u1')
    other.send_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_push_account_update_swallows_send_errors(monkeypatch):
    """If account refresh raises, the loop logs and moves on (no propagation)."""
    from ai.modules.task import task_server as ts_mod

    service = MagicMock()
    service.get_authentication_result = AsyncMock(side_effect=RuntimeError('refresh fail'))
    fake_account = SimpleNamespace(_service=service)
    monkeypatch.setitem(sys.modules, 'ai.account.account', fake_account)
    monkeypatch.setattr(ts_mod, 'account', fake_account, raising=False)

    ts = _make_server()
    target = MagicMock()
    target._account_info = SimpleNamespace(userId='u1', auth='ak_a')
    target.send_event = AsyncMock()
    target.get_connection_id = MagicMock(return_value=1)
    ts._connections = {1: target}

    await TaskServer.push_account_update(ts, 'u1')
    target.send_event.assert_not_awaited()
    ts.debug_message.assert_called()


# ---------------------------------------------------------------------------
# _build_task_account_info — pk_/tk_ permission resolution
# ---------------------------------------------------------------------------


def test_build_task_account_info_populates_organization():
    """The synthesized account for pk_/tk_ auth must carry a populated
    ``organization`` so team permissions resolve. Regression: a plural
    ``organizations=`` value was silently dropped by pydantic, leaving
    ``organization`` None and breaking the chat SSE subscribe with
    'Access denied: no permissions for this task'.
    """
    from ai.account.models import resolve_task_permissions

    ts = _make_server()
    control = SimpleNamespace(userId='user-1', teamId='team-1', orgId='org-1')

    info = ts._build_task_account_info('pk_abc', control, ['task.data'])

    assert info.organization is not None
    # The task's own team is present with the granted permissions, so a pk_
    # subscriber resolves to a non-empty permission list for its own task.
    assert resolve_task_permissions(info, 'team-1') == ['task.data']
