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

"""Tests for the FalkorDB graph node.

The node derives from ``ai.common.graph``, so the real base classes are loaded
from disk (as ``ai.common.graph``) with ``rocketlib`` and the heavier ``ai``
modules stubbed, mirroring ``test_vectordb_tool_mixin.py``.
"""

from __future__ import annotations

import datetime
import importlib.util
import os
import sys
import types

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest

_REPO = Path(__file__).resolve().parents[2]
_GRAPH_PKG = _REPO / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'graph'
_UTILS_DIR = _REPO / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils'
_CONFIG_UTILS = _UTILS_DIR / 'config_utils.py'
_TOOL_ARGS = _UTILS_DIR / 'tool_args.py'
_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'graph_falkordb'


class _StubRedisError(Exception):
    pass


class _StubBase:
    """Stand-in for IInstanceBase / IGlobalBase — the engine supplies the real one."""

    def __init__(self, *args, **kwargs):
        pass


class _StubTable:
    @staticmethod
    def generate_markdown_table(data, headers=None):
        return '\n'.join([' | '.join(map(str, row)) for row in data])


_STUB_NAMES = (
    'rocketlib',
    'rocketlib.types',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.table',
    'ai.common.config',
    'ai.common.utils',
    'falkordb',
    'redis',
    'redis.exceptions',
)


def _install_stubs() -> None:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = _StubBase
    rocketlib.IGlobalBase = _StubBase
    # The decorator only tags the function in production; here it must be a no-op
    # so the methods stay directly callable.
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG=object())
    rocketlib_types = types.ModuleType('rocketlib.types')
    rocketlib_types.IInvokeLLM = types.SimpleNamespace(Ask=lambda **kw: kw)
    rocketlib.types = rocketlib_types

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []

    schema = types.ModuleType('ai.common.schema')
    schema.Answer = type('Answer', (), {'setAnswer': lambda self, v: setattr(self, 'value', v)})
    schema.Question = type('Question', (), {})
    schema.QuestionType = types.SimpleNamespace(QUESTION=1, DIALECT=2, EXECUTE=3)

    table = types.ModuleType('ai.common.table')
    table.Table = _StubTable

    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=lambda *a, **kw: {})

    # Load the real config parsers rather than reimplementing them, so the node
    # is exercised against the same coercion rules it uses in production.
    config_utils = _load_from_path('ai.common.config_utils', _CONFIG_UTILS)
    utils = types.ModuleType('ai.common.utils')
    utils.parse_bool = config_utils.parse_bool
    utils.config_int = config_utils.config_int

    falkordb = types.ModuleType('falkordb')
    falkordb.FalkorDB = object

    redis_exceptions = types.ModuleType('redis.exceptions')
    redis_exceptions.RedisError = _StubRedisError
    redis = types.ModuleType('redis')
    redis.exceptions = redis_exceptions

    sys.modules.update(
        {
            'rocketlib': rocketlib,
            'rocketlib.types': rocketlib_types,
            'ai': ai_pkg,
            'ai.common': common_pkg,
            'ai.common.schema': schema,
            'ai.common.table': table,
            'ai.common.config': config,
            'ai.common.utils': utils,
            'falkordb': falkordb,
            'redis': redis,
            'redis.exceptions': redis_exceptions,
        }
    )

    # tool_args imports `from rocketlib import warning`, so load it only after the
    # rocketlib stub is registered above; expose the real validators/normaliser on
    # the fake utils module so the base is exercised against production behaviour.
    tool_args = _load_from_path('ai.common.tool_args', _TOOL_ARGS)
    for _fn in ('normalize_tool_input', 'require_str', 'require_dict', 'require_int', 'optional_int', 'optional_str'):
        setattr(utils, _fn, getattr(tool_args, _fn))


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    saved = {name: sys.modules.get(name) for name in _STUB_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def _load_from_path(name: str, path: Path, *, is_package: bool = False):
    """Load a module by file path and register it under ``name``."""
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_node():
    """Load the real graph base classes, then the FalkorDB node on top of them."""
    with _scoped_stubs():
        _load_from_path('ai.common.graph', _GRAPH_PKG / '__init__.py', is_package=True)
        iglobal = _load_from_path('nodes.graph_falkordb.IGlobal', _NODE_DIR / 'IGlobal.py')
        # IInstance does `from .IGlobal import ...`, so its package must resolve.
        pkg = types.ModuleType('nodes.graph_falkordb')
        pkg.__path__ = [str(_NODE_DIR)]
        pkg.IGlobal = iglobal
        sys.modules['nodes.graph_falkordb'] = pkg
        iinstance = _load_from_path('nodes.graph_falkordb.IInstance', _NODE_DIR / 'IInstance.py')
        return iglobal, iinstance


_glb_mod, mod = _load_node()
graph_base = sys.modules['ai.common.graph']
config_utils = sys.modules['ai.common.config_utils']


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


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
    def __init__(self, result=None, raise_error=None, explain_plan='plan', explain_error=None):
        self._result = result or _FakeResult()
        self._raise = raise_error
        self.explain_plan = explain_plan
        self._explain_error = explain_error
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

    def explain(self, q, params=None):
        self.calls.append(('explain', q, params, None))
        if self._explain_error:
            raise self._explain_error
        if self._raise:
            raise self._raise
        return self.explain_plan


class _FakeClient:
    def __init__(self, graph):
        self._graph = graph
        self.selected = []

    def select_graph(self, name):
        self.selected.append(name)
        return self._graph

    def list_graphs(self):
        return ['g1', 'g2']


class _FakeGlobal(_glb_mod.IGlobal):
    """The real IGlobal with a fake client — exercises select_graph/_run_query for real."""

    def __init__(self, graph, *, allow_writes=False, max_rows=250, graph_name='agent', graph_schema=None):
        self.client = _FakeClient(graph)
        self.allow_writes = allow_writes
        self.max_rows = max_rows
        self.graph_name = graph_name
        self.query_timeout_ms = 30000
        self.max_execute_rows = 25000
        self.max_validation_attempts = 5
        self.allow_execute = False
        self.db_description = ''
        self.graph_schema = graph_schema or {'nodes': {}, 'relationships': []}


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
    inst = _instance(_FakeGlobal(graph))
    with pytest.raises(ValueError):
        inst.query({'cypher': 'MATCH (n) RETURN n', 'params': 'not-a-dict'})
    assert graph.calls == []


def test_query_returns_error_dict_on_redis_error():
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


def test_list_graphs_returns_names():
    inst = _instance(_FakeGlobal(_FakeGraph()))
    assert inst.list_graphs({}) == {'graphs': ['g1', 'g2']}


# ---------------------------------------------------------------------------
# Inherited graph base: schema, dialect, read-only enforcement
# ---------------------------------------------------------------------------


def test_get_schema_comes_from_reflected_schema():
    schema = {
        'nodes': {'Person': [('name', 'STRING')]},
        'relationships': [{'type': 'KNOWS', 'start': 'Person', 'end': 'Person'}],
    }
    inst = _instance(_FakeGlobal(_FakeGraph(), graph_schema=schema))
    out = inst.get_schema({})
    assert out['labels'] == ['Person']
    assert out['nodes'] == {'Person': [{'property': 'name', 'type': 'STRING'}]}
    assert out['relationships'] == schema['relationships']


def test_dialect_identifies_falkordb():
    inst = _instance(_FakeGlobal(_FakeGraph()))
    assert inst.dialect({}) == {'dialect': 'falkordb'}


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [(True, True), ('true', True), ('yes', True), ('on', True), ('false', False), ('off', False), ('no', False)],
)
def test_allow_writes_accepts_human_typed_strings(raw, expected):
    """allow_writes is human-edited config: 'false' must not read as truthy."""
    graph = _FakeGraph(_FakeResult(result_set=[], header=[]))
    glb = _FakeGlobal(graph)
    glb.allow_writes = config_utils.parse_bool(raw)

    _instance(glb).query({'cypher': 'MATCH (n) RETURN n'})

    # Writes enabled -> GRAPH.QUERY; disabled -> GRAPH.RO_QUERY (server refuses writes).
    assert graph.calls[0][0] == ('query' if expected else 'ro_query')


