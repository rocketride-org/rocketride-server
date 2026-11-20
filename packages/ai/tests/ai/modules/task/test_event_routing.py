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

"""Event and log isolation on a shared engine (plan 7.5, S14): routing by traceId, the OPS stream, per-control status.

Two users on ONE engine: a holder sees its own request trees' flow and SSE
only, engine-level output goes to the ops stream, every holder's status is
projected to its own counts and the engine's availability, and the connection
that opened a binding is delivered first.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from rocketride import EVENT_TYPE

from ai.account.models import AccountInfo
from ai.constants import CONST_BINDING_GRACE_SECONDS
from ai.modules.task.commands.cmd_data import DataCommands
from ai.modules.task.commands.cmd_monitor import MonitorCommands
from ai.modules.task.task_control import ControlStats, TaskControl
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.task_server import TaskServer
from ai.modules.task.trace_owner import TraceOwners

from . import test_task_engine_sharing as sharing
from .test_task_engine_sharing import _caller, _data_conn, _pipeline, _server, _start

catalog = sharing.catalog
engines = sharing.engines

# =============================================================================
# HELPERS
# =============================================================================


async def _two_holders(ts, *, shared=False):
    """One owner Plays one shape under two project ids: two controls, ONE engine.

    ``shared`` marks the engine cross-user so the routing rules of a shared
    engine (plan 7.5; no such engine starts before C.25) are exercised on it.
    """
    a = await _start(ts, _pipeline(), user='user-a')
    b = await _start(ts, _pipeline(project_id='docBrainCopy'), user='user-a')
    assert a.task is b.task and not a.task.shared
    a.task.shared = shared
    return a, b


def _capture(ts):
    """Record every task and server broadcast the server makes."""
    ts.broadcast_task_event = AsyncMock()
    ts.broadcast_server_event = AsyncMock()
    return ts.broadcast_task_event, ts.broadcast_server_event


def _unlogged(engine):
    """No run-log store in these tests: every holder is marked unlogged up front."""
    engine._run_log_failed = set(engine.holds)


# =============================================================================
# TRACE OWNERS
# =============================================================================


def test_a_claimed_tree_belongs_to_its_control_until_released_and_for_the_grace_after():
    owners = TraceOwners()
    owners.claim('1.1.7', 'dev.user-a.acme.docBrain.webhook_1', 42)

    live = owners.owner('1.1.7')
    assert (live.control_key, live.conn_id, live.late) == ('dev.user-a.acme.docBrain.webhook_1', 42, False)

    owners.release('1.1.7', now=1000.0)
    late = owners.owner('1.1.7', now=1000.0 + CONST_BINDING_GRACE_SECONDS / 2)
    assert late.late is True and late.control_key == 'dev.user-a.acme.docBrain.webhook_1'
    assert owners.owner('1.1.7', now=1000.0 + CONST_BINDING_GRACE_SECONDS) is None
    assert owners.owner('nope') is None


def test_a_tree_never_changes_hands_and_a_gone_control_takes_its_trees():
    owners = TraceOwners()
    owners.claim('1.1.7', 'ctrl-a', 1)
    owners.claim('1.1.7', 'ctrl-b', 2)
    assert owners.owner('1.1.7').control_key == 'ctrl-a'

    owners.claim('1.1.8', 'ctrl-a', 1)
    owners.release('1.1.8', now=5.0)
    owners.forget_control('ctrl-a')
    assert owners.owner('1.1.7') is None and owners.owner('1.1.8', now=5.0) is None and len(owners) == 0


# =============================================================================
# ROUTING BY TRACE ID
# =============================================================================


@pytest.mark.asyncio
async def test_a_pipe_tagged_event_reaches_the_trees_owner_only_opener_first(catalog, engines):
    """An SSE of A's request goes to A's control alone, with A's opener connection named."""
    ts = _server()
    a, b = await _two_holders(ts)
    task_events, _ops = _capture(ts)
    engine = a.task
    _unlogged(engine)
    ts.trace_owners.claim(a.task.trace_ref(7), a.key, 11)

    await engine._forward_task_event(EVENT_TYPE.SSE, {'event': 'apaevt_sse', 'body': {'traceId': 7, 'type': 'x'}})

    task_events.assert_awaited_once()
    kwargs = task_events.await_args.kwargs
    assert kwargs['key'] == a.key and kwargs['opener'] == 11
    assert kwargs['event']['body']['controlId'] == a.key
    assert kwargs['event']['body']['traceId'] == a.task.trace_ref(7)
    assert 'late' not in kwargs['event']['body']


