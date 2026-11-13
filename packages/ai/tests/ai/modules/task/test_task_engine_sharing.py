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

"""Named-pipes runtime model: TaskControl / TaskEngine split (plan section 14, Step 3).

One engine per content: controls are the callers' views (owner, rung,
billing, ttl, parameters), engines are processes keyed by the hash of the
resolved spec. Identical specs share an engine; a spec differing only in what
is per control (the parameters map, trace level, ttl, names) shares too; one
config value apart is another engine. Cross-user sharing needs a
request/response source and every node certified ``multitenant``; anything
else is shared per owner. Terminate releases a hold; the engine stops with
its last hold; publisher disable
releases the deployment's holds; an operator may stop an engine outright.
A control entitles its caller to an engine but does not keep it running: the
engine stops on its own inactivity timer (``CONST_ENGINE_IDLE_TTL``; a ttl-0
holder pins it) or at once with its last hold, and a request through a
control whose engine stopped starts it again under the same key. So does a
request through a control whose engine crashed after it had confirmed running;
an engine that never confirmed running is not retried.
"""

from __future__ import annotations

import asyncio
import copy
import time
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest
import rocketlib

from ai.account.models import AccountInfo
from ai.constants import CONST_ENGINE_IDLE_TTL
from ai.modules.task import deploy_events, task_control, task_engine, task_server
from ai.modules.task.commands.cmd_data import DataCommands
from ai.modules.task.commands.cmd_task import TaskCommands
from ai.modules.task.task_control import DeploymentRef, TaskControl, TeamContext
from ai.modules.task.engine_key import engine_content, qualified_key
from ai.modules.task.task_engine import MULTITENANT_BIT, TaskEngine, component_facts
from ai.modules.task.task_server import ControlRegistry, EngineRegistry, TaskServer
from ai.modules.task.types import TaskError


# =============================================================================
# A SMALL CATALOG
# =============================================================================

#: Resolved-config defaults per provider: what the resolver applies to a
#: stored config. ``local_tool`` is not a catalog node (its path is not under
#: ``nodes.``), so it can never run on a cross-user engine.
DEFAULTS: Dict[str, Dict[str, Any]] = {
    'webhook': {'type': 'webhook', 'mode': 'Source', 'hideForm': True},
    'prompt': {'instructions': ['Answer the question.']},
    'local_tool': {'depth': 1},
}
PATHS = {'webhook': 'nodes.webhook', 'prompt': 'nodes.prompt', 'local_tool': 'local_nodes.local_tool'}


@pytest.fixture
def catalog(monkeypatch):
    """Resolve configs against DEFAULTS; ``certified`` lists the multitenant providers."""
    certified = {'webhook', 'prompt', 'local_tool'}

    def resolve(provider, config):
        if provider not in DEFAULTS:
            raise ValueError(f'The service {provider} was not found')
        return SimpleNamespace(to_dict=lambda: {**DEFAULTS[provider], **(config or {})})

    def schema(provider):
        caps = MULTITENANT_BIT if provider in certified else 0
        return {'capabilities': caps} if provider in DEFAULTS else None

    monkeypatch.setattr(task_engine, 'resolve_node_config', resolve)
    monkeypatch.setattr(task_engine, 'node_schema', schema)
    monkeypatch.setattr(rocketlib, 'getServiceDefinition', lambda provider: {'path': PATHS.get(provider, '')})
    return certified


@pytest.fixture
def engines(monkeypatch):
    """Engines that 'start' (and confirm running) and 'stop' without a subprocess; returns the stop log."""
    stopped: List[tuple] = []

    async def start(self):
        # The subprocess reports its service up at once
        self._confirm_running()

    async def stop(self, reason='user'):
        stopped.append((self, reason))
        self._stop_requested = True
        self._status.state = 6  # CANCELLED

    async def terminated(self):
        return None

    monkeypatch.setattr(TaskEngine, 'start_task', start)
    monkeypatch.setattr(TaskEngine, 'stop_task', stop)
    monkeypatch.setattr(TaskEngine, 'wait_terminated', terminated)
    return stopped


class _Clock:
    """A monotonic clock the test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    """Drive the idle clocks of controls, engines and the ttl pass by hand."""
    fake_clock = _Clock()
    fake_time = SimpleNamespace(**{name: getattr(time, name) for name in dir(time) if not name.startswith('_')})
    fake_time.monotonic = lambda: fake_clock.now
    for module in (task_control, task_engine, task_server):
        monkeypatch.setattr(module, 'time', fake_time)
    return fake_clock


# =============================================================================
# HELPERS
# =============================================================================


def _server() -> TaskServer:
    """A TaskServer shell with the control and engine registries."""
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = ControlRegistry()
    ts._engines = EngineRegistry()
    ts._engine_unavailable = {}
    ts._deployment_revoked = {}
    ts._control_starts = {}
    ts._engine_restarts = {}
    ts._restart_tasks = set()
    ts._repoints = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._control_expiry = []
    ts._engine_expiry = []
    ts._expiry_gen = 0
    ts._store_instance = None
    ts._config = {}
    ts._server = MagicMock()
    ts.debug_message = MagicMock()
    ts.broadcast_server_event = AsyncMock()
    return ts


def _pipeline(*, instructions=None, parameters=None, project_id='docBrain', extra=None, name='Doc brain'):
    """A webhook -> prompt pipeline; ``extra`` appends one more component."""
    prompt_config = {} if instructions is None else {'instructions': instructions}
    components = [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
        {
            'id': 'prompt_1',
            'provider': 'prompt',
            'config': prompt_config,
            'input': [{'lane': 'questions', 'from': 'webhook_1'}],
        },
    ]
    if extra:
        components.append(extra)
    pipeline = {'project_id': project_id, 'name': name, 'source': 'webhook_1', 'components': components}
    if parameters is not None:
        pipeline['parameters'] = parameters
    return pipeline


async def _start(
    ts,
    pipeline,
    *,
    user='user-a',
    team='team-1',
    org='org-1',
    run_kind='dev',
    owner_kind='',
    deployment=None,
    **arguments,
):
    """Start (or attach) a control as ``user``, the way on_execute does."""
    request = {'command': 'execute', 'arguments': {'pipeline': copy.deepcopy(pipeline), **arguments}}
    result = await ts.start_task(
        request,
        MagicMock(),
        client_id=user,
        user_id=user,
        team_id=team,
        org_id=org,
        run_kind=run_kind,
        owner_kind=owner_kind,
        developer_id='acme',
        deployment=deployment,
    )
    rung = 'dev' if run_kind == 'dev' else ('me' if owner_kind == 'user' else 'team')
    owner = team if rung == 'team' else user
    return ts._task_control[f'{rung}.{owner}.{result["token"]}']


# =============================================================================
# THE ENGINE KEY
# =============================================================================


def test_identical_specs_hash_equal_and_defaults_do_not_matter(catalog):
    """A spec that spells a default out hashes like one that leaves it out."""
    spelled = _pipeline(instructions=['Answer the question.'])
    assert (
        engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
        == engine_content(spelled, 'webhook_1', component_facts).content_hash
    )


def test_the_parameters_map_names_and_order_stay_out_of_the_key(catalog):
    """Per-control values never move the key: parameters, project id, name, component order."""
    base = engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
    reordered = _pipeline()
    reordered['components'].reverse()
    for other in (
        _pipeline(parameters={'tone': {'node': 'prompt_1', 'key': 'instructions'}}),
        _pipeline(project_id='renamed', name='Another name'),
        reordered,
    ):
        assert engine_content(other, 'webhook_1', component_facts).content_hash == base


def test_one_config_value_apart_is_another_engine(catalog):
    """A different resolved value is different content."""
    a = engine_content(_pipeline(instructions=['Be brief.']), 'webhook_1', component_facts).content_hash
    b = engine_content(_pipeline(instructions=['Be thorough.']), 'webhook_1', component_facts).content_hash
    assert a != b


def test_the_source_and_the_wiring_are_content(catalog):
    """The entry source and the connections enter the key."""
    rewired = _pipeline()
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]
    base = engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
    assert engine_content(rewired, 'webhook_1', component_facts).content_hash != base
    assert engine_content(_pipeline(), 'prompt_1', component_facts).content_hash != base


def test_placeholders_stay_unexpanded_in_the_key(catalog):
    """The key holds the placeholder, so it never depends on whose env fills it."""
    spec = _pipeline(instructions=['${ROCKETRIDE_TONE}'])
    first = engine_content(spec, 'webhook_1', component_facts).content_hash
    assert engine_content(copy.deepcopy(spec), 'webhook_1', component_facts).content_hash == first
    assert first != engine_content(_pipeline(instructions=['friendly']), 'webhook_1', component_facts).content_hash


def test_shareable_needs_a_request_source_certified_nodes_and_the_catalog(catalog):
    """Cross-user sharing is source-first, then every node certified and from the catalog."""
    assert engine_content(_pipeline(), 'webhook_1', component_facts).shareable

    # An uncertified node keeps the engine per owner
    catalog.discard('prompt')
    assert not engine_content(_pipeline(), 'webhook_1', component_facts).shareable
    catalog.add('prompt')

    # A non-catalog node, even certified
    extra = {'id': 'tool_1', 'provider': 'local_tool', 'config': {}}
    assert not engine_content(_pipeline(extra=extra), 'webhook_1', component_facts).shareable

    # A listener (not request/response) entry source
    assert not engine_content(_pipeline(), 'prompt_1', component_facts).shareable

    # A component the resolver cannot resolve
    unknown = {'id': 'x_1', 'provider': 'no_such_node', 'config': {}}
    assert not engine_content(_pipeline(extra=unknown), 'webhook_1', component_facts).shareable


def test_the_real_resolver_applies_schema_defaults():
    """Against the engine's own schema, an empty config and its defaults spelled out are one engine."""
    from ai.common.node_config import resolve_node_config

    defaults = resolve_node_config('webhook', {}).to_dict()
    empty = {'source': 'w', 'components': [{'id': 'w', 'provider': 'webhook', 'config': {}}]}
    spelled = {'source': 'w', 'components': [{'id': 'w', 'provider': 'webhook', 'config': dict(defaults)}]}
    assert (
        engine_content(empty, 'w', component_facts).content_hash
        == engine_content(spelled, 'w', component_facts).content_hash
    )


