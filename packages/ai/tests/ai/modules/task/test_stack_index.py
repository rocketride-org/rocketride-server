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

"""The canonical stack and index translation (C.23, plan 7.2).

The engine walks a pipeline in an order that depends on its shape alone and
names components by STACK INDEX (traces, the open's config); the server reads
that walk through ONE binding, ``engLib.pipelineStack``, and translates both
ways: what a control's user sees names the ids THEY wrote, and what the engine
receives names the engine's components.

Three groups:

- pure: ``stack_order``, ``IndexMap`` and the binding lookup, no engine needed;
- a STUB binding standing in for the engine's answer on the two-component
  test shape, so the translation runs on any engine build;
- the REAL binding, skipped on an engine built before C.23 (they need the
  rebuilt engine).
"""

from __future__ import annotations

import copy
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from rocketride import EVENT_TYPE

from ai.modules.task import engine_key
from ai.modules.task.engine_key import IndexMap, engine_content, index_map_of, pipeline_stack, stack_order
from ai.modules.task.task_control import TaskControl

from . import test_task_engine_sharing as sharing
from .test_task_engine_sharing import _pipeline, _server, _start

catalog = sharing.catalog
engines = sharing.engines

#: Whether the engine this test runs in carries the C.23 binding.
ENGINE = sys.modules.get(engine_key.CONST_ENGINE_MODULE)
HAS_BINDING = ENGINE is not None and hasattr(ENGINE, 'pipelineStack')
needs_engine = pytest.mark.skipif(not HAS_BINDING, reason='needs an engine built with engLib.pipelineStack (C.23)')


# =============================================================================
# HELPERS
# =============================================================================


def _stub_stack(pipeline, source):
    """The engine's answer for the webhook -> prompt test shape, whatever its ids: the source at 0, the prompt at 1."""
    components = pipeline.get('components') or []
    entry = next(c for c in components if c.get('id') == source)
    other = next(c for c in components if c.get('id') != source)
    return {
        'components': [
            {'index': 0, 'id': entry['id'], 'provider': entry['provider'], 'inputs': [], 'controls': []},
            {
                'index': 1,
                'id': other['id'],
                'provider': other['provider'],
                'inputs': [{'from': 0, 'lane': 'questions'}],
                'controls': [],
            },
        ],
        'hash': 'shape-webhook-prompt',
    }


@pytest.fixture
def stub_binding(monkeypatch):
    """Put the stub on the engine module the way the rebuilt engine carries the real one."""
    module = sys.modules.get(engine_key.CONST_ENGINE_MODULE)
    if module is None:
        module = SimpleNamespace()
        monkeypatch.setitem(sys.modules, engine_key.CONST_ENGINE_MODULE, module)
    monkeypatch.setattr(module, 'pipelineStack', _stub_stack, raising=False)
    return _stub_stack


def _renamed(pipeline, *, source='hook', step='ask', project_id='docBrainRenamed'):
    """The same shape with every component id renamed (and the parameters map with it)."""
    spec = copy.deepcopy(pipeline)
    names = {'webhook_1': source, 'prompt_1': step}
    spec['project_id'] = project_id
    spec['source'] = names[spec['source']]
    for component in spec['components']:
        component['id'] = names[component['id']]
        for edge in component.get('input') or []:
            edge['from'] = names[edge['from']]
    if 'parameters' in spec:
        spec['parameters'] = {
            name: f'{names[target.split(".", 1)[0]]}.{target.split(".", 1)[1]}'
            for name, target in spec['parameters'].items()
        }
    return spec


def _sibling(control: TaskControl, pipeline) -> TaskControl:
    """Another control of the same shape, written with other ids, holding the same engine."""
    other = TaskControl(
        control_id='=control/' + 'b' * 32,
        key='=control/' + 'b' * 32,
        userId=control.userId,
        teamId=control.teamId,
        orgId=control.orgId,
        project_id=pipeline['project_id'],
        source=pipeline['source'],
        pipeline=pipeline,
        task=control.task,
    )
    other.setup_declared_parameters()
    return other


# =============================================================================
# PURE: THE STACK ORDER AND THE TABLE
# =============================================================================


