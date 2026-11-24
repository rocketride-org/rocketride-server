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

"""The presenting credential reaches ``authorize_db_target`` (SDD 4.4, develop #2987).

A run's RocketRide cloud databases are authorized as the control's run. The
account layer is also handed the credential of the connection the request
came in on, so it can limit what a restricted key may reach:

- a control that is created, and the engine it starts
- a control the caller is handed although it already exists (the same spec is
  covered by the question just asked; another spec, with ``useExisting``, is
  asked about on its own)
- a dormant control whose engine a request starts again

The credential is a call argument only: it is never kept on a control or an
engine, and never put in the run identity. An account implementation that
predates the keyword is called as it always was.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from ai.modules.task import task_engine
from ai.modules.task.commands import engine_access
from ai.modules.task.task_engine import TaskEngine, _accepts_credential, authorize_db_targets
from ai.modules.task.task_server import TaskServer
from ai.modules.task.types import EngineState

from . import test_task_engine_sharing as sharing
from .test_task_engine_sharing import _db_pipeline, _idle_out, _pipeline, _server

catalog = sharing.catalog
clock = sharing.clock

IDENTITY = {
    'org_id': 'org-1',
    'user_id': 'user-a',
    'team_id': 'team-1',
    'run_kind': 'dev',
    'owner_kind': 'user',
    'public_endpoint': False,
    'path': 'pipeline',
    'task_id': 'acme.docDb',
}

# The session key of the owner and a key of the same owner that may not reach the org database
SESSION = 'rr_session'
SCOPED = 'rr_scoped'


def _conn(auth: Any = SESSION) -> MagicMock:
    """A connection whose account presents ``auth`` (a connection with no account for ``auth=...``)."""
    conn = MagicMock()
    conn._account_info = None if auth is ... else SimpleNamespace(auth=auth)
    return conn


@pytest.fixture
def db_account(monkeypatch):
    """An account that takes the credential, refuses ``SCOPED`` and records every question."""
    import ai.account

    asked: List[Dict[str, Any]] = []

    async def authorize(identity, request, *, credential=None):
        asked.append(
            {
                'task_id': identity['task_id'],
                'identity': dict(identity),
                'request': dict(request),
                'credential': credential,
            }
        )
        if credential == SCOPED:
            return SimpleNamespace(allowed=False, reason='this key may not reach the org database', owner_id='')
        owner = request.get('team_id') or request.get('user_id') or identity['org_id']
        return SimpleNamespace(allowed=True, reason='', owner_id=owner)

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize, raising=False)
    return asked


@pytest.fixture
def engines(monkeypatch):
    """Engines that confirm running without a subprocess; returns the credential each start was given."""
    started: List[Optional[str]] = []

    async def start(self, *, credential=None):
        started.append(credential)
        self.state = EngineState.STARTING
        self._confirm_running()

    async def stop(self, reason='user'):
        self._stop_reason = reason
        self.state = EngineState.STOPPED
        self._status.state = 6  # CANCELLED

    async def terminated(self):
        return None

    monkeypatch.setattr(TaskEngine, 'start_task', start)
    monkeypatch.setattr(TaskEngine, 'stop_task', stop)
    monkeypatch.setattr(TaskEngine, 'wait_terminated', terminated)
    return started


async def _start_as(
    ts: TaskServer,
    pipeline: Dict[str, Any],
    auth: Any = SESSION,
    caller_env: Optional[Dict[str, str]] = None,
    org_id: str = 'org-1',
    **arguments,
):
    """Start (or attach to) a control as user-a over a connection that presents ``auth``, with the call's own env."""
    request = {'command': 'execute', 'arguments': {'pipeline': copy.deepcopy(pipeline), **arguments}}
    result = await ts.start_task(
        request,
        _conn(auth),
        client_id='user-a',
        user_id='user-a',
        team_id='team-1',
        org_id=org_id,
        developer_id='acme',
        caller_env=caller_env,
    )
    return ts._task_control[result['token']]


def _holds(obj: Any, value: str) -> List[str]:
    """The attribute names of ``obj`` whose value is, or contains, ``value``."""
    return [name for name, held in vars(obj).items() if held == value or value in repr(held)]


# =============================================================================
# THE CREDENTIAL OF A CONNECTION
# =============================================================================


def test_the_presenting_credential_is_the_connections_auth():
    assert TaskServer._presenting_credential(_conn('rr_key')) == 'rr_key'
    # The trusted in-process deploy dispatch holds none
    assert TaskServer._presenting_credential(_conn('')) == ''


