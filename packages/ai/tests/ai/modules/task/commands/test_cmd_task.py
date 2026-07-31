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


def _patch_store_file_store(monkeypatch, fs):
    """Route the Store.file_store classmethod (the singleton one-liner the
    handlers call) at the mocked FileStore for this test.
    """
    from ai.account.store import Store

    # Mirrors the real classmethod signature (ctx, client_id=None, root=None)
    # so a call site passing the engine storage anchor exercises the handler
    # instead of dying in the patch with an opaque TypeError.
    monkeypatch.setattr(Store, 'file_store', classmethod(lambda cls, ctx, client_id=None, root=None: fs))


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
    conn.verify_team_permission = MagicMock()  # granted by default
    conn.verify_plans = MagicMock(return_value=True)
    conn.get_task = MagicMock()
    # Bind the REAL org resolver (defined on TaskConn, next to
    # verify_team_permission) so on_execute exercises real membership-based
    # resolution against the stub AccountInfo's organization.
    from ai.modules.task.task_conn import TaskConn

    conn.resolve_org_for_team = MethodType(TaskConn.resolve_org_for_team, conn)
    # Identity context builder (TaskConn.request_context) — the file store is
    # mocked in these tests, so a stub ctx suffices.
    conn.request_context = MagicMock(return_value=SimpleNamespace(account_info=account_info))
    # File-store access lives on StoreCommands; bind the real methods so the
    # fs_* handlers can resolve them on this __init__-bypassed stub.
    conn._get_file_store = MethodType(StoreCommands._get_file_store, conn)
    conn._virtual_scope_mounts = MethodType(StoreCommands._virtual_scope_mounts, conn)
    conn._list_scope_mount = MethodType(StoreCommands._list_scope_mount, conn)
    conn._is_scope_root = StoreCommands._is_scope_root  # staticmethod — no binding

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
    """Build an AccountInfo-shaped stub.

    The default organization contains the default team so the real org
    resolver (resolve_org_for_team) succeeds via membership; pass an explicit
    organization to model other shapes.
    """
    return SimpleNamespace(
        userId=user_id,
        auth=auth,
        userToken='token-' + user_id,
        defaultTeam=default_team,
        organization=organization if organization is not None else {'id': 'org-1', 'teams': [{'id': default_team}]},
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
    """A PermissionError from the team permission check bubbles up after logging."""
    conn = _make_conn(account_info=_account_info())
    conn.verify_team_permission = MagicMock(side_effect=PermissionError('no control'))
    with pytest.raises(PermissionError, match='no control'):
        await TaskCommands.on_execute(conn, {'arguments': {}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_on_execute_rejects_client_team_override(monkeypatch):
    """A client-supplied teamId that differs from the session's team context
    (the profile-assigned development team) is REJECTED, not honored — clients
    no longer choose which team a run executes under.
    """
    from ai.account import account as account_mod

    # The stubbed permission check grants, so execution continues into the
    # secret merge — patch it out so this test asserts only the check target.
    monkeypatch.setattr(account_mod, 'get_merged_env', AsyncMock(return_value={}))

    organization = {'id': 'org-1', 'teams': [{'id': 'team-1'}, {'id': 'team-target'}]}
    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})
    conn = _make_conn(account_info=_account_info(default_team='team-1', organization=organization), server=server)

    with pytest.raises(PermissionError, match='development team'):
        await TaskCommands.on_execute(conn, {'arguments': {'teamId': 'team-target'}})

    server.start_task.assert_not_called()


@pytest.mark.asyncio
async def test_on_execute_accepts_team_id_matching_session_team():
    """A teamId EQUAL to the session's team passes (the trusted in-process
    dispatch sends teamId = the synthesized defaultTeam) and task.control is
    verified on that team.
    """
    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})
    conn = _make_conn(account_info=_account_info(default_team='team-1'), server=server)

    await TaskCommands.on_execute(conn, {'arguments': {'teamId': 'team-1'}})

    conn.verify_team_permission.assert_called_once_with('team-1', 'task.control')