def test_run_query_uses_server_side_readonly():
    """_run_query must go through ro_query so the server rejects writes."""
    graph = _FakeGraph(_FakeResult(result_set=[['Alice']], header=[[1, 'name']]))
    glb = _FakeGlobal(graph)
    rows = glb._run_query('MATCH (n) RETURN n.name AS name')
    assert graph.calls[0][0] == 'ro_query'
    assert rows == [{'name': 'Alice'}]


def test_execute_tool_is_disabled_unless_allowed():
    inst = _instance(_FakeGlobal(_FakeGraph()))
    with pytest.raises(ValueError, match='allow_execute'):
        inst.execute({'query': 'CREATE (n:Person)'})


@pytest.mark.parametrize(
    'args',
    [
        {'query': 'CREATE (n:Person)', 'session_id': 'tx-1'},
        {'sql': 'CREATE (n:Person)', 'row_mode': 'array'},
        {'query': 'CREATE (n:Person {name: $n})', 'params': {'n': 'Ada'}},
        {'query': 'CREATE (n:Person)', 'params': ['Ada']},
        {'query': ''},
    ],
)
def test_execute_tool_reports_disabled_before_argument_errors(args):
    # A disabled node answers "disabled", not which argument is wrong.
    graph = _FakeGraph()
    with pytest.raises(ValueError, match='allow_execute'):
        _instance(_FakeGlobal(graph)).execute(args)
    assert graph.calls == []


def test_execute_tool_runs_writes_when_allowed():
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    out = _instance(glb).execute({'query': 'CREATE (n:Person)'})
    assert graph.calls[0][0] == 'query'
    assert out['affected_rows'] == 1


def test_execute_tool_accepts_sql_key_from_database_query():
    # client.database.query sends the statement as 'sql', not 'query'.
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    out = _instance(glb).execute({'sql': 'CREATE (n:Person)'})
    assert graph.calls[0][0] == 'query'
    assert out['affected_rows'] == 1


@pytest.mark.parametrize('params', [None, {}, []])
def test_execute_tool_treats_empty_params_as_none(params):
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    out = _instance(glb).execute({'query': 'CREATE (n:Person)', 'params': params})
    assert out['affected_rows'] == 1


