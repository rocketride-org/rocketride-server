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

"""The DAP ``process`` command (plan section 3, section 14 Step 3 "process").

One-of validation; name calls walk the rungs and start a published rung from
its artifact, ignoring server-controlled arguments into ``ignored``; spec
calls address the caller's @dev presence and converge per ``onChange``
(repoint, never kill); inline delivery runs open/write/close in process with
a server-minted ``correlationId``; ``timeout`` covers open to close; the
probe advertises ``process``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

from ai.constants import CONST_DEFAULT_MAX_THREADS
from ai.modules.task import task_server
from ai.modules.task.commands import cmd_process
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.task_server_facade import _InProcessConn
from ai.modules.task.types import TaskError

from .. import test_task_engine_sharing as sharing
from ..test_task_engine_sharing import ADDRESS, _caller, _pipeline, _server, _start

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
            return {'body': {'pipe_id': 1, 'traceId': 99}}
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


async def _process(conn, **arguments) -> Dict[str, Any]:
    """Run ``process`` and return the response body."""
    response = await conn.on_process(conn.build_request('process', arguments=arguments))
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
            await _process(conn, **arguments)
        assert err.value.code == TaskError.INVALID_ARGUMENT and err.value.field == 'name'


@pytest.mark.asyncio
async def test_inline_data_over_the_limit_is_refused(catalog, engines, deployments, monkeypatch):
    """Inline data is capped; the SDK streams anything larger."""
    monkeypatch.setattr(cmd_process, 'CONST_PROCESS_INLINE_MAX', 4)
    with pytest.raises(TaskError) as err:
        await _process(_conn(_server(), _caller()), name=ADDRESS, data=b'12345')
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

    body = await _process(conn, name=ADDRESS, data=b'hello', threads=4, ttl=5, objinfo={'name': 'q'})

    assert body['answer'] == 'ok'
    assert body['token'] == ADDRESS
    assert (body['resolved'], body['team'], body['version']) == ('@team', 'team-1', 1)
    assert (body['converged'], body['specMatch']) == ('started', True)
    assert body['ignored'] == ['threads', 'ttl']
    control = ts.resolve_control(ADDRESS, _caller(), 'task.data')
    assert body['engineKey'] == control.task.engine_key
    assert control.task._threads == CONST_DEFAULT_MAX_THREADS

    # open -> write -> close, the open with a server-minted correlationId
    assert [sub for _, sub, _ in data_path] == ['open', 'write', 'close']
    assert data_path[0][2]['correlationId'] and data_path[0][2]['object'] == {'name': 'q', 'size': 5}

    # The hold stays: the next call attaches
    again = await _process(conn, name=ADDRESS, data=b'again')
    assert again['converged'] == 'none' and again['ignored'] == []


@pytest.mark.asyncio
async def test_without_data_the_call_returns_the_address_for_streaming(catalog, engines, deployments, data_path):
    """No inline data (on_sse, or a large payload): stamps and the address, nothing delivered."""
    ts = _server()
    deployments.deploy('team-1')

    body = await _process(_conn(ts, _caller()), name='acme.docBrain')

    assert body['token'] == ADDRESS and body['resolved'] == '@team'
    assert data_path == []


@pytest.mark.asyncio
async def test_rung_order_and_the_rungs_tried(catalog, engines, deployments):
    """Nothing anywhere: not_found lists every rung walked."""
    with pytest.raises(TaskError) as err:
        await _process(_conn(_server(), _caller()), name=ADDRESS)
    assert err.value.code == TaskError.NOT_REGISTERED
    assert err.value.rungsTried == ['@dev', '@me', '@team', '@public']


@pytest.mark.asyncio
async def test_team_overrides_the_order_for_one_call(catalog, engines, deployments, data_path):
    """team= answers from that team; the order answers the next call."""
    ts = _server()
    deployments.deploy('team-1', billing='team-1')
    deployments.deploy('team-2', billing='team-2', version=2)
    account = _caller(teams=('team-1', 'team-2'))
    conn = _conn(ts, account)

    assert (await _process(conn, name=ADDRESS, team='team-2'))['team'] == 'team-2'
    assert (await _process(conn, name=ADDRESS))['team'] == 'team-1'


@pytest.mark.asyncio
async def test_the_timeout_covers_open_to_close(catalog, engines, deployments, monkeypatch):
    """A request that outlives the caller's timeout fails with timeout, and its pipe is closed."""
    ts = _server()
    deployments.deploy('team-1')
    closed: List[int] = []

    async def send(self, request):
        sub = request['arguments']['subcommand']
        if sub == 'write':
            await asyncio.sleep(10)
        if sub == 'close':
            closed.append(request['arguments']['pipe_id'])
        return {'body': {'pipe_id': 1}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    with pytest.raises(TaskError) as err:
        await _process(_conn(ts, _caller()), name=ADDRESS, data=b'x', timeout=0.05)
    assert err.value.code == TaskError.TIMEOUT
    assert (err.value.address, err.value.converged) == (ADDRESS, 'started')
    assert closed == [1]


@pytest.mark.asyncio
async def test_the_close_after_a_timed_out_write_is_bounded(catalog, engines, deployments, monkeypatch):
    """An engine that does not answer the cleanup close never holds the timed-out request open."""
    ts = _server()
    deployments.deploy('team-1')
    monkeypatch.setattr(cmd_process, 'CONST_PROCESS_CLOSE_SECONDS', 0.05)

    async def send(self, request):
        if request['arguments']['subcommand'] in ('write', 'close'):
            await asyncio.sleep(10)
        return {'body': {'pipe_id': 1}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    started = time.monotonic()
    with pytest.raises(TaskError) as err:
        await _process(_conn(ts, _caller()), name=ADDRESS, data=b'x', timeout=0.05)
    assert err.value.code == TaskError.TIMEOUT
    assert time.monotonic() - started < 2.0


# =============================================================================
# SPEC CALLS
# =============================================================================


@pytest.mark.asyncio
async def test_a_spec_call_creates_then_reuses_the_dev_presence(catalog, engines, deployments, data_path):
    """process(spec) starts the caller's @dev control; the same hash reuses it."""
    ts = _server()
    conn = _conn(ts, _caller())

    first = await _process(conn, pipeline=_pipeline(), data=b'a')
    second = await _process(conn, pipeline=_pipeline(), data=b'b')

    assert (first['resolved'], first['converged']) == ('@dev', 'started')
    assert 'version' not in first
    assert (second['converged'], second['specMatch']) == ('none', True)
    assert first['engineKey'] == second['engineKey']
    # A name call by the owner attaches to the same presence
    assert (await _process(conn, name=ADDRESS))['resolved'] == '@dev'


@pytest.mark.asyncio
async def test_on_change_error_keep_and_auto(catalog, engines, deployments, data_path):
    """On a changed spec: error refuses with both hashes, keep uses the old engine, auto repoints."""
    ts = _server()
    conn = _conn(ts, _caller())
    old = await _process(conn, pipeline=_pipeline())

    with pytest.raises(TaskError) as err:
        await _process(conn, pipeline=_pipeline(instructions=['new']))
    assert err.value.code == TaskError.SPEC_CHANGED
    assert err.value.currentHash == old['engineKey'].split(':')[0] and err.value.newHash != err.value.currentHash

    kept = await _process(conn, pipeline=_pipeline(instructions=['new']), onChange='keep')
    assert (kept['specMatch'], kept['engineKey']) == (False, old['engineKey'])

    moved = await _process(conn, pipeline=_pipeline(instructions=['new']), onChange='auto')
    assert (moved['converged'], moved['specMatch']) == ('repointed', True)
    assert moved['engineKey'] != old['engineKey']

    with pytest.raises(TaskError) as err:
        await _process(conn, pipeline=_pipeline(), onChange='sometimes')
    assert err.value.code == TaskError.INVALID_ARGUMENT


@pytest.mark.asyncio
async def test_a_repoint_never_interrupts_the_old_engines_other_holder(catalog, engines, deployments, data_path):
    """Nothing is killed: the old engine keeps serving user-b; the last hold dropping stops it."""
    ts = _server()
    mine = _conn(ts, _caller('user-a'))
    await _process(mine, pipeline=_pipeline())
    theirs = await _start(ts, _pipeline(), user='user-b')
    shared = theirs.task

    await _process(mine, pipeline=_pipeline(instructions=['new']), onChange='auto')

    assert shared.holds == frozenset({theirs.key})
    assert engines == []

    # Alone on its engine, a repoint stops the old one at once
    await _process(mine, pipeline=_pipeline(instructions=['newer']), onChange='auto')
    assert [reason for _, reason in engines] == ['repointed']


@pytest.mark.asyncio
async def test_a_second_workspace_on_the_same_address_warns_of_a_collision(catalog, engines, deployments, data_path):
    """Another origin, another hash: address_collision rides the error (and a repoint's result)."""
    ts = _server()
    conn = _conn(ts, _caller())
    await _process(conn, pipeline=_pipeline(), origin='C:/ws-one/pipelines/docBrain')

    with pytest.raises(TaskError) as err:
        await _process(conn, pipeline=_pipeline(instructions=['x']), origin='C:/ws-two/pipelines/docBrain')
    assert err.value.warnings == [
        {
            'code': 'address_collision',
            'address': ADDRESS,
            'origins': ['C:/ws-one/pipelines/docBrain', 'C:/ws-two/pipelines/docBrain'],
        }
    ]

    # Same origin, or the same hash: no warning
    same = await _process(conn, pipeline=_pipeline(), origin='C:/ws-two/pipelines/docBrain')
    assert 'warnings' not in same


@pytest.mark.asyncio
async def test_repointing_one_address_too_often_warns_of_a_storm(catalog, engines, deployments, data_path, monkeypatch):
    """More than N repoints a minute by one owner: repoint_storm."""
    monkeypatch.setattr(task_server, 'CONST_REPOINT_STORM_MAX', 2)
    ts = _server()
    conn = _conn(ts, _caller())
    await _process(conn, pipeline=_pipeline())

    results = [await _process(conn, pipeline=_pipeline(instructions=[f'v{n}']), onChange='auto') for n in range(3)]

    assert all('warnings' not in r for r in results[:2])
    assert results[2]['warnings'] == [{'code': 'repoint_storm', 'address': ADDRESS, 'count': 3, 'window': 60}]


# =============================================================================
# THE PROBE
# =============================================================================


@pytest.mark.asyncio
async def test_the_probe_advertises_process():
    """An SDK checks the probe before process(); an old server lacks the feature."""
    ts = _server()
    ts._server.account.capabilities = ['oss']
    ts._server.account.get_public_apps = AsyncMock(return_value=[])
    conn = _conn(ts, None)

    response = await conn.on_rrext_public_probe(conn.build_request('rrext_public_probe'))

    assert 'process' in response['body']['features']
