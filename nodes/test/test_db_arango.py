# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the db_arango node (no network).

Loads the real utils / IGlobal / IInstance modules with the engine runtime and
the python-arango driver stubbed, then exercises:
  - utils: the read-only AQL safety gate, isValid parsing, namespace stripping
  - IGlobal: collection-type/json-type helpers, the safety gate inside _run_query,
    the EXECUTE row cap, EXPLAIN-based validation, and schema reflection
  - IInstance: the three tool functions, the lane handlers (QUESTION/EXECUTE/
    DIALECT), limit clamping, and markdown formatting
All driver interaction is faked at the instance level — nothing hits a network.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

# ---------------------------------------------------------------------------
# Capture lists for the stubbed loggers.
# ---------------------------------------------------------------------------

_WARNING_CALLS: list[str] = []
_ERROR_CALLS: list[str] = []


def _reset_logs() -> None:
    _WARNING_CALLS.clear()
    _ERROR_CALLS.clear()


def _stub_warning(msg, *_a, **_k) -> None:
    _WARNING_CALLS.append(str(msg))


def _stub_error(msg, *_a, **_k) -> None:
    _ERROR_CALLS.append(str(msg))


# ---------------------------------------------------------------------------
# Stub doubles for the engine schema/table types and the arango driver.
# ---------------------------------------------------------------------------


class _StubArangoClient:
    def __init__(self, *_a, **_k) -> None:
        pass

    def db(self, *_a, **_k):
        return SimpleNamespace()

    def close(self) -> None:
        pass


class _StubAnswer:
    def __init__(self) -> None:
        self.value = None

    def setAnswer(self, value) -> None:
        self.value = value


class _StubQuestion:
    def __init__(self, *_a, **kwargs) -> None:
        self.type = kwargs.get('type')
        self.role = kwargs.get('role')
        self.questions: list = []
        self.contexts: list = []
        self.instructions: list = []
        self.examples: list = []
        self.expectJson = False

    def addQuestion(self, text) -> None:
        self.questions.append(SimpleNamespace(text=text))

    def addContext(self, ctx) -> None:
        self.contexts.append(ctx)

    def addInstruction(self, *args) -> None:
        self.instructions.append(args)

    def addExample(self, *args) -> None:
        self.examples.append(args)


_QTYPE = SimpleNamespace(QUESTION='QUESTION', DIALECT='DIALECT', EXECUTE='EXECUTE')


class _StubTable:
    @staticmethod
    def generate_markdown_table(data, headers=None) -> str:
        return f'MD|headers={headers}|rows={len(data)}'


def _build_import_stubs() -> dict:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib.warning = _stub_warning
    rocketlib.error = _stub_error
    rocketlib.debug = lambda *_a, **_k: None

    rocketlib_types = types.ModuleType('rocketlib.types')
    rocketlib_types.IInvokeLLM = SimpleNamespace(Ask=lambda **kwargs: SimpleNamespace(**kwargs))

    arango = types.ModuleType('arango')
    arango.ArangoClient = _StubArangoClient
    arango_exc = types.ModuleType('arango.exceptions')
    _ArangoError = type('ArangoError', (Exception,), {})
    arango_exc.ArangoError = _ArangoError
    arango_exc.ServerConnectionError = type('ServerConnectionError', (_ArangoError,), {})
    arango.exceptions = arango_exc

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = SimpleNamespace(getNodeConfig=lambda *_a, **_k: {})
    ai_schema = types.ModuleType('ai.common.schema')
    ai_schema.Answer = _StubAnswer
    ai_schema.Question = _StubQuestion
    ai_schema.QuestionType = _QTYPE
    ai_table = types.ModuleType('ai.common.table')
    ai_table.Table = _StubTable

    return {
        'rocketlib': rocketlib,
        'rocketlib.types': rocketlib_types,
        'arango': arango,
        'arango.exceptions': arango_exc,
        'ai': ai_pkg,
        'ai.common': ai_common,
        'ai.common.config': ai_config,
        'ai.common.schema': ai_schema,
        'ai.common.table': ai_table,
    }


_NODE_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'db_arango'