def test_engine_key_is_the_hash_or_the_hash_qualified_by_owner():
    """A cross-user engine is keyed by content alone; a private one by content and owner."""
    assert qualified_key('abc', shareable=True, owner_id='user-a') == 'abc'
    assert qualified_key('abc', shareable=False, owner_id='user-a') == 'abc:user-a'


# =============================================================================
# CONTROLS AND HOLDS
# =============================================================================


@pytest.mark.asyncio
async def test_two_users_identical_specs_one_engine_two_controls_two_bills(catalog, engines):
    """Identical specs from two users land on ONE engine, held by two controls billed separately."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', team='team-a', org='org-a')
    b = await _start(ts, _pipeline(), user='user-b', team='team-b', org='org-b')

    assert a is not b
    assert a.task is b.task
    assert a.task.engine_key == engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
    assert a.task.holds == {a.key, b.key}
    assert list(ts._engines) == [a.task.engine_key]
    assert a.billing != b.billing
    assert (a.billing.org_id, a.billing.user_id) == ('org-a', 'user-a')
    assert (b.billing.org_id, b.billing.user_id) == ('org-b', 'user-b')


@pytest.mark.asyncio
async def test_specs_differing_only_in_parameters_share_one_engine(catalog, engines):
    """The parameters map is per control: one engine, each control keeps its own map."""
    ts = _server()
    a = await _start(ts, _pipeline(parameters={'tone': {'node': 'prompt_1', 'key': 'instructions'}}), user='user-a')
    b = await _start(ts, _pipeline(parameters={}), user='user-b')

    assert a.task is b.task
    assert a.parameters == {'tone': {'node': 'prompt_1', 'key': 'instructions'}}
    assert b.parameters == {}


@pytest.mark.asyncio
async def test_one_config_value_apart_starts_two_engines(catalog, engines):
    """A spec one value apart is another engine."""
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')
    b = await _start(ts, _pipeline(instructions=['Be thorough.']), user='user-b')

    assert a.task is not b.task
    assert len(ts._engines) == 2


@pytest.mark.asyncio
async def test_an_uncertified_node_shares_per_owner_only(catalog, engines):
    """Uncertified: the key is (hash, owner). The owner's runs share; another user does not."""
    catalog.discard('prompt')
    ts = _server()

    mine = await _start(ts, _pipeline(), user='user-a')
    # The owner's second connection attaches to the same control ...
    again = await _start(ts, _pipeline(), user='user-a', useExisting=True)
    # ... and the owner's identically-built copy under another name shares the engine
    copy_of_mine = await _start(ts, _pipeline(project_id='docBrainCopy'), user='user-a')
    theirs = await _start(ts, _pipeline(), user='user-b')

    content = engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
    assert again is mine
    assert copy_of_mine is not mine and copy_of_mine.task is mine.task
    assert mine.task.engine_key == f'{content}:user-a'
    assert theirs.task is not mine.task
    assert theirs.task.engine_key == f'{content}:user-b'


@pytest.mark.asyncio
async def test_threads_on_a_dev_spec_call_make_the_engine_private(catalog, engines):
    """A @dev spec call that moves threads off policy gets an engine of its own."""
    ts = _server()
    custom = await _start(ts, _pipeline(), user='user-a', threads=4)
    stock = await _start(ts, _pipeline(), user='user-b')

    content = engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
    assert custom.task.engine_key == f'{content}:user-a'
    assert custom.task._threads == 4
    assert stock.task.engine_key == content
    assert custom.task is not stock.task


@pytest.mark.asyncio
async def test_concurrent_starters_of_one_key_start_one_engine(catalog, monkeypatch):
    """Concurrent starters serialize on the key's start lock; the losers attach to the winner."""
    created = []

    async def slow_start(self):
        created.append(self)
        await asyncio.sleep(0.01)

    monkeypatch.setattr(TaskEngine, 'start_task', slow_start)
    ts = _server()

    controls = await asyncio.gather(*(_start(ts, _pipeline(), user=f'user-{n}') for n in range(5)))

    assert len(created) == 1
    assert {id(c.task) for c in controls} == {id(created[0])}
    assert len(created[0].holds) == 5
    assert ts._engines.starting == frozenset()


@pytest.mark.asyncio
async def test_stop_on_dev_releases_only_that_hold(catalog, engines):
    """Terminate is a release: the engine keeps serving the other holder."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a')
    b = await _start(ts, _pipeline(), user='user-b')

    await ts.stop_task(a.key)

    assert a.key not in ts._task_control
    assert ts._task_control[b.key] is b
    assert b.task.holds == {b.key}
    assert engines == []
    assert ts._engines[b.task.engine_key] is b.task


@pytest.mark.asyncio
async def test_stop_on_the_last_hold_stops_the_engine(catalog, engines):
    """The last hold's Stop takes the engine with it, and a @dev control is gone."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a')
    engine = a.task

    await ts.stop_task(a.key)

    assert engines == [(engine, 'user')]
    assert ts._task_control == {}
    assert ts._engines == {}


@pytest.mark.asyncio
async def test_the_last_control_dropping_stops_the_engine_at_once(catalog, engines, clock):
    """No linger: when the last control goes, by terminate or by its own ttl, the engine stops with it."""
    ts = _server()
    long_lived = await _start(ts, _pipeline(), user='user-a', ttl=600)
    short_lived = await _start(ts, _pipeline(), user='user-b', ttl=60)
    engine = long_lived.task

    # The long-ttl holder leaves first; the engine serves the other
    await ts.stop_task(long_lived.key)
    assert engines == [] and engine.holds == {short_lived.key}

    # The short hold lapses at 60s: it was the last, so the engine stops now
    clock.advance(60)
    await ts._ttl_cycle()
    assert ts._task_control == {}
    assert engines == [(engine, 'ttl')]
    assert ts._engines == {}


@pytest.mark.asyncio
async def test_an_inactive_engine_stops_while_a_long_ttl_control_survives(catalog, engines, clock):
    """The engine stops on its own inactivity timer; the control that holds it stays, dormant."""
    ts = _server()
    patient = await _start(ts, _pipeline(), user='user-a', ttl=24 * 3600)
    engine = patient.task

    # One second short of the timer nothing happens
    clock.advance(CONST_ENGINE_IDLE_TTL - 1)
    await ts._ttl_cycle()
    assert engines == []
    assert patient.engine_state == 'running'

    # At the timer the engine stops; the control is still the caller's
    clock.advance(1)
    await ts._ttl_cycle()
    assert engines == [(engine, 'ttl')]
    assert ts._engines == {}
    assert ts._task_control[patient.key] is patient
    assert patient.task is engine and patient.dormant
    assert patient.engine_state == 'stopped'

    # A dormant control still ages on its own ttl, then goes without a second stop
    clock.advance(24 * 3600)
    await ts._ttl_cycle()
    assert patient.key not in ts._task_control
    assert engines == [(engine, 'ttl')]


