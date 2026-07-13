"""
Unit tests for ai.modules.task.commands.cmd_monitor.MonitorCommands.

Focus areas: ``send_server_event`` wildcard + tenant scoping,
``send_task_event`` permission + cross-tenant + key resolution + merged
preferences, ``_send_updates`` SUMMARY catch-up branches, ``set_monitor``
token/project/wildcard variants, ``on_rrext_monitor`` argument parsing
(string-list, int, str-of-int, legacy listenType).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride import EVENT_TYPE
from ai.account.models import RequestContext
from ai.modules.task.commands.cmd_monitor import MonitorCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(account_info=None, conn_id='conn-1', source='local'):
    """
    Build a RequestContext for command-handler tests.

    Handlers now read caller identity from ``ctx.account_info`` (per-request
    context) rather than the connection-level ``self._account_info``. Build
    the ctx from the SAME account the test sets up on the connection.
    """
    return RequestContext(account_info=account_info, conn_id=conn_id, source=source)


def _make_conn(*, account_info=None, server=None, monitors=None, connection_id=1):
    """Build a MonitorCommands instance with __init__ bypassed."""
    conn = MonitorCommands.__new__(MonitorCommands)
    conn._account_info = account_info
    conn._server = server or MagicMock()
    conn._connection_id = connection_id
    conn._monitors = monitors if monitors is not None else {}
    conn._client_info = {'name': 'test', 'version': '1.0'}
    conn.send_event = AsyncMock()
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()
    conn.verify_permission = MagicMock()
    conn.get_connection_id = MagicMock(return_value=connection_id)
    conn.get_task_token = MagicMock(return_value='tk_default')
    # Outbound event-queue state (normally set in MonitorCommands.__init__,
    # which __new__ bypasses).
    conn._out_q = None
    conn._drain_task = None
    conn._overflow_close_task = None
    return conn


def _account_info(*, user_id='user-1', team_id='team-1'):
    """
    Build an AccountInfo stub with a single org/team membership.

    Args:
        user_id: stable user identifier.
        team_id: the team that the caller has ``task.monitor``/``task.data``/``task.control``
            permissions on. Any control whose ``teamId`` matches this value will be
            visible; controls with a different ``teamId`` are filtered out.
    """
    return SimpleNamespace(
        userId=user_id,
        userToken='token-' + user_id,
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [
                {
                    'id': team_id,
                    'permissions': ['task.monitor', 'task.data', 'task.control'],
                }
            ],
        },
    )


# ---------------------------------------------------------------------------
# send_server_event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_server_event_skipped_without_wildcard_subscription():
    """If '*' is not in the monitors dict, send_server_event is a no-op."""
    conn = _make_conn(monitors={})
    await MonitorCommands.send_server_event(conn, EVENT_TYPE.DASHBOARD, {'event': 'x', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_server_event_skipped_when_bit_not_subscribed():
    """A '*' subscription that does not include the event_type bit is skipped."""
    conn = _make_conn(monitors={'*': EVENT_TYPE.SUMMARY})
    await MonitorCommands.send_server_event(conn, EVENT_TYPE.DASHBOARD, {'event': 'x', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_server_event_dispatches_when_subscribed():
    """Matching '*' subscription + bit causes the event to be dispatched."""
    conn = _make_conn(
        monitors={'*': EVENT_TYPE.DASHBOARD},
        account_info=_account_info(),
    )
    await MonitorCommands.send_server_event(conn, EVENT_TYPE.DASHBOARD, {'event': 'evt', 'body': {'x': 1}})
    conn.send_event.assert_awaited_once_with('evt', body={'x': 1})


@pytest.mark.asyncio
async def test_send_server_event_filters_by_user_id_tenant_scoping():
    """A tenant-scoped event (user_id set) is filtered against the caller's userId."""
    account = SimpleNamespace(userId='user-1', userToken='ak_mine')
    conn = _make_conn(monitors={'*': EVENT_TYPE.DASHBOARD}, account_info=account)
    # Mismatched user_id: should be filtered out.
    await MonitorCommands.send_server_event(
        conn, EVENT_TYPE.DASHBOARD, {'event': 'evt', 'body': {}}, user_id='other-user'
    )
    conn.send_event.assert_not_called()
    # Matching user_id: delivered.
    await MonitorCommands.send_server_event(conn, EVENT_TYPE.DASHBOARD, {'event': 'evt', 'body': {}}, user_id='user-1')
    conn.send_event.assert_awaited_once()


# ---------------------------------------------------------------------------
# send_task_event
# ---------------------------------------------------------------------------