def _load_node():
    """Load utils → IGlobal → IInstance as a db_arango package against forced stubs.

    The stubs are installed unconditionally (overwriting any real modules already in
    sys.modules) so the node binds our doubles even under the full ``builder nodes:test``
    session, where other nodes have already imported the real rocketlib / ai.common
    modules. Originals are restored right after the load, so nothing leaks into the
    shared session and other nodes' tests are unaffected.
    """
    saved: dict = {}
    # Preserve any real db_arango* modules already imported (e.g. by the contract
    # suite) so the scaffold cleanup below restores them rather than dropping them.
    saved_db_arango = {
        name: module
        for name, module in list(sys.modules.items())
        if name == 'db_arango' or name.startswith('db_arango.')
    }
    for name, stub in _build_import_stubs().items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    scaffold: list[str] = []
    pkg = types.ModuleType('db_arango')
    pkg.__path__ = [str(_NODE_DIR)]
    pkg.__package__ = 'db_arango'
    sys.modules['db_arango'] = pkg
    scaffold.append('db_arango')

    def _load(sub: str):
        spec = importlib.util.spec_from_file_location(
            f'db_arango.{sub}', _NODE_DIR / f'{sub}.py', submodule_search_locations=[str(_NODE_DIR)]
        )
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = 'db_arango'
        sys.modules[f'db_arango.{sub}'] = mod
        scaffold.append(f'db_arango.{sub}')
        spec.loader.exec_module(mod)
        setattr(pkg, sub, mod)
        return mod

    try:
        utils = _load('utils')
        iglobal = _load('IGlobal')
        iinstance = _load('IInstance')
    finally:
        for name in scaffold:
            sys.modules.pop(name, None)
        for name, module in saved_db_arango.items():
            sys.modules[name] = module
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original

    return utils, iglobal, iinstance


_UTILS, _IG, _II = _load_node()
# Rebind loggers to our capture stubs (belt-and-suspenders; they bound at import).
_IG.warning = _stub_warning
_IG.error = _stub_error
_II.warning = _stub_warning
_II.error = _stub_error

# Public handles under test.
_is_aql_safe = _UTILS._is_aql_safe
_parse_is_valid = _UTILS._parse_is_valid
_plan_is_modification = _UTILS._plan_is_modification
_plan_nodes = _UTILS._plan_nodes
IGlobal = _IG.IGlobal
ArangoError = _IG.ArangoError
_json_type = _IG._json_type
_is_edge_collection = _IG._is_edge_collection
_affected_rows = _IG._affected_rows
IInstance = _II.IInstance
_clamp_limit = _II._clamp_limit


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, rows, stats=None) -> None:
        self._rows = rows
        self._stats = stats

    def __iter__(self):
        return iter(self._rows)

    def statistics(self):
        if isinstance(self._stats, Exception):
            raise self._stats
        return self._stats or {}


class _FakeInstance:
    def __init__(self, listeners=('text', 'table', 'answers'), invoke_answer=None) -> None:
        self._listeners = set(listeners)
        self._invoke_answer = invoke_answer
        self.texts: list = []
        self.tables: list = []
        self.answers: list = []
        self.invoked: list = []

    def getListeners(self):
        return self._listeners

    def writeText(self, text):
        self.texts.append(text)

    def writeTable(self, table):
        self.tables.append(table)

    def writeAnswers(self, answer):
        self.answers.append(answer)

    def invoke(self, payload):
        self.invoked.append(payload)
        if isinstance(self._invoke_answer, Exception):
            raise self._invoke_answer
        return SimpleNamespace(answer=self._invoke_answer)


def _make_instance(ig=None, instance=None) -> IInstance:
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = ig if ig is not None else SimpleNamespace()
    inst.instance = instance if instance is not None else _FakeInstance()
    return inst


