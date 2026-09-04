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
    """Mirrors rocketride.schema.Answer: getJson is a bare json.loads that raises.

    Agents write their answer as text (``Answer(expectJson=False)``), so the
    stub must reproduce that path exactly - a stub that returned None for prose
    would hide the failure the answers lane exists to survive.
    """

    def __init__(self, payload=None):
        self._payload = payload
        self.answer = None

    def getJson(self):
        if self._payload is None:
            return None
        if isinstance(self._payload, (dict, list)):
            return self._payload
        try:
            return json.loads(self._payload)
        except json.JSONDecodeError:
            raise ValueError('Answer is not in JSON format.')

    def getText(self):
        if self._payload is None:
            return ''
        if isinstance(self._payload, (dict, list)):
            return json.dumps(self._payload)
        return str(self._payload)

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
    g.database_id = ''
    g.attached = False
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


def _locked(message='another operation is already running for conn:x:main:t; retry shortly'):
    return _Resp(409, {'error': {'message': message, 'code': 'RESOURCE_LOCKED'}})


def test_resource_locked_is_retried_on_post():
    """Hotdata serializes writes per table: concurrent publishers into one shared
    table get 409 RESOURCE_LOCKED. Measured live, 7 of 8 concurrent appends were
    rejected. The request is refused before doing anything, so replaying a POST
    here cannot double-load.
    """
    c, rec = _client([_locked(), _locked(), _Resp(200, {'load_id': 'ld-1'})])
    assert c.load_table(database_id='db-1', schema='main', table='t', upload_id='up-1') == {'load_id': 'ld-1'}
    assert len(rec.calls) == 3


def test_resource_locked_honors_retry_after(monkeypatch):
    slept = []
    monkeypatch.setattr(client_mod.time, 'sleep', lambda d: slept.append(d))
    locked = _locked()
    locked.headers = {'Retry-After': '2'}
    c, _ = _client([locked, _Resp(200, {})])
    c.load_table(database_id='db-1', schema='main', table='t', upload_id='up-1')
    assert slept == [2.0]


def test_plain_conflict_is_not_retried():
    """409 also means 'table already exists' and 'upload already consumed'. Those
    describe work that DID happen - replaying them is wrong, and _ensure_table
    depends on seeing the status.
    """
    c, rec = _client([_Resp(409, {'error': {'message': 'table exists', 'code': 'CONFLICT'}}), _Resp(200, {})])
    with pytest.raises(client_mod.HotdataError) as excinfo:
        c.create_table(database_id='db-1', schema='main', name='t')
    assert excinfo.value.status_code == 409
    assert len(rec.calls) == 1


def test_resource_locked_budget_exhaustion_names_the_writer_contention(monkeypatch):
    """Exhaustion must come from actually looping, not from one oversized
    Retry-After aborting on the first attempt. Backoff is capped at
    MAX_BACKOFF_S, so a short budget is spent over several real retries.
    """
    slept = []
    monkeypatch.setattr(client_mod.time, 'sleep', lambda d: slept.append(d))
    c, rec = _client([_locked() for _ in range(50)])
    c.retry_budget_s = 4.0
    err = None
    try:
        c.load_table(database_id='db-1', schema='main', table='t', upload_id='up-1')
    except client_mod.HotdataError as e:
        err = e
    assert err is not None and 'locked by another writer' in str(err)
    assert err.status_code == 409 and err.error_code == 'RESOURCE_LOCKED', (
        'callers branch on the code to tell contention from "already exists"'
    )
    assert len(rec.calls) > 1, f'must actually retry before giving up, made {len(rec.calls)} call(s)'
    assert slept, 'must back off between attempts'


def test_database_creation_is_never_replayed_on_a_lock():
    """The one request whose replay is not provably harmless: it mints a billable
    resource and returns the only copy of its id, so a replay after the server
    did create one would orphan it until its TTL fired.
    """
    c, rec = _client([_locked(), _Resp(200, {'id': 'db-1'})])
    with pytest.raises(client_mod.HotdataError):
        c.create_database('n', '24h')
    assert len(rec.calls) == 1


def test_lock_retry_still_applies_to_table_writes():
    c, rec = _client([_locked(), _Resp(200, {})])
    c.create_table(database_id='db-1', schema='main', name='t')
    assert len(rec.calls) == 2


def test_error_code_reads_both_body_shapes():
    assert client_mod._error_code(_Resp(409, {'error': {'code': 'RESOURCE_LOCKED'}})) == 'RESOURCE_LOCKED'
    assert client_mod._error_code(_Resp(409, {'code': 'CONFLICT'})) == 'CONFLICT'
    assert client_mod._error_code(_Resp(409, {})) == ''
    assert client_mod._error_code(_Resp(409, 'not json')) == ''


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


