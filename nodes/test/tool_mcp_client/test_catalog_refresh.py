"""Catalog-staleness tests for tool_mcp_client (issue #1402).

Before this change the MCP tool catalog was fetched once in ``beginGlobal()``
and never re-read, so a tool added or renamed on a running server was invisible
until the engine restarted — and a lookup miss surfaced as the server's own
"not found", which a weak planner narrates around.

These tests pin the new contract:

- a lookup miss refreshes the catalog once (rate-limited) and retries;
- a tool that is still unknown after the refresh raises ``ToolUnavailableError``
  and is never sent to the server;
- discovery queries re-read the server, rate-limited by ``REFRESH_MIN_INTERVAL_S``;
- a failed refresh keeps the previous catalog and warns; a changed catalog
  warns with the added/removed names;
- the cache swap is atomic for concurrent readers.

The first part is server-free (a scripted client); the last part drives the
real stdio transport against ``stub_mcp_server.py`` with a tool added while
the server keeps running.
"""

import json
import os
import sys
import threading
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


# Stub engine-only deps just long enough to import the node, then restore
# sys.modules so the stubs never leak to sibling tests (see _sys_modules_guard).
_CORE_STUBS = ('rocketlib', 'ai', 'ai.common', 'ai.common.config')
_saved_core = {_name: sys.modules.get(_name) for _name in _CORE_STUBS}
_ensure_iglobal_import_stubs()
try:
    from tool_mcp_client import IGlobal as iglobal_module  # noqa: E402
    from tool_mcp_client.IGlobal import (  # noqa: E402
        REFRESH_MIN_INTERVAL_S,
        IGlobal,
        ToolUnavailableError,
    )
    from tool_mcp_client.IInstance import IInstance  # noqa: E402
    from tool_mcp_client.mcp_stdio_client import McpStdioClient, McpToolDef  # noqa: E402
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
    """A connected MCP client whose successive ``list_tools()`` answers are scripted."""

    def __init__(self, *catalogs):
        self._catalogs = [list(c) for c in catalogs]
        self.list_calls = 0
        self.calls = []

    def list_tools(self):
        self.list_calls += 1
        if self.list_calls <= len(self._catalogs):
            return self._catalogs[self.list_calls - 1]
        return self._catalogs[-1]

    def call_tool(self, *, name, arguments):
        self.calls.append((name, arguments))
        return {'content': [{'type': 'text', 'text': f'called {name}'}]}


class _FailingClient(_ScriptedClient):
    def list_tools(self):
        self.list_calls += 1
        raise RuntimeError('server went away')


def _iglobal(client, *initial):
    """An IGlobal as ``beginGlobal`` leaves it: connected client + cached catalog."""
    g = IGlobal.__new__(IGlobal)
    g.serverName = 'srv'
    g._client = client
    g._cache_tools(list(initial))
    return g


@pytest.fixture
def clock(monkeypatch):
    """Controllable ``time.monotonic`` for the IGlobal module."""
    now = [1000.0]
    monkeypatch.setattr(iglobal_module.time, 'monotonic', lambda: now[0])
    return now


@pytest.fixture
def warnings(monkeypatch):
    seen = []
    monkeypatch.setattr(iglobal_module, 'warning', lambda msg: seen.append(str(msg)))
    return seen


# ---------------------------------------------------------------------------
# Lookup miss -> refresh once -> retry
# ---------------------------------------------------------------------------