def _fake_ig(**overrides):
    base = dict(
        max_validation_attempts=1,
        db_description='',
        database='_system',
        allow_execute=False,
        graph_schema={'collections': {}, 'graphs': [], 'views': []},
        _validate_query=lambda aql: (True, ''),
        _run_query=lambda aql, *a, **k: [{'name': 'Alice'}],
        _run_query_raw=lambda aql, *a, **k: {'rows': [], 'affected_rows': 0},
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# =============================================================================
# (a) utils — read-only AQL safety gate
# =============================================================================


class TestAqlSafety:
    @pytest.mark.parametrize(
        'query',
        [
            'FOR u IN users RETURN u',
            "FOR u IN users FILTER u.state == 'CA' LIMIT 5 RETURN u",
            'FOR v, e, p IN 1..3 OUTBOUND "users/1" knows RETURN p',
            'RETURN 1',
            'FOR u IN users RETURN u.inserted_at',  # 'inserted_at' must not trip INSERT
            'FOR u IN users RETURN u.update',  # attribute named like a keyword (read)
            'FOR u IN users RETURN { x: u.remove }',  # keyword-named attribute in an object literal
            'FOR d IN c RETURN d.replace',  # compound attribute access, not a REPLACE clause
        ],
    )
    def test_read_only_queries_are_safe(self, query):
        assert _is_aql_safe(query) is True

    @pytest.mark.parametrize(
        'query',
        [
            'INSERT {name: "x"} INTO users',
            'FOR u IN users UPDATE u WITH {seen: true} IN users',
            'FOR u IN users REPLACE u WITH {} IN users',
            'FOR u IN users REMOVE u IN users',
            'UPSERT {a: 1} INSERT {a: 1} UPDATE {a: 2} IN users',
        ],
    )
    def test_write_queries_are_unsafe(self, query):
        assert _is_aql_safe(query) is False

    def test_safety_is_case_insensitive(self):
        assert _is_aql_safe('insert {a:1} into users') is False

    def test_modification_keyword_in_comment_is_ignored(self):
        assert _is_aql_safe('FOR u IN users RETURN u // then INSERT later') is True
        assert _is_aql_safe('/* REMOVE everything */ FOR u IN users RETURN u') is True

    def test_keyword_inside_string_literal_is_safe(self):
        assert _is_aql_safe("FOR d IN c FILTER d.status == 'INSERT' RETURN d") is True

    def test_slashslash_in_string_does_not_hide_write_keyword(self):
        # A // inside a string (e.g. a URL) must not let a trailing write keyword slip past.
        assert _is_aql_safe('FOR d IN c FILTER d.url == "http://x" REMOVE d IN c') is False


class TestParseIsValid:
    @pytest.mark.parametrize('value', [True, 'true', 'True', 'TRUE'])
    def test_truthy(self, value):
        assert _parse_is_valid(value) is True

    @pytest.mark.parametrize('value', [False, 'false', 'no', None, 0, 'yes'])
    def test_falsy(self, value):
        assert _parse_is_valid(value) is False


# =============================================================================
# (b) IGlobal — helpers, safety gate, caps, validation, reflection
# =============================================================================


class TestJsonType:
    @pytest.mark.parametrize(
        'value,expected',
        [
            (None, 'null'),
            (True, 'bool'),
            (5, 'int'),
            (1.5, 'double'),
            ('x', 'string'),
            ([1], 'array'),
            ({'a': 1}, 'object'),
        ],
    )
    def test_json_type(self, value, expected):
        assert _json_type(value) == expected


class TestIsEdgeCollection:
    @pytest.mark.parametrize(
        'info,expected',
        [
            ({'type': 'edge'}, True),
            ({'type': 'document'}, False),
            ({'type': 3}, True),
            ({'type': 2}, False),
            ({}, False),
        ],
    )
    def test_is_edge(self, info, expected):
        assert _is_edge_collection(info) is expected


class TestAffectedRows:
    def test_modified_key_real_python_arango(self):
        # python-arango Cursor.statistics() reports the write count as 'modified'
        # (verified against a live ArangoDB 3.12).
        assert _affected_rows(_FakeCursor([], {'modified': 3})) == 3

    def test_snake_case_key(self):
        assert _affected_rows(_FakeCursor([], {'writes_executed': 7})) == 7

    def test_camel_case_fallback(self):
        assert _affected_rows(_FakeCursor([], {'writesExecuted': 4})) == 4

    def test_missing_is_zero(self):
        assert _affected_rows(_FakeCursor([], {})) == 0

    def test_statistics_error_is_zero(self):
        assert _affected_rows(_FakeCursor([], RuntimeError('boom'))) == 0


class TestRunQuery:
    def test_unsafe_query_raises_without_executing(self):
        # The keyword scan flags the REMOVE clause; the EXPLAIN-plan gate then
        # confirms it modifies data -> refused before any execute runs.
        executed = []
        ig = IGlobal.__new__(IGlobal)
        ig.db = SimpleNamespace(
            aql=SimpleNamespace(
                explain=lambda aql: _plan('EnumerateCollectionNode', 'RemoveNode', 'ReturnNode'),
                execute=lambda *a, **k: executed.append(1) or iter([]),
            )
        )
        with pytest.raises(ValueError, match='unsafe'):
            ig._run_query('FOR u IN users REMOVE u IN users')
        assert executed == []  # safety gate ran before any execute

    def test_collection_named_like_keyword_executes(self):
        # A read against a collection named 'replace' trips the keyword scan, but the
        # EXPLAIN-plan gate sees no modification node, so the read executes (not refused).
        executed = []
        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 100
        ig.db = SimpleNamespace(
            aql=SimpleNamespace(
                explain=lambda aql: _plan('EnumerateCollectionNode', 'ReturnNode'),
                execute=lambda *a, **k: executed.append(1) or iter([{'d': 1}]),
            )
        )
        assert ig._run_query('FOR d IN replace RETURN d') == [{'d': 1}]
        assert executed == [1]  # the precise gate let the read through

    def test_safe_query_executes_and_returns_rows(self):
        ig = IGlobal.__new__(IGlobal)
        ig.db = SimpleNamespace(aql=SimpleNamespace(execute=lambda *a, **k: iter([{'x': 1}, {'x': 2}])))
        assert ig._run_query('FOR u IN users RETURN u') == [{'x': 1}, {'x': 2}]


class TestRunQueryRaw:
    def test_row_cap_exceeded_raises(self):
        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 2
        ig.db = SimpleNamespace(
            aql=SimpleNamespace(execute=lambda *a, **k: _FakeCursor([{'a': 1}, {'a': 2}, {'a': 3}]))
        )
        with pytest.raises(ValueError, match='max_execute_rows'):
            ig._run_query_raw('FOR u IN users RETURN u')

    def test_exactly_max_rows_returned_without_raising(self):
        # Boundary: a cursor of exactly max_execute_rows is returned, not rejected
        # (the cap check runs before the append, so no extra row is held).
        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 2
        ig.db = SimpleNamespace(aql=SimpleNamespace(execute=lambda *a, **k: _FakeCursor([{'a': 1}, {'a': 2}])))
        out = ig._run_query_raw('FOR u IN users RETURN u')
        assert out['rows'] == [{'a': 1}, {'a': 2}]

    def test_affected_rows_when_no_rows_returned(self):
        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 100
        ig.db = SimpleNamespace(aql=SimpleNamespace(execute=lambda *a, **k: _FakeCursor([], {'modified': 5})))
        out = ig._run_query_raw('INSERT {a:1} INTO users')
        assert out == {'rows': [], 'affected_rows': 5}

    def test_memory_limit_passed_to_execute(self):
        captured = {}

        def _execute(aql, **kwargs):
            captured.update(kwargs)
            return _FakeCursor([])

        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 100
        ig.db = SimpleNamespace(aql=SimpleNamespace(execute=_execute))
        ig._run_query_raw('FOR u IN users RETURN u')
        assert captured['memory_limit'] == IGlobal.QUERY_MEMORY_LIMIT
        assert captured['max_runtime'] == IGlobal.QUERY_MAX_RUNTIME


class TestValidateQuery:
    def test_explain_success(self):
        ig = IGlobal.__new__(IGlobal)
        ig.db = SimpleNamespace(aql=SimpleNamespace(explain=lambda aql: {'nodes': []}))
        assert ig._validate_query('FOR u IN users RETURN u') == (True, '')

    def test_explain_error_returns_message(self):
        def _raise(_aql):
            raise ArangoError('syntax error, unexpected RETURN')

        ig = IGlobal.__new__(IGlobal)
        ig.db = SimpleNamespace(aql=SimpleNamespace(explain=_raise))
        ok, msg = ig._validate_query('FOR RETURN')
        assert ok is False
        assert 'syntax error' in msg


class TestReflectSchema:
    def _ig_with_collections(self, collections, docs):
        ig = IGlobal.__new__(IGlobal)

        def _collection(name):
            return SimpleNamespace(
                find=lambda *a, **k: iter(docs.get(name, [])),
                indexes=lambda: [],
            )

        ig.db = SimpleNamespace(
            collections=lambda: collections,
            collection=_collection,
            graphs=lambda: [],
            views=lambda: [],
        )
        return ig

    def test_skips_system_collections_and_classifies_types(self):
        collections = [
            {'name': '_jobs', 'system': True, 'type': 'document'},
            {'name': '_apps', 'system': False, 'type': 'document'},  # leading underscore
            {'name': 'users', 'system': False, 'type': 'document'},
            {'name': 'knows', 'system': False, 'type': 'edge'},
        ]
        docs = {
            'users': [{'_key': '1', 'name': 'Alice', 'age': 30, 'active': True}],
            'knows': [{'_from': 'users/1', '_to': 'users/2', 'since': 2020}],
        }
        ig = self._ig_with_collections(collections, docs)
        schema = ig._reflect_schema()

        assert set(schema['collections']) == {'users', 'knows'}
        assert schema['collections']['users']['type'] == 'document'
        assert schema['collections']['knows']['type'] == 'edge'
        assert schema['graphs'] == [] and schema['views'] == []

    def test_samples_field_names_and_types(self):
        collections = [{'name': 'users', 'system': False, 'type': 'document'}]
        docs = {'users': [{'name': 'Alice', 'age': 30, 'active': True}]}
        ig = self._ig_with_collections(collections, docs)
        fields = dict(ig._reflect_schema()['collections']['users']['fields'])
        assert fields['name'] == 'string'
        assert fields['age'] == 'int'
        assert fields['active'] == 'bool'

    def test_collections_error_degrades_to_empty(self):
        _reset_logs()
        ig = IGlobal.__new__(IGlobal)

        def _boom():
            raise ArangoError('not authorized')

        ig.db = SimpleNamespace(collections=_boom)
        schema = ig._reflect_schema()
        assert schema == {'collections': {}, 'graphs': [], 'views': []}
        assert any('reflection failed' in w for w in _WARNING_CALLS)


class TestBeginGlobalClamps:
    def _begin_with(self, cfg):
        ig = IGlobal.__new__(IGlobal)
        ig.glb = SimpleNamespace(logicalType='db_arango', connConfig={})
        ig._open_database = lambda *a, **k: SimpleNamespace(aql=SimpleNamespace(execute=lambda *a, **k: iter([])))
        ig._reflect_schema = lambda: {'collections': {}, 'graphs': [], 'views': []}
        orig = _IG.Config.getNodeConfig
        _IG.Config.getNodeConfig = lambda *a, **k: cfg
        try:
            ig.beginGlobal()
        finally:
            _IG.Config.getNodeConfig = orig
        return ig

    def test_clamps_upper_bounds(self):
        # Non-UI configs bypass the services.json bounds, so beginGlobal clamps at runtime.
        ig = self._begin_with(
            {'endpoint': 'http://x:8529', 'database': 'd', 'max_attempts': 9999, 'max_execute_rows': 10**9}
        )
        assert ig.max_validation_attempts == 20
        assert ig.max_execute_rows == 1_000_000

    def test_clamps_lower_bounds(self):
        ig = self._begin_with({'endpoint': 'http://x:8529', 'database': 'd', 'max_attempts': 0, 'max_execute_rows': 0})
        assert ig.max_validation_attempts == 1
        assert ig.max_execute_rows == 1


# =============================================================================
# (c) IInstance — tools, lanes, clamping, formatting
# =============================================================================


class TestClampLimit:
    def test_none_defaults_to_250(self):
        assert _clamp_limit(None) == 250

    def test_clamps_to_max(self):
        assert _clamp_limit(10**9) == 25000

    def test_floor_is_one(self):
        assert _clamp_limit(0) == 1
        assert _clamp_limit(-5) == 1

    def test_non_numeric_defaults(self):
        assert _clamp_limit('abc') == 250


class TestGetAql:
    def test_missing_question_raises(self):
        inst = _make_instance(ig=_fake_ig())
        with pytest.raises(ValueError, match='question'):
            inst.get_aql({})

    def test_valid_safe_query(self):
        ig = _fake_ig()
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users LIMIT 5 RETURN u'}),
        )
        out = inst.get_aql({'question': 'show users'})
        assert out == {'aql': 'FOR u IN users LIMIT 5 RETURN u', 'valid': True}

    def test_write_query_rejected_by_explain_plan(self):
        # A generated write is rejected by the authoritative EXPLAIN-plan gate (not
        # the keyword scan), so get_aql reports valid:False with the modification error.
        ig = _fake_ig(
            max_validation_attempts=2,
            _validate_query=lambda aql: (False, 'Query performs data modification; this node is read-only.'),
        )
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users REMOVE u IN users'}),
        )
        out = inst.get_aql({'question': 'delete all users'})
        assert out['valid'] is False
        assert 'modification' in out['error'].lower()

    def test_off_topic_returns_answer(self):
        ig = _fake_ig()
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'false', 'query': 'The Visigoths sacked Rome in 410 AD.'}),
        )
        out = inst.get_aql({'question': 'when was Rome sacked?'})
        assert out == {'answer': 'The Visigoths sacked Rome in 410 AD.', 'valid': False}

    def test_exhausted_validation_returns_error_not_valid(self):
        # EXPLAIN rejects the query every attempt -> it is NOT valid; get_aql must
        # surface the error and never report valid:True (nor pass the broken query
        # off as a plain-text answer).
        ig = _fake_ig(max_validation_attempts=2, _validate_query=lambda aql: (False, 'syntax error near RETURN'))
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users RETURN u'}),
        )
        out = inst.get_aql({'question': 'show users'})
        assert out['valid'] is False
        assert 'syntax error' in out.get('error', '')
        assert 'answer' not in out