@pytest.mark.asyncio
async def test_on_execute_foreign_team_denied_before_secret_merge(monkeypatch):
    """A foreign teamId aborts BEFORE the env/secret merge and before
    start_task — the cross-team secret-exfiltration hole this check closes.
    """
    from ai.account import account as account_mod

    merged_env = AsyncMock()
    monkeypatch.setattr(account_mod, 'get_merged_env', merged_env)

    server = MagicMock()
    server.start_task = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)

    with pytest.raises(PermissionError, match='development team'):
        await TaskCommands.on_execute(conn, {'arguments': {'teamId': 'team-foreign'}})

    # Neither the secret merge nor the task start may have been reached.
    merged_env.assert_not_awaited()
    server.start_task.assert_not_called()


@pytest.mark.asyncio
async def test_on_execute_run_kind_cannot_be_spoofed_via_dap():
    """arguments.run_kind/trigger are IGNORED: run classification comes only
    from the trusted in-process dispatch attributes, so a remote client can
    never write into the deploy continuum or claim a scheduled trigger.
    """
    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})
    conn = _make_conn(account_info=_account_info(), server=server)

    await TaskCommands.on_execute(
        conn, {'arguments': {'pipeline': {'components': []}, 'run_kind': 'deploy', 'trigger': 'schedule'}}
    )

    kwargs = server.start_task.call_args.kwargs
    assert kwargs['run_kind'] == 'dev'
    assert kwargs['trigger'] == ''


@pytest.mark.asyncio
async def test_on_execute_trusted_attributes_classify_deploy_runs(monkeypatch):
    """The in-process dispatch sets _trusted_run_kind/_trusted_trigger on its
    connection; on_execute forwards them to start_task and SKIPS the user
    env layer (a deployment's config must not depend on who deployed it).
    """
    from ai.account import account as account_singleton

    merged = AsyncMock(return_value={})
    monkeypatch.setattr(account_singleton, 'get_merged_env', merged)

    server = MagicMock()
    server.start_task = AsyncMock(return_value={'token': 'tk_new'})
    conn = _make_conn(account_info=_account_info(), server=server)
    conn._trusted_run_kind = 'deploy'
    conn._trusted_trigger = 'schedule'

    await TaskCommands.on_execute(conn, {'arguments': {'pipeline': {'components': []}}})

    kwargs = server.start_task.call_args.kwargs
    assert kwargs['run_kind'] == 'deploy'
    assert kwargs['trigger'] == 'schedule'
    # No user layer for deploy runs.
    assert merged.await_args.kwargs['user_id'] == ''


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


@pytest.mark.asyncio
async def test_on_restart_authorizes_against_the_tasks_team():
    """on_restart routes authorization through get_task (task-team resolution)
    and never reaches restart_task when the caller lacks task.control on the
    TASK's team — the cross-team restart hole this closes.
    """
    server = MagicMock()
    server.restart_task = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task = MagicMock(side_effect=PermissionError('denied for this task'))

    with pytest.raises(PermissionError, match='denied for this task'):
        await TaskCommands.on_restart(conn, {'arguments': {'token': 'tk_other_team'}})

    conn.get_task.assert_called_once()
    assert conn.get_task.call_args.args[1] == 'task.control'
    server.restart_task.assert_not_called()


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
        'proj-1', 'src-1', conn._account_info, require='task.monitor', team_id=''
    )