@pytest.mark.asyncio
async def test_activity_through_any_holder_keeps_the_engine_running(catalog, engines, clock):
    """Any request through any hold restarts the engine's timer; the deadline moves with it."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', ttl=24 * 3600)
    b = await _start(ts, _pipeline(), user='user-b', ttl=24 * 3600)
    engine = a.task

    # b is active at 600s: at the first deadline the engine is re-pushed
    clock.advance(600)
    b.touch()
    clock.advance(CONST_ENGINE_IDLE_TTL - 600)
    await ts._ttl_cycle()
    assert engines == []
    ((deadline, _, _),) = ts._engine_expiry
    assert deadline == 1000.0 + 600 + CONST_ENGINE_IDLE_TTL

    clock.advance(600)
    await ts._ttl_cycle()
    assert engines == [(engine, 'ttl')]
    assert a.dormant and b.dormant


@pytest.mark.asyncio
async def test_a_zero_ttl_holder_keeps_the_engine_from_aging(catalog, engines, clock):
    """A ttl-0 holder (a listener) is never scheduled, and the engine it holds does not age."""
    ts = _server()
    forever = await _start(ts, _pipeline(), user='user-a', ttl=0)
    other = await _start(ts, _pipeline(), user='user-b', ttl=24 * 3600)
    engine = forever.task

    for _ in range(100):
        clock.advance(60)
        await ts._ttl_cycle()
    assert ts._control_expiry and all(key != forever.key for _, _, key in ts._control_expiry)
    assert not engine.ages
    assert ts._task_control[forever.key] is forever
    assert engines == []

    # Once the listener goes, the engine ages again from its last activity
    await ts.stop_task(forever.key)
    assert engine.ages and engines == []
    clock.advance(CONST_ENGINE_IDLE_TTL)
    await ts._ttl_cycle()
    assert engines == [(engine, 'ttl')]
    assert other.dormant


@pytest.mark.asyncio
async def test_a_busy_holder_never_keeps_an_idle_holder_alive(catalog, engines, clock):
    """Idle time is per control: the idle holder lapses on its own ttl while the busy one stays."""
    ts = _server()
    idle = await _start(ts, _pipeline(), user='user-a', ttl=120)
    busy = await _start(ts, _pipeline(), user='user-b', ttl=60)
    assert idle.task is busy.task

    # The busy holder sends a request every 30s; the idle one sends none
    for _ in range(3):
        clock.advance(30)
        busy.touch()
        await ts._ttl_cycle()
    assert idle.key in ts._task_control

    clock.advance(30)
    busy.touch()
    await ts._ttl_cycle()

    # The idle hold is released at its own 120s; the busy one and the engine stay
    assert idle.key not in ts._task_control
    assert ts._task_control[busy.key] is busy
    assert busy.task.holds == {busy.key}
    assert engines == []


@pytest.mark.asyncio
async def test_a_busy_engine_outlives_a_patient_holder_and_stops_with_the_last(catalog, engines, clock):
    """A holder lapses on its own clock while the engine is busy; the engine stops with the last hold."""
    ts = _server()
    patient = await _start(ts, _pipeline(), user='user-a', ttl=600)
    busy = await _start(ts, _pipeline(), user='user-b', ttl=60)
    engine = busy.task

    # Busy for 1000s: the patient holder lapses at 600 on its own clock
    for _ in range(20):
        clock.advance(50)
        busy.touch()
        await ts._ttl_cycle()
    assert patient.key not in ts._task_control
    assert engines == []

    # The busy holder goes quiet and lapses at 60s: the last hold, the engine stops
    clock.advance(60)
    await ts._ttl_cycle()
    assert ts._task_control == {}
    assert engines == [(engine, 'ttl')]


@pytest.mark.asyncio
async def test_every_running_engine_is_scheduled_once(catalog, engines, clock):
    """The engine-expiry heap holds one entry per running engine; a stopped engine's entry is stale."""
    ts = _server()
    only = await _start(ts, _pipeline(), user='user-a', ttl=60)
    engine = only.task
    assert [entry[2] for entry in ts._engine_expiry] == [engine]

    clock.advance(60)
    await ts._ttl_cycle()
    assert ts._task_control == {}
    assert engines == [(engine, 'ttl')]

    # The stale entry pops and is dropped without a second stop
    clock.advance(CONST_ENGINE_IDLE_TTL)
    await ts._ttl_cycle()
    assert ts._engine_expiry == []
    assert engines == [(engine, 'ttl')]


@pytest.mark.asyncio
async def test_a_zero_ttl_holder_outlives_a_lapsing_sibling(catalog, engines, clock):
    """A ttl-0 control never expires by idle, even beside a holder that does."""
    ts = _server()
    forever = await _start(ts, _pipeline(), user='user-a', ttl=0)
    brief = await _start(ts, _pipeline(), user='user-b', ttl=60)

    clock.advance(60_000)
    await ts._ttl_cycle()

    assert brief.key not in ts._task_control
    assert ts._task_control[forever.key] is forever
    assert forever.task.holds == {forever.key}
    assert engines == []


@pytest.mark.asyncio
async def test_a_pass_pops_only_the_due_controls(catalog, engines, clock):
    """The pass touches the heap's due head only, never the whole registry."""
    ts = _server()
    for n in range(50):
        await _start(ts, _pipeline(), user=f'user-{n}', ttl=600)
    due = await _start(ts, _pipeline(), user='user-due', ttl=60)

    clock.advance(60)
    popped = await ts._ttl_cycle()

    assert popped == 1
    assert due.key not in ts._task_control
    assert len(ts._task_control) == 50
    assert len(ts._control_expiry) == 50

    # Nothing else is due: the next pass pops nothing
    clock.advance(60)
    assert await ts._ttl_cycle() == 0


@pytest.mark.asyncio
async def test_activity_after_scheduling_reschedules_the_control(catalog, engines, clock):
    """A control active since it was scheduled is re-pushed, not released at its stale deadline."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=60)

    clock.advance(50)
    control.touch()

    # The stale deadline comes up: popped, re-pushed at last activity + ttl
    clock.advance(10)
    assert await ts._ttl_cycle() == 1
    assert ts._task_control[control.key] is control
    ((deadline, _, _),) = ts._control_expiry
    assert deadline == clock.now + 50

    # Not yet due one second short of it; released at it
    clock.advance(49)
    assert await ts._ttl_cycle() == 0
    clock.advance(1)
    await ts._ttl_cycle()
    assert control.key not in ts._task_control


@pytest.mark.asyncio
async def test_a_data_request_is_activity_of_its_own_control_only(catalog, engines, clock):
    """A pipe request through one control restarts that control's clock and no other."""
    ts = _server()
    caller = await _start(ts, _pipeline(), user='user-a', ttl=60)
    other = await _start(ts, _pipeline(), user='user-b', ttl=60)
    engine = caller.task
    engine.wait_for_running = AsyncMock()
    engine._send_data = AsyncMock(return_value={'body': {'ok': True}})
    conn = SimpleNamespace(
        _server=ts,
        get_control=MagicMock(return_value=caller),
        build_response=lambda request, body: {'body': body},
        debug_message=MagicMock(),
        verify_team_permission=lambda team_id, perm: None,
    )

    clock.advance(45)
    await DataCommands.on_rrext_process(conn, {'arguments': {'token': caller.address, 'subcommand': 'open'}})

    assert caller.idle_seconds() == 0.0
    assert other.idle_seconds() == 45.0

    # The other holder lapses at its own 60s; the caller does not
    clock.advance(15)
    await ts._ttl_cycle()
    assert other.key not in ts._task_control
    assert ts._task_control[caller.key] is caller


# =============================================================================
# RESTART ON REQUEST
# =============================================================================


async def _idle_out(ts, clock) -> None:
    """Let every engine reach its inactivity timer and run the pass."""
    clock.advance(CONST_ENGINE_IDLE_TTL)
    await ts._ttl_cycle()


def _data_conn(ts, control):
    """A DataCommands stand-in resolving ``control``."""
    return SimpleNamespace(
        _server=ts,
        get_control=MagicMock(return_value=control),
        build_response=lambda request, body: {'body': body},
        debug_message=MagicMock(),
        verify_team_permission=lambda team_id, perm: None,
    )


@pytest.fixture
def serving(monkeypatch):
    """Engines that answer data requests at once."""
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock())
    monkeypatch.setattr(TaskEngine, '_send_data', AsyncMock(return_value={'body': {'ok': True}}))


