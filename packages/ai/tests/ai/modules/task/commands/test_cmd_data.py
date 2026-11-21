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

Every frame is stripped of client-sent context (``_caller``, ``_ctx``,
``config``, ``controlId``) and stamped with the server's ``_caller`` (the
control id on every frame, the control's config on the open); a frame naming
a pipe must find it on the CALLER's control and goes to the engine that pipe
opened on; the token slot names a control id, re-checked against the caller,
and a frame that starts a binding (an open, a standalone ``tool`` borrow) may
name an address instead, answered with the control id; params are
admitted by name and by descriptor before anything is forwarded; credit is
asked once per allow window. The engine is a recorded ``_send_data``.
"""

from __future__ import annotations

import time
from types import MethodType
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.base import OutOfCreditsError
from ai.account.models import RequestContext
from ai.modules.task import caller_stamp
from ai.modules.task.commands.cmd_data import DataCommands
from ai.modules.task.task_conn import TaskConn
from ai.modules.task.task_control import is_control_id
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
    """The engine's data path, recorded: opens answer slots 1, 2, ... on trees 7, 8, ...; everything else ok."""
    sent: List[Dict[str, Any]] = []
    opened = {'count': 0}

    async def send(self, request):
        sent.append({'engine': self, **request['arguments']})
        if request['arguments'].get('subcommand') == 'open':
            opened['count'] += 1
            return {'body': {'pipeId': opened['count'], 'traceId': f'1.1.{6 + opened["count"]}'}}
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
    return body['pipeId']


# =============================================================================
# CREDIT AT START (plan 0 S9)
# =============================================================================


@pytest.mark.asyncio
async def test_a_dev_run_whose_org_is_out_of_credit_is_refused_at_start(catalog, engines, monkeypatch):
    """An owned run's paying unit is checked before anything launches."""
    import ai.account

    check = AsyncMock(return_value='no credit left')
    monkeypatch.setattr(ai.account.account, 'check_spend', check, raising=False)
    ts = _server()
    with pytest.raises(OutOfCreditsError):
        await _start(ts, _pipeline())
    assert engines == []
    check.assert_awaited_once_with('org-1')


# =============================================================================
# STRIP THEN INJECT (S2)
# =============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize('identity', ['saas', 'oss'])
@pytest.mark.parametrize('subcommand', ['open', 'write', 'close', 'tool'])
async def test_a_client_sent_reserved_key_never_reaches_the_engine(catalog, engines, engine_log, subcommand, identity):
    """The four reserved keys (``_caller``, ``_ctx``, ``config``, ``controlId``) are removed at the top level and
    inside the object info on every subcommand, for a SaaS client and for the OSS local identity alike.
    """
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    if identity == 'oss':
        # The OSS local identity carries the internal bit and is still a client connection
        conn._account_info.sysPermissions = ['internal']
        conn.request_context = lambda: RequestContext(account_info=conn._account_info, conn_id='conn-1')
    smuggled = {
        'userId': 'admin',
        'params': {'prompt_1': {'instructions': 'be evil'}},
        'controlId': '=control/' + 'f' * 32,
    }
    reserved: Dict[str, Any] = {
        '_caller': smuggled,
        '_ctx': {'conn_id': 'internal:x'},
        'config': [{'instructions': ['be evil']}],
        'controlId': '=control/' + 'f' * 32,
    }
    arguments: Dict[str, Any] = {'subcommand': subcommand, **reserved}
    if subcommand == 'open':
        arguments.update(object={'name': 'x', **reserved}, mimeType='text/plain')
    else:
        arguments['pipeId'] = await _opened(ts, conn)
        engine_log.clear()
    if subcommand == 'tool':
        arguments['tool'] = 'ask'

    await _frame(conn, **arguments)

    forwarded = engine_log[-1]
    assert all(key not in forwarded for key in ('_ctx', 'config', 'controlId'))
    assert forwarded['_caller']['userId'] == 'user-a'
    assert forwarded['_caller']['params'] == {}
    # The server's own control id and, on the open only (the tool frame here is attached), the control's config
    assert forwarded['_caller']['controlId'] == control.control_id
    assert ('config' in forwarded['_caller']) == (subcommand == 'open')
    if subcommand == 'open':
        assert all(key not in forwarded['object'] for key in reserved)
        assert forwarded['_caller']['config'] != reserved['config']