def test_no_connection_or_no_account_presents_none():
    assert TaskServer._presenting_credential(None) is None
    assert TaskServer._presenting_credential(_conn(...)) is None
    # A stand-in whose attributes are not strings is not a credential
    assert TaskServer._presenting_credential(MagicMock()) is None


# =============================================================================
# THE ACCOUNT LAYER IS HANDED THE CREDENTIAL, AND NOTHING ELSE CHANGES
# =============================================================================


@pytest.mark.asyncio
async def test_the_credential_is_passed_as_a_keyword_and_stays_out_of_the_identity(db_account):
    approved = await authorize_db_targets(IDENTITY, [('org', ''), ('team', 'team-9')], credential=SESSION)

    assert approved == [('org', '', 'org-1'), ('team', 'team-9', 'team-9')]
    assert [q['credential'] for q in db_account] == [SESSION, SESSION]
    assert all(SESSION not in repr(q['identity']) for q in db_account)


@pytest.mark.asyncio
async def test_a_denied_credential_refuses_the_database_with_the_accounts_reason(db_account):
    with pytest.raises(PermissionError, match='this key may not reach the org database'):
        await authorize_db_targets(IDENTITY, [('org', '')], credential=SCOPED)


@pytest.mark.asyncio
async def test_an_account_without_the_keyword_is_called_as_before_with_one_warning(monkeypatch):
    """An older account implementation keeps working: two arguments, and a warning that names no credential."""
    import ai.account

    calls: List[tuple] = []
    warnings: List[str] = []

    async def authorize(identity, request):
        calls.append((identity['task_id'], dict(request)))
        return SimpleNamespace(allowed=True, reason='', owner_id=identity['org_id'])

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize, raising=False)
    monkeypatch.setattr(task_engine, 'warning', warnings.append)

    approved = await authorize_db_targets(IDENTITY, [('org', ''), ('team', 'team-9')], credential=SESSION)

    assert [owner for _, _, owner in approved] == ['org-1', 'org-1']
    assert len(calls) == 2
    assert len(warnings) == 1 and 'predates' in warnings[0] and SESSION not in warnings[0]


@pytest.mark.asyncio
async def test_a_run_without_database_nodes_asks_and_warns_nothing(monkeypatch):
    import ai.account

    warnings: List[str] = []
    monkeypatch.setattr(ai.account.account, 'authorize_db_target', lambda identity, request: 1 / 0, raising=False)
    monkeypatch.setattr(task_engine, 'warning', warnings.append)

    assert await authorize_db_targets(IDENTITY, [], credential=SESSION) == []
    assert warnings == []


def test_the_keyword_is_read_from_the_signature():
    async def keyword_only(identity, target=None, *, credential=None):
        return None

    async def positional(identity, target=None, credential=None):
        return None

    async def any_keyword(identity, target=None, **extra):
        return None

    async def without(identity, target=None):
        return None

    async def positional_only(identity, target, credential, /):
        return None

    assert _accepts_credential(keyword_only)
    assert _accepts_credential(positional)
    assert _accepts_credential(any_keyword)
    assert not _accepts_credential(without)
    assert not _accepts_credential(positional_only)
    # A signature that cannot be read counts as accepting: a credential is never dropped on a guess
    assert _accepts_credential(42)


# =============================================================================
# A CONTROL THAT IS CREATED
# =============================================================================


@pytest.mark.asyncio
async def test_a_new_control_and_its_engine_are_authorized_with_the_connections_credential(
    catalog, engines, db_account
):
    ts = _server()

    control = await _start_as(ts, _db_pipeline(), SESSION)

    assert [(q['task_id'], q['credential']) for q in db_account] == [(control.id, SESSION)]
    assert engines == [SESSION], 'the engine this call starts authorizes its own databases with the same credential'
    assert control.db_approved == {'org': 'org-1'}


@pytest.mark.asyncio
async def test_a_restricted_key_cannot_create_a_control_on_a_database_it_may_not_reach(catalog, engines, db_account):
    ts = _server()

    with pytest.raises(PermissionError, match='this key may not reach the org database'):
        await _start_as(ts, _db_pipeline(), SCOPED)

    assert len(ts._task_control) == 0 and engines == [], 'nothing was registered and no engine started'


