# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for #1404: reasoning-model agents silently drop
zero-argument MCP tools.

Two independent defects combined to cause this:

1. `tool_mcp_client.IGlobal.list_namespaced_tools()` returned the tool's JSON
   schema under the key `input_schema` (snake_case), but the canonical
   `ToolsBase.ToolDescriptor` contract (and every driver that reads it, e.g.
   `agent_langchain`) expects `inputSchema` (camelCase). The mismatch meant
   `td.get('inputSchema')` always returned `None` for MCP-sourced tools,
   discarding the real schema before it ever reached the driver.

2. `agent_langchain.langchain._make_args_schema` treated "no schema info at
   all" and "schema explicitly declares zero properties" as the same case,
   falling back to the permissive `_ToolInput` (which advertises a generic
   `input` field) for both. A genuinely zero-argument tool therefore looked
   to the model like it required an `input` argument, which is what caused
   reasoning models to either skip the tool or call it with an argument the
   MCP server didn't expect and rejected.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Dict, List

import pytest

_NODES_ROOT = Path(__file__).resolve().parent.parent.parent
_REPO_ROOT = _NODES_ROOT.parent


def _install_common_stubs() -> None:
    """Stub `rocketlib` (native engine binding, not pip-installable outside
    RocketRide's own build) with just enough surface for `ai.common.*` and
    the node modules under test to import.
    """
    if 'rocketlib' in sys.modules:
        return

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *_a, **_k: None
    sys.modules['depends'] = depends_mod

    rocketlib_mod = types.ModuleType('rocketlib')

    class _IGlobalBase:
        pass

    class _IInstanceBase:
        pass

    class _IJson(dict):
        @staticmethod
        def toDict(obj):
            return dict(obj)

    class _OpenMode:
        CONFIG = 'CONFIG'
        RUN = 'RUN'

    rocketlib_mod.IGlobalBase = _IGlobalBase
    rocketlib_mod.IInstanceBase = _IInstanceBase
    rocketlib_mod.IJson = _IJson
    rocketlib_mod.OPEN_MODE = _OpenMode
    rocketlib_mod.ToolDescriptor = dict
    rocketlib_mod.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib_mod.getServiceDefinition = lambda *_a, **_k: {}
    rocketlib_mod.warning = lambda *_a, **_k: None
    rocketlib_mod.debug = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib_mod


def _install_agent_stubs() -> None:
    """Stub `ai.common.agent` / `ai.common.agent.types`.

    `agent_langchain.langchain` only uses `AgentBase`/`AgentContext`/
    `AgentRunResult` as type hints and as the base class its own driver
    subclasses — none of that is exercised by `_build_langchain_tools`, which
    is what these tests call. Real `ai.common.schema` (backed by the actual
    published `rocketride` package) and real `ai.common.utils` are used as-is.
    """
    if 'ai.common.agent' in sys.modules:
        return

    ai_common_agent = types.ModuleType('ai.common.agent')

    class _AgentBase:
        def __init__(self, *_a, **_k):
            pass

    class _AgentContext:
        pass

    ai_common_agent.AgentBase = _AgentBase
    ai_common_agent.AgentContext = _AgentContext
    sys.modules['ai.common.agent'] = ai_common_agent

    ai_common_agent_types = types.ModuleType('ai.common.agent.types')
    ai_common_agent_types.AgentRunResult = tuple
    sys.modules['ai.common.agent.types'] = ai_common_agent_types


def _load_langchain_module():
    ai_src = _REPO_ROOT / 'packages' / 'ai' / 'src'
    if str(ai_src) not in sys.path:
        sys.path.insert(0, str(ai_src))

    _install_common_stubs()
    _install_agent_stubs()

    import importlib.util

    langchain_py = _NODES_ROOT / 'src' / 'nodes' / 'agent_langchain' / 'langchain.py'
    spec = importlib.util.spec_from_file_location('agent_langchain_under_test', langchain_py)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_igloal_class():
    ai_src = _REPO_ROOT / 'packages' / 'ai' / 'src'
    if str(ai_src) not in sys.path:
        sys.path.insert(0, str(ai_src))

    _install_common_stubs()

    # IGlobal.py uses relative imports (`from .mcp_stdio_client import ...`),
    # so it must be loaded as a real package member, not via
    # spec_from_file_location on the bare file.
    nodes_src = _NODES_ROOT / 'src' / 'nodes'
    if str(nodes_src) not in sys.path:
        sys.path.insert(0, str(nodes_src))

    import importlib

    module = importlib.import_module('tool_mcp_client.IGlobal')
    return module.IGlobal


class _FakeMcpTool:
    def __init__(self, name: str, description: str, inputSchema: Dict[str, Any]):
        self.name = name
        self.description = description
        self.inputSchema = inputSchema


