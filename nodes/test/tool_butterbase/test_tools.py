# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_butterbase node.

Pure-Python: no server, no engine, no real HTTP. The node modules are imported
under composable stubs for ``rocketlib`` and ``ai.common.config`` so the
relative imports resolve without the engine runtime. The MCP transport is
never hit — we exercise the tool cache, namespacing, and dispatch directly with
a fake client.

Covers:
* ``_split_tool_name`` — namespaced parsing and rejection of bad shapes.
* ``IGlobal._cache_tools`` + accessors — namespacing, lookup, scope guard.
* ``IGlobal.call_tool`` — routes to the client / rejects unknown server.
* ``IInstance._tool_invoke_dynamic`` — strips framework keys, dispatches.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_butterbase'


# ---------------------------------------------------------------------------
# Composable import scaffolding (augments existing stubs, never clobbers)
# ---------------------------------------------------------------------------


def _ensure_rocketlib() -> None:
    mod = sys.modules.get('rocketlib') or types.ModuleType('rocketlib')
    if not hasattr(mod, 'IInstanceBase'):
        mod.IInstanceBase = type('IInstanceBase', (), {})
    if not hasattr(mod, 'IGlobalBase'):
        mod.IGlobalBase = type('IGlobalBase', (), {})
    if not hasattr(mod, 'OPEN_MODE'):
        mod.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    for name in ('debug', 'error', 'warning'):
        if not hasattr(mod, name):
            setattr(mod, name, lambda *a, **k: None)
    sys.modules['rocketlib'] = mod


def _ensure_ai_common() -> None:
    for name in ('ai', 'ai.common', 'ai.common.config'):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    if not hasattr(sys.modules['ai.common.config'], 'Config'):

        class _Config:
            @staticmethod
            def getNodeConfig(*_a, **_k):
                return {}

        sys.modules['ai.common.config'].Config = _Config


def _ensure_pkg() -> None:
    if 'tool_butterbase' not in sys.modules:
        pkg = types.ModuleType('tool_butterbase')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_butterbase'] = pkg


_ensure_rocketlib()
_ensure_ai_common()
_ensure_pkg()

from tool_butterbase.IGlobal import IGlobal  # noqa: E402
from tool_butterbase.IInstance import IInstance, _split_tool_name  # noqa: E402
from tool_butterbase.mcp_streamable_http_client import McpToolDef  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeClient:
    def __init__(self):
        self.calls = []
        self.stopped = False

    def call_tool(self, *, name, arguments):
        self.calls.append({'name': name, 'arguments': arguments})
        return {'content': [{'type': 'text', 'text': f'ok:{name}'}]}

    def stop(self):
        self.stopped = True


def _global_with_tools(*tool_names, server='butterbase'):
    glb = IGlobal()
    glb.serverName = server
    glb._client = _FakeClient()
    glb._cache_tools([McpToolDef(name=n, description=f'{n} desc', inputSchema={'type': 'object'}) for n in tool_names])
    return glb


# ---------------------------------------------------------------------------
# _split_tool_name
# ---------------------------------------------------------------------------


def test_split_tool_name_ok():
    assert _split_tool_name('butterbase.init_app') == ('butterbase', 'init_app')
    # only the first dot splits — tool names may themselves contain dots
    assert _split_tool_name('butterbase.schema.apply') == ('butterbase', 'schema.apply')


@pytest.mark.parametrize('bad', ['init_app', 'butterbase.', '.init_app', '   ', ''])
def test_split_tool_name_rejects_bad(bad):
    with pytest.raises(ValueError):
        _split_tool_name(bad)


# ---------------------------------------------------------------------------
# IGlobal cache + accessors
# ---------------------------------------------------------------------------


def test_cache_and_list_namespaced_tools():
    glb = _global_with_tools('init_app', 'apply_schema')
    listed = {t['name']: t for t in glb.list_namespaced_tools()}
    assert set(listed) == {'butterbase.init_app', 'butterbase.apply_schema'}
    assert listed['butterbase.init_app']['description'] == 'init_app desc'
    assert listed['butterbase.init_app']['input_schema'] == {'type': 'object'}


def test_get_tool_scope_guard():
    glb = _global_with_tools('init_app')
    assert glb.get_tool(server_name='butterbase', tool_name='init_app').name == 'init_app'
    assert glb.get_tool(server_name='butterbase', tool_name='nope') is None
    # wrong server namespace → None
    assert glb.get_tool(server_name='other', tool_name='init_app') is None


def test_call_tool_routes_to_client():
    glb = _global_with_tools('init_app')
    out = glb.call_tool(server_name='butterbase', tool_name='init_app', arguments={'name': 'demo'})
    assert out['content'][0]['text'] == 'ok:init_app'
    assert glb._client.calls == [{'name': 'init_app', 'arguments': {'name': 'demo'}}]


def test_call_tool_rejects_unknown_server():
    glb = _global_with_tools('init_app')
    with pytest.raises(Exception):
        glb.call_tool(server_name='other', tool_name='init_app', arguments={})


# ---------------------------------------------------------------------------
# IInstance dynamic dispatch
# ---------------------------------------------------------------------------


def test_invoke_dynamic_strips_framework_keys_and_dispatches():
    glb = _global_with_tools('init_app')
    inst = IInstance()
    inst.IGlobal = glb

    # _tool_query_dynamic surfaces the namespaced tools
    assert {t['name'] for t in inst._tool_query_dynamic()} == {'butterbase.init_app'}

    inst._tool_invoke_dynamic(
        tool_name='butterbase.init_app',
        input_obj={'name': 'demo', 'security_context': {'token': 'secret'}},
    )
    # framework key 'security_context' must be stripped before reaching the server
    assert glb._client.calls[-1] == {'name': 'init_app', 'arguments': {'name': 'demo'}}


def test_invoke_dynamic_none_input_is_empty_args():
    glb = _global_with_tools('list_apps')
    inst = IInstance()
    inst.IGlobal = glb
    inst._tool_invoke_dynamic(tool_name='butterbase.list_apps', input_obj=None)
    assert glb._client.calls[-1] == {'name': 'list_apps', 'arguments': {}}


def test_invoke_dynamic_non_dict_input_raises():
    glb = _global_with_tools('init_app')
    inst = IInstance()
    inst.IGlobal = glb
    with pytest.raises(ValueError):
        inst._tool_invoke_dynamic(tool_name='butterbase.init_app', input_obj=['not', 'a', 'dict'])
