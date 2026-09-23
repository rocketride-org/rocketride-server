# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the CrewAI tool bridge's generated args_schema.

Bug: every tool call in a crew failed with

    Arguments validation failed: Field required [type=missing]

even for tools whose arguments the model had clearly supplied, and including
CrewAI's own delegation tool.

Root cause: ``crewai/tools/tool_usage.py`` intersects the model's emitted
argument keys with ``args_schema.model_json_schema()["properties"].keys()`` and
**silently drops** everything that does not match::

    acceptable_args = tool.args_schema.model_json_schema()['properties'].keys()
    arguments = {k: v for k, v in calling.arguments.items() if k in acceptable_args}

When nothing matches, ``arguments`` becomes ``{}`` and
``structured_tool.py`` validates that empty dict, reporting every required field
as missing with ``input_value={}``.

Our contribution was typing every field as ``Any``. CrewAI renders the generated
schema into the ReAct prompt as the ``Tool Arguments:`` block, and an ``Any``
field carries no ``"type"`` at all — so the model was shown argument names with
no types, while a second, differently-shaped copy of the schema was appended to
the description. These tests pin the generated schema: real types, no duplicated
schema text, and the exact empty-dict regression.
"""

from __future__ import annotations

import importlib
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

_NODES_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
if str(_NODES_DIR) not in sys.path:
    sys.path.insert(0, str(_NODES_DIR))

_STUB_MODULE_NAMES = ('rocketlib', 'crewai', 'crewai.tools', 'ai', 'ai.common', 'ai.common.agent', 'ai.common.utils')


def _build_stubs() -> dict:
    from pydantic import BaseModel as PydanticBaseModel

    mod_rocketlib = types.ModuleType('rocketlib')
    mod_rocketlib.ToolDescriptor = dict

    mod_crewai = types.ModuleType('crewai')

    class BaseLLM:
        def __init__(self, model: str = '', temperature=None, **kwargs):
            self.model = model

    mod_crewai.BaseLLM = BaseLLM

    mod_crewai_tools = types.ModuleType('crewai.tools')

    class BaseTool(PydanticBaseModel):
        """Minimal stand-in: real BaseTool is a pydantic model with these fields."""

        name: str = ''
        description: str = ''
        args_schema: Any = None

    mod_crewai_tools.BaseTool = BaseTool
    mod_crewai.tools = mod_crewai_tools

    mod_ai = types.ModuleType('ai')
    mod_ai_common = types.ModuleType('ai.common')
    mod_agent = types.ModuleType('ai.common.agent')

    class AgentBase:
        pass

    class AgentContext:
        pass

    mod_agent.AgentBase = AgentBase
    mod_agent.AgentContext = AgentContext

    mod_utils = types.ModuleType('ai.common.utils')
    mod_utils.safe_str = str

    return {
        'rocketlib': mod_rocketlib,
        'crewai': mod_crewai,
        'crewai.tools': mod_crewai_tools,
        'ai': mod_ai,
        'ai.common': mod_ai_common,
        'ai.common.agent': mod_agent,
        'ai.common.utils': mod_utils,
    }


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    sys.modules.update(_build_stubs())
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


with _scoped_stubs():
    crewai_base = importlib.import_module('agent_crewai.crewai_base')


@pytest.fixture(autouse=True)
def _stubbed_crewai():
    """`_build_crew_tools` imports crewai and pydantic at call time, not import time."""
    with _scoped_stubs():
        yield


class _Recorder(crewai_base.CrewBase):
    def __init__(self):
        self.calls = []

    def call_tool(self, context, name, args):
        self.calls.append({'context': context, 'name': name, 'args': args})
        return {'ok': True}


def _tools(*descriptors):
    return _Recorder()._build_crew_tools(context=object(), tool_descriptors=list(descriptors))


def _schema_of(input_schema):
    descriptor = {'name': 'demo', 'description': 'Demo tool.', 'inputSchema': input_schema}
    return _tools(descriptor)[0].args_schema


# ---------------------------------------------------------------------------
# Types reach the prompt
# ---------------------------------------------------------------------------


class TestGeneratedTypes:
    @pytest.mark.parametrize(
        'json_type,expected',
        [
            ('string', 'string'),
            ('integer', 'integer'),
            ('number', 'number'),
            ('boolean', 'boolean'),
            ('array', 'array'),
            ('object', 'object'),
        ],
    )
    def test_required_field_carries_its_type(self, json_type, expected):
        schema = _schema_of({'type': 'object', 'required': ['value'], 'properties': {'value': {'type': json_type}}})
        rendered = schema.model_json_schema()['properties']['value']
        assert rendered.get('type') == expected

    def test_every_property_is_typed(self):
        """The regression: an all-Any model renders properties with no "type" key."""
        schema = _schema_of(
            {
                'type': 'object',
                'required': ['deal_id'],
                'properties': {
                    'deal_id': {'type': 'integer', 'description': 'Deal id.'},
                    'term': {'type': 'string'},
                },
            }
        )
        for name, prop in schema.model_json_schema()['properties'].items():
            assert _is_typed(prop), f'{name} rendered without a type: {prop}'

    def test_unknown_type_falls_back_to_any(self):
        schema = _schema_of({'type': 'object', 'required': ['weird'], 'properties': {'weird': {'type': 'nonsense'}}})
        assert schema.model_validate({'weird': {'anything': 1}}).weird == {'anything': 1}

    def test_missing_type_falls_back_to_any(self):
        schema = _schema_of({'type': 'object', 'required': ['x'], 'properties': {'x': {}}})
        assert schema.model_validate({'x': 'anything'}).x == 'anything'

    @pytest.mark.parametrize('json_type', [['string', 'null'], ['integer', 'string'], 123, {'oneOf': []}])
    def test_non_string_type_falls_back_to_any(self, json_type):
        """A JSON Schema union — `"type": ["string", "null"]` — is not a map key.

        Handing that list to dict.get raises TypeError on the unhashable key rather
        than returning the default, so one nullable property would abort the whole
        _build_crew_tools loop instead of leaving that field untyped.
        """
        schema = _schema_of({'type': 'object', 'required': ['x'], 'properties': {'x': {'type': json_type}}})
        assert schema.model_validate({'x': 'anything'}).x == 'anything'
        assert schema.model_validate({'x': None}).x is None


def _is_typed(prop: dict) -> bool:
    """Whether a rendered property advertises a type to the model.

    Required fields carry `type` directly; optional ones render as
    `anyOf: [{type: X}, {type: null}]`, which is equally informative.
    """
    if 'type' in prop:
        return True
    return any('type' in variant for variant in prop.get('anyOf', []))


# ---------------------------------------------------------------------------
# Validation behaviour
# ---------------------------------------------------------------------------


class TestValidation:
    def test_required_stays_required(self):
        schema = _schema_of({'type': 'object', 'required': ['deal_id'], 'properties': {'deal_id': {'type': 'integer'}}})
        assert schema.model_json_schema()['required'] == ['deal_id']

    def test_the_reported_regression(self):
        """Validating {} against a schema with required fields is what produced the error."""
        schema = _schema_of({'type': 'object', 'required': ['deal_id'], 'properties': {'deal_id': {'type': 'integer'}}})
        with pytest.raises(Exception, match='deal_id'):
            schema.model_validate({})
        assert schema.model_validate({'deal_id': 7}).deal_id == 7

    def test_string_digits_coerce_to_integer(self):
        """Any blocked this: a model emitting "7" could not be repaired."""
        schema = _schema_of({'type': 'object', 'required': ['deal_id'], 'properties': {'deal_id': {'type': 'integer'}}})
        assert schema.model_validate({'deal_id': '7'}).deal_id == 7

    def test_optional_field_may_be_omitted_or_null(self):
        schema = _schema_of(
            {
                'type': 'object',
                'required': ['term'],
                'properties': {'term': {'type': 'string'}, 'limit': {'type': 'integer'}},
            }
        )
        assert schema.model_validate({'term': 'acme'}).limit is None
        assert schema.model_validate({'term': 'acme', 'limit': None}).limit is None
        assert schema.model_validate({'term': 'acme', 'limit': 5}).limit == 5

    def test_declared_default_is_preserved(self):
        schema = _schema_of({'type': 'object', 'properties': {'status': {'type': 'string', 'default': 'open'}}})
        assert schema.model_validate({}).status == 'open'

    def test_unknown_keys_are_ignored_not_rejected(self):
        schema = _schema_of({'type': 'object', 'required': ['term'], 'properties': {'term': {'type': 'string'}}})
        assert schema.model_validate({'term': 'acme', 'stray': 1}).term == 'acme'


# ---------------------------------------------------------------------------
# The argument filter CrewAI applies before validating
# ---------------------------------------------------------------------------


class TestArgumentFilterSurvival:
    """crewai/tools/tool_usage.py keeps only keys the schema declares."""

    def test_real_parameter_names_survive_the_filter(self):
        schema = _schema_of(
            {
                'type': 'object',
                'required': ['deal_id'],
                'properties': {'deal_id': {'type': 'integer'}, 'limit': {'type': 'integer'}},
            }
        )
        acceptable = schema.model_json_schema()['properties'].keys()
        emitted = {'deal_id': 7, 'limit': 5}
        assert {k: v for k, v in emitted.items() if k in acceptable} == emitted

    def test_zero_arg_tool_advertises_no_parameters(self):
        """The old fallback declared a bogus required `input` field for these."""
        for empty in ({'type': 'object', 'properties': {}}, {}, None, 'not a schema'):
            schema = _schema_of(empty)
            assert schema.model_json_schema().get('properties', {}) == {}


# ---------------------------------------------------------------------------
# Malformed descriptors must not take down the whole tool list
# ---------------------------------------------------------------------------


class TestMalformedSchemas:
    @pytest.mark.parametrize(
        'input_schema',
        [
            {'type': 'object', 'properties': 'not a dict'},
            {'type': 'object', 'properties': {'x': 'not a dict'}, 'required': ['x']},
            {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': None},
            {'type': 'object', 'properties': {'': {'type': 'string'}}},
        ],
    )
    def test_does_not_raise(self, input_schema):
        assert _schema_of(input_schema) is not None

    def test_a_bad_descriptor_does_not_drop_the_good_ones(self):
        tools = _tools(
            {
                'name': 'good',
                'description': 'ok',
                'inputSchema': {'type': 'object', 'properties': {'a': {'type': 'string'}}},
            },
            {'name': 'bad', 'description': 'broken', 'inputSchema': {'properties': 'nope'}},
        )
        assert [t.name for t in tools] == ['good', 'bad']


# ---------------------------------------------------------------------------
# Description
# ---------------------------------------------------------------------------


class TestDescription:
    def test_schema_is_not_duplicated_into_the_description(self):
        tool = _tools(
            {
                'name': 'deal_get',
                'description': 'Get a single deal by id.',
                'inputSchema': {
                    'type': 'object',
                    'required': ['deal_id'],
                    'properties': {'deal_id': {'type': 'integer'}},
                },
            }
        )[0]
        assert 'Tool input schema (JSON)' not in tool.description
        assert tool.description == 'Get a single deal by id.'

    def test_missing_description_gets_a_fallback(self):
        tool = _tools({'name': 'thing', 'inputSchema': {}})[0]
        assert tool.name in tool.description

    def test_repr_is_a_one_liner(self):
        tool = _tools({'name': 'deal_get', 'description': 'Line one.\nLine two.', 'inputSchema': {}})[0]
        assert repr(tool) == "Tool(name='deal_get', description='Line one.')"


# ---------------------------------------------------------------------------
# Forwarding
# ---------------------------------------------------------------------------


class TestForwarding:
    def test_run_forwards_validated_args_to_the_host(self):
        recorder = _Recorder()
        tool = recorder._build_crew_tools(
            context='ctx',
            tool_descriptors=[
                {
                    'name': 'deal_get',
                    'description': 'd',
                    'inputSchema': {'type': 'object', 'properties': {'deal_id': {'type': 'integer'}}},
                }
            ],
        )[0]

        assert tool._run(deal_id=7) == '{"ok": true}'
        assert recorder.calls == [{'context': 'ctx', 'name': 'deal_get', 'args': {'deal_id': 7}}]

    def test_host_errors_come_back_as_structured_output(self):
        class _Boom(_Recorder):
            def call_tool(self, context, name, args):
                raise RuntimeError('host exploded')

        tool = _Boom()._build_crew_tools(
            context='ctx', tool_descriptors=[{'name': 't', 'description': 'd', 'inputSchema': {}}]
        )[0]
        out = tool._run()
        assert 'host exploded' in out
        assert 'RuntimeError' in out
