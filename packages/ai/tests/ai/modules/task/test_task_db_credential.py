# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
The credential that started (or restarted) a run reaches ``authorize_db_target``.

A run's cloud databases are authorized in-process, in the request of the
connection that supplied the pipeline. The account layer can only narrow the
decision to what that connection's credential may reach if the engine hands the
credential down, so ``TaskServer.start_task`` and ``TaskServer.restart_task``
pass ``conn._account_info.auth`` to ``Task.start_task(credential=...)``, which
passes it to ``account.authorize_db_target(..., credential=...)``.

Pinned here:

- the credential reaches ``authorize_db_target`` on a start and on a restart,
  and a restart uses the RESTARTER's, not the original starter's;
- it is a call argument only: not on the Task or the control, not in the task
  file, not in the subprocess environment, not in the 8-key identity, not in
  any log line;
- no account info on the connection passes ``None``; the trusted deploy
  dispatch passes ``''``;
- an account implementation that predates the keyword is still called.

Every log hook is replaced by a recorder that, like rocketlib's pybind
``debug``/``warning``, takes positional arguments only: a keyword argument
raises ``TypeError`` in production and must raise here too.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.account
import ai.modules.task.task_engine as engine
import ai.modules.task.task_server as task_server_module
from ai.account.base import DbDecision
from ai.account.models import AccountInfo
from ai.modules.task.task_engine import Task
from ai.modules.task.task_server import TASK_CONTROL, TaskServer
from ai.modules.task.types import TaskError
from ai.modules.task.task_server_facade import start_server_task_as_team

SECRET = 'rr_CREDENTIAL_990_must_never_be_kept'
OTHER_SECRET = 'rr_RESTARTER_990_must_never_be_kept'

# The identity keys the account layer is promised (SDD 4.4). A credential is not one.
IDENTITY_KEYS = {
    'org_id',
    'user_id',
    'team_id',
    'run_kind',
    'owner_kind',
    'public_endpoint',
    'path',
    'task_id',
}

# Org-scope DB node: authorized once, no ${...} to expand.
DB_PIPELINE = {
    'project_id': 'proj-990',
    'source': 'src',
    'components': [
        {'id': 'src', 'provider': 'webhook', 'config': {}},
        {'id': 'db', 'provider': 'rocketride_sql', 'config': {'scope': 'team', 'target': 'team-2'}},
    ],
}


# What the recorder sees when the engine did not pass ``credential=`` at all, so
# "not passed" is distinguishable from "passed None".
NOT_PASSED = object()


class _Launched(Exception):
    """Raised in place of the subprocess launch: everything before it ran for real."""


# =============================================================================
# Harness
# =============================================================================


def _positional_only_log(sink):
    """A log hook that, like rocketlib's pybind ``py::args``, refuses keywords."""

    def log(*args):
        sink.append(' '.join(str(a) for a in args))

    return log


@pytest.fixture
def logs(monkeypatch):
    """Every line any engine log hook receives during the test."""
    lines: list[str] = []
    hook = _positional_only_log(lines)
    monkeypatch.setattr(engine, 'debug', hook)
    monkeypatch.setattr(engine, 'warning', hook)
    monkeypatch.setattr(task_server_module, 'debug', hook)
    return lines


@pytest.fixture
def account(monkeypatch):
    """Recorder in place of the account's authorize/resolve.

    ``calls['authorize']`` holds ``(identity copy, target, credential)``.
    """
    calls = {'authorize': [], 'resolve': []}

    async def authorize(identity, target=None, *, credential=NOT_PASSED):
        calls['authorize'].append((dict(identity), dict(target or {}), credential))
        target = target or {}
        return DbDecision(True, 'ok', False, target.get('team_id') or target.get('user_id') or '')

    async def resolve(client_id, scope='org', owner_id=''):
        calls['resolve'].append((client_id, scope, owner_id))
        return f'postgresql://{scope}-{owner_id or client_id}@pooler/db'

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize)
    monkeypatch.setattr(ai.account.account, 'resolve_db_dsn', resolve)
    return calls


