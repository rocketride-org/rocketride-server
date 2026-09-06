# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Task replicas: N engine subprocesses behind ONE token.

One task is one engine subprocess is one model copy behind one lock, so a
single task runs one inference at a time however wide ``threads`` is.
``replicas`` is the lever that actually parallelises it — which only works if
the whole control, not just the primary, is what the server starts, routes
data to, ages for TTL, and tears down.

Covered here:

- ``resolve_replicas`` / ``resolve_torch_threads`` — parsing, clamping, the
  auto thread rule
- ``start_task`` — N engines registered under one token, distinct ids, a
  partial start failure tearing down the ones that came up
- ``TASK_CONTROL.pick_data_task`` — round-robin order, and skipping engines
  that are not running
- ``stop_task`` / ``remove_task`` — every replica torn down
- ``_monitor_ttl`` — the group is idle only when EVERY replica is
- the ``ROCKETRIDE_TASK_REPLICAS`` / ``ROCKETRIDE_TORCH_THREADS`` env parsing
"""

from __future__ import annotations

import asyncio
import importlib
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride import EVENT_TYPE, TASK_STATE

from ai.constants import CONST_MAX_REPLICAS, CONST_TORCH_THREAD_ENV_VARS
from ai.modules.task import task_server as ts_mod
from ai.modules.task.task_engine import Task
from ai.modules.task.task_server import (
    TASK_CONTROL,
    TaskServer,
    resolve_replicas,
    resolve_torch_threads,
)


class _LoopBreak(BaseException):
    """Sentinel used to escape the endless ``_monitor_ttl`` loop.

    Must NOT derive from Exception: the loop body swallows Exception so a bad
    task cannot kill TTL monitoring, and an Exception sentinel would be caught
    there and spin forever.
    """


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeTask:
    """A Task stand-in that records what the server did to it.

    Constructed exactly as ``start_task`` constructs the real one (all
    keyword arguments), so a signature change here fails loudly rather than
    silently passing a stale shape.
    """

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
        self.started = False
        self.stop_calls = []
        self._stop_requested = False
        self._ttl = 0
        self._idle_time = 0
        self._complete = False
        self._state = TASK_STATE.RUNNING.value

    async def start_task(self):
        self.started = True

    async def stop_task(self, reason='user'):
        self.stop_calls.append(reason)
        self._stop_requested = True

    async def wait_for_running(self):
        return None

    def is_debug_available(self):
        return False

    def is_task_complete(self):
        return self._complete

    def get_status(self):
        return SimpleNamespace(state=self._state, endTime=0.0)


def _make_server():
    """A TaskServer with no event loop, no ports, and no real account service."""
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
    ts._server.account.generate_token.return_value = 'tk_generated'
    ts.debug_message = MagicMock()
    return ts


def _pipeline():
    return {
        'project_id': 'project-1',
        'source': 'src',
        'components': [
            {'id': 'src', 'provider': 'webhook', 'config': {}},
            {'id': 'llm', 'provider': 'llm_openai', 'config': {'model': 'gpt-4.1-mini'}},
        ],
    }


def _request(**arguments):
    args = {'token': 'tk_test', 'pipeline': _pipeline()}
    args.update(arguments)
    return {'command': 'execute', 'arguments': args}


def _install_fake_task(monkeypatch, factory=None):
    """Replace the Task class the server constructs; return the built list."""
    built: list = []

    def _construct(**kwargs):
        task = (factory or _FakeTask)(**kwargs)
        built.append(task)
        return task

    monkeypatch.setattr(ts_mod, 'Task', _construct)
    return built


def _control_with(states):
    """A TASK_CONTROL holding one engine per entry in ``states``."""
    engines = []
    for state in states:
        task = _FakeTask(id=f'task-{len(engines)}')
        task._state = state
        engines.append(task)

    control = TASK_CONTROL()
    control.token = 'tk_test'
    control.id = 'abcd1234.src'
    control.task = engines[0]
    control.replica_tasks = engines[1:]
    return control, engines


# ---------------------------------------------------------------------------
# resolve_replicas
# ---------------------------------------------------------------------------


def test_absent_replicas_falls_back_to_the_server_default():
    """No `replicas` in the request means the server-wide default (1)."""
    assert resolve_replicas(None) == ts_mod.CONST_DEFAULT_REPLICAS


@pytest.mark.parametrize('requested', [0, -7])
def test_replicas_below_one_clamp_up(requested):
    """Zero or negative engines is not a pipeline; the floor is 1."""
    assert resolve_replicas(requested) == 1


def test_replicas_clamp_to_the_ceiling():
    """A request for more replicas than the ceiling gets the ceiling, not a refusal."""
    assert resolve_replicas(999) == CONST_MAX_REPLICAS


def test_replicas_accepts_a_numeric_string():
    """Wire values arrive JSON-decoded, but a client may still send '4'."""
    assert resolve_replicas('4') == 4


@pytest.mark.parametrize('requested', ['lots', object(), [3]])
def test_unparseable_replicas_fall_back_instead_of_failing_the_launch(requested):
    """A bad number must never be the reason a pipeline refuses to run."""
    assert resolve_replicas(requested) == ts_mod.CONST_DEFAULT_REPLICAS


# ---------------------------------------------------------------------------
# resolve_torch_threads
# ---------------------------------------------------------------------------


def test_explicit_torch_threads_win():
    """An explicit positive value is used verbatim, replicas notwithstanding."""
    assert resolve_torch_threads(3, replicas=8) == 3


def test_unset_torch_threads_on_one_replica_inject_nothing():
    """A single unreplicated task must behave exactly as it did before replicas."""
    assert resolve_torch_threads(None, replicas=1) == 0


def test_unset_torch_threads_divide_the_box_between_replicas(monkeypatch):
    """Auto rule: cpu_count // replicas, so N replicas share the machine."""
    monkeypatch.setattr(ts_mod.os, 'cpu_count', lambda: 32)
    assert resolve_torch_threads(None, replicas=8) == 4


