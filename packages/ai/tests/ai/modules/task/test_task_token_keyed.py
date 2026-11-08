# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""A run's private token (``tk_``) cannot be computed from public inputs.

The token is an HMAC of the run's identity under an engine-only key, so knowing
the owner's id, the project id and the source no longer yields the token, and
holding a token requires having been given it. Pinned here:

- the unkeyed digest of the run's identity does not authenticate;
- the token is still stable for one identity in one process (the "already
  running" guard and the useExisting reconnect depend on it), across processes
  that share ``RR_TASK_TOKEN_KEY``, and differs across different keys;
- without ``RR_TASK_TOKEN_KEY`` (unset or empty) each process uses its own
  random key, and logs that as a warning;
- a configured key that is too short refuses to mint;
- ``pk_`` share links are byte-identical to every link ever minted, and a
  ``pk_`` reaches only a run whose source is a public endpoint;
- a supplied token cannot reuse, or replace, another owner's run, and a
  supplied ``tk_`` must be as strong as a minted one;
- the key never reaches a task subprocess and is checked at startup.

Every log hook is a recorder that, like rocketlib's pybind ``debug``, takes
positional arguments only.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.modules.task.task_server as task_server_module
from ai.account.base import AccountBase
from ai.account.models import AccountInfo, resolve_run_permissions
from ai.modules.task.task_engine import Task, filter_subprocess_env
from ai.modules.task.task_server import TASK_CONTROL, TaskServer
from ai.modules.task.types import TaskError

KEY_A = 'A' * 43
KEY_B = 'B' * 43

PIPELINE = {
    'project_id': 'proj-tk',
    'source': 'src',
    'components': [{'id': 'src', 'provider': 'webhook', 'config': {}}],
}

# A run whose source is not a public endpoint: nothing is meant to reach it by pk_.
PRIVATE_PIPELINE = {
    'project_id': 'proj-tk',
    'source': 'src',
    'components': [{'id': 'src', 'provider': 'filesys', 'config': {}}],
}

CHAT_PIPELINE = {
    'project_id': 'proj-tk',
    'source': 'src',
    'components': [{'id': 'src', 'provider': 'chat', 'config': {}}],
}


def _unkeyed(content: dict, prefix: str) -> str:
    """The historical, unkeyed derivation: what anyone can compute."""
    return prefix + hashlib.sha256(json.dumps(content, sort_keys=True).encode('utf-8')).hexdigest()[:32]


def _positional_only_log(sink):
    def log(*args):
        sink.append(' '.join(str(a) for a in args))

    return log


@pytest.fixture
def logs(monkeypatch):
    lines: list[str] = []
    monkeypatch.setattr(task_server_module, 'debug', _positional_only_log(lines))
    return lines


@pytest.fixture
def warned(monkeypatch):
    lines: list[str] = []
    monkeypatch.setattr(task_server_module, 'warning', _positional_only_log(lines))
    return lines


@pytest.fixture
def no_launch(monkeypatch):
    """The run is "up": the subprocess launch is not under test."""

    async def _start(self, *args, **kwargs):
        return None

    monkeypatch.setattr(Task, 'start_task', _start)


def _server(logs, monkeypatch, key=None):
    """A TaskServer with ``__init__`` bypassed and the REAL account token helper."""
    if key is None:
        monkeypatch.delenv('RR_TASK_TOKEN_KEY', raising=False)
    else:
        monkeypatch.setenv('RR_TASK_TOKEN_KEY', key)
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._store_instance = None
    ts._config = {}
    ts._server = SimpleNamespace(
        account=SimpleNamespace(
            generate_token=lambda content, prefix='': AccountBase.generate_token(None, content, prefix),
        )
    )
    ts.debug_message = _positional_only_log(logs)
    ts._debug_task_started = lambda *args: None
    return ts


def _conn(user_id='user-1', team_id='team-1', auth='rr_session_key'):
    conn = SimpleNamespace()
    conn._account_info = AccountInfo(
        auth=auth,
        userId=user_id,
        devTeam=team_id,
        organization={
            'id': 'org-1',
            'name': '',
            'permissions': [],
            'teams': [{'id': team_id, 'name': '', 'permissions': ['task.control', 'task.data']}],
        },
    )
    return conn


def _request(pipeline=None, **arguments):
    pipeline = json.loads(json.dumps(pipeline or PIPELINE))
    return {'command': 'execute', 'arguments': {'pipeline': pipeline, **arguments}}


async def _start(ts, user_id='user-1', pipeline=None, **arguments):
    return await ts.start_task(
        _request(pipeline, **arguments),
        _conn(user_id=user_id),
        client_id=user_id,
        user_id=user_id,
        team_id='team-1',
        org_id='org-1',
    )


def _live_run(token, user_id='user-1', complete=False):
    """A registered dev run owned by ``user_id`` under ``token``."""
    control = TASK_CONTROL()
    control.client_id = user_id
    control.userId = user_id
    control.teamId = 'team-1'
    control.orgId = 'org-1'
    control.run_kind = 'dev'
    control.owner_kind = 'user'
    control.token = token
    control.public_auth = 'pk_owner_public'
    control.pipeline = json.loads(json.dumps(PIPELINE))
    control.source = 'src'
    control.provider = 'webhook'
    control.project_id = 'proj-tk'
    control.id = f'{token[3:11]}.src'
    control.task = SimpleNamespace(
        is_task_complete=lambda: complete,
        wait_for_running=AsyncMock(),
        stop_task=AsyncMock(),
        # The reuse path may also check the requester's credential; not under test.
        authorize_reuse=AsyncMock(),
    )
    return control


# =============================================================================
# The tk_ is no longer computable (the reviewer's bypass, inverted)
# =============================================================================


@pytest.mark.asyncio
async def test_the_unkeyed_digest_of_a_runs_identity_does_not_authenticate(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts)

    derived = _unkeyed({'kind': 'task', 'userId': 'user-1', 'project_id': 'proj-tk', 'source': 'src'}, 'tk_')
    assert started['token'] != derived
    with pytest.raises(TaskError):
        await ts.authenticate(derived)


@pytest.mark.asyncio
async def test_the_tk_is_not_derivable_without_a_configured_key_either(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key=None)
    started = await _start(ts)

    derived = _unkeyed({'kind': 'task', 'userId': 'user-1', 'project_id': 'proj-tk', 'source': 'src'}, 'tk_')
    assert started['token'] != derived
    with pytest.raises(TaskError):
        await ts.authenticate(derived)


# =============================================================================
# Stable where it must be
# =============================================================================


@pytest.mark.asyncio
async def test_the_same_identity_gets_the_same_keyed_token_in_one_process(logs, monkeypatch, no_launch):
    """The 'already running' guard and the useExisting reconnect depend on this."""
    ts = _server(logs, monkeypatch, key=None)
    first = await _start(ts)

    with pytest.raises(ValueError, match='already running'):
        await _start(ts)
    reused = await _start(ts, useExisting=True)
    assert reused['reused'] is True and reused['token'] == first['token']

    # A finished run's slot is taken over by the same identity's next launch.
    ts._task_control[first['token']].task.is_task_complete = lambda: True
    again = await _start(ts)
    assert again['token'] == first['token']
    assert first['token'] != _unkeyed(
        {'kind': 'task', 'userId': 'user-1', 'project_id': 'proj-tk', 'source': 'src'}, 'tk_'
    )


@pytest.mark.asyncio
async def test_a_shared_key_gives_the_same_token_across_restarts_and_replicas(logs, warned, monkeypatch, no_launch):
    one = await _start(_server(logs, monkeypatch, key=KEY_A))
    two = await _start(_server(logs, monkeypatch, key=KEY_A))
    other_key = await _start(_server(logs, monkeypatch, key=KEY_B))

    assert one['token'] == two['token']
    assert one['token'] != other_key['token']
    assert warned == []


@pytest.mark.asyncio
@pytest.mark.parametrize('key', [None, ''], ids=['unset', 'empty'])
async def test_without_a_key_each_process_uses_its_own(logs, warned, monkeypatch, no_launch, key):
    one = await _start(_server(logs, monkeypatch, key=key))
    two = await _start(_server(logs, monkeypatch, key=key))

    assert one['token'] != two['token']
    # A warning, once per process: on a deployed engine this fallback changes
    # everyone's tk_ tokens on every restart, so it must not hide at debug.
    assert len(warned) == 2 and all('RR_TASK_TOKEN_KEY' in line for line in warned)
    assert not any('RR_TASK_TOKEN_KEY' in line for line in logs)


@pytest.mark.asyncio
async def test_a_configured_key_that_is_too_short_refuses_to_mint(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key='too-short')

    with pytest.raises(ValueError, match='RR_TASK_TOKEN_KEY'):
        await _start(ts)
    assert ts._task_control == {}


@pytest.mark.asyncio
async def test_the_token_keeps_its_shape_and_display_id(logs, monkeypatch, no_launch):
    started = await _start(_server(logs, monkeypatch, key=KEY_A))

    token = started['token']
    assert token.startswith('tk_') and len(token) == 35
    int(token[3:], 16)
    assert started['id'] == f'{token[3:11]}.src'


def test_the_key_never_reaches_a_task_subprocess():
    """Pipeline code reads its subprocess environment; the key must not be in it."""
    env = filter_subprocess_env({'RR_TASK_TOKEN_KEY': KEY_A, 'ROCKETRIDE_X': '1', 'PATH': '/bin'})
    assert 'RR_TASK_TOKEN_KEY' not in env


# =============================================================================
# pk_ unchanged; a live keyed tk_ still authenticates
# =============================================================================


@pytest.mark.asyncio
async def test_pk_is_byte_identical_to_the_historical_digest(logs, monkeypatch, no_launch):
    started = await _start(_server(logs, monkeypatch, key=KEY_A))

    content = {'kind': 'public', 'userId': 'user-1', 'project_id': 'proj-tk', 'source': 'src'}
    assert started['publicToken'] == _unkeyed(content, 'pk_')
    # Pinned literal: the value every persisted share link for this identity carries.
    assert started['publicToken'] == 'pk_a6dd3bc33069e9cdc58cd5e2fd2093cc'


@pytest.mark.asyncio
async def test_a_live_keyed_tk_authenticates_with_full_task_permissions(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts)

    info = await ts.authenticate(started['token'])
    perms = info.organization['teams'][0]['permissions']
    assert {'task.control', 'task.data', 'task.monitor', 'task.debug', 'task.store'} <= set(perms)
    assert info.userId == 'user-1'

    public = await ts.authenticate(started['publicToken'])
    assert public.organization['teams'][0]['permissions'] == ['task.data']


# =============================================================================
# A supplied token is bound to the run's owner (the reviewer's reuse, inverted)
# =============================================================================


@pytest.mark.asyncio
async def test_another_users_session_cannot_reuse_a_run_by_supplying_its_token(logs, monkeypatch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    control = _live_run('tk_0123456789abcdef0123456789abcdef', user_id='user-1')
    ts._task_control[control.token] = control

    with pytest.raises(PermissionError, match='another owner'):
        await _start(ts, user_id='user-2', useExisting=True, token=control.token)
    control.task.wait_for_running.assert_not_awaited()


@pytest.mark.asyncio
async def test_another_user_cannot_take_over_a_finished_runs_token(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    control = _live_run('tk_0123456789abcdef0123456789abcdef', user_id='user-1', complete=True)
    ts._task_control[control.token] = control

    with pytest.raises(PermissionError, match='another owner'):
        await _start(ts, user_id='user-2', token=control.token)
    assert ts._task_control[control.token] is control


@pytest.mark.asyncio
async def test_a_personal_deploy_cannot_reuse_the_same_users_dev_run_by_token(logs, monkeypatch):
    """Same user, different run_kind: a different owner identity, as their tokens are."""
    ts = _server(logs, monkeypatch, key=KEY_A)
    control = _live_run('tk_0123456789abcdef0123456789abcdef', user_id='user-1')
    ts._task_control[control.token] = control

    with pytest.raises(PermissionError, match='another owner'):
        await ts.start_task(
            _request(useExisting=True, token=control.token),
            _conn(),
            client_id='user-1',
            user_id='user-1',
            team_id='team-1',
            org_id='org-1',
            run_kind='deploy',
            owner_kind='user',
        )


@pytest.mark.asyncio
async def test_the_owner_still_reuses_its_run_by_supplying_its_token(logs, monkeypatch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    control = _live_run('tk_0123456789abcdef0123456789abcdef', user_id='user-1')
    ts._task_control[control.token] = control

    result = await _start(ts, user_id='user-1', useExisting=True, token=control.token)
    assert result['reused'] is True and result['token'] == control.token


# =============================================================================
# pk_ reaches only a run whose source is a public endpoint
# =============================================================================


def _private_content():
    return {'kind': 'public', 'userId': 'user-1', 'project_id': 'proj-tk', 'source': 'src'}


@pytest.mark.asyncio
async def test_a_derived_pk_does_not_reach_a_run_without_a_public_source(logs, monkeypatch, no_launch):
    """The reviewer's recheck 2, on a run that serves no public endpoint."""
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts, pipeline=PRIVATE_PIPELINE)

    derived = _unkeyed(_private_content(), 'pk_')
    assert derived == started['publicToken']  # the pk_ itself is unchanged
    with pytest.raises(TaskError):
        await ts.authenticate(derived)
    with pytest.raises(TaskError):
        ts.get_task_control_by_public_key(derived)

    # Even a session already carrying the key resolves nothing on the run.
    control = ts._task_control[started['token']]
    info = ts._build_task_account_info(derived, control, ['task.data'])
    assert resolve_run_permissions(info, control) == []


@pytest.mark.asyncio
async def test_a_public_chat_link_still_works(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts, pipeline=CHAT_PIPELINE)

    info = await ts.authenticate(started['publicToken'])
    assert info.organization['teams'][0]['permissions'] == ['task.data']
    control = ts.get_task_control_by_public_key(started['publicToken'])
    assert control.token == started['token']
    assert 'task.data' in resolve_run_permissions(info, control)


@pytest.mark.asyncio
async def test_a_restart_onto_a_private_source_retires_the_pk(logs, monkeypatch, no_launch):
    """What counts is the pipeline the run holds now, not the one it launched with."""
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts, pipeline=CHAT_PIPELINE)
    control = ts._task_control[started['token']]
    control.pipeline = json.loads(json.dumps(PRIVATE_PIPELINE))  # what restart_task stores

    with pytest.raises(TaskError):
        await ts.authenticate(started['publicToken'])


def test_a_placeholder_source_provider_does_not_count_as_public():
    from ai.common.rocketride_db import source_is_public

    pipeline = {'components': [{'id': 'src', 'provider': '${ROCKETRIDE_SOURCE}'}]}
    assert source_is_public(pipeline, 'src') is False
    assert source_is_public({'components': [{'id': 'src', 'provider': 'webhook'}]}, 'src') is True
    assert source_is_public({'components': [{'id': 'other', 'provider': 'webhook'}]}, 'src') is False


# =============================================================================
# A caller-chosen tk_ must be as strong as a minted one
# =============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize('weak', ['tk_1', 'tk_test', 'tk_' + 'a' * 31, 'tk_' + 'a' * 31 + '!'])
async def test_a_weak_custom_tk_token_is_refused(logs, monkeypatch, no_launch, weak):
    ts = _server(logs, monkeypatch, key=KEY_A)

    with pytest.raises(ValueError, match='at least 32'):
        await _start(ts, token=weak)
    assert ts._task_control == {}


@pytest.mark.asyncio
@pytest.mark.parametrize('strong', [f'tk_{uuid.uuid4().hex}', f'tk_{uuid.uuid4()}', 'tk_' + 'Z_-9' * 8])
async def test_a_strong_custom_tk_token_is_kept(logs, monkeypatch, no_launch, strong):
    ts = _server(logs, monkeypatch, key=KEY_A)

    started = await _start(ts, token=strong)
    assert started['token'] == strong
    info = await ts.authenticate(strong)
    assert info.userId == 'user-1'


@pytest.mark.asyncio
async def test_a_custom_name_without_the_tk_prefix_is_still_accepted(logs, monkeypatch, no_launch):
    """First-party SDK and CLI tests name runs like this; such a name never authenticates."""
    ts = _server(logs, monkeypatch, key=KEY_A)

    started = await _start(ts, token='PY-PL')
    assert started['token'] == 'PY-PL'
    assert await ts.authenticate('PY-PL') is None  # not a task key: falls through to the account


# =============================================================================
# Key handling: never forwarded, checked at startup
# =============================================================================


@pytest.mark.parametrize('opt_in', ['RR_*', '*', 'RR_TASK_TOKEN_KEY', 'rr_task_token_key'])
def test_no_opt_in_forwards_the_key_to_a_task_subprocess(opt_in):
    env = filter_subprocess_env(
        {'RR_TASK_TOKEN_KEY': KEY_A, 'rr_task_token_key': KEY_B, 'RR_OTHER': 'x', 'RR_SUBPROCESS_ENV': opt_in}
    )
    assert not {name.upper() for name in env} & {'RR_TASK_TOKEN_KEY'}
    if opt_in in ('RR_*', '*'):
        assert env.get('RR_OTHER') == 'x'  # the opt-in itself still works


def test_a_short_key_stops_the_engine_at_startup(monkeypatch):
    monkeypatch.setenv('RR_TASK_TOKEN_KEY', 'too-short')

    with pytest.raises(ValueError, match='RR_TASK_TOKEN_KEY'):
        TaskServer(server=MagicMock())


@pytest.mark.asyncio
async def test_a_valid_key_is_resolved_at_startup(monkeypatch):
    monkeypatch.setenv('RR_TASK_TOKEN_KEY', KEY_A)

    ts = TaskServer(server=MagicMock())
    try:
        assert ts._tk_key == KEY_A.encode('utf-8')
    finally:
        for task in ts._bg_tasks:
            task.cancel()
        await asyncio.gather(*ts._bg_tasks, return_exceptions=True)


# =============================================================================
# Fixed non-tk_ names (the CLIs' 'UPLOAD_TASK') and a pk_ during a restart
# =============================================================================


@pytest.mark.asyncio
async def test_a_finished_run_under_a_fixed_name_is_replaced_by_another_user(logs, monkeypatch, no_launch):
    """Both CLIs start their upload run as 'UPLOAD_TASK'; the next user must not be locked out."""
    ts = _server(logs, monkeypatch, key=KEY_A)
    await _start(ts, user_id='user-1', token='UPLOAD_TASK')
    first = ts._task_control['UPLOAD_TASK']
    first.task.is_task_complete = lambda: True

    started = await _start(ts, user_id='user-2', token='UPLOAD_TASK')
    assert started['token'] == 'UPLOAD_TASK'
    assert ts._task_control['UPLOAD_TASK'] is not first
    assert ts._task_control['UPLOAD_TASK'].userId == 'user-2'


@pytest.mark.asyncio
async def test_a_running_run_under_a_fixed_name_stays_its_owners(logs, monkeypatch, no_launch):
    ts = _server(logs, monkeypatch, key=KEY_A)
    await _start(ts, user_id='user-1', token='UPLOAD_TASK')
    first = ts._task_control['UPLOAD_TASK']

    with pytest.raises(PermissionError, match='another owner'):
        await _start(ts, user_id='user-2', token='UPLOAD_TASK', useExisting=True)
    assert ts._task_control['UPLOAD_TASK'] is first


@pytest.mark.asyncio
async def test_a_pk_is_refused_while_a_restart_onto_a_private_source_runs(logs, monkeypatch, no_launch):
    """restart_task updates the control only after Task.restart_task returns; the task has the new one first."""
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts, pipeline=CHAT_PIPELINE)
    control = ts._task_control[started['token']]
    pk = started['publicToken']
    assert (await ts.authenticate(pk)).userId == 'user-1'

    entered, release = asyncio.Event(), asyncio.Event()

    async def _restart(*, pipeline, project_id, source, provider, **kwargs):
        control.task._pipeline = pipeline  # what Task.restart_task does before it stops and starts
        entered.set()
        await release.wait()

    control.task.restart_task = _restart
    control.task.has_attached_debugger = lambda: False
    conn = SimpleNamespace(_account_info=None)
    restart = asyncio.ensure_future(
        ts.restart_task(
            {'arguments': {'token': started['token'], 'pipeline': json.loads(json.dumps(PRIVATE_PIPELINE))}}, conn
        )
    )
    await asyncio.wait_for(entered.wait(), 2)

    assert control.pipeline['components'][0]['provider'] == 'chat'  # the control still says public
    with pytest.raises(TaskError):
        await ts.authenticate(pk)
    info = ts._build_task_account_info(pk, control, ['task.data'])
    assert resolve_run_permissions(info, control) == []

    release.set()
    await asyncio.wait_for(restart, 2)
    with pytest.raises(TaskError):
        await ts.authenticate(pk)


@pytest.mark.asyncio
async def test_a_failed_restart_onto_a_public_source_does_not_open_a_private_run(logs, monkeypatch, no_launch):
    """A failed restart leaves the control on the old pipeline and the task on the new: both must be public."""
    ts = _server(logs, monkeypatch, key=KEY_A)
    started = await _start(ts, pipeline=PRIVATE_PIPELINE)
    control = ts._task_control[started['token']]

    async def _restart(*, pipeline, **kwargs):
        control.task._pipeline = pipeline
        raise RuntimeError('restart failed')

    control.task.restart_task = _restart
    control.task.has_attached_debugger = lambda: False
    with pytest.raises(RuntimeError):
        await ts.restart_task(
            {'arguments': {'token': started['token'], 'pipeline': json.loads(json.dumps(CHAT_PIPELINE))}},
            SimpleNamespace(_account_info=None),
        )
    with pytest.raises(TaskError):
        await ts.authenticate(started['publicToken'])
