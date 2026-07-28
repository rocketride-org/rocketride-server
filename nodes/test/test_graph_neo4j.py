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

"""Tests for the Neo4J graph node.

The node derives from ``ai.common.graph``, so the real base classes are loaded
from disk with ``rocketlib`` and the ``neo4j`` driver stubbed, mirroring
``test_graph_falkordb.py``.
"""

from __future__ import annotations

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
_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'graph_neo4j'


class _StubNeo4jError(Exception):
    def __init__(self, message=''):
        super().__init__(message)
        self.message = message


class _StubServiceUnavailable(_StubNeo4jError):
    pass


class _StubAuthError(_StubNeo4jError):
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
    'neo4j',
    'neo4j.exceptions',
)


def _install_stubs() -> None:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = _StubBase
    rocketlib.IGlobalBase = _StubBase
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

    config_utils = _load_from_path('ai.common.config_utils', _CONFIG_UTILS)
    utils = types.ModuleType('ai.common.utils')
    utils.parse_bool = config_utils.parse_bool
    utils.config_int = config_utils.config_int

    neo4j = types.ModuleType('neo4j')
    neo4j.READ_ACCESS = 'READ'
    neo4j.Record = object
    neo4j.Query = lambda q, timeout=None: q
    neo4j.bearer_auth = lambda token: ('bearer', token)
    neo4j.GraphDatabase = types.SimpleNamespace(driver=lambda *a, **kw: None)
    neo4j.graph = types.SimpleNamespace(Node=object, Relationship=object)
    neo4j_exceptions = types.ModuleType('neo4j.exceptions')
    neo4j_exceptions.Neo4jError = _StubNeo4jError
    neo4j_exceptions.ServiceUnavailable = _StubServiceUnavailable
    neo4j_exceptions.AuthError = _StubAuthError
    neo4j.exceptions = neo4j_exceptions

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
            'neo4j': neo4j,
            'neo4j.exceptions': neo4j_exceptions,
        }
    )

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
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_node():
    with _scoped_stubs():
        _load_from_path('ai.common.graph', _GRAPH_PKG / '__init__.py', is_package=True)
        iglobal = _load_from_path('nodes.graph_neo4j.IGlobal', _NODE_DIR / 'IGlobal.py')
        pkg = types.ModuleType('nodes.graph_neo4j')
        pkg.__path__ = [str(_NODE_DIR)]
        pkg.IGlobal = iglobal
        sys.modules['nodes.graph_neo4j'] = pkg
        iinstance = _load_from_path('nodes.graph_neo4j.IInstance', _NODE_DIR / 'IInstance.py')
        return iglobal, iinstance


_glb_mod, mod = _load_node()
graph_base = sys.modules['ai.common.graph']


# ---------------------------------------------------------------------------
# Fakes: Bolt driver / session / result
# ---------------------------------------------------------------------------


class _FakeCounters:
    _ATTRS = (
        'nodes_created',
        'nodes_deleted',
        'relationships_created',
        'relationships_deleted',
        'properties_set',
        'labels_added',
        'labels_removed',
    )

    def __init__(self, **kw):
        for a in self._ATTRS:
            setattr(self, a, kw.get(a, 0))


class _FakeRecord:
    def __init__(self, data):
        self._data = data

    def keys(self):
        return list(self._data.keys())

    def __getitem__(self, key):
        return self._data[key]


class _FakeResult:
    def __init__(self, records=None, counters=None, raise_error=None):
        self._records = [_FakeRecord(r) for r in (records or [])]
        self._counters = counters or _FakeCounters()
        self._raise = raise_error

    def __iter__(self):
        if self._raise:
            raise self._raise
        return iter(self._records)

    def consume(self):
        if self._raise:
            raise self._raise
        return types.SimpleNamespace(counters=self._counters)


class _FakeSession:
    def __init__(self, driver):
        self._driver = driver

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, query, params=None):
        self._driver.calls.append((str(query), params))
        if self._driver.raise_error:
            raise self._driver.raise_error
        return self._driver.result