def test_the_auto_rule_never_yields_zero_threads(monkeypatch):
    """More replicas than cores still leaves each one a thread to run on."""
    monkeypatch.setattr(ts_mod.os, 'cpu_count', lambda: 4)
    assert resolve_torch_threads(None, replicas=16) == 1


def test_unparseable_torch_threads_fall_back_to_the_auto_rule(monkeypatch):
    """Garbage is treated as 'unset', not as a launch failure."""
    monkeypatch.setattr(ts_mod.os, 'cpu_count', lambda: 16)
    assert resolve_torch_threads('four', replicas=4) == 4


# ---------------------------------------------------------------------------
# start_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_replicas_are_registered_under_one_token(monkeypatch):
    """N engines, ONE registry entry — the token is what a client holds."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    result = await ts.start_task(_request(replicas=3), conn=MagicMock())

    assert len(built) == 3
    assert list(ts._task_control) == ['tk_test']
    control = ts._task_control['tk_test']
    assert control.tasks == built
    assert control.task is built[0]
    assert control.replica_tasks == built[1:]
    assert result['replicas'] == 3


@pytest.mark.asyncio
async def test_every_replica_is_started_and_carries_its_index(monkeypatch):
    """All engines start, and each knows which replica of the token it is."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    await ts.start_task(_request(replicas=3), conn=MagicMock())

    assert all(task.started for task in built)
    assert [task.replica_index for task in built] == [0, 1, 2]


@pytest.mark.asyncio
async def test_each_replica_gets_a_distinct_id(monkeypatch):
    """Shared ids would collide in temp-file names, DAP module names and metrics rows."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    await ts.start_task(_request(replicas=3), conn=MagicMock())

    ids = [task.id for task in built]
    assert len(set(ids)) == 3
    # The primary keeps the control's own id — it is what every existing
    # status/monitor path already displays.
    assert ids[0] == ts._task_control['tk_test'].id


@pytest.mark.asyncio
async def test_replicas_share_the_token_and_the_pipeline(monkeypatch):
    """Replication is horizontal: same token, same pipeline, separate processes."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    await ts.start_task(_request(replicas=2), conn=MagicMock())

    assert {task.token for task in built} == {'tk_test'}
    assert all(task.pipeline is built[0].pipeline for task in built)


@pytest.mark.asyncio
async def test_the_resolved_torch_threads_reach_every_replica(monkeypatch):
    """The server resolves the rule once and hands the answer to each engine."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    await ts.start_task(_request(replicas=2, torchThreads=5), conn=MagicMock())

    assert [task.torch_threads for task in built] == [5, 5]


@pytest.mark.asyncio
async def test_a_single_replica_is_the_pre_replica_shape(monkeypatch):
    """The default path builds exactly one engine and injects no thread pinning."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    result = await ts.start_task(_request(), conn=MagicMock())

    assert len(built) == 1
    assert built[0].replica_index == 0
    assert built[0].torch_threads == 0
    assert result['replicas'] == 1


@pytest.mark.asyncio
async def test_a_replica_count_over_the_ceiling_is_clamped_not_refused(monkeypatch):
    """A wild `replicas` must not become a fork bomb, nor a failed launch."""
    ts = _make_server()
    built = _install_fake_task(monkeypatch)

    result = await ts.start_task(_request(replicas=10_000), conn=MagicMock())

    assert len(built) == CONST_MAX_REPLICAS
    assert result['replicas'] == CONST_MAX_REPLICAS


@pytest.mark.asyncio
async def test_a_partial_start_tears_down_the_replicas_that_came_up(monkeypatch):
    """
    A half-started pipeline is not a pipeline.

    The engines that DID start are subprocesses holding a model copy each;
    leaving them behind on a failed launch orphans them under a token the
    caller never receives.
    """

    class _FailingSecond(_FakeTask):
        async def start_task(self):
            if self.replica_index == 1:
                raise RuntimeError('engine refused to start')
            await super().start_task()

    ts = _make_server()
    built = _install_fake_task(monkeypatch, factory=_FailingSecond)

    with pytest.raises(RuntimeError, match='engine refused to start'):
        await ts.start_task(_request(replicas=3), conn=MagicMock())

    assert all(task.stop_calls for task in built)
    # And the half-built control never stays in the registry.
    assert 'tk_test' not in ts._task_control


@pytest.mark.asyncio
async def test_replicas_start_concurrently(monkeypatch):
    """
    Serial starts would pay N model-load times before the token answers.

    Each engine here blocks until every one of them has entered start_task,
    so the test only completes if the starts really do overlap. (Hand-rolled
    rather than asyncio.Barrier: the repo's Python floor is 3.10 and Barrier
    landed in 3.11.)
    """
    replicas = 4
    arrived = {'n': 0}
    all_arrived = asyncio.Event()

    class _Rendezvous(_FakeTask):
        async def start_task(self):
            arrived['n'] += 1
            if arrived['n'] >= replicas:
                all_arrived.set()
            await asyncio.wait_for(all_arrived.wait(), timeout=5)
            await super().start_task()

    ts = _make_server()
    built = _install_fake_task(monkeypatch, factory=_Rendezvous)

    await ts.start_task(_request(replicas=replicas), conn=MagicMock())

    assert all(task.started for task in built)
    assert arrived['n'] == replicas


# ---------------------------------------------------------------------------
# useExisting reuse
# ---------------------------------------------------------------------------


def _reuse_server(replicas=2):
    """A server holding one running control under 'tk_test'."""
    ts = _make_server()
    control, engines = _control_with([TASK_STATE.RUNNING.value] * replicas)
    control.project_id = 'project-1'
    control.source = 'src'
    control.provider = 'webhook'
    control.public_auth = 'pk_public'
    control.pipeline = _pipeline()
    ts._task_control['tk_test'] = control
    return ts, control, engines