def _control(*, user_id='user-1', project_id='proj-1', source='src-1', task_id='task-1', team_id='team-1'):
    """Build a TASK_CONTROL stub for send_task_event tests."""
    return SimpleNamespace(
        userId=user_id,
        teamId=team_id,
        project_id=project_id,
        source=source,
        id=task_id,
        token='tk_1',
    )


@pytest.mark.asyncio
async def test_send_task_event_skipped_when_caller_lacks_team_access():
    """Task events for a team the caller is not a member of are silently dropped."""
    server = MagicMock()
    # Task belongs to team-other; caller's account only grants access to team-1.
    server.get_task_control_by_token = MagicMock(return_value=_control(team_id='team-other'))
    conn = _make_conn(account_info=_account_info(), server=server, monitors={'*': EVENT_TYPE.SUMMARY})
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, 'tk_1', {'event': 'evt', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_task_event_uses_project_key_subscription():
    """A p.<proj>.<src> subscription receives matching task events."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, 'tk_1', {'event': 'status', 'body': {'x': 1}})
    conn.send_event.assert_awaited_once()
    args, kwargs = conn.send_event.await_args
    assert args[0] == 'status'
    assert kwargs['id'] == 'task-1'


@pytest.mark.asyncio
async def test_send_task_event_merges_global_wildcard_and_project_subscriptions():
    """When both '*' and a project key match, their bitmasks are OR-ed."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={
            '*': EVENT_TYPE.TASK,
            'p.proj-1.src-1': EVENT_TYPE.SUMMARY,
        },
    )
    # SUMMARY only matches the project key — but the merge ensures it fires.
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, 'tk_1', {'event': 'status', 'body': {}})
    conn.send_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_send_task_event_checks_data_permission_for_sse():
    """
    SSE events require ``task.data`` permission, not ``task.monitor``.

    The permission gate moved from ``verify_permission`` to an inline
    ``resolve_task_permissions`` check inside ``send_task_event``: SSE events
    are delivered only when the caller's resolved perms include ``task.data``.
    A caller with ``task.data`` (the default account stub) is delivered; a
    caller granted only ``task.monitor`` is silently dropped.
    """
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())

    # Caller has task.data -> SSE event delivered.
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'*': EVENT_TYPE.SSE},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SSE, 'tk_1', {'event': 'x', 'body': {}})
    conn.send_event.assert_awaited_once()

    # Caller lacking task.data -> SSE event dropped.
    monitor_only = SimpleNamespace(
        userId='user-2',
        userToken='token-user-2',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )
    conn2 = _make_conn(
        account_info=monitor_only,
        server=server,
        monitors={'*': EVENT_TYPE.SSE},
    )
    await MonitorCommands.send_task_event(conn2, EVENT_TYPE.SSE, 'tk_1', {'event': 'x', 'body': {}})
    conn2.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_task_event_pipe_scoped_subscription():
    """A p.<proj>.<src>.<pipe> subscription matches when the event body carries that pipe_id."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.proj-1.src-1.42': EVENT_TYPE.SSE},
    )
    await MonitorCommands.send_task_event(
        conn, EVENT_TYPE.SSE, 'tk_1', {'event': 'sse', 'body': {'pipe_id': 42, 'message': 'hi'}}
    )
    conn.send_event.assert_awaited_once()


# ---------------------------------------------------------------------------
# _send_updates — catch-up SUMMARY / TASK branches
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_updates_summary_with_running_control():
    """Newly-enabled SUMMARY bit emits an apaevt_status_update for the running task."""
    status_dict = {'name': 'task-1', 'state': 3}
    status = MagicMock()
    status.model_dump = MagicMock(return_value=status_dict)
    task = MagicMock()
    task.get_status = MagicMock(return_value=status)
    control = SimpleNamespace(id='task-1', task=task)

    conn = _make_conn()
    await MonitorCommands._send_updates(conn, control, EVENT_TYPE.NONE, EVENT_TYPE.SUMMARY)

    conn.send_event.assert_awaited_once()
    args, kwargs = conn.send_event.await_args
    assert kwargs['event'] == 'apaevt_status_update'
    assert kwargs['id'] == 'task-1'
    assert kwargs['body'] == status_dict


@pytest.mark.asyncio
async def test_send_updates_summary_without_control_sends_empty_state():
    """If the task is not running but project_id/source are known, send an empty state."""
    conn = _make_conn()
    await MonitorCommands._send_updates(
        conn,
        None,
        EVENT_TYPE.NONE,
        EVENT_TYPE.SUMMARY,
        project_id='proj-1',
        source='src-1',
    )
    conn.send_event.assert_awaited_once()
    args, kwargs = conn.send_event.await_args
    assert kwargs['id'] == 'proj-1.src-1'


@pytest.mark.asyncio
async def test_send_updates_no_new_bits_is_noop():
    """If curr equals prev, no events are sent."""
    conn = _make_conn()
    await MonitorCommands._send_updates(conn, None, EVENT_TYPE.SUMMARY, EVENT_TYPE.SUMMARY)
    conn.send_event.assert_not_called()


# ---------------------------------------------------------------------------
# set_monitor
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_monitor_wildcard_token():
    """token='*' registers the global wildcard with the given EVENT_TYPE."""
    server = MagicMock()
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    result = await MonitorCommands.set_monitor(conn, token='*', type=EVENT_TYPE.SUMMARY)
    assert result is None  # no event_id for wildcard
    assert conn._monitors == {'*': EVENT_TYPE.SUMMARY}


@pytest.mark.asyncio
async def test_set_monitor_with_token_resolves_to_project_key():
    """When a token is supplied, the registry key is built from the resolved control."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    event_id = await MonitorCommands.set_monitor(conn, token='tk_1', type=EVENT_TYPE.SUMMARY)
    assert event_id == 'task-1'
    assert 'p.proj-1.src-1' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_unsubscribe_removes_key():
    """Setting EVENT_TYPE.NONE deletes the key from the registry."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.set_monitor(conn, token='tk_1', type=EVENT_TYPE.NONE)
    assert 'p.proj-1.src-1' not in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_rejects_token_and_project_id_together():
    """Specifying BOTH token and project_id raises ValueError."""
    conn = _make_conn(account_info=_account_info())
    with pytest.raises(ValueError, match='either token or project_id/source'):
        await MonitorCommands.set_monitor(conn, token='tk_1', project_id='proj-1', source='src-1')


@pytest.mark.asyncio
async def test_set_monitor_rejects_no_target():
    """Neither token nor project_id/source given raises ValueError."""
    conn = _make_conn(account_info=_account_info())
    with pytest.raises(ValueError, match='either token or project_id/source'):
        await MonitorCommands.set_monitor(conn)


@pytest.mark.asyncio
async def test_set_monitor_with_pipe_id_narrows_key():
    """A pipe_id appends '.<pipe_id>' to the registry key."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    await MonitorCommands.set_monitor(conn, token='tk_1', type=EVENT_TYPE.SUMMARY, pipe_id=42)
    assert 'p.proj-1.src-1.42' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_cross_tenant_token_raises():
    """A token whose team the caller is not a member of raises PermissionError."""
    server = MagicMock()
    # Task belongs to team-other; caller only has team-1.
    server.get_task_control_by_token = MagicMock(return_value=_control(team_id='team-other'))
    conn = _make_conn(account_info=_account_info(user_id='user-1'), server=server)
    with pytest.raises(PermissionError, match='Access denied'):
        await MonitorCommands.set_monitor(conn, token='tk_1', type=EVENT_TYPE.SUMMARY)