@pytest.mark.asyncio
async def test_a_request_on_a_dormant_control_restarts_the_engine_under_the_same_key(catalog, engines, clock, serving):
    """No error, no re-resolve: the request starts a new engine of the same key and the control follows it."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='team-1', project_id='docBrain')
    control = await _start(
        ts, _pipeline(), user='', run_kind='deploy', owner_kind='team', deployment=deployment, ttl=3600
    )
    key_before, stopped = control.key, control.task
    await _idle_out(ts, clock)
    assert control.dormant

    response = await DataCommands.on_rrext_process(
        _data_conn(ts, control), {'arguments': {'token': control.address, 'subcommand': 'open'}}
    )

    assert response == {'body': {'ok': True}}
    engine = control.task
    assert engine is not stopped
    assert engine.engine_key == stopped.engine_key
    assert ts._engines == {engine.engine_key: engine}
    assert engine.holds == {control.key} and stopped.holds == frozenset()
    assert (control.key, control.deployment, control.ttl) == (key_before, deployment, 3600)
    assert ts._task_control[control.key] is control
    assert not control.dormant and control.engine_state == 'running'
    assert any(entry[2] is engine for entry in ts._engine_expiry)


@pytest.mark.asyncio
async def test_a_restart_carries_the_stopped_engines_shape(catalog, engines, clock):
    """A private engine with a custom thread count restarts with the same key, threads and env source."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', threads=4, ttl=3600)
    stopped = control.task
    await _idle_out(ts, clock)

    engine = await ts.ensure_engine(control)

    assert engine.engine_key == stopped.engine_key and not engine.shared
    assert engine._threads == 4
    assert engine._env_source is stopped._env_source


@pytest.mark.asyncio
async def test_concurrent_requests_after_a_stop_start_one_engine(catalog, engines, clock, monkeypatch):
    """Concurrent restarters, through one control or several, attach to the one new engine."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    b = await _start(ts, _pipeline(), user='user-b', ttl=3600)
    stopped = a.task
    await _idle_out(ts, clock)

    created = []

    async def slow_start(self):
        created.append(self)
        await asyncio.sleep(0.01)

    monkeypatch.setattr(TaskEngine, 'start_task', slow_start)
    results = await asyncio.gather(ts.ensure_engine(a), ts.ensure_engine(a), ts.ensure_engine(b))

    assert len(created) == 1
    assert all(engine is created[0] for engine in results)
    assert a.task is b.task is created[0]
    assert created[0].holds == {a.key, b.key}
    assert created[0].engine_key == stopped.engine_key
    assert ts._engines.starting == frozenset()


@pytest.mark.asyncio
async def test_status_shows_stopped_then_running(catalog, engines, clock, serving):
    """Holders see the engine stopped while dormant, and running once a request starts it."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    conn = SimpleNamespace(
        get_control=MagicMock(return_value=control),
        build_response=lambda request, body: {'body': body},
        debug_message=MagicMock(),
        verify_team_permission=lambda team_id, perm: None,
    )

    status = await TaskCommands.on_rrext_get_task_status(conn, {'arguments': {}})
    assert status['body']['engineState'] == 'running'

    await _idle_out(ts, clock)
    status = await TaskCommands.on_rrext_get_task_status(conn, {'arguments': {}})
    assert status['body']['engineState'] == 'stopped'

    await DataCommands.on_rrext_process(_data_conn(ts, control), {'arguments': {'subcommand': 'open'}})
    status = await TaskCommands.on_rrext_get_task_status(conn, {'arguments': {}})
    assert status['body']['engineState'] == 'running'


@pytest.mark.asyncio
async def test_a_dormant_control_still_resolves(catalog, engines, clock):
    """A dormant control answers its address: its next request starts the engine."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    await _idle_out(ts, clock)

    assert ts.resolve_control(control.address, _account('user-a'), 'task.data') is control


@pytest.mark.asyncio
async def test_a_failed_restart_leaves_the_control_dormant(catalog, engines, clock, monkeypatch):
    """A start that fails puts the control back on its stopped engine; the next request tries again."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    stopped = control.task
    await _idle_out(ts, clock)

    async def failing_start(self):
        raise RuntimeError('no ports')

    monkeypatch.setattr(TaskEngine, 'start_task', failing_start)
    with pytest.raises(RuntimeError, match='no ports'):
        await ts.ensure_engine(control)

    assert control.task is stopped and control.dormant
    assert stopped.holds == {control.key}
    assert ts._engines == {} and ts._engines.starting == frozenset()


@pytest.mark.asyncio
async def test_terminate_on_a_dormant_dev_control_means_gone(catalog, engines, clock):
    """Stop means gone: a dormant @dev control is removed, its stopped engine is not stopped twice."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    engine = control.task
    await _idle_out(ts, clock)

    await ts.stop_task(control.key)

    assert ts._task_control == {}
    assert engines == [(engine, 'ttl')]


@pytest.mark.asyncio
async def test_use_existing_restarts_a_dormant_control(catalog, engines, clock):
    """Play with useExisting on a dormant control reuses the control and starts its engine."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    stopped = control.task
    await _idle_out(ts, clock)

    again = await _start(ts, _pipeline(), user='user-a', useExisting=True)

    assert again is control
    assert control.task is not stopped and control.engine_state == 'running'


# =============================================================================
# CRASH RESTART
# =============================================================================


async def _crash(engine, exit_code=139) -> None:
    """The subprocess dies on its own: its exit code, then the real teardown."""
    engine._status.exitCode = exit_code
    engine._status.exitMessage = 'Segmentation fault'
    engine._exit_event_seen = True
    await engine._terminated()


def _lister(ts, user):
    """A TaskCommands stand-in listing as ``user``."""
    return SimpleNamespace(
        _server=ts,
        _account_info=_account(user),
        build_response=lambda request, body: {'body': body},
        debug_message=MagicMock(),
        verify_team_permission=lambda team_id, perm: None,
    )


def _listed(response) -> List[tuple]:
    """The (token, engineState) pairs of an rrext_get_tasks response."""
    return [(task['token'], task['engineState']) for task in response['body']['tasks']]


@pytest.mark.asyncio
async def test_a_crash_after_running_leaves_the_controls_dormant_and_restarts(catalog, engines, serving):
    """A crash after the running confirmation is a timer stop: holders stay, the next request restarts the key."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    b = await _start(ts, _pipeline(), user='user-b', ttl=3600)
    crashed = a.task
    assert crashed.reached_running

    await _crash(crashed)

    # Both holders stay, dormant; the crashed engine left the pool
    assert crashed.dormant_reason == 'crash'
    assert a.dormant and b.dormant
    assert a.engine_state == 'stopped' and b.engine_state == 'stopped'
    assert ts._task_control[a.key] is a and ts._task_control[b.key] is b
    assert ts._engines == {}
    assert ts.resolve_control(a.address, _account('user-a'), 'task.data') is a

    # The next request starts the same key again, with no error
    response = await DataCommands.on_rrext_process(_data_conn(ts, a), {'arguments': {'subcommand': 'open'}})
    assert response == {'body': {'ok': True}}
    assert a.task is not crashed and a.task.engine_key == crashed.engine_key
    assert ts._engines == {crashed.engine_key: a.task}
    assert not a.dormant and a.engine_state == 'running'

    # The other holder attaches to the new engine on its own next request
    assert await ts.ensure_engine(b) is a.task


@pytest.mark.asyncio
async def test_a_crash_before_running_is_not_retried(catalog, engines, monkeypatch):
    """An engine that never confirmed running is not restarted: the control sees the failure, as before."""
    ts = _server()

    async def start_without_running(self):
        return None

    monkeypatch.setattr(TaskEngine, 'start_task', start_without_running)
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    failed = control.task
    assert control.engine_state == 'starting'

    await _crash(failed, exit_code=1)

    # Not dormant, not live: a finished run, removed by the cleanup pass
    assert failed.dormant_reason is None and not failed.reached_running
    assert not control.dormant and not control.live
    assert control.engine_state == 'stopped'
    assert await ts.ensure_engine(control) is failed
    assert _listed(await TaskCommands.on_rrext_get_tasks(_lister(ts, 'user-a'), {})) == []


@pytest.mark.asyncio
async def test_a_natural_completion_is_not_a_crash(catalog, engines):
    """An engine that exits with code 0 after running completed: no restart."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)

    await _crash(control.task, exit_code=0)

    assert control.task.dormant_reason is None
    assert not control.dormant and not control.live


