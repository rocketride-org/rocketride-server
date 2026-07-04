"""
Unit tests for ai.modules.task.commands.cmd_task.TaskCommands and the
file-storage handlers extracted into ai.modules.task.commands.cmd_store.StoreCommands.

Coverage focus: ``on_execute``, ``on_restart``, ``on_rrext_get_task_status``,
``on_rrext_get_token``, ``on_rrext_get_tasks`` (TaskCommands) and the
``on_rrext_store`` dispatch plus ``_store_fs_*`` handlers (StoreCommands).
The file-store handlers are exercised by mocking the underlying
``FileStore`` returned by ``_get_file_store``.

The multi-mixin __init__ is bypassed via ``__new__``; tests seed
``_server``, ``_account_info``, ``_connection_id``, and the dispatch
table ``_store_subcommand_handlers`` directly.
"""

from __future__ import annotations

from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.commands.cmd_task import TaskCommands
from ai.modules.task.commands.cmd_store import StoreCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(*, account_info=None, server=None, connection_id=1):
    """Build a TaskCommands instance with __init__ bypassed."""
    conn = TaskCommands.__new__(TaskCommands)
    conn._account_info = account_info
    conn._server = server or MagicMock()
    conn._connection_id = connection_id
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()
    conn.verify_permission = MagicMock()  # granted by default
    conn.verify_plans = MagicMock(return_value=True)
    conn.get_task = MagicMock()
    # File-store access lives on StoreCommands; bind the real method so the
    # fs_* handlers can resolve _get_file_store on this __init__-bypassed stub.
    conn._get_file_store = MethodType(StoreCommands._get_file_store, conn)
    # Re-build the dispatch table that StoreCommands.__init__ would have created.
    conn._store_subcommand_handlers = {
        'fs_open': lambda req, args: StoreCommands._store_fs_open(conn, req, args),
        'fs_read': lambda req, args: StoreCommands._store_fs_read(conn, req, args),
        'fs_write': lambda req, args: StoreCommands._store_fs_write(conn, req, args),
        'fs_close': lambda req, args: StoreCommands._store_fs_close(conn, req, args),
        'fs_delete': lambda req, args: StoreCommands._store_fs_delete(conn, req, args),
        'fs_list_dir': lambda req, args: StoreCommands._store_fs_list_dir(conn, req, args),
        'fs_mkdir': lambda req, args: StoreCommands._store_fs_mkdir(conn, req, args),
        'fs_rmdir': lambda req, args: StoreCommands._store_fs_rmdir(conn, req, args),
        'fs_stat': lambda req, args: StoreCommands._store_fs_stat(conn, req, args),
        'fs_rename': lambda req, args: StoreCommands._store_fs_rename(conn, req, args),
        'fs_geturl': lambda req, args: StoreCommands._store_fs_geturl(conn, req, args),
    }
    return conn


def _account_info(*, user_id='user-1', auth='ak_x', default_team='team-1', organization=None):
    """Build an AccountInfo-shaped stub."""
    return SimpleNamespace(
        userId=user_id,
        auth=auth,
        userToken='token-' + user_id,
        defaultTeam=default_team,
        organization=organization,
        sysPermissions=[],
    )


# ---------------------------------------------------------------------------
# on_execute
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_execute_starts_task_with_resolved_org_id():
    """on_execute resolves org_id from the user's default team and calls start_task."""
    organization = {'id': 'org-B', 'teams': [{'id': 'team-1'}, {'id': 'team-other'}]}
    account = _account_info(user_id='user-1', default_team='team-1', organization=organization)

    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})

    conn = _make_conn(account_info=account, server=server)
    response = await TaskCommands.on_execute(conn, {'arguments': {'pipeline': {'components': []}}})

    server.start_task.assert_awaited_once()
    call_kwargs = server.start_task.call_args.kwargs
    assert call_kwargs['org_id'] == 'org-B'
    assert call_kwargs['team_id'] == 'team-1'
    assert call_kwargs['user_id'] == 'user-1'
    assert call_kwargs['wait_for_running'] is True
    assert response == {'type': 'response', 'body': {'token': 'tk_new'}}


@pytest.mark.asyncio
async def test_on_execute_requires_task_control_permission():
    """A PermissionError from verify_permission bubbles up after logging."""
    conn = _make_conn(account_info=_account_info())
    conn.verify_permission = MagicMock(side_effect=PermissionError('no control'))
    with pytest.raises(PermissionError, match='no control'):
        await TaskCommands.on_execute(conn, {'arguments': {}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_on_execute_checks_plan_for_pipeline():
    """When the request includes a pipeline, verify_plans is invoked."""
    account = _account_info()
    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})

    conn = _make_conn(account_info=account, server=server)
    await TaskCommands.on_execute(conn, {'arguments': {'pipeline': {'components': []}}})

    conn.verify_plans.assert_called_once_with(account, {'components': []})