@pytest.mark.asyncio
async def test_a_late_event_within_the_grace_still_reaches_its_owner_stamped_late(catalog, engines):
    ts = _server()
    a, _b = await _two_holders(ts)
    task_events, _ops = _capture(ts)
    _unlogged(a.task)
    ts.trace_owners.claim(a.task.trace_ref(7), a.key, 11)
    ts.trace_owners.release(a.task.trace_ref(7))

    await a.task._forward_task_event(EVENT_TYPE.SSE, {'event': 'apaevt_sse', 'body': {'traceId': 7, 'type': 'x'}})

    body = task_events.await_args.kwargs['event']['body']
    assert body['controlId'] == a.key and body['late'] is True


@pytest.mark.asyncio
async def test_an_event_of_a_released_tree_goes_to_ops_on_a_shared_engine_never_to_the_next_holder(catalog, engines):
    ts = _server()
    a, _b = await _two_holders(ts, shared=True)
    task_events, ops = _capture(ts)
    _unlogged(a.task)
    ts.trace_owners.claim(a.task.trace_ref(7), a.key, 11)
    ts.trace_owners.release(a.task.trace_ref(7), now=time.monotonic() - CONST_BINDING_GRACE_SECONDS - 1)

    await a.task._forward_task_event(EVENT_TYPE.SSE, {'event': 'apaevt_sse', 'body': {'traceId': 7, 'type': 'x'}})

    task_events.assert_not_awaited()
    ops.assert_awaited_once()
    event_type, event = ops.await_args.args
    assert event_type is EVENT_TYPE.OPS and event['event'] == 'apaevt_ops'
    assert (event['body']['kind'], event['body']['engineKey']) == ('apaevt_sse', a.task.engine_key)


@pytest.mark.asyncio
async def test_on_a_private_engine_an_unowned_binding_is_the_owners(catalog, engines):
    """A scan source's own getPipe has no record: on a (hash, owner) engine its events are the owner's."""
    ts = _server()
    control = await _start(ts, _pipeline(extra={'id': 'local_1', 'provider': 'local_tool', 'config': {}}))
    assert not control.task.shared
    task_events, ops = _capture(ts)
    _unlogged(control.task)

    await control.task._forward_task_event(EVENT_TYPE.SSE, {'event': 'apaevt_sse', 'body': {'traceId': 9}})

    assert task_events.await_args.kwargs['key'] == control.key
    ops.assert_not_awaited()


# =============================================================================
# ENGINE-LEVEL OUTPUT
# =============================================================================


@pytest.mark.asyncio
async def test_engine_level_output_of_a_shared_engine_is_ops_only(catalog, engines):
    """Counts, errors, bare output and the debugger channel never reach a holder of a shared engine."""
    ts = _server()
    a, _b = await _two_holders(ts, shared=True)
    task_events, ops = _capture(ts)
    _unlogged(a.task)

    await a.task._forward_task_event(EVENT_TYPE.DETAIL, {'event': 'apaevt_status_error', 'body': {'message': 'boom'}})
    await a.task._forward_task_event(EVENT_TYPE.OUTPUT, {'event': 'output', 'body': {'output': 'print()'}})

    task_events.assert_not_awaited()
    assert [c.args[1]['body']['kind'] for c in ops.await_args_list] == ['apaevt_status_error', 'output']


@pytest.mark.asyncio
async def test_engine_level_output_of_a_private_engine_reaches_its_owners_controls(catalog, engines):
    ts = _server()
    control = await _start(ts, _pipeline(extra={'id': 'local_1', 'provider': 'local_tool', 'config': {}}))
    task_events, ops = _capture(ts)
    _unlogged(control.task)

    await control.task._forward_task_event(
        EVENT_TYPE.DETAIL, {'event': 'apaevt_status_error', 'body': {'message': 'x'}}
    )

    assert task_events.await_args.kwargs['key'] == control.key
    ops.assert_not_awaited()


@pytest.mark.asyncio
async def test_every_holder_gets_its_own_projected_status(catalog, engines):
    """Status reaches both holders; each sees its own counts and the engine's availability, never the engine's totals."""
    ts = _server()
    a, b = await _two_holders(ts, shared=True)
    task_events, ops = _capture(ts)
    _unlogged(a.task)
    a.stats = ControlStats(totalCount=3, completedCount=2, failedCount=1, completedSize=200, failedSize=50)
    status = {
        'event': 'apaevt_status_update',
        'body': {'completedCount': 99, 'errors': ['engine wide'], 'rateCount': 7},
    }

    await a.task._forward_task_event(EVENT_TYPE.SUMMARY, status)

    bodies = {c.kwargs['key']: c.kwargs['event']['body'] for c in task_events.await_args_list}
    assert set(bodies) == {a.key, b.key}
    assert (bodies[a.key]['completedCount'], bodies[a.key]['failedCount']) == (2, 1)
    assert bodies[b.key]['completedCount'] == 0
    assert all(body['errors'] == [] and body['rateCount'] == 0 for body in bodies.values())
    assert all(body['engine']['availability'] == 'running' for body in bodies.values())
    ops.assert_not_awaited()