class TestGetData:
    def test_missing_question_raises(self):
        inst = _make_instance(ig=_fake_ig())
        with pytest.raises(ValueError, match='question'):
            inst.get_data({})

    def test_happy_path_returns_rows(self):
        ig = _fake_ig(_run_query=lambda aql, *a, **k: [{'name': 'Alice'}])
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users LIMIT 5 RETURN u'}),
        )
        out = inst.get_data({'question': 'show users'})
        assert out['rows'] == [{'name': 'Alice'}]
        assert out['aql'] == 'FOR u IN users LIMIT 5 RETURN u'
        assert out['row_limit'] == 250

    def test_respects_limit_after_execution(self):
        ig = _fake_ig(_run_query=lambda aql, *a, **k: [{'i': i} for i in range(5)])
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users RETURN u'}),
        )
        out = inst.get_data({'question': 'show', 'limit': 2})
        assert len(out['rows']) == 2
        assert out['row_limit'] == 2

    def test_invalid_generation_short_circuits(self):
        ig = _fake_ig()
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'false', 'query': 'not a query'}),
        )
        out = inst.get_data({'question': 'hi'})
        assert out['valid'] is False
        assert 'rows' not in out

    def test_execution_error_returned_as_dict(self):
        def _boom(aql, *a, **k):
            raise ArangoError('collection not found')

        ig = _fake_ig(_run_query=_boom)
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN nope RETURN u'}),
        )
        out = inst.get_data({'question': 'show'})
        assert out['rows'] == []
        assert 'collection not found' in out['error']