def test_execute_tool_forwards_params():
    # graph.query binds $name. The tool must pass the object through, not refuse it.
    graph = _FakeGraph(_FakeResult(result_set=[['Ada']], header=[[1, 'name']], nodes_created=1, properties_set=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    out = _instance(glb).execute(
        {'query': 'CREATE (n:Person {name: $name}) RETURN n.name AS name', 'params': {'name': 'Ada'}}
    )
    assert graph.calls[0][0] == 'query'
    assert graph.calls[0][2] == {'name': 'Ada'}
    assert out['rows'] == [{'name': 'Ada'}]
    assert out['affected_rows'] == 2


@pytest.mark.parametrize('params', [0, False, '', 'rows', 42])
def test_execute_tool_refuses_non_object_params(params):
    glb = _FakeGlobal(_FakeGraph())
    glb.allow_execute = True
    with pytest.raises(ValueError, match='keyed by placeholder name'):
        _instance(glb).execute({'query': 'CREATE (n:Person)', 'params': params})


@pytest.mark.parametrize(
    ('extra', 'message'),
    [
        ({'session_id': 'tx-1'}, 'no transactions'),
        ({'row_mode': 'array'}, "must be 'object'"),
    ],
)
def test_execute_tool_refuses_sql_only_options(extra, message):
    # client.database.query forwards these SQL-node options; graph nodes have
    # no transactions and always return row objects.
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    with pytest.raises(ValueError, match=message):
        _instance(glb).execute({'sql': 'CREATE (n:Person)', **extra})
    assert graph.calls == []


def test_execute_tool_accepts_object_row_mode():
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    out = _instance(glb).execute({'sql': 'CREATE (n:Person)', 'row_mode': 'object', 'session_id': ''})
    assert out['affected_rows'] == 1


def test_execute_schema_lists_params_when_the_driver_supports_them():
    glb = _FakeGlobal(_FakeGraph())
    assert 'params' in _instance(glb)._execute_input_schema()['properties']
    glb.supports_execute_params = False
    assert 'params' not in _instance(glb)._execute_input_schema()['properties']


def test_execute_tool_refuses_positional_params():
    glb = _FakeGlobal(_FakeGraph())
    glb.allow_execute = True
    with pytest.raises(ValueError, match='keyed by placeholder name'):
        _instance(glb).execute({'query': 'CREATE (n:Person {name: $1})', 'params': ['Ada']})


def test_validate_query_uses_explain():
    graph = _FakeGraph()
    ok, err = _FakeGlobal(graph)._validate_query('MATCH (n) RETURN n')
    assert ok is True and err == ''
    assert graph.calls[0][0] == 'explain'


# ---------------------------------------------------------------------------
# Cypher safety (shared by every graph node)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cypher',
    [
        'CREATE (n:Person)',
        'MATCH (n) DELETE n',
        'MATCH (n) SET n.x = 1',
        'MERGE (n:Person {name: "a"})',
    ],
)
def test_is_cypher_safe_rejects_writes(cypher):
    assert graph_base.is_cypher_safe(cypher) is False


def test_is_cypher_safe_allows_reads_and_ignores_comments():
    assert graph_base.is_cypher_safe('MATCH (n) RETURN n') is True
    # A commented-out write must not make the statement look unsafe...
    assert graph_base.is_cypher_safe('MATCH (n) RETURN n // CREATE (x)') is True


def test_parse_bool_reads_llm_is_valid_field():
    # The isValid gate now runs through the shared config parser instead of a
    # graph-local helper; the LLM may answer with a real bool or a string.
    assert config_utils.parse_bool(True) is True
    assert config_utils.parse_bool('true') is True
    assert config_utils.parse_bool('false') is False
    assert config_utils.parse_bool(None) is False


# ---------------------------------------------------------------------------
# Fixes from PR review: enforce limit, reject on EXPLAIN exhaustion, count writes
# ---------------------------------------------------------------------------


def test_get_data_enforces_limit_when_llm_drops_it():
    """The LLM may omit LIMIT; get_data must still cap rows and flag truncation."""
    rows = [{'n': i} for i in range(10)]
    graph = _FakeGraph(_FakeResult(result_set=[[r['n']] for r in rows], header=[[1, 'n']]))
    inst = _instance(_FakeGlobal(graph))
    # Bypass the LLM: force a valid query with a small limit.
    inst.get_query = lambda args: {'query': 'MATCH (n) RETURN n', 'valid': True}

    out = inst.get_data({'question': 'all nodes', 'limit': 3})

    assert out['valid'] is True
    assert len(out['rows']) == 3
    assert out['truncated'] is True


def test_build_query_marks_invalid_after_explain_exhaustion():
    """A query EXPLAIN keeps rejecting must not come back as valid."""
    graph = _FakeGraph(raise_error=mod.RedisError('syntax error'))  # explain always fails
    glb = _FakeGlobal(graph)
    glb.max_validation_attempts = 2
    inst = _instance(glb)
    # Bypass the LLM: it keeps returning the same (syntactically valid, read-only) query.
    inst._buildQueryOnce = lambda *a, **k: {'isValid': True, 'query': 'MATCH (n) RETURN n'}

    result = inst._buildQuery('anything')

    assert config_utils.parse_bool(result.get('isValid')) is False
    assert result.get('error')  # the EXPLAIN error is carried for the caller


def test_get_query_surfaces_explain_failure_as_error_not_prose():
    """An EXPLAIN-exhausted query must return an error, not the broken query as prose."""
    graph = _FakeGraph(raise_error=mod.RedisError('syntax error'))
    glb = _FakeGlobal(graph)
    glb.max_validation_attempts = 2
    inst = _instance(glb)
    inst._buildQueryOnce = lambda *a, **k: {'isValid': True, 'query': 'MATCH (n RETURN n'}

    out = inst.get_query({'question': 'broken'})

    assert out['valid'] is False
    assert out.get('error')  # not swallowed into an 'answer' field
    assert 'answer' not in out


class _CapturingInstance:
    """Captures what the lane path (writeQuestions) emits to each wired lane."""

    def __init__(self, lanes):
        self._lanes = lanes
        self.text = []
        self.tables = []
        self.answers = []

    def getListeners(self):
        return self._lanes

    def writeText(self, v):
        self.text.append(v)

    def writeTable(self, v):
        self.tables.append(v)

    def writeAnswers(self, a):
        self.answers.append(getattr(a, 'value', a))


def _question(text):
    """A plain QuestionType.QUESTION carrying one text part."""
    return types.SimpleNamespace(type=1, questions=[types.SimpleNamespace(text=text)])


def test_write_questions_emits_error_not_broken_cypher_on_explain_exhaustion():
    """Lane-path twin of get_query: broken Cypher must not be emitted as a prose answer."""
    graph = _FakeGraph(raise_error=mod.RedisError('syntax error'))  # explain always fails
    glb = _FakeGlobal(graph)
    glb.max_validation_attempts = 2
    inst = _instance(glb)
    inst._buildQueryOnce = lambda *a, **k: {'isValid': True, 'query': 'MATCH (n RETURN n'}
    cap = _CapturingInstance({'answers', 'text'})
    inst.instance = cap

    inst.writeQuestions(_question('Which people know Alice?'))

    emitted = [str(e) for e in cap.answers + cap.text]
    assert emitted  # something was emitted
    assert all('MATCH (n RETURN n' not in e for e in emitted)  # never the broken query
    assert any('error' in e.lower() for e in emitted)


def test_write_questions_emits_error_for_unsafe_query_not_prose():
    """A write query the LLM claims is valid must be rejected on the lane, not printed."""
    inst = _instance(_FakeGlobal(_FakeGraph()))
    inst._buildQueryOnce = lambda *a, **k: {'isValid': True, 'query': 'MATCH (n) DELETE n'}
    cap = _CapturingInstance({'answers', 'text'})
    inst.instance = cap

    inst.writeQuestions(_question('delete everything'))

    emitted = [str(e) for e in cap.answers + cap.text]
    assert all('DELETE' not in e for e in emitted)  # never the unsafe query
    assert any('write or admin' in e for e in emitted)


def test_get_data_truncated_is_honest_when_limit_exceeds_row_cap():
    """A limit above the node's max_rows must still report truncation, not hide it."""
    # 10 rows exist; the node caps reads at 3, but the caller asks for 1000.
    graph = _FakeGraph(_FakeResult(result_set=[[i] for i in range(10)], header=[[1, 'n']]))
    inst = _instance(_FakeGlobal(graph, max_rows=3))
    inst.get_query = lambda args: {'query': 'MATCH (n) RETURN n', 'valid': True}

    out = inst.get_data({'question': 'all nodes', 'limit': 1000})

    assert len(out['rows']) == 3
    assert out['row_limit'] == 3  # clamped to the node's read cap, not 1000
    assert out['truncated'] is True  # would have been False before the fix


def test_get_data_unwraps_input_envelope():
    """Inherited tools must accept the {'input': {...}} envelope like the query tool."""
    graph = _FakeGraph(_FakeResult(result_set=[['a']], header=[[1, 'n']]))
    inst = _instance(_FakeGlobal(graph))
    inst.get_query = lambda args: {'query': 'MATCH (n) RETURN n', 'valid': True}

    out = inst.get_data({'input': {'question': 'all nodes'}})

    assert out['valid'] is True  # question was found one level down, not rejected


def test_affected_rows_counts_all_write_counters():
    """_affected_rows must not undercount vs the query tool's _write_stats."""
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], labels_added=3, properties_removed=2))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True

    out = glb._run_query_raw('MATCH (n) REMOVE n:Tmp')

    assert out['affected_rows'] == 5  # 3 labels_added + 2 properties_removed


