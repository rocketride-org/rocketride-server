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

"""Environment per call (plan 6.2, 0 S5): the spec keeps its placeholders, each control resolves its own values.

The engine key and task file are env-independent; a private engine carries
its owner's referenced values as its default env; a control's values come
from ITS team context and ride ``_caller.env`` on every frame, and expand the
control's config on the open (``_caller.config``); a placeholder is legal
only in a config value and only for a ``ROCKETRIDE_*`` name.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from ai.modules.task import caller_stamp
from ai.modules.task.pipeline import validate_placeholders
from ai.modules.task.task_control import TeamContext, typed_caller_config
from ai.modules.task.types import TaskError

from . import test_task_engine_sharing as sharing
from .test_task_engine_sharing import _pipeline, _server, _start

catalog = sharing.catalog
engines = sharing.engines
deployments = sharing.deployments
serving = sharing.serving

# =============================================================================
# PLACEHOLDER VALIDATION
# =============================================================================


def test_a_placeholder_in_a_config_value_naming_a_rocketride_variable_is_legal():
    pipeline = _pipeline(instructions=['${ROCKETRIDE_TONE}'])
    assert validate_placeholders(pipeline) == []


@pytest.mark.parametrize(
    ('mutate', 'where'),
    [
        # A placeholder id is reported under the id as written
        (lambda p: p['components'][1].update(id='${ROCKETRIDE_ID}'), '${ROCKETRIDE_ID}'),
        (lambda p: p['components'][1].update(provider='${ROCKETRIDE_PROVIDER}'), 'prompt_1'),
        (
            lambda p: p['components'][1]['input'].__setitem__(0, {'lane': 'questions', 'from': '${ROCKETRIDE_FROM}'}),
            'prompt_1',
        ),
        (lambda p: p.update(source='${ROCKETRIDE_SOURCE}'), 'pipeline'),
    ],
)
def test_a_placeholder_outside_a_config_value_is_an_error(mutate, where):
    """Ids, providers, connections and the source cannot vary per caller: they are what the pipeline IS."""
    pipeline = _pipeline()
    mutate(pipeline)
    errors = validate_placeholders(pipeline)
    assert [e['id'] for e in errors] == [where]
    assert 'only allowed in a component config value' in errors[0]['message']


def test_a_placeholder_outside_the_rocketride_prefix_is_an_error():
    """${HOME} in a config value would reach into the server's own environment (plan 0 S5)."""
    errors = validate_placeholders(_pipeline(instructions=['${HOME}']))
    assert errors == [{'id': 'prompt_1', 'message': 'placeholder ${HOME} must name a ROCKETRIDE_* variable'}]


@pytest.mark.asyncio
async def test_start_refuses_a_pipeline_with_a_placeholder_outside_a_config_value(catalog, engines):
    """A provider that varies per caller is refused at start (a placeholder id fails the address grammar first)."""
    ts = _server()
    pipeline = _pipeline()
    pipeline['components'][1]['provider'] = '${ROCKETRIDE_PROVIDER}'
    with pytest.raises(TaskError) as err:
        await _start(ts, pipeline)
    assert err.value.code == TaskError.INVALID_ARGUMENT and err.value.field == 'pipeline'


# =============================================================================
# THE CONTROL'S ENVIRONMENT
# =============================================================================


@pytest.mark.asyncio
async def test_a_controls_env_is_its_referenced_values_from_its_team_context(
    catalog, engines, deployments, monkeypatch
):
    """Only the names the spec references, resolved with the control's team as the team layer."""
    asked = []

    async def merged(user_id, org_id, team_id):
        asked.append((user_id, org_id, team_id))
        return {'ROCKETRIDE_TONE': 'dry', 'ROCKETRIDE_OTHER': 'never sent'}

    monkeypatch.setattr(deployments, 'get_merged_env', merged)
    ts = _server()
    control = await _start(ts, _pipeline(instructions=['${ROCKETRIDE_TONE}']))

    assert control.env == {'ROCKETRIDE_TONE': 'dry'}
    assert asked == [('user-a', 'org-1', control.team_context.team_id)]
    assert control.team_context == TeamContext('team-1', 'home')


@pytest.mark.asyncio
async def test_a_spec_without_placeholders_asks_the_account_nothing(catalog, engines, deployments, monkeypatch):
    asked = AsyncMock(return_value={'ROCKETRIDE_TONE': 'dry'})
    monkeypatch.setattr(deployments, 'get_merged_env', asked)
    ts = _server()
    control = await _start(ts, _pipeline())

    assert control.env == {}
    asked.assert_not_awaited()