# ---------------------------------------------------------------------------
# on_rrext_monitor — argument parsing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_string_list_types():
    """A list of EVENT_TYPE name strings is converted to a bitmask."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    account = _account_info()
    conn = _make_conn(account_info=account, server=server)
    conn.get_task_token = MagicMock(return_value='tk_1')

    request = {'arguments': {'types': ['SUMMARY', 'TASK']}}
    await MonitorCommands.on_rrext_monitor(conn, request, _ctx(account))

    monitor_value = conn._monitors.get('p.proj-1.src-1')
    assert monitor_value is not None
    assert monitor_value & EVENT_TYPE.SUMMARY
    assert monitor_value & EVENT_TYPE.TASK


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_int_types():
    """An int `types` value is used directly as the bitmask."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    account = _account_info()
    conn = _make_conn(account_info=account, server=server)
    conn.get_task_token = MagicMock(return_value='tk_1')

    request = {'arguments': {'types': EVENT_TYPE.SUMMARY.value}}
    await MonitorCommands.on_rrext_monitor(conn, request, _ctx(account))
    assert conn._monitors.get('p.proj-1.src-1') == EVENT_TYPE.SUMMARY


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_unknown_string_in_list_is_ignored():
    """An unknown name in the string list is silently skipped (warning printed)."""
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    account = _account_info()
    conn = _make_conn(account_info=account, server=server)
    conn.get_task_token = MagicMock(return_value='tk_1')

    request = {'arguments': {'types': ['SUMMARY', 'NOPE_NOT_AN_EVENT']}}
    await MonitorCommands.on_rrext_monitor(conn, request, _ctx(account))
    monitor_value = conn._monitors.get('p.proj-1.src-1')
    assert monitor_value & EVENT_TYPE.SUMMARY


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_monitor_commands_init_creates_empty_monitor_registry():
    """The constructor seeds _monitors and the (unstarted) outbound queue state."""
    conn = MonitorCommands.__new__(MonitorCommands)
    MonitorCommands.__init__(conn, connection_id=1, server=None, transport=None)
    assert conn._monitors == {}
    assert conn._out_q is None
    assert conn._drain_task is None
    assert conn._overflow_close_task is None