def test_affected_rows_reported_for_write_that_also_returns_rows():
    """CREATE (n) RETURN n writes AND returns rows — affected_rows must not be 0."""
    graph = _FakeGraph(_FakeResult(result_set=[['Alice']], header=[[1, 'n']], nodes_created=1, properties_set=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True

    out = glb._run_query_raw('CREATE (n:Person {name: "Alice"}) RETURN n')

    assert out['rows']  # the RETURN produced a row
    assert out['affected_rows'] == 2  # ...and the write is still counted


def test_execute_without_return_is_not_wrapped():
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb._run_query_raw('CREATE (n:Person)')
    assert graph.calls[0][1] == 'CREATE (n:Person)'


def test_execute_return_is_wrapped_with_null_safe_collect():
    graph = _FakeGraph(_FakeResult(result_set=[[1, None]], header=[[1, 'id'], [1, 'name']]))
    glb = _FakeGlobal(graph)
    glb.max_execute_rows = 3
    glb._run_query_raw('UNWIND range(1, 2) AS i CREATE (n:Item {id: i}) RETURN n.id AS id, n.name AS name')
    sent = graph.calls[0][1]
    # A list keeps null cells. collect(id) would drop them and under-count.
    assert 'collect([`id`, `name`])' in sent
    assert 'LIMIT 4' in sent
    # WHERE keeps the guard live. An unused column could be planned away, and
    # the write would then commit before Python could count the rows.
    assert 'WHERE localtime(_rr_d) IS NOT NULL' in sent
    assert 'RETURN _rr_row[0] AS `id`, _rr_row[1] AS `name`' in sent


def test_execute_cap_error_maps_guard_failure_only():
    graph = _FakeGraph(raise_error=mod.RedisError('Invalid time string: _rr_execute_cap'))
    glb = _FakeGlobal(graph)
    glb.max_execute_rows = 3
    with pytest.raises(ValueError, match='max_execute_rows=3'):
        glb._run_query_raw('UNWIND range(1, 5) AS i CREATE (n:Item {id: i}) RETURN n.id AS id')
    assert 'CALL {' in graph.calls[0][1]


def test_execute_user_division_by_zero_stays_a_driver_error():
    graph = _FakeGraph(raise_error=mod.RedisError('Division by zero'))
    glb = _FakeGlobal(graph)
    with pytest.raises(mod.RedisError, match='Division by zero'):
        glb._run_query_raw('RETURN 10 / $z AS q')


def test_execute_user_localtime_error_stays_a_driver_error():
    graph = _FakeGraph(raise_error=mod.RedisError('Invalid time string: noon'))
    glb = _FakeGlobal(graph)
    with pytest.raises(mod.RedisError, match='Invalid time string: noon'):
        glb._run_query_raw("RETURN localtime('noon') AS t")


def test_execute_return_star_is_refused():
    """RETURN * has no names to cap, so it never reaches the server."""
    graph = _FakeGraph()
    glb = _FakeGlobal(graph)
    with pytest.raises(ValueError, match='name the returned columns'):
        glb._run_query_raw('MATCH (n) RETURN *')
    assert graph.calls == []


class _PlanOp:
    """The fields of falkordb.execution_plan.Operation that execute reads."""

    def __init__(self, name, children=None, args=None):
        self.name = name
        self.children = children or []
        self.args = args


class _Plan:
    def __init__(self, root):
        self.structured_plan = root


def test_execute_grammar_miss_without_rows_is_sent_unchanged():
    """CREATE INDEX, FOREACH, and LOAD CSV used to run, and still do."""
    # No Project operator: the command returns no rows.
    plan = _Plan(_PlanOp('ProcedureCall', args='db.idx.fulltext.createNodeIndex'))
    statements = [
        'CREATE INDEX FOR (p:Person) ON (p.name)',
        'CREATE INDEX ON :Person(name)',
        'MATCH (n) FOREACH (x IN [1,2] | SET n.v = x)',
        'LOAD CSV FROM "file:///tmp/a.csv" AS row CREATE (n:Item {id: row.id})',
    ]
    for statement in statements:
        graph = _FakeGraph(explain_plan=plan)
        glb = _FakeGlobal(graph)
        glb._run_query_raw(statement)
        assert graph.calls[0][0] == 'explain'
        assert graph.calls[1] == ('query', statement, None, glb.query_timeout_ms)


def test_execute_call_subquery_is_capped_from_the_plan():
    """A CALL {} the grammar rejects still runs, with the cap, when EXPLAIN names columns."""
    # Same shape ExecutionPlan builds: the column is a Project child, and the
    # producer hangs under that column.
    plan = _Plan(_PlanOp('Results', [_PlanOp('Project', [_PlanOp('i', [_PlanOp('Apply')])])]))
    statement = 'MATCH (n) CALL { WITH n RETURN n.id AS i } RETURN i'
    graph = _FakeGraph(_FakeResult(result_set=[[1]], header=[[1, 'i']]), explain_plan=plan)
    glb = _FakeGlobal(graph)
    glb._run_query_raw(statement, params={'name': 'Ada'})
    assert graph.calls[0] == ('explain', statement, {'name': 'Ada'}, None)
    assert graph.calls[1][0] == 'query'
    assert 'collect([`i`])' in graph.calls[1][1]
    assert graph.calls[1][2] == {'name': 'Ada'}


def test_execute_explain_failure_does_not_block_a_falkordb_command():
    graph = _FakeGraph(explain_error=mod.RedisError('EXPLAIN failed'))
    glb = _FakeGlobal(graph)
    statement = 'CREATE INDEX FOR (p:Person) ON (p.name)'
    glb._run_query_raw(statement)
    assert graph.calls[1] == ('query', statement, None, glb.query_timeout_ms)


def test_execute_old_server_maps_a_rejected_wrapper():
    graph = _FakeGraph(raise_error=mod.RedisError("Invalid input '{': expected a clause (line: 1, column: 6)"))
    glb = _FakeGlobal(graph)
    with pytest.raises(ValueError, match='FalkorDB 4.0'):
        glb._run_query_raw('RETURN 1 AS n')


def test_execute_user_syntax_error_inside_the_wrapper_stays_a_driver_error():
    graph = _FakeGraph(raise_error=mod.RedisError("Invalid input '(': expected an expression (line: 3, column: 8)"))
    glb = _FakeGlobal(graph)
    with pytest.raises(mod.RedisError, match='line: 3'):
        glb._run_query_raw('RETURN 1 AS n')


# ---------------------------------------------------------------------------
# Connection profiles: manual (host/port) and URL
# ---------------------------------------------------------------------------


class _RecordingFalkorDB:
    """Captures how the driver was asked to connect, without opening a socket."""

    last_kwargs = None
    last_url = None

    def __init__(self, **kwargs):
        _RecordingFalkorDB.last_kwargs = kwargs
        _RecordingFalkorDB.last_url = None

    @classmethod
    def from_url(cls, url, **kwargs):
        instance = cls.__new__(cls)
        _RecordingFalkorDB.last_url = url
        _RecordingFalkorDB.last_kwargs = kwargs
        return instance


@pytest.fixture
def recording_client(monkeypatch):
    monkeypatch.setattr(_glb_mod, 'FalkorDB', _RecordingFalkorDB)
    _RecordingFalkorDB.last_kwargs = None
    _RecordingFalkorDB.last_url = None
    return _RecordingFalkorDB


class _GraphListingFalkorDB:
    """Fake client exposing only list_graphs(), for the #2155 graph-existence checks.

    ``graphs_to_list`` is class-level (mirroring _RecordingFalkorDB's last_kwargs/
    last_url) so a test can set it before either constructor path runs.
    """

    graphs_to_list: list = ['agent']
    raise_on_list: Exception | None = None

    def __init__(self, **kwargs):
        pass

    @classmethod
    def from_url(cls, url, **kwargs):
        return cls()

    def list_graphs(self):
        if type(self).raise_on_list is not None:
            raise type(self).raise_on_list
        return type(self).graphs_to_list

    def close(self):
        pass


@pytest.fixture
def graph_listing_client(monkeypatch):
    monkeypatch.setattr(_glb_mod, 'FalkorDB', _GraphListingFalkorDB)
    _GraphListingFalkorDB.graphs_to_list = ['agent']
    _GraphListingFalkorDB.raise_on_list = None
    return _GraphListingFalkorDB


def test_manual_profile_connects_with_host_and_port(recording_client):
    """The pre-existing profile must keep building the client from host/port."""
    _glb_mod.IGlobal._connect(
        {'mode': 'manual', 'host': 'localhost', 'port': 6379, 'username': 'u', 'password': 'p', 'tls': True}
    )

    assert recording_client.last_url is None
    assert recording_client.last_kwargs == {
        'host': 'localhost',
        'port': 6379,
        'username': 'u',
        'password': 'p',
        'ssl': True,
    }


def test_url_profile_connects_from_url(recording_client):
    url = 'falkor://falkordb:s3cret@r-6jissuruar.instance-ytljliglb.us-east-1.aws.cloud:53939'
    _glb_mod.IGlobal._connect({'mode': 'url', 'url': f'  {url}  '})

    # No password field set -> the URL is passed through untouched.
    assert recording_client.last_url == url
    assert recording_client.last_kwargs == {}


def test_password_field_replaces_the_one_embedded_in_the_url(recording_client):
    """The field is the single source of truth: redis-py must not prefer the URL."""
    _glb_mod.IGlobal._connect({'mode': 'url', 'url': 'falkor://falkordb:stale@host:53939', 'password': 'current'})

    assert recording_client.last_url == 'falkor://falkordb@host:53939'
    assert recording_client.last_kwargs == {'password': 'current'}


def test_password_field_fills_in_a_url_without_credentials(recording_client):
    _glb_mod.IGlobal._connect({'mode': 'url', 'url': 'falkor://falkordb@host:53939', 'password': 'secret'})

    assert recording_client.last_url == 'falkor://falkordb@host:53939'
    assert recording_client.last_kwargs == {'password': 'secret'}


@pytest.mark.parametrize(
    ('url', 'expected'),
    [
        # The username survives, percent-escapes and all; only the password goes.
        ('falkor://us%3Aer:p%40ss@host:6379', 'falkor://us%3Aer@host:6379'),
        # No username either — an authority that is only a password.
        ('falkor://:pw@host:6379', 'falkor://host:6379'),
        # unix:// carries its password in the query string instead.
        ('unix:///tmp/f.sock?db=0&password=pw', 'unix:///tmp/f.sock?db=0'),
        ('falkor://host:6379', 'falkor://host:6379'),
    ],
)
def test_url_without_password_strips_only_the_password(url, expected):
    assert _glb_mod._url_without_password(url) == expected


@pytest.mark.parametrize('url', ['http://host:6379', 'host:6379', 'bolt://host:7687'])
def test_url_profile_rejects_unsupported_schemes(url):
    with pytest.raises(ValueError, match='Unsupported FalkorDB URL scheme'):
        _glb_mod._connection_url({'mode': 'url', 'url': url})


def test_url_profile_requires_a_url():
    """An empty URL in the URL profile must fail, not silently hit localhost."""
    with pytest.raises(ValueError, match='FalkorDB URL is required'):
        _glb_mod._connection_url({'mode': 'url', 'url': ''})


def test_manual_profile_has_no_url():
    assert _glb_mod._connection_url({'mode': 'manual', 'host': 'localhost'}) == ''


def test_legacy_flat_config_still_uses_host_port(recording_client):
    """Pipelines saved before profiles existed carry no 'mode' key at all."""
    _glb_mod.IGlobal._connect({'host': 'db.internal', 'port': 6380})

    assert recording_client.last_url is None
    assert recording_client.last_kwargs == {'host': 'db.internal', 'port': 6380}


def test_probe_does_not_leak_url_credentials(monkeypatch, recording_client):
    """A failed probe is logged: the password in the URL must not reach the log."""
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)
    monkeypatch.setattr(
        recording_client, 'from_url', classmethod(lambda cls, url, **kw: (_ for _ in ()).throw(_StubRedisError('nope')))
    )

    glb = _FakeGlobal(_FakeGraph())
    glb._probe_connection({'mode': 'url', 'url': 'falkor://falkordb:s3cret@host:53939'})

    assert messages and 's3cret' not in messages[0]
    assert 'falkor://***@host:53939' in messages[0]


def test_probe_does_not_leak_unix_socket_password(monkeypatch, recording_client):
    """A unix:// URL carries its password in the query string, not the authority."""
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)
    monkeypatch.setattr(
        recording_client, 'from_url', classmethod(lambda cls, url, **kw: (_ for _ in ()).throw(_StubRedisError('nope')))
    )

    glb = _FakeGlobal(_FakeGraph())
    glb._probe_connection({'mode': 'url', 'url': 'unix:///tmp/f.sock?db=0&password=s3cret'})

    assert messages and 's3cret' not in messages[0]
    assert 'unix:///tmp/f.sock?db=0&password=***' in messages[0]