@pytest.mark.asyncio
async def test_reuse_reports_a_replica_count_that_differs_from_the_request():
    """
    `replicas` is the throughput knob, and it is NOT applied to a live token.

    Silently serving 2 replicas to a caller who asked for 8 makes the run
    read as a measurement of 8.
    """
    ts, _, _ = _reuse_server(replicas=2)

    result = await ts.start_task(_request(useExisting=True, replicas=8), conn=MagicMock())

    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'already running with 2 replica(s)' in said
    assert 'ignoring the requested 8' in said
    assert result['reused'] is True
    assert result['replicas'] == 2


@pytest.mark.asyncio
async def test_reuse_is_silent_when_the_replica_count_matches():
    """No warning when the caller asked for exactly what is running."""
    ts, _, _ = _reuse_server(replicas=2)

    await ts.start_task(_request(useExisting=True, replicas=2), conn=MagicMock())

    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the requested' not in said


@pytest.mark.asyncio
async def test_reuse_waits_for_every_replica_to_be_running():
    """The caller is told the TOKEN is ready, not that one engine of it is."""
    ts, _, engines = _reuse_server(replicas=3)
    waited = []
    for task in engines:
        task.wait_for_running = AsyncMock(side_effect=lambda task=task: waited.append(task))

    await ts.start_task(_request(useExisting=True), conn=MagicMock(), wait_for_running=True)

    assert waited == engines


# ---------------------------------------------------------------------------
# pick_data_task
# ---------------------------------------------------------------------------


def test_pick_data_task_round_robins_across_replicas():
    """Inputs to one token spread across the engines instead of queueing on one."""
    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)

    picked = [control.pick_data_task() for _ in range(7)]

    assert picked == [engines[0], engines[1], engines[2], engines[0], engines[1], engines[2], engines[0]]


def test_pick_data_task_skips_engines_that_are_not_running():
    """A starting or dead replica would block or fail its 1/N share of the traffic."""
    control, engines = _control_with(
        [TASK_STATE.RUNNING.value, TASK_STATE.INITIALIZING.value, TASK_STATE.RUNNING.value]
    )

    picked = [control.pick_data_task() for _ in range(4)]

    assert picked == [engines[0], engines[2], engines[0], engines[2]]


def test_pick_data_task_falls_back_to_the_primary_when_nothing_runs_yet():
    """Pre-replica behaviour: hand back the primary and let the caller await it."""
    control, engines = _control_with([TASK_STATE.STARTING.value, TASK_STATE.STARTING.value])

    assert control.pick_data_task() is engines[0]


def test_pick_data_task_on_an_unreplicated_control_is_just_the_task():
    """The overwhelmingly common case costs no status reads and no cursor."""
    control, engines = _control_with([TASK_STATE.STARTING.value])

    assert control.pick_data_task() is engines[0]
    assert control.data_cursor == 0


def test_pick_data_task_survives_a_status_read_that_throws():
    """A task torn down mid-scan means 'not a candidate', never an exception."""
    control, engines = _control_with([TASK_STATE.RUNNING.value, TASK_STATE.RUNNING.value])
    engines[1].get_status = MagicMock(side_effect=RuntimeError('gone'))

    assert control.pick_data_task() is engines[0]


def test_an_empty_control_picks_nothing():
    """A control with no engine at all answers None rather than raising."""
    control = TASK_CONTROL()
    assert control.pick_data_task() is None


# ---------------------------------------------------------------------------
# Data ingress routing
# ---------------------------------------------------------------------------


def test_the_data_path_asks_for_a_replica_and_the_others_ask_for_the_primary():
    """
    for_data is what makes `replicas` do anything.

    Status / attach / debug / monitor must keep resolving to the primary: a
    round-robined answer would report a different process on each call.
    """
    from ai.modules.task.task_conn import TaskConn

    control, engines = _control_with([TASK_STATE.RUNNING.value, TASK_STATE.RUNNING.value])
    control.teamId = 'team-1'

    conn = TaskConn.__new__(TaskConn)
    conn._account_info = None
    conn._server = MagicMock()
    conn._server.get_task_control = MagicMock(return_value=control)
    conn.get_task_token = MagicMock(return_value='tk_test')

    assert TaskConn.get_task(conn, {}, 'task.monitor') is engines[0]
    assert TaskConn.get_task(conn, {}, 'task.monitor') is engines[0]
    assert TaskConn.get_task(conn, {}, 'task.data', for_data=True) is engines[0]
    assert TaskConn.get_task(conn, {}, 'task.data', for_data=True) is engines[1]


# ---------------------------------------------------------------------------
# Pipe affinity — the open -> write -> close session must not straddle engines
# ---------------------------------------------------------------------------


class _PipeEngine(_FakeTask):
    """
    An engine stand-in that mints pipe ids the way a real subprocess does.

    Crucially it starts at 1 and knows nothing about replicas, so TWO of
    these both hand out pipe id 1 — the collision the wire encoding exists
    to resolve.
    """

    # The REAL qualifier, so the test exercises production's encoding rather
    # than a second implementation of it.
    encode_pipe_id = Task.encode_pipe_id

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._next_local = 1
        self.pipes = {}
        self.seen = []

    async def _send_data(self, request):
        args = request.get('arguments', {})
        subcommand = args.get('subcommand')
        self.seen.append((subcommand, args.get('pipe_id')))

        if subcommand == 'open':
            local = self._next_local
            self._next_local += 1
            self.pipes[local] = []
            return {'body': {'pipe_id': local}}

        pipe_id = args.get('pipe_id')
        if pipe_id not in self.pipes:
            # The exact failure the bug produced in production.
            raise ValueError(f'Write pipe with id {pipe_id} not found')

        if subcommand == 'write':
            self.pipes[pipe_id].append(args.get('data'))
            return {'body': None}

        if subcommand == 'close':
            written = self.pipes.pop(pipe_id)
            return {'body': {'objectId': f'{self.id}:{pipe_id}', 'chunks': len(written)}}

        raise ValueError(f'Invalid subcommand {subcommand}')


