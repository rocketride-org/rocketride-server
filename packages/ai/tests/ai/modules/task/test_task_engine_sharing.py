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

"""Named-pipes runtime model: TaskControl / TaskEngine split (plan section 14, Step 3; C.22, C.25).

One engine per SHAPE: controls are the callers' views (owner, rung,
``project_id``, resolved config, billing, ttl, parameters), handled by a
control id and identified by their configuration; engines are processes
keyed by the shape of the spec (providers, wiring, source), qualified by the
owner on ``@spec`` and bare on the published rungs, where every caller's
control of one shape holds one engine (a self-driven source or a RocketRide
cloud database keeps its owner on every rung). Specs of one owner that share
a shape share an engine whatever their configuration; a spec differing in
configuration under the same ``project_id`` is another control on that
engine; another user's identical spec on ``@spec`` is another engine, on a
published rung the same one. Terminate releases a hold; the
engine stops with its last hold; publisher disable releases the
deployment's holds; an operator, or the owner the key names, may stop an
engine outright.
A control entitles its caller to an engine but does not keep it running: the
engine stops on its own inactivity timer (``CONST_ENGINE_IDLE_TTL``; a ttl-0
holder pins it) or at once with its last hold, and a request through a
control whose engine stopped starts it again under the same key. So does a
request through a control whose engine crashed after it had confirmed running;
an engine that never confirmed running is not retried.
"""

from __future__ import annotations

import itertools
import asyncio
import copy
import time
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock

import pytest
import rocketlib
from rocketride import EVENT_TYPE

from ai.account.audience import audience_fields
from ai.account.models import AccountInfo
from ai.common import node_config
from ai.constants import CONST_DEFAULT_MAX_THREADS, CONST_ENGINE_IDLE_TTL
from ai.modules.task import deploy_events, task_control, task_engine, task_server
from ai.modules.task.commands.cmd_data import DataCommands
from ai.modules.task.commands.cmd_task import TaskCommands
from ai.modules.task.task_control import RESOLVE_ATTACH, DeploymentRef, TaskControl
from ai.modules.task.engine_key import (
    engine_content,
    key_owner,
    pipeline_stack,
    properties_digest,
    qualified_key,
    stack_order,
)
from ai.modules.task.task_engine import TaskEngine, component_facts
from ai.modules.task.task_server import ControlRegistry, EngineRegistry, Resolution, TaskServer
from ai.modules.task.types import EngineState, TaskError
from ai.modules.task.trace_owner import TraceOwners


# =============================================================================
# A SMALL CATALOG
# =============================================================================

#: Resolved-config defaults per provider: what the resolver applies to a
#: stored config. ``local_tool`` is not a catalog node (its path is not under
#: ``nodes.``): it shares by shape like any other node (plan 4.4).
DEFAULTS: Dict[str, Dict[str, Any]] = {
    'webhook': {'type': 'webhook', 'mode': 'Source', 'hideForm': True},
    'prompt': {'instructions': ['Answer the question.'], 'maxTokens': 1024, 'stream': False, 'label': ''},
    'local_tool': {'depth': 1},
    'rocketride_sql': {'scope': 'org'},
}
PATHS = {'webhook': 'nodes.webhook', 'prompt': 'nodes.prompt', 'local_tool': 'local_nodes.local_tool'}
#: The catalog's ``classType`` words: the webhook is a DOOR source; a prompt
#: or a tool as the entry source drives itself (a listener's shape).
CLASSES = {
    'webhook': ['source', 'webhook'],
    'prompt': ['llm'],
    'local_tool': ['tool'],
    'rocketride_sql': ['database'],
}
#: The keys each provider flags ``param`` (what a pipeline may expose per call).
PARAMS = {'prompt': ('instructions',)}
#: The declared type of each leaf, as a leaf descriptor would say it.
TYPES = {bool: 'boolean', int: 'integer', float: 'number', str: 'string', list: 'array'}


class _View:
    """The slice of a resolved ConfigView the server reads: values, param keys, paths, descriptors, overlay."""

    def __init__(self, provider, config):
        self._defaults = DEFAULTS[provider]
        self._values = {**self._defaults, **(config or {})}
        self.param_keys = frozenset(PARAMS.get(provider, ()))
        self.param_paths = self.param_keys

    def to_dict(self):
        return dict(self._values)

    def get(self, key, default=None):
        return self._values.get(key, default)

    def __iter__(self):
        return iter(self._values)

    def __contains__(self, key):
        return key in self._values

    def path_of(self, key):
        return key

    def leaf_path(self, key):
        return key if key in self._values else None

    def descriptor_of(self, key):
        return {'type': TYPES.get(type(self._defaults.get(key)), 'string')}

    def overlay(self, params):
        for key, value in params.items():
            if key not in self.param_keys:
                raise rocketlib.ConfigError(f'"{key}" is not a parameter of this node')
            if not isinstance(value, (str, list)):
                raise rocketlib.ConfigError(f'"{key}" must be a string')
        return self


@pytest.fixture
def catalog(monkeypatch):
    """Resolve configs against DEFAULTS; the service definitions carry PATHS and CLASSES."""

    def resolve(provider, config):
        if provider not in DEFAULTS:
            raise ValueError(f'The service {provider} was not found')
        return _View(provider, config)

    def definition(provider):
        return {'path': PATHS.get(provider, ''), 'classType': list(CLASSES.get(provider, []))}

    monkeypatch.setattr(task_engine, 'resolve_node_config', resolve)
    monkeypatch.setattr(node_config, 'resolve_node_config', resolve)
    monkeypatch.setattr(rocketlib, 'getServiceDefinition', definition)
    return CLASSES


@pytest.fixture
def engines(monkeypatch):
    """Engines that 'start' (and confirm running) and 'stop' without a subprocess; returns the stop log."""
    stopped: List[tuple] = []

    async def start(self):
        # The subprocess reports its service up at once
        self.state = EngineState.STARTING
        self._confirm_running()

    async def stop(self, reason='user'):
        stopped.append((self, reason))
        self._stop_reason = reason
        self.state = EngineState.STOPPED
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
    ts.trace_owners = TraceOwners()
    ts._deployment_revoked = {}
    ts._engine_ids = itertools.count(1)
    ts._node_id = 1
    ts._launched = {}
    ts._engine_restarts = {}
    ts._restart_tasks = set()
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
    """
    Start (or attach) a control as ``user``, the way on_execute does.

    A deployment run is stamped with the rung its owner answers on (the
    trusted dispatch stamps it from the audience): a user-owned one on
    ``@me``, a team-owned one on its team's rung.
    """
    request = {'command': 'execute', 'arguments': {'pipeline': copy.deepcopy(pipeline), **arguments}}
    rung = '' if run_kind == 'dev' else {'user': 'me', 'team': 'team', 'org': 'org'}[owner_kind or 'team']
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
        rung=rung,
    )
    # The token slot carries the control id: the registry key
    return ts._task_control[result['token']]


def _copy(**kwargs):
    """The same shape under another project id: another control of the owner on the same engine."""
    return _pipeline(project_id='docBrainCopy', **kwargs)


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
        _pipeline(parameters={'tone': 'prompt_1.instructions'}),
        _pipeline(project_id='renamed', name='Another name'),
        reordered,
    ):
        assert engine_content(other, 'webhook_1', component_facts).content_hash == base


def test_one_config_value_apart_is_the_same_shape_and_another_configuration(catalog):
    """Configuration is out of the engine key (plan 7.2) and in the control's identity (plan section 1)."""
    a = engine_content(_pipeline(instructions=['Be brief.']), 'webhook_1', component_facts)
    b = engine_content(_pipeline(instructions=['Be thorough.']), 'webhook_1', component_facts)
    assert a.content_hash == b.content_hash
    assert a.config_by_index != b.config_by_index
    assert task_control.config_hash(a.config_by_index) != task_control.config_hash(b.config_by_index)
    # By stack index (the engine's walk, or the id order without it), the configs resolved
    prompt, webhook = a.index_map.to_index('prompt_1'), a.index_map.to_index('webhook_1')
    assert a.config_by_index[prompt]['instructions'] == ['Be brief.']
    assert a.config_by_index[webhook] == DEFAULTS['webhook']
    # The open carries the STORED form (the engine resolves it); the identity hashes the resolved one
    assert (a.stored_by_index[prompt], a.stored_by_index[webhook]) == ({'instructions': ['Be brief.']}, {})
    spelled = engine_content(_pipeline(instructions=['Answer the question.']), 'webhook_1', component_facts)
    assert task_control.config_hash(spelled.config_by_index) == task_control.config_hash(
        engine_content(_pipeline(), 'webhook_1', component_facts).config_by_index
    )


def test_the_source_and_the_wiring_are_content(catalog):
    """The entry source and the connections enter the key."""
    rewired = _pipeline()
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]
    base = engine_content(_pipeline(), 'webhook_1', component_facts).content_hash
    assert engine_content(rewired, 'webhook_1', component_facts).content_hash != base
    assert engine_content(_pipeline(), 'prompt_1', component_facts).content_hash != base


def test_placeholders_stay_unexpanded_in_the_resolved_config(catalog):
    """The configuration identity holds the placeholder, so it never depends on whose env fills it."""
    spec = _pipeline(instructions=['${ROCKETRIDE_TONE}'])
    first = task_control.config_hash(engine_content(spec, 'webhook_1', component_facts).config_by_index)
    again = task_control.config_hash(engine_content(copy.deepcopy(spec), 'webhook_1', component_facts).config_by_index)
    assert again == first
    other = engine_content(_pipeline(instructions=['friendly']), 'webhook_1', component_facts).config_by_index
    assert first != task_control.config_hash(other)


def test_a_door_source_shares_and_a_self_driven_source_keeps_its_owner(catalog):
    """The entry source's catalog classType decides (plan 4.4): a door shares by shape; anything else drives itself."""
    door = engine_content(_pipeline(), 'webhook_1', component_facts)
    assert door.source_classes == ('source', 'webhook') and not door.self_driven
    assert door.key(rung='public', owner_id='user-a') == door.key_hash

    # A custom (non-catalog) node shares like a catalog one: nothing certifies
    extra = {'id': 'tool_1', 'provider': 'local_tool', 'config': {}}
    assert not engine_content(_pipeline(extra=extra), 'webhook_1', component_facts).self_driven

    # An entry source that is no door (a listener's shape) keeps its owner on every rung
    listener = engine_content(_pipeline(), 'prompt_1', component_facts)
    assert listener.self_driven
    for rung in ('spec', 'me', 'team', 'public'):
        assert listener.key(rung=rung, owner_id='user-a') == f'{listener.key_hash}:user-a'

    # A component the resolver cannot resolve is an ERROR, never a private key
    # over its raw config (audit 2026-11-12): the start refuses the spec
    unknown = {'id': 'x_1', 'provider': 'no_such_node', 'config': {}}
    with pytest.raises(Exception):
        engine_content(_pipeline(extra=unknown), 'webhook_1', component_facts)