@pytest.mark.asyncio
async def test_on_rrext_get_token_team_scope_resolves_deploy_run():
    """A teamId argument scopes the lookup (and permission check) to that team."""
    server = MagicMock()
    server.get_task_control_by_project = MagicMock(return_value=SimpleNamespace(token='tk_deploy'))

    conn = _make_conn(account_info=_account_info(), server=server)
    conn.verify_team_permission = MagicMock()
    response = await TaskCommands.on_rrext_get_token(
        conn, {'arguments': {'projectId': 'proj-1', 'source': 'src-1', 'teamId': 'team-1'}}
    )
    assert response == {'type': 'response', 'body': {'token': 'tk_deploy'}}
    conn.verify_team_permission.assert_called_once_with('team-1', 'task.monitor')
    server.get_task_control_by_project.assert_called_once_with(
        'proj-1', 'src-1', conn._account_info, require='task.monitor', team_id='team-1'
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
            run_kind='dev',
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
    # Run classification rides every row — clients must not infer deploy-ness
    # from a non-empty teamId (dev runs carry an attribution team too).
    assert response['body']['tasks'][0]['runKind'] == 'dev'


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
        run_kind='dev',
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
async def test_on_rrext_store_dispatches_to_known_subcommand(monkeypatch):
    """A known subcommand is dispatched via _store_subcommand_handlers."""
    server = MagicMock()
    server.store = MagicMock()
    fs = MagicMock()
    fs.stat = AsyncMock(return_value={'exists': True, 'size': 0})
    _patch_store_file_store(monkeypatch, fs)

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
async def test_store_fs_open_write_returns_handle_id(monkeypatch):
    """fs_open with mode='w' creates a write handle and returns its id."""
    server = MagicMock()
    fs = MagicMock()
    fs.open_write = AsyncMock(return_value='h-123')
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_account_info(), server=server, connection_id=42)
    args = {'path': 'foo.txt', 'mode': 'w'}
    response = await StoreCommands._store_fs_open(conn, {}, args)
    fs.open_write.assert_awaited_once_with('foo.txt')
    assert response['body'] == {'handle': 'h-123'}


@pytest.mark.asyncio
async def test_store_fs_open_read_returns_metadata(monkeypatch):
    """fs_open default mode opens for reading and returns the metadata dict."""
    server = MagicMock()
    fs = MagicMock()
    fs.open_read = AsyncMock(return_value={'handle': 'h-456', 'size': 1024})
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_account_info(), server=server, connection_id=7)
    response = await StoreCommands._store_fs_open(conn, {}, {'path': 'foo.txt'})
    fs.open_read.assert_awaited_once_with('foo.txt')
    assert response['body'] == {'handle': 'h-456', 'size': 1024}


@pytest.mark.asyncio
async def test_store_fs_read_clamps_negative_offset(monkeypatch):
    """Negative offset is reset to 0 before forwarding to FileStore."""
    server = MagicMock()
    fs = MagicMock()
    fs.read_chunk = AsyncMock(return_value=b'data')
    _patch_store_file_store(monkeypatch, fs)

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
# Virtual scope mounts ('@' / '@/Team') in fs_list_dir / fs_stat
# ---------------------------------------------------------------------------


def _org_account(*, teams=None, org_perms=()):
    """Account stub with an organization for scope-mount tests."""
    return _account_info(
        organization={
            'id': 'org-1',
            'name': 'Acme',
            'permissions': list(org_perms),
            'teams': teams
            if teams is not None
            else [{'id': 'team-1', 'name': 'Development', 'permissions': ['task.store']}],
        }
    )


@pytest.mark.asyncio
async def test_root_listing_is_pure_and_filters_reserved_names(monkeypatch):
    """Simple mode: the root listing is the caller's own tree ONLY — no
    injected mounts — and reserved '@'/'=' physical names are dropped.
    """
    server = MagicMock()
    fs = MagicMock()
    fs.list_dir = AsyncMock(
        return_value={
            'entries': [
                {'name': 'docs', 'type': 'dir'},
                {'name': '@legacy', 'type': 'dir'},
                {'name': '=old', 'type': 'file'},
            ],
            'count': 3,
        }
    )
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_org_account(org_perms=['org.admin']), server=server)
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': ''})

    names = [e['name'] for e in response['body']['entries']]
    assert names == ['docs']
    assert response['body']['count'] == 1


@pytest.mark.asyncio
async def test_at_listing_shows_mounts_by_capability(monkeypatch):
    """Joined mode: '@' lists User/Team always, Org only for org.admin."""
    server = MagicMock()
    fs = MagicMock()
    fs.list_dir = AsyncMock()
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_org_account(org_perms=['org.admin']), server=server)
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': '@'})
    assert [e['name'] for e in response['body']['entries']] == ['User', 'Team', 'Org']

    conn = _make_conn(account_info=_org_account(), server=server)
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': '@'})
    assert [e['name'] for e in response['body']['entries']] == ['User', 'Team']

    # The mounts are virtual — the store is never consulted.
    fs.list_dir.assert_not_called()