@pytest.mark.asyncio
async def test_an_operator_stop_never_restarts(catalog, engines):
    """rrext_engine_stop is not a crash: holders are told engine_unavailable and nothing restarts."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    engine = control.task

    await ts.stop_engine(engine.engine_key, 'maintenance')
    await engine._terminated()

    assert engine.dormant_reason is None and not control.dormant
    assert await ts.ensure_engine(control) is engine
    assert len(engines) == 1
    with pytest.raises(TaskError) as told:
        ts.resolve_control(control.address, _account('user-a'), 'task.data')
    assert told.value.code == TaskError.ENGINE_UNAVAILABLE


@pytest.mark.asyncio
async def test_terminate_after_a_crash_still_means_gone(catalog, engines):
    """Stop means gone: terminate on a crash-dormant @dev control removes it without a second stop."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    await _crash(control.task)

    await ts.stop_task(control.key)

    assert ts._task_control == {}
    assert engines == []


@pytest.mark.asyncio
async def test_task_lists_show_dormant_and_starting_controls(catalog, engines, clock, monkeypatch):
    """rrext_get_tasks lists a dormant control as 'stopped' and a restarting one as 'starting'."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    lister = _lister(ts, 'user-a')
    assert _listed(await TaskCommands.on_rrext_get_tasks(lister, {})) == [(control.address, 'running')]

    # Dormant: listed, stopped
    await _idle_out(ts, clock)
    assert _listed(await TaskCommands.on_rrext_get_tasks(lister, {})) == [(control.address, 'stopped')]

    # Restarting: listed, starting, while the start runs and until the
    # engine confirms running
    release = asyncio.Event()

    async def slow_start(self):
        await release.wait()

    monkeypatch.setattr(TaskEngine, 'start_task', slow_start)
    restart = asyncio.ensure_future(ts.ensure_engine(control))
    await asyncio.sleep(0)
    assert _listed(await TaskCommands.on_rrext_get_tasks(lister, {})) == [(control.address, 'starting')]

    release.set()
    engine = await restart
    assert _listed(await TaskCommands.on_rrext_get_tasks(lister, {})) == [(control.address, 'starting')]
    engine._confirm_running()
    assert _listed(await TaskCommands.on_rrext_get_tasks(lister, {})) == [(control.address, 'running')]


@pytest.mark.asyncio
async def test_status_shows_starting_while_in_the_start_gate(catalog, engines, clock, monkeypatch):
    """The status body reads 'starting' while a request waits in the gate for its stopped engine."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    other = await _start(ts, _pipeline(), user='user-b', ttl=3600)
    conn = SimpleNamespace(
        get_control=MagicMock(return_value=control),
        build_response=lambda request, body: {'body': body},
        debug_message=MagicMock(),
        verify_team_permission=lambda team_id, perm: None,
    )
    await _idle_out(ts, clock)

    # Another holder's restart holds the gate; this control waits behind it
    release = asyncio.Event()

    async def slow_start(self):
        await release.wait()
        self._confirm_running()

    monkeypatch.setattr(TaskEngine, 'start_task', slow_start)
    first = asyncio.ensure_future(ts.ensure_engine(other))
    await asyncio.sleep(0)
    waiting = asyncio.ensure_future(ts.ensure_engine(control))
    await asyncio.sleep(0)
    assert control.task.dormant_reason == 'ttl'

    status = await TaskCommands.on_rrext_get_task_status(conn, {'arguments': {}})
    assert status['body']['engineState'] == 'starting'

    release.set()
    await asyncio.gather(first, waiting)
    status = await TaskCommands.on_rrext_get_task_status(conn, {'arguments': {}})
    assert status['body']['engineState'] == 'running'
    assert not control.engine_starting


@pytest.mark.asyncio
async def test_publisher_disable_releases_the_deployment_holds(catalog, engines):
    """Disable releases every hold that resolved through the deployment; others keep the engine."""
    catalog.discard('prompt')  # per-owner engine: the owner's dev run and @me deploy share it
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='user~user-a', project_id='docBrain')
    dev = await _start(ts, _pipeline(), user='user-a')
    deployed = await _start(ts, _pipeline(), user='user-a', run_kind='deploy', owner_kind='user', deployment=deployment)
    assert dev.task is deployed.task and deployed.rung == 'me'

    # Enabling releases nothing
    await deploy_events.release_deployment_holds(ts, 'org-1', 'user~user-a', 'docBrain', 'enabled')
    assert deployed.key in ts._task_control

    await deploy_events.release_deployment_holds(ts, 'org-1', 'user~user-a', 'docBrain', 'disabled')
    assert deployed.key not in ts._task_control
    assert ts._task_control[dev.key] is dev
    assert dev.task.holds == {dev.key}
    assert engines == []


@pytest.mark.asyncio
async def test_publisher_remove_stops_an_engine_only_the_deployment_held(catalog, engines):
    """With no other holder the kill switch stops the engine: no back door."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='team-1', project_id='docBrain')
    run = await _start(ts, _pipeline(), user='', run_kind='deploy', owner_kind='team', deployment=deployment)
    engine = run.task

    await deploy_events.release_deployment_holds(ts, 'org-1', 'team-1', 'docBrain', 'removed')

    assert ts._task_control == {}
    assert engines == [(engine, 'unpublished')]
    assert ts._engines == {}


@pytest.mark.asyncio
async def test_a_deployment_revoked_while_its_run_started_is_never_registered(catalog, engines):
    """The dispatch read the deployment enabled, then it was disabled while the artifact loaded: refused."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='team-1', project_id='docBrain')
    state_epoch = time.monotonic()
    await asyncio.sleep(0.05)  # the artifact loads (a monotonic tick is 15 ms on Windows)
    await ts.release_deployment_holds(deployment)  # the disable lands after the state read

    with pytest.raises(TaskError) as err:
        await ts.start_task(
            {'command': 'execute', 'arguments': {'pipeline': _pipeline()}},
            MagicMock(),
            client_id='',
            user_id='',
            team_id='team-1',
            org_id='org-1',
            run_kind='deploy',
            owner_kind='team',
            developer_id='acme',
            deployment=deployment,
            deployment_epoch=state_epoch,
        )
    assert (err.value.code, err.value.reason) == (TaskError.ENGINE_UNAVAILABLE, 'unpublished')
    assert ts._task_control == {}
    assert ts._engines == {}

    # A state read AFTER the revocation (a re-enable, a later fire) registers as before
    await asyncio.sleep(0.05)
    run = await _start(ts, _pipeline(), user='', run_kind='deploy', owner_kind='team', deployment=deployment)
    assert run.key in ts._task_control


@pytest.mark.asyncio
async def test_a_hold_the_release_pass_could_not_drop_is_refused_on_its_next_request(catalog, engines, monkeypatch):
    """One failed remove never leaves a disabled deployment serving: the pass goes on, reports, and the resolver refuses."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='user~user-a', project_id='docBrain')
    first = await _start(ts, _pipeline(), run_kind='deploy', owner_kind='user', deployment=deployment)
    second = await _start(
        ts, _pipeline(), run_kind='deploy', owner_kind='user', deployment=deployment, token='docBrain2'
    )
    assert ts.resolve_control(first.address, _account('user-a'), 'task.data') is first
    await asyncio.sleep(0.05)  # the disable comes later than the registrations

    real_remove = ts.remove_task

    async def flaky_remove(key, **kwargs):
        if key == first.key:
            raise RuntimeError('store hiccup')
        await real_remove(key, **kwargs)

    monkeypatch.setattr(ts, 'remove_task', flaky_remove)
    with pytest.raises(RuntimeError, match='1 hold'):
        await ts.release_deployment_holds(deployment)

    # The second hold went; the first is still registered but refused, and dropped, on its next request
    assert second.key not in ts._task_control
    assert first.key in ts._task_control
    with pytest.raises(TaskError) as err:
        ts.resolve_control(first.address, _account('user-a'), 'task.data')
    assert (err.value.code, err.value.reason) == (TaskError.ENGINE_UNAVAILABLE, 'unpublished')
    assert first.key not in ts._task_control


# =============================================================================
# THE OPERATOR'S STOP
# =============================================================================


def _conn(sys_permissions):
    conn = MagicMock()
    conn._account_info = AccountInfo(
        auth='rr_key',
        userId='ops-1',
        sysPermissions=sys_permissions,
        organization={'id': 'org-1', 'name': '', 'permissions': [], 'teams': [], 'developerId': 'acme'},
    )
    conn._server = MagicMock()
    conn._server.stop_engine = AsyncMock()
    conn.build_response = MagicMock(return_value={'type': 'response'})
    return conn


@pytest.mark.asyncio
@pytest.mark.parametrize('sys_permissions', [[], ['sys.app']])
async def test_engine_stop_requires_sys_admin(sys_permissions):
    """Only sys.admin / internal may stop an engine."""
    conn = _conn(sys_permissions)
    with pytest.raises(PermissionError):
        await TaskCommands.on_rrext_engine_stop(conn, {'arguments': {'engineKey': 'abc'}})
    conn._server.stop_engine.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('sys_permissions', [['sys.admin'], ['internal']])
async def test_engine_stop_runs_for_operators(sys_permissions):
    """An operator's stop reaches the server with the key and the reason."""
    conn = _conn(sys_permissions)
    await TaskCommands.on_rrext_engine_stop(conn, {'arguments': {'engineKey': 'abc', 'reason': 'maintenance'}})
    conn._server.stop_engine.assert_awaited_once_with('abc', 'maintenance')