def _server(logs):
    """A TaskServer with ``__init__`` bypassed (no loop, no ports)."""
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._store_instance = None
    ts._config = {}
    ts._server = MagicMock()
    ts._server.account.generate_token = MagicMock(side_effect=lambda content, prefix: f'{prefix}abcdefgh12345678')
    ts.debug_message = lambda msg: logs.append(str(msg))
    return ts


def _conn(auth=SECRET, user_id='user-1', team_id='team-1'):
    """A connection with a REAL AccountInfo that may control user-1's runs."""
    conn = SimpleNamespace()
    conn._account_info = AccountInfo(
        auth=auth,
        userId=user_id,
        devTeam=team_id,
        organization={
            'id': 'org-1',
            'name': '',
            'permissions': [],
            'teams': [
                {'id': team_id, 'name': '', 'permissions': ['task.control', 'task.monitor', 'task.data', 'task.store']}
            ],
        },
    )
    return conn


def _request(pipeline=None):
    return {'command': 'execute', 'arguments': {'pipeline': json.loads(json.dumps(pipeline or DB_PIPELINE))}}


class _Launch:
    """Stands in for ``asyncio.create_subprocess_exec`` and records what it was given.

    The task file is read at launch, while it exists, so the test can search
    what the run persisted.
    """

    def __init__(self):
        self.calls = []

    async def __call__(self, exec_path, *child_args, env=None, **_kwargs):
        task_file = child_args[1]
        with open(task_file, encoding='utf-8') as handle:
            self.calls.append({'argv': [exec_path, *child_args], 'env': dict(env or {}), 'task_file': handle.read()})
        raise _Launched


@pytest.fixture
def launch(monkeypatch):
    launcher = _Launch()
    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', launcher)
    return launcher


def _leaks(needle, value, *, skip=(), _seen=None, _depth=0):
    """Paths under ``value`` whose content holds ``needle`` (containers and ai.* objects).

    ``skip`` names attributes not followed: ``_server`` is the shared TaskServer, which
    holds every live connection and so every connection's own ``auth`` by design.
    """
    seen = _seen if _seen is not None else set()
    if id(value) in seen or _depth > 8:
        return []
    seen.add(id(value))
    if isinstance(value, (str, bytes)):
        text = value if isinstance(value, str) else value.decode('utf-8', 'replace')
        return ['<value>'] if needle in text else []
    found = []
    if isinstance(value, dict):
        items = [(f'[{k!r}]', k) for k in value] + [(f'[{k!r}]', v) for k, v in value.items()]
    elif isinstance(value, (list, tuple, set, frozenset)):
        items = [(f'[{i}]', v) for i, v in enumerate(value)]
    elif type(value).__module__.startswith(('ai.', 'tests.')) or isinstance(value, SimpleNamespace):
        items = [(f'.{k}', v) for k, v in getattr(value, '__dict__', {}).items() if k not in skip]
    else:
        return []
    for where, child in items:
        found += [f'{where}{rest}' for rest in _leaks(needle, child, skip=skip, _seen=seen, _depth=_depth + 1)]
    return found


def _register_control(ts, owner_conn, pipeline=None):
    """A registered run built exactly as ``TaskServer.start_task`` builds one, not started."""
    control = TASK_CONTROL()
    control.client_id = 'user-1'
    control.userId = 'user-1'
    control.teamId = 'team-1'
    control.orgId = 'org-1'
    control.run_kind = 'dev'
    control.owner_kind = 'user'
    control.token = 'tk_abcdefgh12345678'
    control.public_auth = 'pk_abcdefgh12345678'
    control.pipeline = json.loads(json.dumps(pipeline or DB_PIPELINE))
    control.source = 'src'
    control.provider = 'webhook'
    control.project_id = 'proj-990'
    control.id = 'abcdefgh.src'
    control.launch_owner = owner_conn
    control.task = Task(
        server=ts,
        id=control.id,
        project_id=control.project_id,
        source=control.source,
        token=control.token,
        public_auth=control.public_auth,
        pipeline=control.pipeline,
        launch_args={},
        launch_type=control.launch_type,
        provider=control.provider,
        ttl=0,
        client_id=control.client_id,
        team_id=control.teamId,
        org_id=control.orgId,
        env={},
        env_source=None,
        run_kind='dev',
        owner_kind='user',
        trigger='',
    )
    # The old process is gone and its stop is not what is under test.
    control.task.stop_task = AsyncMock()
    control.task.is_task_complete = lambda: True
    ts._task_control[control.token] = control
    return control