def test_project_status_passes_a_private_engines_counts_through_with_the_availability():
    control = TaskControl()
    control.task = SimpleNamespace(dormant_reason=None, state=None, is_live=True)
    control.engine_starting = False
    body = control.project_status({'completedCount': 5, 'errors': ['e']}, shared=False)
    assert body['completedCount'] == 5 and body['errors'] == ['e'] and 'availability' in body['engine']


def test_project_status_scrubs_a_shared_engines_diagnostics_metrics_and_tokens():
    """A holder of a shared engine sees its own counts; the engine's resource and token totals are platform signal."""
    control = TaskControl()
    control.task = SimpleNamespace(dormant_reason=None, state=None, is_live=True)
    control.engine_starting = False
    status = {'completedCount': 5, 'errors': ['e'], 'metrics': {'cpu_percent': 50.0}, 'tokens': {'total': 9.0}}
    body = control.project_status(status, shared=True)
    assert body['completedCount'] == 0 and body['errors'] == []
    assert body['metrics']['cpu_percent'] == 0.0 and body['tokens']['total'] == 0.0


def test_project_status_expands_the_notes_placeholders_with_the_controls_own_address():
    """The engine stores notes as emitted; two controls of one owner holding one
    private engine under different addresses each see their own door.
    """
    stored = [
        {'url-link': '{host}/webhook/{address}', 'address': '{address}', 'lanes': ['json']},
        'send to {token} ({project_id}/{source})',
        42,
    ]
    bodies = {}
    for address, project_id in (('acme.docBrain.webhook_1', 'docBrain'), ('acme.leadSync.webhook_1', 'leadSync')):
        control = TaskControl()
        control.task = SimpleNamespace(dormant_reason=None, state=None, is_live=True)
        control.engine_starting = False
        control.address = address
        control.project_id = project_id
        bodies[address] = control.project_status({'notes': stored}, shared=False)
    assert bodies['acme.docBrain.webhook_1']['notes'] == [
        {'url-link': '{host}/webhook/acme.docBrain.webhook_1', 'address': 'acme.docBrain.webhook_1', 'lanes': ['json']},
        'send to acme.docBrain.webhook_1 (docBrain/webhook_1)',
        42,
    ]
    assert bodies['acme.leadSync.webhook_1']['notes'][1] == 'send to acme.leadSync.webhook_1 (leadSync/webhook_1)'
    # The stored notes were not modified: the next holder expands its own.
    assert stored[1] == 'send to {token} ({project_id}/{source})'
    # A shared engine's notes are scrubbed, expanded or not.
    assert control.project_status({'notes': stored}, shared=True)['notes'] == []


def test_project_status_fills_the_open_tool_notes_node_id_with_the_controls_source():
    """A source's `open-tool` note (plan 3.6) names the node as `{source}`: the
    last segment of the control's address IS the source's component id, so
    two controls of one engine each get a button bound to their own source.
    """
    stored = [
        {'button-text': 'Open Chat', 'open-tool': 'rocketride.chat', 'nodeId': '{source}', 'address': '{address}'}
    ]
    control = TaskControl()
    control.task = SimpleNamespace(dormant_reason=None, state=None, is_live=True)
    control.engine_starting = False
    control.address = 'acme.docBrain.chat_1'
    control.project_id = 'docBrain'
    assert control.project_status({'notes': stored}, shared=False)['notes'] == [
        {
            'button-text': 'Open Chat',
            'open-tool': 'rocketride.chat',
            'nodeId': 'chat_1',
            'address': 'acme.docBrain.chat_1',
        }
    ]


# =============================================================================
# OPENER FIRST AND THE OPS GATE
# =============================================================================


@pytest.mark.asyncio
async def test_the_opener_is_delivered_first_and_skipped_in_the_fan_out():
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {'k': object()}
    ts.debug_message = MagicMock()
    order = []

    def conn(name):
        c = MagicMock()

        async def send(event_type, key, event, direct=False):
            order.append((name, direct))

        c.send_task_event = send
        return c

    ts._connections = {1: conn('opener'), 2: conn('other')}

    await ts.broadcast_task_event(EVENT_TYPE.SSE, 'k', {'event': 'apaevt_sse', 'body': {}}, opener=1)

    assert order == [('opener', True), ('other', False)]


