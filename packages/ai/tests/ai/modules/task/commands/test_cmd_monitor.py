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

from rocketride import EVENT_TYPE, TASK_STATE
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
    conn.get_task_address = MagicMock(return_value='')
    return conn


# The one control every helper describes: the address clients send in the
# token slot, and the registry key the engine reports events under.
ADDRESS = 'acme.proj-1.src-1'
KEY = 'dev.user-1.acme.proj-1.src-1'


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


def _control(
    *,
    user_id='user-1',
    project_id='proj-1',
    source='src-1',
    task_id='task-1',
    team_id='team-1',
    run_kind='dev',
    owner_kind='',
):
    """Build a TaskControl stub for send_task_event tests.

    Mirrors TaskControl's owner model: the owner of a dev run (and of a
    user-owned @me deploy) is its user, the owner of a team deploy is its
    team — monitor keys scope by owner.
    """
    kind = owner_kind or ('team' if run_kind == 'deploy' else 'user')
    return SimpleNamespace(
        userId=user_id,
        teamId=team_id,
        project_id=project_id,
        source=source,
        id=task_id,
        address=ADDRESS,
        key=KEY,
        run_kind=run_kind,
        owner_kind=kind,
        owner_id=team_id if kind == 'team' else user_id,
    )


@pytest.mark.asyncio
async def test_send_task_event_skipped_when_caller_lacks_team_access():
    """Deploy events for a team the caller is not a member of are silently dropped."""
    server = MagicMock()
    # Team-owned deploy run of team-other; caller's account only grants team-1.
    server.control_by_key = MagicMock(return_value=_control(team_id='team-other', run_kind='deploy'))
    conn = _make_conn(account_info=_account_info(), server=server, monitors={'*': EVENT_TYPE.SUMMARY})
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'evt', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_task_event_skipped_for_a_teammates_private_run():
    """A user-owned run (dev or @me deploy) delivers ONLY to its owner: a
    teammate on the very same billing team never receives its events.
    """
    server = MagicMock()
    # user-2's @me deploy, billed to the CALLER's own team — still private.
    server.control_by_key = MagicMock(
        return_value=_control(user_id='user-2', team_id='team-1', run_kind='deploy', owner_kind='user')
    )
    conn = _make_conn(account_info=_account_info(user_id='user-1'), server=server, monitors={'*': EVENT_TYPE.SUMMARY})
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'evt', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_task_event_uses_project_key_subscription():
    """A p.<proj>.<src> subscription receives matching task events."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.dev.user-1.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'status', 'body': {'x': 1}})
    conn.send_event.assert_awaited_once()
    args, kwargs = conn.send_event.await_args
    assert args[0] == 'status'
    assert kwargs['id'] == 'task-1'


@pytest.mark.asyncio
async def test_send_task_event_merges_global_wildcard_and_project_subscriptions():
    """When both '*' and a project key match, their bitmasks are OR-ed."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={
            '*': EVENT_TYPE.TASK,
            'p.dev.user-1.proj-1.src-1': EVENT_TYPE.SUMMARY,
        },
    )
    # SUMMARY only matches the project key — but the merge ensures it fires.
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'status', 'body': {}})
    conn.send_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_send_task_event_checks_data_permission_for_sse():
    """SSE events require task.data permission, not task.monitor."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'*': EVENT_TYPE.SSE},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SSE, KEY, {'event': 'x', 'body': {}})
    conn.verify_permission.assert_called_with('task.data')


@pytest.mark.asyncio
async def test_send_task_event_pipe_scoped_subscription():
    """A p.<proj>.<src>.<pipe> subscription matches when the event body carries that pipe_id."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control())
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.dev.user-1.proj-1.src-1.42': EVENT_TYPE.SSE},
    )
    await MonitorCommands.send_task_event(
        conn, EVENT_TYPE.SSE, KEY, {'event': 'sse', 'body': {'pipe_id': 42, 'message': 'hi'}}
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


def _deny_monitor(perm):
    """Stand in for verify_permission on a credential that lacks task.monitor."""
    if perm == 'task.monitor':
        raise PermissionError(f'Permission {perm!r} denied')


def _running_control():
    """Build the caller's own running dev run, registered on a server stub."""
    control = _control()
    control.task = MagicMock()
    control.task.get_status = MagicMock(return_value=SimpleNamespace(state=TASK_STATE.RUNNING.value, name='My run'))
    server = MagicMock()
    server._task_control = {'dev.user-1.acme.proj-1.src-1': control}
    return control, server


@pytest.mark.asyncio
async def test_send_updates_summary_withheld_without_monitor_permission():
    """Without task.monitor, a newly-enabled SUMMARY bit sends no snapshot of the running task."""
    control, server = _running_control()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.verify_permission = MagicMock(side_effect=_deny_monitor)

    # project_id/source are given too: a running task must not fall through
    # to the "not running" state either.
    await MonitorCommands._send_updates(
        conn, control, EVENT_TYPE.NONE, EVENT_TYPE.SUMMARY, project_id='proj-1', source='src-1'
    )

    conn.verify_permission.assert_called_with('task.monitor')
    control.task.get_status.assert_not_called()
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_updates_task_list_withheld_without_monitor_permission():
    """Without task.monitor, a newly-enabled TASK bit sends no active-task list."""
    control, server = _running_control()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.verify_permission = MagicMock(side_effect=_deny_monitor)

    await MonitorCommands._send_updates(conn, control, EVENT_TYPE.NONE, EVENT_TYPE.TASK)

    conn.verify_permission.assert_called_with('task.monitor')
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_updates_task_list_sent_with_monitor_permission():
    """With task.monitor, a newly-enabled TASK bit lists the caller's active runs."""
    control, server = _running_control()
    conn = _make_conn(account_info=_account_info(), server=server)

    await MonitorCommands._send_updates(conn, control, EVENT_TYPE.NONE, EVENT_TYPE.TASK)

    conn.send_event.assert_awaited_once()
    _, kwargs = conn.send_event.await_args
    assert kwargs['event'] == 'apaevt_task'
    assert kwargs['body']['action'] == 'running'
    assert [task['id'] for task in kwargs['body']['tasks']] == ['task-1']


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
    """When an address is supplied, the registry key is built from the resolved control."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    event_id = await MonitorCommands.set_monitor(conn, token=ADDRESS, type=EVENT_TYPE.SUMMARY)
    assert event_id == 'task-1'
    assert 'p.dev.user-1.proj-1.src-1' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_unsubscribe_removes_key():
    """Setting EVENT_TYPE.NONE deletes the key from the registry."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.dev.user-1.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.set_monitor(conn, token=ADDRESS, type=EVENT_TYPE.NONE)
    assert 'p.dev.user-1.proj-1.src-1' not in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_rejects_token_and_project_id_together():
    """Specifying BOTH token and project_id raises ValueError."""
    conn = _make_conn(account_info=_account_info())
    with pytest.raises(ValueError, match='either token or project_id/source'):
        await MonitorCommands.set_monitor(conn, token=ADDRESS, project_id='proj-1', source='src-1')


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
    server.resolve_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    await MonitorCommands.set_monitor(conn, token=ADDRESS, type=EVENT_TYPE.SUMMARY, pipe_id=42)
    assert 'p.dev.user-1.proj-1.src-1.42' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_cross_tenant_token_raises():
    """An address the resolver refuses for this caller raises PermissionError
    and registers nothing — the resolver's verdict is final here.
    """
    server = MagicMock()
    server.resolve_control = MagicMock(side_effect=PermissionError('Access denied: no permissions for this task'))
    conn = _make_conn(account_info=_account_info(user_id='user-1'), server=server)
    with pytest.raises(PermissionError, match='Access denied'):
        await MonitorCommands.set_monitor(conn, token=ADDRESS, type=EVENT_TYPE.SUMMARY)
    server.resolve_control.assert_called_once_with(ADDRESS, conn._account_info, 'task.monitor')
    assert conn._monitors == {}


# ---------------------------------------------------------------------------
# on_rrext_monitor — argument parsing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_string_list_types():
    """A list of EVENT_TYPE name strings is converted to a bitmask."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_address = MagicMock(return_value=ADDRESS)

    request = {'arguments': {'types': ['SUMMARY', 'TASK']}}
    await MonitorCommands.on_rrext_monitor(conn, request)

    monitor_value = conn._monitors.get('p.dev.user-1.proj-1.src-1')
    assert monitor_value is not None
    assert monitor_value & EVENT_TYPE.SUMMARY
    assert monitor_value & EVENT_TYPE.TASK


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_int_types():
    """An int `types` value is used directly as the bitmask."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_address = MagicMock(return_value=ADDRESS)

    request = {'arguments': {'types': EVENT_TYPE.SUMMARY.value}}
    await MonitorCommands.on_rrext_monitor(conn, request)
    assert conn._monitors.get('p.dev.user-1.proj-1.src-1') == EVENT_TYPE.SUMMARY


@pytest.mark.asyncio
async def test_on_rrext_monitor_with_unknown_string_in_list_is_ignored():
    """An unknown name in the string list is silently skipped (warning printed)."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_address = MagicMock(return_value=ADDRESS)

    request = {'arguments': {'types': ['SUMMARY', 'NOPE_NOT_AN_EVENT']}}
    await MonitorCommands.on_rrext_monitor(conn, request)
    monitor_value = conn._monitors.get('p.dev.user-1.proj-1.src-1')
    assert monitor_value & EVENT_TYPE.SUMMARY


# ---------------------------------------------------------------------------
# Owner scoping — dev keys are user-scoped, deploy keys are team-scoped
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_task_event_deploy_run_delivers_to_team_key():
    """A deploy run's events land on the TEAM-scoped key, not a user key."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control(run_kind='deploy'))
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.deploy.team-1.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'status', 'body': {}})
    conn.send_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_send_task_event_dev_run_not_delivered_to_other_owner_key():
    """A dev run's events never match another owner's subscription key."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control(user_id='user-1'))
    # Subscriber holds a key for user-2's dev run of the SAME project/source.
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        monitors={'p.dev.user-2.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'status', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_send_task_event_dev_vs_deploy_keys_never_alias():
    """A dev subscription of a pipeline does NOT receive its deploy run's events."""
    server = MagicMock()
    server.control_by_key = MagicMock(return_value=_control(run_kind='deploy'))
    conn = _make_conn(
        account_info=_account_info(),
        server=server,
        # The caller's own dev subscription for the same project/source.
        monitors={'p.dev.user-1.proj-1.src-1': EVENT_TYPE.SUMMARY},
    )
    await MonitorCommands.send_task_event(conn, EVENT_TYPE.SUMMARY, KEY, {'event': 'status', 'body': {}})
    conn.send_event.assert_not_called()