# =============================================================================
# The credential reaches the account layer
# =============================================================================


@pytest.mark.asyncio
async def test_start_passes_the_starting_connections_credential(logs, account, launch):
    ts = _server(logs)

    with pytest.raises(_Launched):
        await ts.start_task(
            _request(), _conn(SECRET), client_id='user-1', user_id='user-1', team_id='team-1', org_id='org-1'
        )

    assert [(target, credential) for _, target, credential in account['authorize']] == [
        ({'scope': 'team', 'team_id': 'team-2'}, SECRET)
    ]
    assert set(account['authorize'][0][0]) == IDENTITY_KEYS


@pytest.mark.asyncio
async def test_restart_authorizes_with_the_restarters_credential_not_the_starters(logs, account, launch):
    ts = _server(logs)
    control = _register_control(ts, owner_conn=_conn(SECRET))

    with pytest.raises(RuntimeError, match='restart'):
        await ts.restart_task(
            {'arguments': {'token': control.token, 'pipeline': json.loads(json.dumps(DB_PIPELINE))}},
            _conn(OTHER_SECRET),
        )

    assert [credential for _, _, credential in account['authorize']] == [OTHER_SECRET]


@pytest.mark.asyncio
async def test_restart_over_a_task_key_passes_the_task_key(logs, account, launch):
    """A ``tk_`` stand-in identity restarts its own run; its key is what is passed."""
    ts = _server(logs)
    control = _register_control(ts, owner_conn=_conn(SECRET))
    task_key_conn = _conn(control.token)

    with pytest.raises(RuntimeError, match='restart'):
        await ts.restart_task(
            {'arguments': {'token': control.token, 'pipeline': json.loads(json.dumps(DB_PIPELINE))}}, task_key_conn
        )

    assert [credential for _, _, credential in account['authorize']] == [control.token]


@pytest.mark.asyncio
async def test_a_connection_without_account_info_passes_none(logs, account, launch):
    ts = _server(logs)

    with pytest.raises(_Launched):
        await ts.start_task(_request(), SimpleNamespace(), client_id='user-1', user_id='user-1', team_id='team-1')

    assert [credential for _, _, credential in account['authorize']] == [None]


@pytest.mark.asyncio
async def test_no_connection_at_all_passes_none(logs, account, launch):
    ts = _server(logs)

    with pytest.raises(_Launched):
        await ts.start_task(_request(), None, client_id='user-1', user_id='user-1', team_id='team-1')

    assert [credential for _, _, credential in account['authorize']] == [None]


@pytest.mark.asyncio
async def test_deploy_dispatch_passes_an_empty_credential(logs, account, launch, monkeypatch):
    """The trusted in-process dispatch holds no credential: ``''``, not None, and no special case."""
    ts = _server(logs)
    ts._next_connection_id = lambda: 1
    from ai.modules.task.commands.cmd_task import TaskCommands

    monkeypatch.setattr(TaskCommands, 'verify_plans', lambda self, info, pipeline: None, raising=False)
    monkeypatch.setattr(TaskCommands, 'resolve_org_for_team', AsyncMock(return_value='org-1'), raising=False)

    with pytest.raises(RuntimeError, match='execute failed'):
        await start_server_task_as_team(ts, json.loads(json.dumps(DB_PIPELINE)), org_id='org-1', team_id='team-1')

    assert [credential for _, _, credential in account['authorize']] == ['']
    identity = account['authorize'][0][0]
    assert identity['run_kind'] == 'deploy'
    assert set(identity) == IDENTITY_KEYS