class TestGetSchema:
    def _schema(self):
        return {
            'collections': {
                'users': {'type': 'document', 'fields': [('name', 'string'), ('age', 'int')]},
                'knows': {'type': 'edge', 'fields': [('_from', 'string'), ('_to', 'string')]},
            },
            'graphs': [{'name': 'social'}],
            'views': [{'name': 'search_view'}],
        }

    def test_returns_full_schema(self):
        ig = _fake_ig(graph_schema=self._schema())
        inst = _make_instance(ig=ig)
        out = inst.get_schema({})
        assert out['database'] == '_system'
        assert set(out['collections']) == {'users', 'knows'}
        assert out['collections']['users']['fields'][0] == {'field': 'name', 'type': 'string'}
        assert out['graphs'] == [{'name': 'social'}]
        assert out['views'] == [{'name': 'search_view'}]

    def test_collection_filter_hit(self):
        ig = _fake_ig(graph_schema=self._schema())
        inst = _make_instance(ig=ig)
        out = inst.get_schema({'collection': 'users'})
        assert set(out['collections']) == {'users'}

    def test_collection_filter_miss(self):
        ig = _fake_ig(graph_schema=self._schema())
        inst = _make_instance(ig=ig)
        out = inst.get_schema({'collection': 'ghost'})
        assert 'not found' in out['error']

    def test_non_dict_args_raises(self):
        inst = _make_instance(ig=_fake_ig(graph_schema=self._schema()))
        with pytest.raises(ValueError):
            inst.get_schema(['oops'])