def _pipe_control(count=2):
    """A control whose engines all mint pipe ids from 1."""
    engines = [_PipeEngine(id=f'task#{i}', replica_index=i, replica_count=count) for i in range(count)]
    control = TASK_CONTROL()
    control.token = 'tk_test'
    control.id = 'abcd1234.src'
    control.teamId = 'team-1'
    control.task = engines[0]
    control.replica_tasks = engines[1:]
    return control, engines


def _data_conn(control):
    """A bare TaskConn wired to one control, for the data ingress path."""
    from ai.modules.task.task_conn import TaskConn

    conn = TaskConn.__new__(TaskConn)
    conn._account_info = None
    conn._server = MagicMock()
    conn._server.get_task_control = MagicMock(return_value=control)
    conn.get_task_token = MagicMock(return_value='tk_test')
    conn.build_response = lambda request, body=None: {'body': body}
    conn.debug_message = MagicMock()
    return conn


async def _process(conn, **arguments):
    """Drive one rrext_process request through the real ingress handler."""
    from ai.modules.task.commands.cmd_data import DataCommands

    request = {'command': 'rrext_process', 'arguments': {'token': 'tk_test', **arguments}}
    response = await DataCommands.on_rrext_process(conn, request)
    return response.get('body')


@pytest.mark.asyncio
async def test_a_pipe_session_stays_on_the_engine_that_opened_it():
    """
    THE bug this encoding exists for.

    The SDK does open -> N x write -> close against one pipe id, and a pipe
    lives inside one subprocess. Both engines here mint local id 1, so
    routing each request independently would send file A's bytes into file
    B's pipe (or fail outright with "Write pipe with id 1 not found").
    """
    control, engines = _pipe_control(2)
    conn = _data_conn(control)

    first = await _process(conn, subcommand='open', object={}, mimeType='text/plain')
    second = await _process(conn, subcommand='open', object={}, mimeType='text/plain')

    # Round-robined across the two engines...
    assert first['pipe_id'] != second['pipe_id']

    await _process(conn, subcommand='write', pipe_id=first['pipe_id'], data=b'A1')
    await _process(conn, subcommand='write', pipe_id=second['pipe_id'], data=b'B1')
    await _process(conn, subcommand='write', pipe_id=first['pipe_id'], data=b'A2')

    # ...and every write landed in the pipe its own open created.
    assert engines[0].pipes == {1: [b'A1', b'A2']}
    assert engines[1].pipes == {1: [b'B1']}

    first_result = await _process(conn, subcommand='close', pipe_id=first['pipe_id'])
    second_result = await _process(conn, subcommand='close', pipe_id=second['pipe_id'])

    assert first_result == {'objectId': 'task#0:1', 'chunks': 2}
    assert second_result == {'objectId': 'task#1:1', 'chunks': 1}


@pytest.mark.asyncio
async def test_the_engine_only_ever_sees_its_own_local_pipe_id():
    """The qualification is a WIRE concern — the subprocess protocol is untouched."""
    control, engines = _pipe_control(2)
    conn = _data_conn(control)

    opened = await _process(conn, subcommand='open', object={}, mimeType='text/plain')
    await _process(conn, subcommand='write', pipe_id=opened['pipe_id'], data=b'x')

    assert engines[0].seen == [('open', None), ('write', 1)]


@pytest.mark.asyncio
async def test_an_unreplicated_token_hands_back_the_raw_engine_id():
    """One engine, one id space: the pre-replica wire protocol, unchanged."""
    control, engines = _pipe_control(1)
    conn = _data_conn(control)

    opened = await _process(conn, subcommand='open', object={}, mimeType='text/plain')

    assert opened == {'pipe_id': 1}
    await _process(conn, subcommand='write', pipe_id=1, data=b'x')
    assert engines[0].pipes == {1: [b'x']}


def test_the_wire_id_encodes_the_replica_that_minted_it():
    """Round-trip: what the client holds decodes back to (engine, local id)."""
    from ai.modules.task.types import decode_pipe_id, encode_pipe_id

    for replica_index in range(CONST_MAX_REPLICAS):
        for local_id in (1, 2, 7, 1000):
            wire = encode_pipe_id(local_id, replica_index)
            assert decode_pipe_id(wire) == (local_id, replica_index)


def test_a_standalone_tool_call_is_round_robined():
    """`tool` without a pipe_id borrows a pool pipe — nothing to be affine to."""
    control, engines = _pipe_control(3)

    picked = [control.route_data_request({'arguments': {'subcommand': 'tool', 'tool': 't'}})[0] for _ in range(4)]

    assert picked == [engines[0], engines[1], engines[2], engines[0]]


def test_a_tool_call_on_an_open_pipe_follows_that_pipe():
    """`tool` WITH a pipe_id reuses the caller's pipe, so it must go to its engine."""
    from ai.modules.task.types import encode_pipe_id

    control, engines = _pipe_control(3)
    wire = encode_pipe_id(4, 2)

    task, outbound = control.route_data_request({'arguments': {'subcommand': 'tool', 'tool': 't', 'pipe_id': wire}})

    assert task is engines[2]
    assert outbound['arguments']['pipe_id'] == 4


def test_routing_does_not_mutate_the_inbound_request():
    """The caller's request object is shared; localisation must copy, not edit."""
    from ai.modules.task.types import encode_pipe_id

    control, _ = _pipe_control(2)
    request = {'arguments': {'subcommand': 'write', 'pipe_id': encode_pipe_id(3, 1)}}

    control.route_data_request(request)

    assert request['arguments']['pipe_id'] == encode_pipe_id(3, 1)


