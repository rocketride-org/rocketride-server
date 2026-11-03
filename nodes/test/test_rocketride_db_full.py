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

"""Integration tests for the RocketRide cloud DB nodes (real PostgreSQL).

Runs the ``rocketride_sql`` and ``rocketride_vector`` nodes end-to-end against
a local PostgreSQL container standing in for the cloud data-core, connected
through the real seam (the DSN delivered in ``ROCKETRIDE_DB_DSNS``, as the
task engine does).

Requires a container on the live pin (PG16 + pgvector), e.g.::

    docker run -d --name rr-pg-phase1 -p 55432:5432 \
        -e POSTGRES_PASSWORD=rrpass -e POSTGRES_USER=rruser -e POSTGRES_DB=rrtenant \
        pgvector/pgvector:pg16
    docker exec rr-pg-phase1 psql -U rruser -d rrtenant -c 'CREATE EXTENSION IF NOT EXISTS vector;'

Configuration via environment variables:
    RR_TEST_PG_DSN — libpq URL of the test database
                     (default: postgresql://rruser:rrpass@localhost:55432/rrtenant)

Skips cleanly when the database is unreachable.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import urllib.parse
import types

from ._store_base_stubs import store_base_stubs

from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_AI_SRC = _REPO / 'packages' / 'ai' / 'src'
_RRDB_PATH = _AI_SRC / 'ai' / 'common' / 'rocketride_db.py'
_DB_BASE_DIR = _AI_SRC / 'ai' / 'common' / 'database'
_UTILS_DIR = _AI_SRC / 'ai' / 'common' / 'utils'
_SQL_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_sql'
_VEC_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_vector'

TEST_DSN = os.environ.get('RR_TEST_PG_DSN', 'postgresql://rruser:rrpass@localhost:55432/rrtenant')
# Derived, not hardcoded: the suite must also run against a provisioned tenant
# DSN (e.g. t_<slug>_<hash> through a pooler), not just the default container.
TEST_DB_NAME = urllib.parse.urlparse(TEST_DSN).path.lstrip('/')

# RR_REQUIRE_DB_TESTS (set by CI once its DB containers are healthy) turns
# every skip in this module into a hard failure: a broken container or missing
# dependency must never let the safety-control tests silently go green.
_DB_TESTS_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))

if _DB_TESTS_REQUIRED:
    import numpy as np
    import pgvector  # noqa: F401
    import psycopg2
    import sqlalchemy  # noqa: F401
else:
    psycopg2 = pytest.importorskip('psycopg2')
    pytest.importorskip('pgvector')
    pytest.importorskip('sqlalchemy')
    np = pytest.importorskip('numpy')


def _db_reachable() -> bool:
    try:
        conn = psycopg2.connect(TEST_DSN, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


if _DB_TESTS_REQUIRED and not _db_reachable():
    pytest.fail(f'RR_REQUIRE_DB_TESTS is set but the test database is not reachable at {TEST_DSN}', pytrace=False)

pytestmark = pytest.mark.skipif(not _db_reachable(), reason=f'RocketRide test database not reachable at {TEST_DSN}')


def _load_from_path(name: str, path: Path, *, is_package: bool = False, register: bool = True):
    """Load a module from ``path``, optionally exposing it through ``sys.modules``."""
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    if register:
        sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Environment: stubs + the fake resolver (the injectable test seam)
# ---------------------------------------------------------------------------


def _build_rr_env(monkeypatch):
    """Stub the engine surface and install the fake DSN resolver."""
    warnings: list[str] = []

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *a, **kw: None
    monkeypatch.setitem(sys.modules, 'depends', depends_mod)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = warnings.append
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG=object())
    rocketlib.Entry = type('Entry', (), {})
    rocketlib_types = types.ModuleType('rocketlib.types')
    rocketlib_types.IInvokeLLM = types.SimpleNamespace(Ask=lambda **kw: kw)
    rocketlib.types = rocketlib_types
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    monkeypatch.setitem(sys.modules, 'rocketlib.types', rocketlib_types)

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []

    schema = types.ModuleType('ai.common.schema')

    class _Metadata:
        def __init__(self, **kw):
            self._data = kw
            for k, v in kw.items():
                setattr(self, k, v)

        def model_dump(self):
            return dict(self._data)

    class _Doc:
        def __init__(self, score=0.0, page_content='', metadata=None, embedding=None, embedding_model=''):
            self.score = score
            self.page_content = page_content
            self.metadata = _Metadata(**metadata) if isinstance(metadata, dict) else metadata
            self.embedding = embedding
            self.embedding_model = embedding_model

    class _DocFilter:
        def __init__(self, **kw):
            for name in (
                'nodeId',
                'isTable',
                'tableIds',
                'parent',
                'permissions',
                'objectIds',
                'isDeleted',
                'chunkIds',
                'minChunkId',
                'maxChunkId',
            ):
                setattr(self, name, kw.get(name))
            # The drivers page with these since #2631; the stand-in must carry them too.
            self.offset = kw.get('offset', 0)
            self.limit = kw.get('limit', 10)

    class _QuestionText(str):
        embedding = None
        embedding_model = ''

    schema.Doc = _Doc
    schema.DocFilter = _DocFilter
    schema.DocMetadata = _Metadata
    schema.QuestionText = _QuestionText
    schema.Answer = type('Answer', (), {})
    schema.Question = type('Question', (), {})
    schema.QuestionType = types.SimpleNamespace(QUESTION=1, DIALECT=2, EXECUTE=3)

    table = types.ModuleType('ai.common.table')
    table.Table = types.SimpleNamespace(
        generate_markdown_table=lambda data, headers=None: '\n'.join(' | '.join(map(str, r)) for r in data)
    )

    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=lambda provider, connConfig: dict(connConfig))

    transform = types.ModuleType('ai.common.transform')
    for name in ('IGlobalTransform', 'IInstanceTransform', 'IEndpointTransform'):
        setattr(transform, name, type(name, (), {}))

    store_mod = types.ModuleType('ai.common.store')

    class _StubDocumentStoreBase:
        """Minimal stand-in for DocumentStoreBase's first-write flow."""

        def __init__(self, provider, connConfig, bag):
            self.vectorSize = 0
            self.modelName = ''
            self.threshold_search = 0.5

        def createCollection(self, documents) -> bool:
            if not self._doesCollectionExist():
                self._createCollection(len(documents[0].embedding))
            return True

    # rocketride_vector's IGlobal / IInstance sit on the store base since #2587;
    # these tests drive the driver Store directly, so only the names matter.
    bases = store_base_stubs()
    store_mod.DocumentStoreBase = _StubDocumentStoreBase
    store_mod.StoreGlobalBase = bases.StoreGlobalBase
    store_mod.StoreInstanceBase = bases.StoreInstanceBase
    store_mod.CONTROL_OBJECT_ID = bases.CONTROL_OBJECT_ID

    monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common', common_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.schema', schema)
    monkeypatch.setitem(sys.modules, 'ai.common.table', table)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config)
    monkeypatch.setitem(sys.modules, 'ai.common.transform', transform)
    monkeypatch.setitem(sys.modules, 'ai.common.store', store_mod)

    config_utils = _load_from_path(
        'ai.common.utils.config_utils',
        _UTILS_DIR / 'config_utils.py',
        register=False,
    )
    utils = types.ModuleType('ai.common.utils')
    utils.parse_bool = config_utils.parse_bool
    monkeypatch.setitem(sys.modules, 'ai.common.utils', utils)

    rrdb_mod = _load_from_path('ai.common.rocketride_db', _RRDB_PATH, register=False)
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', rrdb_mod)

    # Deliver the DSN the way the task engine does: nodes never resolve one.
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))

    return types.SimpleNamespace(schema=schema, warnings=warnings)