# =============================================================================
# The credential is never kept
# =============================================================================


@pytest.mark.asyncio
async def test_the_credential_is_not_kept_anywhere(logs, account, launch, capsys, caplog):
    ts = _server(logs)

    with pytest.raises(_Launched):
        await ts.start_task(
            _request(), _conn(SECRET), client_id='user-1', user_id='user-1', team_id='team-1', org_id='org-1'
        )

    (launched,) = launch.calls
    identity, _, presented = account['authorize'][0]
    # The credential was in play, so its absence below is not vacuous.
    assert presented == SECRET

    assert SECRET not in json.dumps(identity)
    assert set(identity) == IDENTITY_KEYS
    # What the run persisted: the task file, and the subprocess environment.
    assert SECRET not in launched['task_file']
    assert _leaks(SECRET, launched['env']) == []
    assert _leaks(SECRET, launched['argv']) == []
    # Every line logged on the way, by any hook, and anything printed.
    assert logs, 'the run logged nothing, so the log assertion proves nothing'
    assert not [line for line in logs if SECRET in line]
    out, err = capsys.readouterr()
    assert SECRET not in out + err + caplog.text


@pytest.mark.asyncio
async def test_the_credential_is_not_on_the_task_or_its_control(logs, account, launch):
    """A run that starts and stays registered keeps no copy: checked on the live Task and control."""
    ts = _server(logs)
    control = _register_control(ts, owner_conn=_conn(SECRET))

    with pytest.raises(RuntimeError):
        await ts.restart_task(
            {'arguments': {'token': control.token, 'pipeline': json.loads(json.dumps(DB_PIPELINE))}}, _conn(SECRET)
        )

    assert [credential for _, _, credential in account['authorize']] == [SECRET]
    assert _leaks(SECRET, control.task, skip=('_server',)) == []
    # launch_owner is the connection itself, which holds its own auth by design.
    assert _leaks(SECRET, {k: v for k, v in vars(control).items() if k != 'launch_owner'}, skip=('_server',)) == []
    assert not [line for line in logs if SECRET in line]


@pytest.mark.asyncio
async def test_a_denied_start_does_not_log_the_credential(logs, account, launch, monkeypatch):
    ts = _server(logs)

    presented = []

    async def deny(identity, target=None, *, credential=NOT_PASSED):
        presented.append(credential)
        return DbDecision(False, 'key_scope_not_team_admin', True)

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', deny)

    with pytest.raises(PermissionError, match='key_scope_not_team_admin') as denied:
        await ts.start_task(
            _request(), _conn(SECRET), client_id='user-1', user_id='user-1', team_id='team-1', org_id='org-1'
        )

    assert presented == [SECRET]
    assert SECRET not in str(denied.value)
    assert launch.calls == []
    assert not [line for line in logs if SECRET in line]


# =============================================================================
# Account implementations
# =============================================================================


@pytest.mark.asyncio
async def test_an_account_that_predates_the_keyword_is_still_called(logs, launch, monkeypatch):
    """New engine, old account: the two-argument call it always had, and a warning that names no credential."""
    seen = []

    async def old_authorize(identity, target=None):
        seen.append((dict(identity), target))
        return DbDecision(True, 'ok', False, (target or {}).get('team_id', ''))

    async def resolve(client_id, scope='org', owner_id=''):
        return 'postgresql://x@pooler/db'

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', old_authorize)
    monkeypatch.setattr(ai.account.account, 'resolve_db_dsn', resolve)
    ts = _server(logs)

    with pytest.raises(_Launched):
        await ts.start_task(
            _request(), _conn(SECRET), client_id='user-1', user_id='user-1', team_id='team-1', org_id='org-1'
        )

    assert [target for _, target in seen] == [{'scope': 'team', 'team_id': 'team-2'}]
    warned = [line for line in logs if 'predates credential-aware' in line]
    assert len(warned) == 1
    assert not [line for line in logs if SECRET in line]