@pytest.mark.asyncio
async def test_the_open_carries_the_controls_config_by_stack_index_and_the_other_frames_do_not(
    catalog, engines, engine_log
):
    """``_caller.config`` is the resolved component config in the spec's component order, on the open only (plan 5.3)."""
    ts = _server()
    control = await _start(ts, _pipeline(instructions=['dry']))
    conn = _data_conn(ts, control)

    slot = await _opened(ts, conn)
    await _frame(conn, subcommand='write', pipeId=slot, data=b'x')
    await _frame(conn, subcommand='close', pipeId=slot)

    opened, written, closed = engine_log
    assert opened['_caller']['config'] == control.config
    # As the spec stores it (the engine resolves it), by stack index: the prompt's instructions, the
    # webhook's empty config
    names = control.index_map
    assert opened['_caller']['config'][names.to_index('prompt_1')] == {'instructions': ['dry']}
    assert opened['_caller']['config'][names.to_index('webhook_1')] == {}
    assert 'config' not in written['_caller'] and 'config' not in closed['_caller']
    assert {f['_caller']['controlId'] for f in engine_log} == {control.control_id}


# =============================================================================
# WHICH FRAMES MAY START A PUBLICATION (plan 3.6: a tool borrow is its own binding)
# =============================================================================


@pytest.mark.asyncio
async def test_a_standalone_tool_frame_with_an_address_resolves_like_submit(catalog, engines, engine_log):
    """A ``tool`` frame naming no pipe opens its own binding: an ADDRESS in its token slot resolves the way
    submit() does, so it may start a dormant publication (plan 3.6).
    """
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='tool', tool='dialect', nodeId='db_1', input={}, token=control.address)

    ts.resolve_target.assert_awaited_once()
    conn.get_control.assert_not_called()
    assert engine_log[-1]['subcommand'] == 'tool'


@pytest.mark.asyncio
async def test_a_standalone_tool_frame_carries_the_config_and_an_attached_one_does_not(catalog, engines, engine_log):
    """A standalone tool borrow is its own binding, often the control's first frame on the engine: its _caller
    carries the control's config like an open; a tool call on an open pipe carries the control id alone.
    """
    ts = _server()
    control = await _start(ts, _pipeline(instructions=['dry']))
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='tool', tool='dialect', nodeId='db_1', input={}, token=control.control_id)
    slot = await _opened(ts, conn)
    await _frame(conn, subcommand='tool', tool='ask', pipeId=slot)

    standalone, opened, attached = engine_log
    assert standalone['_caller']['config'] == control.config == opened['_caller']['config']
    assert 'config' not in attached['_caller']
    assert {f['_caller']['controlId'] for f in engine_log} == {control.control_id}


@pytest.mark.asyncio
async def test_a_binding_is_its_controls_from_before_its_first_frame_until_it_ends(catalog, engines, monkeypatch):
    """A node's self.state/self.files name the binding by its correlationId: the engine resolves it from before the
    open or the standalone tool call reaches the subprocess, and forgets it when the binding ends (plan 5.7).
    """
    seen, used = [], set()

    async def send(self, request):
        arguments = request['arguments']
        used.add(self)
        seen.append((arguments['subcommand'], self.binding_control(arguments['_caller']['correlationId'])))
        if arguments.get('subcommand') == 'open':
            return {'body': {'pipeId': 1, 'traceId': '1.1.7'}}
        return {'body': {'ok': True}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock())
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='tool', tool='dialect', nodeId='db_1', input={}, token=control.control_id)
    slot = await _opened(ts, conn)
    await _frame(conn, subcommand='close', pipeId=slot)

    assert seen == [('tool', control), ('open', control), ('close', control)]
    assert all(engine._bindings == {} for engine in used)