@pytest.mark.asyncio
async def test_the_credential_is_kept_nowhere(catalog, engines, db_account):
    ts = _server()
    secret = 'rr_never_stored_0123456789'

    control = await _start_as(ts, _db_pipeline(), secret)

    assert _holds(control, secret) == []
    assert _holds(control.task, secret) == []
    assert _holds(ts, secret) == []
    assert all(secret not in repr(q['identity']) for q in db_account)


# =============================================================================
# A CONTROL THE CALLER IS HANDED ALTHOUGH IT EXISTS
# =============================================================================


@pytest.mark.asyncio
async def test_the_same_spec_is_asked_once_for_the_caller_that_reuses_it(catalog, engines, db_account):
    """The question asked for the submitted pipeline covers a control of the same spec: no second question."""
    ts = _server()
    first = await _start_as(ts, _db_pipeline(), SESSION)
    del db_account[:]

    again = await _start_as(ts, _db_pipeline(), SESSION)

    assert again is first
    assert [q['credential'] for q in db_account] == [SESSION]
    assert engines == [SESSION], 'no second engine'


@pytest.mark.asyncio
async def test_a_restricted_key_cannot_ride_a_wider_run_of_the_same_spec(catalog, engines, db_account):
    ts = _server()
    first = await _start_as(ts, _db_pipeline(), SESSION)

    with pytest.raises(PermissionError, match='this key may not reach the org database'):
        await _start_as(ts, _db_pipeline(), SCOPED)

    assert list(ts._task_control.values()) == [first], 'the running control is untouched'


@pytest.mark.asyncio
async def test_use_existing_asks_about_the_running_controls_own_databases(catalog, engines, db_account):
    """The caller submits a pipeline without a database; the control it would get holds one."""
    ts = _server()
    running = await _start_as(ts, _db_pipeline(), SESSION)
    del db_account[:]

    reused = await _start_as(ts, _pipeline(project_id='docDb'), SESSION, useExisting=True)

    assert reused is running
    assert [(q['task_id'], q['credential']) for q in db_account] == [(running.id, SESSION)]
    assert running.db_approved == {'org': 'org-1'}, 'what the engine was handed does not change'


@pytest.mark.asyncio
async def test_use_existing_refuses_a_key_the_running_controls_databases_are_denied_to(catalog, engines, db_account):
    ts = _server()
    running = await _start_as(ts, _db_pipeline(), SESSION)

    with pytest.raises(PermissionError) as refused:
        await _start_as(ts, _pipeline(project_id='docDb'), SCOPED, useExisting=True)

    message = str(refused.value)
    assert message.startswith(f'Cannot reuse the running task "{running.id}"')
    assert 'this key may not reach the org database' in message
    assert SCOPED not in message
    assert list(ts._task_control.values()) == [running]


@pytest.mark.asyncio
async def test_use_existing_on_a_run_without_databases_asks_nothing(catalog, engines, db_account):
    ts = _server()
    running = await _start_as(ts, _pipeline(), SESSION)

    reused = await _start_as(ts, _pipeline(instructions=['other']), SCOPED, useExisting=True)

    assert reused is running and db_account == []


# One spec whose database is named by the call's environment
_ENV_SPEC = {'scope': 'team', 'target': '${ROCKETRIDE_DB_TEAM}'}


@pytest.mark.asyncio
async def test_the_same_spec_on_another_environments_database_is_asked_about_on_its_own(catalog, engines, db_account):
    """A spec is compared with its placeholders in place: the same spec can hold another database.

    The answer given for what this call resolved does not cover the running
    control, whose engine holds the database its own environment named.
    """
    ts = _server()
    running = await _start_as(ts, _db_pipeline(**_ENV_SPEC), SESSION, caller_env={'ROCKETRIDE_DB_TEAM': 'team-1'})
    assert running.db_approved == {'team:team-1': 'team-1'}
    del db_account[:]

    again = await _start_as(ts, _db_pipeline(**_ENV_SPEC), SESSION, caller_env={'ROCKETRIDE_DB_TEAM': 'team-9'})

    assert again is running, 'the same spec: the caller gets the control it already has'
    # What this call resolved, then what the running control holds
    assert [q['request'].get('team_id') for q in db_account] == ['team-9', 'team-1']
    assert [q['credential'] for q in db_account] == [SESSION, SESSION]
    assert running.db_approved == {'team:team-1': 'team-1'}, 'what the engine was handed does not change'