@pytest.mark.parametrize(
    ('authorize', 'accepts'),
    [
        (lambda identity, target=None: None, False),
        (lambda identity, target=None, *, credential=None: None, True),
        (lambda identity, target=None, credential=None: None, True),
        (lambda identity, target=None, **kwargs: None, True),
        (lambda identity, target=None, *args: None, False),
        (MagicMock(), True),
    ],
)
def test_accepts_credential_reads_the_signature(authorize, accepts):
    assert engine._accepts_credential(authorize) is accepts


# =============================================================================
# Deploy runs
# =============================================================================


@pytest.mark.asyncio
async def test_deploy_run_is_unaffected_by_the_credential_plumbing(logs, account, launch):
    """A deploy keeps its identity and its decisions: the same 8 keys, owner scope and run kind."""
    ts = _server(logs)
    conn = SimpleNamespace(_account_info=AccountInfo(userId='', devTeam='team-1', organization=None))

    with pytest.raises(_Launched):
        await ts.start_task(
            _request(),
            conn,
            client_id='',
            user_id='',
            team_id='team-1',
            org_id='org-1',
            run_kind='deploy',
            owner_kind='team',
        )

    identity, target, credential = account['authorize'][0]
    assert credential == ''
    assert set(identity) == IDENTITY_KEYS
    assert (identity['run_kind'], identity['owner_kind'], identity['user_id']) == ('deploy', 'team', '')
    assert identity['path'] == 'pipeline'
    assert target == {'scope': 'team', 'team_id': 'team-2'}


# =============================================================================
# useExisting: reusing a running task is authorized for the requester too
# =============================================================================

SCOPED = 'rr_scoped_ci_key_task_control_team1'
SESSION = 'rr_session_of_org_admin'

OWN_TEAM_PIPELINE = {
    'project_id': 'proj-990',
    'source': 'src',
    'components': [
        {'id': 'src', 'provider': 'webhook', 'config': {}},
        {'id': 'db', 'provider': 'rocketride_sql', 'config': {'scope': 'team', 'target': 'team-1'}},
    ],
}
NO_DB_PIPELINE = {
    'project_id': 'proj-990',
    'source': 'src',
    'components': [{'id': 'src', 'provider': 'webhook', 'config': {}}],
}


@pytest.fixture
def restricted_account(monkeypatch):
    """An account that, like the SaaS one, narrows the scoped key to its own team.

    The session key reaches every team. ``calls`` holds ``(target, credential)``.
    """
    calls = []

    async def authorize(identity, target=None, *, credential=NOT_PASSED):
        target = target or {}
        calls.append((target, credential))
        if credential == SCOPED and target.get('scope') == 'team' and target.get('team_id') != 'team-1':
            return DbDecision(False, 'key_scope_not_team_admin', True)
        return DbDecision(True, 'ok', False, target.get('team_id') or target.get('user_id') or '')

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize)
    return calls


def _live_run(ts, pipeline=None):
    """The admin's running dev run, started with the session key: its DB targets are read as a start reads them."""
    control = _register_control(ts, owner_conn=_conn(SESSION), pipeline=pipeline)
    control.task.is_task_complete = lambda: False
    control.task._db_seen = control.task._db_access(control.task._pipeline)
    return control


def _reuse(ts, control, conn, **kwargs):
    request = _request()
    request['arguments'].update({'useExisting': True, 'token': control.token})
    return ts.start_task(
        request, conn, client_id='user-1', user_id='user-1', team_id='team-1', org_id='org-1', **kwargs
    )


@pytest.mark.asyncio
async def test_use_existing_attaches_only_after_authorizing_the_requesters_credential(logs, account):
    """The reviewer's counterexample, inverted.

    Before, a scoped key attached to the admin's run and no DB decision was made
    for it. Now its credential is asked about the run's databases.
    """
    ts = _server(logs)
    control = _live_run(ts)

    result = await _reuse(ts, control, _conn(SCOPED))

    assert result['reused'] is True and result['token'] == control.token
    assert account['authorize'] != []  # a DB decision was made for the scoped key
    assert [(target, credential) for _, target, credential in account['authorize']] == [
        ({'scope': 'team', 'team_id': 'team-2'}, SCOPED)
    ]
    # asked under the RUN's identity, still exactly the 8 keys
    assert set(account['authorize'][0][0]) == IDENTITY_KEYS
    assert account['authorize'][0][0]['task_id'] == control.id