@pytest.fixture()
def rr_env(monkeypatch):
    """Provide isolated engine stubs and a fake DSN resolver for one test."""
    return _build_rr_env(monkeypatch)


@pytest.fixture()
def raw_conn():
    """Yield a raw connection to the configured PostgreSQL test database."""
    conn = psycopg2.connect(TEST_DSN)
    yield conn
    conn.close()


def test_rr_env_does_not_leak_module_aliases(monkeypatch):
    """Remove temporary module aliases when fixture setup has no prior state."""
    aliases = ('ai.common.rocketride_db', 'ai.common.utils')
    for alias in aliases:
        monkeypatch.delitem(sys.modules, alias, raising=False)

    with monkeypatch.context() as fixture_patch:
        _build_rr_env(fixture_patch)
        assert 'ai.common.rocketride_db' in sys.modules
        assert 'ai.common.utils' in sys.modules

    assert all(alias not in sys.modules for alias in aliases)


def test_rr_env_restores_existing_module_aliases(monkeypatch):
    """Restore aliases registered by previously collected suites."""
    existing_rocketride_db = types.ModuleType('ai.common.rocketride_db')
    existing_utils = types.ModuleType('ai.common.utils')
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', existing_rocketride_db)
    monkeypatch.setitem(sys.modules, 'ai.common.utils', existing_utils)

    with monkeypatch.context() as fixture_patch:
        _build_rr_env(fixture_patch)
        assert sys.modules['ai.common.rocketride_db'] is not existing_rocketride_db
        assert sys.modules['ai.common.utils'] is not existing_utils

    assert sys.modules['ai.common.rocketride_db'] is existing_rocketride_db
    assert sys.modules['ai.common.utils'] is existing_utils


# ---------------------------------------------------------------------------
# rocketride_sql end-to-end
# ---------------------------------------------------------------------------


def _load_sql_node(monkeypatch):
    db_global = _load_from_path(
        'ai.common.database.db_global_base',
        _DB_BASE_DIR / 'db_global_base.py',
        register=False,
    )
    sql_safety = _load_from_path(
        'ai.common.database.sql_safety',
        _DB_BASE_DIR / 'sql_safety.py',
        register=False,
    )
    database_pkg = types.ModuleType('ai.common.database')
    database_pkg.__path__ = [str(_DB_BASE_DIR)]
    database_pkg.DatabaseGlobalBase = db_global.DatabaseGlobalBase
    monkeypatch.setitem(sys.modules, 'ai.common.database', database_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.database.db_global_base', db_global)
    monkeypatch.setitem(sys.modules, 'ai.common.database.sql_safety', sql_safety)
    db_instance = _load_from_path(
        'ai.common.database.db_instance_base',
        _DB_BASE_DIR / 'db_instance_base.py',
        register=False,
    )
    database_pkg.DatabaseInstanceBase = db_instance.DatabaseInstanceBase
    monkeypatch.setitem(sys.modules, 'ai.common.database.db_instance_base', db_instance)

    iglobal = _load_from_path('nodes.rocketride_sql.IGlobal', _SQL_NODE_DIR / 'IGlobal.py', register=False)
    pkg = types.ModuleType('nodes.rocketride_sql')
    pkg.__path__ = [str(_SQL_NODE_DIR)]
    pkg.IGlobal = iglobal
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_sql', pkg)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_sql.IGlobal', iglobal)
    iinstance = _load_from_path('nodes.rocketride_sql.IInstance', _SQL_NODE_DIR / 'IInstance.py', register=False)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_sql.IInstance', iinstance)
    return iglobal.IGlobal, iinstance.IInstance