def test_stack_order_puts_the_stack_first_in_index_order_then_the_rest_by_id():
    """With the engine's stack the members come first by index; components the engine never builds follow by id."""
    components = [{'id': 'z_orphan'}, {'id': 'b_llm'}, {'id': 'a_src'}, {'id': 'c_tool'}, {'id': 'a_orphan'}]
    stack = {
        'components': [{'index': 0, 'id': 'a_src'}, {'index': 1, 'id': 'c_tool'}, {'index': 2, 'id': 'b_llm'}],
        'hash': 'h',
    }

    assert [c['id'] for c in stack_order(components, stack)] == ['a_src', 'c_tool', 'b_llm', 'a_orphan', 'z_orphan']
    # Without the engine's stack: the component id order (C.22)
    assert [c['id'] for c in stack_order(components)] == ['a_orphan', 'a_src', 'b_llm', 'c_tool', 'z_orphan']


def test_the_index_map_translates_stack_members_and_passes_everything_else_through():
    """Digits name a stack member; a filter type, a tool label or an orphan's position never translates."""
    names = IndexMap(['hook', 'ask', 'orphan'], stacked=2, engine_indexes=True, shape_hash='h')

    assert (names.to_index('ask'), names.to_index('nope')) == (1, None)
    assert (names.to_id(0), names.to_id(3), names.to_id(-1), names.to_id(True)) == ('hook', None, None, None)
    assert names.author('1') == 'ask'
    assert names.author('2') == '2'  # outside the stack: never built, never traced
    assert names.author('pipe') == 'pipe'
    assert names.author('ask.search()') == 'ask.search()'
    assert names.author(None) is None
    # Only the engine's ASCII decimal is an index: other digits are labels
    assert names.author('²') == '²'
    assert names.author('١') == '١'
    assert names.author('9' * 40) == '9' * 40
    assert [c['id'] for c in names.order([{'id': 'x'}, {'id': 'orphan'}, {'id': 'hook'}, {'id': 'ask'}])] == [
        'hook',
        'ask',
        'orphan',
        'x',
    ]

    # An index the table does not hold passes through instead of raising
    short = IndexMap(['hook'], stacked=3, engine_indexes=True)
    assert short.author('2') == '2'

    # An engine that names components by id: nothing is an index
    by_id = IndexMap(['1', 'ask'], stacked=0, engine_indexes=False)
    assert by_id.author('1') == '1'


def test_the_binding_is_looked_up_never_imported(monkeypatch):
    """No engine module, or one without the binding: no stack; with it, its answer as given."""
    monkeypatch.setitem(sys.modules, engine_key.CONST_ENGINE_MODULE, SimpleNamespace())
    assert pipeline_stack({'components': []}, 'a') is None
    assert index_map_of({'components': [{'id': 'b'}, {'id': 'a'}]}, 'a').ids == ['a', 'b']

    seen = []

    def binding(pipeline, source):
        seen.append((pipeline, source))
        return {'components': [{'index': 0, 'id': 'b'}], 'hash': 'h'}

    monkeypatch.setitem(sys.modules, engine_key.CONST_ENGINE_MODULE, SimpleNamespace(pipelineStack=binding))
    spec = {'components': [{'id': 'b'}, {'id': 'a'}]}
    names = index_map_of(spec, 'b')
    assert seen == [(spec, 'b')]
    assert (names.ids, names.stacked, names.engine_indexes, names.shape_hash) == (['b', 'a'], 1, True, 'h')


def test_a_stack_row_without_a_component_keeps_its_slot(monkeypatch):
    """A source named but not listed keeps index 0, so every later component keeps the index the engine traces."""

    def binding(pipeline, source):
        return {
            'components': [
                {'index': 0, 'id': 'src', 'provider': '', 'inputs': [], 'controls': []},
                {
                    'index': 1,
                    'id': 'ask',
                    'provider': 'prompt',
                    'inputs': [{'from': 0, 'lane': 'questions'}],
                    'controls': [],
                },
            ],
            'hash': 'h',
        }

    monkeypatch.setitem(sys.modules, engine_key.CONST_ENGINE_MODULE, SimpleNamespace(pipelineStack=binding))
    names = index_map_of({'components': [{'id': 'orphan'}, {'id': 'ask'}]}, 'src')

    assert names.ids == ['src', 'ask', 'orphan'] and names.stacked == 2
    assert (names.author('0'), names.author('1'), names.author('2')) == ('src', 'ask', '2')
    assert names.to_index('ask') == 1