@pytest.mark.asyncio
async def test_two_controls_on_one_engine_carry_their_own_values(catalog, engines, deployments, monkeypatch):
    """One owner, one shape, two team contexts: one engine, each control's env is its own and expands ITS config."""

    async def merged(user_id, org_id, team_id):
        return {'ROCKETRIDE_TONE': f'tone-of-{team_id}'}

    monkeypatch.setattr(deployments, 'get_merged_env', merged)
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['${ROCKETRIDE_TONE}']), user='user-a', team='team-1')
    b = await _start(
        ts, _pipeline(project_id='other', instructions=['${ROCKETRIDE_TONE}']), user='user-a', team='team-2'
    )

    assert a.task is b.task
    assert (a.env, b.env) == ({'ROCKETRIDE_TONE': 'tone-of-team-1'}, {'ROCKETRIDE_TONE': 'tone-of-team-2'})
    # The identity keeps the placeholder; the open carries each control's expansion (plan 5.3)
    prompt = a.index_map.to_index('prompt_1')
    assert a.config_hash == b.config_hash and a.config[prompt]['instructions'] == ['${ROCKETRIDE_TONE}']
    stamps = [caller_stamp.mint(sharing._caller(), c, correlation_id='r', subcommand='open') for c in (a, b)]
    assert [s['config'][prompt]['instructions'] for s in stamps] == [['tone-of-team-1'], ['tone-of-team-2']]
    assert all(s['controlId'] == c.control_id for s, c in zip(stamps, (a, b)))
    assert 'config' not in caller_stamp.mint(sharing._caller(), a, correlation_id='r', subcommand='write')


@pytest.mark.asyncio
async def test_an_account_that_cannot_answer_leaves_the_control_without_env(catalog, engines, deployments, monkeypatch):
    monkeypatch.setattr(deployments, 'get_merged_env', AsyncMock(side_effect=RuntimeError('ledger down')))
    ts = _server()
    control = await _start(ts, _pipeline(instructions=['${ROCKETRIDE_TONE}']))
    assert control.env == {}


# =============================================================================
# TYPED PLACEHOLDERS: A WHOLE-PLACEHOLDER LEAF TAKES ITS DECLARED TYPE
# =============================================================================


def _typed_pipeline(**leaves):
    """The webhook -> prompt pipeline with ``leaves`` set on the prompt's config."""
    pipeline = _pipeline()
    pipeline['components'][1]['config'].update(leaves)
    return pipeline


async def _open_config(ts, pipeline, env, account, monkeypatch):
    """Start a control whose ``account`` answers ``env``; the prompt's config as its open carries it (at its stack index)."""
    monkeypatch.setattr(account, 'get_merged_env', AsyncMock(return_value=env))
    control = await _start(ts, pipeline)
    stamp = caller_stamp.mint(sharing._caller(), control, correlation_id='r', subcommand='open')
    return control, stamp['config'][control.index_map.to_index('prompt_1')]


@pytest.mark.asyncio
async def test_an_integer_leaf_set_to_a_placeholder_reaches_the_engine_as_an_int(
    catalog, engines, deployments, monkeypatch
):
    """${ROCKETRIDE_EDGE} on an integer leaf: the stored value keeps the placeholder, the open carries 1024."""
    ts = _server()
    control, config = await _open_config(
        ts, _typed_pipeline(maxTokens='${ROCKETRIDE_EDGE}'), {'ROCKETRIDE_EDGE': '1024'}, deployments, monkeypatch
    )
    assert config['maxTokens'] == 1024 and isinstance(config['maxTokens'], int)
    assert control.config[control.index_map.to_index('prompt_1')]['maxTokens'] == '${ROCKETRIDE_EDGE}'


@pytest.mark.asyncio
async def test_a_boolean_leaf_set_to_a_placeholder_reaches_the_engine_as_a_bool(
    catalog, engines, deployments, monkeypatch
):
    ts = _server()
    _, config = await _open_config(
        ts, _typed_pipeline(stream='${ROCKETRIDE_STREAM}'), {'ROCKETRIDE_STREAM': 'true'}, deployments, monkeypatch
    )
    assert config['stream'] is True


@pytest.mark.asyncio
async def test_a_placeholder_inside_a_longer_string_stays_a_string(catalog, engines, deployments, monkeypatch):
    """Only a leaf that IS one placeholder is typed; text around it is text, whatever the env value looks like."""
    ts = _server()
    _, config = await _open_config(
        ts,
        _typed_pipeline(label='edge ${ROCKETRIDE_EDGE}', instructions=['Tone: ${ROCKETRIDE_EDGE}']),
        {'ROCKETRIDE_EDGE': '1024'},
        deployments,
        monkeypatch,
    )
    assert config['label'] == 'edge 1024' and config['instructions'] == ['Tone: 1024']


@pytest.mark.asyncio
async def test_an_unfilled_placeholder_on_a_typed_leaf_is_left_to_the_engine(
    catalog, engines, deployments, monkeypatch
):
    """No env value: the placeholder rides as written (the engine's resolver passes a placeholder untyped)."""
    ts = _server()
    _, config = await _open_config(ts, _typed_pipeline(maxTokens='${ROCKETRIDE_EDGE}'), {}, deployments, monkeypatch)
    assert config['maxTokens'] == '${ROCKETRIDE_EDGE}'