@pytest.mark.asyncio
async def test_on_execute_skips_plan_check_without_pipeline():
    """If the request omits pipeline, verify_plans is not invoked."""
    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})

    conn = _make_conn(account_info=_account_info(), server=server)
    await TaskCommands.on_execute(conn, {'arguments': {}})

    conn.verify_plans.assert_not_called()


# ---------------------------------------------------------------------------
# on_restart
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_restart_delegates_to_restart_task():
    """on_restart forwards to TaskServer.restart_task and returns its body."""
    server = MagicMock()
    server.restart_task = AsyncMock(return_value={'restarted': True})
    conn = _make_conn(account_info=_account_info(), server=server)
    response = await TaskCommands.on_restart(conn, {'arguments': {'token': 'tk_x'}})
    server.restart_task.assert_awaited_once()
    assert response == {'type': 'response', 'body': {'restarted': True}}


@pytest.mark.asyncio
async def test_on_restart_propagates_server_errors():
    """If restart_task raises, on_restart logs and re-raises."""
    server = MagicMock()
    server.restart_task = AsyncMock(side_effect=RuntimeError('cannot restart'))
    conn = _make_conn(account_info=_account_info(), server=server)
    with pytest.raises(RuntimeError, match='cannot restart'):
        await TaskCommands.on_restart(conn, {'arguments': {}})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# on_rrext_get_task_status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_get_task_status_returns_task_status_dict():
    """Retrieves task via get_task and returns its model_dump()."""
    status = MagicMock()
    status.model_dump = MagicMock(return_value={'name': 'task-1', 'state': 3})

    task = MagicMock()
    task.get_status.return_value = status

    conn = _make_conn(account_info=_account_info())
    conn.get_task = MagicMock(return_value=task)

    response = await TaskCommands.on_rrext_get_task_status(conn, {'arguments': {'token': 'tk_x'}})
    conn.get_task.assert_called_once()
    assert response == {'type': 'response', 'body': {'name': 'task-1', 'state': 3}}


# ---------------------------------------------------------------------------
# on_rrext_get_token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_get_token_returns_token_from_server():
    """The handler queries the server with project_id + source and returns the token."""
    server = MagicMock()
    server.get_task_control_by_project = MagicMock(return_value=SimpleNamespace(token='tk_found'))

    conn = _make_conn(account_info=_account_info(), server=server)
    response = await TaskCommands.on_rrext_get_token(conn, {'arguments': {'projectId': 'proj-1', 'source': 'src-1'}})
    assert response == {'type': 'response', 'body': {'token': 'tk_found'}}
    server.get_task_control_by_project.assert_called_once_with(
        'proj-1', 'src-1', conn._account_info, require='task.monitor'
    )


# ---------------------------------------------------------------------------
# on_rrext_get_tasks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_get_tasks_filters_to_caller_and_running_only():
    """The list includes only RUNNING tasks the caller has team access to."""
    from rocketride import TASK_STATE

    running_status = SimpleNamespace(state=TASK_STATE.RUNNING.value, status='running')
    completed_status = SimpleNamespace(state=TASK_STATE.COMPLETED.value, status='completed')

    def _ctrl(token, team_id, status):
        """Build a TASK_CONTROL stub with the given team_id + status."""
        task = MagicMock()
        task.get_status = MagicMock(return_value=status)
        return SimpleNamespace(
            token=token,
            userId='user-1',
            teamId=team_id,
            source='src',
            pipeline={'name': 'my-pipeline', 'description': 'desc'},
            task=task,
        )

    server = MagicMock()
    server._task_control = {
        'tk_running_mine': _ctrl('tk_running_mine', 'team-1', running_status),
        'tk_done_mine': _ctrl('tk_done_mine', 'team-1', completed_status),
        'tk_running_other': _ctrl('tk_running_other', 'team-other', running_status),
    }

    # Caller has access to team-1 only; team-other is invisible.
    organization = {
        'id': 'org-1',
        'permissions': [],
        'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
    }
    conn = _make_conn(account_info=_account_info(user_id='user-1', organization=organization), server=server)
    response = await TaskCommands.on_rrext_get_tasks(conn, {})

    tokens = [t['token'] for t in response['body']['tasks']]
    assert tokens == ['tk_running_mine']
    assert response['body']['tasks'][0]['name'] == 'my-pipeline'


@pytest.mark.asyncio
async def test_on_rrext_get_tasks_falls_back_to_source_name():
    """Without pipeline.name, the task name defaults to the source id."""
    from rocketride import TASK_STATE

    status = SimpleNamespace(state=TASK_STATE.RUNNING.value, status='running')
    task = MagicMock()
    task.get_status = MagicMock(return_value=status)
    control = SimpleNamespace(
        token='tk_1',
        userId='user-1',
        teamId='team-1',
        source='my-source',
        pipeline=None,
        task=task,
    )

    server = MagicMock()
    server._task_control = {'tk_1': control}

    organization = {
        'id': 'org-1',
        'permissions': [],
        'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
    }
    conn = _make_conn(account_info=_account_info(user_id='user-1', organization=organization), server=server)
    response = await TaskCommands.on_rrext_get_tasks(conn, {})
    assert response['body']['tasks'][0]['name'] == 'my-source'
    assert response['body']['tasks'][0]['description'] == 'RocketRide DTC MCP Tool'