@pytest.mark.asyncio
async def test_a_standalone_tool_frame_with_a_control_id_is_the_controls(catalog, engines, engine_log):
    """A ``=control/`` token on a standalone ``tool`` frame is a control id: the registry hit and the caller check, no resolution."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='tool', tool='dialect', nodeId='db_1', input={}, token=control.control_id)

    conn.get_control.assert_called_once()
    ts.resolve_target.assert_not_awaited()
    assert engine_log[-1]['_caller']['controlId'] == control.control_id


@pytest.mark.asyncio
async def test_an_open_by_address_resolves_like_submit_and_answers_with_the_control_id(catalog, engines, engine_log):
    """send/pipe and the HTTP door open by ADDRESS (plan section 1): the open resolves it the way submit() does,
    starting a dormant publication, and answers with the control id and address the pipe's later frames name.
    """
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    body = await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain', token=control.address)

    ts.resolve_target.assert_awaited_once()
    conn.get_control.assert_not_called()
    assert body['pipeId'] == 1
    assert body['controlId'] == control.control_id and body['address'] == control.address
    assert engine_log[-1]['_caller']['controlId'] == control.control_id


@pytest.mark.asyncio
async def test_an_open_by_control_id_is_the_controls_and_answers_with_it(catalog, engines, engine_log):
    """A ``=control/`` token on an open is a control id: the registry hit and the caller check, no resolution."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    body = await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain', token=control.control_id)

    conn.get_control.assert_called_once()
    ts.resolve_target.assert_not_awaited()
    assert body['controlId'] == control.control_id


@pytest.mark.asyncio
async def test_a_frame_on_an_open_pipe_names_a_control_id_never_an_address(catalog, engines, engine_log):
    """Once a pipe is open its frames name the control id the open answered with: an address could resolve to a
    sibling control by then (one project_id, several configurations), so it is refused before anything is forwarded.
    """
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    slot = await _opened(ts, conn, token=control.address)
    conn.get_control = MethodType(TaskConn.get_control, conn)
    conn.get_token_slot = MethodType(TaskConn.get_token_slot, conn)
    forwarded = len(engine_log)

    with pytest.raises(PermissionError, match='control id'):
        await _frame(conn, subcommand='write', pipeId=slot, data=b'x', token=control.address)
    assert len(engine_log) == forwarded

    await _frame(conn, subcommand='write', pipeId=slot, data=b'x', token=control.control_id)
    assert engine_log[-1]['subcommand'] == 'write'


@pytest.mark.asyncio
async def test_a_foreign_or_unknown_control_id_is_permission_denied_never_not_found(catalog, engines, engine_log):
    """Every verb re-checks the caller against the control it names; the registry is no existence oracle."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a')
    theirs = _data_conn(ts, control)
    theirs._account_info = _caller('user-b')
    theirs.get_control = MethodType(TaskConn.get_control, theirs)
    theirs.get_token_slot = MethodType(TaskConn.get_token_slot, theirs)

    for token in (control.control_id, '=control/' + 'e' * 32):
        with pytest.raises(PermissionError, match='not your control') as refused:
            await _opened(ts, theirs, token=token)
        assert not isinstance(refused.value, TaskError)
    assert engine_log == []

    # The owner, and an operator, reach it
    assert ts.control_by_id(control.control_id, _caller('user-a'), 'task.data') is control
    admin = _caller('user-c')
    admin.sysPermissions = ['sys.admin']
    assert ts.control_by_id(control.control_id, admin, 'task.data') is control
    assert is_control_id(control.control_id)


@pytest.mark.asyncio
@pytest.mark.parametrize('subcommand', ['write', 'close', 'tool'])
async def test_a_frame_on_an_open_pipe_attaches_only(catalog, engines, engine_log, subcommand):
    """A frame naming a pipe lands on the control the open found and never starts anything."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    pipe_id = await _opened(ts, conn)
    ts.resolve_target.reset_mock()
    conn.get_control.reset_mock()
    arguments: Dict[str, Any] = {'subcommand': subcommand, 'pipeId': pipe_id}
    if subcommand == 'tool':
        arguments['tool'] = 'ask'

    await _frame(conn, **arguments)

    ts.resolve_target.assert_not_awaited()
    conn.get_control.assert_called_once()


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
        'spec',
    )
    assert stamp['controlId'] == control.control_id and is_control_id(stamp['controlId'])
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
        await _frame(conn, subcommand='write', pipeId=1, data=b'x')
    assert engine_log == []

    # Opened by THIS control: the write goes through, under the open's request id
    slot = await _opened(ts, conn)
    await _frame(conn, subcommand='write', pipeId=slot, data=b'x')
    assert engine_log[1]['_caller']['correlationId'] == engine_log[0]['correlationId']