class _FakeDriver:
    def __init__(self, result=None, raise_error=None):
        self.result = result or _FakeResult()
        self.raise_error = raise_error
        self.calls = []
        self.session_kwargs = []

    def session(self, **kwargs):
        self.session_kwargs.append(kwargs)
        return _FakeSession(self)

    def verify_connectivity(self):
        pass

    def close(self):
        pass


class _FakeGlobal(_glb_mod.IGlobal):
    """The real Neo4J IGlobal with a fake Bolt driver."""

    def __init__(self, driver, *, database='neo4j'):
        self.driver = driver
        self.database = database
        self.max_execute_rows = 25000
        self.max_validation_attempts = 5
        self.allow_execute = False
        self.db_description = ''
        self.graph_schema = {'nodes': {}, 'relationships': []}


def _instance(global_state):
    inst = mod.IInstance()
    inst.IGlobal = global_state
    return inst


# ---------------------------------------------------------------------------
# _run_query: read-only gate, READ access, limit/truncation
# ---------------------------------------------------------------------------


def test_run_query_refuses_write_cypher():
    glb = _FakeGlobal(_FakeDriver())
    with pytest.raises(ValueError):
        glb._run_query('MATCH (n) DELETE n')
    # The unsafe query must never reach the driver.
    assert glb.driver.calls == []


def test_run_query_uses_read_access_mode():
    driver = _FakeDriver(_FakeResult(records=[{'name': 'Alice'}]))
    glb = _FakeGlobal(driver)
    rows = glb._run_query('MATCH (n) RETURN n.name AS name')
    assert rows == [{'name': 'Alice'}]
    assert driver.session_kwargs[0].get('default_access_mode') == 'READ'


def test_run_query_returns_one_past_limit_for_truncation():
    records = [{'n': i} for i in range(10)]
    glb = _FakeGlobal(_FakeDriver(_FakeResult(records=records)))
    rows = glb._run_query('MATCH (n) RETURN n', limit=3)
    # limit+1 rows so the caller can detect truncation.
    assert len(rows) == 4


def test_run_query_without_limit_falls_back_to_read_row_cap():
    records = [{'n': i} for i in range(10)]
    glb = _FakeGlobal(_FakeDriver(_FakeResult(records=records)))
    glb.max_execute_rows = 4  # read_row_cap defaults to this
    # The pipeline `questions` lane calls with no limit; it must not stream
    # the whole result set into worker memory.
    assert len(glb._run_query('MATCH (n) RETURN n')) == 4


def test_run_query_clamps_limit_to_read_row_cap():
    records = [{'n': i} for i in range(10)]
    glb = _FakeGlobal(_FakeDriver(_FakeResult(records=records)))
    glb.max_execute_rows = 2
    # A caller limit above the cap cannot lift it: cap+1 rows at most.
    assert len(glb._run_query('MATCH (n) RETURN n', limit=9)) == 3


# ---------------------------------------------------------------------------
# _run_query_raw: EXECUTE path, affected_rows counted unconditionally
# ---------------------------------------------------------------------------


def test_affected_rows_counted_even_when_write_returns_rows():
    # CREATE (n) RETURN n writes AND returns a row — affected_rows must not be 0.
    result = _FakeResult(records=[{'n': 'Alice'}], counters=_FakeCounters(nodes_created=1, properties_set=1))
    glb = _FakeGlobal(_FakeDriver(result))
    out = glb._run_query_raw('CREATE (n:Person {name: "Alice"}) RETURN n')
    assert out['rows']
    assert out['affected_rows'] == 2  # would have been 0 before the fix


def test_execute_raw_caps_at_max_execute_rows():
    glb = _FakeGlobal(_FakeDriver(_FakeResult(records=[{'n': i} for i in range(10)])))
    glb.max_execute_rows = 3
    with pytest.raises(ValueError, match='max_execute_rows'):
        glb._run_query_raw('MATCH (n) RETURN n')


