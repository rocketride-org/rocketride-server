"""Tests for the MCP client's environment variables and allowed-tools list.

- ``env`` (stdio transport) reaches the server process, so a server that reads
  its API key from the environment can be configured in the node.
- ``allowedTools`` limits the tools the agent sees; a call to any other tool
  is refused as unknown and never sent to the server. It is a per-call
  parameter: the instance reads it from the call's settings and the control's
  cached catalog stays whole.

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

    for name in ('ai', 'ai.common'):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

    if 'tool_mcp_client' not in sys.modules:
        package = types.ModuleType('tool_mcp_client')
        package.__path__ = [str(Path(_NODE_SRC).resolve())]
        sys.modules['tool_mcp_client'] = package


_CORE_STUBS = ('rocketlib', 'ai', 'ai.common')
_saved_core = {_name: sys.modules.get(_name) for _name in _CORE_STUBS}
_ensure_iglobal_import_stubs()
try:
    from tool_mcp_client import IGlobal as iglobal_module  # noqa: E402
    from tool_mcp_client.IGlobal import IGlobal, ToolUnavailableError, parse_allowed_tools  # noqa: E402
    from tool_mcp_client.IInstance import IInstance  # noqa: E402
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
        self.list_calls = 0

    def list_tools(self):
        self.list_calls += 1
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


@pytest.mark.parametrize('raw', [None, '', [], [{'toolName': ' '}], [{}], '  ,  '])
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


@pytest.mark.parametrize(
    'raw', ['[not json', '{"toolName": "search"}', 42, [{'name': 'search'}], [{'toolName': 'a'}, {'tool': 'b'}]]
)
def test_malformed_allowed_tools_raise(raw):
    with pytest.raises(ValueError):
        parse_allowed_tools(raw)


@pytest.mark.parametrize(
    'raw',
    [
        [False],
        [0],
        [None],
        [['search']],
        [{'toolName': False}],
        [{'toolName': 0}],
        [{'toolName': 'search'}, False],
        '[false]',
        '[{"toolName": 0}]',
        _EngineJson([{'toolName': False}]),
    ],
)
def test_an_entry_that_is_not_a_tool_name_raises_instead_of_allowing_every_tool(raw):
    # Dropping such an entry could leave the list empty, and an empty list
    # exposes every tool: the parser must fail closed
    with pytest.raises(ValueError):
        parse_allowed_tools(raw)


@pytest.mark.parametrize('raw', [['', ' '], [{}, {'toolName': ''}, ''], '[{}]', '[""]'])
def test_blank_entries_and_rows_still_allow_every_tool(raw):
    assert parse_allowed_tools(raw) is None


# ---------------------------------------------------------------------------
# Filtering the catalog
# ---------------------------------------------------------------------------


def _iglobal(client):
    """An IGlobal as ``beginGlobal`` leaves it: connected client + the whole cached catalog."""
    g = IGlobal.__new__(IGlobal)
    g._client = client
    g._cache_tools(client.list_tools())
    return g


def test_only_allowed_tools_reach_the_agent():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client)
    assert [t['name'] for t in g.list_namespaced_tools('srv', {'search'})] == ['srv.search']


def test_a_call_to_a_tool_outside_the_list_is_refused_and_not_sent():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client)
    with pytest.raises(ToolUnavailableError, match="known tools: \\['search'\\]"):
        g.call_tool(server_name='srv', tool_name='delete_repo', arguments={}, allowed={'search'})
    assert client.calls == []
    g.call_tool(server_name='srv', tool_name='search', arguments={'q': 'x'}, allowed={'search'})
    assert client.calls == [('search', {'q': 'x'})]


def test_a_name_outside_the_list_is_refused_without_refreshing_the_catalog():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client)
    allowed = {'search', 'fetch'}
    g._catalog_fetched_at = None  # stale, so a lookup miss may refresh
    before = client.list_calls
    with pytest.raises(ToolUnavailableError):
        g.call_tool(server_name='srv', tool_name='delete_repo', arguments={}, allowed=allowed)
    assert client.list_calls == before
    # An allowed name the server adds later is still found by refreshing.
    client._tools.append(_tool('fetch'))
    g.call_tool(server_name='srv', tool_name='fetch', arguments={}, allowed=allowed)
    assert client.list_calls == before + 1
    assert client.calls == [('fetch', {})]


def test_a_refreshed_catalog_keeps_the_filter():
    client = _ScriptedClient([_tool('search')])
    g = _iglobal(client)
    client._tools = [_tool('search'), _tool('fetch'), _tool('delete_repo')]
    assert g.refresh_tools(reason='test')
    # The control caches the whole catalog; each call's list filters it
    assert sorted(g._tools_by_original) == ['delete_repo', 'fetch', 'search']
    assert sorted(t['name'] for t in g.list_namespaced_tools('srv', {'search', 'fetch'})) == ['srv.fetch', 'srv.search']


def test_without_a_list_every_tool_is_exposed():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client)
    assert sorted(t['name'] for t in g.list_namespaced_tools('srv', None)) == ['srv.delete_repo', 'srv.search']


# ---------------------------------------------------------------------------
# The call's allow list, read from its settings
# ---------------------------------------------------------------------------


def _instance(g, **settings):
    """One call's instance on control ``g``, with ``settings`` as the call's settings."""
    inst = type('IInstanceUnderTest', (IInstance,), {'settings': None})()
    inst.IGlobal = g
    inst.settings = types.SimpleNamespace(serverName='srv', **settings)
    return inst


def test_each_call_applies_its_own_allow_list_to_one_control():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    g = _iglobal(client)
    reader = _instance(g, allowedTools=[{'toolName': 'search'}])
    admin = _instance(g, allowedTools=None)

    assert [t['name'] for t in reader._tool_query_dynamic()] == ['srv.search']
    assert sorted(t['name'] for t in admin._tool_query_dynamic()) == ['srv.delete_repo', 'srv.search']

    with pytest.raises(ToolUnavailableError):
        reader._tool_invoke_dynamic(tool_name='srv.delete_repo', input_obj={})
    assert client.calls == []
    admin._tool_invoke_dynamic(tool_name='srv.delete_repo', input_obj={})
    assert client.calls == [('delete_repo', {})]


def test_settings_without_an_allow_list_expose_every_tool():
    # The Butterbase preset declares no allowedTools, so its settings have no such key
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    inst = _instance(_iglobal(client))
    assert sorted(t['name'] for t in inst._tool_query_dynamic()) == ['srv.delete_repo', 'srv.search']


def test_a_malformed_allow_list_fails_the_call():
    inst = _instance(_iglobal(_ScriptedClient([_tool('search')])), allowedTools=[{'tool': 'search'}])
    with pytest.raises(ValueError, match='has no toolName'):
        inst._tool_query_dynamic()


def test_an_allow_list_of_non_names_fails_the_call_and_exposes_no_tool():
    client = _ScriptedClient([_tool('search'), _tool('delete_repo')])
    inst = _instance(_iglobal(client), allowedTools=[{'toolName': False}])
    with pytest.raises(ValueError, match='toolName'):
        inst._tool_query_dynamic()
    with pytest.raises(ValueError, match='toolName'):
        inst._tool_invoke_dynamic(tool_name='srv.delete_repo', input_obj={})
    assert client.calls == []


# ---------------------------------------------------------------------------
# beginGlobal against the stub stdio server
# ---------------------------------------------------------------------------


class _ResolvedConfig(dict):
    """A control's resolved config as the node reads it: the active branch flattened, item and attribute access."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as e:
            raise AttributeError(name) from e


