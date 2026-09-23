"""Tests for zero-argument MCP tool handling (issue #1404).

Reasoning-model agents silently drop a tool whose input schema has no
``properties``. The MCP client now normalizes such schemas to carry a single
synthesized optional no-op field (``rr_no_args``) so strict models keep the
tool, and strips that field again before the real ``tools/call``.

Covers:
- ``normalize_tool_input_schema`` (pure) — every degenerate schema shape.
- The production invoke path — synthesized placeholders are removed, while a
  real MCP argument named ``rr_no_args`` is preserved.
- End-to-end against a stub stdio MCP server: discovery shapes + transport
  normalization.
"""

import os
import sys
import types
from pathlib import Path

import pytest

# Import the node modules the same way the sibling test_sse_redirect.py does:
# add the node source dir to sys.path and import the transport standalone.
_NODE_SRC = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'tool_mcp_client')
sys.path.insert(0, _NODE_SRC)


def _ensure_iglobal_import_stubs():
    """Provide the minimal engine imports required by the real IGlobal module."""
    rocketlib = sys.modules.get('rocketlib') or types.ModuleType('rocketlib')
    if not hasattr(rocketlib, 'IGlobalBase'):
        rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    if not hasattr(rocketlib, 'IInstanceBase'):
        rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    if not hasattr(rocketlib, 'OPEN_MODE'):
        rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    if not hasattr(rocketlib, 'warning'):
        rocketlib.warning = lambda *_args, **_kwargs: None
    sys.modules['rocketlib'] = rocketlib

    for name in ('ai', 'ai.common', 'ai.common.config'):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    if not hasattr(sys.modules['ai.common.config'], 'Config'):

        class _Config:
            @staticmethod
            def getNodeConfig(*_args, **_kwargs):
                return {}

        sys.modules['ai.common.config'].Config = _Config

    if 'tool_mcp_client' not in sys.modules:
        package = types.ModuleType('tool_mcp_client')
        package.__path__ = [str(Path(_NODE_SRC).resolve())]
        sys.modules['tool_mcp_client'] = package


_ensure_iglobal_import_stubs()

from tool_mcp_client.IGlobal import IGlobal  # noqa: E402
from tool_mcp_client.IInstance import IInstance  # noqa: E402
from tool_mcp_client.mcp_schema import NOOP_ARG_NAME, normalize_tool_input_schema, strip_synthesized_args  # noqa: E402
from tool_mcp_client.mcp_stdio_client import McpStdioClient, McpToolDef  # noqa: E402

STUB_SERVER = os.path.join(os.path.dirname(__file__), 'stub_mcp_server.py')


# ---------------------------------------------------------------------------
# normalize_tool_input_schema — pure unit tests
# ---------------------------------------------------------------------------


class TestNormalizeSchema:
    def _assert_synthesized(self, schema):
        props = schema.get('properties')
        assert isinstance(props, dict)
        assert list(props.keys()) == [NOOP_ARG_NAME]
        assert props[NOOP_ARG_NAME]['type'] == 'string'
        assert schema['type'] == 'object'
        assert schema.get('required') == []

    def test_none_is_synthesized(self):
        self._assert_synthesized(normalize_tool_input_schema(None))

    def test_non_dict_is_synthesized(self):
        self._assert_synthesized(normalize_tool_input_schema('not-a-schema'))
        self._assert_synthesized(normalize_tool_input_schema(123))

    def test_bare_object_is_synthesized(self):
        # The exact shape the transports used to default to.
        self._assert_synthesized(normalize_tool_input_schema({'type': 'object'}))

    def test_explicit_empty_properties_is_synthesized(self):
        self._assert_synthesized(normalize_tool_input_schema({'type': 'object', 'properties': {}, 'required': []}))

    def test_non_empty_properties_passes_through_unchanged(self):
        original = {
            'type': 'object',
            'properties': {'msg': {'type': 'string'}},
            'required': ['msg'],
        }
        result = normalize_tool_input_schema(original)
        assert result is original  # untouched, same object
        assert NOOP_ARG_NAME not in result['properties']

    def test_preserves_extra_schema_keys(self):
        result = normalize_tool_input_schema({'type': 'object', 'title': 'Foo', 'description': 'bar'})
        assert result['title'] == 'Foo'
        assert result['description'] == 'bar'
        self._assert_synthesized(result)


# ---------------------------------------------------------------------------
# strip_synthesized_args — pure unit tests
# ---------------------------------------------------------------------------


class TestStripSynthesizedArgs:
    def test_strips_noop_key(self):
        assert strip_synthesized_args({NOOP_ARG_NAME: 'whatever', 'a': 1}) == {'a': 1}

    def test_strips_when_only_noop(self):
        assert strip_synthesized_args({NOOP_ARG_NAME: ''}) == {}

    def test_leaves_real_args_untouched(self):
        args = {'a': 1, 'b': 2}
        assert strip_synthesized_args(args) == {'a': 1, 'b': 2}

    def test_empty_dict_unchanged(self):
        assert strip_synthesized_args({}) == {}

    def test_non_dict_unchanged(self):
        assert strip_synthesized_args(None) is None
        assert strip_synthesized_args('x') == 'x'