# ---------------------------------------------------------------------------
# _validate_query: EXPLAIN
# ---------------------------------------------------------------------------


def test_validate_query_runs_explain():
    driver = _FakeDriver(_FakeResult())
    ok, err = _FakeGlobal(driver)._validate_query('MATCH (n) RETURN n')
    assert ok is True and err == ''
    assert driver.calls[0][0].startswith('EXPLAIN ')


def test_validate_query_reports_error():
    driver = _FakeDriver(raise_error=_StubNeo4jError('syntax error'))
    ok, err = _FakeGlobal(driver)._validate_query('MATCH (n RETURN n')
    assert ok is False and 'syntax error' in err


# ---------------------------------------------------------------------------
# Tool surface: dialect, get_cypher alias, get_schema label filter
# ---------------------------------------------------------------------------


def test_dialect_reports_neo4j():
    inst = _instance(_FakeGlobal(_FakeDriver()))
    assert inst.dialect({}) == {'dialect': 'neo4j'}


def test_get_cypher_is_alias_for_get_query():
    inst = _instance(_FakeGlobal(_FakeDriver()))
    seen = {}

    def _fake_get_query(args):
        seen['args'] = args
        return {'query': 'MATCH (n) RETURN n', 'valid': True}

    inst.get_query = _fake_get_query
    out = inst.get_cypher({'question': 'all nodes'})
    # The old tool returned the statement under `cypher`; keep that key working
    # for agents written against it, without dropping get_query's `query`.
    assert out == {'query': 'MATCH (n) RETURN n', 'cypher': 'MATCH (n) RETURN n', 'valid': True}
    assert seen['args'] == {'question': 'all nodes'}


def test_get_cypher_passes_through_non_query_replies():
    inst = _instance(_FakeGlobal(_FakeDriver()))
    # The not-a-graph-question path has no `query` key, so there is nothing to
    # mirror and no empty `cypher` should be invented.
    inst.get_query = lambda args: {'answer': 'I am a teapot', 'valid': False}
    assert inst.get_cypher({'question': 'hi'}) == {'answer': 'I am a teapot', 'valid': False}


def test_get_schema_filters_by_label():
    glb = _FakeGlobal(_FakeDriver())
    glb.graph_schema = {
        'nodes': {'Person': [('name', 'STRING')], 'City': [('name', 'STRING')]},
        'relationships': [{'type': 'LIVES_IN', 'start': 'Person', 'end': 'City'}],
    }
    out = _instance(glb).get_schema({'label': 'Person'})
    assert out['labels'] == ['Person']
    assert 'City' not in out['nodes']
    assert out['database'] == 'neo4j'


def test_get_schema_unknown_label_returns_error():
    glb = _FakeGlobal(_FakeDriver())
    glb.graph_schema = {'nodes': {'Person': []}, 'relationships': []}
    out = _instance(glb).get_schema({'label': 'Ghost'})
    assert 'error' in out


def test_get_schema_unwraps_input_envelope():
    glb = _FakeGlobal(_FakeDriver())
    glb.graph_schema = {'nodes': {'Person': [('name', 'STRING')]}, 'relationships': []}
    out = _instance(glb).get_schema({'input': {'label': 'Person'}})
    assert out['labels'] == ['Person']


# ---------------------------------------------------------------------------
# get_data: limit clamped, truncation honest
# ---------------------------------------------------------------------------


def test_get_data_enforces_limit_and_flags_truncation():
    glb = _FakeGlobal(_FakeDriver(_FakeResult(records=[{'n': i} for i in range(10)])))
    inst = _instance(glb)
    inst.get_query = lambda args: {'query': 'MATCH (n) RETURN n', 'valid': True}
    out = inst.get_data({'question': 'all nodes', 'limit': 3})
    assert out['valid'] is True
    assert len(out['rows']) == 3
    assert out['truncated'] is True
