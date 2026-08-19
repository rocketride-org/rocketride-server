"""
Unit tests for ai.modules.task.commands.cmd_misc.MiscCommands.

Three categories:

- ``_mask_apikey`` / ``_resolve_monitor_label`` — pure static helpers.
- ``on_rrext_services`` / ``on_rrext_validate`` — thin handlers that
  delegate to rocketlib + ``resolve_implied_source``. Mock those.
- ``on_rrext_dashboard`` — large method that walks ``_task_control`` and
  ``_connections``. We cover the happy paths (caller filtering,
  tk_ scoping) with seeded state and bypassed __init__.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.modules.task.commands import cmd_misc
from ai.modules.task.commands.cmd_misc import MiscCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(*, account_info=None, server=None, connection_id=1):
    """Build a MiscCommands instance with __init__ bypassed."""
    conn = MiscCommands.__new__(MiscCommands)
    conn._account_info = account_info
    conn._server = server or MagicMock()
    conn._connection_id = connection_id
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()
    conn.verify_permission = MagicMock()  # no-op (granted) by default
    return conn


# ---------------------------------------------------------------------------
# _mask_apikey
# ---------------------------------------------------------------------------


def test_mask_apikey_short_value_is_fully_masked():
    """Strings 8 chars or shorter are returned as '****'."""
    assert MiscCommands._mask_apikey('') == '****'
    assert MiscCommands._mask_apikey('abc') == '****'
    assert MiscCommands._mask_apikey('12345678') == '****'  # boundary


def test_mask_apikey_long_value_shows_first_and_last_four():
    """Longer strings keep the first 4 and last 4 characters with **** in the middle."""
    assert MiscCommands._mask_apikey('abcdefghij') == 'abcd****ghij'
    assert MiscCommands._mask_apikey('ak_secret_1234567890') == 'ak_s****7890'


def test_mask_apikey_handles_none():
    """A None input is treated as 'short' and returns '****'."""
    assert MiscCommands._mask_apikey(None) == '****'


# ---------------------------------------------------------------------------
# _resolve_monitor_label
# ---------------------------------------------------------------------------


def test_resolve_monitor_label_wildcard():
    """The '*' wildcard maps to 'All tasks'."""
    assert MiscCommands._resolve_monitor_label('*', {}, {}) == 'All tasks'


def test_resolve_monitor_label_unrecognised_key():
    """Any key not starting with 'p.' falls back to 'Task monitor'."""
    assert MiscCommands._resolve_monitor_label('foo', {}, {}) == 'Task monitor'


# Keys carry the owner_key layout p.{runKind}.{owner}.{project}.{source}
# (the leading runKind segment separates a user's dev run from their @me
# deploy). The label resolver reads project from segment 2 and source from
# segment 3 — NOT 1/2 as the pre-runKind layout did.
def test_resolve_monitor_label_project_wildcard():
    """A 'p.<runKind>.<owner>.<id>.*' key uses the project label + '.*'."""
    project_names = {'proj-1': 'my-project'}
    assert MiscCommands._resolve_monitor_label('p.dev.user-1.proj-1.*', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_project_only():
    """A 'p.<runKind>.<owner>.<id>' key (no source) yields '<project>.*'."""
    project_names = {'proj-1': 'my-project'}
    assert MiscCommands._resolve_monitor_label('p.dev.user-1.proj-1', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_with_source():
    """A 'p.<runKind>.<owner>.<id>.<source>' key uses project + source friendly names."""
    project_names = {'proj-1': 'my-project'}
    source_names = {'proj-1.src-1': 'reader'}
    result = MiscCommands._resolve_monitor_label('p.deploy.user-1.proj-1.src-1', project_names, source_names)
    assert result == 'my-project.reader'


def test_resolve_monitor_label_reads_project_not_owner_segment():
    """Regression: the owner segment must NOT be read as the project. A key
    whose owner id would resolve to a friendly name if mis-indexed proves the
    resolver reads segment 2 (project), not segment 1 (owner).
    """
    # If the resolver wrongly read segment 1 (owner 'user-1') as the project,
    # it would emit 'owner-label'; reading segment 2 (proj-1) emits my-project.
    project_names = {'proj-1': 'my-project', 'user-1': 'owner-label'}
    assert MiscCommands._resolve_monitor_label('p.dev.user-1.proj-1.*', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_truncates_project_id_when_no_friendly_name():
    """Unknown project ids are truncated to 8 characters."""
    result = MiscCommands._resolve_monitor_label('p.dev.user-1.proj-very-long-id-here.*', {}, {})
    assert result.startswith('proj-ver')


# ---------------------------------------------------------------------------
# _build_monitors_list
# ---------------------------------------------------------------------------


def test_build_monitors_list_resolves_keys_and_flag_names():
    """Each (key, flags) pair becomes a {key: label, flags: names} dict."""
    from rocketride import EVENT_TYPE

    monitors = {
        'p.deploy.user-1.proj-1.src-1': EVENT_TYPE.SUMMARY,
        '*': EVENT_TYPE.SUMMARY,
    }
    project_names = {'proj-1': 'my-project'}
    source_names = {'proj-1.src-1': 'reader'}

    out = MiscCommands._build_monitors_list(monitors, project_names, source_names)

    # Sort for stability: order isn't part of the contract here.
    out_by_key = {item['key']: item['flags'] for item in out}
    assert 'my-project.reader' in out_by_key
    assert 'All tasks' in out_by_key
    # Each flag list contains at least 'summary'.
    assert 'summary' in out_by_key['my-project.reader']


# ---------------------------------------------------------------------------
# on_rrext_services
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_services_returns_specific_service(monkeypatch):
    """When `arguments.service` is set, return that single full entry."""
    schema = {'name': 'ocr', 'fields': []}

    async def fake_get_service(name):
        return schema if name == 'ocr' else None

    monkeypatch.setattr(cmd_misc.services_catalog, 'get_service', fake_get_service)

    conn = _make_conn()
    result = await MiscCommands.on_rrext_services(conn, {'arguments': {'service': 'ocr'}})

    assert result == {'type': 'response', 'body': schema}


@pytest.mark.asyncio
async def test_on_rrext_services_unknown_service_raises(monkeypatch):
    """An unknown service id raises ValueError (re-raised after debug log)."""

    async def fake_get_service(name):
        return None

    monkeypatch.setattr(cmd_misc.services_catalog, 'get_service', fake_get_service)

    conn = _make_conn()
    with pytest.raises(ValueError, match="Service 'unknown' not found"):
        await MiscCommands.on_rrext_services(conn, {'arguments': {'service': 'unknown'}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_on_rrext_services_no_service_returns_summary(monkeypatch):
    """Without a `service` arg, the cached summary body is returned."""
    summary = {'services': {'a': {'title': 'A'}}, 'version': 7}

    async def fake_get_summary():
        return summary

    monkeypatch.setattr(cmd_misc.services_catalog, 'get_summary', fake_get_summary)

    conn = _make_conn()
    result = await MiscCommands.on_rrext_services(conn, {})
    assert result['body'] == summary


# ---------------------------------------------------------------------------
# on_rrext_validate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_validate_uses_explicit_source(monkeypatch):
    """`arguments.source` takes priority over pipeline.source and the implied source."""
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: 'never-used')
    captured = {}

    def _fake_validate(payload):
        """Capture the payload so the test can assert on it."""
        captured['payload'] = payload
        return {'ok': True}

    monkeypatch.setattr(cmd_misc, 'validatePipeline', _fake_validate)

    conn = _make_conn()
    request = {
        'arguments': {
            'pipeline': {'components': [], 'source': 'pipeline-source'},
            'source': 'explicit-source',
        },
    }
    result = await MiscCommands.on_rrext_validate(conn, request)

    assert captured['payload']['source'] == 'explicit-source'
    assert captured['payload']['version'] == 1  # default
    assert result == {'type': 'response', 'body': {'ok': True}}


@pytest.mark.asyncio
async def test_on_rrext_validate_falls_back_to_pipeline_source(monkeypatch):
    """When `arguments.source` is missing, `pipeline.source` is used."""
    captured = {}
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    request = {'arguments': {'pipeline': {'source': 'pipeline-source', 'components': []}}}
    await MiscCommands.on_rrext_validate(conn, request)
    assert captured['source'] == 'pipeline-source'


@pytest.mark.asyncio
async def test_on_rrext_validate_falls_back_to_implied_source(monkeypatch):
    """When neither explicit nor pipeline.source is set, resolve_implied_source is used."""
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: 'implied')
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {}}})
    assert captured.get('source') == 'implied'


@pytest.mark.asyncio
async def test_on_rrext_validate_no_source_anywhere_omits_field(monkeypatch):
    """If no source can be resolved, the field is left out of the payload."""
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: None)
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {'components': []}}})
    assert 'source' not in captured


@pytest.mark.asyncio
async def test_on_rrext_validate_propagates_validate_pipeline_errors(monkeypatch):
    """A raise from validatePipeline is logged and re-raised."""
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: 'src')
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        MagicMock(side_effect=RuntimeError('invalid pipeline')),
    )

    conn = _make_conn()
    with pytest.raises(RuntimeError, match='invalid pipeline'):
        await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {}}})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# on_rrext_dashboard — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_dashboard_filters_to_caller_user_id(monkeypatch):
    """The dashboard only includes tasks owned by the caller."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Caller is a member of team-1 only; team-other is invisible to them.
    caller_account = SimpleNamespace(
        userId='user-1',
        auth='ak_caller',
        userToken='ak_caller_secret_token',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )

    # Server state: one task in caller's team, one in a team they cannot see.
    own_status = SimpleNamespace(
        name='task.reader',
        startTime=900.0,
        endTime=0,
        completed=False,
        state=3,
        totalCount=0,
        completedCount=0,
        rateCount=0,
        rateSize=0,
        metrics=None,
    )
    own_task = SimpleNamespace(
        get_status=lambda: own_status,
        get_connection_count=lambda: 1,
        _idle_time=0,
        _ttl=600,
    )
    own_control = SimpleNamespace(
        id='task-1',
        userId='user-1',
        teamId='team-1',
        token='tk_1',
        source='reader',
        project_id='proj-1',
        run_kind='dev',
        # Real controls always expose owner_id (dev run -> the user).
        owner_id='user-1',
        provider='node-x',
        task=own_task,
        launch_type=SimpleNamespace(value='LAUNCH'),
    )
    other_control = SimpleNamespace(
        id='task-2',
        userId='other-user',
        teamId='team-other',
        token='tk_2',
        source='other-source',
        project_id='proj-2',
        run_kind='dev',
        owner_id='other-user',
        provider='node-y',
        task=MagicMock(),
        launch_type=SimpleNamespace(value='EXECUTE'),
    )

    server = MagicMock()
    server._task_control = {'tk_1': own_control, 'tk_2': other_control}
    server._connections = {}
    server._server = SimpleNamespace(_startTime=900.0)

    conn = _make_conn(account_info=caller_account, server=server)
    result = await MiscCommands.on_rrext_dashboard(conn, {})

    body = result['body']
    assert body['overview']['activeTasks'] == 1
    assert len(body['tasks']) == 1
    assert body['tasks'][0]['id'] == 'task-1'