def test_engine_content_orders_configs_by_the_engines_stack(stub_binding):
    """The control's config follows the engine's stack; the engine key is built on the shape hash, which ignores the ids."""

    def facts(provider, stored):
        return dict(stored), ('source', 'webhook')

    spec = _pipeline(instructions=['dry'])
    spec['components'].reverse()
    content = engine_content(spec, 'webhook_1', facts)

    assert content.index_map.ids == ['webhook_1', 'prompt_1']
    assert content.stored_by_index == [{}, {'instructions': ['dry']}]
    assert content.shape_hash == 'shape-webhook-prompt'

    # Renaming every id keeps the shape hash, and with it the engine key, and
    # moves nothing; only the content hash (the fallback without the binding)
    # carries the ids
    renamed = engine_content(_renamed(spec), 'hook', facts)
    assert renamed.shape_hash == content.shape_hash
    assert renamed.key_hash == content.key_hash == content.shape_hash
    assert renamed.key(rung='public', owner_id='user-b') == content.key(rung='public', owner_id='user-a')
    assert renamed.stored_by_index == content.stored_by_index
    assert renamed.content_hash != content.content_hash


# =============================================================================
# STUB BINDING: THE SERVER TRANSLATES BOTH WAYS
# =============================================================================


@pytest.mark.asyncio
async def test_a_flow_event_names_the_receiving_controls_own_component(catalog, engines, stub_binding):
    """The engine traces index 1; the control that owns the tree sees the id its user wrote, in its run log too."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a')
    engine = control.task
    engine._run_log_failed = set(engine.holds)
    ts.broadcast_task_event = AsyncMock()
    ts.trace_owners.claim(engine.trace_ref(7), control.key, 11)

    body = {'id': 3, 'op': 'enter', 'component': '1', 'pipes': ['report.pdf', '1'], 'traceId': 7, 'trace': {}}
    await engine._forward_task_event(EVENT_TYPE.FLOW, {'event': 'apaevt_flow', 'body': body})

    delivered = ts.broadcast_task_event.await_args.kwargs['event']['body']
    assert delivered['component'] == 'prompt_1'
    assert delivered['pipes'] == ['report.pdf', 'prompt_1']
    # The engine's own copy keeps the index (it aggregates by index)
    assert body['component'] == '1' and body['pipes'] == ['report.pdf', '1']


@pytest.mark.asyncio
async def test_a_begin_names_the_object_and_is_never_translated(catalog, engines, stub_binding):
    """BEGIN/END carry the object name; a document called '1' stays '1'."""
    ts = _server()
    control = await _start(ts, _pipeline(), user='user-a')

    body = control.author_flow({'op': 'begin', 'component': '1', 'pipes': ['1']})
    assert (body['component'], body['pipes']) == ('1', ['1'])


@pytest.mark.asyncio
async def test_a_control_written_with_other_ids_reads_its_own_ids(catalog, engines, stub_binding):
    """Two controls of one shape, two sets of ids: each reads the engine's index as its own id."""
    ts = _server()
    first = await _start(ts, _pipeline(), user='user-a')
    second = _sibling(first, _renamed(_pipeline()))

    flow = {'op': 'leave', 'component': '1', 'pipes': ['doc', '0', '1']}
    assert first.author_flow(dict(flow))['pipes'] == ['doc', 'webhook_1', 'prompt_1']
    assert second.author_flow(dict(flow))['pipes'] == ['doc', 'hook', 'ask']
    assert second.author_flow(dict(flow))['component'] == 'ask'