def test_the_real_resolver_applies_schema_defaults():
    """Against the engine's own schema, an empty config and its defaults spelled out are one engine."""
    from ai.common.node_config import resolve_node_config

    defaults = resolve_node_config('webhook', {}).to_dict()
    empty = {'source': 'w', 'components': [{'id': 'w', 'provider': 'webhook', 'config': {}}]}
    spelled = {'source': 'w', 'components': [{'id': 'w', 'provider': 'webhook', 'config': dict(defaults)}]}
    assert (
        engine_content(empty, 'w', component_facts).config_by_index
        == engine_content(spelled, 'w', component_facts).config_by_index
    )


def test_engine_key_is_owner_qualified_on_spec_only():
    """Plan 4.4: (shape, owner) on @spec, the bare shape on the published rungs; a private shape keeps its owner."""
    assert qualified_key('abc', rung='spec', owner_id='user-a') == 'abc:user-a'
    for rung in ('me', 'team', 'public'):
        assert qualified_key('abc', rung=rung, owner_id='user-a') == 'abc'
        assert qualified_key('abc', rung=rung, owner_id='user-a', private=True) == 'abc:user-a'
    assert qualified_key('abc', rung='spec', owner_id='') == 'abc'


def test_off_policy_engine_properties_key_their_own_spec_engine():
    """A @spec call's threads/args departing from policy key an engine of their own; a published rung ignores them."""
    digest = properties_digest(4, ['--x'])
    assert digest == properties_digest(4, ['--x']) and digest != properties_digest(4, ['--y'])
    assert qualified_key('abc', rung='spec', owner_id='user-a', properties=digest) == f'abc+{digest}:user-a'
    assert qualified_key('abc', rung='public', owner_id='user-a', properties=digest) == 'abc'
    assert qualified_key('abc', rung='me', owner_id='user-a', private=True, properties=digest) == 'abc:user-a'


def test_key_owner_reads_the_owner_a_key_names():
    """A bare key names nobody; a qualified one its owner, whatever precedes it."""
    assert key_owner('abc') == ''
    assert key_owner('abc:user-a') == 'user-a'
    assert key_owner('abc+0123456789ab:team-1') == 'team-1'
    assert key_owner('') == ''


# =============================================================================
# CONTROLS AND HOLDS
# =============================================================================


@pytest.mark.asyncio
async def test_two_users_identical_specs_on_spec_are_two_engines(catalog, engines):
    """@spec engines are owner-qualified (plan 4.4): a second user's identical spec is a second engine."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', team='team-a', org='org-a')
    b = await _start(ts, _pipeline(), user='user-b', team='team-b', org='org-b')

    content = engine_content(_pipeline(), 'webhook_1', component_facts).key_hash
    assert a is not b and a.task is not b.task
    assert (a.task.engine_key, b.task.engine_key) == (f'{content}:user-a', f'{content}:user-b')
    assert a.task.holds == {a.key} and b.task.holds == {b.key}
    assert a.billing != b.billing
    assert (a.billing.org_id, a.billing.user_id) == ('org-a', 'user-a')
    assert (b.billing.org_id, b.billing.user_id) == ('org-b', 'user-b')


@pytest.mark.asyncio
async def test_a_different_configuration_is_another_control_on_the_same_engine(catalog, engines):
    """Plan 3.4: one owner, one project_id, two configs: two controls, two ids, ONE engine."""
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')
    b = await _start(ts, _pipeline(instructions=['Be thorough.']), user='user-a')

    assert a is not b and a.control_id != b.control_id
    assert a.task is b.task and len(ts._engines) == 1
    assert a.task.holds == {a.key, b.key}
    assert a.config_hash != b.config_hash
    assert a.index_key == b.index_key and {id(c) for c in ts._task_control.lookup(a.index_key)} == {id(a), id(b)}
    assert a.task.engine_key == f'{engine_content(_pipeline(), "webhook_1", component_facts).key_hash}:user-a'


@pytest.mark.asyncio
async def test_the_same_configuration_reuses_the_control(catalog, engines):
    """The identity is (owner, rung, project_id, hash(resolved config)): a repeated spec call answers with the same id."""
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')
    again = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')

    assert again is a and len(ts._task_control) == 1


@pytest.mark.asyncio
async def test_use_existing_attaches_to_the_live_control_of_the_project_whatever_its_config(catalog, engines):
    """useExisting: the caller's live @spec control of that project_id answers, its running spec kept, stamped reused."""
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')

    request = {'command': 'execute', 'arguments': {'pipeline': _pipeline(instructions=['Other.']), 'useExisting': True}}
    result = await ts.start_task(
        request,
        MagicMock(),
        client_id='user-a',
        user_id='user-a',
        team_id='team-1',
        org_id='org-1',
        developer_id='acme',
    )

    assert (result['token'], result['reused'], result['converged']) == (a.control_id, True, 'none')
    assert len(ts._task_control) == 1 and a.pipeline['components'][1]['config']['instructions'] == ['Be brief.']
    # Without useExisting the differing configuration is another control
    b = await _start(ts, _pipeline(instructions=['Other.']), user='user-a')
    assert b is not a and len(ts._task_control) == 2


@pytest.mark.asyncio
async def test_specs_differing_only_in_parameters_share_one_engine(catalog, engines):
    """The parameters map is per control: one engine, each control keeps its own map."""
    ts = _server()
    a = await _start(ts, _pipeline(parameters={'tone': 'prompt_1.instructions'}), user='user-a')
    b = await _start(ts, _copy(parameters={}), user='user-a')

    assert a.task is b.task
    assert a.parameters == {'tone': 'prompt_1.instructions'}
    assert b.parameters == {}


@pytest.mark.asyncio
async def test_every_spec_engine_is_the_owners(catalog, engines):
    """On @spec the key is (shape, owner): the owner's runs share; another user's do not."""
    ts = _server()

    mine = await _start(ts, _pipeline(), user='user-a')
    # The owner's second call answers with the same control ...
    again = await _start(ts, _pipeline(), user='user-a')
    # ... and the owner's identically-built copy under another name shares the engine
    copy_of_mine = await _start(ts, _copy(), user='user-a')
    theirs = await _start(ts, _pipeline(), user='user-b')

    content = engine_content(_pipeline(), 'webhook_1', component_facts).key_hash
    assert again is mine
    assert copy_of_mine is not mine and copy_of_mine.task is mine.task
    assert mine.task.engine_key == f'{content}:user-a'
    assert theirs.task is not mine.task
    assert theirs.task.engine_key == f'{content}:user-b'


@pytest.mark.asyncio
async def test_threads_off_policy_on_a_spec_call_key_an_engine_of_their_own(catalog, engines):
    """A @spec call may set threads/args; off policy they key the owner's own engine, which keeps the starter's values."""
    ts = _server()
    custom = await _start(ts, _pipeline(), user='user-a', threads=4)
    stock = await _start(ts, _copy(), user='user-a')
    argued = await _start(ts, _pipeline(project_id='docBrainArgs'), user='user-a', args=['--x'])

    content = engine_content(_pipeline(), 'webhook_1', component_facts).key_hash
    assert custom.task.engine_key == f'{content}+{properties_digest(4, [])}:user-a'
    assert custom.task._threads == 4
    assert stock.task is not custom.task and stock.task.engine_key == f'{content}:user-a'
    assert stock.task._threads == CONST_DEFAULT_MAX_THREADS
    assert argued.task.engine_key == f'{content}+{properties_digest(CONST_DEFAULT_MAX_THREADS, ["--x"])}:user-a'
    assert len({custom.task, stock.task, argued.task}) == 3


# =============================================================================
# SHARED ENGINES ON THE PUBLISHED RUNGS (C.25)
# =============================================================================


async def _publish(ts, pipeline, *, user, rung='public', team='team-1', org='org-1', **arguments):
    """Start (or attach) ``user``'s own control on a published rung, the way the trusted dispatch does."""
    request = {'command': 'execute', 'arguments': {'pipeline': copy.deepcopy(pipeline), **arguments}}
    result = await ts.start_task(
        request,
        MagicMock(),
        client_id=user,
        user_id=user,
        team_id=team,
        org_id=org,
        run_kind='deploy',
        owner_kind='user',
        rung=rung,
        developer_id='acme',
        deployment=DeploymentRef(org_id=org, team_id=f'=user/{user}', project_id=pipeline['project_id']),
        caller_id=user,
    )
    return ts._task_control[result['token']]


@pytest.mark.asyncio
async def test_two_users_configs_of_one_published_shape_share_one_engine(catalog, engines):
    """C.25 exit: two users' different configurations of one published shape are ONE engine and two controls."""
    ts = _server()
    a = await _publish(ts, _pipeline(instructions=['Be brief.']), user='user-a', org='org-a')
    b = await _publish(ts, _pipeline(instructions=['Be thorough.']), user='user-b', org='org-b')

    content = engine_content(_pipeline(), 'webhook_1', component_facts).key_hash
    assert a is not b and a.task is b.task and len(ts._engines) == 1
    assert a.task.engine_key == content and a.task.shared
    assert a.task.holds == {a.key, b.key}
    # Each control carries its own configuration to the engine on its open
    assert {'instructions': ['Be brief.']} in a.caller_config()
    assert {'instructions': ['Be thorough.']} in b.caller_config()
    assert all(component['config'] == {} for component in a.task._pipeline['components'])
    # Attribution rides each control: two controls on one engine bill two accounts
    assert (a.billing.org_id, a.billing.user_id) == ('org-a', 'user-a')
    assert (b.billing.org_id, b.billing.user_id) == ('org-b', 'user-b')

    # @me shares the same way, on its own engine beside the owner's @spec one
    mine = await _publish(ts, _pipeline(), user='user-a', rung='me')
    dev = await _start(ts, _pipeline(), user='user-a')
    assert mine.task is a.task
    assert dev.task is not a.task and dev.task.engine_key == f'{content}:user-a'