class TestWriteQuestions:
    def _question(self, qtype, text='show users'):
        return SimpleNamespace(type=qtype, questions=[SimpleNamespace(text=text)])

    def test_dialect_emits_arango(self):
        inst = _make_instance(ig=_fake_ig(), instance=_FakeInstance())
        inst.writeQuestions(self._question(_QTYPE.DIALECT))
        assert len(inst.instance.answers) == 1
        assert json.loads(inst.instance.answers[0].value) == {'dialect': 'arango'}

    def test_execute_disabled_warns_and_skips(self):
        _reset_logs()
        inst = _make_instance(ig=_fake_ig(allow_execute=False), instance=_FakeInstance())
        inst.writeQuestions(self._question(_QTYPE.EXECUTE, text='FOR u IN users RETURN u'))
        assert inst.instance.answers == []
        assert any('EXECUTE is disabled' in w for w in _WARNING_CALLS)

    def test_execute_enabled_runs_raw(self):
        ig = _fake_ig(
            allow_execute=True,
            _run_query_raw=lambda aql, *a, **k: {'rows': [{'a': 1}], 'affected_rows': 0},
        )
        inst = _make_instance(ig=ig, instance=_FakeInstance())
        inst.writeQuestions(self._question(_QTYPE.EXECUTE, text='FOR u IN users RETURN u'))
        assert inst.instance.tables  # a markdown table was written
        assert inst.instance.answers

    def test_question_happy_path_writes_all_lanes(self):
        ig = _fake_ig(_run_query=lambda aql, *a, **k: [{'name': 'Alice'}])
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users LIMIT 5 RETURN u'}),
        )
        inst.writeQuestions(self._question(_QTYPE.QUESTION))
        assert inst.instance.texts
        assert inst.instance.tables
        assert inst.instance.answers

    def test_exhausted_validation_emits_error_not_query(self):
        # After EXPLAIN rejects every attempt, the lane emits the error, not the
        # rejected query masquerading as an answer; and nothing is executed.
        ig = _fake_ig(max_validation_attempts=2, _validate_query=lambda aql: (False, 'syntax error near RETURN'))
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users RETURN u'}),
        )
        inst.writeQuestions(self._question(_QTYPE.QUESTION))
        assert inst.instance.answers
        assert 'syntax error' in inst.instance.answers[0].value
        assert not inst.instance.tables

    def test_write_generated_query_emits_error(self):
        # A generated write is rejected by the EXPLAIN-plan gate; the lane emits the
        # modification error and nothing is executed or tabulated.
        ig = _fake_ig(
            max_validation_attempts=2,
            _validate_query=lambda aql: (False, 'Query performs data modification; this node is read-only.'),
        )
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR u IN users REMOVE u IN users'}),
        )
        inst.writeQuestions(self._question(_QTYPE.QUESTION))
        assert inst.instance.answers
        assert 'modification' in inst.instance.answers[0].value.lower()
        assert not inst.instance.tables

    def test_collection_named_like_keyword_emits_table(self):
        # The pipeline path no longer pre-rejects a read against a keyword-named
        # collection: EXPLAIN approves it, _run_query returns rows, a table is emitted.
        ig = _fake_ig(_run_query=lambda aql, *a, **k: [{'d': 1}])
        inst = _make_instance(
            ig=ig,
            instance=_FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR d IN replace RETURN d'}),
        )
        inst.writeQuestions(self._question(_QTYPE.QUESTION))
        assert inst.instance.tables  # the read executed and produced a table
        assert not any('unsafe' in a.value.lower() for a in inst.instance.answers)

    def test_no_question_text_warns(self):
        _reset_logs()
        inst = _make_instance(ig=_fake_ig(), instance=_FakeInstance())
        inst.writeQuestions(SimpleNamespace(type=_QTYPE.QUESTION, questions=[]))
        assert any('No question text' in w for w in _WARNING_CALLS)