@pytest.mark.asyncio
async def test_the_status_projection_shows_component_stats_by_author_id(catalog, engines, stub_binding):
    """The status translates componentStats and the pipe stacks; slowestDocs names objects and passes through."""
    ts = _server()
    first = await _start(ts, _pipeline(), user='user-a')
    second = _sibling(first, _renamed(_pipeline()))
    status = {
        'componentStats': {'1': {'calls': 2, 'totalSeconds': 1.5, 'maxSeconds': 1.0}, 'pipe': {'calls': 1}},
        'pipeflow': {'totalPipes': 0, 'byPipe': {0: ['report.pdf', '0', '1']}},
        'slowestDocs': [{'name': '1', 'elapsed': 2.0}],
    }

    mine = first.project_status(status, shared=False)
    theirs = second.project_status(status, shared=False)

    assert set(mine['componentStats']) == {'prompt_1', 'pipe'}
    assert set(theirs['componentStats']) == {'ask', 'pipe'}
    assert theirs['componentStats']['ask'] == {'calls': 2, 'totalSeconds': 1.5, 'maxSeconds': 1.0}
    assert theirs['pipeflow']['byPipe'] == {0: ['report.pdf', 'hook', 'ask']}
    assert theirs['slowestDocs'] == [{'name': '1', 'elapsed': 2.0}]
    # The engine's status is not touched
    assert set(status['componentStats']) == {'1', 'pipe'}


@pytest.mark.asyncio
async def test_params_by_author_id_reach_the_engines_component_at_that_index(catalog, engines, stub_binding):
    """A parameters map in the control's own ids targets the engine's component at the same stack index."""
    ts = _server()
    first = await _start(ts, _pipeline(parameters={'tone': 'prompt_1.instructions'}), user='user-a')
    second = _sibling(first, _renamed(_pipeline(parameters={'tone': 'prompt_1.instructions'})))

    # The published map stays in the author's ids
    assert second.parameters == {'tone': 'ask.instructions'}
    assert first.resolve_params({'tone': 'dry'}) == {'prompt_1': {'instructions': 'dry'}}
    assert second.resolve_params({'tone': 'dry'}) == {'prompt_1': {'instructions': 'dry'}}


@pytest.mark.asyncio
async def test_the_task_file_and_the_open_config_share_the_engines_order(
    catalog, engines, stub_binding, monkeypatch, tmp_path
):
    """Position i of the task file is stack index i, and the open's config[i] is that component's."""
    from ai.modules.task import task_engine

    monkeypatch.setattr(task_engine, 'CONST_TASK_DATA_PATH', str(tmp_path))
    ts = _server()
    spec = _pipeline(instructions=['dry'])
    spec['components'].reverse()
    control = await _start(ts, spec, user='user-a')

    written = control.task._build_task(control.pipeline)['config']['pipeline']['components']
    assert [c['id'] for c in written] == ['webhook_1', 'prompt_1']
    assert control.caller_config() == [{}, {'instructions': ['dry']}]
    assert control.task.index_map.shape_hash == 'shape-webhook-prompt'


# =============================================================================
# THE REAL BINDING (needs the rebuilt engine)
# =============================================================================

#: webhook -> parse -> (embed -> store, llm), the ids and listing of a first author
CHAIN = {
    'source': 'hook',
    'components': [
        {'id': 'hook', 'provider': 'webhook', 'config': {'port': 1}},
        {'id': 'parse', 'provider': 'parse', 'input': [{'lane': 'tags', 'from': 'hook'}]},
        {'id': 'embed', 'provider': 'embedding', 'input': [{'lane': 'text', 'from': 'parse'}]},
        {'id': 'store', 'provider': 'qdrant', 'input': [{'lane': 'documents', 'from': 'embed'}]},
        {
            'id': 'llm',
            'provider': 'llm_openai',
            'input': [{'lane': 'questions', 'from': 'parse'}, {'lane': 'questions', 'from': 'hook'}],
        },
    ],
}

#: The same shape: ids renamed, components and edges listed otherwise, config and UI data changed
CHAIN_SHUFFLED = {
    'source': 'src_9',
    'components': [
        {
            'id': 'z_answer',
            'provider': 'llm_openai',
            'name': 'Answer',
            'config': {'model': 'x'},
            'ui': {'position': {'x': 4}},
            'input': [{'from': 'src_9', 'lane': 'questions'}, {'from': 'a_parser', 'lane': 'questions'}],
        },
        {'id': 'q_vectors', 'provider': 'qdrant', 'input': [{'lane': 'documents', 'from': 'm_embedder'}]},
        {'id': 'a_parser', 'provider': 'parse', 'input': [{'lane': 'tags', 'from': 'src_9'}]},
        {'id': 'm_embedder', 'provider': 'embedding', 'input': [{'lane': 'text', 'from': 'a_parser'}]},
        {'id': 'src_9', 'provider': 'webhook', 'config': {'port': 2}},
    ],
}