def test_attached_get_database_does_not_create_database():
    created = []
    g = _global(database_id='db-shared')
    g.client = SimpleNamespace(create_database=lambda **kw: created.append(kw))

    assert g.get_database() == {
        'id': 'db-shared',
        'default_schema': 'main',
        'attached': True,
    }
    assert created == []
    assert g.attached is True


def test_non_attached_get_database_still_creates_database():
    created = []
    g = _global()
    g.client = SimpleNamespace(create_database=lambda **kw: created.append(kw) or {'id': 'db-created'})

    assert g.get_database() == {'id': 'db-created'}
    assert len(created) == 1
    assert g.attached is False


def test_drop_database_clears_only_the_matching_handle():
    g = _global()
    handle = {'id': 'db-1'}
    g.database = handle
    g.drop_database({'id': 'other'})
    assert g.database is handle
    g.drop_database(handle)
    assert g.database is None


def test_drop_database_keeps_an_attached_handle():
    g = _global(database_id='db-shared', attached=True)
    handle = {'id': 'db-shared', 'default_schema': 'main', 'attached': True}
    g.database = handle

    g.drop_database(handle)

    assert g.database is handle


def test_end_global_deletes_and_clears_secrets():
    deleted = []
    g = _global()
    g.database = {'id': 'db-1'}
    g.client = SimpleNamespace(delete_database=lambda i: deleted.append(i))
    g.endGlobal()
    assert deleted == ['db-1']
    assert g.database is None and g.client is None
    assert g.apikey == '' and g.workspace_id == ''


def test_end_global_does_not_delete_attached_database():
    """Only the remote delete is skipped. The local handle is dropped either way.

    Keeping it would let a second beginGlobal on the same object - which resets
    `attached` to False - inherit a database it does not own and delete it at the
    next teardown.
    """
    deleted = []
    g = _global(database_id='db-shared', attached=True)
    g.database = {'id': 'db-shared', 'default_schema': 'main', 'attached': True}
    g.client = SimpleNamespace(delete_database=lambda i: deleted.append(i))

    g.endGlobal()

    assert deleted == [], 'an attached database must never be deleted'
    assert g.database is None and g.attached is False
    assert any('left in place' in message for message in _DEBUG_CALLS)


def test_a_reopened_global_cannot_inherit_an_attached_database():
    """The stale-handle path, end to end: attach, tear down, reopen without
    database_id, and confirm the second run creates its own database instead of
    adopting - and then deleting - the shared one.
    """
    deleted = []
    g = _global(database_id='db-shared', attached=True)
    g.database = {'id': 'db-shared', 'default_schema': 'main', 'attached': True}
    g.client = SimpleNamespace(delete_database=lambda i: deleted.append(i))
    g.endGlobal()

    # Reopen with no database_id: this run owns whatever it creates.
    g.database_id = ''
    g.attached = False
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-own'},
        delete_database=lambda i: deleted.append(i),
    )
    assert g.get_database()['id'] == 'db-own'
    g.endGlobal()
    assert deleted == ['db-own'], f'must delete only its own database, deleted={deleted}'


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


def test_run_sql_surfaces_result_id_when_present():
    g = _loaded_global()
    g.client = SimpleNamespace(
        query=lambda **_kw: {'rows': [{'a': 1}], 'result_id': 'result-1'},
    )

    out = _instance(g)._run_sql('SELECT 1 AS a', 10)

    assert out['result_id'] == 'result-1'


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
        raise client_mod.HotdataError('hotdata: POST ... failed with HTTP 409', status_code=409)

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


def test_build_index_on_an_attached_database_names_the_owning_run():
    g = _loaded_global(attached=True)
    g.database = {'id': 'db-shared', 'default_schema': 'main', 'attached': True}
    g.client = SimpleNamespace(create_index=lambda **_kw: {})
    inst = _instance(g)
    with pytest.raises(ValueError, match='run that created the database'):
        inst.build_index({'table': 'docs', 'column': 'body'})


def test_build_index_on_an_owned_database_reports_the_real_symptom():
    """Only an attached run is EXPECTED to lack a connection id. A database we
    created that has none is an unexpected create response, and blaming
    attachment would send the caller looking in the wrong place.
    """
    g = _loaded_global(attached=False)
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    g.client = SimpleNamespace(create_index=lambda **_kw: {})
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='no default_connection_id'):
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