@pytest.mark.asyncio
async def test_a_restricted_key_cannot_reuse_a_run_holding_another_teams_database(logs, restricted_account):
    ts = _server(logs)
    control = _live_run(ts)  # holds team-2's database

    with pytest.raises(PermissionError, match='key_scope_not_team_admin') as refused:
        await _reuse(ts, control, _conn(SCOPED))

    assert 'Cannot reuse the running task' in str(refused.value)
    assert SCOPED not in str(refused.value)
    assert not [line for line in logs if SCOPED in line]
    # the owner's run is untouched
    assert ts._task_control[control.token] is control


@pytest.mark.asyncio
async def test_a_restricted_key_reuses_a_run_whose_databases_it_may_reach(logs, restricted_account):
    ts = _server(logs)
    control = _live_run(ts, OWN_TEAM_PIPELINE)

    result = await _reuse(ts, control, _conn(SCOPED))

    assert result['reused'] is True
    assert restricted_account == [({'scope': 'team', 'team_id': 'team-1'}, SCOPED)]


@pytest.mark.asyncio
async def test_a_session_key_reuses_as_before(logs, restricted_account):
    ts = _server(logs)
    control = _live_run(ts)

    result = await _reuse(ts, control, _conn(SESSION))

    assert result['reused'] is True
    assert restricted_account == [({'scope': 'team', 'team_id': 'team-2'}, SESSION)]


@pytest.mark.asyncio
async def test_a_run_without_db_targets_is_reused_unchanged(logs, account):
    ts = _server(logs)
    control = _live_run(ts, NO_DB_PIPELINE)

    result = await _reuse(ts, control, _conn(SCOPED))

    assert result['reused'] is True
    assert account['authorize'] == []


@pytest.mark.asyncio
async def test_an_account_that_predates_the_keyword_reuses_as_before(logs, monkeypatch):
    """Old account: it cannot tell callers apart, so it is not asked, and the reuse is today's."""
    seen = []

    async def old_authorize(identity, target=None):
        seen.append(target)
        return DbDecision(False, 'would_deny', True)

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', old_authorize)
    ts = _server(logs)
    control = _live_run(ts)

    result = await _reuse(ts, control, _conn(SCOPED))

    assert result['reused'] is True
    assert seen == []


@pytest.mark.asyncio
async def test_a_connection_without_account_info_reuses_with_none(logs, account):
    """None reaches the account, which decides what a missing credential means (SaaS: today's behaviour first)."""
    ts = _server(logs)
    control = _live_run(ts)

    result = await _reuse(ts, control, SimpleNamespace())

    assert result['reused'] is True
    assert [credential for _, _, credential in account['authorize']] == [None]


def _starting_run(ts):
    """A registered run whose start has not yet read its databases (``_db_seen`` is None)."""
    control = _register_control(ts, owner_conn=_conn(SESSION))
    control.task.is_task_complete = lambda: False
    assert control.task._db_seen is None
    return control


@pytest.mark.asyncio
async def test_concurrent_reuse_during_start_waits_for_the_databases_then_reuses(logs, account):
    """A second connection resolving the same run while it starts waits for the start, as it always did."""
    ts = _server(logs)
    control = _starting_run(ts)

    reuse = asyncio.ensure_future(_reuse(ts, control, _conn(SESSION)))
    await asyncio.sleep(0.05)
    assert not reuse.done()  # waiting, not refused
    control.task._db_seen = control.task._db_access(control.task._pipeline)  # the start reads its databases
    result = await asyncio.wait_for(reuse, 2)

    assert result['reused'] is True
    assert [(target, credential) for _, target, credential in account['authorize']] == [
        ({'scope': 'team', 'team_id': 'team-2'}, SESSION)
    ]