@pytest.mark.asyncio
async def test_a_self_driven_source_keeps_its_owner_on_every_rung(catalog, engines):
    """A listener's shape (no door classType on its source) runs one listener per owner: owner-qualified everywhere."""
    ts = _server()
    a = await _publish(ts, _pipeline(), user='user-a', source='prompt_1')
    b = await _publish(ts, _pipeline(), user='user-b', source='prompt_1')

    content = engine_content(_pipeline(), 'prompt_1', component_facts).key_hash
    assert a.task is not b.task
    assert (a.task.engine_key, b.task.engine_key) == (f'{content}:user-a', f'{content}:user-b')
    assert not a.task.shared and a.task.client_id == 'user-a'


def _db_pipeline(scope='org', target='', project_id='docDb'):
    """A webhook -> RocketRide cloud SQL pipeline."""
    pipeline = _pipeline(project_id=project_id)
    config = {'scope': scope, **({'target': target} if target else {})}
    pipeline['components'].append(
        {
            'id': 'sql_1',
            'provider': 'rocketride_sql',
            'config': config,
            'input': [{'lane': 'text', 'from': 'webhook_1'}],
        }
    )
    return pipeline


@pytest.fixture
def db_account(monkeypatch):
    """An account that approves every database and records the run identity each decision was asked for."""
    import ai.account

    asked: List[tuple] = []

    async def authorize(identity, request):
        asked.append((identity['user_id'], identity['org_id'], dict(request)))
        owner = request.get('team_id') or request.get('user_id') or identity['org_id']
        return SimpleNamespace(allowed=True, reason='', owner_id=owner)

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize, raising=False)
    return asked


@pytest.mark.asyncio
async def test_a_cloud_database_shape_keeps_its_owner_and_every_control_is_authorized(catalog, engines, db_account):
    """The DSNs ride the engine process once, so a DB shape is owner-qualified; each control is authorized as itself."""
    ts = _server()
    a = await _publish(ts, _db_pipeline(), user='user-a', org='org-a')
    b = await _publish(ts, _db_pipeline(), user='user-b', org='org-b')

    content = engine_content(_db_pipeline(), 'webhook_1', component_facts).key_hash
    assert a.task is not b.task
    assert (a.task.engine_key, b.task.engine_key) == (f'{content}:user-a', f'{content}:user-b')
    assert [(user, org) for user, org, _ in db_account] == [('user-a', 'org-a'), ('user-b', 'org-b')]
    assert a.db_approved == {'org': 'org-a'}


@pytest.mark.asyncio
async def test_a_control_attaching_needs_the_databases_its_engine_was_handed(catalog, engines, db_account):
    """A running engine's process holds the DSNs of its start: a later control asking for another is refused."""
    ts = _server()
    first = await _start(ts, _db_pipeline(), user='user-a')
    # What the engine's own start approved (the fake start does not run it)
    first.task.db_approved = dict(first.db_approved)

    # The same database: the control attaches
    same = await _start(ts, _db_pipeline(project_id='docDbCopy'), user='user-a')
    assert same.task is first.task

    # Another database on the same shape: refused, nothing registered
    with pytest.raises(TaskError) as refused:
        await _start(ts, _db_pipeline(scope='team', project_id='docDbTeam'), user='user-a')
    assert refused.value.code == TaskError.ENGINE_UNAVAILABLE and 'team' in str(refused.value)
    assert first.task.holds == {first.key, same.key}
    assert len(ts._task_control) == 2


@pytest.mark.asyncio
async def test_a_control_wanting_fewer_databases_or_another_org_is_refused(catalog, engines, db_account):
    """The engine's process holds exactly its handed databases, in its org: both maps must match, and the org."""
    ts = _server()
    first = await _start(ts, _db_pipeline(), user='user-a', org='org-a')
    first.task.db_approved = {**first.db_approved, 'team': 'team-1'}
    first.task.org_id = 'org-a'

    # A control that wants only some of what the process holds is refused
    with pytest.raises(TaskError) as fewer:
        await _start(ts, _db_pipeline(project_id='docDbFewer'), user='user-a', org='org-a')
    assert fewer.value.code == TaskError.ENGINE_UNAVAILABLE and 'team' in str(fewer.value)

    # The same user in another org resolves the same scope to another database
    first.task.db_approved = dict(first.db_approved)
    with pytest.raises(TaskError) as other_org:
        await _start(ts, _db_pipeline(project_id='docDbOrgB'), user='user-a', org='org-b')
    assert other_org.value.code == TaskError.ENGINE_UNAVAILABLE


@pytest.mark.asyncio
async def test_the_same_databases_from_another_org_are_refused(catalog, engines, db_account):
    """A user scope approves the same owner in every org, but resolves to each org's database: the org alone refuses."""
    ts = _server()
    first = await _start(ts, _db_pipeline(scope='user'), user='user-a', org='org-a')
    first.task.db_approved = dict(first.db_approved)
    first.task.org_id = 'org-a'
    assert first.db_approved == {'user': 'user-a'}

    with pytest.raises(TaskError) as other_org:
        await _start(ts, _db_pipeline(scope='user', project_id='docDbOrgB'), user='user-a', org='org-b')
    assert other_org.value.code == TaskError.ENGINE_UNAVAILABLE
    # The user scope's request names the user in both orgs: the maps are equal
    assert [request.get('user_id') for _, _, request in db_account] == ['user-a', 'user-a']


@pytest.mark.asyncio
async def test_a_control_removed_during_its_restart_takes_no_hold(catalog, engines, db_account, clock, monkeypatch):
    """remove_task during the account question: the restart aborts and the removed control holds nothing."""
    ts = _server()
    control = await _start(ts, _db_pipeline(), user='user-a', ttl=3600)
    await _idle_out(ts, clock)
    assert control.dormant
    original = ts._authorize_control_db

    async def authorize_then_remove(target):
        approved = await original(target)
        ts._task_control.pop(target.key, None)
        return approved

    monkeypatch.setattr(ts, '_authorize_control_db', authorize_then_remove)
    with pytest.raises(TaskError) as removed:
        await ts.ensure_engine(control)
    assert removed.value.code == TaskError.ENGINE_UNAVAILABLE
    assert all(control.key not in engine.holds for engine in ts._engines.values())


@pytest.mark.asyncio
async def test_a_dormant_control_is_reauthorized_before_it_rejoins(catalog, engines, db_account, clock, monkeypatch):
    """Membership revoked after a control started refuses its rejoin; it stays on its stopped engine."""
    import ai.account

    ts = _server()
    control = await _start(ts, _db_pipeline(), user='user-a', ttl=3600)
    stopped = control.task
    await _idle_out(ts, clock)
    assert control.dormant

    async def deny(identity, request):
        return SimpleNamespace(allowed=False, reason='no longer a member', owner_id='')

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', deny, raising=False)
    with pytest.raises(PermissionError, match='no longer a member'):
        await ts.ensure_engine(control)
    assert control.task is stopped and control.dormant


@pytest.mark.asyncio
async def test_a_shared_engine_carries_no_user_identity_and_no_user_env(catalog, engines, monkeypatch, tmp_path):
    """Plan 7.2: a shared engine starts as nobody, from the shape alone; env rides each control's open."""
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    ts = _server()
    env_source = AsyncMock(return_value={'ROCKETRIDE_TONE': 'secret-of-a'})
    import ai.account

    monkeypatch.setattr(ai.account.account, 'get_merged_env', env_source)
    spec = _pipeline(instructions=['Be brief.'], parameters={'tone': 'prompt_1.instructions'})
    control = await _publish(ts, spec, user='user-a', pipelineTraceLevel='full')
    engine = control.task

    assert engine.shared and engine._env_source is not env_source and await engine._env_source() == {}
    assert (engine.client_id, engine.team_id, engine.org_id, engine.address, engine.project_id) == ('', '', '', '', '')
    assert 'user-a' not in engine.id and control.address not in engine.id
    assert engine._pipelineTraceLevel == 'none' and engine._launch_args == {}
    assert await engine._default_env(spec) == {}

    task = engine._build_task(engine._pipeline, env={'ROCKETRIDE_TONE': 'secret-of-a'})
    written = task['config']['pipeline']
    assert task['config']['env'] == {}
    assert 'identity' not in task and 'storage' not in task
    assert written['project_id'] == '' and written['name'] is None and written['parameters'] == {}
    assert all(component['config'] == {} for component in written['components'])
    assert 'secret-of-a' not in str(task) and 'docBrain' not in str(task) and 'Be brief.' not in str(task)

    # Its own usage names nobody and writes no remainder debit (plan 15 item 21)
    identity = engine._metrics_identity()
    assert (identity['client_id'], identity['team_id'], identity['org_id']) == ('', '', '')
    assert identity['debit_remainder'] is False

    # The control still carries its own environment to the engine on its open
    env_source.assert_not_awaited()
    assert control.task is engine and control.address == 'acme.docBrain.webhook_1'


@pytest.mark.asyncio
async def test_a_shared_engines_credit_check_asks_the_callers_org_and_refuses_no_caller(catalog, engines, monkeypatch):
    """The paying unit is the binding's caller; a binding with no caller on a shared engine has nobody to pay."""
    import ai.account

    check = AsyncMock(return_value=None)
    monkeypatch.setattr(ai.account.account, 'check_spend', check, raising=False)
    ts = _server()
    engine = (await _publish(ts, _pipeline(), user='user-a', org='org-a')).task

    answered = await task_engine._check_spend(engine, {'caller': {'orgId': 'org-b', 'userId': 'user-b'}}, None)
    assert answered.body == {'refusal': None}
    check.assert_awaited_once_with('org-b')

    refused = await task_engine._check_spend(engine, {}, None)
    assert refused.body == {'refusal': task_engine.CONST_NO_PAYING_UNIT}
    assert check.await_count == 1


@pytest.mark.asyncio
async def test_a_shared_engines_lifecycle_events_name_each_holder_never_another(catalog, engines):
    """A shared engine's task events reach every holder, each copy naming that holder's own address and project."""
    ts = _server()
    a = await _publish(ts, _pipeline(name='Alpha'), user='user-a')
    b = await _publish(ts, _pipeline(project_id='docBeta', name='Beta'), user='user-b')
    engine = a.task
    assert engine is b.task
    ts.broadcast_task_event = AsyncMock()
    engine._run_log_failed = set(engine.holds)

    event = engine.build_event('apaevt_task', body={'action': 'begin', 'name': 'x', 'projectId': ''}, id=engine.id)
    await engine._forward_task_event(EVENT_TYPE.TASK, event)

    sent = {c.kwargs['key']: c.kwargs['event'] for c in ts.broadcast_task_event.await_args_list}
    assert set(sent) == {a.key, b.key}
    assert (sent[a.key]['body']['__id'], sent[a.key]['body']['projectId'], sent[a.key]['body']['name']) == (
        a.id,
        'docBrain',
        'Alpha',
    )
    assert (sent[b.key]['body']['__id'], sent[b.key]['body']['projectId'], sent[b.key]['body']['name']) == (
        b.id,
        'docBeta',
        'Beta',
    )