class TestRocketrideSqlE2E:
    @pytest.fixture()
    def sql_table(self, raw_conn):
        with raw_conn.cursor() as cur:
            cur.execute('DROP TABLE IF EXISTS rr_sql_e2e')
            cur.execute('CREATE TABLE rr_sql_e2e (id serial PRIMARY KEY, name text, qty int)')
            cur.execute("INSERT INTO rr_sql_e2e (name, qty) VALUES ('bolt', 7), ('nut', 3)")
            raw_conn.commit()
        yield 'rr_sql_e2e'
        with raw_conn.cursor() as cur:
            cur.execute('DROP TABLE IF EXISTS rr_sql_e2e')
            raw_conn.commit()

    def _begin(self, monkeypatch, config):
        iglobal_cls, iinstance_cls = _load_sql_node(monkeypatch)
        glb = iglobal_cls()
        glb.glb = types.SimpleNamespace(logicalType='rocketride_sql', connConfig=config)
        glb.beginGlobal()
        inst = iinstance_cls()
        inst.IGlobal = glb
        return glb, inst

    def test_begin_global_connects_and_reflects(self, rr_env, monkeypatch, sql_table):
        glb, _ = self._begin(monkeypatch, {'table': sql_table})
        try:
            assert glb.database == TEST_DB_NAME
            assert glb.table == sql_table
            assert sql_table in glb.db_schema
            assert 'name' in glb.schema
            ok, err = glb._validateQuery(f'SELECT * FROM {sql_table}')
            assert ok, err
        finally:
            glb.endGlobal()

    def test_execute_gated_by_allow_execute(self, rr_env, monkeypatch, sql_table):
        glb, inst = self._begin(monkeypatch, {'table': sql_table, 'allow_execute': False})
        try:
            with pytest.raises(ValueError, match='execute tool is disabled'):
                inst.execute({'sql': f'SELECT * FROM {sql_table}'})
        finally:
            glb.endGlobal()

    def test_execute_runs_real_query(self, rr_env, monkeypatch, sql_table):
        glb, inst = self._begin(monkeypatch, {'table': sql_table, 'allow_execute': True})
        try:
            result = inst.execute({'sql': f'SELECT name, qty FROM {sql_table} ORDER BY qty DESC'})
            assert [r['name'] for r in result['rows']] == ['bolt', 'nut']
            written = inst.execute({'sql': f"INSERT INTO {sql_table} (name, qty) VALUES ('washer', 11)"})
            assert written['affected_rows'] == 1
            back = inst.execute({'sql': f'SELECT count(*) AS n FROM {sql_table}'})
            assert back['rows'][0]['n'] == 3
        finally:
            glb.endGlobal()

    # -- lanes fail closed (rocketride-ai/rocketride-saas#789) ------------------

    @staticmethod
    def _refuse_connections(glb):
        """Point the node's engine at a port nothing listens on.

        This is what a pooler that went away leaves a running pipeline with: the
        task started and reflected the schema, and the next connection attempt is
        refused.
        """
        import socket

        from sqlalchemy import create_engine

        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            closed_port = probe.getsockname()[1]
        glb.engine.dispose()
        glb.engine = create_engine(
            f'postgresql+psycopg2://nobody:nopass@127.0.0.1:{closed_port}/{TEST_DB_NAME}',
            connect_args={'connect_timeout': 2},
        )

    @staticmethod
    def _lanes(inst, lanes=('text',)):
        """Give the instance a downstream that records what is emitted."""

        class _Sink:
            def __init__(self):
                self.text = []
                self.answers = []

            def getListeners(self):
                return list(lanes)

            def writeText(self, text):
                self.text.append(text)

            def writeAnswers(self, answer):
                self.answers.append(answer)

        inst.instance = _Sink()
        return inst.instance

    @staticmethod
    def _answer(rows):
        return types.SimpleNamespace(getJson=lambda: rows)

    def test_answers_lane_inserts_when_the_database_is_up(self, rr_env, monkeypatch, sql_table, raw_conn):
        """Control for the failure cases below: the same call writes the row on a live database."""
        glb, inst = self._begin(monkeypatch, {'table': sql_table})
        try:
            self._lanes(inst)
            inst.writeAnswers(self._answer([{'name': 'washer', 'qty': 11}]))
            with raw_conn.cursor() as cur:
                cur.execute(f"SELECT count(*) FROM {sql_table} WHERE name = 'washer'")
                assert cur.fetchone()[0] == 1
        finally:
            glb.endGlobal()

    def test_answers_lane_fails_when_the_connection_is_refused(self, rr_env, monkeypatch, sql_table, raw_conn):
        glb, inst = self._begin(monkeypatch, {'table': sql_table})
        lane_error = sys.modules['ai.common.database.db_instance_base'].DatabaseLaneError
        try:
            self._refuse_connections(glb)
            self._lanes(inst)
            with pytest.raises(lane_error) as raised:
                inst.writeAnswers(self._answer([{'name': 'washer', 'qty': 11}]))
            assert '127.0.0.1' not in str(raised.value)
            with raw_conn.cursor() as cur:
                cur.execute(f"SELECT count(*) FROM {sql_table} WHERE name = 'washer'")
                assert cur.fetchone()[0] == 0
        finally:
            glb.endGlobal()

    def test_table_lane_fails_when_the_connection_is_refused(self, rr_env, monkeypatch, sql_table):
        glb, inst = self._begin(monkeypatch, {'table': sql_table})
        lane_error = sys.modules['ai.common.database.db_instance_base'].DatabaseLaneError
        # The shared stand-in for ai.common.table carries only the markdown writer.
        monkeypatch.setattr(
            sys.modules['ai.common.table'].Table,
            'parse_markdown_table',
            lambda markdown: (['name', 'qty'], [['washer', 11]]),
            raising=False,
        )
        try:
            self._refuse_connections(glb)
            self._lanes(inst)
            with pytest.raises(lane_error):
                inst.writeTable('| name | qty |\n| --- | --- |\n| washer | 11 |')
        finally:
            glb.endGlobal()

    def test_question_lane_fails_and_never_emits_none_when_the_connection_is_refused(
        self, rr_env, monkeypatch, sql_table
    ):
        glb, inst = self._begin(monkeypatch, {'table': sql_table})
        lane_error = sys.modules['ai.common.database.db_instance_base'].DatabaseLaneError
        try:
            self._refuse_connections(glb)
            sink = self._lanes(inst, ('text', 'answers'))
            inst._buildSQLQuery = lambda question_text: {'isValid': True, 'query': f'SELECT * FROM {sql_table}'}
            question = types.SimpleNamespace(questions=[types.SimpleNamespace(text='what is in stock?')])
            with pytest.raises(lane_error):
                inst.writeQuestions(question)
            assert sink.text == [] and sink.answers == []
        finally:
            glb.endGlobal()

    # -- EXPLAIN and table checks: an outage is not a verdict on the SQL ---------

    @staticmethod
    def _unavailable_error():
        return sys.modules['ai.common.database.db_global_base'].DatabaseUnavailableError

    def test_explain_over_a_refused_connection_fails_the_question_lane_without_a_repair_loop(
        self, rr_env, monkeypatch, sql_table
    ):
        glb, inst = self._begin(monkeypatch, {'table': sql_table})
        try:
            self._refuse_connections(glb)
            sink = self._lanes(inst, ('text', 'answers'))
            glb.max_validation_attempts = 5
            asked = []
            inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: (
                asked.append(1) or {'isValid': True, 'query': f'SELECT * FROM {sql_table}'}
            )
            question = types.SimpleNamespace(questions=[types.SimpleNamespace(text='what is in stock?')])

            with pytest.raises(self._unavailable_error()):
                inst.writeQuestions(question)

            assert len(asked) == 1  # the outage was not fed back to the LLM as a rejection
            assert sink.text == [] and sink.answers == []
        finally:
            glb.endGlobal()

    def test_explain_of_bad_sql_on_a_live_database_is_still_a_rejection(self, rr_env, monkeypatch, sql_table):
        glb, _ = self._begin(monkeypatch, {'table': sql_table})
        try:
            ok, message = glb._validateQuery('SELECT * FROM rr_no_such_table')
            assert ok is False and 'does not exist' in message

            ok, message = glb._validateQuery(f'SELECT no_such_column FROM {sql_table}')
            assert ok is False and 'no_such_column' in message

            assert glb._validateQuery(f'SELECT name FROM {sql_table}') == (True, '')
        finally:
            glb.endGlobal()

    def test_explain_over_a_connection_the_server_closed_is_an_outage(self, rr_env, monkeypatch, sql_table, raw_conn):
        """The connection died after it was obtained: SQLAlchemy marks it invalid, no message matching needed."""
        glb, _ = self._begin(monkeypatch, {'table': sql_table})
        try:
            # Pre-ping would replace the dead pooled connection before EXPLAIN ran (the
            # next test); switch it off to exercise the failure arriving mid-statement.
            glb.engine.pool._pre_ping = False
            with glb.engine.connect() as conn:
                pid = conn.exec_driver_sql('SELECT pg_backend_pid()').scalar()
            with raw_conn.cursor() as cur:
                cur.execute('SELECT pg_terminate_backend(%s)', (pid,))
            raw_conn.commit()

            with pytest.raises(self._unavailable_error()):
                glb._validateQuery(f'SELECT name FROM {sql_table}')
        finally:
            glb.endGlobal()

    def test_explain_over_a_connection_the_server_closed_is_replaced_by_pre_ping(
        self, rr_env, monkeypatch, sql_table, raw_conn
    ):
        glb, _ = self._begin(monkeypatch, {'table': sql_table})
        try:
            with glb.engine.connect() as conn:
                pid = conn.exec_driver_sql('SELECT pg_backend_pid()').scalar()
            with raw_conn.cursor() as cur:
                cur.execute('SELECT pg_terminate_backend(%s)', (pid,))
            raw_conn.commit()

            assert glb._validateQuery(f'SELECT name FROM {sql_table}') == (True, '')
        finally:
            glb.endGlobal()

    def test_table_exists_over_a_refused_connection_raises_and_a_missing_table_is_false(
        self, rr_env, monkeypatch, sql_table
    ):
        glb, _ = self._begin(monkeypatch, {'table': sql_table})
        try:
            assert glb._tableExists(sql_table) is True
            assert glb._tableExists('rr_no_such_table') is False

            self._refuse_connections(glb)

            with pytest.raises(self._unavailable_error()):
                glb._tableExists(sql_table)
            with pytest.raises(self._unavailable_error()):
                glb._getTableSchema(sql_table)
        finally:
            glb.endGlobal()

    # -- pool resilience (rocketride-ai/rocketride-saas#789) --------------------

    def test_a_pooled_connection_the_server_closed_is_replaced_not_surfaced(
        self, rr_env, monkeypatch, sql_table, raw_conn
    ):
        """Pre-ping: the first statement after a pooler restart must not fail on a dead pooled connection."""
        glb, inst = self._begin(monkeypatch, {'table': sql_table, 'allow_execute': True})
        try:
            with glb.engine.connect() as conn:
                pid = conn.exec_driver_sql('SELECT pg_backend_pid()').scalar()
            # The server drops the idle pooled connection, as a pooler restart or a failover does.
            with raw_conn.cursor() as cur:
                cur.execute('SELECT pg_terminate_backend(%s)', (pid,))
                assert cur.fetchone()[0] is True
            raw_conn.commit()

            result = inst.execute({'sql': 'SELECT 1 AS one'})

            assert result['rows'] == [{'one': 1}]
        finally:
            glb.endGlobal()

    def test_the_connect_timeout_reaches_the_driver(self, rr_env, monkeypatch, sql_table):
        glb, _ = self._begin(monkeypatch, {'table': sql_table, 'connect_timeout': 3})
        try:
            with glb.engine.connect() as conn:
                assert conn.connection.dbapi_connection.get_dsn_parameters()['connect_timeout'] == '3'
        finally:
            glb.endGlobal()

    @staticmethod
    def _dsn_on_port(port):
        parsed = urllib.parse.urlparse(TEST_DSN)
        credentials = parsed.netloc.rpartition('@')[0]
        prefix = f'{credentials}@' if credentials else ''
        return parsed._replace(netloc=f'{prefix}127.0.0.1:{port}').geturl()

    @staticmethod
    def _free_port():
        import socket

        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            return probe.getsockname()[1]

    def test_a_refused_connection_is_retried_a_bounded_number_of_times(self, rr_env, monkeypatch, sql_table):
        import time

        port = self._free_port()
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': self._dsn_on_port(port)}))
        attempts = []
        real_connect = psycopg2.connect
        monkeypatch.setattr(psycopg2, 'connect', lambda *a, **kw: (attempts.append(1), real_connect(*a, **kw))[1])

        started = time.monotonic()
        with pytest.raises(Exception, match='refused'):
            self._begin(monkeypatch, {'table': sql_table, 'connect_retries': 3, 'connect_retry_budget': 10})
        elapsed = time.monotonic() - started

        assert len(attempts) == 3  # the first try and two retries, then it gives up
        assert elapsed < 10

    def test_a_connection_refused_for_a_moment_is_retried_to_success(self, rr_env, monkeypatch, sql_table):
        """A pooler that is back within the retry budget costs the pipeline nothing."""
        import socket
        import threading
        import time

        port = self._free_port()
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': self._dsn_on_port(port)}))
        real = urllib.parse.urlparse(TEST_DSN)
        upstream = (real.hostname, real.port or 5432)
        stop = threading.Event()

        def pipe(src, dst):
            try:
                while chunk := src.recv(65536):
                    dst.sendall(chunk)
            except OSError:
                pass
            finally:
                for sock in (src, dst):
                    try:
                        sock.close()
                    except OSError:
                        pass

        def proxy_after_delay():
            time.sleep(0.8)  # the pooler is "down" until now
            server = socket.socket()
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', port))
            server.listen()
            server.settimeout(0.2)
            while not stop.is_set():
                try:
                    client, _ = server.accept()
                except (socket.timeout, OSError):
                    continue
                backend = socket.create_connection(upstream)
                threading.Thread(target=pipe, args=(client, backend), daemon=True).start()
                threading.Thread(target=pipe, args=(backend, client), daemon=True).start()
            server.close()

        thread = threading.Thread(target=proxy_after_delay, daemon=True)
        thread.start()
        glb = None
        try:
            # Eight attempts and a 20 s budget: the jittered waits cannot all fall inside the 0.8 s outage.
            glb, inst = self._begin(
                monkeypatch,
                {'table': sql_table, 'allow_execute': True, 'connect_retries': 8, 'connect_retry_budget': 20},
            )
            assert inst.execute({'sql': 'SELECT 1 AS one'})['rows'] == [{'one': 1}]
        finally:
            if glb is not None:
                glb.endGlobal()
            stop.set()
            thread.join(timeout=3)

    @staticmethod
    def _stalling_relay(upstream):
        """A TCP relay to ``upstream`` that can be told to hold every byte while keeping the sockets open.

        This is a pooler whose process is frozen: the kernel keeps acknowledging segments, so
        no TCP-level setting (keepalives, ``tcp_user_timeout``) sees anything wrong.
        Returns ``(port, stall_event, stop)``.
        """
        import socket
        import threading
        import time

        stall = threading.Event()
        stopped = threading.Event()
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 0))
        listener.listen(8)
        listener.settimeout(0.2)

        def pump(src, dst):
            try:
                while chunk := src.recv(65536):
                    while stall.is_set() and not stopped.is_set():
                        time.sleep(0.05)
                    dst.sendall(chunk)
            except OSError:
                pass
            finally:
                for sock in (src, dst):
                    try:
                        sock.close()
                    except OSError:
                        pass

        def accept():
            while not stopped.is_set():
                try:
                    client, _ = listener.accept()
                except (socket.timeout, OSError):
                    continue
                backend = socket.create_connection(upstream)
                threading.Thread(target=pump, args=(client, backend), daemon=True).start()
                threading.Thread(target=pump, args=(backend, client), daemon=True).start()
            listener.close()

        thread = threading.Thread(target=accept, daemon=True)
        thread.start()

        def stop():
            stopped.set()
            thread.join(timeout=3)

        return listener.getsockname()[1], stall, stop

    def test_a_stalled_pooler_is_bounded_for_the_ping_and_the_reconnect(self, rr_env, monkeypatch, sql_table):
        """The reviewer's stalled-pooler case: a pooled connection to a peer that stopped answering.

        Without the ping watchdog this blocked forever in ``pool_pre_ping``'s ``SELECT 1``.
        """
        import time

        real = urllib.parse.urlparse(TEST_DSN)
        port, stall, stop = self._stalling_relay((real.hostname, real.port or 5432))
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': self._dsn_on_port(port)}))
        glb = None
        try:
            glb, inst = self._begin(
                monkeypatch,
                {
                    'table': sql_table,
                    'allow_execute': True,
                    'ping_timeout': 1,
                    'connect_timeout': 1,
                    'connect_retries': 3,
                    'connect_retry_budget': 2,
                },
            )
            assert inst.execute({'sql': 'SELECT 1 AS one'})['rows'] == [{'one': 1}]  # warm the pool
            stall.set()

            started = time.monotonic()
            with pytest.raises(RuntimeError):
                inst.execute({'sql': 'SELECT 1 AS one'})
            elapsed = time.monotonic() - started

            # ping_timeout (1 s) + the reconnect: 3 attempts of connect_timeout (1 s) inside a 2 s budget.
            assert elapsed < 12, f'a stalled pooler held the call for {elapsed:.1f}s'
        finally:
            stall.clear()
            if glb is not None:
                glb.endGlobal()
            stop()

    def test_the_node_setting_overrides_a_connect_timeout_written_in_the_dsn(self, rr_env, monkeypatch, sql_table):
        dsn = self._dsn_on_port(urllib.parse.urlparse(TEST_DSN).port or 5432) + '?connect_timeout=30'
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': dsn}))

        glb, _ = self._begin(monkeypatch, {'table': sql_table, 'connect_timeout': 3})
        try:
            with glb.engine.connect() as conn:
                assert conn.connection.dbapi_connection.get_dsn_parameters()['connect_timeout'] == '3'
        finally:
            glb.endGlobal()

    def test_the_keepalive_settings_reach_libpq(self, rr_env, monkeypatch, sql_table):
        glb, _ = self._begin(
            monkeypatch,
            {'table': sql_table, 'keepalives_idle': 20, 'keepalives_interval': 7, 'keepalives_count': 4},
        )
        try:
            with glb.engine.connect() as conn:
                params = conn.connection.dbapi_connection.get_dsn_parameters()
            assert (params['keepalives'], params['keepalives_idle']) == ('1', '20')
            assert (params['keepalives_interval'], params['keepalives_count']) == ('7', '4')
            if psycopg2.__libpq_version__ >= 120000:
                assert params['tcp_user_timeout'] == '30000'
        finally:
            glb.endGlobal()

    def test_what_libpq_says_for_a_full_role_and_a_mixed_multi_host_failure_is_classified_by_message(
        self, rr_env, monkeypatch, sql_table, raw_conn
    ):
        """psycopg2 sets no SQLSTATE while connecting, so these are told apart by their text (real libpq errors)."""
        self._begin(monkeypatch, {'table': sql_table})[0].endGlobal()  # loads the node modules the helper imports
        from ai.common.database.connect_retry import is_transient_connect_error

        parsed = urllib.parse.urlparse(TEST_DSN)
        port = parsed.port or 5432
        raw_conn.autocommit = True
        with raw_conn.cursor() as cur:
            cur.execute('DROP ROLE IF EXISTS rr789_full_role')
            cur.execute("CREATE ROLE rr789_full_role LOGIN PASSWORD 'x' CONNECTION LIMIT 0")
        try:

            def failure(**kw):
                with pytest.raises(psycopg2.OperationalError) as raised:
                    psycopg2.connect(connect_timeout=3, dbname=TEST_DB_NAME, **kw)
                return raised.value

            full = failure(host=parsed.hostname, port=port, user='rr789_full_role', password='x')
            assert full.pgcode is None  # why the message is what is matched
            assert is_transient_connect_error(full), str(full)

            mixed = failure(
                host=f'{parsed.hostname},{parsed.hostname}',
                port=f'1,{port}',
                user='rr789_no_such_role',
                password='x',
            )
            assert not is_transient_connect_error(mixed), str(mixed)

            refused = failure(host=parsed.hostname, port=1, user='x', password='x')
            assert is_transient_connect_error(refused), str(refused)
        finally:
            with raw_conn.cursor() as cur:
                cur.execute('DROP ROLE IF EXISTS rr789_full_role')

    def test_config_connection_fields_ignored(self, rr_env, monkeypatch, sql_table):
        """The defining property: config cannot redirect the connection."""
        glb, _ = self._begin(
            monkeypatch,
            {'table': sql_table, 'host': 'evil.example.com', 'user': 'evil', 'password': 'evil'},
        )
        try:
            assert glb.database == TEST_DB_NAME
            assert 'evil' not in str(glb.engine.url)
        finally:
            glb.endGlobal()