def test_probe_reports_missing_host_on_manual_profile(monkeypatch):
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)

    _FakeGlobal(_FakeGraph())._probe_connection({'mode': 'manual', 'host': ''})

    assert messages == ['host is required']


# ---------------------------------------------------------------------------
# #2155: a read-only node silently fell back to querying the unrelated
# default graph "agent" instead of the one actually configured, surfacing a
# cryptic "ERR Invalid graph operation on empty key" only on the first
# query. _open_driver now fails fast, and _probe_connection warns at save
# time, when the configured graph does not exist -- unless a write path is
# enabled, since FalkorDB creates a graph lazily on its first write.
# ---------------------------------------------------------------------------


def test_resolve_graph_name_falls_back_on_absent_empty_or_blank():
    assert _glb_mod._resolve_graph_name({}) == 'agent'
    assert _glb_mod._resolve_graph_name({'graph': ''}) == 'agent'
    assert _glb_mod._resolve_graph_name({'graph': '   '}) == 'agent'
    assert _glb_mod._resolve_graph_name({'graph': 'changeimpact'}) == 'changeimpact'


def test_open_driver_raises_when_the_configured_graph_is_missing(graph_listing_client):
    graph_listing_client.graphs_to_list = ['other-graph']
    glb = _FakeGlobal(_FakeGraph())

    with pytest.raises(Exception, match='FalkorDB graph "agent" does not exist.*other-graph'):
        glb._open_driver({'mode': 'manual', 'host': 'localhost', 'graph': 'agent'})