@pytest.mark.asyncio
async def test_set_monitor_project_scope_binds_caller_as_owner():
    """A project/source subscription without team_id binds the CALLER's userId."""
    server = MagicMock()
    server.get_task_control_by_project = MagicMock(return_value=_control())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(user_id='user-1'), server=server)
    await MonitorCommands.set_monitor(conn, project_id='proj-1', source='src-1', type=EVENT_TYPE.SUMMARY)
    assert 'p.dev.user-1.proj-1.src-1' in conn._monitors


@pytest.mark.asyncio
async def test_set_monitor_team_scope_binds_team_as_owner():
    """A project/source subscription WITH team_id builds the team-scoped key."""
    server = MagicMock()
    server.get_task_control_by_project = MagicMock(return_value=_control(run_kind='deploy'))
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    await MonitorCommands.set_monitor(
        conn, project_id='proj-1', source='src-1', type=EVENT_TYPE.SUMMARY, team_id='team-1'
    )
    assert 'p.deploy.team-1.proj-1.src-1' in conn._monitors
    # The lookup was scoped to the team as well.
    _, kwargs = server.get_task_control_by_project.call_args
    assert kwargs.get('team_id') == 'team-1'


@pytest.mark.asyncio
async def test_set_monitor_token_for_deploy_run_builds_team_key():
    """An address subscription to a deploy run lands on the team-scoped key."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=_control(run_kind='deploy'))
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    await MonitorCommands.set_monitor(conn, token=ADDRESS, type=EVENT_TYPE.SUMMARY)
    assert 'p.deploy.team-1.proj-1.src-1' in conn._monitors


@pytest.mark.asyncio
async def test_on_rrext_monitor_passes_team_id_through():
    """The wire teamId argument reaches set_monitor's team scope."""
    server = MagicMock()
    server.get_task_control_by_project = MagicMock(return_value=_control(run_kind='deploy'))
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task_address = MagicMock(return_value='')

    request = {'arguments': {'projectId': 'proj-1', 'source': 'src-1', 'teamId': 'team-1', 'types': ['SUMMARY']}}
    await MonitorCommands.on_rrext_monitor(conn, request)
    assert 'p.deploy.team-1.proj-1.src-1' in conn._monitors