def test_get_schema_falls_back_to_sql_without_connection_id():
    seen = {}

    def _query(**kw):
        seen.update(kw)
        return {
            'rows': [
                {
                    'table_schema': 'main',
                    'table_name': 'orders',
                    'column_name': 'id',
                    'data_type': 'Int64',
                },
                {
                    'table_schema': 'main',
                    'table_name': 'orders',
                    'column_name': 'total',
                    'data_type': 'Float64',
                },
            ]
        }

    g = _global(database_id='db-shared', attached=True)
    g.database = {'id': 'db-shared', 'default_schema': 'main', 'attached': True}
    g.client = SimpleNamespace(query=_query)

    out = _instance(g).get_schema({})

    assert out == {
        'summary': ['main.orders(id Int64, total Float64)'],
        'tables': [
            {
                'schema': 'main',
                'table': 'orders',
                'columns': [
                    {'name': 'id', 'data_type': 'Int64'},
                    {'name': 'total', 'data_type': 'Float64'},
                ],
            }
        ],
        'database_id': 'db-shared',
    }
    assert 'FROM information_schema.columns' in seen['sql']
    assert seen['database_id'] == 'db-shared'


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


def _captured_rows(payload, table='sales'):
    """Run a payload through the answers lane and return the rows that got loaded."""
    seen = {}
    g = _loaded_global(table=table)
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda body, **_k: seen.setdefault('payload', body) or 'up-1',
        load_table=lambda **_kw: {'row_count': 1},
    )
    inst = _instance(g)
    inst.writeAnswers(_StubAnswer(payload))
    lines = [ln for ln in seen.get('payload', b'').decode().split('\n') if ln.strip()]
    return [json.loads(ln) for ln in lines]


def test_answers_lane_accepts_a_fenced_json_object():
    """Agents emit their answer as text and fence it. getJson() alone would raise,
    which would make structural publishing as unreliable as agent-driven writes.
    """
    fenced = '```json\n{"room": "room-1", "note": "C4"}\n```'
    assert _captured_rows(fenced) == [{'room': 'room-1', 'note': 'C4'}]


def test_answers_lane_accepts_json_after_prose():
    answer = 'Here is my verdict:\n{"room": "room-2", "note": "G4"}\nHope that helps.'
    assert _captured_rows(answer) == [{'room': 'room-2', 'note': 'G4'}]


def test_answers_lane_accepts_a_plain_json_string():
    assert _captured_rows('{"room": "room-3"}') == [{'room': 'room-3'}]


def test_answers_lane_unwraps_only_the_reserved_rows_envelope():
    """{"rows": [...]} becomes N rows. Nothing else does.

    `items`, `data` and `results` are all plausible business column names, so
    unwrapping them would turn one legitimate record into several and drop the
    column - a silent loss. Guessing wrong the other way is visible.
    """
    assert _captured_rows('{"rows": [{"id": 1}, {"id": 2}]}') == [{'id': 1}, {'id': 2}]
    for key in ('records', 'items', 'data', 'results', 'entries'):
        payload = f'{{"{key}": [{{"id": 3}}]}}'
        assert _captured_rows(payload) == [{key: [{'id': 3}]}], f'{key} must not be unwrapped'


def test_answers_lane_does_not_explode_an_unnamed_nested_list():
    """Only the documented wrapper names unwrap. A row that legitimately holds a
    list of objects is ONE row - exploding it would drop the column and multiply
    the row count, silently.
    """
    rows = _captured_rows('{"line_items": [{"sku": "A"}, {"sku": "B"}]}')
    assert rows == [{'line_items': [{'sku': 'A'}, {'sku': 'B'}]}]


def test_answers_lane_keeps_a_multi_key_object_as_one_row():
    rows = _captured_rows('{"room": "room-1", "notes": ["C4", "G4"]}')
    assert rows == [{'room': 'room-1', 'notes': ['C4', 'G4']}]


def test_answers_lane_rejects_prose_with_the_text_quoted():
    """Silently skipping would leave an empty table with nothing to explain it."""
    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: pytest.fail('must not reach the API'))
    inst = _instance(g)
    with pytest.raises(ValueError, match='I looked at the data'):
        inst.writeAnswers(_StubAnswer('I looked at the data and found nothing of note.'))


def test_answers_lane_rejects_a_list_of_scalars():
    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: pytest.fail('must not reach the API'))
    inst = _instance(g)
    with pytest.raises(ValueError, match='must be an object'):
        inst.writeAnswers(_StubAnswer('["C4", "G4"]'))


def test_answers_lane_rejects_a_partly_malformed_batch():
    """Filtering the bad entries out would load a subset and report success."""
    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: pytest.fail('must not reach the API'))
    inst = _instance(g)
    with pytest.raises(ValueError, match='must be an object'):
        inst.writeAnswers(_StubAnswer('[{"id": 1}, "unavailable", {"id": 2}]'))


def test_answers_lane_finds_the_row_after_an_unrelated_json_value():
    """The first decodable value in the prose is often not the row. Taking it and
    giving up would discard an answer that is right there.
    """
    assert _captured_rows('Scores: [1, 2, 3]. Row: {"id": 7}') == [{'id': 7}]