class TestFormatMarkdown:
    def test_list_of_dicts_uses_keys_as_headers(self):
        inst = _make_instance(ig=_fake_ig())
        out = inst._formatResultAsMarkdown([{'a': 1, 'b': 2}, {'a': 3, 'b': 4}])
        assert out == "MD|headers=['a', 'b']|rows=2"

    def test_heterogeneous_rows_union_all_keys(self):
        # Schemaless ArangoDB: a field present only in a later row must still appear.
        inst = _make_instance(ig=_fake_ig())
        out = inst._formatResultAsMarkdown([{'a': 1}, {'b': 2}])
        assert out == "MD|headers=['a', 'b']|rows=2"


# =============================================================================
# (d) Phase 2 — explain-plan read-only gate, multi-model reflection, caps
# =============================================================================


def _plan(*node_types):
    return {'nodes': [{'type': t} for t in node_types]}


class TestPlanModification:
    def test_read_only_plan_is_not_modification(self):
        assert _plan_is_modification(_plan('SingletonNode', 'EnumerateCollectionNode', 'ReturnNode')) is False

    @pytest.mark.parametrize('mod', ['InsertNode', 'UpdateNode', 'ReplaceNode', 'RemoveNode', 'UpsertNode'])
    def test_modification_node_detected(self, mod):
        assert _plan_is_modification(_plan('SingletonNode', mod, 'ReturnNode')) is True

    def test_nodes_from_nested_plan_shape(self):
        assert _plan_nodes({'plan': {'nodes': [{'type': 'RemoveNode'}]}}) == [{'type': 'RemoveNode'}]

    def test_modification_in_all_plans_shape(self):
        shaped = {'plans': [{'nodes': [{'type': 'InsertNode'}]}, {'nodes': [{'type': 'ReturnNode'}]}]}
        assert _plan_is_modification(shaped) is True

    def test_modification_in_list_shape(self):
        assert _plan_is_modification([{'nodes': [{'type': 'UpdateNode'}]}]) is True

    def test_unknown_shape_is_safe(self):
        assert _plan_nodes('garbage') == []
        assert _plan_is_modification(None) is False


class TestValidateQueryReadOnly:
    def test_modification_plan_rejected(self):
        ig = IGlobal.__new__(IGlobal)
        ig.db = SimpleNamespace(aql=SimpleNamespace(explain=lambda aql: _plan('InsertNode', 'ReturnNode')))
        ok, msg = ig._validate_query('INSERT {a: 1} INTO users')
        assert ok is False
        assert 'read-only' in msg

    def test_read_only_plan_accepted(self):
        ig = IGlobal.__new__(IGlobal)
        ig.db = SimpleNamespace(aql=SimpleNamespace(explain=lambda aql: _plan('EnumerateCollectionNode', 'ReturnNode')))
        assert ig._validate_query('FOR u IN users RETURN u') == (True, '')