def _begin(monkeypatch, cfg):
    """Run beginGlobal with ``cfg`` as the control's resolved config; return (IGlobal, warnings)."""
    warnings = []
    monkeypatch.setattr(iglobal_module, 'warning', warnings.append)
    g = type('IGlobalUnderTest', (IGlobal,), {'config': None})()
    g.config = _ResolvedConfig(cfg)
    g.beginGlobal()
    return g, warnings


def _stdio_cfg(**stdio):
    # The stdio branch flattened in; serverName and allowedTools are per call, never config
    return {
        'transport': 'stdio',
        'commandLine': f'"{sys.executable}" "{STUB_SERVER}"',
        'env': {},
        **stdio,
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

    g, warnings = _begin(monkeypatch, _stdio_cfg())
    try:
        # The control caches every server tool; the call's list narrows what it sees
        assert sorted(g._tools_by_original) == ['echo_tool', 'empty_props_tool', 'no_schema_tool']
        inst = _instance(g, allowedTools=[{'toolName': 'echo_tool'}, {'toolName': 'typo_tool'}])
        assert [t['name'] for t in inst._tool_query_dynamic()] == ['srv.echo_tool']
        assert any("allowed tools not on the server: ['typo_tool']" in w for w in warnings)
    finally:
        g.endGlobal()


def test_env_must_be_a_mapping(monkeypatch):
    with pytest.raises(Exception, match='env must be a dictionary'):
        _begin(monkeypatch, _stdio_cfg(env='TOKEN=abc'))