def test_answers_lane_treats_an_empty_object_as_no_rows():
    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: pytest.fail('must not reach the API'))
    inst = _instance(g)
    inst.writeAnswers(_StubAnswer('{}'))


def test_answers_lane_ignores_blank_text():
    g = _loaded_global()
    g.client = SimpleNamespace(create_table=lambda **_kw: pytest.fail('must not reach the API'))
    inst = _instance(g)
    inst.writeAnswers(_StubAnswer('   '))


def test_json_from_text_offers_candidates_in_preference_order():
    assert iinstance_mod._json_from_text('```\n{"a": {"b": 1}}\n```')[0] == {'a': {'b': 1}}
    assert iinstance_mod._json_from_text('noise {"a": "}"} tail')[0] == {'a': '}'}
    assert iinstance_mod._json_from_text('no json here') == []
    # A fence whose first line IS the JSON must not have that line eaten as a tag.
    assert iinstance_mod._json_from_text('```\n{"a":1}\n```')[0] == {'a': 1}


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


class _MissingColumn(RuntimeError):
    """The live 400: an append that omits a column the table already has."""

    status_code = 400

    def __init__(self, column='room'):
        super().__init__(
            f"hotdata: POST /loads failed with HTTP 400: upload is missing column '{column}'; "
            'an append must carry every column the table has, since a column left out of the '
            'write would be dropped from the table.'
        )


def _widening_global(columns, uploads, loads):
    """A global whose first load is refused for a missing column, second accepted."""
    calls = {'load': 0}

    def _load(**kw):
        calls['load'] += 1
        if calls['load'] == 1:
            raise _MissingColumn()
        loads.append(kw)
        return {'row_count': 1}

    g = _loaded_global(table='agent_answers')
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda payload, **_k: (uploads.append(payload), f'up-{len(uploads)}')[1],
        load_table=_load,
        query=lambda **_kw: {'rows': [{'column_name': c} for c in columns]},
    )
    return g


def test_load_widens_rows_to_the_tables_full_column_set():
    """Hotdata refuses a write that omits a column: leaving one out would drop it.

    Two producers writing different shapes into one shared table is the whole
    point of a shared-evidence or telemetry database, so the second producer
    must not simply fail.
    """
    uploads, loads = [], []
    g = _widening_global(['session', 'room', 'beat', 'note'], uploads, loads)
    inst = _instance(g)
    out = inst.load_data({'table': 'agent_answers', 'rows': [{'session': 's', 'beat': 1, 'agent': 'a'}]})

    assert len(uploads) == 2, 'the refused upload is consumed; the retry needs a fresh one'
    widened = [json.loads(ln) for ln in uploads[1].decode().split('\n') if ln.strip()]
    assert widened == [{'session': 's', 'room': None, 'beat': 1, 'note': None, 'agent': 'a'}], (
        'absent columns fill with null, and a new column the table lacks is kept'
    )
    assert out.get('row_count') == 1


def test_widening_re_reads_a_table_that_grew_under_it():
    """A concurrent producer can add a column between our schema read and our
    retry, so the widened payload arrives stale and is refused for a DIFFERENT
    missing column. One attempt would surface that as an unactionable failure.
    """
    uploads, loads = [], []
    schema_reads = {'n': 0}
    calls = {'load': 0}

    def _load(**kw):
        calls['load'] += 1
        if calls['load'] == 1:
            raise _MissingColumn('room')
        if calls['load'] == 2:
            raise _MissingColumn('wave')  # another writer widened the table
        loads.append(kw)
        return {'row_count': 1}

    def _query(**_kw):
        schema_reads['n'] += 1
        cols = ['session', 'room'] if schema_reads['n'] == 1 else ['session', 'room', 'wave']
        return {'rows': [{'column_name': c} for c in cols]}

    g = _loaded_global(table='agent_answers')
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda payload, **_k: (uploads.append(payload), f'up-{len(uploads)}')[1],
        load_table=_load,
        query=_query,
    )
    inst = _instance(g)
    out = inst.load_data({'table': 'agent_answers', 'rows': [{'session': 's'}]})

    assert schema_reads['n'] == 2, 'must re-read the schema after the second refusal'
    widened = [json.loads(ln) for ln in uploads[-1].decode().split('\n') if ln.strip()]
    assert widened == [{'session': 's', 'room': None, 'wave': None}]
    assert out.get('row_count') == 1