@pytest.mark.asyncio
async def test_a_direct_delivery_needs_no_subscription_but_still_the_permission():
    conn = MonitorCommands.__new__(MonitorCommands)
    conn._monitors = {}
    conn._server = SimpleNamespace(control_by_key=lambda key: SimpleNamespace(id='t', address='acme.p.s'))
    conn._account_info = _caller()
    conn.verify_permission = MagicMock()
    conn.send_event = AsyncMock()
    control = SimpleNamespace(
        id='t',
        address='acme.p.s',
        run_kind='dev',
        owner_kind='user',
        owner_id='user-a',
        userId='user-a',
        teamId='team-1',
        project_id='p',
        source='s',
    )
    conn._server = SimpleNamespace(control_by_key=lambda key: control)

    await conn.send_task_event(EVENT_TYPE.SSE, 'k', {'event': 'apaevt_sse', 'body': {'x': 1}}, direct=True)

    conn.verify_permission.assert_called_with('task.data')
    conn.send_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_ops_is_masked_at_delivery_for_a_non_operator():
    conn = MonitorCommands.__new__(MonitorCommands)
    conn._monitors = {'*': EVENT_TYPE.OPS | EVENT_TYPE.SUMMARY}
    conn._account_info = AccountInfo(userId='u', sysPermissions=[])
    conn.send_event = AsyncMock()

    await conn.send_server_event(EVENT_TYPE.OPS, {'event': 'apaevt_ops', 'body': {}})
    conn.send_event.assert_not_awaited()

    conn._account_info = AccountInfo(userId='u', sysPermissions=['sys.admin'])
    await conn.send_server_event(EVENT_TYPE.OPS, {'event': 'apaevt_ops', 'body': {}})
    conn.send_event.assert_awaited_once()


def test_all_does_not_include_ops():
    assert not EVENT_TYPE.ALL & EVENT_TYPE.OPS


# =============================================================================
# THE DATA PATH CLAIMS AND RELEASES TREES
# =============================================================================


@pytest.fixture
def engine_log(monkeypatch):
    """An engine whose open answers tree 7 on slot 1."""
    sent = []

    async def send(self, request):
        sent.append(request['arguments'])
        if request['arguments'].get('subcommand') == 'open':
            return {'body': {'pipeId': 1, 'traceId': '1.1.7'}}
        if request['arguments'].get('subcommand') == 'tool':
            return {'body': {'result': 1, 'traceId': '1.1.8'}}
        return {'body': {'ok': True}}

    monkeypatch.setattr(TaskEngine, '_send_data', send)
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock())
    return sent


async def _frame(conn, **arguments):
    response = await DataCommands.on_rrext_process(conn, {'command': 'rrext_process', 'arguments': arguments})
    return response['body']


@pytest.mark.asyncio
async def test_an_open_claims_the_tree_and_a_close_releases_it_counting_the_binding(catalog, engines, engine_log):
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain')
    owner = ts.trace_owners.owner('1.1.7')
    assert (owner.control_key, owner.conn_id, owner.late) == (control.key, 1, False)
    assert control.stats.totalCount == 1

    await _frame(conn, subcommand='write', pipeId=1, data=b'12345')
    await _frame(conn, subcommand='close', pipeId=1)
    assert ts.trace_owners.owner('1.1.7').late is True
    assert (control.stats.completedCount, control.stats.completedSize, control.stats.failedCount) == (1, 5, 0)


@pytest.mark.asyncio
async def test_a_failed_close_counts_the_binding_failed(catalog, engines, engine_log, monkeypatch):
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)
    await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain')
    monkeypatch.setattr(TaskEngine, '_send_data', AsyncMock(side_effect=RuntimeError('gone')))

    with pytest.raises(RuntimeError):
        await _frame(conn, subcommand='close', pipeId=1)
    assert (control.stats.failedCount, control.stats.completedCount) == (1, 0)
    assert ts.trace_owners.owner('1.1.7').late is True


@pytest.mark.asyncio
async def test_a_borrowed_tool_pipe_is_claimed_and_released_in_one_frame(catalog, engines, engine_log):
    ts = _server()
    control = await _start(ts, _pipeline())
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='tool', tool='ask')

    assert ts.trace_owners.owner('1.1.8').late is True
    assert (control.stats.totalCount, control.stats.completedCount) == (1, 1)


@pytest.mark.asyncio
async def test_a_claim_names_the_publication_that_answered(catalog, engines, engine_log):
    """The usage row is keyed by the answering publication (plan 8.2): the claim carries its slot and version."""
    from ai.modules.task.task_control import DeploymentRef

    ts = _server()
    control = await _start(ts, _pipeline())
    assert control.publication() == ('', None)  # a dev run serves through no publication
    control.deployment = DeploymentRef(org_id='org-1', team_id='team-staging', project_id='docBrain')
    control.version = 5
    conn = _data_conn(ts, control)

    await _frame(conn, subcommand='open', object={'name': 'x'}, mimeType='text/plain')

    owner = ts.trace_owners.owner('1.1.7')
    assert (owner.team, owner.version) == ('team-staging', 5)
    ts.trace_owners.release('1.1.7')
    late = ts.trace_owners.owner('1.1.7')
    assert late.late is True and (late.team, late.version) == ('team-staging', 5)