@pytest.mark.asyncio
async def test_on_rrext_dashboard_tk_auth_locks_to_owning_task(monkeypatch):
    """Task-token (tk_*) auth restricts the view to just that task."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Both tasks belong to caller's team; the tk_ auth filter narrows further.
    caller_account = SimpleNamespace(
        userId='user-1',
        auth='tk_my-only-task',
        userToken='tk_token',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )

    def _make_control(token):
        """Build a minimal task control with the matching token."""
        return SimpleNamespace(
            id=token,
            userId='user-1',
            teamId='team-1',
            token=token,
            source='s',
            project_id='p',
            run_kind='dev',
            # Real controls always expose owner_id (dev run -> the user).
            owner_id='user-1',
            provider='node-x',
            task=SimpleNamespace(
                get_status=lambda: SimpleNamespace(
                    name='task.s',
                    startTime=900.0,
                    endTime=0,
                    completed=False,
                    state=3,
                    totalCount=0,
                    completedCount=0,
                    rateCount=0,
                    rateSize=0,
                    metrics=None,
                ),
                get_connection_count=lambda: 0,
                _idle_time=0,
                _ttl=600,
            ),
            launch_type=SimpleNamespace(value='LAUNCH'),
        )

    server = MagicMock()
    server._task_control = {
        'tk_my-only-task': _make_control('tk_my-only-task'),
        'tk_other-task': _make_control('tk_other-task'),
    }
    server._connections = {}
    server._server = SimpleNamespace(_startTime=900.0)

    conn = _make_conn(account_info=caller_account, server=server)
    result = await MiscCommands.on_rrext_dashboard(conn, {})

    body = result['body']
    assert len(body['tasks']) == 1
    assert body['tasks'][0]['id'] == 'tk_my-only-task'


@pytest.mark.asyncio
async def test_on_rrext_dashboard_requires_monitor_permission():
    """If verify_permission raises, the error is logged and re-raised."""
    conn = _make_conn()
    conn.verify_permission = MagicMock(side_effect=PermissionError('no monitor'))
    with pytest.raises(PermissionError, match='no monitor'):
        await MiscCommands.on_rrext_dashboard(conn, {})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# rrext_list_connections / rrext_list_tasks — paginated list commands
# ---------------------------------------------------------------------------


def _caller_account(auth='ak_caller'):
    """Standard caller: user-1, member of team-1 with task.monitor."""
    return SimpleNamespace(
        userId='user-1',
        auth=auth,
        userToken='ak_caller_secret_token',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )


def _list_control(task_id, *, name=None, start=900.0, provider='node-x', team_id='team-1', completed=False):
    """Build a minimal task control whose get_status() yields a stable row."""
    status = SimpleNamespace(
        name=name or f'task.{task_id}',
        startTime=start,
        endTime=0,
        completed=completed,
        state=3,
        totalCount=0,
        completedCount=0,
        rateCount=0,
        rateSize=0,
        metrics=None,
    )
    return SimpleNamespace(
        id=task_id,
        userId='user-1',
        teamId=team_id,
        token=f'tk_{task_id}',
        source='reader',
        project_id='proj-1',
        run_kind='dev',
        provider=provider,
        task=SimpleNamespace(
            get_status=lambda: status,
            get_connection_count=lambda: 0,
            _idle_time=0,
            _ttl=600,
        ),
        launch_type=SimpleNamespace(value='LAUNCH'),
    )


def _list_ws_conn(
    user_id='user-1',
    connected_at=100.0,
    authenticated=True,
    display_name='User One',
    email='user1@example.com',
    organization=None,
):
    """Build a minimal WebSocket-connection stand-in owned by user_id."""
    return SimpleNamespace(
        # Account shape mirrors the AccountInfo fields the row builder reads:
        # userId, displayName, email, and the OrgInfo dict (None = no org).
        _account_info=SimpleNamespace(
            userId=user_id,
            displayName=display_name,
            email=email,
            organization=organization,
        ),
        _connected_at=connected_at,
        _last_activity=connected_at + 1.0,
        _messages_in=1,
        _messages_out=2,
        _authenticated=authenticated,
        _client_info={'name': 'client'},
        _monitors={},
    )


def _make_server(controls=(), connections=None):
    """Build a server stand-in seeded with task controls and connections."""
    server = MagicMock()
    server._task_control = {c.token: c for c in controls}
    server._connections = connections or {}
    server._server = SimpleNamespace(_startTime=900.0)
    return server


@pytest.mark.asyncio
async def test_list_tasks_paging_math(monkeypatch):
    """page/page_size slice the startTime-ascending default order correctly."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Five tasks created at 901..905: default sort is startTime asc.
    controls = [_list_control(f'task-{i}', start=900.0 + i) for i in range(1, 6)]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {'page': 2, 'page_size': 2}})

    body = result['body']
    # Envelope math: 5 rows total, page 2 of size 2 holds rows 3 and 4.
    assert body['total'] == 5
    assert body['page'] == 2
    assert body['pageSize'] == 2
    assert [row['id'] for row in body['rows']] == ['task-3', 'task-4']