def test_widening_gives_up_after_a_bounded_number_of_attempts():
    """Each attempt costs an upload, so a table that keeps growing must not spin."""
    uploads = []

    def _load(**_kw):
        raise _MissingColumn('always-something-new')

    g = _loaded_global(table='t')
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda payload, **_k: (uploads.append(payload), 'up')[1],
        load_table=_load,
        query=lambda **_kw: {'rows': [{'column_name': c} for c in ('a', 'b')]},
    )
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='missing column'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}]})
    # Exactly: one original upload plus one per widening attempt. `<=` would let a
    # regression that stopped retrying after the first attempt pass unnoticed.
    assert len(uploads) == iinstance_mod._WIDEN_ATTEMPTS + 1


def test_load_does_not_widen_when_nothing_would_change():
    """No column is missing after all - re-loading would duplicate rows for nothing."""
    uploads, loads = [], []
    g = _widening_global(['session', 'beat'], uploads, loads)
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='missing column'):
        inst.load_data({'table': 'agent_answers', 'rows': [{'session': 's', 'beat': 1}]})
    assert len(uploads) == 1, 'must not re-upload an identical payload'


def test_load_does_not_widen_on_an_unrelated_failure():
    def _boom(**_kw):
        raise RuntimeError('load rejected')

    uploads = []
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda payload, **_k: (uploads.append(payload), 'u')[1],
        load_table=_boom,
        query=lambda **_kw: pytest.fail('an unrelated failure must not trigger schema introspection'),
    )
    inst = _instance(g)
    with pytest.raises(RuntimeError, match='load rejected'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}]})
    assert len(uploads) == 1


class _TypeConflict(RuntimeError):
    """The live 409 that follows null-filling a numeric column."""

    status_code = 409

    def __init__(self):
        super().__init__(
            "hotdata: POST /loads failed with HTTP 409: column 'confidence' can't change type from "
            'float64 to varchar automatically'
        )


def test_widening_a_numeric_column_to_null_explains_the_real_fix():
    """Null in every row re-types the column, and the server refuses.

    No payload satisfies both "carry every column" and "do not re-type a column",
    so the node has to name the design fix rather than pass a bare CONFLICT up.
    """
    calls = {'load': 0}

    def _load(**_kw):
        calls['load'] += 1
        raise _MissingColumn('confidence') if calls['load'] == 1 else _TypeConflict()

    g = _loaded_global(table='agent_answers')
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: 'up',
        load_table=_load,
        query=lambda **_kw: {'rows': [{'column_name': c} for c in ('session', 'confidence')]},
    )
    inst = _instance(g)
    with pytest.raises(ValueError) as excinfo:
        inst.load_data({'table': 'agent_answers', 'rows': [{'session': 's'}]})
    message = str(excinfo.value)
    assert 'confidence' in message
    assert 'own table' in message, 'the message must name the fix, not just the symptom'


def test_type_conflict_detection_is_status_scoped():
    assert iinstance_mod._is_type_conflict(_TypeConflict()) is True
    assert iinstance_mod._is_type_conflict(_MissingColumn()) is False


def test_projection_is_append_only():
    """Null-filling is additive for an append and destructive for anything else:
    an upsert of {"id": 7, "note": "x"} widened with balance=null would wipe the
    stored balance. Those modes must fail instead.
    """
    calls = {'load': 0}

    def _load(**_kw):
        calls['load'] += 1
        raise _MissingColumn('balance')

    g = _loaded_global(table='accounts', allow_destructive_load=True)
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        upload_bytes=lambda *_a, **_k: 'up',
        load_table=_load,
        query=lambda **_kw: pytest.fail('a non-append load must not widen'),
    )
    inst = _instance(g)
    for mode in ('upsert', 'update', 'replace'):
        calls['load'] = 0
        with pytest.raises(RuntimeError, match='missing column'):
            inst.load_data({'table': 'accounts', 'rows': [{'id': 7, 'note': 'x'}], 'mode': mode, 'key': ['id']})
        assert calls['load'] == 1, f'{mode} must not retry with a widened payload'


def test_ensure_table_does_not_mistake_lock_exhaustion_for_an_existing_table():
    """409 carries two opposite meanings. Swallowing RESOURCE_LOCKED as "already
    exists" would send us on to load into a table that may not be there, and
    report a confusing table-not-found instead of the real contention.
    """
    locked = client_mod.HotdataError('still locked by another writer', status_code=409, error_code='RESOURCE_LOCKED')

    def _create(**_kw):
        raise locked

    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=_create,
        upload_bytes=lambda *_a, **_k: pytest.fail('must not upload when the table is unresolved'),
    )
    inst = _instance(g)
    with pytest.raises(client_mod.HotdataError, match='locked by another writer'):
        inst.load_data({'table': 't', 'rows': [{'a': 1}]})