# ---------------------------------------------------------------------------
# rocketride_vector end-to-end (incl. HNSW index verification)
# ---------------------------------------------------------------------------


def _load_vector_store(monkeypatch):
    search_module = _load_from_path(
        'ai.common.store.pgvector_store', _AI_SRC / 'ai/common/store/pgvector_store.py', register=False
    )
    monkeypatch.setitem(sys.modules, 'ai.common.store.pgvector_store', search_module)

    iglobal = _load_from_path('nodes.rocketride_vector.IGlobal', _VEC_NODE_DIR / 'IGlobal.py', register=False)
    pkg = types.ModuleType('nodes.rocketride_vector')
    pkg.__path__ = [str(_VEC_NODE_DIR)]
    pkg.IGlobal = iglobal
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector', pkg)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector.IGlobal', iglobal)
    store = _load_from_path(
        'nodes.rocketride_vector.rocketride_vector',
        _VEC_NODE_DIR / 'rocketride_vector.py',
        register=False,
    )
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector.rocketride_vector', store)
    return store.Store


_NODE_LOADER_ALIASES = (
    (
        _load_sql_node,
        (
            'ai.common.database',
            'ai.common.database.db_global_base',
            'ai.common.database.sql_safety',
            'ai.common.database.db_instance_base',
            'nodes.rocketride_sql',
            'nodes.rocketride_sql.IGlobal',
            'nodes.rocketride_sql.IInstance',
        ),
    ),
    (
        _load_vector_store,
        (
            'ai.common.store.pgvector_store',
            'nodes.rocketride_vector',
            'nodes.rocketride_vector.IGlobal',
            'nodes.rocketride_vector.rocketride_vector',
        ),
    ),
)