@pytest.mark.asyncio
async def test_list_tasks_sort_by_name_desc(monkeypatch):
    """An explicit sorter overrides the default startTime ascending order."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', name='alpha', start=903.0),
        _list_control('task-2', name='bravo', start=902.0),
        _list_control('task-3', name='charlie', start=901.0),
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    request = {'arguments': {'sort': [{'field': 'name', 'dir': 'desc'}]}}
    result = await MiscCommands.on_rrext_list_tasks(conn, request)

    assert [row['name'] for row in result['body']['rows']] == ['charlie', 'bravo', 'alpha']


@pytest.mark.asyncio
async def test_list_tasks_filter_by_provider(monkeypatch):
    """A string filter narrows rows by case-insensitive contains, and the
    filtered total reflects the narrowed set (not the page).
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', provider='node-x'),
        _list_control('task-2', provider='node-y'),
        _list_control('task-3', provider='node-y'),
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {'filters': {'provider': 'node-y'}}})

    body = result['body']
    assert body['total'] == 2
    assert {row['id'] for row in body['rows']} == {'task-2', 'task-3'}


@pytest.mark.asyncio
async def test_list_tasks_search_matches_name(monkeypatch):
    """The free-text search matches across the name-ish keys (here: name)."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', name='pipeline.alpha'),
        _list_control('task-2', name='pipeline.bravo'),
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {'search': 'ALPHA'}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 'task-1'


@pytest.mark.asyncio
async def test_list_tasks_scopes_to_caller_permissions(monkeypatch):
    """Tasks in teams the caller cannot monitor never enter the row set."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', team_id='team-1'),
        _list_control('task-2', team_id='team-other'),  # invisible to caller
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 'task-1'