def _account(user_id):
    return AccountInfo(
        auth='rr_key',
        userId=user_id,
        devTeam='team-1',
        organization={
            'id': 'org-1',
            'name': '',
            'permissions': [],
            'teams': [{'id': 'team-1', 'name': '', 'permissions': ['task.control', 'task.data', 'task.monitor']}],
            'developerId': 'acme',
        },
    )


@pytest.mark.asyncio
async def test_every_holder_is_told_engine_unavailable_once(catalog, engines):
    """Each holder's next request gets TASK_ENGINE_UNAVAILABLE; the one after re-resolves."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a')
    b = await _start(ts, _pipeline(), user='user-b')
    key = a.task.engine_key

    await ts.stop_engine(key, 'maintenance')
    assert engines == [(a.task, 'maintenance')]

    for control, user in ((a, 'user-a'), (b, 'user-b')):
        with pytest.raises(TaskError) as told:
            ts.resolve_control(control.address, _account(user), 'task.data')
        assert told.value.code == TaskError.ENGINE_UNAVAILABLE
        assert (told.value.engineKey, told.value.reason) == (key, 'maintenance')

        with pytest.raises(TaskError) as again:
            ts.resolve_control(control.address, _account(user), 'task.data')
        assert again.value.code == TaskError.NOT_REGISTERED


@pytest.mark.asyncio
async def test_stopping_an_unknown_engine_says_so():
    ts = _server()
    with pytest.raises(TaskError) as err:
        await ts.stop_engine('nope')
    assert err.value.code == TaskError.NOT_REGISTERED


# =============================================================================
# THE TASK FILE
# =============================================================================


def _engine(*, shared, pipeline):
    return TaskEngine(
        server=MagicMock(),
        id='acme.docBrain.webhook_1',
        project_id='docBrain',
        source='webhook_1',
        engine_key='hash-1' if shared else 'hash-1:user-a',
        address='acme.docBrain.webhook_1',
        pipeline=pipeline,
        shared=shared,
        threads=8,
        trace_level='none' if shared else 'full',
        client_id='' if shared else 'user-a',
        team_id='team-1',
        org_id='org-1',
    )


def test_build_task_round_trips_parameters_and_names_the_engine(monkeypatch, tmp_path):
    """The task file carries the parameters map and the engine key as taskId, never the address."""
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    parameters = {'tone': {'node': 'prompt_1', 'key': 'instructions'}}
    pipeline = _pipeline(parameters=parameters)
    engine = _engine(shared=False, pipeline=pipeline)

    task = engine._build_task(pipeline)

    assert task['config']['pipeline']['parameters'] == parameters
    assert task['taskId'] == 'hash-1:user-a'
    assert 'acme.docBrain' not in task['taskId']
    assert task['config']['threadCount'] == 8
    assert task['config']['pipelineTraceLevel'] == 'full'


def test_every_launch_writes_a_fresh_trace_epoch(monkeypatch, tmp_path):
    """Two engines (or two launches of one) never share an epoch, so their traceIds never collide (P31)."""
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    pipeline = _pipeline()
    first = _engine(shared=False, pipeline=pipeline)._build_task(pipeline)['config']['traceEpoch']
    second = _engine(shared=True, pipeline=pipeline)._build_task(pipeline)['config']['traceEpoch']

    assert 0 < first < 0x10000 and 0 < second < 0x10000
    assert second != first

    # The epoch is 16 bits and never 0: it wraps from 65535 to 1
    monkeypatch.setattr(task_engine, '_trace_epochs', iter([0xFFFF, 0x10000]))
    assert [task_engine.next_trace_epoch(), task_engine.next_trace_epoch()] == [0xFFFF, 1]


def test_a_cross_user_engine_names_no_user(monkeypatch, tmp_path):
    """S13: the identity block names a user only on a (hash, owner) engine."""
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    pipeline = _pipeline()

    shared = _engine(shared=True, pipeline=pipeline)._build_task(pipeline)
    private = _engine(shared=False, pipeline=pipeline)._build_task(pipeline)

    assert shared['identity'] == {'userId': '', 'teamId': '', 'orgId': ''}
    assert shared['storage'] == {'root': ''}
    assert shared['config']['pipelineTraceLevel'] == 'none'
    assert private['identity'] == {'userId': 'user-a', 'teamId': 'team-1', 'orgId': 'org-1'}
    assert private['storage'] == {'root': 'users/user-a/files'}


@pytest.mark.asyncio
async def test_start_task_builds_a_cross_user_engine_without_a_user_or_env(catalog, engines):
    """The shared engine is nobody's: no client id, no caller env, default trace off."""
    ts = _server()
    env_source = AsyncMock(return_value={'ROCKETRIDE_TONE': 'secret-of-a'})
    request = {'command': 'execute', 'arguments': {'pipeline': _pipeline(), 'pipelineTraceLevel': 'full'}}
    await ts.start_task(
        request,
        MagicMock(),
        client_id='user-a',
        user_id='user-a',
        team_id='team-1',
        org_id='org-1',
        developer_id='acme',
        env_source=env_source,
    )
    (control,) = ts._task_control.values()
    engine = control.task

    assert engine.shared and engine.client_id == ''
    assert engine._pipelineTraceLevel == 'none'
    assert control.trace_level == 'full'
    assert await engine._env_source() == {}
    env_source.assert_not_awaited()


def test_metrics_accumulate_per_trace_for_their_own_control():
    """Per-trace accumulators attribute each request tree to one control, for life."""
    from ai.modules.task.task_metrics import TaskMetrics

    metrics = TaskMetrics.__new__(TaskMetrics)
    metrics.traces = {}
    usage = metrics.trace(7, 'dev.user-a.acme.docBrain.webhook_1')
    assert metrics.trace(7, 'dev.user-a.acme.docBrain.webhook_1') is usage
    with pytest.raises(ValueError):
        metrics.trace(7, 'dev.user-b.acme.docBrain.webhook_1')


# =============================================================================
# THE RESOLVER: RUNGS, PUBLISHED STARTS AND THE INDEX (plan 3.2, 14 Step 3)
# =============================================================================

ADDRESS = 'acme.docBrain.webhook_1'


class _Deployments:
    """
    The account's deployment surface, in memory: deployments by slot, review
    states, public publications, artifacts and developer ids.
    """

    def __init__(self) -> None:
        self.capabilities = ()
        self.deployments: Dict[tuple, Dict[str, Any]] = {}
        self.states: Dict[tuple, str] = {}
        self.publics: Dict[tuple, Dict[str, Any]] = {}
        self.artifacts: Dict[tuple, Dict[str, Any]] = {}
        self.developer_orgs = {'acme': 'org-1'}

    def deploy(
        self,
        slot,
        *,
        org='org-1',
        version=1,
        state='enabled',
        billing='team-1',
        review='ready',
        pipeline=None,
        project='docBrain',
    ):
        self.deployments[(org, slot, project)] = {
            'teamId': slot,
            'version': version,
            'state': state,
            'billingTeamId': billing,
        }
        self.states[(org, project, version)] = review
        self.artifacts[(org, project, version)] = pipeline or _pipeline(project_id=project)

    def publish(self, *, org='org-1', version=1, state='enabled', review='ready'):
        self.publics[(org, 'docBrain')] = {'version': version, 'state': state, 'artifactState': review}
        self.states[(org, 'docBrain', version)] = review
        self.artifacts[(org, 'docBrain', version)] = _pipeline()

    async def deployments_get(self, org_id, team_id, project_id):
        return self.deployments.get((org_id, team_id, project_id))

    async def deployments_versions(self, org_id, project_id):
        return [
            {'version': version, 'kind': 'pipe', 'state': state}
            for (org, pipe, version), state in self.states.items()
            if (org, pipe) == (org_id, project_id)
        ]

    async def publish_get(self, org_id, kind, app_id, audience):
        # The audience-publish table (published_apps) of the row source
        assert kind == 'app'
        if audience != {'type': 'public', 'id': ''}:
            return None
        return self.publics.get((org_id, app_id))

    async def deployments_artifact(self, org_id, project_id, version):
        return copy.deepcopy(self.artifacts[(org_id, project_id, version)])

    async def get_org_of_developer_id(self, developer_id):
        return self.developer_orgs.get(developer_id)

    async def get_developer_id(self, org_id):
        return next((dev for dev, org in self.developer_orgs.items() if org == org_id), None)

    async def get_merged_env(self, user_id, org_id, team_id):
        return {}