@pytest.mark.parametrize(('loader', 'aliases'), _NODE_LOADER_ALIASES)
def test_node_loader_does_not_leak_module_aliases(rr_env, monkeypatch, loader, aliases):
    """Remove every temporary node alias when no prior module was loaded."""
    for alias in aliases:
        monkeypatch.delitem(sys.modules, alias, raising=False)

    with monkeypatch.context() as loader_patch:
        loader(loader_patch)
        assert all(alias in sys.modules for alias in aliases)

    assert all(alias not in sys.modules for alias in aliases)


@pytest.mark.parametrize(('loader', 'aliases'), _NODE_LOADER_ALIASES)
def test_node_loader_restores_existing_module_aliases(rr_env, monkeypatch, loader, aliases):
    """Restore real modules that were present before a temporary node load."""
    existing = {alias: types.ModuleType(alias) for alias in aliases}
    for alias, module in existing.items():
        monkeypatch.setitem(sys.modules, alias, module)

    with monkeypatch.context() as loader_patch:
        loader(loader_patch)
        assert all(sys.modules[alias] is not existing[alias] for alias in aliases)

    assert all(sys.modules[alias] is existing[alias] for alias in aliases)


VEC_TABLE = 'rr_vec_e2e'
DIMS = 8


def _unit_vec(rng):
    v = rng.standard_normal(DIMS)
    return (v / np.linalg.norm(v)).tolist()