# ---------------------------------------------------------------------------
# on_rrext_store dispatcher
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_store_dispatches_to_known_subcommand():
    """A known subcommand is dispatched via _store_subcommand_handlers."""
    server = MagicMock()
    server.store = MagicMock()
    fs = MagicMock()
    fs.stat = AsyncMock(return_value={'exists': True, 'size': 0})
    server.store.get_file_store = MagicMock(return_value=fs)

    conn = _make_conn(account_info=_account_info(), server=server)
    response = await StoreCommands.on_rrext_store(conn, {'arguments': {'subcommand': 'fs_stat', 'path': 'foo.txt'}})
    assert response['body'] == {'exists': True, 'size': 0}


@pytest.mark.asyncio
async def test_on_rrext_store_unknown_subcommand_raises():
    """An unknown subcommand raises ValueError."""
    conn = _make_conn(account_info=_account_info())
    with pytest.raises(ValueError, match='Unknown subcommand'):
        await StoreCommands.on_rrext_store(conn, {'arguments': {'subcommand': 'nope'}})


@pytest.mark.asyncio
async def test_on_rrext_store_missing_subcommand_raises():
    """A missing subcommand raises ValueError early."""
    conn = _make_conn(account_info=_account_info())
    with pytest.raises(ValueError, match='Subcommand is required'):
        await StoreCommands.on_rrext_store(conn, {'arguments': {}})


# ---------------------------------------------------------------------------
# Selected _store_fs_* handlers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_store_fs_open_write_returns_handle_id():
    """fs_open with mode='w' creates a write handle and returns its id."""
    server = MagicMock()
    fs = MagicMock()
    fs.open_write = AsyncMock(return_value='h-123')
    server.store.get_file_store = MagicMock(return_value=fs)

    conn = _make_conn(account_info=_account_info(), server=server, connection_id=42)
    args = {'path': 'foo.txt', 'mode': 'w'}
    response = await StoreCommands._store_fs_open(conn, {}, args)
    fs.open_write.assert_awaited_once_with('foo.txt', 42)
    assert response['body'] == {'handle': 'h-123'}


@pytest.mark.asyncio
async def test_store_fs_open_read_returns_metadata():
    """fs_open default mode opens for reading and returns the metadata dict."""
    server = MagicMock()
    fs = MagicMock()
    fs.open_read = AsyncMock(return_value={'handle': 'h-456', 'size': 1024})
    server.store.get_file_store = MagicMock(return_value=fs)

    conn = _make_conn(account_info=_account_info(), server=server, connection_id=7)
    response = await StoreCommands._store_fs_open(conn, {}, {'path': 'foo.txt'})
    fs.open_read.assert_awaited_once_with('foo.txt', 7)
    assert response['body'] == {'handle': 'h-456', 'size': 1024}


@pytest.mark.asyncio
async def test_store_fs_read_clamps_negative_offset():
    """Negative offset is reset to 0 before forwarding to FileStore."""
    server = MagicMock()
    fs = MagicMock()
    fs.read_chunk = AsyncMock(return_value=b'data')
    server.store.get_file_store = MagicMock(return_value=fs)

    conn = _make_conn(account_info=_account_info(), server=server)
    args = {'handle': 'h-1', 'offset': -50, 'length': 100}
    await StoreCommands._store_fs_read(conn, {}, args)
    fs.read_chunk.assert_awaited_once()
    call_args = fs.read_chunk.call_args
    # The clamped offset is the second positional or 'offset' kwarg.
    if 'offset' in call_args.kwargs:
        assert call_args.kwargs['offset'] == 0
    else:
        assert call_args.args[1] == 0


# ---------------------------------------------------------------------------
# Constructor — exercises the dispatch-table population
# ---------------------------------------------------------------------------


def test_store_commands_init_builds_subcommand_dispatch_table():
    """StoreCommands.__init__ stores a fully-populated _store_subcommand_handlers dict."""
    conn = StoreCommands.__new__(StoreCommands)
    StoreCommands.__init__(conn, connection_id=1, server=None, transport=None)
    assert set(conn._store_subcommand_handlers.keys()) == {
        'fs_open',
        'fs_read',
        'fs_write',
        'fs_close',
        'fs_delete',
        'fs_list_dir',
        'fs_mkdir',
        'fs_rmdir',
        'fs_stat',
        'fs_rename',
        'fs_geturl',
    }