# ---------------------------------------------------------------------------
# Outbound event queue — enqueue / drain / overflow
# ---------------------------------------------------------------------------


async def _yield_loop(n: int = 10) -> None:
    """Yield the event loop repeatedly so the drain task can process the queue."""
    for _ in range(n):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_enqueue_lazily_starts_drain_and_delivers_in_order():
    """enqueue_task_event starts a drain that calls send_task_event in FIFO order."""
    conn = _make_conn()
    conn.send_task_event = AsyncMock()

    payloads = [{'event': f'e{i}', 'body': {}} for i in range(3)]
    for p in payloads:
        conn.enqueue_task_event(EVENT_TYPE.SUMMARY, 'tk_x', p)

    assert conn._drain_task is not None  # lazily started
    await _yield_loop()

    calls = [c.args for c in conn.send_task_event.await_args_list]
    assert calls == [(EVENT_TYPE.SUMMARY, 'tk_x', p) for p in payloads]
    conn.stop_event_drain()


@pytest.mark.asyncio
async def test_drain_skips_permission_error_without_logging():
    """A PermissionError from send_task_event is a normal skip (not logged)."""
    conn = _make_conn()
    conn.send_task_event = AsyncMock(side_effect=PermissionError('no monitor'))

    conn.enqueue_task_event(EVENT_TYPE.SUMMARY, 'tk_x', {'event': 'e', 'body': {}})
    await _yield_loop()

    conn.debug_message.assert_not_called()
    conn.stop_event_drain()


@pytest.mark.asyncio
async def test_drain_logs_other_exceptions_and_survives():
    """A non-permission error is logged; the drain keeps processing later events."""
    conn = _make_conn()
    conn.send_task_event = AsyncMock(side_effect=[RuntimeError('boom'), None])

    conn.enqueue_task_event(EVENT_TYPE.SUMMARY, 'tk_x', {'event': 'bad', 'body': {}})
    conn.enqueue_task_event(EVENT_TYPE.SUMMARY, 'tk_x', {'event': 'ok', 'body': {}})
    await _yield_loop()

    conn.debug_message.assert_called()  # the RuntimeError was logged
    assert conn.send_task_event.await_count == 2  # drain survived and delivered the next
    conn.stop_event_drain()


@pytest.mark.asyncio
async def test_enqueue_status_overflow_drops_oldest():
    """When the queue is full, an idempotent snapshot drops the oldest, keeps the newest."""
    conn = _make_conn()
    # Block the drain so we can observe overflow on a maxsize-1 queue.
    conn._drain_task = MagicMock()
    conn._out_q = asyncio.Queue(maxsize=1)
    conn._out_q.put_nowait((EVENT_TYPE.SUMMARY, 'tk_x', {'event': 'old', 'body': {}}))

    conn.enqueue_task_event(EVENT_TYPE.SUMMARY, 'tk_x', {'event': 'new', 'body': {}})

    assert conn._out_q.qsize() == 1
    _, _, event = conn._out_q.get_nowait()
    assert event['event'] == 'new'


@pytest.mark.asyncio
async def test_enqueue_sse_overflow_disconnects_slow_consumer():
    """A full SSE queue disconnects the connection instead of silently dropping chunks."""
    conn = _make_conn()
    conn._transport = MagicMock()
    conn._transport.disconnect = AsyncMock()
    conn._drain_task = MagicMock()  # block the drain so the queue stays full
    conn._out_q = asyncio.Queue(maxsize=1)
    conn._out_q.put_nowait((EVENT_TYPE.SSE, 'tk_x', {'event': 'chunk0', 'body': {}}))

    conn.enqueue_task_event(EVENT_TYPE.SSE, 'tk_x', {'event': 'chunk1', 'body': {}})

    assert conn._overflow_close_task is not None  # disconnect scheduled
    await _yield_loop()
    conn._transport.disconnect.assert_awaited_once()
    # The SSE chunk is NOT dropped-and-replaced (queue still holds the original).
    assert conn._out_q.qsize() == 1