@pytest.fixture
def deployments(monkeypatch, serving):
    """The in-memory deployment surface behind ``ai.account.account``."""
    import ai.account

    fake = _Deployments()
    monkeypatch.setattr(ai.account, 'account', fake)
    return fake


def _caller(
    user_id='user-a', *, dev_team='team-1', teams=('team-1',), org='org-1', developer_id='acme', endpoints=None
):
    """An account with task permissions on each of ``teams``."""
    perms = ['task.control', 'task.data', 'task.monitor']
    return AccountInfo(
        auth='rr_key',
        userId=user_id,
        devTeam=dev_team,
        organization={
            'id': org,
            'name': '',
            'permissions': [],
            'teams': [{'id': team, 'name': '', 'permissions': perms} for team in teams],
            'developerId': developer_id,
        },
        endpoints=endpoints,
    )


@pytest.mark.asyncio
async def test_play_creates_the_dev_control_and_a_name_call_attaches_to_it(catalog, engines, deployments):
    """@dev is attach-only: a name finds the caller's Play'd control and starts nothing."""
    ts = _server()
    deployments.deploy('user~user-a', billing='team-1')
    played = await _start(ts, _pipeline(), user='user-a')

    resolved = await ts.resolve_or_start(ADDRESS, _caller('user-a'), 'task.data')

    assert resolved is played and resolved.rung == 'dev'
    assert list(ts._task_control) == [played.key]


@pytest.mark.asyncio
async def test_a_dead_dev_falls_through_to_me_started_from_the_artifact(catalog, engines, deployments):
    """Stop means gone: the name falls through to @me, which starts from the artifact with trigger='process'."""
    ts = _server()
    deployments.deploy('user~user-a', billing='team-1')
    played = await _start(ts, _pipeline(), user='user-a')
    await ts.stop_task(played.key)

    control = await ts.resolve_or_start(ADDRESS, _caller('user-a'), 'task.data')

    assert control.rung == 'me' and control.key == f'me.user-a.{ADDRESS}'
    assert (control.run_kind, control.owner_kind, control.owner_id) == ('deploy', 'user', 'user-a')
    assert control.trigger == 'process'
    assert control.deployment == DeploymentRef(org_id='org-1', team_id='user~user-a', project_id='docBrain')
    assert control.teamId == 'team-1' and control.engine_state == 'running'

    # The next name call attaches to it
    assert await ts.resolve_or_start(ADDRESS, _caller('user-a'), 'task.data') is control


@pytest.mark.asyncio
async def test_without_a_personal_deployment_the_team_answers(catalog, engines, deployments):
    """@team: the deployment of the caller's team, owned by that team."""
    ts = _server()
    deployments.deploy('team-1')

    control = await ts.resolve_or_start(ADDRESS, _caller('user-a'), 'task.data')

    assert control.rung == 'team' and control.key == f'team.team-1.{ADDRESS}'
    assert (control.owner_kind, control.owner_id) == ('team', 'team-1')
    assert control.deployment == DeploymentRef(org_id='org-1', team_id='team-1', project_id='docBrain')

    # A teammate resolves the same team control through the owner index
    assert ts.resolve_control(ADDRESS, _caller('user-b'), 'task.data') is control


@pytest.mark.asyncio
async def test_a_non_owner_falls_past_the_owners_play_to_the_publication(catalog, engines, deployments):
    """Nobody can name another user's control: user-b reaches the team publication, not user-a's @dev."""
    ts = _server()
    deployments.deploy('team-1')
    played = await _start(ts, _pipeline(), user='user-a')

    control = await ts.resolve_or_start(ADDRESS, _caller('user-b'), 'task.data')

    assert control is not played and control.rung == 'team'
    # Identical content: the publication shares the Play'd engine
    assert control.task is played.task


@pytest.mark.asyncio
async def test_a_public_control_is_the_callers_and_carries_the_publishers_deployment(catalog, engines, deployments):
    """@public across orgs: owned and billed by the caller, released by the publisher's deployment."""
    ts = _server()
    deployments.publish(org='org-1')
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')

    control = await ts.resolve_or_start(ADDRESS, stranger, 'task.data')

    assert control.rung == 'public' and control.key == f'public.user-z.{ADDRESS}'
    assert control.address == ADDRESS
    assert (control.owner_kind, control.owner_id, control.userId) == ('user', 'user-z', 'user-z')
    assert (control.orgId, control.teamId) == ('org-2', 'team-z')
    assert control.deployment == DeploymentRef(org_id='org-1', team_id='~public', project_id='docBrain')
    assert control.trigger == 'process'
    assert ts.resolve_control(ADDRESS, stranger, 'task.data') is control

    # The publisher's kill switch releases it
    assert await ts.release_deployment_holds(control.deployment) == 1
    assert control.key not in ts._task_control


@pytest.mark.asyncio
async def test_public_needs_ready_and_an_enabled_binding(catalog, engines, deployments):
    """The pipe serving gate: a public publication serves only a ready deployment that is enabled."""
    ts = _server()
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')
    for state, review in (('enabled', 'submit'), ('disabled', 'ready'), ('enabled', 'failed')):
        deployments.publish(state=state, review=review)
        with pytest.raises(TaskError) as err:
            await ts.resolve_or_start(ADDRESS, stranger, 'task.data')
        assert err.value.code == TaskError.NOT_REGISTERED


@pytest.mark.asyncio
async def test_a_scoped_key_skips_dev_and_starts_at_me(catalog, engines, deployments):
    """A production webhook key never lands on the owner's Play'd run."""
    ts = _server()
    deployments.deploy('user~user-a', billing='team-1')
    played = await _start(ts, _pipeline(), user='user-a')
    scoped = _caller('user-a', endpoints=[ADDRESS])

    control = await ts.resolve_or_start(ADDRESS, scoped, 'task.data')

    assert control is not played and control.rung == 'me'

    # Outside its scope the key is refused before anything starts
    with pytest.raises(PermissionError):
        await ts.resolve_or_start('acme.otherPipe.webhook_1', scoped, 'task.data')


@pytest.mark.asyncio
async def test_not_registered_lists_the_rungs_actually_tried(catalog, engines, deployments):
    """not_found names the rungs walked; a scoped key never tried @dev."""
    ts = _server()
    for account, rungs in (
        (_caller('user-a'), ['@dev', '@me', '@team', '@public']),
        (_caller('user-a', endpoints=[ADDRESS]), ['@me', '@team', '@public']),
    ):
        with pytest.raises(TaskError) as err:
            await ts.resolve_or_start(ADDRESS, account, 'task.data')
        assert err.value.code == TaskError.NOT_REGISTERED
        assert err.value.rungsTried == rungs
        with pytest.raises(TaskError) as err:
            ts.resolve_control(ADDRESS, account, 'task.data')
        assert err.value.rungsTried == rungs


def _order(first, *, endpoints=None, teams=('staging', 'production')):
    """A member of Staging and Production whose team order starts with ``first``."""
    return _caller('user-a', dev_team=first, teams=teams, endpoints=endpoints)


def _two_environments(deployments):
    """Publish docBrain to Staging v5 and Production v4, and otherPipe to Production v4 only."""
    deployments.deploy('staging', version=5, billing='staging', pipeline=_pipeline(instructions=['v5']))
    deployments.deploy('production', version=4, billing='production', pipeline=_pipeline(instructions=['v4']))
    deployments.deploy(
        'production',
        version=4,
        billing='production',
        project='otherPipe',
        pipeline=_pipeline(project_id='otherPipe'),
    )