@pytest.mark.asyncio
async def test_a_restricted_key_reusing_during_start_is_refused_once_the_databases_are_known(logs, restricted_account):
    ts = _server(logs)
    control = _starting_run(ts)

    reuse = asyncio.ensure_future(_reuse(ts, control, _conn(SCOPED)))
    await asyncio.sleep(0.05)
    assert not reuse.done()
    control.task._db_seen = ([('team', 'team-2')], False)

    with pytest.raises(PermissionError, match='key_scope_not_team_admin'):
        await asyncio.wait_for(reuse, 2)


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['COMPLETED', 'CANCELLED'])
async def test_the_wait_ends_when_the_run_ends_first(logs, account, state):
    ts = _server(logs)
    control = _starting_run(ts)

    reuse = asyncio.ensure_future(_reuse(ts, control, _conn(SESSION)))
    await asyncio.sleep(0.05)
    control.task._status.state = getattr(engine.TASK_STATE, state).value

    with pytest.raises(TaskError):
        await asyncio.wait_for(reuse, 2)
    assert account['authorize'] == []


@pytest.mark.asyncio
async def test_a_restart_in_progress_does_not_end_the_wait(logs, account):
    """A restart stops the old process (terminal state) before the new start: that is not the end of the run."""
    ts = _server(logs)
    control = _starting_run(ts)
    control.task._is_restarting = True
    control.task._status.state = engine.TASK_STATE.COMPLETED.value

    reuse = asyncio.ensure_future(_reuse(ts, control, _conn(SESSION)))
    await asyncio.sleep(0.4)  # longer than a poll
    assert not reuse.done()
    control.task._db_seen = ([('team', 'team-2')], False)

    assert (await asyncio.wait_for(reuse, 2))['reused'] is True


@pytest.mark.asyncio
async def test_the_wait_is_bounded(logs, account, monkeypatch):
    monkeypatch.setattr(engine, 'CONST_MAX_READY_TIME', 0)
    ts = _server(logs)
    control = _starting_run(ts)

    with pytest.raises(TimeoutError, match='never reported its databases'):
        await asyncio.wait_for(_reuse(ts, control, _conn(SESSION)), 2)


@pytest.mark.asyncio
async def test_a_run_that_cannot_hold_a_database_is_not_waited_for(logs, account):
    ts = _server(logs)
    plain = _register_control(ts, owner_conn=_conn(SESSION), pipeline=NO_DB_PIPELINE)
    plain.task.is_task_complete = lambda: False
    assert plain.task._db_seen is None

    assert (await asyncio.wait_for(_reuse(ts, plain, _conn(SCOPED)), 2))['reused'] is True
    assert account['authorize'] == []


@pytest.mark.asyncio
async def test_the_check_follows_the_wait_for_running(logs, restricted_account):
    """A restart that lands while the reuser waits for the run swaps in new databases: the check sees those."""
    ts = _server(logs)
    control = _live_run(ts, pipeline=NO_DB_PIPELINE)  # holds nothing when the reuse begins

    async def wait_and_restart():
        control.task._db_seen = ([('team', 'team-2')], False)

    control.task.wait_for_running = wait_and_restart

    with pytest.raises(PermissionError, match='key_scope_not_team_admin'):
        await _reuse(ts, control, _conn(SCOPED), wait_for_running=True)

    assert restricted_account == [({'scope': 'team', 'team_id': 'team-2'}, SCOPED)]


@pytest.mark.asyncio
async def test_a_start_records_its_databases_and_a_restart_clears_then_records_them(logs, account, launch):
    ts = _server(logs)
    control = _register_control(ts, owner_conn=_conn(SESSION))

    with pytest.raises(RuntimeError, match='restart'):
        await ts.restart_task(
            {'arguments': {'token': control.token, 'pipeline': json.loads(json.dumps(DB_PIPELINE))}}, _conn(SESSION)
        )

    # targets only: ids, no credential
    assert control.task._db_seen == ([('team', 'team-2')], True)  # the webhook source is public
    assert _leaks(SESSION, control.task._db_seen) == []