def test_a_pipe_id_naming_a_dead_replica_says_so():
    """
    Rerouting to a live engine would report "pipe not found" — a confusing
    lie. The truth is that the engine holding that pipe is gone.
    """
    from ai.modules.task.types import encode_pipe_id

    control, engines = _pipe_control(2)
    engines[1]._state = TASK_STATE.COMPLETED.value

    with pytest.raises(ValueError, match='no longer running'):
        control.route_data_request({'arguments': {'subcommand': 'write', 'pipe_id': encode_pipe_id(1, 1)}})


def test_a_pipe_id_naming_a_replica_that_does_not_exist_says_so():
    """A stale id from a previously larger run must not silently hit engine 0."""
    from ai.modules.task.types import encode_pipe_id

    control, _ = _pipe_control(2)

    with pytest.raises(ValueError, match='runs 2 replica'):
        control.route_data_request({'arguments': {'subcommand': 'write', 'pipe_id': encode_pipe_id(1, 5)}})


# ---------------------------------------------------------------------------
# Pipe ids in broadcast events
# ---------------------------------------------------------------------------


def _event_task(replica_index=1, replica_count=2):
    """A bare Task carrying only what _qualify_event_pipe_ids reads."""
    task = Task.__new__(Task)
    task.replica_index = replica_index
    task.replica_count = replica_count
    return task


def test_sse_events_carry_the_qualified_pipe_id():
    """A client narrows its SSE subscription by the id `open` gave it — the
    event has to carry the same id or the filter never matches.
    """
    from ai.modules.task.types import encode_pipe_id

    task = _event_task()
    message = {'event': 'apaevt_sse', 'body': {'pipe_id': 3, 'message': 'hi'}}

    Task._qualify_event_pipe_ids(task, message)

    assert message['body']['pipe_id'] == encode_pipe_id(3, 1)


def test_trace_events_carry_the_qualified_pipe_index():
    """apaevt_trace.body.id is the traced pipe, and becomes apaevt_flow.body.id."""
    from ai.modules.task.types import encode_pipe_id

    task = _event_task()
    message = {'event': 'apaevt_trace', 'body': {'id': 5, 'op': 'enter', 'pipe_id': 'component-name'}}

    Task._qualify_event_pipe_ids(task, message)

    assert message['body']['id'] == encode_pipe_id(5, 1)
    # `pipe_id` on a trace holds the COMPONENT id despite the name — it is
    # not a pipe and must never be rewritten.
    assert message['body']['pipe_id'] == 'component-name'


def test_an_unreplicated_task_never_rewrites_an_event():
    """Single-engine event bodies stay byte-identical."""
    task = _event_task(replica_index=0, replica_count=1)
    message = {'event': 'apaevt_sse', 'body': {'pipe_id': 3}}

    Task._qualify_event_pipe_ids(task, message)

    assert message['body']['pipe_id'] == 3


# ---------------------------------------------------------------------------
# Lifecycle events fold to one per token
# ---------------------------------------------------------------------------


def _lifecycle_event(action, replica=0):
    return {'event': 'apaevt_task', 'body': {'action': action, 'replica': replica}}


def test_only_the_first_replica_to_begin_speaks_for_the_token():
    """Clients fold task events by {projectId, source, action} and ignore the
    replica stamp, so N begins read as N pipelines starting.
    """
    ts = _make_server()
    control, _ = _control_with([TASK_STATE.RUNNING.value] * 3)
    ts._task_control['tk_test'] = control

    forwarded = [
        TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('begin', replica=i)) for i in range(3)
    ]

    assert forwarded == [True, False, False]


def test_end_waits_for_the_last_replica():
    """
    The first replica to exit must NOT mark the whole pipeline stopped while
    its siblings are still serving traffic.
    """
    ts = _make_server()
    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)
    ts._task_control['tk_test'] = control

    # Replica 0 exits first: two engines still live, so its end is dropped.
    engines[0]._complete = True
    assert not TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('end', replica=0))

    engines[1]._complete = True
    assert not TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('end', replica=1))

    # The last one out carries the event for the token.
    engines[2]._complete = True
    assert TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('end', replica=2))


def test_restart_is_announced_once_by_the_primary():
    """A restart drives every replica through the same transition."""
    ts = _make_server()
    control, _ = _control_with([TASK_STATE.RUNNING.value] * 3)
    ts._task_control['tk_test'] = control

    forwarded = [
        TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('restart', replica=i))
        for i in range(3)
    ]

    assert forwarded == [True, False, False]


def test_per_replica_events_are_never_folded():
    """Status, output, trace and SSE are per-engine by nature — all pass."""
    ts = _make_server()
    control, _ = _control_with([TASK_STATE.RUNNING.value] * 2)
    ts._task_control['tk_test'] = control

    for event in (
        {'event': 'apaevt_status_update', 'body': {'replica': 1}},
        {'event': 'apaevt_sse', 'body': {'replica': 1}},
        {'event': 'output', 'body': {'replica': 1}},
    ):
        assert TaskServer._should_forward_lifecycle_event(ts, control, event)


def test_an_unreplicated_token_folds_nothing():
    """A single engine's begin/end is the token's begin/end, as it always was."""
    ts = _make_server()
    control, _ = _control_with([TASK_STATE.RUNNING.value])
    ts._task_control['tk_test'] = control

    assert TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('begin'))
    assert TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('begin'))
    assert TaskServer._should_forward_lifecycle_event(ts, control, _lifecycle_event('end'))


@pytest.mark.asyncio
async def test_broadcast_drops_the_folded_begin():
    """The fold happens on the real broadcast path, not just in the predicate."""
    ts = _make_server()
    control, _ = _control_with([TASK_STATE.RUNNING.value] * 2)
    ts._task_control['tk_test'] = control

    conn = MagicMock()
    conn.send_task_event = AsyncMock()
    ts._connections = {1: conn}

    await TaskServer.broadcast_task_event(ts, EVENT_TYPE.TASK, 'tk_test', _lifecycle_event('begin', replica=0))
    await TaskServer.broadcast_task_event(ts, EVENT_TYPE.TASK, 'tk_test', _lifecycle_event('begin', replica=1))

    conn.send_task_event.assert_awaited_once()