@pytest.mark.asyncio
async def test_team_order_answers_from_the_first_team_holding_the_name(catalog, engines, deployments):
    """Staging first: Staging's v5 for a pipe on both, Production's v4 for a pipe only Production holds."""
    ts = _server()
    _two_environments(deployments)

    both = await ts.resolve_or_start(ADDRESS, _order('staging'), 'task.data')
    only = await ts.resolve_or_start('acme.otherPipe.webhook_1', _order('staging'), 'task.data')

    assert (both.rung, both.owner_id, both.version) == ('team', 'staging', 5)
    assert (only.rung, only.owner_id, only.version) == ('team', 'production', 4)
    assert both.deployment.team_id == 'staging'


@pytest.mark.asyncio
async def test_reordering_flips_the_next_call_and_team_overrides_one_call(catalog, engines, deployments):
    """A reorder answers from the new first team even with the old one live; team= overrides one call."""
    ts = _server()
    _two_environments(deployments)
    staging = await ts.resolve_or_start(ADDRESS, _order('staging'), 'task.data')

    production = await ts.resolve_or_start(ADDRESS, _order('production'), 'task.data')
    assert (production.owner_id, production.version) == ('production', 4)

    # The live staging control answers the override; the order is back for the next call
    assert await ts.resolve_or_start(ADDRESS, _order('production'), 'task.data', team='staging') is staging
    assert ts.resolve_control(ADDRESS, _order('production'), 'task.data') is production
    with pytest.raises(PermissionError):
        await ts.resolve_or_start(ADDRESS, _order('production'), 'task.data', team='elsewhere')


@pytest.mark.asyncio
async def test_a_key_frozen_to_production_ignores_its_owners_order(catalog, engines, deployments):
    """An endpoints-scoped key resolves @team through its frozen team only."""
    ts = _server()
    _two_environments(deployments)
    key = _order('staging', endpoints=[ADDRESS], teams=('production',))

    control = await ts.resolve_or_start(ADDRESS, key, 'task.data')

    assert (control.owner_id, control.version) == ('production', 4)
    assert control.team_context == TeamContext('production', 'key')

    # A scoped key not pinned to one team resolves no team at all
    unpinned = _order('staging', endpoints=['acme.otherPipe.webhook_1'])
    with pytest.raises(TaskError) as err:
        await ts.resolve_or_start('acme.otherPipe.webhook_1', unpinned, 'task.data')
    assert err.value.code == TaskError.NOT_REGISTERED


@pytest.mark.asyncio
async def test_the_team_context_is_the_answering_team_and_home_elsewhere(catalog, engines, deployments):
    """@team runs with the answering team's context; Play and @public with the caller's home team."""
    ts = _server()
    _two_environments(deployments)

    answered = await ts.resolve_or_start(ADDRESS, _order('production', teams=('production', 'staging')), 'task.data')
    assert answered.team_context == TeamContext('production', 'answering')

    played = await _start(ts, _pipeline(), user='user-a', team='staging')
    assert played.team_context == TeamContext('staging', 'home')

    deployments.publish(org='org-1')
    stranger = _caller('user-z', dev_team='team-z', teams=('team-y', 'team-z'), org='org-2', developer_id='globex')
    public = await ts.resolve_or_start(ADDRESS, stranger, 'task.data')
    assert public.team_context == TeamContext('team-z', 'home') and public.teamId == 'team-z'


@pytest.mark.asyncio
async def test_a_two_segment_address_with_several_live_sources_needs_a_source(catalog, engines):
    """The source index finds both live sources; the caller must name one."""
    ts = _server()
    webhook = await _start(ts, _pipeline(), user='user-a')
    prompt = await _start(ts, _pipeline(), user='user-a', source='prompt_1')

    with pytest.raises(TaskError) as err:
        ts.resolve_control('acme.docBrain', _caller('user-a'), 'task.data')
    assert err.value.code == TaskError.SOURCE_REQUIRED
    assert err.value.sources == ['prompt_1', 'webhook_1']

    await ts.stop_task(prompt.key)
    assert ts.resolve_control('acme.docBrain', _caller('user-a'), 'task.data') is webhook
    assert ts._task_control.sources_of('acme', 'docBrain') == ['webhook_1']


@pytest.mark.asyncio
async def test_a_two_segment_name_starts_the_artifacts_default_source(catalog, engines, deployments):
    """With nothing live, a two-segment name starts the pinned artifact's default source."""
    ts = _server()
    deployments.deploy('team-1')

    control = await ts.resolve_or_start('acme.docBrain', _caller('user-a'), 'task.data')

    assert control.address == ADDRESS and control.rung == 'team'


def test_a_resolve_touches_constant_entries_however_large_the_registry():
    """100,000 controls at other addresses: a resolve probes O(1) + one per team."""
    ts = _server()
    registry = ts._task_control
    for n in range(100_000):
        other = TaskControl(
            developer_id='acme', project_id=f'pipe{n}', source='webhook_1', userId=f'user-{n % 97}', teamId='team-1'
        )
        other.address = f'acme.pipe{n}.webhook_1'
        other.key = f'dev.{other.userId}.{other.address}'
        registry[other.key] = other
    mine = TaskControl(developer_id='acme', project_id='docBrain', source='webhook_1', userId='user-a', teamId='team-1')
    mine.address, mine.key = ADDRESS, f'dev.user-a.{ADDRESS}'
    mine.task = MagicMock()
    mine.task.is_task_complete.return_value = False
    mine.task.dormant_reason = None
    registry[mine.key] = mine
    teams = tuple(f'team-{n}' for n in range(5))

    # A hit on @dev: one exact-key probe
    registry.probes = 0
    assert ts.resolve_control(ADDRESS, _caller('user-a', teams=teams), 'task.data') is mine
    assert registry.probes == 1

    # A miss on every rung, twice (live, then registered): dev + me + teams + public per walk
    registry.probes = 0
    with pytest.raises(TaskError):
        ts.resolve_control('acme.nowhere.webhook_1', _caller('user-a', teams=teams), 'task.data')
    assert registry.probes == 2 * (3 + len(teams))

    # The forget path keeps the indexes exact
    del registry[mine.key]
    assert registry.owned(ADDRESS, 'user-a') == [] and registry.sources_of('acme', 'docBrain') == []


@pytest.fixture
def restarts(monkeypatch):
    """Automatic restarts without waiting: the backoffs are recorded and pass at once."""
    slept: List[float] = []
    real_sleep = asyncio.sleep

    async def sleep(seconds):
        slept.append(seconds)
        await real_sleep(0)

    fake_asyncio = SimpleNamespace(
        **{name: getattr(asyncio, name) for name in dir(asyncio) if not name.startswith('_')}
    )
    fake_asyncio.sleep = sleep
    monkeypatch.setattr(task_server, 'asyncio', fake_asyncio)
    warned = MagicMock()
    monkeypatch.setattr(task_server, 'warning', warned)
    return SimpleNamespace(slept=slept, warned=warned)


async def _settle(ts) -> None:
    """Let every pending automatic restart run."""
    while ts._restart_tasks:
        await asyncio.gather(*list(ts._restart_tasks))


@pytest.mark.asyncio
async def test_a_crashed_listener_restarts_with_backoff_up_to_the_hourly_cap(catalog, engines, clock, restarts):
    """A ttl-0 holder's engine restarts on its own after 5 s, 10 s, ... and stays stopped after 5 an hour."""
    ts = _server()
    listener = await _start(ts, _pipeline(), user='user-a', ttl=0)

    # Five crashes after running: five restarts, the backoff doubling
    for _ in range(5):
        crashed = listener.task
        await _crash(crashed)
        await _settle(ts)
        assert listener.task is not crashed and listener.engine_state == 'running'
        assert listener.task.engine_key == crashed.engine_key
    assert restarts.slept == [5.0, 10.0, 20.0, 40.0, 80.0]

    # The sixth in the same hour: dormant, listed stopped, logged
    await _crash(listener.task)
    await _settle(ts)
    assert listener.dormant and listener.engine_state == 'stopped'
    assert restarts.slept == [5.0, 10.0, 20.0, 40.0, 80.0]
    restarts.warned.assert_called_once()

    # An hour later the budget is back and the backoff starts over
    clock.advance(3601)
    assert ts._listener_restart_delay(listener.task.engine_key) == 5.0


@pytest.mark.asyncio
async def test_a_crashed_request_response_engine_waits_for_a_request(catalog, engines, restarts):
    """No ttl-0 holder: the crash leaves the holders dormant and nothing restarts on its own."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)

    await _crash(control.task)
    await _settle(ts)

    assert control.dormant and restarts.slept == []
    assert ts._engine_restarts == {}