class TestListNamespacedToolsSchemaKey:
    """#1404 part 1: the produced dict must use `inputSchema`, not `input_schema`."""

    def test_zero_arg_tool_schema_key_is_camel_case(self):
        IGlobal = _load_igloal_class()
        glb = IGlobal.__new__(IGlobal)
        glb.serverName = 'myserver'
        glb._tools_by_namespaced = {
            'myserver.list_open_issues': _FakeMcpTool(
                name='list_open_issues',
                description='List open issues',
                inputSchema={'type': 'object', 'properties': {}},
            )
        }

        out = glb.list_namespaced_tools()

        assert len(out) == 1
        assert 'inputSchema' in out[0], 'schema must be exposed under the canonical camelCase key'
        assert 'input_schema' not in out[0]
        assert out[0]['inputSchema'] == {'type': 'object', 'properties': {}}

    def test_tool_with_parameters_schema_key_is_also_camel_case(self):
        IGlobal = _load_igloal_class()
        glb = IGlobal.__new__(IGlobal)
        glb.serverName = 'myserver'
        glb._tools_by_namespaced = {
            'myserver.search': _FakeMcpTool(
                name='search',
                description='Search issues',
                inputSchema={'type': 'object', 'properties': {'query': {'type': 'string'}}},
            )
        }

        out = glb.list_namespaced_tools()

        assert out[0]['inputSchema']['properties'] == {'query': {'type': 'string'}}


class TestMakeArgsSchemaZeroArgTools:
    """#1404 part 2: a tool with an explicit empty-properties schema must get
    a strict, argument-free schema — not the generic permissive fallback.
    """

    def _build_tools(self, tool_descriptors: List[Dict[str, Any]]):
        module = _load_langchain_module()

        class _FakeAgentBase:
            def call_tool(self, context, name, args):
                return {}

        return module._build_langchain_tools(_FakeAgentBase(), object(), tool_descriptors)

    def test_zero_arg_tool_gets_strict_empty_schema_not_generic_input_field(self):
        tools = self._build_tools(
            [
                {
                    'name': 'list_open_issues',
                    'description': 'List issues',
                    'inputSchema': {'type': 'object', 'properties': {}},
                }
            ]
        )
        assert len(tools) == 1
        schema_cls = tools[0].args_schema
        json_schema = schema_cls.model_json_schema()

        # The bug: this used to be `_ToolInput`, whose schema advertises a
        # generic `input` field — making a genuinely no-argument tool look
        # like it requires one.
        assert json_schema.get('properties', {}) == {}, (
            f'zero-argument tool schema must have no properties, got {json_schema.get("properties")}'
        )

    def test_schema_missing_properties_key_is_unconstrained_not_zero_arg(self):
        """`{"type": "object"}` (no `properties` key at all) means "any object
        shape", not "zero arguments" -- it must NOT collapse to the same
        no-args schema as an explicit `"properties": {}`. Regression for a
        review finding: `input_schema.get('properties', {})` treated a missing
        key the same as an explicitly empty one.
        """
        tools = self._build_tools(
            [
                {
                    'name': 'unconstrained_tool',
                    'description': 'no properties key at all',
                    'inputSchema': {'type': 'object'},
                }
            ]
        )
        schema_cls = tools[0].args_schema
        assert 'input' in schema_cls.model_fields
        assert schema_cls.model_config.get('extra') == 'allow'

    def test_zero_arg_tool_schema_rejects_extra_args(self):
        tools = self._build_tools(
            [
                {
                    'name': 'list_open_issues',
                    'description': 'List issues',
                    'inputSchema': {'type': 'object', 'properties': {}},
                }
            ]
        )
        schema_cls = tools[0].args_schema
        with pytest.raises(Exception):
            schema_cls(input='unexpected')

    def test_tool_with_real_params_still_gets_named_fields(self):
        tools = self._build_tools(
            [
                {
                    'name': 'search',
                    'description': 'Search issues',
                    'inputSchema': {
                        'type': 'object',
                        'properties': {'query': {'type': 'string', 'description': 'search text'}},
                        'required': ['query'],
                    },
                }
            ]
        )
        schema_cls = tools[0].args_schema
        json_schema = schema_cls.model_json_schema()
        assert 'query' in json_schema.get('properties', {})

    def test_tool_with_no_schema_info_falls_back_to_permissive_input_field(self):
        """No schema info at all (e.g. a non-MCP tool source) is a different
        case from an explicit empty schema and should keep the permissive
        fallback so arbitrary args still get through.

        Checked via `model_fields` rather than `model_json_schema()`: this
        particular fallback class (`_ToolInput`, pre-existing/untouched by
        this fix) uses a bare `Any` annotation that pydantic can't always
        re-resolve when the class is loaded via a synthetic module spec, which
        is a test-harness artifact unrelated to the behavior under test.
        """
        tools = self._build_tools([{'name': 'legacy_tool', 'description': 'no schema known'}])
        schema_cls = tools[0].args_schema
        assert 'input' in schema_cls.model_fields
        assert schema_cls.model_config.get('extra') == 'allow'