def test_ensure_table_still_treats_a_plain_conflict_as_success():
    loaded = {}
    exists = client_mod.HotdataError('table exists', status_code=409, error_code='CONFLICT')

    def _create(**_kw):
        raise exists

    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=_create,
        upload_bytes=lambda *_a, **_k: 'up',
        load_table=lambda **kw: loaded.update(kw) or {'row_count': 1},
    )
    inst = _instance(g)
    assert inst.load_data({'table': 't', 'rows': [{'a': 1}]})['row_count'] == 1
    assert loaded['table'] == 't'


def test_result_id_append_is_deduplicated():
    """This path is advertised to agents on execute and get_data, and appending a
    query result is no more idempotent than appending rows.
    """
    loads = []
    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=lambda **_kw: {},
        load_table=lambda **kw: loads.append(kw) or {'row_count': 5},
    )
    inst = _instance(g)
    first = inst.load_data({'table': 't', 'result_id': 'res-1'})
    second = inst.load_data({'table': 't', 'result_id': 'res-1'})
    assert len(loads) == 1, 'the second identical result load must not be sent'
    assert second.get('deduplicated') is True
    assert not first.get('deduplicated')


def test_result_id_is_withheld_when_the_rows_were_truncated():
    """result_id names the whole server-side result; rows is only the first
    `limit` of it. Offering both together invites an agent to materialise far
    more than it saw.
    """
    g = _loaded_global(max_execute_rows=2)
    g.client = SimpleNamespace(query=lambda **_kw: {'rows': [{'a': 1}, {'a': 2}, {'a': 3}], 'result_id': 'res-9'})
    inst = _instance(g)
    out = inst._run_sql('SELECT 1', 2)
    assert out['row_count'] == 2
    assert 'result_id' not in out, 'a truncated window must not advertise the full result'


def test_missing_column_detection_is_status_scoped():
    assert iinstance_mod._is_missing_column(_MissingColumn()) is True
    generic = RuntimeError('upload is missing column x')
    assert iinstance_mod._is_missing_column(generic) is False, 'no status means not our 400'


def test_table_columns_refuses_an_unsafe_identifier():
    """The name is interpolated into SQL, so it is re-validated rather than trusted."""
    g = _loaded_global()
    g.client = SimpleNamespace(query=lambda **_kw: pytest.fail('must not reach the API'))
    inst = _instance(g)
    assert inst._table_columns('main', "t'; DROP--") == []
    assert inst._table_columns('main', 'a.b') == []


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
    g._loaded = {}
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
    g._loaded = {}
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
    g._loaded = {}
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
    g._loaded = {}
    assert g.seen_load('fp-1') is None, 'first sight of a payload reserves it'
    g.record_load('fp-1', 'complete')
    assert g.seen_load('fp-1') == 'complete'
    g.drop_database(handle)
    assert g.database is None
    assert g.seen_load('fp-1') is None, 'the fingerprint should not survive the drop'


def test_pending_envelope_is_matched_case_insensitively():
    """A 'Pending' 202 envelope must be followed, not treated as finished."""
    polls = [{'status': 'succeeded', 'row_count': 3}]
    g = _global()
    g.client = SimpleNamespace(get_job=lambda _i: polls.pop(0))
    inst = _instance(g)
    out = inst._await_job({'status': 'Pending', 'id': 'job-1'})
    assert out.get('row_count') == 3, 'the job should have been polled to completion'


def test_partial_append_keeps_its_reservation_and_warns_against_retry():
    """Append is not idempotent. A partial load means an unknown subset already
    landed, so releasing the reservation would let a blind retry duplicate
    exactly those rows. Keep it and tell the caller to reconcile instead.
    """
    jobs = [{'status': 'partially_succeeded', 'id': 'job-1'}]
    calls = []
    g = _global()
    g._loaded = {}
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
    assert 'do not simply retry' in first['note'].lower()

    second = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert second.get('deduplicated') is True, 'a partial append must not silently re-append'
    assert len(calls) == 1, 'the retry must not reach the server and duplicate the landed subset'


def test_result_id_load_does_not_claim_zero_rows():
    """A result_id load has no local row count; reporting 0 would claim an empty
    load that may well have inserted rows.
    """
    g = _global()
    g._loaded = {}
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        load_table=lambda **_kw: {'status': 'succeeded'},
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    out = _instance(g).load_data({'table': 'orders', 'result_id': 'res-1', 'mode': 'append'})
    assert 'row_count' not in out, f'unknown count must be omitted, got {out.get("row_count")!r}'