class TestRocketrideVectorE2E:
    @pytest.fixture()
    def vec_store(self, rr_env, monkeypatch, raw_conn):
        with raw_conn.cursor() as cur:
            cur.execute(f'DROP TABLE IF EXISTS {VEC_TABLE}')
            raw_conn.commit()
        store_cls = _load_vector_store(monkeypatch)
        store = store_cls('rocketride_vector', {'collection': VEC_TABLE, 'similarity': 'cosine'}, {})
        yield store
        # Close the driver connection before dropping, so a test that leaves
        # it inside a transaction cannot block the DROP on its locks.
        if store.client is not None:
            store.client.close()
            store.client = None
        with raw_conn.cursor() as cur:
            cur.execute(f'DROP TABLE IF EXISTS {VEC_TABLE}')
            raw_conn.commit()

    def _chunks(self, schema, contents_and_embeddings):
        docs = []
        for i, (content, embedding) in enumerate(contents_and_embeddings):
            docs.append(
                schema.Doc(
                    page_content=content,
                    metadata={
                        'objectId': f'obj-{i}',
                        'nodeId': 'test-node',
                        'parent': '/test',
                        'permissionId': 0,
                        'isDeleted': False,
                        'chunkId': 0,
                        'isTable': False,
                        'tableId': 0,
                        'vectorSize': len(embedding),
                        'modelName': 'test-model',
                    },
                    embedding=embedding,
                    embedding_model='test-model',
                )
            )
        return docs

    def test_first_write_creates_table_and_hnsw_index(self, rr_env, vec_store, raw_conn):
        rng = np.random.default_rng(7)
        vec_store.addChunks(self._chunks(rr_env.schema, [(f'doc {i}', _unit_vec(rng)) for i in range(100)]))

        with raw_conn.cursor() as cur:
            cur.execute('SELECT indexname, indexdef FROM pg_indexes WHERE tablename = %s', (VEC_TABLE,))
            indexes = {name: ddl for name, ddl in cur.fetchall()}

        index_name = f'{VEC_TABLE}_embedding_hnsw'
        assert index_name in indexes
        assert 'USING hnsw (embedding vector_cosine_ops)' in indexes[index_name]
        assert "m='16'" in indexes[index_name]
        assert "ef_construction='64'" in indexes[index_name]

    def test_semantic_search_uses_hnsw_index_not_seq_scan(self, rr_env, vec_store, raw_conn):
        """The acceptance check: the node's own search SQL must use the index.

        The planner rightly prefers a seq scan on tiny tables, so load enough
        rows (and ANALYZE) that index cost wins; then EXPLAIN the exact
        ``semantic_search`` statement the driver executes.
        """
        rng = np.random.default_rng(11)
        # Insert in one bulk statement (the driver's row-at-a-time insert is
        # too slow for a 2000-row planner fixture); create the table + index
        # through the driver's first-write path first.
        vec_store.addChunks(self._chunks(rr_env.schema, [('seed doc', _unit_vec(rng))]))
        with raw_conn.cursor() as cur:
            cur.execute(
                f'INSERT INTO {VEC_TABLE} (content, objectId, chunkId, isDeleted, embedding) '
                f"SELECT 'doc '||i, 'obj-'||i, 0, false, "
                f"(SELECT ('['||string_agg((random()*2-1)::text, ',')||']')::vector "
                f' FROM generate_series(1,{DIMS}) WHERE i=i) '
                f'FROM generate_series(1, 2000) i'
            )
            cur.execute(f'ANALYZE {VEC_TABLE}')
            raw_conn.commit()

        # EXPLAIN the exact statement the driver runs for semantic search.
        search_module = sys.modules['ai.common.store.pgvector_store']
        search_sql = search_module.SEARCH_SQL['semantic_search'].format(
            collection=VEC_TABLE, similarity_operator='<=>', where_clause=''
        )
        probe = _unit_vec(rng)
        with raw_conn.cursor() as cur:
            cur.execute(f'EXPLAIN {search_sql}', (str(probe), 5))
            plan = '\n'.join(row[0] for row in cur.fetchall())

        assert f'Index Scan using {VEC_TABLE}_embedding_hnsw' in plan, plan
        assert 'Seq Scan' not in plan, plan

    def test_semantic_search_returns_nearest_document(self, rr_env, vec_store):
        rng = np.random.default_rng(23)
        vectors = [(f'doc {i}', _unit_vec(rng)) for i in range(50)]
        vec_store.addChunks(self._chunks(rr_env.schema, vectors))

        # Query with (nearly) the exact embedding of doc 17 — it must come back first.
        target = vectors[17][1]
        query = rr_env.schema.QuestionText('find doc 17')
        query.embedding = target
        results = vec_store.searchSemantic(query, rr_env.schema.DocFilter(limit=5))
        assert results, 'semantic search returned nothing'
        assert results[0].page_content == 'doc 17'
        assert results[0].score > 0.99

    def test_upsert_replaces_same_object_id(self, rr_env, vec_store):
        rng = np.random.default_rng(31)
        first = self._chunks(rr_env.schema, [('original', _unit_vec(rng))])
        vec_store.addChunks(first)
        replacement = self._chunks(rr_env.schema, [('replaced', _unit_vec(rng))])
        vec_store.addChunks(replacement)
        assert vec_store.count_documents() == 1

    # A transaction-mode pooler (PgBouncer) holds a server connection for as
    # long as a client sits inside a transaction. A long-lived node left
    # "idle in transaction" pins one of the database's few pooler slots for
    # its whole lifetime, so between calls the session must be plain "idle".
    @staticmethod
    def _session_state(raw_conn, store) -> str:
        """The node's backend state as the server sees it (pg_stat_activity)."""
        with raw_conn.cursor() as cur:
            cur.execute('SELECT state FROM pg_stat_activity WHERE pid = %s', (store.client.get_backend_pid(),))
            state = cur.fetchone()[0]
        # pg_stat_activity is snapshotted per transaction: end ours so the
        # next probe sees fresh state.
        raw_conn.rollback()
        return state

    def test_session_idle_after_connect(self, rr_env, vec_store, raw_conn):
        assert self._session_state(raw_conn, vec_store) == 'idle'

    def test_session_idle_after_each_read(self, rr_env, vec_store, raw_conn):
        rng = np.random.default_rng(41)
        vectors = [(f'doc {i}', _unit_vec(rng)) for i in range(5)]
        vec_store.addChunks(self._chunks(rr_env.schema, vectors))
        assert self._session_state(raw_conn, vec_store) == 'idle', 'after addChunks'

        query = rr_env.schema.QuestionText('doc')
        query.embedding = vectors[0][1]
        reads = {
            '_doesCollectionExist': lambda: vec_store._doesCollectionExist(),
            'count_documents': lambda: vec_store.count_documents(),
            'searchSemantic': lambda: vec_store.searchSemantic(query, rr_env.schema.DocFilter(limit=5)),
            'searchKeyword': lambda: vec_store.searchKeyword(query, rr_env.schema.DocFilter(limit=5)),
            'get': lambda: vec_store.get(rr_env.schema.DocFilter(limit=5)),
            'getPaths': lambda: vec_store.getPaths(),
            'render': lambda: vec_store.render('obj-0', lambda _text: None),
        }
        for name, read in reads.items():
            read()
            assert self._session_state(raw_conn, vec_store) == 'idle', f'after {name}'

    def test_session_idle_after_each_single_statement_write(self, rr_env, vec_store, raw_conn):
        rng = np.random.default_rng(43)
        vec_store.addChunks(self._chunks(rr_env.schema, [('doc', _unit_vec(rng))]))
        for name in ('markDeleted', 'markActive', 'remove'):
            getattr(vec_store, name)(['obj-0'])
            assert self._session_state(raw_conn, vec_store) == 'idle', f'after {name}'

    def test_session_idle_after_failed_read(self, rr_env, vec_store, raw_conn):
        rng = np.random.default_rng(47)
        vec_store.addChunks(self._chunks(rr_env.schema, [('doc', _unit_vec(rng))]))
        query = rr_env.schema.QuestionText('doc')
        query.embedding = [1.0, 0.0]  # wrong width: the server rejects the comparison
        with pytest.raises(Exception, match='dimensions'):
            vec_store.searchSemantic(query, rr_env.schema.DocFilter(limit=5))
        assert self._session_state(raw_conn, vec_store) == 'idle'
        # ...and the connection is still usable (no aborted transaction).
        assert vec_store.count_documents() == 1

    def test_session_idle_after_failed_write(self, rr_env, vec_store, raw_conn):
        rng = np.random.default_rng(53)
        vec_store.addChunks(self._chunks(rr_env.schema, [('original', _unit_vec(rng))]))
        bad = self._chunks(rr_env.schema, [('replacement', _unit_vec(rng))])
        bad[0].embedding = [1.0, 0.0]  # wrong width: the INSERT fails after the DELETE ran
        with pytest.raises(Exception):
            vec_store.addChunks(bad, checkCollection=False)
        assert self._session_state(raw_conn, vec_store) == 'idle'
        # The replacement is still atomic: the failed batch left the original in place.
        docs = vec_store.get(rr_env.schema.DocFilter(objectIds=['obj-0'], limit=5))
        assert [d.page_content for d in docs] == ['original']
        # ...and the connection is back in autocommit, so later reads open no transaction.
        assert vec_store.client.autocommit is True
        assert self._session_state(raw_conn, vec_store) == 'idle', 'after a read following the failed write'

    def test_wide_vectors_skip_index_with_warning(self, rr_env, monkeypatch, raw_conn):
        wide_table = 'rr_vec_wide_e2e'
        with raw_conn.cursor() as cur:
            cur.execute(f'DROP TABLE IF EXISTS {wide_table}')
            raw_conn.commit()
        store_cls = _load_vector_store(monkeypatch)
        store = store_cls('rocketride_vector', {'collection': wide_table, 'similarity': 'cosine'}, {})
        try:
            store._createCollection(vectorSize=2001)
            with raw_conn.cursor() as cur:
                cur.execute('SELECT indexname FROM pg_indexes WHERE tablename = %s', (wide_table,))
                index_names = [row[0] for row in cur.fetchall()]
            assert not any('hnsw' in name for name in index_names)
            assert any('Skipping index' in w for w in rr_env.warnings)
        finally:
            with raw_conn.cursor() as cur:
                cur.execute(f'DROP TABLE IF EXISTS {wide_table}')
                raw_conn.commit()