# ---------------------------------------------------------------------------
# Status aggregation
# ---------------------------------------------------------------------------


def _status_control(*counts):
    """A control whose engines carry REAL TASK_STATUS objects."""
    from rocketride import TASK_STATUS

    engines = []
    for index, completed in enumerate(counts):
        task = _FakeTask(id=f'task#{index}')
        status = TASK_STATUS(
            name='pipe.src',
            state=TASK_STATE.RUNNING.value,
            startTime=100.0 + index,
            endTime=200.0 + index,
            completedCount=completed,
            totalCount=completed,
            rateCount=completed,
            completedSize=completed * 10,
        )
        status.metrics.cpu_percent = 5.0
        status.tokens.total = 1.5
        status.errors = [f'boom {index}']
        task.get_status = lambda status=status: status
        task._idle_time = 60 * (index + 1)
        engines.append(task)

    control = TASK_CONTROL()
    control.token = 'tk_test'
    control.task = engines[0]
    control.replica_tasks = engines[1:]
    return control, engines


def test_status_counters_sum_across_replicas():
    """Inputs round-robin, so the primary alone reports ~1/N of the work."""
    control, _ = _status_control(4, 6, 2)

    status = control.get_status()

    assert status.completedCount == 12
    assert status.totalCount == 12
    assert status.rateCount == 12
    assert status.completedSize == 120


def test_status_spans_the_whole_group_in_time():
    """First engine to start, last to finish — that is the run's window."""
    control, _ = _status_control(1, 1, 1)

    status = control.get_status()

    assert status.startTime == 100.0
    assert status.endTime == 202.0


def test_status_sums_resource_use_and_billing():
    """Three processes cost three processes' worth of CPU and tokens."""
    control, _ = _status_control(1, 1, 1)

    status = control.get_status()

    assert status.metrics.cpu_percent == 15.0
    assert status.tokens.total == 4.5


def test_status_surfaces_every_replicas_errors():
    """A failing replica must not be invisible to anyone watching the token."""
    control, _ = _status_control(1, 1)

    status = control.get_status()

    assert status.errors == ['boom 0', 'boom 1']


def test_status_keeps_the_primary_lifecycle_state():
    """State follows the primary — the process every attach/debug path uses."""
    control, engines = _status_control(1, 1)

    assert control.get_status().state == engines[0].get_status().state


def test_aggregation_never_mutates_the_primary_live_status():
    """The primary's status object is the one its Task keeps updating."""
    control, engines = _status_control(4, 6)
    live = engines[0].get_status()

    control.get_status()

    assert live.completedCount == 4


def test_an_unreplicated_control_returns_the_status_object_itself():
    """No copy, no summation — the pre-replica read, at the pre-replica cost."""
    control, engines = _status_control(4)

    assert control.get_status() is engines[0].get_status()


def test_control_idle_time_is_the_busiest_replicas():
    """The group is only as idle as its most recently active engine."""
    control, _ = _status_control(1, 1, 1)

    assert control.idle_time == 60


# ---------------------------------------------------------------------------
# Lifecycle: stop / remove


@pytest.mark.asyncio
async def test_stop_task_stops_every_replica():
    """A surviving replica would keep serving a token its owner believes is gone."""
    from ai.modules.task.types import LAUNCH_TYPE

    ts = _make_server()
    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)
    control.launch_type = LAUNCH_TYPE.EXECUTE
    ts._task_control['tk_test'] = control

    await TaskServer.stop_task(ts, 'tk_test')

    assert [task.stop_calls for task in engines] == [['user'], ['user'], ['user']]


@pytest.mark.asyncio
async def test_stop_task_passes_the_reason_to_every_replica():
    """A ttl expiry records as a completed window — for all of them, not just one."""
    from ai.modules.task.types import LAUNCH_TYPE

    ts = _make_server()
    control, engines = _control_with([TASK_STATE.RUNNING.value] * 2)
    control.launch_type = LAUNCH_TYPE.EXECUTE
    ts._task_control['tk_test'] = control

    await TaskServer.stop_task(ts, 'tk_test', reason='ttl')

    assert [task.stop_calls for task in engines] == [['ttl'], ['ttl']]


@pytest.mark.asyncio
async def test_remove_task_tears_down_every_replica():
    """Removing the registry entry must not leave replicas running headless."""
    ts = _make_server()
    ts.broadcast_server_event = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)
    control.userId = 'u1'
    control.project_id = 'project-1'
    control.source = 'src'
    ts._task_control['tk_test'] = control

    removed = await TaskServer.remove_task(ts, 'tk_test')

    assert removed is control
    assert 'tk_test' not in ts._task_control
    assert all(task.stop_calls for task in engines)


@pytest.mark.asyncio
async def test_one_stubborn_replica_does_not_strand_the_rest():
    """Teardown is best-effort per engine; one failure must not skip the others."""
    ts = _make_server()
    ts.broadcast_server_event = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)
    control.userId = 'u1'
    control.project_id = 'project-1'
    control.source = 'src'
    engines[0].stop_task = AsyncMock(side_effect=RuntimeError('will not die'))
    ts._task_control['tk_test'] = control

    await TaskServer.remove_task(ts, 'tk_test')

    assert all(task.stop_calls for task in engines[1:])