@pytest.mark.asyncio
async def test_frames_of_an_open_pipe_stay_on_the_engine_it_opened_on(catalog, engines, engine_log):
    """The record pins the engine: later frames go where the pipe opened, whatever the control holds now."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    slot = await _opened(ts, conn)
    opened_on = engine_log[0]['engine']
    assert control.open_pipes[slot].engine is opened_on
    assert control.open_pipes[slot].trace_id == '1.1.7'

    # The control moves to another engine (an engine started again for a dormant control)
    control.task = MagicMock(name='new-engine')

    await _frame(conn, subcommand='write', pipeId=slot, data=b'x')
    await _frame(conn, subcommand='close', pipeId=slot)

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
        await _frame(conn, subcommand='close', pipeId=slot)
    assert control.open_pipes == {}


@pytest.mark.asyncio
async def test_a_close_whose_object_failed_counts_a_failed_binding(catalog, engines, engine_log, monkeypatch):
    """The engine answers a close normally for an object the pipeline failed; the error on the body is the verdict."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    slot = await _opened(ts, conn)
    monkeypatch.setattr(TaskEngine, '_send_data', AsyncMock(return_value={'body': {'error': 'node raised'}}))

    body = await _frame(conn, subcommand='close', pipeId=slot)

    assert body == {'error': 'node raised'}
    assert control.open_pipes == {}
    assert (control.stats.completedCount, control.stats.failedCount) == (0, 1)


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
    """The resolved view is cached on the control for the pipeline's life and dropped with it.

    The start builds the open's config once (the typed-placeholder pass) and
    caches every component's view; the params of each open read that view,
    so no open resolves a schema again.
    """
    from ai.common import node_config

    calls = []
    real = node_config.resolve_node_config
    monkeypatch.setattr(node_config, 'resolve_node_config', lambda p, c: (calls.append(p), real(p, c))[1])
    ts = _server()
    control = await _start(ts, _pipeline(parameters=EXPOSED))
    conn = _data_conn(ts, control)
    assert set(control.param_views) == {'prompt_1', 'webhook_1'}
    before = len(calls)

    for value in ('a', 'b', 'c'):
        await _opened(ts, conn, params={'tone': value})
    assert calls[before:] == []

    control.setup_declared_parameters()
    assert control.param_views == {}


# =============================================================================
# CREDIT (S9)
# =============================================================================


@pytest.mark.asyncio
async def test_out_of_credit_is_refused_before_any_bytes_reach_the_engine(catalog, engines, engine_log, monkeypatch):
    """The paying unit is asked on the open; a refusal is out_of_credits and nothing is forwarded."""
    import ai.account

    check = AsyncMock(return_value=None)
    monkeypatch.setattr(ai.account.account, 'check_spend', check, raising=False)
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    # The account ran dry after the start (which asked once, plan 0 S9)
    check.return_value = 'no credit left'
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

    # The start asked once for the dev run's org (plan 0 S9); the data path's
    # own questions are what the window bounds
    asked.reset_mock()
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
    control = MagicMock(address='acme.docBrain.webhook_1', rung='spec', orgId='org-1', env={}, trace_level=None)
    control.control_id = '=control/' + 'a' * 32
    control.team_context.team_id = 'team-1'
    conn = MagicMock(_account_info=_caller(), request_context=None)
    arguments = {'subcommand': 'write', 'pipeId': 1, 'data': b'x' * 65536, '_caller': {'userId': 'x'}}
    rounds = 2000

    started = time.perf_counter()
    for i in range(rounds):
        caller_stamp.prepare(conn, control, arguments, correlation_id='req', params=None)
    per_frame = (time.perf_counter() - started) / rounds

    assert per_frame < 100e-6, f'{per_frame * 1e6:.1f} us per frame'
    assert ts is not None


# =============================================================================
# cancel: an attach-only frame on the request's own binding
# =============================================================================


@pytest.mark.asyncio
async def test_a_cancel_attaches_to_the_open_pipe_and_leaves_its_record_in_place(catalog, engines, engine_log):
    """Cancel rides the open-pipe record like a write: same engine, same request id, nothing retired."""
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    # Nobody opened slot 1 on this control: refused before anything is sent
    with pytest.raises(PermissionError):
        await _frame(conn, subcommand='cancel', pipeId=1)
    assert engine_log == []

    slot = await _opened(ts, conn)
    opened_on = engine_log[0]['engine']
    await _frame(conn, subcommand='cancel', pipeId=slot)

    # Forwarded to the engine the pipe opened on, under the open's request id
    assert engine_log[1]['engine'] is opened_on
    assert engine_log[1]['_caller']['correlationId'] == engine_log[0]['correlationId']
    # The binding is still open: the close that follows is what retires it
    assert slot in control.open_pipes
    await _frame(conn, subcommand='close', pipeId=slot)
    assert slot not in control.open_pipes
