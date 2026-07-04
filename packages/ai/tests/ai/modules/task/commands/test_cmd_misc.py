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


def test_resolve_monitor_label_project_wildcard():
    """A 'p.<id>.*' key uses the project label + '.*' suffix."""
    project_names = {'proj-1': 'my-project'}
    assert MiscCommands._resolve_monitor_label('p.proj-1.*', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_project_only():
    """A bare 'p.<id>' key (no source) yields '<project>.*'."""
    project_names = {'proj-1': 'my-project'}
    assert MiscCommands._resolve_monitor_label('p.proj-1', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_with_source():
    """A 'p.<id>.<source>' key uses both the project and source friendly names."""
    project_names = {'proj-1': 'my-project'}
    source_names = {'proj-1.src-1': 'reader'}
    result = MiscCommands._resolve_monitor_label('p.proj-1.src-1', project_names, source_names)
    assert result == 'my-project.reader'


def test_resolve_monitor_label_with_pipe_suffix():
    """A 4-part 'p.<id>.<source>.<pipe>' key appends a 'pipe<n>' suffix."""
    result = MiscCommands._resolve_monitor_label('p.proj-1.src-1.42', {}, {})
    assert result == 'proj-1.src-1.pipe42'


def test_resolve_monitor_label_truncates_project_id_when_no_friendly_name():
    """Unknown project ids are truncated to 8 characters."""
    result = MiscCommands._resolve_monitor_label('p.proj-very-long-id-here.*', {}, {})
    assert result.startswith('proj-ver')


# ---------------------------------------------------------------------------
# _build_monitors_list
# ---------------------------------------------------------------------------


def test_build_monitors_list_resolves_keys_and_flag_names():
    """Each (key, flags) pair becomes a {key: label, flags: names} dict."""
    from rocketride import EVENT_TYPE

    monitors = {
        'p.proj-1.src-1': EVENT_TYPE.SUMMARY,
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
    """When `arguments.service` is set, return that single definition."""
    schema = {'name': 'ocr', 'fields': []}
    monkeypatch.setattr(cmd_misc, 'getServiceDefinition', lambda name: schema if name == 'ocr' else None)

    conn = _make_conn()
    result = await MiscCommands.on_rrext_services(conn, {'arguments': {'service': 'ocr'}})

    assert result == {'type': 'response', 'body': schema}


@pytest.mark.asyncio
async def test_on_rrext_services_unknown_service_raises(monkeypatch):
    """An unknown service id raises ValueError (re-raised after debug log)."""
    monkeypatch.setattr(cmd_misc, 'getServiceDefinition', lambda name: None)

    conn = _make_conn()
    with pytest.raises(ValueError, match="Service 'unknown' not found"):
        await MiscCommands.on_rrext_services(conn, {'arguments': {'service': 'unknown'}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_on_rrext_services_no_service_returns_all(monkeypatch):
    """Without a `service` arg, getServiceDefinitions() is returned."""
    all_schemas = [{'name': 'a'}, {'name': 'b'}]
    monkeypatch.setattr(cmd_misc, 'getServiceDefinitions', lambda: all_schemas)

    conn = _make_conn()
    result = await MiscCommands.on_rrext_services(conn, {})
    assert result['body'] == all_schemas


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
# Constructor (no-op)
# ---------------------------------------------------------------------------


def test_misc_commands_init_is_noop():
    """The mixin's __init__ accepts the standard arguments without setting state."""
    instance = MiscCommands.__new__(MiscCommands)
    MiscCommands.__init__(instance, connection_id=1, server=None, transport=None)
