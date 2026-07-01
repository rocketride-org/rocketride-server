"""
Unit tests for ai.modules.task.commands.cmd_monitor.MonitorCommands.

Focus areas: ``send_server_event`` wildcard + tenant scoping,
``send_task_event`` permission + cross-tenant + key resolution + merged
preferences, ``_send_updates`` SUMMARY catch-up branches, ``set_monitor``
token/project/wildcard variants, ``on_rrext_monitor`` argument parsing
(string-list, int, str-of-int, legacy listenType).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride import EVENT_TYPE
from ai.modules.task.commands.cmd_monitor import MonitorCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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
    server.get_task_control = MagicMock(return_value=_control(team_id='team-other'))
    conn = _make_conn(account_info=_account_info(), server=server, monitors={'*': EVENT_TYPE.SUMMARY})
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, 'tk_1', {'event': 'evt', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_task_event_uses_project_key_subscription():
    """A p.<proj>.<src> subscription receives matching task events."""
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_control())
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
    server.get_task_control = MagicMock(return_value=_control())
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
    """SSE events require task.data permission, not task.monitor."""
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'*': EVENT_TYPE.SSE},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SSE, 'tk_1', {'event': 'x', 'body': {}})
    conn.verify_permission.assert_called_with('task.data')


@pytest.mark.asyncio
async def test_send_task_event_pipe_scoped_subscription():
    """A p.<proj>.<src>.<pipe> subscription matches when the event body carries that pipe_id."""
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_control())
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
    server.get_task_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    event_id = await MonitorCommands.set_monitor(conn, token='tk_1', type=EVENT_TYPE.SUMMARY)
    assert event_id == 'task-1'
    assert 'p.proj-1.src-1' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_unsubscribe_removes_key():
    """Setting EVENT_TYPE.NONE deletes the key from the registry."""
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_control())
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
    server.get_task_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    await MonitorCommands.set_monitor(conn, token='tk_1', type=EVENT_TYPE.SUMMARY, pipe_id=42)
    assert 'p.proj-1.src-1.42' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_cross_tenant_token_raises():
    """A token whose team the caller is not a member of raises PermissionError."""
    server = MagicMock()
    # Task belongs to team-other; caller only has team-1.
    server.get_task_control = MagicMock(return_value=_control(team_id='team-other'))
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
    server.get_task_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_token = MagicMock(return_value='tk_1')

    request = {'arguments': {'types': ['SUMMARY', 'TASK']}}
    await MonitorCommands.on_rrext_monitor(conn, request)

    monitor_value = conn._monitors.get('p.proj-1.src-1')
    assert monitor_value is not None
    assert monitor_value & EVENT_TYPE.SUMMARY
    assert monitor_value & EVENT_TYPE.TASK


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_int_types():
    """An int `types` value is used directly as the bitmask."""
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_token = MagicMock(return_value='tk_1')

    request = {'arguments': {'types': EVENT_TYPE.SUMMARY.value}}
    await MonitorCommands.on_rrext_monitor(conn, request)
    assert conn._monitors.get('p.proj-1.src-1') == EVENT_TYPE.SUMMARY


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_unknown_string_in_list_is_ignored():
    """An unknown name in the string list is silently skipped (warning printed)."""
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_token = MagicMock(return_value='tk_1')

    request = {'arguments': {'types': ['SUMMARY', 'NOPE_NOT_AN_EVENT']}}
    await MonitorCommands.on_rrext_monitor(conn, request)
    monitor_value = conn._monitors.get('p.proj-1.src-1')
    assert monitor_value & EVENT_TYPE.SUMMARY


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_monitor_commands_init_creates_empty_monitor_registry():
    """The constructor seeds _monitors as an empty dict."""
    conn = MonitorCommands.__new__(MonitorCommands)
    MonitorCommands.__init__(conn, connection_id=1, server=None, transport=None)
    assert conn._monitors == {}