@pytest.mark.asyncio
async def test_task_list_rows_of_a_shared_engine_show_each_control_its_own_status(catalog, engines):
    """The dashboard and task-list rows read the control's projection, never the shared engine's totals."""
    from ai.modules.task.commands.cmd_misc import MiscCommands

    ts = _server()
    a = await _publish(ts, _pipeline(name='Alpha'), user='user-a')
    b = await _publish(ts, _pipeline(project_id='docBeta', name='Beta'), user='user-b')
    engine = a.task
    engine._status.completedCount = 99
    engine._status.rateCount = 7
    engine._status.status = 'Processing the-other-callers-file.pdf'
    a.stats = task_control.ControlStats(totalCount=3, completedCount=2, failedCount=1)

    rows = {row['id']: row for row in MiscCommands._build_task_rows(MagicMock(), [a, b], time.time())}

    assert (rows[a.id]['completedCount'], rows[a.id]['totalCount'], rows[a.id]['name']) == (2, 3, 'Alpha')
    assert (rows[b.id]['completedCount'], rows[b.id]['name']) == (0, 'Beta')
    assert all(row['rateCount'] == 0 and not row['status'] for row in rows.values())
    assert all(row['engineState'] == 'running' for row in rows.values())


@pytest.mark.asyncio
async def test_concurrent_starters_of_one_key_start_one_engine(catalog, monkeypatch):
    """Concurrent starters serialize on the key's start lock; the losers attach to the winner."""
    created = []

    async def slow_start(self):
        created.append(self)
        await asyncio.sleep(0.01)

    monkeypatch.setattr(TaskEngine, 'start_task', slow_start)
    ts = _server()

    controls = await asyncio.gather(*(_start(ts, _pipeline(project_id=f'pipe{n}'), user='user-a') for n in range(5)))

    assert len(created) == 1
    assert {id(c.task) for c in controls} == {id(created[0])}
    assert len(created[0].holds) == 5
    assert ts._engines.starting == frozenset()


@pytest.mark.asyncio
async def test_stop_on_dev_releases_only_that_hold(catalog, engines):
    """Terminate is a release: the engine keeps serving the other holder."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a')
    b = await _start(ts, _copy(), user='user-a')

    await ts.stop_task(a.key)

    assert a.key not in ts._task_control
    assert ts._task_control[b.key] is b
    assert b.task.holds == {b.key}
    assert engines == []
    assert ts._engines[b.task.engine_key] is b.task


@pytest.mark.asyncio
async def test_stop_on_the_last_hold_stops_the_engine(catalog, engines):
    """The last hold's Stop takes the engine with it, and a @spec control is gone."""
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
    short_lived = await _start(ts, _copy(), user='user-a', ttl=60)
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
    b = await _start(ts, _copy(), user='user-a', ttl=24 * 3600)
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
    other = await _start(ts, _copy(), user='user-a', ttl=24 * 3600)
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
    busy = await _start(ts, _copy(), user='user-a', ttl=60)
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
    busy = await _start(ts, _copy(), user='user-a', ttl=60)
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
    brief = await _start(ts, _copy(), user='user-a', ttl=60)

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
    other = await _start(ts, _copy(), user='user-a', ttl=60)
    engine = caller.task
    engine.wait_for_running = AsyncMock()
    engine._send_data = AsyncMock(return_value={'body': {'ok': True}})
    conn = _data_conn(ts, caller)

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


async def _attach(ts, target, account, require=None):
    """The control ``resolve_target`` attaches to for ``target``: registered controls only, nothing starts."""
    return (await ts.resolve_target(account, target, require, mode=RESOLVE_ATTACH)).control


async def _resolve(ts, target, account, require=None):
    """The control ``resolve_target`` answers ``target`` with, a publication started when needed."""
    return (await ts.resolve_target(account, target, require)).control


def _data_conn(ts, control):
    """A DataCommands whose resolution always lands on ``control`` (no transport, no auth).

    The test's own server answers every address with ``control``:
    ``ts.resolve_target`` is replaced for the test (each test builds its own
    server), so a frame by address is counted on it.
    """
    conn = DataCommands.__new__(DataCommands)
    conn._server = ts
    conn._connection_id = 1
    conn._account_info = _caller()
    conn.get_control = MagicMock(return_value=control)
    ts.resolve_target = AsyncMock(return_value=Resolution(None, control, None, False))
    conn.build_response = lambda request, body: {'body': body}
    conn.debug_message = MagicMock()
    conn.verify_team_permission = lambda team_id, perm: None
    return conn


@pytest.fixture
def serving(monkeypatch):
    """Engines that answer data requests at once."""
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock())
    monkeypatch.setattr(TaskEngine, '_send_data', AsyncMock(return_value={'body': {'ok': True}}))


@pytest.mark.asyncio
async def test_a_request_on_a_dormant_control_restarts_the_engine_under_the_same_key(catalog, engines, clock, serving):
    """No error, no re-resolve: the request starts a new engine of the same key and the control follows it."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='=team/team-1', project_id='docBrain')
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
async def test_a_shared_engine_restarted_by_any_holder_is_still_nobodys(catalog, engines, clock):
    """A dormant holder of a shared engine starts it again under the bare key, with no identity of its own lent."""
    ts = _server()
    a = await _publish(ts, _pipeline(), user='user-a', ttl=3600)
    b = await _publish(ts, _pipeline(), user='user-b', ttl=3600)
    stopped = a.task
    await _idle_out(ts, clock)
    assert a.dormant and b.dormant

    engine = await ts.ensure_engine(b)

    assert engine is not stopped and engine.engine_key == stopped.engine_key and engine.shared
    assert (engine.client_id, engine.org_id, engine.address) == ('', '', '')
    # The other holder attaches to the one new engine on its next request
    assert await ts.ensure_engine(a) is engine and engine.holds == {a.key, b.key}


@pytest.mark.asyncio
async def test_concurrent_requests_after_a_stop_start_one_engine(catalog, engines, clock, monkeypatch):
    """Concurrent restarters, through one control or several, attach to the one new engine."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    b = await _start(ts, _copy(), user='user-a', ttl=3600)
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

    assert await _attach(ts, control.address, _account('user-a'), 'task.data') is control


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
    """Stop means gone: a dormant @spec control is removed, its stopped engine is not stopped twice."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    engine = control.task
    await _idle_out(ts, clock)

    await ts.stop_task(control.key)

    assert ts._task_control == {}
    assert engines == [(engine, 'ttl')]


@pytest.mark.asyncio
async def test_a_spec_call_on_a_dormant_control_reuses_it_and_starts_its_engine(catalog, engines, clock):
    """Play on a dormant control of the same identity answers with that control and starts its engine."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    stopped = control.task
    await _idle_out(ts, clock)

    again = await _start(ts, _pipeline(), user='user-a')

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
    """The (address, engineState) pairs of an rrext_get_tasks response (the token slot is the control id)."""
    return [(task['address'], task['engineState']) for task in response['body']['tasks']]


@pytest.mark.asyncio
async def test_a_crash_after_running_leaves_the_controls_dormant_and_restarts(catalog, engines, serving):
    """A crash after the running confirmation is a timer stop: holders stay, the next request restarts the key."""
    ts = _server()
    a = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    b = await _start(ts, _copy(), user='user-a', ttl=3600)
    crashed = a.task
    assert crashed.state is EngineState.RUNNING

    await _crash(crashed)

    # Both holders stay, dormant; the crashed engine left the pool
    assert crashed.dormant_reason == 'crash'
    assert a.dormant and b.dormant
    assert a.engine_state == 'stopped' and b.engine_state == 'stopped'
    assert ts._task_control[a.key] is a and ts._task_control[b.key] is b
    assert ts._engines == {}
    assert await _attach(ts, a.address, _account('user-a'), 'task.data') is a

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
    assert failed.dormant_reason is None and failed.state is EngineState.FAILED
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
        await _attach(ts, control.address, _account('user-a'), 'task.data')
    assert told.value.code == TaskError.ENGINE_UNAVAILABLE


@pytest.mark.asyncio
async def test_terminate_after_a_crash_still_means_gone(catalog, engines):
    """Stop means gone: terminate on a crash-dormant @spec control removes it without a second stop."""
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
    other = await _start(ts, _copy(), user='user-a', ttl=3600)
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
    ts = _server()
    deployed = await _publish(ts, _pipeline(), user='user-a', rung='me')
    other = await _publish(ts, _pipeline(), user='user-b', rung='me')
    assert other.task is deployed.task and deployed.rung == 'me'

    # Enabling releases nothing
    await deploy_events.release_deployment_holds(ts, 'org-1', '=user/user-a', 'docBrain', 'enabled')
    assert deployed.key in ts._task_control

    await deploy_events.release_deployment_holds(ts, 'org-1', '=user/user-a', 'docBrain', 'disabled')
    assert deployed.key not in ts._task_control
    assert ts._task_control[other.key] is other
    assert other.task.holds == {other.key}
    assert engines == []


@pytest.mark.asyncio
async def test_publisher_remove_stops_an_engine_only_the_deployment_held(catalog, engines):
    """With no other holder the kill switch stops the engine: no back door."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='=team/team-1', project_id='docBrain')
    run = await _start(ts, _pipeline(), user='', run_kind='deploy', owner_kind='team', deployment=deployment)
    engine = run.task

    await deploy_events.release_deployment_holds(ts, 'org-1', '=team/team-1', 'docBrain', 'removed')

    assert ts._task_control == {}
    assert engines == [(engine, 'unpublished')]
    assert ts._engines == {}


@pytest.mark.asyncio
async def test_a_deployment_revoked_while_its_run_started_is_never_registered(catalog, engines):
    """The dispatch read the deployment enabled, then it was disabled while the artifact loaded: refused."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='=team/team-1', project_id='docBrain')
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
            rung='team',
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
    deployment = DeploymentRef(org_id='org-1', team_id='=user/user-a', project_id='docBrain')
    first = await _start(ts, _pipeline(), run_kind='deploy', owner_kind='user', deployment=deployment)
    second = await _start(
        ts, _pipeline(), run_kind='deploy', owner_kind='user', deployment=deployment, token='docBrain2'
    )
    assert await _attach(ts, first.address, _account('user-a'), 'task.data') is first
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
        await _attach(ts, first.address, _account('user-a'), 'task.data')
    assert (err.value.code, err.value.reason) == (TaskError.ENGINE_UNAVAILABLE, 'unpublished')
    assert first.key not in ts._task_control