def test_open_driver_succeeds_when_the_configured_graph_exists(graph_listing_client):
    graph_listing_client.graphs_to_list = ['changeimpact', 'other']
    glb = _FakeGlobal(_FakeGraph())

    glb._open_driver({'mode': 'manual', 'host': 'localhost', 'graph': 'changeimpact'})

    assert glb.graph_name == 'changeimpact'


@pytest.mark.parametrize('flag', ['allow_writes', 'allow_execute'])
def test_open_driver_skips_the_graph_check_when_a_write_path_is_enabled(graph_listing_client, flag):
    """FalkorDB creates a graph lazily on its first write, so a write-capable
    node may legitimately target one that does not exist yet.
    """
    graph_listing_client.graphs_to_list = []  # nothing exists yet
    glb = _FakeGlobal(_FakeGraph())

    glb._open_driver({'mode': 'manual', 'host': 'localhost', 'graph': 'brand-new', flag: True})

    assert glb.graph_name == 'brand-new'  # did not raise


def test_probe_warns_when_the_configured_graph_is_missing(monkeypatch, graph_listing_client):
    graph_listing_client.graphs_to_list = ['changeimpact']
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)

    _FakeGlobal(_FakeGraph())._probe_connection({'mode': 'manual', 'host': 'localhost', 'graph': 'agent'})

    assert len(messages) == 1
    assert 'FalkorDB graph "agent" was not found' in messages[0]
    assert 'changeimpact' in messages[0]