#: Two identical branches; the swapped twin renames them across the branches
SYMMETRIC = {
    'source': 'chat',
    'components': [
        {'id': 'chat', 'provider': 'chat'},
        {'id': 'l_llm', 'provider': 'llm_openai', 'input': [{'lane': 'questions', 'from': 'chat'}]},
        {'id': 'r_llm', 'provider': 'llm_openai', 'input': [{'lane': 'questions', 'from': 'chat'}]},
        {'id': 'l_out', 'provider': 'response_answers', 'input': [{'lane': 'answers', 'from': 'l_llm'}]},
        {'id': 'r_out', 'provider': 'response_answers', 'input': [{'lane': 'answers', 'from': 'r_llm'}]},
    ],
}
SYMMETRIC_SWAPPED = {
    'source': 'c',
    'components': [
        {'id': 'b2', 'provider': 'response_answers', 'input': [{'lane': 'answers', 'from': 'a2'}]},
        {'id': 'b1', 'provider': 'response_answers', 'input': [{'lane': 'answers', 'from': 'a1'}]},
        {'id': 'a2', 'provider': 'llm_openai', 'input': [{'lane': 'questions', 'from': 'c'}]},
        {'id': 'a1', 'provider': 'llm_openai', 'input': [{'lane': 'questions', 'from': 'c'}]},
        {'id': 'c', 'provider': 'chat'},
    ],
}


def _shape(stack):
    """A stack as the hash sees it: per index the provider and the wiring, no ids."""
    return [(c['provider'], c['inputs'], c['controls']) for c in stack['components']]


@needs_engine
def test_the_engine_walks_shuffled_ids_and_input_order_to_one_stack_and_hash():
    first = pipeline_stack(CHAIN, 'hook')
    second = pipeline_stack(CHAIN_SHUFFLED, 'src_9')

    assert _shape(first) == _shape(second)
    assert first['hash'] == second['hash'] and len(first['hash']) == 64
    assert first['components'][0]['id'] == 'hook' and second['components'][0]['id'] == 'src_9'

    # The same component sits at the same index in both
    one, two = index_map_of(CHAIN, 'hook'), index_map_of(CHAIN_SHUFFLED, 'src_9')
    for left, right in (('parse', 'a_parser'), ('embed', 'm_embedder'), ('store', 'q_vectors'), ('llm', 'z_answer')):
        assert one.to_index(left) == two.to_index(right)


@needs_engine
def test_symmetric_branches_walk_to_one_hash():
    first = pipeline_stack(SYMMETRIC, 'chat')
    second = pipeline_stack(SYMMETRIC_SWAPPED, 'c')

    assert _shape(first) == _shape(second)
    assert first['hash'] == second['hash']


@needs_engine
def test_configuration_names_and_avoid_mocks_against_the_shape_hash():
    """Configuration and names are outside the shape; avoidMocks and a lane are in it."""
    base = pipeline_stack(CHAIN, 'hook')['hash']
    configured = copy.deepcopy(CHAIN)
    configured['components'][4]['config'] = {'model': 'other'}
    configured['components'][4]['name'] = 'Renamed'
    relaned = copy.deepcopy(CHAIN)
    relaned['components'][1]['input'][0]['lane'] = 'documents'

    assert pipeline_stack(configured, 'hook')['hash'] == base
    assert pipeline_stack({**CHAIN, 'avoidMocks': True}, 'hook')['hash'] != base
    assert pipeline_stack(relaned, 'hook')['hash'] != base


@needs_engine
def test_the_engine_refuses_two_components_with_one_id():
    duplicated = copy.deepcopy(CHAIN)
    duplicated['components'][2]['id'] = 'parse'
    with pytest.raises(Exception):
        pipeline_stack(duplicated, 'hook')