@pytest.mark.asyncio
async def test_list_tasks_tk_auth_locks_to_owning_task(monkeypatch):
    """Task-token (tk_*) auth narrows the list to just the owning task."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [_list_control('task-1'), _list_control('task-2')]
    conn = _make_conn(account_info=_caller_account(auth='tk_task-2'), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 'task-2'


@pytest.mark.asyncio
async def test_list_tasks_requires_monitor_permission():
    """If verify_permission raises, the error is logged and re-raised."""
    conn = _make_conn()
    conn.verify_permission = MagicMock(side_effect=PermissionError('no monitor'))
    with pytest.raises(PermissionError, match='no monitor'):
        await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_list_connections_paging_and_default_sort(monkeypatch):
    """Default order is connectedAt ascending (registration order); the
    page slice and envelope math follow the convention.
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Seed newest-first to prove the sort (not dict order) drives the rows.
    connections = {
        3: _list_ws_conn(connected_at=300.0),
        1: _list_ws_conn(connected_at=100.0),
        2: _list_ws_conn(connected_at=200.0),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {'page': 1, 'page_size': 2}})

    body = result['body']
    assert body['total'] == 3
    assert body['page'] == 1
    assert body['pageSize'] == 2
    assert [row['id'] for row in body['rows']] == [1, 2]