@pytest.mark.asyncio
async def test_a_spec_that_cannot_be_keyed_is_refused_at_start(catalog, engines):
    """An unknown node is engine_start_failed, never a private key over the raw config."""
    ts = _server()
    unknown = {'id': 'x_1', 'provider': 'no_such_node', 'config': {}}

    with pytest.raises(TaskError) as err:
        await _start(ts, _pipeline(extra=unknown))
    assert err.value.code == TaskError.ENGINE_START_FAILED
    assert ts._task_control == {} and ts._engines == {}


@pytest.mark.asyncio
async def test_a_restart_is_a_successor_with_a_new_id_on_the_same_engine_when_the_shape_holds(catalog, engines):
    """Plan 7.3: Play on an existing run terminates the control and creates its successor; the engine stays when the shape did."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    deployed = await _start(ts, _copy(), user='user-a')
    assert dev.task is deployed.task
    engine = dev.task

    conn = MagicMock()
    conn._account_info = _account('user-a')
    result = await ts.restart_task(
        {'arguments': {'token': dev.control_id, 'pipeline': _pipeline(instructions='second draft')}}, conn=conn
    )

    successor = ts._task_control[result['token']]
    assert successor is not dev and successor.control_id != dev.control_id
    assert result['converged'] == 'none' and result['address'] == dev.address
    assert dev.key not in ts._task_control
    assert successor.task is engine and deployed.task is engine
    assert engine.holds == {successor.key, deployed.key}
    assert engines == [], 'the engine the successor holds was never stopped'
    assert successor.pipeline['components'][1]['config']['instructions'] == 'second draft'
    assert successor.config_hash != dev.config_hash


@pytest.mark.asyncio
async def test_a_restart_whose_shape_changed_moves_to_another_engine_and_stops_the_old_one_when_last(catalog, engines):
    """A spec of another shape is another engine; the predecessor's hold goes through the hold rule."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    old_engine = dev.task
    rewired = _pipeline()
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]

    conn = MagicMock()
    conn._account_info = _account('user-a')
    result = await ts.restart_task({'arguments': {'token': dev.control_id, 'pipeline': rewired}}, conn=conn)

    successor = ts._task_control[result['token']]
    assert result['converged'] == 'started'
    assert successor.task is not old_engine and successor.task.holds == {successor.key}
    assert engines == [(old_engine, 'restart')]
    assert list(ts._engines) == [successor.task.engine_key]


@pytest.mark.asyncio
async def test_a_restart_whose_engine_never_confirms_running_leaves_the_predecessor_in_place(
    catalog, engines, monkeypatch
):
    """A failed create puts the predecessor back as it was: its hold, its pipeline, its registration."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    old_engine = dev.task
    old_pipeline = dev.pipeline
    rewired = _pipeline()
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]
    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock(side_effect=TimeoutError('silent')))

    conn = MagicMock()
    conn._account_info = _account('user-a')
    with pytest.raises(TaskError) as err:
        await ts.restart_task(
            {'arguments': {'token': dev.control_id, 'pipeline': rewired}}, conn=conn, wait_for_running=True
        )

    assert err.value.code == TaskError.ENGINE_START_FAILED
    assert ts._task_control[dev.key] is dev and dev.task is old_engine
    assert old_engine.holds == {dev.key} and dev.pipeline == old_pipeline
    assert [reason for engine, reason in engines if engine is not old_engine] == ['user']
    assert all(engine is not old_engine for engine, _ in engines), 'the old engine was never stopped'
    assert list(ts._engines) == [old_engine.engine_key]


@pytest.mark.asyncio
async def test_a_restart_keeps_the_other_holder_and_the_subscriptions(catalog, engines):
    """The other holder keeps its engine unchanged; the monitors keyed by the project stay for the successor."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    deployed = await _start(ts, _copy(), user='user-a')
    old_engine = dev.task
    rewired = _pipeline()
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]
    watcher = MagicMock()
    watcher._monitors = {'p.dev.user-a.docBrain.webhook_1': 4}
    ts._connections = {1: watcher}

    conn = MagicMock()
    conn._account_info = _account('user-a')
    result = await ts.restart_task({'arguments': {'token': dev.control_id, 'pipeline': rewired}}, conn=conn)

    successor = ts._task_control[result['token']]
    assert successor.task is not old_engine and deployed.task is old_engine
    assert old_engine.holds == {deployed.key}
    assert engines == [], 'nothing was stopped for the other holder'
    assert watcher._monitors == {'p.dev.user-a.docBrain.webhook_1': 4}


@pytest.mark.asyncio
async def test_a_restart_refuses_a_foreign_control_id(catalog, engines):
    """Every verb that names a control id re-checks the caller (plan section 1)."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    conn = MagicMock()
    conn._account_info = _account('user-b')

    with pytest.raises(PermissionError):
        await ts.restart_task({'arguments': {'token': dev.control_id, 'pipeline': _pipeline()}}, conn=conn)
    assert ts._task_control[dev.key] is dev and engines == []


@pytest.mark.asyncio
async def test_a_restart_carries_the_predecessors_deployment_epoch(catalog, engines):
    """A deployment revoked since the predecessor registered refuses the successor; the predecessor is not restored."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='=user/user-a', project_id='docBrain')
    run = await _start(ts, _pipeline(), user='user-a', run_kind='deploy', owner_kind='user', deployment=deployment)
    old_engine = run.task
    resolve_env = ts._resolve_control_env

    async def revoked_during_setup(control, chain):
        # The kill switch lands while the successor is set up: the predecessor
        # has already left the registry, so the release pass never saw it
        await asyncio.sleep(0.05)  # a monotonic tick is 15 ms on Windows
        ts._deployment_revoked[deployment] = time.monotonic()
        return await resolve_env(control, chain)

    ts._resolve_control_env = revoked_during_setup

    conn = MagicMock()
    conn._account_info = _account('user-a')
    with pytest.raises(TaskError) as err:
        await ts.restart_task(
            {'arguments': {'token': run.control_id, 'pipeline': _pipeline(instructions='second draft')}}, conn=conn
        )

    assert (err.value.code, err.value.reason) == (TaskError.ENGINE_UNAVAILABLE, 'unpublished')
    assert ts._task_control == {}, 'neither a successor nor the revoked predecessor is registered'
    assert engines == [(old_engine, 'unpublished')], 'the predecessor was the last hold'


@pytest.mark.asyncio
async def test_a_failed_restart_keeps_the_predecessors_request_trees(catalog, engines, monkeypatch):
    """The predecessor's open pipes keep their trace routing through a rollback; a commit forgets them."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    ts.trace_owners.claim('trace-1', dev.key, 7)
    rewired = _pipeline()
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]
    conn = MagicMock()
    conn._account_info = _account('user-a')

    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock(side_effect=TimeoutError('silent')))
    with pytest.raises(TaskError):
        await ts.restart_task(
            {'arguments': {'token': dev.control_id, 'pipeline': rewired}}, conn=conn, wait_for_running=True
        )
    assert ts._task_control[dev.key] is dev
    assert ts.trace_owners.owner('trace-1').control_key == dev.key

    monkeypatch.setattr(TaskEngine, 'wait_for_running', AsyncMock())
    await ts.restart_task({'arguments': {'token': dev.control_id, 'pipeline': rewired}}, conn=conn)
    assert dev.key not in ts._task_control and ts.trace_owners.owner('trace-1') is None


@pytest.mark.asyncio
async def test_a_control_whose_engine_is_stopping_is_passed_over_not_reused(catalog, engines):
    """An engine in teardown takes no new hold: a matching spec call creates the replacement on a new engine."""
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')
    stopping = a.task
    stopping.state = EngineState.STOPPING

    again = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')

    assert again is not a and again.task is not stopping
    # The stopping control stays registered: its terminal events are delivered
    # through it, and the stop that began the teardown removes it afterwards
    assert set(ts._task_control) == {a.key, again.key} and stopping.holds == {a.key}
    assert again.task.is_live and again.task.holds == {again.key}


@pytest.mark.asyncio
async def test_a_restarts_predecessor_stays_registered_while_its_successor_is_set_up(catalog, engines):
    """An event in flight still routes to the predecessor during the setup; the successor's lookup never answers with it."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a')
    seen = {}
    resolve_env = ts._resolve_control_env

    async def during_setup(control, chain):
        # The successor's start is under way: the predecessor is still the
        # registered control of its key, marked for the lookup to pass over
        seen['registered'] = ts._task_control.get(dev.key) is dev
        seen['restarting'] = dev.restarting
        return await resolve_env(control, chain)

    ts._resolve_control_env = during_setup
    conn = MagicMock()
    conn._account_info = _account('user-a')
    result = await ts.restart_task({'arguments': {'token': dev.control_id, 'pipeline': _pipeline()}}, conn=conn)

    assert seen == {'registered': True, 'restarting': True}
    # The same pipeline restarted is a successor, never the predecessor reused
    assert dev.key not in ts._task_control and list(ts._task_control) == [result['token']]
    assert ts._task_control[result['token']] is not dev and result['converged'] == 'none'


@pytest.mark.asyncio
async def test_the_same_configuration_rewired_is_another_control_on_another_engine(catalog, engines):
    """Reuse means the same configuration ON THE ENGINE OF THIS SHAPE: a wiring change is never served by the old control."""
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')
    rewired = _pipeline(instructions=['Be brief.'])
    rewired['components'][1]['input'] = [{'lane': 'text', 'from': 'webhook_1'}]

    b = await _start(ts, rewired, user='user-a')

    assert b is not a and b.config_hash == a.config_hash and b.task is not a.task
    assert len(ts._task_control) == 2 and len(ts._engines) == 2
    # useExisting stays the explicit path onto the running spec, whatever it runs
    request = {'command': 'execute', 'arguments': {'pipeline': rewired, 'useExisting': True}}
    result = await ts.start_task(
        request,
        MagicMock(),
        client_id='user-a',
        user_id='user-a',
        team_id='team-1',
        org_id='org-1',
        developer_id='acme',
    )
    assert result['reused'] is True and result['token'] in (a.control_id, b.control_id)


