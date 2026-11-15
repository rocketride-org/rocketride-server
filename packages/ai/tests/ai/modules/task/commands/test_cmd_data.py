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

"""The data path's trust boundary (plan 0 S2/S3/S9, 3.1 P1/P2, 5.3): ``DataCommands.on_rrext_process``.

Every frame is stripped of client-sent context and stamped with the server's
``_caller``; a frame naming a pipe must find it on the CALLER's control and
goes to the engine that pipe opened on; params are admitted by name and by
descriptor before anything is forwarded; credit is asked once per allow
window. The engine is a recorded ``_send_data``.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.base import OutOfCreditsError
from ai.account.models import RequestContext
from ai.modules.task import caller_stamp
from ai.modules.task.commands.cmd_data import DataCommands
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.types import TaskError

from .. import test_task_engine_sharing as sharing
from ..test_task_engine_sharing import _caller, _data_conn, _pipeline, _server, _start

# The sharing module's fixtures, under their own names
catalog = sharing.catalog
engines = sharing.engines

# =============================================================================
# HELPERS
# =============================================================================

EXPOSED = {'tone': 'prompt_1.instructions'}


@pytest.fixture
def engine_log(monkeypatch) -> List[Dict[str, Any]]:
    """The engine's data path, recorded: an open answers slot 1 on tree 7, everything else ok."""
    sent: List[Dict[str, Any]] = []

    async def send(self, request):
        sent.append({'engine': self, **request['arguments']})
        if request['arguments'].get('subcommand') == 'open':
            return {'body': {'pipe_id': 1, 'traceId': '1.1.7'}}
        return {'body': {'ok': True}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock())
    return sent


async def _frame(conn, **arguments):
    """One data frame through ``conn``; the response body."""
    response = await DataCommands.on_rrext_process(conn, {'command': 'rrext_process', 'arguments': arguments})
    return response['body']


async def _opened(ts, conn, **arguments):
    """Open a pipe on ``conn``'s control; the slot the engine answered."""
    body = await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain', **arguments)
    return body['pipe_id']


# =============================================================================
# STRIP THEN INJECT (S2)
# =============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize('subcommand', ['open', 'write', 'close', 'tool'])
async def test_a_client_sent_caller_never_reaches_the_engine(catalog, engines, engine_log, subcommand):
    """_caller and _ctx at the top level and inside the object info are removed on every subcommand."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    smuggled = {'userId': 'admin', 'params': {'prompt_1': {'instructions': 'be evil'}}}
    arguments: Dict[str, Any] = {'subcommand': subcommand, '_caller': smuggled, '_ctx': {'conn_id': 'internal:x'}}
    if subcommand == 'open':
        arguments.update(object={'name': 'x', '_caller': smuggled}, mimeType='text/plain')
    else:
        arguments['pipe_id'] = await _opened(ts, conn)
        engine_log.clear()
    if subcommand == 'tool':
        arguments['tool'] = 'ask'

    await _frame(conn, **arguments)

    forwarded = engine_log[-1]
    assert '_ctx' not in forwarded
    assert forwarded['_caller']['userId'] == 'user-a'
    assert forwarded['_caller']['params'] == {}
    if subcommand == 'open':
        assert '_caller' not in forwarded['object']


@pytest.mark.asyncio
async def test_the_stamp_names_the_control_and_its_request(catalog, engines, engine_log):
    """The server's _caller: the account, the control's team context, address and rung, the request id."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    await _opened(ts, conn)

    stamp = engine_log[0]['_caller']
    assert (stamp['userId'], stamp['orgId'], stamp['address'], stamp['rung']) == (
        'user-a',
        'org-1',
        control.address,
        'dev',
    )
    assert stamp['teamId'] == control.team_context.team_id
    assert stamp['correlationId'] == engine_log[0]['correlationId']
    assert len(stamp['correlationId']) == 32


@pytest.mark.asyncio
async def test_an_internal_connection_forwards_its_own_stamp(catalog, engines, engine_log):
    """A server-made connection (conn_id 'internal:...') is the one pass-through; a client never is."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    own = {'userId': 'internal:run-log', 'params': {}}
    conn.request_context = lambda: RequestContext.internal('run-log')

    await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain', _caller=own)

    assert engine_log[0]['_caller'] == own
    # The kind, not the bit: the OSS local identity carries 'internal' and is still stripped
    client = _data_conn(ts, control)
    client._account_info.sysPermissions = ['internal']
    client.request_context = lambda: RequestContext(account_info=client._account_info, conn_id='conn-5')
    await _frame(client, subcommand='open', object={'name': 'x'}, mimeType='text/plain', _caller=own)
    assert engine_log[1]['_caller']['userId'] == 'user-a'


# =============================================================================
# THE OPEN-PIPE RECORD (P1/P2)
# =============================================================================


@pytest.mark.asyncio
async def test_a_frame_on_a_slot_not_open_on_the_callers_control_is_refused_before_forwarding(
    catalog, engines, engine_log
):
    """Another holder's slot number, or a slot nobody opened: permission_denied, nothing sent."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    with pytest.raises(PermissionError):
        await _frame(conn, subcommand='write', pipe_id=1, data=b'x')
    assert engine_log == []

    # Opened by THIS control: the write goes through, under the open's request id
    slot = await _opened(ts, conn)
    await _frame(conn, subcommand='write', pipe_id=slot, data=b'x')
    assert engine_log[1]['_caller']['correlationId'] == engine_log[0]['correlationId']