# ---------------------------------------------------------------------------
# Lifecycle: restart
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_restart_drives_every_replica():
    """
    Leaving some engines on the old configuration would make one token answer
    differently per request.
    """

    class _Restartable(_FakeTask):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.restarts = []

        def has_attached_debugger(self):
            return False

        async def restart_task(self, pipeline, project_id, source, provider):
            self.restarts.append((project_id, source, provider))

    ts = _make_server()
    engines = [
        _Restartable(id=f'task#{i}', replica_index=i, replica_count=3, _torch_threads=4, torch_threads=4)
        for i in range(3)
    ]
    control = TASK_CONTROL()
    control.token = 'tk_test'
    control.id = 'abcd1234.src'
    control.project_id = 'project-1'
    control.source = 'src'
    control.provider = 'webhook'
    control.public_auth = 'pk_public'
    control.pipeline = _pipeline()
    control.task = engines[0]
    control.replica_tasks = engines[1:]
    ts._task_control['tk_test'] = control
    ts.get_task_control = lambda token: control

    request = {'arguments': {'token': 'tk_test', 'pipeline': _pipeline()}}
    result = await TaskServer.restart_task(ts, request, conn=None)

    assert [task.restarts for task in engines] == [[('project-1', 'src', 'webhook')]] * 3
    assert result['replicas'] == 3


@pytest.mark.asyncio
async def test_restart_preserves_replica_identity_and_thread_pinning():
    """
    A restart resets the RUN, not the engine's identity.

    replica_index decides pipe-id qualification and run-log ownership, and
    torch_threads is the box-sharing contract — silently losing either on a
    restart would leave the token routing to the wrong engine and every
    replica spawning cpu_count threads again.
    """
    from rocketride import TASK_STATUS

    task = Task.__new__(Task)
    task.replica_index = 2
    task.replica_count = 4
    task._torch_threads = 8
    task._status = TASK_STATUS(completedCount=17, state=TASK_STATE.RUNNING.value)
    task._status_trace = ['noise']
    task.info = {'a': 1}

    Task._reset_status(task)

    # The run's counters are cleared...
    assert task._status.completedCount == 0
    assert task._status_trace == []
    # ...and the engine's identity survives.
    assert task.replica_index == 2
    assert task.replica_count == 4
    assert task._torch_threads == 8


@pytest.mark.asyncio
async def test_partial_restart_failure_stops_the_whole_group_and_raises():
    """
    A token that answers from two different pipelines is worse than no token.

    If one replica's restart fails, the group is left half on the old
    pipeline and half on the new one. Rather than leave that half-and-half
    control behind, every replica is stopped and the control is removed —
    then the failure is raised.
    """

    class _Restartable(_FakeTask):
        def has_attached_debugger(self):
            return False

        async def restart_task(self, pipeline, project_id, source, provider):
            if self.replica_index == 1:
                raise RuntimeError('engine refused to restart')

    ts = _make_server()
    engines = [
        _Restartable(id=f'task#{i}', replica_index=i, replica_count=3, _torch_threads=4, torch_threads=4)
        for i in range(3)
    ]
    control = TASK_CONTROL()
    control.token = 'tk_test'
    control.id = 'abcd1234.src'
    control.project_id = 'project-1'
    control.source = 'src'
    control.provider = 'webhook'
    control.public_auth = 'pk_public'
    control.pipeline = _pipeline()
    control.task = engines[0]
    control.replica_tasks = engines[1:]
    ts._task_control['tk_test'] = control
    ts.get_task_control = lambda token: control

    request = {'arguments': {'token': 'tk_test', 'pipeline': _pipeline()}}

    with pytest.raises(RuntimeError, match='engine refused to restart'):
        await TaskServer.restart_task(ts, request, conn=None)

    # Every replica was stopped, including the ones whose restart succeeded.
    assert all(task.stop_calls for task in engines)
    # And the half-restarted control never stays in the registry.
    assert 'tk_test' not in ts._task_control


# ---------------------------------------------------------------------------
# Lifecycle: cleanup
# ---------------------------------------------------------------------------


def _cleanup_loop(monkeypatch):
    """Make ``_cleanup_tasks`` run exactly one iteration, then break out."""

    async def _stop_after_one(_delay):
        raise _LoopBreak

    monkeypatch.setattr(ts_mod.asyncio, 'sleep', _stop_after_one)


@pytest.mark.asyncio
async def test_cleanup_keeps_a_control_while_any_replica_still_runs(monkeypatch):
    """
    Removing the control would orphan the live subprocess and leave its
    events broadcasting under a token nobody can look up.
    """
    _cleanup_loop(monkeypatch)

    ts = _make_server()
    ts.remove_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)
    engines[0]._complete = True
    engines[1]._complete = True
    engines[2]._complete = False
    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._cleanup_tasks(ts)

    ts.remove_task.assert_not_awaited()


@pytest.mark.asyncio
async def test_cleanup_removes_a_control_once_every_replica_is_done(monkeypatch):
    """The grace period runs from the LAST replica to finish."""
    _cleanup_loop(monkeypatch)

    ts = _make_server()
    ts.remove_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.COMPLETED.value] * 3)
    for task in engines:
        task._complete = True
        # Long expired: endTime stays 0.0 on the stand-in, and the grace
        # period is measured against wall-clock now.
    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._cleanup_tasks(ts)

    ts.remove_task.assert_awaited_once_with('tk_test')


@pytest.mark.asyncio
async def test_cleanup_waits_out_the_grace_period_of_the_last_replica(monkeypatch):
    """A replica that finished a second ago holds the whole control back."""
    _cleanup_loop(monkeypatch)

    ts = _make_server()
    ts.remove_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.COMPLETED.value] * 2)
    for task in engines:
        task._complete = True
    # The straggler ended just now, so the group is still inside its grace.
    engines[1].get_status = lambda: SimpleNamespace(state=TASK_STATE.COMPLETED.value, endTime=time.time())
    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._cleanup_tasks(ts)

    ts.remove_task.assert_not_awaited()


# ---------------------------------------------------------------------------
# TTL across replicas
# ---------------------------------------------------------------------------