class TestLookupMiss:
    def test_get_tool_miss_refreshes_and_finds_a_tool_added_after_start(self, clock):
        client = _ScriptedClient([_tool('a'), _tool('late')])
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S

        assert g.get_tool(server_name='srv', tool_name='late').name == 'late'
        assert client.list_calls == 1
        assert {d['name'] for d in g.list_namespaced_tools()} == {'srv.a', 'srv.late'}

    def test_call_tool_calls_a_tool_added_after_start(self, clock):
        client = _ScriptedClient([_tool('a'), _tool('late')])
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S

        result = g.call_tool(server_name='srv', tool_name='late', arguments={'x': 1})

        assert result['content'][0]['text'] == 'called late'
        assert client.calls == [('late', {'x': 1})]

    def test_unknown_tool_after_refresh_raises_and_never_reaches_the_server(self, clock):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S

        with pytest.raises(ToolUnavailableError) as exc:
            g.call_tool(server_name='srv', tool_name='ghost', arguments={})

        assert "'ghost'" in str(exc.value) and "'srv'" in str(exc.value) and "'a'" in str(exc.value)
        assert client.calls == []
        assert client.list_calls == 1

    def test_instance_invoke_of_unknown_tool_is_refused_loudly(self, clock):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))
        instance = IInstance.__new__(IInstance)
        instance.IGlobal = g
        clock[0] += REFRESH_MIN_INTERVAL_S

        with pytest.raises(ToolUnavailableError):
            instance._tool_invoke_dynamic(tool_name='srv.ghost', input_obj={'q': 1})

        assert client.calls == []

    def test_known_tool_does_not_refresh(self):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))

        g.call_tool(server_name='srv', tool_name='a', arguments={})

        assert client.list_calls == 0
        assert client.calls == [('a', {})]

    def test_repeated_misses_within_the_interval_refresh_once(self, clock):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S

        assert g.get_tool(server_name='srv', tool_name='ghost') is None
        clock[0] += REFRESH_MIN_INTERVAL_S / 2
        assert g.get_tool(server_name='srv', tool_name='ghost') is None
        assert client.list_calls == 1

        clock[0] += REFRESH_MIN_INTERVAL_S
        assert g.get_tool(server_name='srv', tool_name='ghost') is None
        assert client.list_calls == 2

    def test_other_server_name_is_not_this_node(self):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))

        assert g.get_tool(server_name='other', tool_name='a') is None
        assert client.list_calls == 0

    def test_no_client_means_no_refresh_and_no_crash(self):
        g = IGlobal.__new__(IGlobal)
        g.serverName = 'srv'

        assert g.get_tool(server_name='srv', tool_name='a') is None
        assert g.list_namespaced_tools() == []


# ---------------------------------------------------------------------------
# Catalog query -> refresh after TTL only
# ---------------------------------------------------------------------------


class TestCatalogQuery:
    def test_query_within_the_interval_serves_the_cache(self, clock):
        client = _ScriptedClient([_tool('a'), _tool('late')])
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S / 2

        assert {d['name'] for d in g.list_namespaced_tools()} == {'srv.a'}
        assert client.list_calls == 0

    def test_query_after_the_interval_re_reads_the_server(self, clock):
        client = _ScriptedClient([_tool('a'), _tool('late')])
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S

        assert {d['name'] for d in g.list_namespaced_tools()} == {'srv.a', 'srv.late'}
        assert client.list_calls == 1
        # The refresh restarts the interval: an immediate second query is served from cache.
        assert {d['name'] for d in g.list_namespaced_tools()} == {'srv.a', 'srv.late'}
        assert client.list_calls == 1

    def test_query_descriptor_shape_is_unchanged(self):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))

        [descriptor] = g.list_namespaced_tools()

        assert descriptor == {
            'name': 'srv.a',
            'description': 'a description',
            'inputSchema': {'type': 'object', 'properties': {}},
        }


# ---------------------------------------------------------------------------
# Refresh outcomes: failure keeps the cache; change is reported
# ---------------------------------------------------------------------------