@pytest.mark.asyncio
async def test_frames_of_an_open_pipe_stay_on_the_engine_it_opened_on(catalog, engines, engine_log):
    """A repoint between open and close never redirects the request: the record pins the engine."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    slot = await _opened(ts, conn)
    opened_on = engine_log[0]['engine']
    assert control.open_pipes[slot].engine is opened_on
    assert control.open_pipes[slot].trace_id == '1.1.7'

    # The control moves to another engine (what a repoint does)
    control.task = MagicMock(name='new-engine')

    await _frame(conn, subcommand='write', pipe_id=slot, data=b'x')
    await _frame(conn, subcommand='close', pipe_id=slot)

    assert [f['engine'] for f in engine_log] == [opened_on, opened_on, opened_on]
    # The close retired the record
    assert slot not in control.open_pipes


@pytest.mark.asyncio
async def test_a_close_retires_the_record_even_when_the_engine_fails(catalog, engines, engine_log, monkeypatch):
    """A failed close must not leave a slot the next open could collide with."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    slot = await _opened(ts, conn)
    monkeypatch.setattr(TaskEngine, '_send_data', AsyncMock(side_effect=RuntimeError('engine gone')))

    with pytest.raises(RuntimeError):
        await _frame(conn, subcommand='close', pipe_id=slot)
    assert control.open_pipes == {}


# =============================================================================
# PARAMS (S3)
# =============================================================================


@pytest.mark.asyncio
async def test_params_are_admitted_by_name_and_by_descriptor_and_ride_the_stamp(catalog, engines, engine_log):
    """A good value lands per node by schema path; a bad value is param_rejected by name; nothing is forwarded."""
    ts = _server()
    control = await _start(ts, _pipeline(parameters=EXPOSED))
    conn = _data_conn(ts, control)

    await _opened(ts, conn, params={'tone': 'dry'})
    assert engine_log[0]['_caller']['params'] == {'prompt_1': {'instructions': 'dry'}}
    assert 'params' not in engine_log[0]

    with pytest.raises(TaskError) as err:
        await _opened(ts, conn, params={'tone': 7})
    assert err.value.code == TaskError.PARAM_REJECTED
    assert err.value.errors[0]['name'] == 'tone'
    assert len(engine_log) == 1


@pytest.mark.asyncio
async def test_the_node_schema_is_resolved_once_per_control(catalog, engines, engine_log, monkeypatch):
    """The resolved view is cached on the control for the pipeline's life and dropped with it."""
    from ai.common import node_config

    calls = []
    real = node_config.resolve_node_config
    monkeypatch.setattr(node_config, 'resolve_node_config', lambda p, c: (calls.append(p), real(p, c))[1])
    ts = _server()
    control = await _start(ts, _pipeline(parameters=EXPOSED))
    conn = _data_conn(ts, control)
    before = len(calls)

    for value in ('a', 'b', 'c'):
        await _opened(ts, conn, params={'tone': value})
    assert calls[before:] == ['prompt']

    control.setup_declared_parameters()
    assert control.param_views == {}


# =============================================================================
# CREDIT (S9)
# =============================================================================


@pytest.mark.asyncio
async def test_out_of_credit_is_refused_before_any_bytes_reach_the_engine(catalog, engines, engine_log, monkeypatch):
    """The paying unit is asked on the open; a refusal is out_of_credits and nothing is forwarded."""
    import ai.account

    monkeypatch.setattr(ai.account.account, 'check_spend', AsyncMock(return_value='no credit left'), raising=False)
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    with pytest.raises(OutOfCreditsError):
        await _opened(ts, conn)
    assert engine_log == []


@pytest.mark.asyncio
async def test_an_allow_is_trusted_for_the_window_and_a_refusal_never_is(catalog, engines, engine_log, monkeypatch):
    """One ledger question per control per allow window; a refusal is asked again on the next request."""
    import ai.account

    asked = AsyncMock(return_value=None)
    monkeypatch.setattr(ai.account.account, 'check_spend', asked, raising=False)
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    for _ in range(3):
        await _opened(ts, conn)
    assert asked.await_count == 1

    # The window lapsed: asked again; a refusal is remembered by nobody
    control.credit_allowed_at = time.monotonic() - 3600
    asked.return_value = 'broke'
    for _ in range(2):
        with pytest.raises(OutOfCreditsError):
            await _opened(ts, conn)
    assert asked.await_count == 3


# =============================================================================
# OVERHEAD
# =============================================================================


def test_the_stamp_and_record_cost_microseconds():
    """The per-frame additions (strip, stamp, record) stay well under a tenth of a millisecond each."""
    ts = _server()
    control = MagicMock(address='acme.docBrain.webhook_1', rung='dev', orgId='org-1', env={}, trace_level=None)
    control.team_context.team_id = 'team-1'
    conn = MagicMock(_account_info=_caller(), request_context=None)
    arguments = {'subcommand': 'write', 'pipe_id': 1, 'data': b'x' * 65536, '_caller': {'userId': 'x'}}
    rounds = 2000

    started = time.perf_counter()
    for i in range(rounds):
        caller_stamp.prepare(conn, control, arguments, correlation_id='req', params=None)
    per_frame = (time.perf_counter() - started) / rounds

    assert per_frame < 100e-6, f'{per_frame * 1e6:.1f} us per frame'
    assert ts is not None