def test_probe_is_silent_about_the_graph_when_it_already_exists(monkeypatch, graph_listing_client):
    graph_listing_client.graphs_to_list = ['agent']
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)

    _FakeGlobal(_FakeGraph())._probe_connection({'mode': 'manual', 'host': 'localhost', 'graph': 'agent'})

    assert messages == []


@pytest.mark.parametrize('flag', ['allow_writes', 'allow_execute'])
def test_probe_does_not_warn_about_a_missing_graph_when_a_write_path_is_enabled(
    monkeypatch, graph_listing_client, flag
):
    graph_listing_client.graphs_to_list = []
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)

    _FakeGlobal(_FakeGraph())._probe_connection(
        {'mode': 'manual', 'host': 'localhost', 'graph': 'brand-new', flag: True}
    )

    assert messages == []


def test_probe_still_reports_a_connection_failure_when_a_write_path_is_enabled(monkeypatch, graph_listing_client):
    """The write-capable early-out skips only the graph-existence check --
    a real connection failure must still be reported either way.
    """
    graph_listing_client.raise_on_list = _StubRedisError('connection refused')
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)

    _FakeGlobal(_FakeGraph())._probe_connection({'mode': 'manual', 'host': 'localhost', 'allow_writes': True})

    assert any('Could not connect to FalkorDB' in m for m in messages)