# ---------------------------------------------------------------------------
# IGlobal cached-descriptor contract — server-free production path
# ---------------------------------------------------------------------------


def test_list_namespaced_tools_emits_cached_schema_under_camel_case_key():
    """The production cache accessor exposes the MCP schema as ``inputSchema``."""
    schema = {
        'type': 'object',
        'properties': {'query': {'type': 'string'}},
        'required': ['query'],
    }
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.serverName = 'cached'
    iglobal._cache_tools([McpToolDef(name='search', description='Search documents', inputSchema=schema)])

    [descriptor] = iglobal.list_namespaced_tools()

    assert descriptor['name'] == 'cached.search'
    assert descriptor['description'] == 'Search documents'
    assert descriptor['inputSchema'] is schema
    assert descriptor['inputSchema'] == schema
    assert 'input_schema' not in descriptor


class _RecordingClient:
    def __init__(self):
        self.calls = []

    def call_tool(self, *, name, arguments):
        self.calls.append((name, arguments))
        return {'received_arguments': arguments}


def _instance_with_cached_tool(tool):
    client = _RecordingClient()
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.serverName = 'cached'
    iglobal._client = client
    iglobal._cache_tools([tool])
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = iglobal
    return instance, client


def test_invoke_strips_synthesized_noop_argument_before_tools_call():
    instance, client = _instance_with_cached_tool(
        McpToolDef(
            name='zero_arg',
            description='',
            inputSchema=normalize_tool_input_schema(None),
            has_synthesized_noop_arg=True,
        )
    )

    result = instance._tool_invoke_dynamic(tool_name='cached.zero_arg', input_obj={NOOP_ARG_NAME: 'ignored'})

    assert result['received_arguments'] == {}
    assert client.calls == [('zero_arg', {})]


def test_invoke_preserves_real_rr_no_args_argument_before_tools_call():
    schema = {
        'type': 'object',
        'properties': {NOOP_ARG_NAME: {'type': 'string'}},
        'required': [NOOP_ARG_NAME],
    }
    instance, client = _instance_with_cached_tool(
        McpToolDef(name='real_rr_no_args', description='', inputSchema=schema)
    )

    result = instance._tool_invoke_dynamic(
        tool_name='cached.real_rr_no_args', input_obj={NOOP_ARG_NAME: 'forward this'}
    )

    assert result['received_arguments'] == {NOOP_ARG_NAME: 'forward this'}
    assert client.calls == [('real_rr_no_args', {NOOP_ARG_NAME: 'forward this'})]


# ---------------------------------------------------------------------------
# End-to-end against the stub stdio MCP server
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    c = McpStdioClient(command=sys.executable, args=[STUB_SERVER], timeout_s=10.0)
    c.start()
    try:
        yield c
    finally:
        c.stop()


class TestStubIntegration:
    def test_zero_arg_tools_get_nonempty_properties(self, client):
        tools = {t.name: t for t in client.list_tools()}
        assert set(tools) == {'no_schema_tool', 'empty_props_tool', 'echo_tool'}

        # Both zero-argument shapes are normalized to a non-empty properties map
        # carrying the synthesized no-op field.
        for name in ('no_schema_tool', 'empty_props_tool'):
            props = tools[name].inputSchema.get('properties')
            assert isinstance(props, dict) and props, f'{name} still has empty properties'
            assert NOOP_ARG_NAME in props, f'{name} missing synthesized arg'
            assert tools[name].has_synthesized_noop_arg

    def test_real_arg_tool_schema_untouched(self, client):
        tools = {t.name: t for t in client.list_tools()}
        echo = tools['echo_tool'].inputSchema
        assert set(echo['properties']) == {'msg'}
        assert NOOP_ARG_NAME not in echo['properties']
        assert not tools['echo_tool'].has_synthesized_noop_arg

    def test_synthesized_arg_never_reaches_server(self, client):
        # Exercise the transport with the exact arguments the production invoke
        # path sends after it removes the presentation-only no-op field.
        model_args = strip_synthesized_args({NOOP_ARG_NAME: 'ignored'})
        result = client.call_tool(name='no_schema_tool', arguments=model_args)
        assert result['received_arguments'] == {}

    def test_empty_call_succeeds(self, client):
        result = client.call_tool(name='empty_props_tool', arguments={})
        assert result['received_arguments'] == {}

    def test_real_args_pass_through(self, client):
        result = client.call_tool(name='echo_tool', arguments={'msg': 'hi'})
        assert result['received_arguments'] == {'msg': 'hi'}