@pytest.mark.asyncio
async def test_concurrent_identical_launches_share_one_control(catalog, monkeypatch):
    """Two identical launches that pass the lookup together are one control: the gate rechecks before registering."""
    release = asyncio.Event()

    async def held_start(self):
        await release.wait()
        self.state = EngineState.STARTING
        self._confirm_running()

    monkeypatch.setattr(TaskEngine, 'start_task', held_start)
    ts = _server()
    arrivals: List[str] = []
    try_start_lock = ts._engines.try_start_lock

    async def counting(key):
        arrivals.append(key)
        return await try_start_lock(key)

    monkeypatch.setattr(ts._engines, 'try_start_lock', counting)

    # Another project of the same shape holds the engine's start gate while
    # the two identical launches pass the lookup (no control of theirs exists
    # yet) and queue behind it; only then is the gate released
    holder = asyncio.ensure_future(_start(ts, _copy(), user='user-a'))
    launches = [asyncio.ensure_future(_start(ts, _pipeline(), user='user-a')) for _ in range(2)]
    while len(arrivals) < 3:
        await asyncio.sleep(0)
    release.set()
    other, *controls = await asyncio.gather(holder, *launches)

    assert len({id(c) for c in controls}) == 1 and set(ts._task_control) == {other.key, controls[0].key}
    assert controls[0].task is other.task and other.task.holds == {other.key, controls[0].key}


@pytest.mark.asyncio
async def test_the_hosted_policy_holds_for_a_control_attaching_to_a_warm_engine(catalog, engines, monkeypatch):
    """A config the hosted policy refuses never holds an engine, warm or cold: the engine's own start is not the gate."""
    monkeypatch.setattr(task_engine, '_is_saas_engine', lambda: True)
    monkeypatch.setattr(
        task_engine,
        'saas_pipeline_violation',
        lambda pipeline, *args, **kwargs: (
            'stdio' if pipeline['components'][1]['config'].get('instructions') == ['stdio'] else None
        ),
    )
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['Be brief.']), user='user-a')

    with pytest.raises(ValueError, match='stdio'):
        await _start(ts, _pipeline(instructions=['stdio']), user='user-a')
    assert list(ts._task_control) == [a.key] and a.task.holds == {a.key}


@pytest.mark.asyncio
async def test_the_deployment_index_names_the_kill_switch_targets(catalog, engines):
    """for_deployment lists the controls that resolved through a deployment; a removed control leaves it."""
    ts = _server()
    deployment = DeploymentRef(org_id='org-1', team_id='=team/team-1', project_id='docBrain')
    run = await _start(ts, _pipeline(), user='', run_kind='deploy', owner_kind='team', deployment=deployment)
    dev = await _start(ts, _pipeline(), user='user-a')

    assert ts._task_control.for_deployment(deployment) == [run]
    assert ts._task_control.for_deployment(DeploymentRef(org_id='org-1', team_id='=team/team-2', project_id='x')) == []
    assert dev.deployment is None

    await ts.remove_task(run.key)
    assert ts._task_control.for_deployment(deployment) == []


@pytest.mark.asyncio
async def test_the_control_start_gate_serializes_and_is_dropped_when_empty():
    """Two starters of one control key run one after the other; the gate leaves the registry with them."""
    registry = EngineRegistry()
    order: List[str] = []

    async def starter(name):
        async with registry.control_start_lock('me.user-a.acme.docBrain.webhook_1'):
            order.append(f'{name}:in')
            await asyncio.sleep(0)
            order.append(f'{name}:out')

    await asyncio.gather(starter('a'), starter('b'))

    assert order == ['a:in', 'a:out', 'b:in', 'b:out']
    assert registry._control_starts == {}


@pytest.mark.asyncio
async def test_a_data_open_with_an_unknown_param_is_refused_before_the_engine(catalog, engines, serving):
    """The data path admits params by public name like submit() does; nothing reaches the engine."""
    ts = _server()
    control = await _start(ts, _pipeline(parameters={'tone': 'prompt_1.instructions'}))

    with pytest.raises(TaskError) as err:
        await DataCommands.on_rrext_process(
            _data_conn(ts, control), {'arguments': {'subcommand': 'open', 'params': {'nope': 'x'}}}
        )
    assert err.value.code == TaskError.PARAM_REJECTED
    TaskEngine._send_data.assert_not_awaited()

    response = await DataCommands.on_rrext_process(
        _data_conn(ts, control), {'arguments': {'subcommand': 'open', 'params': {'tone': 'dry'}}}
    )
    assert response == {'body': {'ok': True}}
    forwarded = TaskEngine._send_data.await_args.args[-1]
    # The admitted params ride the server's _caller, per node and by schema
    # path (plan 5.3); the public-name map never reaches the engine
    assert 'params' not in forwarded['arguments']
    assert forwarded['arguments']['_caller']['params'] == {'prompt_1': {'instructions': 'dry'}}


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
async def test_engine_stop_of_a_shared_engine_requires_sys_admin(sys_permissions):
    """A key without an owner (a shared engine) is an operator's only."""
    conn = _conn(sys_permissions)
    with pytest.raises(PermissionError):
        await TaskCommands.on_rrext_engine_stop(conn, {'arguments': {'engineKey': 'abc'}})
    conn._server.stop_engine.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_owner_may_stop_the_engine_their_key_names(sys_permissions=()):
    """Plan 7.1: the owner stops their own (shape, owner) engine; another owner's is refused."""
    conn = _conn(list(sys_permissions))
    await TaskCommands.on_rrext_engine_stop(conn, {'arguments': {'engineKey': 'abc:ops-1', 'reason': 'gpu'}})
    conn._server.stop_engine.assert_awaited_once_with('abc:ops-1', 'gpu')

    conn.verify_team_permission = MagicMock(side_effect=PermissionError('no permissions for team'))
    with pytest.raises(PermissionError):
        await TaskCommands.on_rrext_engine_stop(conn, {'arguments': {'engineKey': 'abc:someone-else'}})
    conn.verify_team_permission.assert_called_once_with('someone-else', 'task.control')
    assert conn._server.stop_engine.await_count == 1


@pytest.mark.asyncio
async def test_a_team_member_with_task_control_may_stop_the_teams_engine():
    """A team-owned engine's key names the team: task.control on it is the owner case."""
    conn = _conn([])
    conn.verify_team_permission = MagicMock()
    await TaskCommands.on_rrext_engine_stop(conn, {'arguments': {'engineKey': 'abc:team-1'}})
    conn.verify_team_permission.assert_called_once_with('team-1', 'task.control')
    conn._server.stop_engine.assert_awaited_once_with('abc:team-1', 'ops')


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
    b = await _start(ts, _copy(), user='user-a')
    key = a.task.engine_key

    await ts.stop_engine(key, 'maintenance')
    assert engines == [(a.task, 'maintenance')]

    for control, user in ((a, 'user-a'), (b, 'user-a')):
        with pytest.raises(TaskError) as told:
            await _attach(ts, control.address, _account(user), 'task.data')
        assert told.value.code == TaskError.ENGINE_UNAVAILABLE
        assert (told.value.engineKey, told.value.reason) == (key, 'maintenance')

        with pytest.raises(TaskError) as again:
            await _attach(ts, control.address, _account(user), 'task.data')
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


