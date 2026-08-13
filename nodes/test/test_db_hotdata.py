# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the db_hotdata node (no network).

Covers the REST client's retry policy, the lock-guarded ephemeral-database
lifecycle, and the get_schema / execute tool surface. Every dependency on the
engine runtime or the network is stubbed into sys.modules before import and
popped afterwards, so nothing leaks into other nodes' tests under a full
`builder nodes:test-full` run.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------

_WARNING_CALLS: list[str] = []
_DEBUG_CALLS: list[str] = []
_NORMALIZE_CALLS: list[str] = []


def _reset_logs() -> None:
    _WARNING_CALLS.clear()
    _DEBUG_CALLS.clear()
    _NORMALIZE_CALLS.clear()


def _stub_warning(msg, *_a, **_k) -> None:
    _WARNING_CALLS.append(str(msg))


def _stub_debug(msg, *_a, **_k) -> None:
    _DEBUG_CALLS.append(str(msg))


def _stub_normalize(args, **kw):
    _NORMALIZE_CALLS.append(kw.get('tool_name', 'tool'))
    return args if isinstance(args, dict) else {}


class _StubQuestion:
    """Records what the node puts in front of the LLM so prompts can be asserted."""

    def __init__(self, role=''):
        self.role = role
        self.instructions = []
        self.contexts = []
        self.examples = []
        self.goals = []
        self.questions = []

    def addInstruction(self, title, text):
        self.instructions.append((title, text))

    def addContext(self, text):
        self.contexts.append(text)

    def addExample(self, q, a):
        self.examples.append((q, a))

    def addGoal(self, text):
        self.goals.append(text)

    def addQuestion(self, text):
        self.questions.append(text)

    def all_text(self):
        parts = [t for _, t in self.instructions] + self.contexts + self.goals + self.questions
        return '\n'.join(parts)


class _StubAnswer:
    def __init__(self, payload=None):
        self._payload = payload
        self.answer = None

    def getJson(self):
        return self._payload

    def setAnswer(self, text):
        self.answer = text


class _RequestException(Exception):
    pass


class _ConnectionError(_RequestException):
    pass


class _ConnectTimeout(_ConnectionError):
    pass


class _ReadTimeout(_RequestException):
    pass


def _build_import_stubs() -> dict:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib.warning = _stub_warning
    rocketlib.debug = _stub_debug
    rocketlib.error = lambda *_a, **_k: None
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')

    requests = types.ModuleType('requests')
    requests.exceptions = SimpleNamespace(
        RequestException=_RequestException,
        ConnectionError=_ConnectionError,
        ConnectTimeout=_ConnectTimeout,
        ReadTimeout=_ReadTimeout,
        Timeout=_ReadTimeout,
    )
    requests.request = lambda *_a, **_k: None  # replaced per-test

    rocketlib_types = types.ModuleType('rocketlib.types')
    rocketlib_types.IInvokeLLM = SimpleNamespace(Ask=lambda question=None: SimpleNamespace(question=question))
    rocketlib.types = rocketlib_types

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    ai_utils = types.ModuleType('ai.common.utils')
    ai_utils.normalize_tool_input = _stub_normalize
    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = SimpleNamespace(getNodeConfig=lambda *_a, **_k: {})
    ai_schema = types.ModuleType('ai.common.schema')
    ai_schema.Question = _StubQuestion
    ai_schema.Answer = _StubAnswer

    return {
        'rocketlib': rocketlib,
        'rocketlib.types': rocketlib_types,
        'requests': requests,
        'ai': ai_pkg,
        'ai.common': ai_common,
        'ai.common.utils': ai_utils,
        'ai.common.config': ai_config,
        'ai.common.schema': ai_schema,
    }


# ---------------------------------------------------------------------------
# Load the node modules as a synthetic package so relative imports resolve.
# ---------------------------------------------------------------------------

_NODE_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'db_hotdata'
_PKG = 'db_hotdata_under_test'


