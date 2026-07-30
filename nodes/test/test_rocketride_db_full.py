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
through the real seam (env ``ROCKETRIDE_CLIENT_ID`` + a fake, injectable
``Account.resolve_db_dsn`` — exactly how tests are meant to swap the resolver;
node code is identical regardless of which resolver is active).

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
import os
import sys
import urllib.parse
import types

from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_AI_SRC = _REPO / 'packages' / 'ai' / 'src'
_RRDB_PATH = _AI_SRC / 'ai' / 'common' / 'rocketride_db.py'
_DB_BASE_DIR = _AI_SRC / 'ai' / 'common' / 'database'
_SQL_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_sql'
_VEC_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_vector'

TEST_DSN = os.environ.get('RR_TEST_PG_DSN', 'postgresql://rruser:rrpass@localhost:55432/rrtenant')
# Derived, not hardcoded: the suite must also run against a provisioned tenant
# DSN (e.g. t_<slug>_<hash> through a pooler), not just the default container.
TEST_DB_NAME = urllib.parse.urlparse(TEST_DSN).path.lstrip('/')
TEST_CLIENT_ID = 'tenant-integration-test'

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


def _load_from_path(name: str, path: Path, *, is_package: bool = False):
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Environment: stubs + the fake resolver (the injectable test seam)
# ---------------------------------------------------------------------------


@pytest.fixture()
def rr_env(monkeypatch):
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

    store_mod.DocumentStoreBase = _StubDocumentStoreBase

    monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common', common_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.schema', schema)
    monkeypatch.setitem(sys.modules, 'ai.common.table', table)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config)
    monkeypatch.setitem(sys.modules, 'ai.common.transform', transform)
    monkeypatch.setitem(sys.modules, 'ai.common.store', store_mod)

    rrdb_mod = _load_from_path('ai.common.rocketride_db', _RRDB_PATH)
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', rrdb_mod)

    # The injectable fake resolver: same seam a SaaS build fills in.
    account_mod = types.ModuleType('ai.account')

    async def fake_resolve_db_dsn(client_id):
        assert client_id == TEST_CLIENT_ID
        return TEST_DSN

    account_mod.account = types.SimpleNamespace(resolve_db_dsn=fake_resolve_db_dsn)
    monkeypatch.setitem(sys.modules, 'ai.account', account_mod)
    monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', TEST_CLIENT_ID)
    monkeypatch.delenv('ROCKETRIDE_DB_DSN', raising=False)

    return types.SimpleNamespace(schema=schema, warnings=warnings)


@pytest.fixture()
def raw_conn():
    conn = psycopg2.connect(TEST_DSN)
    yield conn
    conn.close()


# ---------------------------------------------------------------------------
# rocketride_sql end-to-end
# ---------------------------------------------------------------------------


def _load_sql_node(monkeypatch):
    db_global = _load_from_path('ai.common.database.db_global_base', _DB_BASE_DIR / 'db_global_base.py')
    sql_safety = _load_from_path('ai.common.database.sql_safety', _DB_BASE_DIR / 'sql_safety.py')
    database_pkg = types.ModuleType('ai.common.database')
    database_pkg.__path__ = [str(_DB_BASE_DIR)]
    database_pkg.DatabaseGlobalBase = db_global.DatabaseGlobalBase
    monkeypatch.setitem(sys.modules, 'ai.common.database', database_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.database.db_global_base', db_global)
    monkeypatch.setitem(sys.modules, 'ai.common.database.sql_safety', sql_safety)
    db_instance = _load_from_path('ai.common.database.db_instance_base', _DB_BASE_DIR / 'db_instance_base.py')
    database_pkg.DatabaseInstanceBase = db_instance.DatabaseInstanceBase
    monkeypatch.setitem(sys.modules, 'ai.common.database.db_instance_base', db_instance)

    iglobal = _load_from_path('nodes.rocketride_sql.IGlobal', _SQL_NODE_DIR / 'IGlobal.py')
    pkg = types.ModuleType('nodes.rocketride_sql')
    pkg.__path__ = [str(_SQL_NODE_DIR)]
    pkg.IGlobal = iglobal
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_sql', pkg)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_sql.IGlobal', iglobal)
    iinstance = _load_from_path('nodes.rocketride_sql.IInstance', _SQL_NODE_DIR / 'IInstance.py')
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

    def test_begin_global_via_injected_env_dsn(self, rr_env, monkeypatch, sql_table):
        """The production delivery path: the task engine resolves server-side and
        injects ROCKETRIDE_DB_DSN; the node-side account is never consulted.
        """
        import types as _types

        async def poisoned(client_id):  # pragma: no cover — must not be reached
            raise AssertionError('account must not be consulted when ROCKETRIDE_DB_DSN is injected')

        monkeypatch.setitem(
            sys.modules, 'ai.account', _types.SimpleNamespace(account=_types.SimpleNamespace(resolve_db_dsn=poisoned))
        )
        monkeypatch.setenv('ROCKETRIDE_DB_DSN', TEST_DSN)
        glb, inst = self._begin(monkeypatch, {'table': sql_table, 'allow_execute': True})
        try:
            assert glb.database == TEST_DB_NAME
            rows = inst.execute({'sql': f'SELECT count(*) AS n FROM {sql_table}'})
            assert rows['rows'][0]['n'] == 2
        finally:
            glb.endGlobal()

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
    iglobal = _load_from_path('nodes.rocketride_vector.IGlobal', _VEC_NODE_DIR / 'IGlobal.py')
    pkg = types.ModuleType('nodes.rocketride_vector')
    pkg.__path__ = [str(_VEC_NODE_DIR)]
    pkg.IGlobal = iglobal
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector', pkg)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector.IGlobal', iglobal)
    store = _load_from_path('nodes.rocketride_vector.rocketride_vector', _VEC_NODE_DIR / 'rocketride_vector.py')
    return store.Store


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
        # Close the driver connection before dropping: the driver's SELECT
        # paths (mirroring vectordb_postgres) leave the session idle in
        # transaction, and its AccessShare lock would block the DROP.
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
        node_module = sys.modules['nodes.rocketride_vector.rocketride_vector']
        search_sql = node_module.SQL_QUERIES['semantic_search'].format(
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