def _ttl_loop(monkeypatch, check_interval=60):
    """Make ``_monitor_ttl`` run exactly one iteration, then break out."""
    counter = {'n': 0}

    async def _sleep_one_then_stop(_delay):
        counter['n'] += 1
        if counter['n'] > 1:
            raise _LoopBreak

    monkeypatch.setattr(ts_mod.asyncio, 'sleep', _sleep_one_then_stop)
    monkeypatch.setattr(ts_mod, 'CONST_TTL_CHECK', check_interval)


@pytest.mark.asyncio
async def test_ttl_does_not_fire_while_any_replica_is_busy(monkeypatch):
    """
    Inputs round-robin, so one busy replica means the pipeline is in use.

    Killing the token because its siblings happened to be between documents
    would cut a live run short.
    """
    _ttl_loop(monkeypatch)

    ts = _make_server()
    ts.stop_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 2)
    for task in engines:
        task._ttl = 100
    engines[0]._idle_time = 50  # 50 + 60 -> over
    engines[1]._idle_time = 0  # 0 + 60 -> still under
    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._monitor_ttl(ts)

    ts.stop_task.assert_not_awaited()


@pytest.mark.asyncio
async def test_ttl_fires_once_every_replica_is_idle(monkeypatch):
    """When the whole group has gone quiet for its window, the token goes."""
    _ttl_loop(monkeypatch)

    ts = _make_server()
    ts.stop_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 3)
    for task in engines:
        task._ttl = 100
        task._idle_time = 50  # 50 + 60 -> over, for all of them

    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._monitor_ttl(ts)

    ts.stop_task.assert_awaited_once_with('tk_test', reason='ttl')


@pytest.mark.asyncio
async def test_zero_ttl_still_means_never_with_replicas(monkeypatch):
    """ttl=0 is 'run until told otherwise' — replication does not change that."""
    _ttl_loop(monkeypatch)

    ts = _make_server()
    ts.stop_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 2)
    for task in engines:
        task._ttl = 0
        task._idle_time = 999_999
    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._monitor_ttl(ts)

    ts.stop_task.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_completed_replica_does_not_hold_the_idle_clock_back(monkeypatch):
    """
    A replica that already exited is the cleanup loop's business.

    Counting it as 'not idle' would make a token with one dead engine
    immortal.
    """
    _ttl_loop(monkeypatch)

    ts = _make_server()
    ts.stop_task = AsyncMock()

    control, engines = _control_with([TASK_STATE.RUNNING.value] * 2)
    for task in engines:
        task._ttl = 100
    engines[0]._idle_time = 50
    engines[1]._complete = True
    engines[1]._idle_time = 0
    ts._task_control['tk_test'] = control

    with pytest.raises(_LoopBreak):
        await TaskServer._monitor_ttl(ts)

    ts.stop_task.assert_awaited_once_with('tk_test', reason='ttl')


# ---------------------------------------------------------------------------
# Environment-driven server defaults
# ---------------------------------------------------------------------------


def _reload_constants(monkeypatch, **env):
    """Reimport ai.constants with the given environment in place."""
    import ai.constants as constants

    for name in ('ROCKETRIDE_TASK_REPLICAS', 'ROCKETRIDE_TORCH_THREADS'):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    return importlib.reload(constants)


@pytest.fixture(autouse=True)
def _restore_constants():
    """Leave ai.constants exactly as it was found, whatever a reload did."""
    yield
    import ai.constants as constants

    importlib.reload(constants)


def test_replica_default_comes_from_the_environment(monkeypatch):
    """Operators set the fleet-wide default in Docker/Helm, not per request."""
    constants = _reload_constants(monkeypatch, ROCKETRIDE_TASK_REPLICAS='4')
    assert constants.CONST_DEFAULT_REPLICAS == 4


def test_torch_thread_default_comes_from_the_environment(monkeypatch):
    constants = _reload_constants(monkeypatch, ROCKETRIDE_TORCH_THREADS='6')
    assert constants.CONST_DEFAULT_TORCH_THREADS == 6


def test_unset_environment_keeps_the_pre_replica_defaults(monkeypatch):
    """Nothing set means one replica and no thread pinning: today's behaviour."""
    constants = _reload_constants(monkeypatch)
    assert constants.CONST_DEFAULT_REPLICAS == 1
    assert constants.CONST_DEFAULT_TORCH_THREADS == 0


@pytest.mark.parametrize('value', ['', '   ', 'four', '3.5', '-2'])
def test_an_invalid_replica_env_falls_back_rather_than_crashing_the_server(monkeypatch, value):
    """A typo in a values.yaml must not stop the server from booting."""
    constants = _reload_constants(monkeypatch, ROCKETRIDE_TASK_REPLICAS=value)
    assert constants.CONST_DEFAULT_REPLICAS == 1


def test_a_replica_env_over_the_ceiling_falls_back_to_the_default(monkeypatch):
    """Out of range is a mistake, not an instruction to run 1000 subprocesses."""
    constants = _reload_constants(monkeypatch, ROCKETRIDE_TASK_REPLICAS='1000')
    assert constants.CONST_DEFAULT_REPLICAS == 1


def test_an_invalid_torch_thread_env_falls_back_to_auto(monkeypatch):
    constants = _reload_constants(monkeypatch, ROCKETRIDE_TORCH_THREADS='lots')
    assert constants.CONST_DEFAULT_TORCH_THREADS == 0


def test_the_six_thread_variables_are_pinned_together():
    """Pinning only some lets an unpinned stack spawn cpu_count threads anyway."""
    assert CONST_TORCH_THREAD_ENV_VARS == (
        'OMP_NUM_THREADS',
        'MKL_NUM_THREADS',
        'OPENBLAS_NUM_THREADS',
        'VECLIB_MAXIMUM_THREADS',
        'NUMEXPR_NUM_THREADS',
        'TORCH_NUM_THREADS',
    )