# ---------------------------------------------------------------------------
# Team-scope authorization (security) — a team_id subscription requires
# membership, checked BEFORE the not-running swallow can register the key.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_monitor_foreign_team_scope_denied_even_when_not_running():
    """Subscribing to another team's deploy scope is rejected up front -- even
    when no run exists yet. Regression: get_task_control_by_project raises a
    RuntimeError (not a PermissionError) on the not-running path, which the
    except-Exception branch swallows; without the membership check the foreign
    subscription would still be registered under p.<foreignTeam>.<proj>.<src>.
    """
    server = MagicMock()
    # Subscribe-before-launch: no live run -> RuntimeError, NOT PermissionError.
    server.get_task_control_by_project = MagicMock(side_effect=RuntimeError('Your pipeline is not running'))
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(team_id='team-1'), server=server)

    with pytest.raises(PermissionError, match='no permissions for this team'):
        await MonitorCommands.set_monitor(
            conn, project_id='proj-1', source='src-1', type=EVENT_TYPE.SUMMARY, team_id='team-other'
        )

    # Nothing registered under the foreign key, and the run lookup was never
    # reached (the membership check fires first).
    assert 'p.deploy.team-other.proj-1.src-1' not in conn._monitors
    assert conn._monitors == {}
    server.get_task_control_by_project.assert_not_called()


@pytest.mark.asyncio
async def test_set_monitor_own_team_scope_allowed_before_a_run_exists():
    """The caller's OWN team scope still subscribes before any run exists: the
    not-running RuntimeError is tolerated once membership is established.
    """
    server = MagicMock()
    server.get_task_control_by_project = MagicMock(side_effect=RuntimeError('not running'))
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=_account_info(team_id='team-1'), server=server)

    await MonitorCommands.set_monitor(
        conn, project_id='proj-1', source='src-1', type=EVENT_TYPE.SUMMARY, team_id='team-1'
    )
    assert 'p.deploy.team-1.proj-1.src-1' in conn._monitors


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_monitor_commands_init_creates_empty_monitor_registry():
    """The constructor seeds _monitors as an empty dict."""
    conn = MonitorCommands.__new__(MonitorCommands)
    MonitorCommands.__init__(conn, connection_id=1, server=None, transport=None)
    assert conn._monitors == {}