def _load_modules():
    stubs = _build_import_stubs()
    # Force the stubs in, remembering whatever was there. Installing only when a
    # name is absent works in isolation but not under `builder nodes:test`, where
    # the real rocketlib/ai.common/requests are already imported by other nodes'
    # tests - the module under test would then bind the real objects and every
    # assertion about captured warnings or normalize_tool_input would fail.
    saved = {name: sys.modules.get(name) for name in stubs}
    for name, module in stubs.items():
        sys.modules[name] = module

    pkg = types.ModuleType(_PKG)
    pkg.__path__ = [str(_NODE_DIR)]
    sys.modules[_PKG] = pkg
    loaded = [_PKG]

    try:
        mods = {}
        for short in ('hotdata_client', 'hotdata_schema', 'IGlobal', 'IInstance'):
            dotted = f'{_PKG}.{short}'
            spec = importlib.util.spec_from_file_location(dotted, _NODE_DIR / f'{short}.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[dotted] = module
            loaded.append(dotted)
            spec.loader.exec_module(module)
            mods[short] = module
        return mods, stubs['requests']
    finally:
        for name in loaded:
            sys.modules.pop(name, None)
        # Restore exactly what was there so nothing leaks into other nodes' tests.
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


_MODS, _REQUESTS_STUB = _load_modules()
client_mod = _MODS['hotdata_client']
schema_mod = _MODS['hotdata_schema']
iglobal_mod = _MODS['IGlobal']
iinstance_mod = _MODS['IInstance']


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Resp:
    def __init__(self, status_code=200, body=None, headers=None, text=''):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.text = text

    def json(self):
        return self._body


class _Recorder:
    """Stands in for requests.request, replaying a queued list of outcomes."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, method, url, **kw):
        self.calls.append({'method': method, 'url': url, **kw})
        outcome = self.outcomes.pop(0) if self.outcomes else _Resp()
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    _reset_logs()
    monkeypatch.setattr(client_mod.time, 'sleep', lambda *_a: None)
    yield


def _client(outcomes):
    recorder = _Recorder(outcomes)
    client_mod.requests.request = recorder
    c = client_mod.HotdataClient(apikey='sk-secret-key', workspace_id='ws-1', retry_budget_s=30.0)
    return c, recorder


def _global(**overrides):
    g = iglobal_mod.IGlobal()
    g._db_lock = threading.Lock()
    g.database = None
    g.client = SimpleNamespace()
    g.apikey = 'sk-secret-key'
    g.workspace_id = 'ws-1'
    g.ttl = '24h'
    g.max_execute_rows = 25000
    g.allow_execute = True
    g.job_timeout_secs = 30
    g.async_after_ms = 5000
    for k, v in overrides.items():
        setattr(g, k, v)
    return g


def _instance(glb):
    inst = iinstance_mod.IInstance()
    inst.IGlobal = glb
    return inst


# ---------------------------------------------------------------------------
# Client: request building
# ---------------------------------------------------------------------------


def test_request_carries_auth_workspace_and_timeout():
    c, rec = _client([_Resp(200, {'ok': True})])
    c.get_query_run('run-1')
    call = rec.calls[0]
    assert call['method'] == 'GET'
    assert call['url'] == 'https://api.hotdata.dev/v1/query-runs/run-1'
    assert call['headers']['Authorization'] == 'Bearer sk-secret-key'
    assert call['headers']['X-Workspace-Id'] == 'ws-1'
    assert call['timeout'] == client_mod.DEFAULT_TIMEOUT_S


def test_base_url_override_strips_trailing_slash():
    client_mod.requests.request = _Recorder([_Resp(200, {})])
    c = client_mod.HotdataClient('k', 'w', base_url='https://alt.example.com/')
    assert c.base_url == 'https://alt.example.com'


# ---------------------------------------------------------------------------
# Client: retry policy
# ---------------------------------------------------------------------------


def test_429_is_retried_and_retry_after_is_honored(monkeypatch):
    slept = []
    monkeypatch.setattr(client_mod.time, 'sleep', lambda d: slept.append(d))
    c, rec = _client([_Resp(429, headers={'Retry-After': '7'}), _Resp(200, {'id': 'db-1'})])
    assert c.create_database('n', '24h') == {'id': 'db-1'}
    assert len(rec.calls) == 2
    assert slept == [7.0]


def test_retry_after_is_capped():
    assert client_mod._parse_retry_after({'Retry-After': '99999'}) == client_mod.MAX_RETRY_AFTER_S
    assert client_mod._parse_retry_after({}) is None
    assert client_mod._parse_retry_after({'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'}) is None


def test_429_budget_exhaustion_raises_overloaded(monkeypatch):
    monkeypatch.setattr(client_mod.time, 'sleep', lambda *_a: None)
    c, _ = _client([_Resp(429, headers={'Retry-After': '600'})])
    with pytest.raises(client_mod.HotdataOverloadedError):
        c.create_database('n', '24h')


def test_post_read_timeout_is_not_replayed():
    c, rec = _client([_ReadTimeout('read timed out'), _Resp(200, {'id': 'db-1'})])
    with pytest.raises(client_mod.HotdataError):
        c.create_database('n', '24h')
    assert len(rec.calls) == 1, 'a POST that may have reached the server must not be replayed'


def test_get_read_timeout_is_retried():
    c, rec = _client([_ReadTimeout('read timed out'), _Resp(200, {'status': 'succeeded'})])
    assert c.get_query_run('run-1') == {'status': 'succeeded'}
    assert len(rec.calls) == 2


def test_pre_response_connection_error_is_retried_on_post():
    c, rec = _client([_ConnectTimeout('never left'), _Resp(200, {'id': 'db-1'})])
    assert c.create_database('n', '24h') == {'id': 'db-1'}
    assert len(rec.calls) == 2


def test_post_5xx_is_not_retried():
    c, rec = _client([_Resp(503, text='upstream down'), _Resp(200, {})])
    with pytest.raises(client_mod.HotdataError):
        c.create_database('n', '24h')
    assert len(rec.calls) == 1


def test_get_5xx_is_retried():
    c, rec = _client([_Resp(503, text='blip'), _Resp(200, {'status': 'succeeded'})])
    assert c.get_query_run('run-1') == {'status': 'succeeded'}
    assert len(rec.calls) == 2


def test_4xx_raises_runtime_error_with_body_snippet():
    c, _ = _client([_Resp(400, text='bad sql')])
    with pytest.raises(client_mod.HotdataError, match='bad sql'):
        c.get_query_run('run-1')


# ---------------------------------------------------------------------------
# Client: TTL is mandatory
# ---------------------------------------------------------------------------


def test_create_database_always_sends_expires_at():
    c, rec = _client([_Resp(200, {'id': 'db-1'})])
    c.create_database('run-db', '24h')
    assert rec.calls[0]['json']['expires_at'] == '24h'


def test_create_database_refuses_empty_ttl():
    c, rec = _client([_Resp(200, {'id': 'db-1'})])
    with pytest.raises(ValueError):
        c.create_database('run-db', '')
    assert rec.calls == []


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def test_concurrent_get_database_creates_exactly_one():
    """The tool_daytona failure: unguarded check-then-act billed two databases."""
    created = []

    def _slow_create(name, expires_at, schemas=None):
        time.sleep(0.02)  # widen the race window
        created.append(name)
        return {'id': f'db-{len(created)}'}

    g = _global()
    g.client = SimpleNamespace(create_database=_slow_create)

    results = []
    threads = [threading.Thread(target=lambda: results.append(g.get_database())) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(created) == 1, f'expected exactly one database, got {len(created)}'
    assert all(r is results[0] for r in results)


def test_drop_database_clears_only_the_matching_handle():
    g = _global()
    handle = {'id': 'db-1'}
    g.database = handle
    g.drop_database({'id': 'other'})
    assert g.database is handle
    g.drop_database(handle)
    assert g.database is None


def test_end_global_deletes_and_clears_secrets():
    deleted = []
    g = _global()
    g.database = {'id': 'db-1'}
    g.client = SimpleNamespace(delete_database=lambda i: deleted.append(i))
    g.endGlobal()
    assert deleted == ['db-1']
    assert g.database is None and g.client is None
    assert g.apikey == '' and g.workspace_id == ''


def test_end_global_warns_but_does_not_raise_on_delete_failure():
    def _boom(_i):
        raise RuntimeError('gone')

    g = _global()
    g.database = {'id': 'db-1'}
    g.client = SimpleNamespace(delete_database=_boom)
    g.endGlobal()  # must not raise
    assert any('delete failed' in m for m in _WARNING_CALLS)
    assert g.database is None


def test_secrets_never_reach_the_logs():
    g = _global()
    g.database = {'id': 'db-1'}
    g.client = SimpleNamespace(delete_database=lambda _i: None)
    g.endGlobal()
    joined = ' '.join(_WARNING_CALLS + _DEBUG_CALLS)
    assert 'sk-secret-key' not in joined
    assert 'ws-1' not in joined


# ---------------------------------------------------------------------------
# SQL guards
# ---------------------------------------------------------------------------


def test_single_trailing_semicolon_is_accepted():
    cleaned, count = iinstance_mod._split_statements('SELECT 1;')
    assert cleaned == 'SELECT 1'
    assert count == 1


def test_semicolon_inside_a_literal_is_not_a_statement_break():
    _, count = iinstance_mod._split_statements("SELECT 'a;b' AS x")
    assert count == 1


def test_comments_are_ignored_when_counting():
    _, count = iinstance_mod._split_statements('SELECT 1 -- trailing ; comment\n')
    assert count == 1


def test_execute_rejects_multi_statement():
    inst = _instance(_global())
    with pytest.raises(ValueError, match='one statement'):
        inst.execute({'sql': 'SELECT 1; SELECT 2'})


def test_execute_rejects_write_verbs():
    inst = _instance(_global())
    for sql in ('INSERT INTO t VALUES (1)', 'create table t (a int)', 'DROP TABLE t'):
        with pytest.raises(ValueError, match='read-only'):
            inst.execute({'sql': sql})


def test_execute_refuses_when_allow_execute_is_off():
    inst = _instance(_global(allow_execute=False))
    with pytest.raises(RuntimeError, match='disabled'):
        inst.execute({'sql': 'SELECT 1'})


def test_execute_requires_non_empty_sql():
    inst = _instance(_global())
    for bad in ({}, {'sql': ''}, {'sql': 42}):
        with pytest.raises(ValueError):
            inst.execute(bad)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def test_execute_returns_inline_rows_and_applies_limit():
    g = _global()
    g.client = SimpleNamespace(
        query=lambda **_kw: {'rows': [{'a': 1}, {'a': 2}, {'a': 3}]},
        create_database=lambda **_kw: {'id': 'db-1'},
    )
    inst = _instance(g)
    out = inst.execute({'sql': 'SELECT a FROM t', 'limit': 2})
    assert out['row_count'] == 2
    assert out['rows'] == [{'a': 1}, {'a': 2}]
    assert 'execute' in _NORMALIZE_CALLS


def test_execute_limit_is_clamped_and_booleans_rejected():
    seen = {}

    def _query(**kw):
        seen.update(kw)
        return {'rows': [{'a': i} for i in range(25)]}

    g = _global(max_execute_rows=10)
    g.client = SimpleNamespace(query=_query, create_database=lambda **_kw: {'id': 'db-1'})
    inst = _instance(g)
    # execute does not rewrite the SQL - it slices the returned rows - so assert
    # the effective limit through row_count rather than the statement text.
    out = inst.execute({'sql': 'SELECT 1', 'limit': 9999})
    assert out['row_count'] == 10, f'9999 should clamp to max_execute_rows=10, got {out["row_count"]}'
    # JSON true must not be read as limit=1
    out = inst.execute({'sql': 'SELECT 1', 'limit': True})
    assert out['row_count'] == 10, f'a boolean limit must not be coerced to 1, got {out["row_count"]}'


def test_execute_follows_async_run_to_a_result():
    polls = [{'status': 'running'}, {'status': 'succeeded', 'result_id': 'res-1'}]
    g = _global()
    g.client = SimpleNamespace(
        query=lambda **_kw: {'query_run_id': 'run-1'},
        get_query_run=lambda _i: polls.pop(0),
        get_result=lambda _i, offset=0, limit=None: {'rows': [{'a': 1}]},
        create_database=lambda **_kw: {'id': 'db-1'},
    )
    inst = _instance(g)
    out = inst.execute({'sql': 'SELECT a FROM t'})
    assert out['rows'] == [{'a': 1}]


def test_failed_query_run_raises_runtime_error():
    g = _global()
    g.client = SimpleNamespace(
        query=lambda **_kw: {'query_run_id': 'run-1'},
        get_query_run=lambda _i: {'status': 'failed', 'error': 'syntax error at or near "SELCT"'},
        create_database=lambda **_kw: {'id': 'db-1'},
    )
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='syntax error'):
        inst.execute({'sql': 'SELECT 1'})


def _llm_instance(glb, answers):
    """An instance whose bound LLM replays a queued list of SQL answers."""
    asked = []

    def _invoke(ask):
        asked.append(ask.question)
        reply = answers.pop(0) if answers else 'SELECT 1'
        if isinstance(reply, BaseException):
            raise reply
        return SimpleNamespace(answer=reply)

    inst = _instance(glb)
    inst.instance = SimpleNamespace(invoke=_invoke)
    inst.asked = asked
    return inst


# ---------------------------------------------------------------------------
# NL-to-SQL
# ---------------------------------------------------------------------------


def test_dialect_returns_the_full_briefing_not_a_bare_string():
    inst = _instance(_global())
    out = inst.dialect({})
    assert out['dialect'] == 'datafusion'
    briefing = out['briefing']
    # The distinctions an LLM gets wrong by default must all be present.
    for marker in ('DataFusion 54', 'PostgreSQL parser dialect', 'jsonb_', 'pg_catalog', 'bm25_search'):
        assert marker in briefing, f'dialect briefing is missing {marker!r}'
    assert len(briefing) > 1000
    # Verified against the live API 2026-08-12: SHOW TABLES works, so the briefing
    # must not tell the LLM it errors.
    assert 'SHOW TABLES / SHOW COLUMNS / SHOW FUNCTIONS are NOT available' not in briefing


def test_generated_prompt_carries_dialect_and_schema():
    g = _loaded_global()
    g.db_description = 'Sales data for EMEA'
    g.client = SimpleNamespace(
        information_schema=lambda **_kw: {
            'tables': [{'name': 'sales', 'columns': [{'name': 'units', 'type': 'Int64'}]}]
        },
    )
    inst = _llm_instance(g, ['SELECT 1'])
    inst.get_sql({'question': 'how many units?'})
    text = inst.asked[0].all_text()
    assert 'PostgreSQL parser dialect' in text
    assert 'sales' in text and 'units' in text
    assert 'Sales data for EMEA' in text
    assert 'how many units?' in inst.asked[0].questions


def test_get_sql_strips_markdown_fences():
    g = _loaded_global()
    g.client = SimpleNamespace(information_schema=lambda **_kw: {'tables': []})
    inst = _llm_instance(g, ['```sql\nSELECT 1\n```'])
    assert inst.get_sql({'question': 'anything'})['sql'] == 'SELECT 1'


def test_get_sql_requires_a_question():
    inst = _llm_instance(_loaded_global(), [])
    with pytest.raises(ValueError, match='question is required'):
        inst.get_sql({})


def test_get_data_retries_with_the_error_fed_back():
    calls = {'n': 0}

    def _query(**_kw):
        calls['n'] += 1
        if calls['n'] == 1:
            raise RuntimeError("Invalid function 'to_number'. Did you mean 'to_char'?")
        return {'rows': [{'a': 1}]}

    g = _loaded_global(max_attempts=3)
    g.client = SimpleNamespace(information_schema=lambda **_kw: {'tables': []}, query=_query)
    inst = _llm_instance(g, ['SELECT to_number(x) FROM t', 'SELECT x FROM t'])

    out = inst.get_data({'question': 'convert x'})
    assert out['rows'] == [{'a': 1}]
    assert out['attempts'] == 2
    # The second prompt must contain the first failure so the LLM can correct it.
    assert 'to_number' in inst.asked[1].all_text()


def test_get_data_gives_up_after_max_attempts():
    g = _loaded_global(max_attempts=2)
    g.client = SimpleNamespace(
        information_schema=lambda **_kw: {'tables': []},
        query=lambda **_kw: (_ for _ in ()).throw(RuntimeError('boom')),
    )
    inst = _llm_instance(g, ['SELECT 1', 'SELECT 2'])
    with pytest.raises(RuntimeError, match='after 2 attempts'):
        inst.get_data({'question': 'x'})


def test_get_data_rejects_a_multi_statement_generation():
    g = _loaded_global(max_attempts=2)
    g.client = SimpleNamespace(
        information_schema=lambda **_kw: {'tables': []},
        query=lambda **_kw: {'rows': [{'ok': 1}]},
    )
    inst = _llm_instance(g, ['SELECT 1; DROP TABLE t', 'SELECT 1'])
    out = inst.get_data({'question': 'x'})
    assert out['attempts'] == 2, 'the batched generation must be rejected and retried'


def test_schema_lookup_failure_does_not_sink_the_question():
    def _boom(**_kw):
        raise RuntimeError('information_schema unavailable')

    g = _loaded_global()
    g.client = SimpleNamespace(information_schema=_boom, query=lambda **_kw: {'rows': []})
    inst = _llm_instance(g, ['SELECT 1'])
    out = inst.get_data({'question': 'x'})
    assert out['row_count'] == 0
    assert any('could not read schema' in m for m in _WARNING_CALLS)


def test_missing_llm_answer_raises():
    g = _loaded_global()
    g.client = SimpleNamespace(information_schema=lambda **_kw: {'tables': []})
    inst = _instance(g)
    inst.instance = SimpleNamespace(invoke=lambda _ask: SimpleNamespace(answer=''))
    with pytest.raises(RuntimeError, match='did not return a query'):
        inst.get_sql({'question': 'x'})


def test_schema_formatting_handles_empty_and_flat_shapes():
    assert 'No tables' in schema_mod.format_schema_for_prompt([])
    text = schema_mod.format_schema_for_prompt(
        [{'table_name': 'orders', 'table_schema': 'main', 'columns': ['id Int64', 'total Float64']}]
    )
    assert 'main.orders' in text and 'total Float64' in text


def _loaded_global(**overrides):
    """A global whose database already exists, with the fields loads/indexes need."""
    g = _global(**overrides)
    g.database = {
        'id': 'db-1',
        'default_schema': 'main',
        'default_catalog': 'default',
        'default_connection_id': 'conn-1',
    }
    return g


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------


def test_upload_bytes_single_mode_puts_without_bearer_and_finalizes():
    slot = _Resp(
        201,
        {
            'upload_id': 'up-1',
            'finalize_token': 'tok-1',
            'mode': 'single',
            'url': 'https://storage.example/put',
            'headers': {'Content-Type': 'application/json'},
        },
    )
    c, rec = _client([slot, _Resp(200), _Resp(200, {'status': 'ready'})])
    assert c.upload_bytes(b'[{"a":1}]', 't.json') == 'up-1'

    put = rec.calls[1]
    assert put['method'] == 'PUT'
    assert put['url'] == 'https://storage.example/put'
    assert 'Authorization' not in put['headers'], 'presigned PUT must not carry our bearer token'
    assert put['data'] == b'[{"a":1}]'

    finalize = rec.calls[2]
    assert finalize['url'].endswith('/v1/uploads/up-1/finalize')
    assert finalize['headers']['X-Upload-Finalize-Token'] == 'tok-1'


def test_upload_slot_missing_token_raises():
    c, _ = _client([_Resp(201, {'upload_id': 'up-1'})])
    with pytest.raises(client_mod.HotdataError, match='finalize_token'):
        c.upload_bytes(b'x', 't.json')


def test_load_table_requires_exactly_one_source():
    c, _ = _client([])
    with pytest.raises(ValueError):
        c.load_table('db-1', 'main', 't', upload_id='u', result_id='r')
    with pytest.raises(ValueError):
        c.load_table('db-1', 'main', 't')


# ---------------------------------------------------------------------------
# load_data
# ---------------------------------------------------------------------------


def test_load_data_uploads_rows_as_json_and_loads():
    seen = {}

    def _upload(payload, filename, content_type='application/json'):
        seen['payload'] = payload
        seen['filename'] = filename
        return 'up-1'

    def _load(**kw):
        seen['load'] = kw
        return {'row_count': 2, 'status': 'succeeded'}

    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **kw: {}, upload_bytes=_upload, load_table=_load)
    inst = _instance(g)
    out = inst.load_data({'table': 'orders', 'rows': [{'a': 1}, {'a': 2}]})

    assert out['table'] == 'orders' and out['schema'] == 'main'
    assert seen['load']['data_format'] == 'json'
    assert seen['load']['upload_id'] == 'up-1'
    assert seen['load']['mode'] == 'append'
    assert b'"a": 1' in seen['payload'] or b'"a":1' in seen['payload']


def test_load_data_from_result_id_skips_upload():
    calls = {'uploaded': False}

    def _upload(*_a, **_k):
        calls['uploaded'] = True
        return 'up-x'

    def _load(**kw):
        calls['load'] = kw
        return {'row_count': 5}

    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: {}, upload_bytes=_upload, load_table=_load)
    inst = _instance(g)
    out = inst.load_data({'table': 'orders', 'result_id': 'res-9'})
    assert calls['uploaded'] is False, 'result_id must avoid the upload round trips entirely'
    assert calls['load']['result_id'] == 'res-9'
    assert out['row_count'] == 5


def test_load_data_validates_arguments():
    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: {}, load_table=lambda **_kw: {})
    inst = _instance(g)
    with pytest.raises(ValueError, match='table is required'):
        inst.load_data({'rows': [{'a': 1}]})
    with pytest.raises(ValueError, match='rows'):
        inst.load_data({'table': 't'})
    with pytest.raises(ValueError, match='not both'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}], 'result_id': 'r'})
    with pytest.raises(ValueError, match='mode must be'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}], 'mode': 'obliterate'})
    with pytest.raises(ValueError, match='requires key'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}], 'mode': 'upsert'})


def test_load_data_with_no_rows_does_no_work():
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: pytest.fail('must not upload an empty batch'),
        load_table=lambda **_kw: pytest.fail('must not load an empty batch'),
    )
    inst = _instance(g)
    assert inst.load_data({'table': 'orders', 'rows': []})['row_count'] == 0


def test_existing_table_409_is_treated_as_success():
    def _create(**_kw):
        raise RuntimeError('hotdata: POST ... failed with HTTP 409: table exists')

    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=_create,
        upload_bytes=lambda *_a, **_k: 'up-1',
        load_table=lambda **_kw: {'row_count': 1},
    )
    inst = _instance(g)
    assert inst.load_data({'table': 'orders', 'rows': [{'a': 1}]})['row_count'] == 1


# ---------------------------------------------------------------------------
# Async jobs
# ---------------------------------------------------------------------------


def test_load_follows_202_job_to_completion():
    jobs = [{'status': 'running'}, {'status': 'succeeded', 'row_count': 7}]
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: 'up-1',
        load_table=lambda **_kw: {'id': 'job-1', 'status': 'pending'},
        get_job=lambda _i: jobs.pop(0),
    )
    inst = _instance(g)
    assert inst.load_data({'table': 'orders', 'rows': [{'a': 1}]})['row_count'] == 7


def test_failed_job_raises_with_server_message():
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: 'up-1',
        load_table=lambda **_kw: {'id': 'job-1', 'status': 'pending'},
        get_job=lambda _i: {'status': 'failed', 'error_message': 'bad parquet'},
    )
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='bad parquet'):
        inst.load_data({'table': 'orders', 'rows': [{'a': 1}]})


def test_partially_succeeded_job_warns_but_returns():
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: 'up-1',
        load_table=lambda **_kw: {'id': 'job-1', 'status': 'pending'},
        get_job=lambda _i: {'status': 'partially_succeeded', 'row_count': 3},
    )
    inst = _instance(g)
    assert inst.load_data({'table': 'orders', 'rows': [{'a': 1}]})['row_count'] == 3
    assert any('partially' in m for m in _WARNING_CALLS)


# ---------------------------------------------------------------------------
# build_index
# ---------------------------------------------------------------------------


def test_build_index_uses_default_connection_and_derives_a_name():
    seen = {}
    g = _loaded_global()
    g.client = SimpleNamespace(create_index=lambda **kw: seen.update(kw) or {'status': 'ready'})
    inst = _instance(g)
    out = inst.build_index({'table': 'docs', 'column': 'body', 'index_type': 'bm25'})
    assert seen['connection_id'] == 'conn-1'
    assert seen['schema'] == 'main'
    assert seen['columns'] == ['body']
    assert out['index_name'] == 'docs_body_bm25'
    assert out['status'] == 'ready'


def test_build_index_validates_type_and_required_args():
    g = _loaded_global()
    g.client = SimpleNamespace(create_index=lambda **_kw: {})
    inst = _instance(g)
    with pytest.raises(ValueError, match='table and column'):
        inst.build_index({'table': 'docs'})
    with pytest.raises(ValueError, match='index_type must be'):
        inst.build_index({'table': 'docs', 'column': 'body', 'index_type': 'magic'})


def test_build_index_without_connection_id_raises():
    g = _loaded_global()
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    g.client = SimpleNamespace(create_index=lambda **_kw: {})
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='default_connection_id'):
        inst.build_index({'table': 'docs', 'column': 'body'})


def test_get_schema_uses_information_schema_not_show_tables():
    seen = {}

    def _info(**kw):
        seen.update(kw)
        return {'tables': [{'name': 'orders'}]}

    g = _loaded_global()
    g.client = SimpleNamespace(information_schema=_info)
    inst = _instance(g)
    out = inst.get_schema({'schema': 'public'})
    assert out['tables'] == [{'name': 'orders'}]
    # Scoped by connection_id: passing database_id is silently ignored server-side
    # and yields an empty table list.
    assert seen['connection_id'] == 'conn-1'
    assert 'database_id' not in seen
    assert seen['include_columns'] is True
    assert 'get_schema' in _NORMALIZE_CALLS


# ---------------------------------------------------------------------------
# Lanes
# ---------------------------------------------------------------------------


class _FakeLaneInstance:
    """Captures what the node writes downstream."""

    def __init__(self, lanes, invoke=None):
        self._lanes = lanes
        self.texts = []
        self.tables = []
        self.answers = []
        self.invoke = invoke or (lambda _ask: SimpleNamespace(answer='SELECT 1'))

    def getListeners(self):
        return self._lanes

    def writeText(self, text):
        self.texts.append(text)

    def writeTable(self, markdown):
        self.tables.append(markdown)

    def writeAnswers(self, answer):
        self.answers.append(answer)


def test_questions_lane_emits_to_every_wired_lane():
    g = _loaded_global()
    g.client = SimpleNamespace(
        information_schema=lambda **_kw: {'tables': []},
        query=lambda **_kw: {'rows': [{'product': 'widget', 'units': 3}]},
    )
    inst = _instance(g)
    inst.instance = _FakeLaneInstance(['text', 'table', 'answers'])

    question = SimpleNamespace(questions=[SimpleNamespace(text='what sold most?')])
    inst.writeQuestions(question)

    assert len(inst.instance.texts) == 1
    assert '| product | units |' in inst.instance.texts[0]
    assert len(inst.instance.tables) == 1
    assert len(inst.instance.answers) == 1


def test_questions_lane_only_writes_wired_lanes():
    g = _loaded_global()
    g.client = SimpleNamespace(
        information_schema=lambda **_kw: {'tables': []},
        query=lambda **_kw: {'rows': [{'a': 1}]},
    )
    inst = _instance(g)
    inst.instance = _FakeLaneInstance(['text'])
    inst.writeQuestions(SimpleNamespace(questions=[SimpleNamespace(text='q')]))
    assert inst.instance.texts and not inst.instance.tables and not inst.instance.answers


def test_questions_lane_emits_structured_error_on_failure():
    g = _loaded_global(max_attempts=1)
    g.client = SimpleNamespace(
        information_schema=lambda **_kw: {'tables': []},
        query=lambda **_kw: (_ for _ in ()).throw(RuntimeError('table not found')),
    )
    inst = _instance(g)
    inst.instance = _FakeLaneInstance(['text', 'answers'])
    inst.writeQuestions(SimpleNamespace(questions=[SimpleNamespace(text='q')]))

    assert inst.instance.answers, 'a failure must still reach the answers lane'
    payload = json.loads(inst.instance.answers[0].answer)
    assert 'error' in payload, 'errors must be structurally distinguishable from prose'


def test_questions_lane_ignores_an_empty_question():
    inst = _instance(_loaded_global())
    inst.instance = _FakeLaneInstance(['text'])
    inst.writeQuestions(SimpleNamespace(questions=[]))
    assert not inst.instance.texts
    assert any('no question text' in m.lower() for m in _WARNING_CALLS)


def test_answers_lane_loads_via_upload_never_insert():
    seen = {}

    def _load(**kw):
        seen['load'] = kw
        return {'row_count': 2}

    g = _loaded_global(table='sales')
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: 'up-1',
        load_table=_load,
        query=lambda **_kw: pytest.fail('the answers lane must never emit SQL'),
    )
    inst = _instance(g)
    inst.instance = _FakeLaneInstance([])
    inst.writeAnswers(_StubAnswer([{'a': 1}, {'a': 2}]))

    assert seen['load']['table'] == 'sales'
    assert seen['load']['mode'] == 'append'
    assert seen['load']['upload_id'] == 'up-1'


def test_answers_lane_wraps_a_single_dict():
    seen = {}
    g = _loaded_global(table='sales')
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda payload, **_k: seen.setdefault('payload', payload) or 'up-1',
        load_table=lambda **_kw: {'row_count': 1},
    )
    inst = _instance(g)
    inst.writeAnswers(_StubAnswer({'a': 1}))
    lines = [ln for ln in seen['payload'].decode().split('\n') if ln.strip()]
    assert [json.loads(ln) for ln in lines] == [{'a': 1}]


def test_rows_are_uploaded_as_ndjson_not_a_json_array():
    """Hotdata rejects a JSON array with 'Expected JSON record to be an object'."""
    payload = iinstance_mod._to_ndjson([{'a': 1}, {'a': 2}])
    text = payload.decode()
    assert not text.lstrip().startswith('['), 'must not be a JSON array'
    lines = [ln for ln in text.split('\n') if ln.strip()]
    assert len(lines) == 2
    assert [json.loads(ln) for ln in lines] == [{'a': 1}, {'a': 2}]
    assert text.endswith('\n')


def test_ndjson_rejects_non_object_rows():
    with pytest.raises(ValueError, match='must be an object'):
        iinstance_mod._to_ndjson([{'a': 1}, [1, 2, 3]])


def test_answers_lane_ignores_empty_payloads():
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: pytest.fail('must not touch the API for an empty payload'),
    )
    inst = _instance(g)
    inst.writeAnswers(_StubAnswer(None))


def test_answers_lane_surfaces_a_load_failure():
    """The answers lane has no output lane to emit to, so swallowing a load
    failure would let the run report success while the rows were never loaded.
    """

    def _boom(**_kw):
        raise RuntimeError('load rejected')

    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: {}, upload_bytes=lambda *_a, **_k: 'u', load_table=_boom)
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='load rejected'):
        inst.writeAnswers(_StubAnswer([{'a': 1}]))


def test_markdown_rendering_escapes_pipes_and_truncates():
    md = iinstance_mod._rows_to_markdown([{'a': 'x|y'}])
    assert 'x\\|y' in md
    many = iinstance_mod._rows_to_markdown([{'a': i} for i in range(150)])
    assert 'more rows not shown' in many
    assert iinstance_mod._rows_to_markdown([]) == 'No rows.'


def test_boolean_query_params_are_lowercased():
    """Requests renders True as "True"; Hotdata rejects anything but true/false."""
    c, rec = _client([_Resp(200, {'tables': []})])
    c.information_schema(connection_id='conn-1', include_columns=True)
    assert rec.calls[0]['params']['include_columns'] == 'true'


def test_none_query_params_are_dropped():
    assert client_mod._encode_params({'a': None, 'b': 1, 'c': False}) == {'b': 1, 'c': 'false'}


def test_get_data_rejects_generated_write_sql_without_calling_the_server():
    """The NL path must apply the same read-only guard as execute."""
    calls = []

    g = _global(max_attempts=2)
    g.client = SimpleNamespace(
        query=lambda **kw: calls.append(kw) or {'rows': []},
        create_database=lambda **_kw: {'id': 'db-1'},
    )
    inst = _instance(g)
    inst._generate_sql = lambda *_a, **_k: 'CREATE TABLE customers (id BIGINT)'

    with pytest.raises(RuntimeError, match='could not answer'):
        inst.get_data({'question': 'make a customers table'})

    assert calls == [], 'generated DDL must never reach the server'


def test_get_data_retries_after_a_rejected_write_and_succeeds():
    """A rejected write is fed back so the next attempt can produce a SELECT."""
    produced = ['DELETE FROM t', 'SELECT 1']
    seen = []

    g = _global(max_attempts=3)
    g.client = SimpleNamespace(
        query=lambda **kw: seen.append(kw.get('sql')) or {'rows': [{'a': 1}]},
        create_database=lambda **_kw: {'id': 'db-1'},
    )
    inst = _instance(g)
    inst._generate_sql = lambda *_a, **_k: produced.pop(0)

    out = inst.get_data({'question': 'anything'})
    assert out['rows'] == [{'a': 1}]
    assert seen == ['SELECT 1'], 'only the SELECT should have been executed'


# ---------------------------------------------------------------------------
# Append de-duplication
#
# Verified against the live API: an identical append took a table from 2 rows to
# 4. Hotdata exposes no idempotency key on loads, so the guard lives here.
# ---------------------------------------------------------------------------


def _load_global(uploads, *, destructive=False):
    g = _global(allow_destructive_load=destructive)
    g._loaded = set()
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        upload_bytes=lambda payload, **_kw: uploads.append(payload) or f'upl-{len(uploads)}',
        load_table=lambda **_kw: {'row_count': 2},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    return g


def test_identical_append_is_skipped_the_second_time():
    uploads = []
    inst = _instance(_load_global(uploads))
    rows = [{'a': 1}, {'a': 2}]

    first = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert not first.get('deduplicated')
    assert len(uploads) == 1

    second = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert second.get('deduplicated') is True
    assert len(uploads) == 1, 'the duplicate append must not reach the server'
    assert any('skipping' in m for m in _WARNING_CALLS)


def test_different_payload_still_appends():
    uploads = []
    inst = _instance(_load_global(uploads))
    inst.load_data({'table': 'orders', 'rows': [{'a': 1}], 'mode': 'append'})
    inst.load_data({'table': 'orders', 'rows': [{'a': 2}], 'mode': 'append'})
    assert len(uploads) == 2


def test_same_payload_to_a_different_table_still_appends():
    uploads = []
    inst = _instance(_load_global(uploads))
    rows = [{'a': 1}]
    inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    inst.load_data({'table': 'invoices', 'rows': rows, 'mode': 'append'})
    assert len(uploads) == 2


def test_replace_is_never_deduplicated():
    uploads = []
    inst = _instance(_load_global(uploads, destructive=True))
    rows = [{'a': 1}]
    inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'replace'})
    out = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'replace'})
    assert not out.get('deduplicated'), 'replace is idempotent by nature - do not skip it'
    assert len(uploads) == 2


def test_get_schema_includes_a_flat_summary_line():
    """Small models miscount columns walking nested JSON; the summary is flat."""
    g = _global()
    g.database = {'id': 'db-1', 'default_connection_id': 'conn-1', 'default_schema': 'main'}
    g.client = SimpleNamespace(
        create_database=lambda **_kw: g.database,
        information_schema=lambda **_kw: {
            'tables': [
                {
                    'schema': 'main',
                    'table': 'orders',
                    'columns': [
                        {'name': 'note', 'data_type': 'Utf8View'},
                        {'name': 'product', 'data_type': 'Utf8View'},
                        {'name': 'region', 'data_type': 'Utf8View'},
                        {'name': 'units', 'data_type': 'Int64'},
                    ],
                }
            ]
        },
    )
    out = _instance(g).get_schema({})
    assert out['summary'] == ['main.orders(note Utf8View, product Utf8View, region Utf8View, units Int64)']
    # every column name must survive into the flat line
    for col in ('note', 'product', 'region', 'units'):
        assert col in out['summary'][0]


def test_schema_summary_handles_a_table_with_no_columns():
    assert iinstance_mod._schema_summary([{'schema': 'main', 'table': 't'}]) == ['main.t(no columns reported)']


# ---------------------------------------------------------------------------
# Destructive-load gate
#
# The SQL surface is read-only, but load_data is a separate write path. A
# capable agent told to "delete the refunded orders" found this in one attempt
# during agentic testing: blocked on DELETE, it called load_data mode=replace
# and wiped the table (6 rows -> 1). These lock the gate shut.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('mode', ['replace', 'update', 'delete'])
def test_destructive_load_modes_refused_by_default(mode):
    g = _global(allow_destructive_load=False)
    g.client = SimpleNamespace(create_database=lambda **_kw: {'id': 'db-1'})
    inst = _instance(g)
    with pytest.raises(ValueError, match='allow_destructive_load'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}], 'mode': mode, 'key': ['a']})


@pytest.mark.parametrize('mode', ['append', 'upsert'])
def test_non_destructive_modes_need_no_gate(mode):
    inst = _instance(_load_global([]))
    out = inst.load_data({'table': 't', 'rows': [{'a': 1}], 'mode': mode, 'key': ['a']})
    assert out['mode'] == mode


def test_destructive_mode_allowed_once_gated_on():
    inst = _instance(_load_global([], destructive=True))
    out = inst.load_data({'table': 't', 'rows': [{'a': 1}], 'mode': 'replace'})
    assert out['mode'] == 'replace'


def test_execute_still_blocks_sql_writes_regardless_of_the_load_gate():
    inst = _instance(_global(allow_destructive_load=True))
    with pytest.raises(ValueError, match='read-only'):
        inst.execute({'sql': "DELETE FROM orders WHERE status='refunded'"})


# ---------------------------------------------------------------------------
# Dedup reservation must not survive a failed load
#
# The append fingerprint is recorded atomically at check time so parallel tool
# calls cannot double-load. That reservation has to be released when the load
# then fails - otherwise the agent's retry is skipped as a duplicate and the
# rows are never loaded, while the tool reports "the table already contains
# these rows".
# ---------------------------------------------------------------------------


def _failing_load_global(calls, fail_times):
    g = _global()
    g._loaded = set()
    state = {'n': 0}

    def _load(**_kw):
        state['n'] += 1
        calls.append(state['n'])
        if state['n'] <= fail_times:
            raise RuntimeError('hotdata: POST /loads failed with HTTP 503')
        return {'row_count': 1}

    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        upload_bytes=lambda payload, **_kw: 'upl-1',
        load_table=_load,
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    return g


def test_failed_append_can_be_retried_and_actually_loads():
    calls = []
    inst = _instance(_failing_load_global(calls, fail_times=1))
    rows = [{'a': 1}]

    with pytest.raises(RuntimeError):
        inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})

    # The retry must reach the server, not be swallowed as a duplicate.
    out = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert not out.get('deduplicated'), 'a retry after a failed load must not be treated as a duplicate'
    assert len(calls) == 2, f'expected the retry to hit load_table, got {len(calls)} call(s)'


def test_successful_append_is_still_deduplicated():
    calls = []
    inst = _instance(_failing_load_global(calls, fail_times=0))
    rows = [{'a': 1}]
    inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    out = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert out.get('deduplicated') is True
    assert len(calls) == 1, 'the second identical append must not reach the server'


def test_result_id_load_failure_propagates_without_nameerror():
    """The failure handler releases the dedup reservation; the result_id path
    never creates one, so the name must still be bound. This regressed once.
    """
    g = _global()
    g._loaded = set()
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        load_table=lambda **_kw: (_ for _ in ()).throw(RuntimeError('load failed')),
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='load failed'):
        inst.load_data({'table': 't', 'result_id': 'res-1', 'mode': 'append'})


# ---------------------------------------------------------------------------
# CodeRabbit findings on PR #1937
# ---------------------------------------------------------------------------


def test_retry_after_zero_does_not_spin(monkeypatch):
    """`Retry-After: 0` is a legal header. Without a floor the retry loop would
    re-issue with no pause until the whole budget was spent, flooding a server
    that is already shedding load.
    """
    slept = []
    monkeypatch.setattr(client_mod.time, 'sleep', lambda d: slept.append(d))
    c, rec = _client([_Resp(429, headers={'Retry-After': '0'}), _Resp(200, {'id': 'db-1'})])
    c.create_database('n', '24h')
    assert slept, 'a zero Retry-After must still pause'
    assert min(slept) >= client_mod.BASE_BACKOFF_S


def test_drop_database_clears_the_dedup_fingerprints():
    """Fingerprints describe one specific database. Keeping them across a drop
    would make an identical append to the replacement report deduplicated
    without loading anything.
    """
    g = _global()
    handle = {'id': 'db-1'}
    g.database = handle
    g._loaded = set()
    assert g.seen_load('fp-1') is False
    g.drop_database(handle)
    assert g.database is None
    assert g.seen_load('fp-1') is False, 'the fingerprint should not survive the drop'


def test_pending_envelope_is_matched_case_insensitively():
    """A 'Pending' 202 envelope must be followed, not treated as finished."""
    polls = [{'status': 'succeeded', 'row_count': 3}]
    g = _global()
    g.client = SimpleNamespace(get_job=lambda _i: polls.pop(0))
    inst = _instance(g)
    out = inst._await_job({'status': 'Pending', 'id': 'job-1'})
    assert out.get('row_count') == 3, 'the job should have been polled to completion'


def test_partial_load_releases_the_dedup_reservation():
    """Only some rows landed, so a retry of the same payload must reach the
    server rather than being skipped as a duplicate.
    """
    jobs = [
        {'status': 'partially_succeeded', 'id': 'job-1'},
        {'status': 'succeeded', 'row_count': 1},
    ]
    calls = []
    g = _global()
    g._loaded = set()
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        upload_bytes=lambda *_a, **_k: 'upl-1',
        # JobStatus per the published spec: pending|running|succeeded|partially_succeeded|failed
        load_table=lambda **_kw: calls.append(1) or {'status': 'pending', 'id': 'job-1'},
        get_job=lambda _i: jobs.pop(0),
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    inst = _instance(g)
    rows = [{'a': 1}]
    first = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert first.get('partial') is True
    second = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert not second.get('deduplicated'), 'a partial load must be retryable'
    assert len(calls) == 2
