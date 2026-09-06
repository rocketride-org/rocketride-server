# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for tool_vertex_search score_threshold filtering.

These are pure-Python unit tests — no server, no live Vertex AI. The node
module is imported under a stubbed ``rocketlib`` so ``IInstance.py`` resolves
without the engine runtime.
"""

from __future__ import annotations

import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_vertex_search'

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config')


def _tool_function(**meta):
    def wrap(fn):
        fn.__tool_meta__ = meta
        return fn

    return wrap


def _install_stubs() -> None:
    stub = types.ModuleType('rocketlib')

    class _IInstanceBase:
        pass

    class _IGlobalBase:
        pass

    stub.IInstanceBase = _IInstanceBase
    stub.IGlobalBase = _IGlobalBase
    stub.tool_function = _tool_function
    stub.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    stub.debug = lambda *a, **kw: None
    stub.warning = lambda *a, **kw: None
    sys.modules['rocketlib'] = stub

    ai = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')
    ai_common_config = types.ModuleType('ai.common.config')
    ai_common_config.Config = type('Config', (), {})
    ai.common = ai_common
    ai_common.config = ai_common_config
    sys.modules['ai'] = ai
    sys.modules['ai.common'] = ai_common
    sys.modules['ai.common.config'] = ai_common_config

    if 'tool_vertex_search' not in sys.modules:
        pkg = types.ModuleType('tool_vertex_search')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_vertex_search'] = pkg


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    added_pkg = 'tool_vertex_search' not in sys.modules
    _install_stubs()
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        if added_pkg:
            for name in list(sys.modules):
                if name == 'tool_vertex_search' or name.startswith('tool_vertex_search.'):
                    sys.modules.pop(name, None)


with _scoped_stubs():
    from tool_vertex_search.IInstance import IInstance  # noqa: E402


def _make_instance(neighbors):
    endpoint = types.SimpleNamespace()
    endpoint.find_neighbors = lambda **kw: [neighbors]
    inst = IInstance()
    inst.IGlobal = types.SimpleNamespace(index_endpoint=endpoint, deployed_index_id='deployed-1')
    return inst, endpoint


def test_search_score_threshold_keeps_higher_similarity():
    neighbors = [
        types.SimpleNamespace(id='close', distance=0.9),
        types.SimpleNamespace(id='far', distance=0.2),
    ]
    inst, _endpoint = _make_instance(neighbors)

    results = inst.search({'query_vector': [0.1, 0.2], 'top_k': 10, 'score_threshold': 0.5})

    assert results == [{'id': 'close', 'distance': 0.9}]


def test_search_zero_threshold_keeps_all_neighbors():
    neighbors = [
        types.SimpleNamespace(id='close', distance=0.9),
        types.SimpleNamespace(id='far', distance=0.2),
    ]
    inst, _endpoint = _make_instance(neighbors)

    results = inst.search({'query_vector': [0.1, 0.2], 'top_k': 2, 'score_threshold': 0.0})

    assert results == [
        {'id': 'close', 'distance': 0.9},
        {'id': 'far', 'distance': 0.2},
    ]


def test_search_disconnected_returns_error():
    inst = IInstance()
    inst.IGlobal = types.SimpleNamespace(index_endpoint=None, deployed_index_id='deployed-1')

    results = inst.search({'query_vector': [0.1], 'top_k': 1})

    assert results == [{'error': 'Vertex AI Index Endpoint is not connected.'}]
