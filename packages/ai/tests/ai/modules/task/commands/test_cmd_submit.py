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

"""The DAP ``rrext_submit`` command (plan section 3, section 14 Step 3 "submit").

One-of validation; name calls walk the rungs and start a published rung from
its artifact, ignoring server-controlled arguments into ``ignored``; spec
calls address the caller's @spec control of the spec's identity (a
``project_id`` is required; the same configuration reuses, another
configuration is another control on the same engine, another user gets
another engine); the token slot carries the control id; inline delivery runs
open/write/close in process with a server-minted ``correlationId``; the
server adds no deadline; the probe advertises ``submit``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

from ai.constants import CONST_DEFAULT_MAX_THREADS
from ai.modules.task.commands import cmd_submit
from ai.modules.task.run_log import stream_name
from ai.modules.task.task_control import is_control_id
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.task_server_facade import _InProcessConn
from ai.modules.task.types import TaskError

from .. import test_task_engine_sharing as sharing
from ..test_task_engine_sharing import ADDRESS, _caller, _pipeline, _server

# The runtime-model fixtures, shared with the engine-sharing tests
catalog = sharing.catalog
deployments = sharing.deployments
engines = sharing.engines
serving = sharing.serving


# =============================================================================
# HELPERS
# =============================================================================


@pytest.fixture
def data_path(monkeypatch):
    """The engine's data path, in memory: every open/write/close is logged."""
    calls: List[tuple] = []

    async def send(self, request: Dict[str, Any]) -> Dict[str, Any]:
        arguments = request['arguments']
        calls.append((self, arguments['subcommand'], dict(arguments)))
        if arguments['subcommand'] == 'open':
            return {'body': {'pipeId': 1, 'traceId': 99}}
        if arguments['subcommand'] == 'close':
            return {'body': {'objects': 1, 'answer': 'ok'}}
        return {'body': {}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    return calls


def _conn(ts, account) -> _InProcessConn:
    """An authenticated connection of ``account`` on ``ts``."""
    conn = _InProcessConn(ts)
    conn._account_info = account
    conn._authenticated = True
    return conn


async def _submit(conn, **arguments) -> Dict[str, Any]:
    """Run ``submit`` and return the response body."""
    response = await conn.on_rrext_submit(conn.build_request('rrext_submit', arguments=arguments))
    return response['body']


# =============================================================================
# VALIDATION
# =============================================================================


@pytest.mark.asyncio
async def test_exactly_one_of_name_or_pipeline(catalog, engines, deployments):
    """Neither, or both, is invalid_argument naming the field."""
    conn = _conn(_server(), _caller())
    for arguments in ({}, {'name': ADDRESS, 'pipeline': _pipeline()}):
        with pytest.raises(TaskError) as err:
            await _submit(conn, **arguments)
        assert err.value.code == TaskError.INVALID_ARGUMENT and err.value.field == 'name'


@pytest.mark.asyncio
async def test_inline_data_over_the_limit_is_refused(catalog, engines, deployments, monkeypatch):
    """Inline data is capped; the SDK streams anything larger."""
    monkeypatch.setattr(cmd_submit, 'CONST_SUBMIT_INLINE_MAX', 4)
    with pytest.raises(TaskError) as err:
        await _submit(_conn(_server(), _caller()), name=ADDRESS, data=b'12345')
    assert err.value.code == TaskError.PAYLOAD_TOO_LARGE and err.value.limit == 4


# =============================================================================
# NAME CALLS
# =============================================================================


@pytest.mark.asyncio
async def test_a_name_call_starts_the_publication_and_ignores_server_controlled_args(
    catalog, engines, deployments, data_path
):
    """threads=4 on a name call: ignored and stamped, the engine keeps the policy shape."""
    ts = _server()
    deployments.deploy('team-1')
    conn = _conn(ts, _caller())

    body = await _submit(conn, name=ADDRESS, data=b'hello', threads=4, ttl=5, objinfo={'name': 'q'})

    assert body['answer'] == 'ok'
    control = ts.resolve_control(ADDRESS, _caller(), 'task.data')
    assert body['token'] == control.control_id and is_control_id(body['token'])
    assert body['address'] == ADDRESS
    assert (body['resolved'], body['team'], body['version']) == ('@team', 'team-1', 1)
    assert body['converged'] == 'started'
    assert body['ignored'] == ['threads', 'ttl']
    assert body['engineKey'] == control.task.engine_key
    assert control.task._threads == CONST_DEFAULT_MAX_THREADS

    # open -> write -> close, the open with a server-minted correlationId
    assert [sub for _, sub, _ in data_path] == ['open', 'write', 'close']
    assert data_path[0][2]['correlationId'] and data_path[0][2]['object'] == {'name': 'q', 'size': 5}

    # The hold stays: the next call attaches
    again = await _submit(conn, name=ADDRESS, data=b'again')
    assert again['converged'] == 'none' and again['ignored'] == []


@pytest.mark.asyncio
async def test_an_inline_submit_claims_its_request_tree_for_the_control(catalog, engines, deployments, data_path):
    """The round trip's tree is the submitting control's, this connection first, and counts in its stats (plan 7.5)."""
    ts = _server()
    deployments.deploy('team-1')
    conn = _conn(ts, _caller())
    claims: List[tuple] = []
    real_claim = ts.trace_owners.claim

    def claim(trace_id, control_key, conn_id, **attribution):
        claims.append((trace_id, control_key, conn_id))
        real_claim(trace_id, control_key, conn_id, **attribution)

    ts.trace_owners.claim = claim
    await _submit(conn, name=ADDRESS, data=b'hello')
    control = ts.resolve_control(ADDRESS, _caller(), 'task.data')
    assert claims == [('99', control.key, conn._connection_id)]
    # Released at the close: the owner lingers for the grace, stamped late
    owner = ts.trace_owners.owner('99')
    assert owner is not None and owner.control_key == control.key and owner.late is True
    # The tree is paid by the CALLER (plan 8.3): their org and user, their home team
    assert (owner.billing.org_id, owner.billing.user_id, owner.address) == ('org-1', 'user-a', ADDRESS)
    assert (control.stats.totalCount, control.stats.completedCount, control.stats.completedSize) == (1, 1, 5)


@pytest.mark.asyncio
async def test_a_close_that_carries_the_objects_error_counts_the_binding_failed(
    catalog, engines, deployments, monkeypatch
):
    """The pipeline failed the object: the close answers normally with its error, and the control counts a failure."""

    async def send(self, request):
        if request['arguments']['subcommand'] == 'open':
            return {'body': {'pipe_id': 1, 'traceId': 99}}
        if request['arguments']['subcommand'] == 'close':
            return {'body': {'objects': 1, 'error': 'the parser refused it'}}
        return {'body': {}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    ts = _server()
    deployments.deploy('team-1')
    body = await _submit(_conn(ts, _caller()), name=ADDRESS, data=b'hello')
    assert body['error'] == 'the parser refused it'
    control = ts.resolve_control(ADDRESS, _caller(), 'task.data')
    assert (control.stats.totalCount, control.stats.completedCount, control.stats.failedCount) == (1, 0, 1)
    assert control.stats.failedSize == 5


@pytest.mark.asyncio
async def test_without_data_the_call_returns_the_control_id_for_streaming(catalog, engines, deployments, data_path):
    """No inline data (on_sse, or a large payload): stamps and the control id, nothing delivered."""
    ts = _server()
    deployments.deploy('team-1')

    body = await _submit(_conn(ts, _caller()), name='acme.docBrain')

    control = ts.resolve_control(ADDRESS, _caller(), 'task.data')
    assert body['token'] == control.control_id and body['address'] == ADDRESS and body['resolved'] == '@team'
    assert data_path == []


@pytest.mark.asyncio
async def test_rung_order_and_the_rungs_tried(catalog, engines, deployments):
    """Nothing anywhere: not_found lists every rung walked."""
    with pytest.raises(TaskError) as err:
        await _submit(_conn(_server(), _caller()), name=ADDRESS)
    assert err.value.code == TaskError.NOT_REGISTERED
    assert err.value.rungsTried == ['@spec', '@me', '@team', '@public']


@pytest.mark.asyncio
async def test_team_overrides_the_order_for_one_call(catalog, engines, deployments, data_path):
    """team= answers from that team; the order answers the next call."""
    ts = _server()
    deployments.deploy('team-1', billing='team-1')
    deployments.deploy('team-2', billing='team-2', version=2)
    account = _caller(teams=('team-1', 'team-2'))
    conn = _conn(ts, account)

    assert (await _submit(conn, name=ADDRESS, team='team-2'))['team'] == 'team-2'
    assert (await _submit(conn, name=ADDRESS))['team'] == 'team-1'


@pytest.mark.asyncio
async def test_a_failed_write_still_closes_its_pipe_and_the_failure_is_what_the_caller_sees(
    catalog, engines, deployments, monkeypatch
):
    """The server adds no deadline: a write fails only when the engine says so, and the pipe is then closed."""
    ts = _server()
    deployments.deploy('team-1')
    closed: List[int] = []

    async def send(self, request):
        sub = request['arguments']['subcommand']
        if sub == 'write':
            raise TaskError(TaskError.CANCELLED, 'Pipe 1: the request was cancelled')
        if sub == 'close':
            closed.append(request['arguments']['pipeId'])
        return {'body': {'pipeId': 1}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    with pytest.raises(TaskError) as err:
        await _submit(_conn(ts, _caller()), name=ADDRESS, data=b'x')
    assert err.value.code == TaskError.CANCELLED
    assert closed == [1]


@pytest.mark.asyncio
async def test_timeout_is_not_a_server_argument(catalog, engines, deployments, monkeypatch):
    """A ``timeout`` the client sends is not applied: the request runs until the engine answers."""
    ts = _server()
    deployments.deploy('team-1')

    async def send(self, request):
        if request['arguments']['subcommand'] == 'write':
            await asyncio.sleep(0.2)
        return {'body': {'pipeId': 1, 'answers': ['late']}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    result = await _submit(_conn(ts, _caller()), name=ADDRESS, data=b'x', timeout=0.01)
    assert result['answers'] == ['late']


@pytest.mark.asyncio
async def test_params_ride_the_inline_open_and_an_unknown_name_is_refused(catalog, engines, deployments, data_path):
    """Per-call params enter by the open (one door); a name the map does not expose is param_rejected."""
    ts = _server()
    exposed = {'tone': 'prompt_1.instructions'}
    deployments.deploy('team-1', pipeline=_pipeline(parameters=exposed))
    conn = _conn(ts, _caller())

    body = await _submit(conn, name=ADDRESS, data=b'x', params={'tone': 'dry'})
    assert body['answer'] == 'ok'
    opens = [arguments for _engine, sub, arguments in data_path if sub == 'open']
    assert [o['_caller']['params'] for o in opens] == [{'prompt_1': {'instructions': 'dry'}}]
    assert all('params' not in o for o in opens)
    # Every frame of the request carries the same server-minted request id
    assert len({a['_caller']['correlationId'] for _e, _s, a in data_path}) == 1

    with pytest.raises(TaskError) as err:
        await _submit(conn, name=ADDRESS, data=b'x', params={'tone': 'dry', 'nope': 1})
    assert err.value.code == TaskError.PARAM_REJECTED
    assert err.value.errors == [{'name': 'nope', 'reason': 'not a parameter of this pipeline'}]
    assert len([1 for _engine, sub, _args in data_path if sub == 'open']) == 1, 'nothing reached the engine'


@pytest.mark.asyncio
async def test_a_data_request_on_a_name_starts_its_publication_like_process(catalog, engines, deployments):
    """send/pipe (and the HTTP door through them) resolve through the same resolver: an artifact start."""
    ts = _server()
    deployments.deploy('team-1')
    conn = _conn(ts, _caller())

    control = await conn.resolve_control_or_start({'arguments': {'token': ADDRESS}}, 'task.data')
    assert (control.rung, control.live, control.trigger) == ('team', True, 'submit')
    assert list(ts._task_control) == [control.key]

    # The next data request attaches; nothing starts twice
    again = await conn.resolve_control_or_start({'arguments': {'token': ADDRESS}}, 'task.data')
    assert again is control and len(ts._engines) == 1


@pytest.mark.asyncio
async def test_a_start_that_never_confirms_running_is_engine_start_failed(
    catalog, engines, deployments, data_path, monkeypatch
):
    """The liveness detector's bare TimeoutError reaches the caller as the structured error, with the key."""
    ts = _server()
    deployments.deploy('team-1')
    conn = _conn(ts, _caller())
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock(side_effect=TimeoutError('silent')))

    with pytest.raises(TaskError) as err:
        await _submit(conn, name=ADDRESS, data=b'x')
    assert err.value.code == TaskError.ENGINE_START_FAILED
    assert isinstance(err.value.engineKey, str) and len(err.value.engineKey.split(':')[0]) == 64, (
        'the key rides the error'
    )
    # A start that never confirmed is not retried and leaves nothing registered (plan 7.2)
    assert ts._task_control == {} and ts._engines == {}


# =============================================================================
# SPEC CALLS
# =============================================================================


@pytest.mark.asyncio
async def test_a_spec_call_creates_then_reuses_the_spec_control(catalog, engines, deployments, data_path):
    """submit(spec) creates the caller's @spec control; the same identity answers with the same id."""
    ts = _server()
    conn = _conn(ts, _caller())

    first = await _submit(conn, pipeline=_pipeline(), data=b'a')
    second = await _submit(conn, pipeline=_pipeline(), data=b'b')

    assert (first['resolved'], first['converged']) == ('@spec', 'started')
    assert 'version' not in first and is_control_id(first['token']) and first['address'] == ADDRESS
    assert (second['token'], second['converged']) == (first['token'], 'none')
    assert first['engineKey'] == second['engineKey']
    # A name call by the owner attaches to the same control
    named = await _submit(conn, name=ADDRESS)
    assert (named['resolved'], named['token']) == ('@spec', first['token'])


@pytest.mark.asyncio
async def test_five_submits_of_three_configs_are_one_engine_and_three_controls(
    catalog, engines, deployments, data_path
):
    """The Step 3c exit (plan 13, C.22): database1/p1, database2/p2, database1/p1, database2/p2, database3/p3."""
    ts = _server()
    conn = _conn(ts, _caller())
    calls = [('database1', 'p1'), ('database2', 'p2'), ('database1', 'p1'), ('database2', 'p2'), ('database3', 'p3')]

    results = [
        await _submit(conn, pipeline=_pipeline(project_id=project, instructions=[config]), data=b'x')
        for project, config in calls
    ]

    # ONE engine, THREE controls, three ids; calls 3 and 4 answer with the ids of 1 and 2
    assert len(ts._engines) == 1 and len(ts._task_control) == 3
    tokens = [r['token'] for r in results]
    assert (tokens[2], tokens[3]) == (tokens[0], tokens[1]) and len(set(tokens)) == 3
    assert [r['converged'] for r in results] == ['started', 'started', 'none', 'none', 'started']
    assert {r['engineKey'] for r in results} == set(ts._engines)
    controls = [ts._task_control[token] for token in (tokens[0], tokens[1], tokens[4])]
    assert {c.task for c in controls} == set(ts._engines.values())
    assert len({c.config_hash for c in controls}) == 3
    # Each open carried ITS control's config: three IGlobal sets for the engine to build (plan 5.3)
    opens = [arguments for _engine, sub, arguments in data_path if sub == 'open']
    assert [o['_caller']['controlId'] for o in opens] == [tokens[0], tokens[1], tokens[0], tokens[1], tokens[4]]
    prompt = controls[0].index_map.to_index('prompt_1')
    assert [o['_caller']['config'][prompt]['instructions'] for o in opens] == [['p1'], ['p2'], ['p1'], ['p2'], ['p3']]
    # Three run-log continua, named by the stable identity, never by the control id (plan 15 item 20)
    continua = [stream_name(c.project_id, c.source, c.run_kind) for c in controls]
    assert continua == ['database1.webhook_1.dev', 'database2.webhook_1.dev', 'database3.webhook_1.dev']
    assert all(c.control_id not in name for c in controls for name in continua)


@pytest.mark.asyncio
async def test_a_spec_without_a_project_id_is_refused_naming_the_field(catalog, engines, deployments, data_path):
    """project_id is required on every spec door (plan 2.2): nothing is minted in its place."""
    ts = _server()
    pipeline = _pipeline()
    del pipeline['project_id']

    with pytest.raises(TaskError) as err:
        await _submit(_conn(ts, _caller()), pipeline=pipeline, data=b'x')

    assert (err.value.code, err.value.field) == (TaskError.INVALID_ARGUMENT, 'project_id')
    assert ts._task_control == {} and ts._engines == {} and data_path == []


@pytest.mark.asyncio
async def test_a_second_users_identical_spec_gets_a_second_engine(catalog, engines, deployments, data_path):
    """Engines are owner-qualified on every rung in this PR: no cross-owner sharing before C.25."""
    ts = _server()
    mine = await _submit(_conn(ts, _caller('user-a')), pipeline=_pipeline(), data=b'x')
    theirs = await _submit(_conn(ts, _caller('user-b')), pipeline=_pipeline(), data=b'x')

    assert mine['token'] != theirs['token'] and mine['engineKey'] != theirs['engineKey']
    assert len(ts._engines) == 2 and len(ts._task_control) == 2


@pytest.mark.asyncio
async def test_a_differing_configuration_is_another_control_on_the_same_engine(
    catalog, engines, deployments, data_path
):
    """Plan 3.4: nothing is moved between engines and nothing is refused; both controls live on the one engine."""
    ts = _server()
    conn = _conn(ts, _caller())
    old = await _submit(conn, pipeline=_pipeline())
    new = await _submit(conn, pipeline=_pipeline(instructions=['new']))

    assert old['token'] != new['token'] and old['engineKey'] == new['engineKey']
    assert (old['converged'], new['converged']) == ('started', 'started')
    assert len(ts._engines) == 1 and len(ts._task_control) == 2
    assert ts._task_control[old['token']].live and ts._task_control[new['token']].live
    # The most recently touched one answers a name call (plan 3.2)
    older, newer = ts._task_control[old['token']], ts._task_control[new['token']]
    newer.last_activity = older.last_activity + 1
    assert (await _submit(conn, name=ADDRESS))['token'] == new['token']
    older.last_activity = newer.last_activity + 1
    assert (await _submit(conn, name=ADDRESS))['token'] == old['token']


# =============================================================================
# THE PROBE
# =============================================================================


@pytest.mark.asyncio
async def test_the_probe_advertises_process():
    """An SDK checks the probe before submit(); an old server lacks the feature."""
    ts = _server()
    ts._server.account.capabilities = ['oss']
    ts._server.account.get_public_apps = AsyncMock(return_value=[])
    conn = _conn(ts, None)

    response = await conn.on_rrext_public_probe(conn.build_request('rrext_public_probe'))

    assert 'submit' in response['body']['features']


@pytest.mark.asyncio
async def test_the_cleanup_close_after_a_failed_write_is_bounded(catalog, engines, deployments, monkeypatch):
    """An engine that stops answering the cleanup close cannot hold the failed request open; the write's failure is what propagates."""
    ts = _server()
    deployments.deploy('team-1')
    monkeypatch.setattr(cmd_submit, 'CONST_SUBMIT_CLOSE_SECONDS', 0.05)

    async def send(self, request):
        sub = request['arguments']['subcommand']
        if sub == 'write':
            raise TaskError(TaskError.CANCELLED, 'Pipe 1: the request was cancelled')
        if sub == 'close':
            await asyncio.sleep(10)
        return {'body': {'pipeId': 1}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    started = time.monotonic()
    with pytest.raises(TaskError) as err:
        await _submit(_conn(ts, _caller()), name=ADDRESS, data=b'x')
    assert err.value.code == TaskError.CANCELLED
    assert time.monotonic() - started < 2.0