def test_reflect_schema_failure_does_not_break_begin(monkeypatch):
    """A driver error during reflection degrades the schema, it does not crash the node."""
    glb = _FakeGlobal(_FakeGraph())
    monkeypatch.setattr(glb, '_reflect_schema', lambda: (_ for _ in ()).throw(RuntimeError('boom')))
    monkeypatch.setattr(glb, '_open_driver', lambda config: None)
    glb.glb = types.SimpleNamespace(logicalType='graph_falkordb', connConfig={})

    graph_base.GraphGlobalBase.beginGlobal(glb)

    assert glb.graph_schema == {'nodes': {}, 'relationships': []}


# ---------------------------------------------------------------------------
# EXECUTE row cap against a real FalkorDB. Off unless a server is named:
# FALKORDB_TEST_URL, or FALKORDB_TEST_HOST and optional FALKORDB_TEST_PORT.
# ---------------------------------------------------------------------------

_LIVE_GRAPH = 'rr_execute_cap'


def _item_count(db) -> int:
    result = db.select_graph(_LIVE_GRAPH).query('MATCH (n:Item) RETURN count(n)')
    rows = result.result_set or []
    if not rows or not rows[0]:
        return 0
    return int(rows[0][0])


@pytest.fixture
def falkordb_execute(monkeypatch):
    """A real server and an IGlobal pointed at a graph this fixture deletes."""
    url = os.environ.get('FALKORDB_TEST_URL', '').strip()
    host = os.environ.get('FALKORDB_TEST_HOST', '').strip()
    if not url and not host:
        pytest.skip('set FALKORDB_TEST_URL or FALKORDB_TEST_HOST to run execute against FalkorDB')

    from redis.exceptions import RedisError as RealRedisError

    monkeypatch.setattr(_glb_mod, 'RedisError', RealRedisError)
    try:
        import falkordb
        from falkordb import FalkorDB
    except ImportError:
        pytest.skip('falkordb client is not installed')
    if 'mocks' in (getattr(falkordb, '__file__', '') or '').replace('\\', '/'):
        pytest.skip('the FalkorDB test mock is on the path; run this file without ROCKETRIDE_MOCK')

    try:
        if url:
            db = FalkorDB.from_url(url, socket_connect_timeout=1, socket_timeout=10)
        else:
            port = int(os.environ.get('FALKORDB_TEST_PORT', '6379'))
            db = FalkorDB(host=host, port=port, socket_connect_timeout=1, socket_timeout=10)
        db.list_graphs()
    except Exception as exc:
        pytest.skip(f'FalkorDB is not reachable ({exc})')

    try:
        db.select_graph(_LIVE_GRAPH).delete()
    except Exception:
        pass

    glb = _glb_mod.IGlobal()
    glb.client = db
    glb.graph_name = _LIVE_GRAPH
    glb.query_timeout_ms = 30000
    glb.max_execute_rows = 3
    glb.max_rows = 250
    glb.allow_writes = True
    try:
        yield glb, db
    finally:
        try:
            db.select_graph(_LIVE_GRAPH).delete()
        except Exception:
            pass
        db.close()


def test_live_over_cap_write_rolls_back(falkordb_execute):
    """The #2542 repro: five created nodes, cap 3, and the graph stays empty."""
    glb, db = falkordb_execute
    with pytest.raises(ValueError, match='max_execute_rows=3'):
        glb._run_query_raw('UNWIND range(1, 5) AS i CREATE (n:Item {id: i}) RETURN n.id AS id')
    assert _item_count(db) == 0


def test_live_under_cap_write_commits(falkordb_execute):
    glb, db = falkordb_execute
    out = glb._run_query_raw('UNWIND range(1, 2) AS i CREATE (n:Item {id: i}) RETURN n.id AS id')
    assert len(out['rows']) == 2
    assert _item_count(db) == 2


def test_live_null_column_is_counted_and_committed(falkordb_execute):
    glb, db = falkordb_execute
    out = glb._run_query_raw('CREATE (n:Item {id: 1}) RETURN n.id AS id, n.name AS name')
    assert out['rows'] == [{'id': 1, 'name': None}]
    assert _item_count(db) == 1


def test_live_return_star_writes_nothing(falkordb_execute):
    glb, db = falkordb_execute
    with pytest.raises(ValueError, match='name the returned columns'):
        glb._run_query_raw('CREATE (n:Item {id: 1}) RETURN *')
    assert _item_count(db) == 0


def test_live_call_subquery_over_cap_rolls_back(falkordb_execute):
    glb, db = falkordb_execute
    query = 'UNWIND range(1, 5) AS i CALL { WITH i CREATE (n:Item {id: i}) RETURN i AS i } RETURN i'
    with pytest.raises(ValueError, match='max_execute_rows=3'):
        glb._run_query_raw(query)
    assert _item_count(db) == 0


def test_live_index_and_foreach_reach_the_server(falkordb_execute):
    glb, _db = falkordb_execute
    glb._run_query_raw('CREATE INDEX FOR (p:Person) ON (p.name)')
    glb._run_query_raw('CREATE (:Person {name: "a"})')
    glb._run_query_raw('MATCH (n:Person) FOREACH (x IN [1, 2] | SET n.v = x)')