def _engine(*, shared, pipeline, server=None):
    return TaskEngine(
        server=server or MagicMock(),
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
    parameters = {'tone': 'prompt_1.instructions'}
    pipeline = _pipeline(parameters=parameters)
    engine = _engine(shared=False, pipeline=pipeline)

    task = engine._build_task(pipeline)

    assert task['config']['pipeline']['parameters'] == parameters
    assert task['taskId'] == 'hash-1:user-a'
    assert 'acme.docBrain' not in task['taskId']
    assert task['config']['threadCount'] == 8
    assert task['config']['pipelineTraceLevel'] == 'full'


@pytest.mark.asyncio
async def test_the_open_config_follows_the_task_files_component_order(catalog, engines, monkeypatch, tmp_path):
    """One stack order (engine_key.stack_order): a spec listing its components out of that order still gets
    _caller.config[i] for the component the engine finds at pipeline.components[i] of the task file.
    """
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    ts = _server()
    reversed_spec = _pipeline(instructions=['dry'])
    reversed_spec['components'].reverse()
    assert [c['id'] for c in reversed_spec['components']] == ['prompt_1', 'webhook_1']

    control = await _start(ts, reversed_spec, user='user-a')
    written = control.task._build_task(control.pipeline)['config']['pipeline']['components']

    # The stack order is the engine's canonical walk where the engine has the
    # binding (C.23), the id order otherwise; never the order the spec lists
    order = [c['id'] for c in stack_order(reversed_spec['components'], pipeline_stack(reversed_spec, 'webhook_1'))]
    assert [c['id'] for c in written] == order
    assert all(c['config'] == {} for c in written)
    config = control.caller_config()
    assert config == control.config and len(config) == len(written)
    # Index i is the same component in both: the prompt's stored config carries the instructions, the webhook's is empty
    assert dict(zip(order, config)) == {'prompt_1': {'instructions': ['dry']}, 'webhook_1': {}}
    # Another control of the same owner listing the components the other way round shares the engine and
    # indexes its config the same way
    other = await _start(ts, _pipeline(project_id='docBrainCopy', instructions=['wet']), user='user-a')
    assert other.task is control.task
    assert dict(zip(order, other.caller_config())) == {'prompt_1': {'instructions': ['wet']}, 'webhook_1': {}}


def test_the_task_file_carries_no_trace_epoch(monkeypatch, tmp_path):
    """The engine's trace counter is a bare per-launch uint64; the launch is named by EaaS, never seeded into the engine (plan 7.4)."""
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    ts = _server()
    pipeline = _pipeline()

    task = _engine(shared=False, pipeline=pipeline, server=ts)._build_task(pipeline)

    assert 'traceEpoch' not in task['config']


def test_every_launch_gets_its_own_engine_id_and_the_wire_trace_id_names_it():
    """The server mints one engine id per launch; a trace counter leaves as `{nodeId}.{engineId}.{traceId}`."""
    ts = _server()
    first = _engine(shared=False, pipeline=_pipeline(), server=ts)
    second = _engine(shared=True, pipeline=_pipeline(), server=ts)
    first.engine_id = ts.next_engine_id()
    second.engine_id = ts.next_engine_id()

    assert (first.engine_id, second.engine_id) == (1, 2)
    assert first.trace_ref(7) == '1.1.7'
    assert second.trace_ref(7) == '1.2.7'

    # A restart is a new launch: the same engine, a new id, so the old ids never alias the new ones
    first.engine_id = ts.next_engine_id()
    assert first.trace_ref(7) == '1.3.7'


def test_no_engine_names_a_user(monkeypatch, tmp_path):
    """S13, plan 5.7: no task file names an identity or a storage anchor, shared or private."""
    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    pipeline = _pipeline()

    shared = _engine(shared=True, pipeline=pipeline)._build_task(pipeline)
    private = _engine(shared=False, pipeline=pipeline)._build_task(pipeline)

    assert shared['config']['pipelineTraceLevel'] == 'none'
    for task_file in (shared, private):
        assert 'identity' not in task_file and 'storage' not in task_file


@pytest.mark.asyncio
async def test_start_task_builds_an_owner_qualified_engine_with_the_owners_env(catalog, engines, monkeypatch):
    """A @spec engine is its owner's: the owner's client id, trace level and environment chain (plan 6.2)."""
    import ai.account

    asked = []

    async def merged(user_id, org_id, team_id):
        asked.append((user_id, org_id, team_id))
        return {'ROCKETRIDE_TONE': 'secret-of-a'}

    monkeypatch.setattr(ai.account.account, 'get_merged_env', merged)
    ts = _server()
    request = {'command': 'execute', 'arguments': {'pipeline': _pipeline(), 'pipelineTraceLevel': 'full'}}
    await ts.start_task(
        request,
        MagicMock(),
        client_id='user-a',
        user_id='user-a',
        team_id='team-1',
        org_id='org-1',
        developer_id='acme',
        caller_env={'ROCKETRIDE_MINE': 'x'},
    )
    (control,) = ts._task_control.values()
    engine = control.task

    assert not engine.shared and engine.client_id == 'user-a'
    assert engine._pipelineTraceLevel == 'full' and control.trace_level == 'full'
    # One chain: the engine's default is the owner's org, home team and user,
    # with the @spec call's own values on top
    assert await engine._env_source() == {'ROCKETRIDE_TONE': 'secret-of-a', 'ROCKETRIDE_MINE': 'x'}
    assert asked == [('user-a', 'org-1', 'team-1')]


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
    The account's deployment surface, in memory: deployments by audience
    (``=user/<uid>``, ``=team/<tid>``), review states, public publications,
    artifacts and developer ids.
    """

    def __init__(self) -> None:
        self.capabilities = ()
        self.deployments: Dict[tuple, Dict[str, Any]] = {}
        self.states: Dict[tuple, str] = {}
        self.publics: Dict[tuple, Dict[str, Any]] = {}
        self.artifacts: Dict[tuple, Dict[str, Any]] = {}
        self.developer_orgs = {'acme': 'org-1'}

    async def check_spend(self, org_id):
        """No balance in memory: the org may always open a pipe."""
        return None

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
        # ``project`` is the SHORT id the file carries; the rows are keyed by
        # the registry name the deploy door stores, ``developerId.pipeId``
        name = f'acme.{project}'
        self.deployments[(org, slot, name)] = {
            'teamId': slot,
            'version': version,
            'state': state,
            'billingTeamId': billing,
        }
        self.states[(org, name, version)] = review
        self.artifacts[(org, name, version)] = pipeline or _pipeline(project_id=project)

    def publish(self, *, org='org-1', version=1, state='enabled', review='ready'):
        self.publics[(org, 'acme.docBrain')] = {'version': version, 'state': state, 'artifactState': review}
        self.states[(org, 'acme.docBrain', version)] = review
        self.artifacts[(org, 'acme.docBrain', version)] = _pipeline()

    async def deployments_get(self, org_id, team_id, project_id):
        return self.deployments.get((org_id, team_id, project_id))

    async def deployments_versions(self, org_id, project_id):
        return [
            {'version': version, 'kind': 'pipe', 'state': state}
            for (org, pipe, version), state in self.states.items()
            if (org, pipe) == (org_id, project_id)
        ]

    async def publish_of_app(self, org_id, kind, app_id):
        # THE row source (plan 10.1): every live publish row of the project
        # from the one publish table — the team and personal pointers and the
        # public row alike, each with its audience and the review state of
        # the version it points at
        assert kind == 'pipe'
        rows = []
        for (org, slot, project), dep in self.deployments.items():
            if (org, project) != (org_id, app_id):
                continue
            audience = audience_fields(slot)
            rows.append(
                {
                    'kind': 'pipe',
                    'audience': audience,
                    'version': dep['version'],
                    'state': dep['state'],
                    'artifactState': self.states.get((org, project, dep['version']), 'ready'),
                    'billingTeamId': dep.get('billingTeamId', ''),
                }
            )
        public = self.publics.get((org_id, app_id))
        if public:
            rows.append({'kind': 'pipe', 'audience': {'type': 'public', 'id': ''}, 'billingTeamId': '', **public})
        return rows

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
    """An account with task permissions on each of ``teams``, each named its id capitalized (``Staging``)."""
    perms = ['task.control', 'task.data', 'task.monitor']
    return AccountInfo(
        auth='rr_key',
        userId=user_id,
        devTeam=dev_team,
        teamOrder=[dev_team],
        organization={
            'id': org,
            'name': '',
            'permissions': [],
            'teams': [{'id': team, 'name': team.capitalize(), 'permissions': perms} for team in teams],
            'developerId': developer_id,
        },
        endpoints=endpoints,
    )


@pytest.mark.asyncio
async def test_play_creates_the_dev_control_and_a_name_call_attaches_to_it(catalog, engines, deployments):
    """@spec is attach-only: a name finds the caller's Play'd control and starts nothing."""
    ts = _server()
    deployments.deploy('=user/user-a', billing='team-1')
    played = await _start(ts, _pipeline(), user='user-a')

    resolved = await _resolve(ts, ADDRESS, _caller('user-a'), 'task.data')

    assert resolved is played and resolved.rung == 'spec'
    assert list(ts._task_control) == [played.key]


@pytest.mark.asyncio
async def test_a_dead_dev_falls_through_to_me_started_from_the_artifact(catalog, engines, deployments):
    """Stop means gone: the name falls through to @me, which starts from the artifact with trigger='submit'."""
    ts = _server()
    deployments.deploy('=user/user-a', billing='team-1')
    played = await _start(ts, _pipeline(), user='user-a')
    await ts.stop_task(played.key)

    control = await _resolve(ts, ADDRESS, _caller('user-a'), 'task.data')

    assert control.rung == 'me' and control.index_key == f'me.user-a.{ADDRESS}'
    assert (control.run_kind, control.owner_kind, control.owner_id) == ('deploy', 'user', 'user-a')
    assert control.trigger == 'submit'
    assert control.deployment == DeploymentRef(org_id='org-1', team_id='=user/user-a', project_id='acme.docBrain')
    assert control.teamId == 'team-1' and control.engine_state == 'running'

    # The next name call attaches to it
    assert await _resolve(ts, ADDRESS, _caller('user-a'), 'task.data') is control


@pytest.mark.asyncio
async def test_without_a_personal_deployment_the_team_answers(catalog, engines, deployments):
    """@team: the deployment of the caller's team, owned by that team."""
    ts = _server()
    deployments.deploy('=team/team-1')

    control = await _resolve(ts, ADDRESS, _caller('user-a'), 'task.data')

    assert control.rung == 'team' and control.index_key == f'team.team-1.user-a.{ADDRESS}'
    assert (control.owner_kind, control.owner_id, control.caller_id) == ('team', 'team-1', 'user-a')
    assert control.deployment == DeploymentRef(org_id='org-1', team_id='=team/team-1', project_id='acme.docBrain')

    # A teammate gets a control of their own (plan 8.3: one control per caller)
    with pytest.raises(TaskError) as err:
        await _attach(ts, ADDRESS, _caller('user-b'), 'task.data')
    assert err.value.code == TaskError.NOT_REGISTERED
    other = await _resolve(ts, ADDRESS, _caller('user-b'), 'task.data')
    assert other is not control and other.index_key == f'team.team-1.user-b.{ADDRESS}'
    assert (other.owner_id, other.userId, other.teamId) == ('team-1', 'user-b', 'team-1')


@pytest.mark.asyncio
async def test_a_non_owner_falls_past_the_owners_play_to_the_publication(catalog, engines, deployments):
    """Nobody can name another user's control: user-b reaches the team publication, not user-a's @spec."""
    ts = _server()
    deployments.deploy('=team/team-1')
    played = await _start(ts, _pipeline(), user='user-a')

    control = await _resolve(ts, ADDRESS, _caller('user-b'), 'task.data')

    assert control is not played and control.rung == 'team'
    # Identical content, another owner (the team): another engine in this PR
    assert control.task is not played.task


@pytest.mark.asyncio
async def test_a_public_control_is_the_callers_and_carries_the_publishers_deployment(catalog, engines, deployments):
    """@public across orgs: owned and billed by the caller, released by the publisher's deployment."""
    ts = _server()
    deployments.publish(org='org-1')
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')

    control = await _resolve(ts, ADDRESS, stranger, 'task.data')

    assert control.rung == 'public' and control.index_key == f'public.user-z.{ADDRESS}'
    assert control.address == ADDRESS
    assert (control.owner_kind, control.owner_id, control.userId) == ('user', 'user-z', 'user-z')
    # The caller's org pays; the store bills no team (plan 8.3); the caller's home team is the environment's
    assert (control.orgId, control.teamId, control.env_team) == ('org-2', '', 'team-z')
    assert control.deployment == DeploymentRef(org_id='org-1', team_id='@public', project_id='acme.docBrain')
    assert control.trigger == 'submit'
    assert await _attach(ts, ADDRESS, stranger, 'task.data') is control

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
            await _resolve(ts, ADDRESS, stranger, 'task.data')
        assert err.value.code == TaskError.NOT_REGISTERED


@pytest.mark.asyncio
async def test_a_scoped_key_skips_dev_and_starts_at_me(catalog, engines, deployments):
    """A production webhook key never lands on the owner's Play'd run (@spec is skipped)."""
    ts = _server()
    deployments.deploy('=user/user-a', billing='team-1')
    played = await _start(ts, _pipeline(), user='user-a')
    scoped = _caller('user-a', endpoints=[ADDRESS])

    control = await _resolve(ts, ADDRESS, scoped, 'task.data')

    assert control is not played and control.rung == 'me'

    # Outside its scope the key is refused before anything starts
    with pytest.raises(PermissionError):
        await _resolve(ts, 'acme.otherPipe.webhook_1', scoped, 'task.data')


@pytest.mark.asyncio
async def test_not_registered_lists_the_rungs_actually_tried(catalog, engines, deployments):
    """not_found names the rungs walked; a scoped key never tried @spec."""
    ts = _server()
    for account, rungs in (
        (_caller('user-a'), ['@spec', '@me', '@team', '@org', '@public']),
        (_caller('user-a', endpoints=[ADDRESS]), ['@me', '@team', '@org', '@public']),
    ):
        with pytest.raises(TaskError) as err:
            await _resolve(ts, ADDRESS, account, 'task.data')
        assert err.value.code == TaskError.NOT_REGISTERED
        assert err.value.rungsTried == rungs
        with pytest.raises(TaskError) as err:
            await _attach(ts, ADDRESS, account, 'task.data')
        assert err.value.rungsTried == rungs


def _order(first, *, endpoints=None, teams=('staging', 'production')):
    """A member of Staging and Production whose team order starts with ``first``."""
    return _caller('user-a', dev_team=first, teams=teams, endpoints=endpoints)


def _two_environments(deployments):
    """Publish docBrain to Staging v5 and Production v4, and otherPipe to Production v4 only."""
    deployments.deploy('=team/staging', version=5, billing='staging', pipeline=_pipeline(instructions=['v5']))
    deployments.deploy('=team/production', version=4, billing='production', pipeline=_pipeline(instructions=['v4']))
    deployments.deploy(
        '=team/production',
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

    both = await _resolve(ts, ADDRESS, _order('staging'), 'task.data')
    only = await _resolve(ts, 'acme.otherPipe.webhook_1', _order('staging'), 'task.data')

    assert (both.rung, both.owner_id, both.version) == ('team', 'staging', 5)
    assert (only.rung, only.owner_id, only.version) == ('team', 'production', 4)
    assert both.deployment.team_id == '=team/staging'


@pytest.mark.asyncio
async def test_reordering_flips_the_next_call_and_a_team_root_names_one_team(catalog, engines, deployments):
    """A reorder answers from the new first team even with the old one live; a team root names one team."""
    ts = _server()
    _two_environments(deployments)
    staging = await _resolve(ts, ADDRESS, _order('staging'), 'task.data')

    production = await _resolve(ts, ADDRESS, _order('production'), 'task.data')
    assert (production.owner_id, production.version) == ('production', 4)

    # The live staging control answers its root, by name in any case or by
    # id; the order is back for the next bare call
    assert await _resolve(ts, f'@staging/{ADDRESS}', _order('production'), 'task.data') is staging
    assert await _resolve(ts, f'@STAGING/{ADDRESS}', _order('production'), 'task.data') is staging
    assert await _resolve(ts, f'=team/staging/{ADDRESS}', _order('production'), 'task.data') is staging
    assert await _attach(ts, ADDRESS, _order('production'), 'task.data') is production
    with pytest.raises(PermissionError, match='not a member'):
        await _resolve(ts, f'=team/elsewhere/{ADDRESS}', _order('production'), 'task.data')
    with pytest.raises(PermissionError, match='not a member'):
        await _resolve(ts, f'@Elsewhere/{ADDRESS}', _order('production'), 'task.data')


@pytest.mark.asyncio
async def test_a_key_frozen_to_production_ignores_its_owners_order(catalog, engines, deployments):
    """An endpoints-scoped key resolves @team through its frozen team only."""
    ts = _server()
    _two_environments(deployments)
    key = _order('staging', endpoints=[ADDRESS], teams=('production',))

    control = await _resolve(ts, ADDRESS, key, 'task.data')

    assert (control.owner_id, control.version) == ('production', 4)
    # The frozen team stands in for the home team: environment and ledger agree
    assert (control.env_team, control.teamId, control.userId) == ('production', 'production', 'user-a')

    # A scoped key not pinned to one team resolves no team at all
    unpinned = _order('staging', endpoints=['acme.otherPipe.webhook_1'])
    with pytest.raises(TaskError) as err:
        await _resolve(ts, 'acme.otherPipe.webhook_1', unpinned, 'task.data')
    assert err.value.code == TaskError.NOT_REGISTERED


@pytest.mark.asyncio
async def test_the_environment_is_the_callers_home_team_and_the_ledger_the_serving_rung(catalog, engines, deployments):
    """Plan 8.3: the environment's team is always the caller's home team; the ledger team is the serving rung's."""
    ts = _server()
    _two_environments(deployments)

    # Production first: it answers, and it is also the home team
    answered = await _resolve(ts, ADDRESS, _order('production', teams=('production', 'staging')), 'task.data')
    assert (answered.env_team, answered.teamId, answered.userId) == ('production', 'production', 'user-a')

    # A Staging-first member calling Production's publication by root: the
    # ledger row is Production's, the environment Staging's
    member = _caller('user-b', dev_team='staging', teams=('staging', 'production'))
    rooted = await _resolve(ts, f'@production/{ADDRESS}', member, 'task.data')
    assert (rooted.env_team, rooted.teamId, rooted.userId, rooted.orgId) == ('staging', 'production', 'user-b', 'org-1')
    assert rooted is not answered

    played = await _start(ts, _pipeline(), user='user-a', team='staging')
    assert (played.env_team, played.teamId) == ('staging', 'staging')

    # A caller from another org on the store: their org pays, no ledger team,
    # their home team's environment
    deployments.publish(org='org-1')
    stranger = _caller('user-z', dev_team='team-z', teams=('team-y', 'team-z'), org='org-2', developer_id='globex')
    public = await _resolve(ts, ADDRESS, stranger, 'task.data')
    assert (public.owner_kind, public.owner_id) == ('user', 'user-z')
    assert (public.env_team, public.teamId, public.orgId, public.userId) == ('team-z', '', 'org-2', 'user-z')


@pytest.mark.asyncio
async def test_a_two_segment_address_with_several_live_sources_needs_a_source(catalog, engines):
    """The source index finds both live sources; the caller must name one."""
    ts = _server()
    webhook = await _start(ts, _pipeline(), user='user-a')
    prompt = await _start(ts, _pipeline(), user='user-a', source='prompt_1')

    with pytest.raises(TaskError) as err:
        await _attach(ts, 'acme.docBrain', _caller('user-a'), 'task.data')
    assert err.value.code == TaskError.SOURCE_REQUIRED
    assert err.value.sources == ['prompt_1', 'webhook_1']

    await ts.stop_task(prompt.key)
    assert await _attach(ts, 'acme.docBrain', _caller('user-a'), 'task.data') is webhook
    assert ts._task_control.sources_of('acme', 'docBrain') == ['webhook_1']


@pytest.mark.asyncio
async def test_a_two_segment_name_starts_the_artifacts_default_source(catalog, engines, deployments):
    """With nothing live, a two-segment name starts the pinned artifact's default source."""
    ts = _server()
    deployments.deploy('=team/team-1')

    control = await _resolve(ts, 'acme.docBrain', _caller('user-a'), 'task.data')

    assert control.address == ADDRESS and control.rung == 'team'


async def test_a_resolve_touches_constant_entries_however_large_the_registry():
    """100,000 controls at other addresses: a resolve probes O(1) + one per team."""
    ts = _server()
    registry = ts._task_control
    for n in range(100_000):
        other = TaskControl(
            developer_id='acme', project_id=f'pipe{n}', source='webhook_1', userId=f'user-{n % 97}', teamId='team-1'
        )
        other.address = f'acme.pipe{n}.webhook_1'
        other.control_id = other.key = f'=control/{n:032x}'
        registry[other.key] = other
    mine = TaskControl(developer_id='acme', project_id='docBrain', source='webhook_1', userId='user-a', teamId='team-1')
    mine.address = ADDRESS
    mine.control_id = mine.key = '=control/' + 'a' * 32
    mine.task = MagicMock()
    mine.task.is_task_complete.return_value = False
    mine.task.dormant_reason = None
    registry[mine.key] = mine
    teams = tuple(f'team-{n}' for n in range(5))

    # A hit on @spec: one name-index probe
    registry.probes = 0
    assert await _attach(ts, ADDRESS, _caller('user-a', teams=teams), 'task.data') is mine
    assert registry.probes == 1

    # A miss on every rung, twice (live, then registered): spec + me + teams + org + public per walk
    registry.probes = 0
    with pytest.raises(TaskError):
        await _attach(ts, 'acme.nowhere.webhook_1', _caller('user-a', teams=teams), 'task.data')
    assert registry.probes == 2 * (4 + len(teams))

    # The forget path keeps the indexes exact
    del registry[mine.key]
    assert registry.lookup(mine.index_key) == [] and registry.sources_of('acme', 'docBrain') == []
    assert registry.for_owner('=user/user-a') == []


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


@pytest.mark.asyncio
async def test_a_restart_releases_the_engine_the_predecessor_holds_at_commit(catalog, engines, clock):
    """A request on the dormant predecessor during the setup moves its hold; the commit releases THAT hold, not the stale one."""
    ts = _server()
    dev = await _start(ts, _pipeline(), user='user-a', ttl=3600)
    stopped = dev.task
    await _idle_out(ts, clock)
    assert dev.dormant
    resolve_env = ts._resolve_control_env
    moved = {}

    async def during_setup(control, chain):
        # An id-based request reaches the dormant predecessor while its
        # successor is being set up: ensure_engine starts the key again and
        # the predecessor's hold moves onto the replacement engine
        if not moved:
            moved['engine'] = await ts.ensure_engine(dev)
            assert dev.task is moved['engine'] and moved['engine'] is not stopped
        return await resolve_env(control, chain)

    ts._resolve_control_env = during_setup
    conn = MagicMock()
    conn._account_info = _account('user-a')
    result = await ts.restart_task({'arguments': {'token': dev.control_id, 'pipeline': _pipeline()}}, conn=conn)

    successor = ts._task_control[result['token']]
    replacement = moved['engine']
    assert dev.key not in ts._task_control
    # The successor shares the replacement engine; the predecessor's hold on
    # it is gone, so the successor's terminate is the last hold
    assert successor.task is replacement
    assert replacement.holds == {successor.key}
    assert stopped.holds == frozenset()
    await ts.stop_task(successor.key)
    assert (replacement, 'user') in engines
