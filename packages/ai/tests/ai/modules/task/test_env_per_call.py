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

The engine's content key and task file are env-independent; a private engine
carries its owner's referenced values as its default env; a control's values
come from ITS team context and ride ``_caller.env`` on every frame; a
placeholder is legal only in a config value and only for a ``ROCKETRIDE_*``
name.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from ai.modules.task.pipeline import validate_placeholders
from ai.modules.task.task_control import TeamContext
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
    """Identical specs, one engine, two callers: each control's env is its own; the engine key is shared."""

    async def merged(user_id, org_id, team_id):
        return {'ROCKETRIDE_TONE': f'tone-of-{user_id}'}

    monkeypatch.setattr(deployments, 'get_merged_env', merged)
    ts = _server()
    a = await _start(ts, _pipeline(instructions=['${ROCKETRIDE_TONE}']), user='user-a')
    b = await _start(ts, _pipeline(instructions=['${ROCKETRIDE_TONE}']), user='user-b')

    assert a.task is b.task
    assert (a.env, b.env) == ({'ROCKETRIDE_TONE': 'tone-of-user-a'}, {'ROCKETRIDE_TONE': 'tone-of-user-b'})


@pytest.mark.asyncio
async def test_an_account_that_cannot_answer_leaves_the_control_without_env(catalog, engines, deployments, monkeypatch):
    monkeypatch.setattr(deployments, 'get_merged_env', AsyncMock(side_effect=RuntimeError('ledger down')))
    ts = _server()
    control = await _start(ts, _pipeline(instructions=['${ROCKETRIDE_TONE}']))
    assert control.env == {}


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
    assert task['config']['pipeline']['components'][0]['config']['instructions'] == '${ROCKETRIDE_TONE}'
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