@pytest.mark.asyncio
async def test_list_connections_scoped_to_caller_user(monkeypatch):
    """Connections owned by other users never enter the row set."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    connections = {
        1: _list_ws_conn(user_id='user-1'),
        2: _list_ws_conn(user_id='someone-else'),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 1
    assert body['rows'][0]['clientId'] == 'user-1'


@pytest.mark.asyncio
async def test_list_connections_filter_authenticated(monkeypatch):
    """A boolean row value filters by coerced equality ('true'/'false')."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    connections = {
        1: _list_ws_conn(connected_at=100.0, authenticated=True),
        2: _list_ws_conn(connected_at=200.0, authenticated=False),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    request = {'arguments': {'filters': {'authenticated': 'false'}}}
    result = await MiscCommands.on_rrext_list_connections(conn, request)

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 2


@pytest.mark.asyncio
async def test_list_connections_search_client_id(monkeypatch):
    """The free-text search matches the clientId key case-insensitively."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Both rows belong to the caller; the search narrows within them.
    connections = {
        1: _list_ws_conn(connected_at=100.0),
        2: _list_ws_conn(connected_at=200.0),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {'search': 'USER-1'}})

    # clientId is 'user-1' on both rows, so both match the search term.
    assert result['body']['total'] == 2


@pytest.mark.asyncio
async def test_list_connections_rows_carry_user_and_org_identity(monkeypatch):
    """Rows resolve userId/userName/orgId/orgName server-side from the
    connection's AccountInfo — userName prefers displayName, org keys come
    from the OrgInfo dict.
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    org = {'id': 'org-1', 'name': 'Acme Corp', 'permissions': [], 'teams': []}
    connections = {1: _list_ws_conn(display_name='User One', email='user1@example.com', organization=org)}
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})

    row = result['body']['rows'][0]
    assert row['userId'] == 'user-1'
    assert row['userName'] == 'User One'
    assert row['orgId'] == 'org-1'
    assert row['orgName'] == 'Acme Corp'


