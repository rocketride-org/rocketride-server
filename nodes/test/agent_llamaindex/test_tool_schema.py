# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""The real ReAct formatter must publish the host tool's actual argument schema."""

import json

from llama_index.core.agent.react.formatter import get_react_tool_descriptions

from nodes.agent_llamaindex.llamaindex import _build_tools


def test_react_tool_args_preserve_host_schema():
    schema = {
        'type': 'object',
        'properties': {'key': {'type': 'string'}, 'amount': {'type': 'string', 'default': '1'}},
        'required': ['key'],
        'additionalProperties': False,
    }
    tool = _build_tools([{'name': 'redis_1.redis_incr', 'description': 'Increment a counter.', 'inputSchema': schema}])[
        0
    ]
    assert tool.metadata.get_parameters_dict() == schema
    rendered = get_react_tool_descriptions([tool])[0]
    assert json.loads(rendered.split('Tool Args: ', 1)[1]) == schema


def test_each_tool_keeps_its_own_nested_schema():
    schemas = [
        {
            'type': 'object',
            'properties': {'keys': {'type': 'array', 'items': {'type': 'string'}}},
            'required': ['keys'],
        },
        {'type': 'object', 'properties': {'cursor': {'type': 'string', 'pattern': '^[0-9]+$'}}},
    ]
    tools = _build_tools([{'name': name, 'inputSchema': schema} for name, schema in zip(['delete', 'scan'], schemas)])
    assert [tool.metadata.get_parameters_dict() for tool in tools] == schemas


def test_tool_metadata_does_not_share_mutable_schema_with_caller():
    schema = {'type': 'object', 'properties': {'key': {'type': 'string'}}}
    tool = _build_tools([{'name': 'get', 'inputSchema': schema}])[0]
    schema['properties'].clear()
    assert 'key' in tool.metadata.get_parameters_dict()['properties']
    returned = tool.metadata.get_parameters_dict()
    returned['properties'].clear()
    assert 'key' in tool.metadata.get_parameters_dict()['properties']


def test_tool_without_schema_still_advertises_an_empty_object():
    tool = _build_tools([{'name': 'no_args'}])[0]
    assert tool.metadata.get_parameters_dict().get('properties') == {}