# ---------------------------------------------------------------------------
# Path-segment safety
#
# schema/table/index names arrive as agent tool arguments and are interpolated
# into request paths. Verified before the guard existed: a table named
# '../../other' produced .../tables/../../other/loads, which requests
# normalises into a different endpoint, and 'orders?x=1' injected a query
# string. Refuse rather than escape.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('hostile', ['../../other', 'orders?x=1', 'a/b', 'x#y', 'has space', '', '.'])
def test_hostile_identifiers_are_refused(hostile):
    c, _rec = _client([_Resp(200, {})])
    with pytest.raises(ValueError, match='invalid'):
        c.load_table(
            database_id='db-1',
            schema='main',
            table=hostile,
            mode='append',
            upload_id='u',
            result_id='',
            data_format='json',
            key=None,
            async_after_ms=0,
        )


def test_legitimate_identifiers_build_the_expected_paths():
    c, rec = _client([_Resp(200, {}), _Resp(200, {}), _Resp(200, {})])
    c.load_table(
        database_id='db-1',
        schema='main',
        table='orders_2024',
        mode='append',
        upload_id='u',
        result_id='',
        data_format='json',
        key=None,
        async_after_ms=0,
    )
    assert rec.calls[-1]['url'].endswith('/v1/databases/db-1/schemas/main/tables/orders_2024/loads')
    c.create_index(
        connection_id='conn-1', schema='main', table='orders', index_name='i', index_type='bm25', columns=['note']
    )
    assert rec.calls[-1]['url'].endswith('/v1/connections/conn-1/tables/main/orders/indexes')


def test_a_non_409_failure_mentioning_exists_is_not_swallowed():
    """The 409 branch keys off the status, not the message. A different failure
    whose body happens to say 'exists' must still propagate.
    """

    def _create(**_kw):
        raise client_mod.HotdataError(
            'hotdata: POST ... failed with HTTP 400: column already exists in another table',
            status_code=400,
        )

    g = _loaded_global()
    g.client = SimpleNamespace(
        create_table=_create,
        upload_bytes=lambda *_a, **_k: 'up-1',
        load_table=lambda **_kw: {'row_count': 1},
    )
    with pytest.raises(client_mod.HotdataError, match='HTTP 400'):
        _instance(g).load_data({'table': 'orders', 'rows': [{'a': 1}]})


def test_a_repeated_partial_append_keeps_reporting_partial():
    """A partial outcome must survive the dedup branch. Reporting the repeat as a
    clean duplicate would claim the table holds every row, which the partial
    result contradicts.
    """
    jobs = [{'status': 'partially_succeeded', 'id': 'job-1'}]
    calls = []
    g = _global()
    g._loaded = {}
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        upload_bytes=lambda *_a, **_k: 'upl-1',
        load_table=lambda **_kw: calls.append(1) or {'status': 'pending', 'id': 'job-1'},
        get_job=lambda _i: jobs.pop(0),
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    inst = _instance(g)
    rows = [{'a': 1}]

    first = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert first.get('partial') is True

    second = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert second.get('deduplicated') is True
    assert second.get('partial') is True, 'the repeat must still be reported as partial'
    assert 'row_count' not in second, 'the landed subset is unknown - do not claim the full count'
    assert 'only what is missing' in second['note']
    assert len(calls) == 1, 'the repeat must not reach the server'


# ---------------------------------------------------------------------------
# Reservation states must stay distinct
#
# seen_load() returns 'pending' while a load is still in flight. Treating that
# as a completed dedup told a concurrent caller the rows were already present
# before the original load had finished - and if that original then failed and
# released the reservation, the rows never landed at all.
# ---------------------------------------------------------------------------


def _blocking_load_global(gate, calls):
    g = _global()
    g._loaded = {}

    def _load(**_kw):
        calls.append(1)
        gate.wait(timeout=5)
        return {'row_count': 1}

    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        upload_bytes=lambda *_a, **_k: 'upl-1',
        load_table=_load,
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    return g


def test_concurrent_identical_append_gets_in_progress_not_false_success():
    gate = threading.Event()
    calls = []
    inst = _instance(_blocking_load_global(gate, calls))
    rows = [{'a': 1}]
    results = {}

    def _run_first():
        try:
            results['first'] = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
        except Exception as exc:  # reported below instead of hanging the suite
            results['error'] = exc

    first = threading.Thread(target=_run_first)
    first.start()
    # Bounded wait. If the first call fails before reaching load_table, `calls`
    # never fills, and an unbounded loop here would hang the entire test suite.
    deadline = time.monotonic() + 5
    while not calls and time.monotonic() < deadline:
        time.sleep(0.01)
    if not calls:
        gate.set()
        first.join(timeout=5)
        pytest.fail(f'the first load never reached load_table: {results.get("error")!r}')

    second = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert second.get('in_progress') is True, 'a mid-flight duplicate must not report completion'
    assert 'deduplicated' not in second, 'in-flight is not a completed dedup'
    assert 'row_count' not in second, 'nothing has landed yet - claim no count'

    gate.set()
    first.join(timeout=5)
    assert calls == [1], 'the concurrent call must not have reached the server'


