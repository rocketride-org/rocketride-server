# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Unit tests for tool_falkordb helpers and tool-method behavior (no server)."""

from __future__ import annotations

import datetime
import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: when run under a bare interpreter that lacks the engine runtime
# (rocketlib, ai.common, falkordb, redis), inject lightweight stubs ONLY for
# modules that are not already present, import the module under test, then
# REMOVE the stubs we added so they never leak into the shared pytest session
# (see test_tool_tavily.py for the full rationale).
# ---------------------------------------------------------------------------

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


class _StubRedisError(Exception):
    """Real exception class so IInstance's except clauses catch it under the stub."""


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the module."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}

    falkordb = MagicMock()
    falkordb.FalkorDB = MagicMock()

    redis_exceptions = MagicMock()
    redis_exceptions.RedisError = _StubRedisError
    redis = MagicMock()
    redis.exceptions = redis_exceptions

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
        'falkordb': falkordb,
        'redis': redis,
        'redis.exceptions': redis_exceptions,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

mod = importlib.import_module('nodes.tool_falkordb.IInstance')

for _name in _added_stubs:
    sys.modules.pop(_name, None)


class _FakeNode:
    def __init__(self, node_id=1, labels=None, properties=None):
        self.id = node_id
        self.labels = labels or ['Person']
        self.properties = properties or {'name': 'Alice'}


class _FakeEdge:
    def __init__(self):
        self.id = 7
        self.relation = 'KNOWS'
        self.src_node = 1
        self.dest_node = 2
        self.properties = {'since': 2020}


class _FakeResult:
    def __init__(self, result_set=None, header=None, **stats):
        self.result_set = result_set or []
        self.header = header or []
        for attr in (
            'nodes_created',
            'nodes_deleted',
            'relationships_created',
            'relationships_deleted',
            'properties_set',
            'properties_removed',
            'labels_added',
            'indices_created',
        ):
            setattr(self, attr, stats.get(attr, 0))


class _FakeGraph:
    def __init__(self, result=None, raise_error=None):
        self._result = result or _FakeResult()
        self._raise = raise_error
        self.calls = []

    def query(self, q, params=None, timeout=None):
        self.calls.append(('query', q, params, timeout))
        if self._raise:
            raise self._raise
        return self._result

    def ro_query(self, q, params=None, timeout=None):
        self.calls.append(('ro_query', q, params, timeout))
        if self._raise:
            raise self._raise
        return self._result


class _FakeClient:
    def __init__(self, graph):
        self._graph = graph
        self.selected = []

    def select_graph(self, name):
        self.selected.append(name)
        return self._graph

    def list_graphs(self):
        return ['g1', 'g2']


class _FakeGlobal:
    def __init__(self, graph, *, allow_writes=False, max_rows=250, graph_name='agent'):
        self.client = _FakeClient(graph)
        self.allow_writes = allow_writes
        self.max_rows = max_rows
        self.graph_name = graph_name
        self.query_timeout_ms = 30000


def _instance(global_state):
    inst = mod.IInstance()
    inst.IGlobal = global_state
    return inst


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------


def test_serialize_node_edge_and_temporal():
    node = mod._serialize_value(_FakeNode())
    assert node == {'id': 1, 'labels': ['Person'], 'properties': {'name': 'Alice'}}

    edge = mod._serialize_value(_FakeEdge())
    assert edge == {'id': 7, 'type': 'KNOWS', 'src': 1, 'dst': 2, 'properties': {'since': 2020}}

    stamp = datetime.datetime(2026, 6, 11, 12, 0, 0)
    assert mod._serialize_value(stamp) == '2026-06-11T12:00:00'
    assert mod._serialize_value([1, 'a', None]) == [1, 'a', None]


def test_header_names_handles_pairs_and_strings():
    assert mod._header_names([[1, 'name'], [2, 'age']]) == ['name', 'age']
    assert mod._header_names(['plain']) == ['plain']
    assert mod._header_names(None) == []


# ---------------------------------------------------------------------------
# query: routing, caps, errors
# ---------------------------------------------------------------------------


def test_query_uses_ro_query_when_writes_disabled():
    graph = _FakeGraph(_FakeResult(result_set=[['x']], header=[[1, 'value']]))
    inst = _instance(_FakeGlobal(graph, allow_writes=False))
    out = inst.query({'cypher': 'MATCH (n) RETURN n'})
    assert graph.calls[0][0] == 'ro_query'
    assert out['columns'] == ['value']
    assert out['row_count'] == 1


def test_query_uses_query_when_writes_enabled_and_reports_stats():
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=2))
    inst = _instance(_FakeGlobal(graph, allow_writes=True))
    out = inst.query({'cypher': 'CREATE (n) RETURN n'})
    assert graph.calls[0][0] == 'query'
    assert out['stats'] == {'nodes_created': 2}


def test_query_caps_rows_and_flags_truncation():
    rows = [[i] for i in range(10)]
    graph = _FakeGraph(_FakeResult(result_set=rows, header=[[1, 'n']]))
    inst = _instance(_FakeGlobal(graph, max_rows=3))
    out = inst.query({'cypher': 'MATCH (n) RETURN n'})
    assert out['row_count'] == 3
    assert out['truncated'] is True


def test_query_rejects_bad_params_without_touching_client():
    graph = _FakeGraph()
    glb = _FakeGlobal(graph)
    inst = _instance(glb)
    with pytest.raises(ValueError):
        inst.query({'cypher': 'MATCH (n) RETURN n', 'params': 'not-a-dict'})
    assert graph.calls == []


def test_query_returns_error_dict_on_redis_error():
    # Raise the class the module actually bound — under `builder nodes:test-full`
    # the real redis may already be imported, and the file-local stub would
    # then not be caught by IInstance's `except RedisError`.
    graph = _FakeGraph(raise_error=mod.RedisError('bad cypher'))
    inst = _instance(_FakeGlobal(graph))
    out = inst.query({'cypher': 'MATCH (n) RETURN n'})
    assert out['error'] == 'bad cypher'
    assert out['rows'] == []


def test_query_graph_override_and_default():
    graph = _FakeGraph(_FakeResult())
    glb = _FakeGlobal(graph, graph_name='default-graph')
    inst = _instance(glb)
    inst.query({'cypher': 'MATCH (n) RETURN n'})
    inst.query({'cypher': 'MATCH (n) RETURN n', 'graph': 'other'})
    assert glb.client.selected == ['default-graph', 'other']


# ---------------------------------------------------------------------------
# list_graphs / get_schema
# ---------------------------------------------------------------------------


def test_list_graphs_returns_names():
    inst = _instance(_FakeGlobal(_FakeGraph()))
    assert inst.list_graphs({}) == {'graphs': ['g1', 'g2']}


def test_get_schema_shapes_columns():
    graph = _FakeGraph(_FakeResult(result_set=[['Person'], ['City']], header=[[1, 'label']]))
    inst = _instance(_FakeGlobal(graph))
    out = inst.get_schema({})
    assert out['labels'] == ['Person', 'City']
    # All three procedures run read-only.
    assert all(call[0] == 'ro_query' for call in graph.calls)
