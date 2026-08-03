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

    def explain(self, q):
        self.calls.append(('explain', q, None, None))
        if self._raise:
            raise self._raise
        return 'plan'


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


def test_execute_tool_runs_writes_when_allowed():
    graph = _FakeGraph(_FakeResult(result_set=[], header=[], nodes_created=1))
    glb = _FakeGlobal(graph)
    glb.allow_execute = True
    out = _instance(glb).execute({'query': 'CREATE (n:Person)'})
    assert graph.calls[0][0] == 'query'
    assert out['affected_rows'] == 1


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


def test_probe_reports_missing_host_on_manual_profile(monkeypatch):
    messages = []
    monkeypatch.setattr(_glb_mod, 'warning', messages.append)

    _FakeGlobal(_FakeGraph())._probe_connection({'mode': 'manual', 'host': ''})

    assert messages == ['host is required']


def test_reflect_schema_failure_does_not_break_begin(monkeypatch):
    """A driver error during reflection degrades the schema, it does not crash the node."""
    glb = _FakeGlobal(_FakeGraph())
    monkeypatch.setattr(glb, '_reflect_schema', lambda: (_ for _ in ()).throw(RuntimeError('boom')))
    monkeypatch.setattr(glb, '_open_driver', lambda config: None)
    glb.glb = types.SimpleNamespace(logicalType='graph_falkordb', connConfig={})

    graph_base.GraphGlobalBase.beginGlobal(glb)

    assert glb.graph_schema == {'nodes': {}, 'relationships': []}