@pytest.mark.asyncio
async def test_a_key_denied_the_running_controls_database_cannot_reach_it_through_another_environment(
    catalog, engines, monkeypatch
):
    """A key that may reach team-9 and not team-1 does not get the control that holds team-1's database."""
    import ai.account

    async def authorize(identity, request, *, credential=None):
        if credential == SCOPED and request.get('team_id') == 'team-1':
            return SimpleNamespace(allowed=False, reason='this key may not reach that team database', owner_id='')
        return SimpleNamespace(allowed=True, reason='', owner_id=request.get('team_id') or identity['org_id'])

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize, raising=False)
    ts = _server()
    running = await _start_as(ts, _db_pipeline(**_ENV_SPEC), SESSION, caller_env={'ROCKETRIDE_DB_TEAM': 'team-1'})

    with pytest.raises(PermissionError) as refused:
        await _start_as(ts, _db_pipeline(**_ENV_SPEC), SCOPED, caller_env={'ROCKETRIDE_DB_TEAM': 'team-9'})

    message = str(refused.value)
    assert message.startswith(f'Cannot reuse the running task "{running.id}"')
    assert 'this key may not reach that team database' in message
    assert list(ts._task_control.values()) == [running]


@pytest.mark.asyncio
async def test_the_same_spec_started_under_another_org_is_asked_about_on_its_own(catalog, engines, db_account):
    """A user scope resolves per org: the same key and owner under another org is another database.

    The user's control started under org-1 holds org-1's copy. The answer
    given for the same spec submitted under org-2 does not cover it.
    """
    ts = _server()
    running = await _start_as(ts, _db_pipeline(scope='user'), SESSION)
    assert running.db_approved == {'user': 'user-a'}
    del db_account[:]

    again = await _start_as(ts, _db_pipeline(scope='user'), SESSION, org_id='org-2')

    assert again is running, 'the same owner and spec: the caller gets the control it already has'
    # What this call resolved under org-2 (the same key and owner), then what the running control holds, as org-1's run
    assert [(q['task_id'], q['identity']['org_id'], q['credential']) for q in db_account] == [
        (running.id, 'org-2', SESSION),
        (running.id, 'org-1', SESSION),
    ]


# =============================================================================
# A DORMANT CONTROL WHOSE ENGINE IS STARTED AGAIN
# =============================================================================


@pytest.mark.asyncio
async def test_a_request_that_wakes_a_dormant_control_authorizes_as_that_request(catalog, engines, db_account, clock):
    ts = _server()
    control = await _start_as(ts, _db_pipeline(), SESSION, ttl=3600)
    await _idle_out(ts, clock)
    assert control.dormant
    del db_account[:], engines[:]

    engine = await ts.ensure_engine(control, credential='rr_waker')

    assert engine is control.task and not control.dormant
    assert [q['credential'] for q in db_account] == ['rr_waker']
    assert engines == ['rr_waker']


@pytest.mark.asyncio
async def test_a_restricted_key_cannot_wake_a_dormant_control(catalog, engines, db_account, clock):
    ts = _server()
    control = await _start_as(ts, _db_pipeline(), SESSION, ttl=3600)
    stopped = control.task
    await _idle_out(ts, clock)

    with pytest.raises(PermissionError, match='this key may not reach the org database'):
        await ts.ensure_engine(control, credential=SCOPED)

    assert control.task is stopped and control.dormant


@pytest.mark.asyncio
async def test_a_restart_the_server_makes_by_itself_presents_no_credential(catalog, engines, db_account, clock):
    ts = _server()
    control = await _start_as(ts, _db_pipeline(), SESSION, ttl=3600)
    await _idle_out(ts, clock)
    del db_account[:], engines[:]

    await ts.ensure_engine(control)

    assert [q['credential'] for q in db_account] == [None]
    assert engines == [None]


@pytest.mark.asyncio
async def test_a_data_or_control_request_carries_its_connections_credential_to_the_restart():
    """``engine_for`` is the door every request through a control takes."""
    seen: List[tuple] = []
    control = SimpleNamespace(dormant=False, teamId='team-1')

    async def ensure_engine(got, *, credential=None):
        seen.append((got, credential))
        return 'engine'

    conn = SimpleNamespace(
        _server=SimpleNamespace(ensure_engine=ensure_engine), _account_info=SimpleNamespace(auth='rr_request')
    )

    assert await engine_access.engine_for(conn, control, 'task.data') == 'engine'
    assert seen == [(control, 'rr_request')]