@pytest.mark.asyncio
async def test_list_connections_user_name_falls_back_to_email(monkeypatch):
    """An empty displayName falls back to the account email; a missing org
    membership keeps the org keys null.
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    connections = {1: _list_ws_conn(display_name='', email='user1@example.com', organization=None)}
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})

    row = result['body']['rows'][0]
    assert row['userName'] == 'user1@example.com'
    assert row['orgId'] is None
    assert row['orgName'] is None


@pytest.mark.asyncio
async def test_list_connections_search_matches_user_name(monkeypatch):
    """The free-text search matches the resolved userName identity key."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Both rows belong to the caller; only one display name matches the term.
    connections = {
        1: _list_ws_conn(connected_at=100.0, display_name='Ada Lovelace'),
        2: _list_ws_conn(connected_at=200.0, display_name='Grace Hopper'),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {'search': 'lovelace'}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 1


def test_build_connection_rows_identity_null_when_unauthenticated():
    """A connection with no account info carries all-null identity keys, and
    empty displayName + email resolve userName to None (not '').
    """
    conn = _make_conn()

    # One connection that never authenticated, one whose account carries no
    # usable name fields — the builder is called directly because the list
    # command's caller scoping only admits authenticated connections.
    anon = SimpleNamespace(
        _connected_at=100.0,
        _last_activity=101.0,
        _messages_in=0,
        _messages_out=0,
        _authenticated=False,
        _client_info={},
        _monitors={},
    )
    nameless = _list_ws_conn(display_name='', email='')

    rows = MiscCommands._build_connection_rows(conn, [], [(7, anon), (8, nameless)], 1000.0)

    # Unauthenticated: every identity key is null.
    assert rows[0]['userId'] is None
    assert rows[0]['userName'] is None
    assert rows[0]['orgId'] is None
    assert rows[0]['orgName'] is None
    # Authenticated but nameless: userId resolves, userName stays null.
    assert rows[1]['userId'] == 'user-1'
    assert rows[1]['userName'] is None


@pytest.mark.asyncio
async def test_list_connections_requires_monitor_permission():
    """If verify_permission raises, the error is logged and re-raised."""
    conn = _make_conn()
    conn.verify_permission = MagicMock(side_effect=PermissionError('no monitor'))
    with pytest.raises(PermissionError, match='no monitor'):
        await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# Constructor (no-op)
# ---------------------------------------------------------------------------


def test_misc_commands_init_is_noop():
    """The mixin's __init__ accepts the standard arguments without setting state."""
    instance = MiscCommands.__new__(MiscCommands)
    MiscCommands.__init__(instance, connection_id=1, server=None, transport=None)