@pytest.mark.asyncio
async def test_listing_team_mount_returns_memberships_not_storage(monkeypatch):
    """Listing '@/Team' is VIRTUAL: the caller's teams by display name with the
    id in the entry body — never a physical teams/ listing.
    """
    server = MagicMock()
    fs = MagicMock()
    fs.list_dir = AsyncMock()
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_org_account(), server=server)
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': '@/Team'})

    fs.list_dir.assert_not_called()
    assert response['body']['entries'] == [{'name': 'Development', 'type': 'dir', 'id': 'team-1', 'virtual': True}]


@pytest.mark.asyncio
async def test_stat_scope_mounts_synthesize_directories(monkeypatch):
    """fs_stat on the bare mounts reports a virtual directory."""
    server = MagicMock()
    fs = MagicMock()
    fs.stat = AsyncMock()
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_org_account(), server=server)
    for path in ('@', '@/User', '@/Team', '@/Org', '/@/Team/'):
        response = await StoreCommands._store_fs_stat(conn, {}, {'path': path})
        assert response['body'] == {'exists': True, 'type': 'dir', 'virtual': True}
    fs.stat.assert_not_called()


@pytest.mark.asyncio
async def test_no_org_session_at_listing(monkeypatch):
    """A session without an organization still gets User/Team (its team
    list is simply empty) but never Org.
    """
    server = MagicMock()
    fs = MagicMock()
    fs.list_dir = AsyncMock()
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_account_info(), server=server)
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': '@'})

    assert [e['name'] for e in response['body']['entries']] == ['User', 'Team']


# ---------------------------------------------------------------------------
# System trees (.logs / .deployments) hidden from listings
# ---------------------------------------------------------------------------


def _fs_with_system_entries():
    """File-store mock whose listing includes the system trees."""
    fs = MagicMock()
    fs.list_dir = AsyncMock(
        return_value={
            'entries': [
                {'name': '.logs', 'type': 'dir'},
                {'name': '.deployments', 'type': 'dir'},
                {'name': 'docs', 'type': 'dir'},
            ],
            'count': 3,
        }
    )
    return fs


@pytest.mark.asyncio
async def test_listing_hides_system_trees_from_ordinary_sessions(monkeypatch):
    """.logs/.deployments are system-owned: invisible at every scope root
    for callers without sys.admin.
    """
    fs = _fs_with_system_entries()
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_org_account(), server=MagicMock())
    # The tail of the matrix is the normalization-bypass family: spellings
    # that reach a scope root only AFTER normalize_path collapses them
    # ('@//User', '@/./User', '\\@\\User', '/'). The filter and the store
    # must judge the SAME normalized path — filtering on the raw spelling
    # would let these list the user root with the system trees visible.
    for path in (
        '',
        '@/User',
        '@/Org',
        '@/Team/=team-1',
        '@/User/=other-user',
        '@//User',
        '@/./User',
        '\\@\\User',
        '/',
    ):
        response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': path})
        names = [e['name'] for e in response['body']['entries']]
        assert '.logs' not in names and '.deployments' not in names
        assert 'docs' in names


@pytest.mark.asyncio
async def test_listing_shows_system_trees_to_sys_admin(monkeypatch):
    """sys.admin may do anything with the system trees — including see them."""
    fs = _fs_with_system_entries()
    _patch_store_file_store(monkeypatch, fs)

    account = _org_account()
    account.sysPermissions = ['sys.admin']
    conn = _make_conn(account_info=account, server=MagicMock())
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': ''})

    names = [e['name'] for e in response['body']['entries']]
    assert '.logs' in names and '.deployments' in names


@pytest.mark.asyncio
async def test_nested_listing_keeps_user_dirs_named_like_system_trees(monkeypatch):
    """Only SCOPE ROOTS host system trees — a nested dir a user happened to
    name '.logs' stays visible (the store would resolve it normally too).
    """
    fs = _fs_with_system_entries()
    _patch_store_file_store(monkeypatch, fs)

    conn = _make_conn(account_info=_org_account(), server=MagicMock())
    response = await StoreCommands._store_fs_list_dir(conn, {}, {'path': 'docs/sub'})

    names = [e['name'] for e in response['body']['entries']]
    assert '.logs' in names and '.deployments' in names


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