class TestRefreshOutcomes:
    def test_failed_refresh_keeps_previous_catalog_and_warns(self, clock, warnings):
        client = _FailingClient()
        g = _iglobal(client, _tool('a'))
        clock[0] += REFRESH_MIN_INTERVAL_S

        assert g.refresh_tools(reason='test') is False
        assert {d['name'] for d in g.list_namespaced_tools()} == {'srv.a'}
        assert g.call_tool(server_name='srv', tool_name='a', arguments={})['content'][0]['text'] == 'called a'
        assert any('refresh (test) failed' in w and 'server went away' in w for w in warnings)

    def test_changed_catalog_warns_with_added_and_removed_names(self, warnings):
        client = _ScriptedClient([_tool('a'), _tool('c')])
        g = _iglobal(client, _tool('a'), _tool('b'))

        assert g.refresh_tools(reason='test') is True

        [msg] = warnings
        assert "added=['c']" in msg and "removed=['b']" in msg

    def test_unchanged_catalog_does_not_warn(self, warnings):
        client = _ScriptedClient([_tool('a')])
        g = _iglobal(client, _tool('a'))

        assert g.refresh_tools(reason='test') is True
        assert warnings == []

    def test_cache_swap_is_atomic_for_a_concurrent_reader(self):
        client = _ScriptedClient([_tool('a'), _tool('b')])
        g = _iglobal(client, _tool('a'))
        old_by_name = g._tools_by_original
        old_by_namespaced = g._tools_by_namespaced

        g.refresh_tools(reason='test')

        # A reader still holding the previous maps sees them unchanged; the
        # new catalog is a fresh object, not an in-place mutation.
        assert set(old_by_name) == {'a'} and set(old_by_namespaced) == {'srv.a'}
        assert set(g._tools_by_original) == {'a', 'b'}
        assert g._tools_by_original is not old_by_name


# ---------------------------------------------------------------------------
# End-to-end against the stub stdio MCP server, tools changing under it
# ---------------------------------------------------------------------------


@pytest.fixture
def live_tools_file(tmp_path, monkeypatch):
    path = tmp_path / 'tools.json'
    path.write_text(json.dumps([{'name': 'echo_tool', 'description': 'echo', 'inputSchema': {'type': 'object'}}]))
    monkeypatch.setenv('STUB_MCP_TOOLS_FILE', str(path))
    return path


@pytest.fixture
def stub_client(live_tools_file):
    c = McpStdioClient(command=sys.executable, args=[STUB_SERVER], timeout_s=10.0)
    c.start()
    try:
        yield c
    finally:
        c.stop()


class TestAgainstStubServer:
    def test_tool_added_after_start_becomes_callable_and_ghost_is_refused(self, stub_client, live_tools_file, clock):
        g = IGlobal.__new__(IGlobal)
        g.serverName = 'stub'
        g._client = stub_client
        g._cache_tools(stub_client.list_tools())
        assert {t['name'] for t in g.list_namespaced_tools()} == {'stub.echo_tool'}

        # The server grows a tool while the engine keeps running.
        live_tools_file.write_text(
            json.dumps(
                [
                    {'name': 'echo_tool', 'description': 'echo', 'inputSchema': {'type': 'object'}},
                    {'name': 'late_tool', 'description': 'added later', 'inputSchema': {'type': 'object'}},
                ]
            )
        )
        clock[0] += REFRESH_MIN_INTERVAL_S

        result = g.call_tool(server_name='stub', tool_name='late_tool', arguments={'k': 'v'})
        assert result['content'][0]['text'] == 'called late_tool'
        assert result['received_arguments'] == {'k': 'v'}

        clock[0] += REFRESH_MIN_INTERVAL_S
        with pytest.raises(ToolUnavailableError):
            g.call_tool(server_name='stub', tool_name='ghost_tool', arguments={})

    def test_stdio_requests_from_several_threads_do_not_starve_each_other(self, stub_client):
        errors = []

        def worker():
            try:
                for _ in range(5):
                    names = {t.name for t in stub_client.list_tools()}
                    assert 'echo_tool' in names
                    stub_client.call_tool(name='echo_tool', arguments={'msg': 'hi'})
            except Exception as e:  # pragma: no cover - failure path
                errors.append(e)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        assert not errors
        assert not any(t.is_alive() for t in threads)
