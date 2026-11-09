# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The DeepAgent adapter sends each tool's input schema to the model once.

Runs against the real ``langchain_core`` and ``pydantic``: whether ``_rr_input_schema``
attaches to a ``BaseTool`` is the framework's behavior, and a stub would not show it.
"""

from __future__ import annotations

import builtins
import json
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

from .._real_langchain import DEEPAGENT_SYMBOLS, load_adapter, real_langchain_or_skip

PASTE_LABEL = 'Tool input schema (JSON)'
STAGE = 'stage_marker_7f3'
SCHEMA = {
    'type': 'object',
    'required': ['deal_id'],
    'properties': {
        'deal_id': {'type': 'integer', 'description': 'The deal to read.'},
        'stage': {'type': 'string', 'enum': [STAGE, 'closed']},
        'filter': {'type': 'object', 'properties': {'owner': {'type': 'string'}}},
    },
}
TOOL = {'name': 'crm.get_deal', 'description': 'Get a single deal by id.', 'inputSchema': SCHEMA}


class _FakeAgent:
    def __init__(self) -> None:
        self.calls: List[Any] = []

    def call_tool(self, context: Any, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        self.calls.append((context, name, args))
        return {'ok': True}


@pytest.fixture(scope='module')
def real_langchain():
    restore = real_langchain_or_skip()
    yield
    restore()


@pytest.fixture(scope='module')
def adapter(real_langchain):
    return load_adapter('agent_deepagent/deepagent.py', '_agent_deepagent_tool_builder', DEEPAGENT_SYMBOLS)


def _build(adapter, *descriptors, agent=None):
    return adapter._build_deepagent_tools(agent or _FakeAgent(), SimpleNamespace(), list(descriptors))


def _prompt_entries(prompt: str) -> List[Dict[str, Any]]:
    return json.JSONDecoder().raw_decode(prompt.split('args schema): ', 1)[1])[0]


def test_description_has_no_schema_paste_when_the_original_attaches(adapter):
    tool = _build(adapter, TOOL)[0]
    assert tool.description == TOOL['description']
    assert tool._rr_input_schema is SCHEMA


def test_nested_schema_and_enum_survive_only_in_the_original(adapter):
    tool = _build(adapter, TOOL)[0]
    assert tool._rr_input_schema['properties']['stage']['enum'] == [STAGE, 'closed']
    assert 'owner' in tool._rr_input_schema['properties']['filter']['properties']
    generated = json.dumps(tool.args_schema.model_json_schema())
    assert STAGE not in generated
    assert 'owner' not in generated


def test_protocol_prompt_shows_the_original_schema_once(adapter):
    from ai.common.utils import normalize_bound_tools

    other = {'name': 'crm.list_deals', 'description': 'List deals.', 'inputSchema': {'type': 'object'}}
    prompt = adapter._tool_call_protocol_prompt(normalize_bound_tools(_build(adapter, TOOL, other)))
    assert prompt.count(STAGE) == 1
    assert PASTE_LABEL not in prompt
    entries = _prompt_entries(prompt)
    assert [entry['name'] for entry in entries] == ['crm.get_deal', 'crm.list_deals']
    assert entries[0] == {'name': 'crm.get_deal', 'description': TOOL['description'], 'args_schema': SCHEMA}


def test_bind_tools_sends_the_original_schema_once(adapter):
    prompts: List[str] = []

    class _Host(_FakeAgent):
        def call_llm(self, context: Any, prompt: str, **kwargs: Any) -> str:
            prompts.append(prompt)
            return 'FINAL>>>done'

    host = _Host()
    model = adapter._build_deepagent_llm(host, SimpleNamespace())
    model.bind_tools(_build(adapter, TOOL, agent=host))
    model.invoke('Read deal 42.')
    assert len(prompts) == 1
    assert prompts[0].count(STAGE) == 1
    assert PASTE_LABEL not in prompts[0]
    assert _prompt_entries(prompts[0]) == [
        {'name': 'crm.get_deal', 'description': TOOL['description'], 'args_schema': SCHEMA}
    ]


def test_framework_tool_without_original_keeps_its_generated_schema(adapter):
    generated = {'type': 'object', 'properties': {'todos': {'type': 'array'}}}
    prompt = adapter._tool_call_protocol_prompt(
        [{'name': 'write_todos', 'description': 'Plan.', 'args_schema': generated}]
    )
    assert _prompt_entries(prompt) == [{'name': 'write_todos', 'description': 'Plan.', 'args_schema': generated}]


def test_attach_failure_keeps_the_paste(adapter, monkeypatch):
    def refuse_the_original(obj: Any, name: str, value: Any) -> None:
        if name == '_rr_input_schema':
            raise AttributeError(name)
        builtins.setattr(obj, name, value)

    # The name is looked up in the adapter's globals before the builtin, so this reaches only the adapter's own call.
    monkeypatch.setattr(adapter, 'setattr', refuse_the_original, raising=False)
    tool = _build(adapter, TOOL)[0]
    assert tool.description.startswith(TOOL['description'])
    assert PASTE_LABEL in tool.description
    assert json.dumps(SCHEMA, ensure_ascii=False) in tool.description
    assert not hasattr(tool, '_rr_input_schema')


def test_paste_helper_leaves_the_description_when_there_is_no_usable_schema(adapter):
    assert adapter._with_schema_text('desc', None) == 'desc'
    assert adapter._with_schema_text('desc', {'bad': object()}) == 'desc'


def test_run_forwards_arguments_unchanged(adapter):
    agent = _FakeAgent()
    tool = _build(adapter, TOOL, agent=agent)[0]
    assert json.loads(tool._run(deal_id=42, tags=['a'])) == {'ok': True}
    assert [(name, args) for _, name, args in agent.calls] == [('crm.get_deal', {'deal_id': 42, 'tags': ['a']})]
