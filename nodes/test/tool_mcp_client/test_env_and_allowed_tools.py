"""Tests for the MCP client's environment variables and allowed-tools list.

- ``env`` (stdio transport) reaches the server process, so a server that reads
  its API key from the environment can be configured in the node.
- ``allowedTools`` limits the tools the agent sees; a call to any other tool
  is refused as unknown and never sent to the server.

The parsing and filtering tests use a scripted client; the ``beginGlobal``
tests launch ``stub_mcp_server.py`` over stdio.
"""

import json
import os
import sys
import types
from pathlib import Path

import pytest

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


_CORE_STUBS = ('rocketlib', 'ai', 'ai.common', 'ai.common.config')
_saved_core = {_name: sys.modules.get(_name) for _name in _CORE_STUBS}
_ensure_iglobal_import_stubs()
try:
    from tool_mcp_client import IGlobal as iglobal_module  # noqa: E402
    from tool_mcp_client.IGlobal import IGlobal, ToolUnavailableError, parse_allowed_tools  # noqa: E402
    from tool_mcp_client.mcp_stdio_client import McpToolDef  # noqa: E402
finally:
    for _name, _mod in _saved_core.items():
        if _mod is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _mod

STUB_SERVER = os.path.join(os.path.dirname(__file__), 'stub_mcp_server.py')


def _tool(name):
    return McpToolDef(name=name, description=f'{name} description', inputSchema={'type': 'object', 'properties': {}})


class _ScriptedClient:
    def __init__(self, tools):
        self._tools = list(tools)
        self.calls = []

    def list_tools(self):
        return list(self._tools)

    def call_tool(self, *, name, arguments):
        self.calls.append((name, arguments))
        return {'content': [{'type': 'text', 'text': f'called {name}'}]}


class _EngineJson:
    """Stand-in for an engine JSON array, which prints as its JSON text."""

    def __init__(self, value):
        self._value = value

    def __str__(self):
        return json.dumps(self._value)


# ---------------------------------------------------------------------------
# parse_allowed_tools
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('raw', [None, '', [], [{'toolName': ' '}], '  ,  '])
def test_no_names_allows_every_tool(raw):
    assert parse_allowed_tools(raw) is None


@pytest.mark.parametrize(
    'raw',
    [
        [{'toolName': 'search'}, {'toolName': 'fetch '}],
        ['search', 'fetch'],
        'search, fetch',
        'search\nfetch\n',
        '[{"toolName": "search"}, {"toolName": "fetch"}]',
        _EngineJson([{'toolName': 'search'}, {'toolName': 'fetch'}]),
    ],
)
def test_names_are_read_from_every_config_shape(raw):
    assert parse_allowed_tools(raw) == {'search', 'fetch'}


@pytest.mark.parametrize('raw', ['[not json', '{"toolName": "search"}', 42])
def test_malformed_allowed_tools_raise(raw):
    with pytest.raises(ValueError):
        parse_allowed_tools(raw)


# ---------------------------------------------------------------------------
# Filtering the catalog
# ---------------------------------------------------------------------------


def _iglobal(client, allowed):
    g = IGlobal.__new__(IGlobal)
    g.serverName = 'srv'
    g._client = client
    g._allowed_tools = allowed
    g._cache_tools(client.list_tools())
    return g


def test_only_allowed_tools_reach_the_agent():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client, {'search'})
    assert [t['name'] for t in g.list_namespaced_tools()] == ['srv.search']


def test_a_call_to_a_tool_outside_the_list_is_refused_and_not_sent():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client, {'search'})
    with pytest.raises(ToolUnavailableError, match="known tools: \\['search'\\]"):
        g.call_tool(server_name='srv', tool_name='delete_repo', arguments={})
    assert client.calls == []
    g.call_tool(server_name='srv', tool_name='search', arguments={'q': 'x'})
    assert client.calls == [('search', {'q': 'x'})]


def test_a_refreshed_catalog_keeps_the_filter():
    client = _ScriptedClient([_tool('search')])
    g = _iglobal(client, {'search', 'fetch'})
    client._tools = [_tool('search'), _tool('fetch'), _tool('delete_repo')]
    assert g.refresh_tools(reason='test')
    assert sorted(g._tools_by_original) == ['fetch', 'search']


def test_without_a_list_every_tool_is_exposed():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client, None)
    assert sorted(g._tools_by_original) == ['delete_repo', 'search']


# ---------------------------------------------------------------------------
# beginGlobal against the stub stdio server
# ---------------------------------------------------------------------------


def _begin(monkeypatch, cfg):
    """Run beginGlobal with ``cfg`` as the node config; return (IGlobal, warnings)."""
    warnings = []
    monkeypatch.setattr(iglobal_module, 'warning', warnings.append)
    monkeypatch.setattr(iglobal_module.Config, 'getNodeConfig', staticmethod(lambda *_a, **_k: cfg), raising=False)
    g = IGlobal()
    g.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    g.glb = types.SimpleNamespace(logicalType='mcp_client', connConfig={})
    g.beginGlobal()
    return g, warnings


def _stdio_cfg(**stdio):
    return {
        'serverName': 'stub',
        'transport': 'stdio',
        'stdio': {'commandLine': f'"{sys.executable}" "{STUB_SERVER}"', **stdio},
    }


def test_env_reaches_the_stdio_server(monkeypatch, tmp_path):
    # The stub server serves the tools listed in the file its
    # STUB_MCP_TOOLS_FILE environment variable names, so seeing those tools
    # proves the variable reached the process.
    monkeypatch.delenv('STUB_MCP_TOOLS_FILE', raising=False)
    tools_file = tmp_path / 'tools.json'
    tools_file.write_text(json.dumps([{'name': 'from_env', 'description': 'd', 'inputSchema': {'type': 'object'}}]))

    g, _ = _begin(monkeypatch, _stdio_cfg(env={'STUB_MCP_TOOLS_FILE': str(tools_file)}))
    try:
        assert sorted(g._tools_by_original) == ['from_env']
    finally:
        g.endGlobal()


def test_allowed_tools_filter_the_server_catalog_and_name_missing_tools(monkeypatch):
    monkeypatch.delenv('STUB_MCP_TOOLS_FILE', raising=False)
    cfg = _stdio_cfg()
    cfg['allowedTools'] = [{'toolName': 'echo_tool'}, {'toolName': 'typo_tool'}]

    g, warnings = _begin(monkeypatch, cfg)
    try:
        assert sorted(g._tools_by_original) == ['echo_tool']
        assert any("allowed tools not on the server: ['typo_tool']" in w for w in warnings)
    finally:
        g.endGlobal()


def test_env_must_be_a_mapping(monkeypatch):
    with pytest.raises(Exception, match='env must be a dictionary'):
        _begin(monkeypatch, _stdio_cfg(env='TOKEN=abc'))