class TestRunQueryCaps:
    def test_result_capped_at_max_execute_rows(self):
        _reset_logs()
        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 3
        ig.db = SimpleNamespace(aql=SimpleNamespace(execute=lambda *a, **k: iter([{'i': i} for i in range(10)])))
        rows = ig._run_query('FOR u IN users RETURN u')
        assert len(rows) == 3
        assert any('truncated' in w for w in _WARNING_CALLS)

    def test_memory_limit_and_runtime_passed_to_execute(self):
        captured = {}

        def _execute(aql, **kwargs):
            captured.update(kwargs)
            return iter([])

        ig = IGlobal.__new__(IGlobal)
        ig.max_execute_rows = 100
        ig.db = SimpleNamespace(aql=SimpleNamespace(execute=_execute))
        ig._run_query('FOR u IN users RETURN u')
        assert captured['memory_limit'] == IGlobal.QUERY_MEMORY_LIMIT
        assert captured['max_runtime'] == IGlobal.QUERY_MAX_RUNTIME


class TestMultiModelReflection:
    def _ig(self, collections=None, docs=None, indexes=None, graphs=None, views=None):
        ig = IGlobal.__new__(IGlobal)
        docs = docs or {}
        indexes = indexes or {}

        def _collection(name):
            return SimpleNamespace(
                find=lambda *a, **k: iter(docs.get(name, [])),
                indexes=lambda: indexes.get(name, []),
            )

        ig.db = SimpleNamespace(
            collections=lambda: collections or [],
            collection=_collection,
            graphs=lambda: graphs or [],
            views=lambda: views or [],
        )
        return ig

    def test_indexes_reflected_skipping_primary(self):
        ig = self._ig(
            collections=[{'name': 'users', 'system': False, 'type': 'document'}],
            docs={'users': [{'email': 'a@b.c'}]},
            indexes={
                'users': [
                    {'type': 'primary', 'fields': ['_key']},
                    {'type': 'persistent', 'fields': ['email']},
                ]
            },
        )
        assert ig._reflect_schema()['collections']['users']['indexed_fields'] == ['email']

    def test_graphs_reflected_snake_case(self):
        ig = self._ig(
            graphs=[
                {
                    'name': 'org',
                    'edge_definitions': [
                        {
                            'edge_collection': 'reports_to',
                            'from_vertex_collections': ['employees'],
                            'to_vertex_collections': ['employees'],
                        }
                    ],
                }
            ]
        )
        ed = ig._reflect_schema()['graphs'][0]['edge_definitions'][0]
        assert ed == {'edge': 'reports_to', 'from': ['employees'], 'to': ['employees']}

    def test_graphs_reflected_camel_case(self):
        ig = self._ig(
            graphs=[
                {
                    'name': 'social',
                    'edgeDefinitions': [{'collection': 'knows', 'from': ['persons'], 'to': ['persons']}],
                }
            ]
        )
        ed = ig._reflect_schema()['graphs'][0]['edge_definitions'][0]
        assert ed == {'edge': 'knows', 'from': ['persons'], 'to': ['persons']}

    def test_views_reflected(self):
        ig = self._ig(views=[{'name': 'search', 'type': 'arangosearch'}])
        assert ig._reflect_schema()['views'] == [{'name': 'search', 'type': 'arangosearch'}]


class TestGraphSchemaInPrompt:
    def test_graph_and_index_context_reaches_the_llm(self):
        schema = {
            'collections': {
                'persons': {
                    'type': 'document',
                    'fields': [('name', 'string')],
                    'indexed_fields': ['name'],
                }
            },
            'graphs': [
                {'name': 'social', 'edge_definitions': [{'edge': 'knows', 'from': ['persons'], 'to': ['persons']}]}
            ],
            'views': [{'name': 'person_search', 'type': 'arangosearch'}],
        }
        instance = _FakeInstance(invoke_answer={'isValid': 'true', 'query': 'FOR p IN persons LIMIT 5 RETURN p'})
        inst = _make_instance(ig=_fake_ig(graph_schema=schema), instance=instance)
        inst.get_aql({'question': 'show people'})
        context_blob = '\n'.join(instance.invoked[0].question.contexts)
        assert 'knows' in context_blob
        assert '(persons) -[knows]-> (persons)' in context_blob
        assert 'indexed: name' in context_blob
        assert 'person_search' in context_blob


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