@pytest.mark.asyncio
async def test_a_value_that_does_not_fit_its_typed_leaf_is_refused_at_the_door(
    catalog, engines, deployments, monkeypatch
):
    """A non-numeric env value on an integer leaf is invalid_argument naming the leaf; nothing starts."""
    monkeypatch.setattr(deployments, 'get_merged_env', AsyncMock(return_value={'ROCKETRIDE_EDGE': 'lots'}))
    ts = _server()
    with pytest.raises(TaskError) as err:
        await _start(ts, _typed_pipeline(maxTokens='${ROCKETRIDE_EDGE}'))
    assert (err.value.code, err.value.field) == (TaskError.INVALID_ARGUMENT, 'maxTokens')
    assert '"maxTokens" expects integer (from ${ROCKETRIDE_EDGE})' in str(err.value)
    assert 'lots' not in str(err.value), 'the env value never leaves with the refusal'
    assert ts._task_control == {} and ts._engines == {}


class _DottedView:
    """One integer leaf under a branch block whose name carries a dot."""

    def __iter__(self):
        return iter(['maxTokens'])

    def path_of(self, key):
        return 'models.gpt-5.2.maxTokens'

    def descriptor_of(self, key):
        return {'type': 'integer'}


def test_a_typed_leaf_under_a_dotted_branch_name_takes_its_type():
    """``models.gpt-5.2.maxTokens``: the walk matches stored keys against the path, never the path split at its dots."""
    stored = {'models': {'gpt-5.2': {'maxTokens': '${ROCKETRIDE_EDGE}'}}}
    expanded = {'models': {'gpt-5.2': {'maxTokens': '1024'}}}
    assert typed_caller_config(stored, expanded, _DottedView()) == {'models': {'gpt-5.2': {'maxTokens': 1024}}}


def test_a_placeholder_followed_by_a_newline_is_not_one_whole_placeholder():
    """Only the placeholder itself is typed: anything after it, a newline included, keeps the expansion a string."""
    stored = {'models': {'gpt-5.2': {'maxTokens': '${ROCKETRIDE_EDGE}\n'}}}
    expanded = {'models': {'gpt-5.2': {'maxTokens': '1024\n'}}}
    assert typed_caller_config(stored, expanded, _DottedView())['models']['gpt-5.2']['maxTokens'] == '1024\n'


# =============================================================================
# THE ENGINE'S DEFAULT ENV AND THE TASK FILE
# =============================================================================


@pytest.mark.asyncio
async def test_a_private_engines_default_env_is_its_owners_referenced_values():
    """The engine's view of the spec for the checks is expanded; what runs keeps the placeholders."""
    from ai.modules.task.task_engine import TaskEngine
    from unittest.mock import MagicMock

    engine = TaskEngine(
        server=MagicMock(),
        id='t',
        project_id='p',
        source='s',
        engine_key='hash:user-a',
        address='acme.p.s',
        pipeline={},
        shared=False,
        env_source=AsyncMock(return_value={'ROCKETRIDE_TONE': 'dry', 'ROCKETRIDE_OTHER': 'x'}),
    )
    spec = {'components': [{'id': 'c', 'provider': 'prompt', 'config': {'instructions': '${ROCKETRIDE_TONE}'}}]}

    assert await engine._default_env(spec) == {'ROCKETRIDE_TONE': 'dry'}
    assert (await engine._resolve_pipeline(spec))['components'][0]['config']['instructions'] == 'dry'
    task = engine._build_task(spec, {'ROCKETRIDE_TONE': 'dry'})
    # The task file is the SHAPE (C.22): no config at all, the default env beside it
    assert task['config']['pipeline']['components'][0] == {'id': 'c', 'provider': 'prompt', 'config': {}}
    assert task['config']['env'] == {'ROCKETRIDE_TONE': 'dry'}


@pytest.mark.asyncio
async def test_a_shared_engine_has_no_default_env():
    from ai.modules.task.task_engine import TaskEngine
    from unittest.mock import MagicMock

    source = AsyncMock(return_value={'ROCKETRIDE_TONE': 'dry'})
    engine = TaskEngine(
        server=MagicMock(),
        id='t',
        project_id='p',
        source='s',
        engine_key='hash',
        address='acme.p.s',
        pipeline={},
        shared=True,
        env_source=source,
    )
    spec = {'components': [{'id': 'c', 'provider': 'prompt', 'config': {'instructions': '${ROCKETRIDE_TONE}'}}]}

    assert await engine._default_env(spec) == {}
    source.assert_not_awaited()
    assert engine._build_task(spec, {})['config']['env'] == {}