def test_pending_then_failure_lets_a_retry_through():
    """A caller that saw 'pending' was told nothing landed. When the original
    load then fails, the reservation is released so a genuine retry can run.
    """
    calls = []

    def _load(**_kw):
        calls.append(1)
        raise RuntimeError('hotdata: POST /loads failed with HTTP 503')

    g = _global()
    g._loaded = {}
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        upload_bytes=lambda *_a, **_k: 'upl-1',
        load_table=_load,
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    inst = _instance(g)
    rows = [{'a': 1}]

    with pytest.raises(RuntimeError):
        inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert g._loaded == {}, 'a failed load must not leave a reservation behind'

    with pytest.raises(RuntimeError):
        inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert len(calls) == 2, 'the retry must reach the server, not be swallowed as a duplicate'


# ---------------------------------------------------------------------------
# get_sql must apply the same guard as get_data and execute
#
# Raised in review: get_sql handed back generated SQL unchecked, so a write verb
# or a semicolon batch came back as a "query" the node's own execute would then
# refuse - and unlike get_data there was no corrective retry. All three paths
# now ask the same question via _validate_generated_sql.
# ---------------------------------------------------------------------------


def test_get_sql_retries_when_the_model_returns_a_write():
    """First answer is a DELETE; the model gets the error fed back and the
    corrected SELECT is what the caller receives.
    """
    g = _loaded_global(max_attempts=3)
    inst = _llm_instance(g, ["DELETE FROM orders WHERE status='refunded'", 'SELECT * FROM orders'])
    out = inst.get_sql({'question': 'clean up the refunds'})
    assert out['sql'] == 'SELECT * FROM orders'
    assert len(inst.asked) == 2, 'the write should have triggered one regeneration'
    assert 'read-only' in inst.asked[1].all_text(), 'the rejection reason must reach the model'


def test_get_sql_refuses_rather_than_returning_unusable_sql():
    """When every attempt is a write, failing is better than handing back SQL
    the node's own execute would refuse - the caller gets a clear reason.
    """
    g = _loaded_global(max_attempts=2)
    inst = _llm_instance(g, ['DROP TABLE orders', 'TRUNCATE orders'])
    with pytest.raises(RuntimeError, match='could not generate acceptable SQL'):
        inst.get_sql({'question': 'wipe it'})


def test_get_sql_rejects_a_semicolon_batch():
    g = _loaded_global(max_attempts=2)
    inst = _llm_instance(g, ['SELECT 1; SELECT 2', 'SELECT 1'])
    assert inst.get_sql({'question': 'two things'})['sql'] == 'SELECT 1'


def test_all_three_sql_paths_share_one_validator():
    """get_data, get_sql and execute must agree on what is acceptable."""
    inst = _instance(_global())
    for sql in ('DELETE FROM t', 'SELECT 1; SELECT 2'):
        _cleaned, invalid = inst._validate_generated_sql(sql)
        assert invalid, f'{sql!r} should be rejected by the shared validator'
    _cleaned, invalid = inst._validate_generated_sql('SELECT 1;')
    assert not invalid, 'a single statement with a trailing semicolon is fine'


# ---------------------------------------------------------------------------
# Dedup must not outlive the database it describes
#
# Seen live during a demo: an identical append was skipped as a duplicate, then
# the follow-up query failed with "table 'default.main.orders' not found". The
# fingerprint had been keyed on schema.table + payload only, so a record from a
# previous database still matched and suppressed the load that would have
# created the table in the current one.
# ---------------------------------------------------------------------------


def _swappable_db_global(calls):
    g = _global()
    g._loaded = {}
    g.client = SimpleNamespace(
        create_database=lambda **_kw: {'id': 'db-1', 'default_schema': 'main'},
        create_table=lambda **_kw: {},
        information_schema=lambda **_kw: {'tables': []},
        upload_bytes=lambda *_a, **_k: 'upl-1',
        load_table=lambda **_kw: calls.append(1) or {'row_count': 1},
    )
    g.database = {'id': 'db-1', 'default_schema': 'main'}
    return g


def test_a_new_database_does_not_inherit_the_previous_dedup_records():
    calls = []
    g = _swappable_db_global(calls)
    inst = _instance(g)
    rows = [{'a': 1}]

    inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})
    assert len(calls) == 1

    # the run moves to a different database; the payload has never been loaded there
    g.database = {'id': 'db-2', 'default_schema': 'main'}
    out = inst.load_data({'table': 'orders', 'rows': rows, 'mode': 'append'})

    assert not out.get('deduplicated'), 'a different database must not reuse the old fingerprint'
    assert len(calls) == 2, 'the load must actually run against the new database'
