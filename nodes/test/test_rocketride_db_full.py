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

The ``rocketride_vector`` cases run the node's real classes over the shared
pgvector driver, with the DSN delivered in ``ROCKETRIDE_DB_DSNS`` (the
production delivery path), once directly and once through a transaction-mode
pooler.

Configuration via environment variables:
    RR_TEST_PG_DSN — libpq URL of the test database
                     (default: postgresql://rruser:rrpass@localhost:55432/rrtenant)
    RR_TEST_PGVECTOR_POOLER_DSN — the same database behind PgBouncer in
                     transaction mode; the pooled rocketride_vector cases are
                     not run without it

Skips cleanly when the database is unreachable.
"""

from __future__ import annotations

import contextlib
import dataclasses
import importlib
import importlib.util
import json
import os
import sys
import urllib.parse
import types
import uuid

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
# rocketride_vector end-to-end (the shared pgvector driver, the HNSW index,
# the tool surface), directly and through the transaction-mode pooler
# ---------------------------------------------------------------------------


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


# The rocketride_vector cases run the node's real classes (StoreGlobalBase,
# StoreInstanceBase, the shared pgvector driver, the schema) rather than the
# stand-ins above, once directly and once through the pooler when
# RR_TEST_PGVECTOR_POOLER_DSN is set.

POOLER_DSN = os.environ.get('RR_TEST_PGVECTOR_POOLER_DSN', '').strip()
DIMS = 8
_VEC_MODULES = (
    'nodes.rocketride_vector',
    'nodes.rocketride_vector.IEndpoint',
    'nodes.rocketride_vector.IGlobal',
    'nodes.rocketride_vector.IInstance',
    'nodes.rocketride_vector.rocketride_vector',
)


@pytest.fixture(params=['direct', 'pooler'])
def vec_dsn(request) -> str:
    """The DSN the server injects: the database itself, or the transaction-mode pooler in front of it."""
    if request.param == 'pooler':
        if not POOLER_DSN:
            pytest.skip('NOT RUN: RR_TEST_PGVECTOR_POOLER_DSN is not set (the transaction-mode pooler pass)')
        try:
            psycopg2.connect(POOLER_DSN, connect_timeout=3).close()
        except Exception:
            if _DB_TESTS_REQUIRED:
                pytest.fail(f'RR_TEST_PGVECTOR_POOLER_DSN is set but not reachable: {POOLER_DSN}')
            pytest.skip(f'NOT RUN: pooler not reachable at {POOLER_DSN}')
        return POOLER_DSN
    return TEST_DSN


@pytest.fixture()
def rv(monkeypatch, vec_dsn):
    """The real rocketride_vector node, its DSN delivered the way the task engine delivers it."""
    import depends as real_depends

    depends_mod = types.ModuleType('depends')
    depends_mod.__dict__.update(real_depends.__dict__)
    depends_mod.depends = lambda *a, **kw: None  # the requirements are installed; never resolve them in a test
    monkeypatch.setitem(sys.modules, 'depends', depends_mod)
    for name in _VEC_MODULES:  # always the real modules, never a stand-in another suite registered
        monkeypatch.delitem(sys.modules, name, raising=False)
    from ai.common.config import Config

    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, connConfig: dict(connConfig)))
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': vec_dsn}))
    monkeypatch.delenv('ROCKETRIDE_DB_RESOLVE_ERROR', raising=False)
    store_mod = importlib.import_module('nodes.rocketride_vector.rocketride_vector')
    iglobal_mod = importlib.import_module('nodes.rocketride_vector.IGlobal')
    iinstance_mod = importlib.import_module('nodes.rocketride_vector.IInstance')
    from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText

    return types.SimpleNamespace(
        dsn=vec_dsn,
        Store=store_mod.Store,
        IGlobal=iglobal_mod.IGlobal,
        IInstance=iinstance_mod.IInstance,
        Doc=Doc,
        DocFilter=DocFilter,
        DocMetadata=DocMetadata,
        QuestionText=QuestionText,
        monkeypatch=monkeypatch,
    )


def _unique_table(prefix: str) -> str:
    """A table name no other test (or parallel worker) uses."""
    return f'{prefix}_{uuid.uuid4().hex[:8]}'


def _unit_vec(rng):
    v = rng.standard_normal(DIMS)
    return (v / np.linalg.norm(v)).tolist()


@contextlib.contextmanager
def _called_as(rv, ctx):
    """Run the body as the tool call ``ctx``, the way the engine's dispatcher runs a tool method.

    Where the engine does not record the call context yet (``tool_call`` is an
    interface there), the node module's lookup stands in for it, so the node
    sees exactly ``ctx``; where it does, nothing is replaced.
    """
    from ai.common import tool_context

    with tool_context.tool_call(ctx):
        if tool_context.current_tool_call() is not None:
            yield
            return
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(sys.modules[rv.IInstance.__module__], 'current_tool_call', lambda: ctx)
            yield


def _begin_vector_node(rv, config):
    """Run the node's real beginGlobal (open the store, register the transform key).

    The tool tests run past the outer gate: unless ``config`` sets them,
    expose_tools and allow_write are on (both default off on the node).
    """
    from rocketlib import OPEN_MODE

    config = {'expose_tools': True, 'allow_write': True, **config}
    glb = rv.IGlobal()
    glb.IEndpoint = types.SimpleNamespace(
        endpoint=types.SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}, parameters={})
    )
    glb.glb = types.SimpleNamespace(logicalType='rocketride_vector', connConfig=config)
    glb.beginGlobal()
    inst = rv.IInstance()
    inst.IGlobal = glb
    return glb, inst


class TestRocketrideVectorE2E:
    @pytest.fixture()
    def vec_store(self, rv, raw_conn):
        table = _unique_table('vx_l2_rr_e2e')
        store = rv.Store('rocketride_vector', {'collection': table, 'similarity': 'cosine'}, {})
        yield store
        store.close()
        with raw_conn.cursor() as cur:
            cur.execute("SET lock_timeout = '10s'")
            cur.execute(f'DROP TABLE IF EXISTS {table}')
            raw_conn.commit()

    def _chunks(self, rv, contents_and_embeddings, chunk_id=0):
        return [
            rv.Doc(
                page_content=content,
                metadata=rv.DocMetadata(
                    objectId=f'obj-{i}',
                    chunkId=chunk_id,
                    nodeId='test-node',
                    parent='/test',
                    permissionId=0,
                    isDeleted=False,
                    isTable=False,
                    tableId=0,
                    signature='component-signature',
                    chunk_index=chunk_id,
                ),
                embedding=embedding,
                embedding_model='test-model',
            )
            for i, (content, embedding) in enumerate(contents_and_embeddings)
        ]

    def test_connects_via_the_injected_dsn_and_reports_no_connection_details(self, rv, vec_store):
        assert vec_store.database == TEST_DB_NAME
        info = vec_store.describe()
        assert info.collection == vec_store.table and info.collection_exists is False
        assert 'shared_org_table' in info.caveats
        dumped = json.dumps(dataclasses.asdict(info))
        fields = urllib.parse.urlparse(rv.dsn)
        for secret in (fields.hostname, str(fields.port), fields.username, fields.password, TEST_DB_NAME):
            assert secret not in dumped

    def test_first_write_creates_table_and_hnsw_index(self, rv, vec_store, raw_conn):
        rng = np.random.default_rng(7)
        vec_store.addChunks(self._chunks(rv, [(f'doc {i}', _unit_vec(rng)) for i in range(100)]))

        with raw_conn.cursor() as cur:
            cur.execute('SELECT indexname, indexdef FROM pg_indexes WHERE tablename = %s', (vec_store.table,))
            indexes = {name: ddl for name, ddl in cur.fetchall()}
            cur.execute(
                f'SELECT count(*), count(signature), count(meta) FROM {vec_store.table} WHERE objectid <> %s',
                ('schema',),
            )
            counts = cur.fetchone()
        raw_conn.rollback()

        index_name = f'{vec_store.table}_embedding_hnsw'
        assert index_name in indexes
        assert 'USING hnsw (embedding vector_cosine_ops)' in indexes[index_name]
        assert "m='16'" in indexes[index_name]
        assert "ef_construction='64'" in indexes[index_name]
        # A real Doc (signature and chunker extras included) is stored, not refused.
        assert counts == (100, 100, 100)

    def test_semantic_search_uses_hnsw_index_not_seq_scan(self, rv, vec_store, raw_conn):
        """The acceptance check: the node's own search SQL must use the index.

        The planner rightly prefers a seq scan on tiny tables, so load enough
        rows (and ANALYZE) that index cost wins; then EXPLAIN the exact
        statement the driver executes for a semantic search.
        """
        from psycopg2 import sql as pgsql

        rng = np.random.default_rng(11)
        vec_store.addChunks(self._chunks(rv, [('seed doc', _unit_vec(rng))]))
        with raw_conn.cursor() as cur:
            cur.execute(
                f'INSERT INTO {vec_store.table} (content, objectId, chunkId, isDeleted, embedding) '
                f"SELECT 'doc '||i, 'obj-'||i, 0, false, "
                f"(SELECT ('['||string_agg((random()*2-1)::text, ',')||']')::vector "
                f' FROM generate_series(1,{DIMS}) WHERE i=i) '
                f'FROM generate_series(1, 2000) i'
            )
            cur.execute(f'ANALYZE {vec_store.table}')
            raw_conn.commit()

        from ai.common.store.pgvector.sql import vector_literal

        statement, params = vec_store._sql.semantic(
            vec_store._cached_columns(),
            'cosine',
            vector_literal(_unit_vec(rng)),
            vec_store._where(rv.DocFilter()),
            5,
            0,
        )
        with raw_conn.cursor() as cur:
            cur.execute(pgsql.SQL('EXPLAIN ') + statement, params)
            plan = '\n'.join(row[0] for row in cur.fetchall())
        raw_conn.rollback()

        assert f'Index Scan using {vec_store.table}_embedding_hnsw' in plan, plan
        assert 'Seq Scan' not in plan, plan

    def test_semantic_search_returns_nearest_document(self, rv, vec_store):
        rng = np.random.default_rng(23)
        vectors = [(f'doc {i}', _unit_vec(rng)) for i in range(50)]
        vec_store.addChunks(self._chunks(rv, vectors))

        # Query with the exact embedding of doc 17: it must come back first.
        query = rv.QuestionText(text='find doc 17')
        query.embedding = vectors[17][1]
        results = vec_store.searchSemantic(query, rv.DocFilter(limit=5))
        assert results, 'semantic search returned nothing'
        assert results[0].page_content == 'doc 17'
        assert results[0].score > 0.99

    def test_upsert_replaces_same_object_id(self, rv, vec_store):
        rng = np.random.default_rng(31)
        vec_store.addChunks(self._chunks(rv, [('original', _unit_vec(rng))]))
        vec_store.addChunks(self._chunks(rv, [('replaced', _unit_vec(rng))]))
        assert vec_store.count_documents() == 2  # the chunk and the control record
        assert vec_store.countChunks(rv.DocFilter()) == 1

    def test_wide_vectors_skip_index_with_warning(self, rv, raw_conn):
        import ai.common.store.pgvector.driver as driver

        warnings: list = []
        rv.monkeypatch.setattr(driver, 'warning', warnings.append)
        wide_table = _unique_table('vx_l2_rr_wide')
        store = rv.Store('rocketride_vector', {'collection': wide_table, 'similarity': 'cosine'}, {})
        try:
            store._createCollection(vectorSize=2001)
            with raw_conn.cursor() as cur:
                cur.execute('SELECT indexname FROM pg_indexes WHERE tablename = %s', (wide_table,))
                index_names = [row[0] for row in cur.fetchall()]
            raw_conn.rollback()
            assert not any('hnsw' in name for name in index_names)
            assert any('Skipping index' in w for w in warnings)
        finally:
            store.close()
            with raw_conn.cursor() as cur:
                cur.execute(f'DROP TABLE IF EXISTS {wide_table}')
                raw_conn.commit()


class TestRocketrideVectorNode:
    """The node's lifecycle and tool surface through its real IGlobal/IInstance."""

    @pytest.fixture()
    def table(self, raw_conn):
        name = _unique_table('vx_l2_rr_node')
        yield name
        with raw_conn.cursor() as cur:
            cur.execute("SET lock_timeout = '10s'")
            cur.execute(f'DROP TABLE IF EXISTS {name}')
            raw_conn.commit()

    def test_node_uses_the_store_bases(self, rv):
        from ai.common.store import StoreGlobalBase, StoreInstanceBase, VectorStoreToolMixin
        from ai.common.store.pgvector import PgVectorStore

        assert issubclass(rv.IGlobal, StoreGlobalBase)
        assert issubclass(rv.IInstance, StoreInstanceBase) and issubclass(rv.IInstance, VectorStoreToolMixin)
        assert issubclass(rv.Store, PgVectorStore)

    def test_services_declare_the_tool_and_the_write_switches(self):
        from ai.common.store.vx_defaults import VECTOR_ALLOW_WRITES_DEFAULT

        text = (_VEC_NODE_DIR / 'services.json').read_text(encoding='utf-8')
        text = '\n'.join(line for line in text.splitlines() if not line.strip().startswith('//'))
        services = json.loads(text)
        assert services['classType'] == ['store', 'tool']
        assert services['capabilities'] == ['invoke']
        fields = services['fields']
        # The outer gate (#2631): the tool surface and the write tools, both off by default.
        assert fields['rrvector.expose_tools']['default'] is False
        assert fields['rrvector.allow_write']['default'] is False
        # The write gate's DAP switch. Agents have no switch of their own: allow_write alone decides theirs.
        assert fields['rrvector.allow_writes']['default'] is VECTOR_ALLOW_WRITES_DEFAULT
        assert not [name for name in fields if 'agent_writes' in name]
        properties = set(fields['rrvector.cloud']['properties'])
        assert {'rrvector.expose_tools', 'rrvector.allow_write', 'rrvector.allow_writes'} <= properties
        # The allow_writes default lives in vx_defaults only: no profile pins it.
        assert all('allow_writes' not in profile for profile in services['preconfig']['profiles'].values())

    def test_tools_are_hidden_and_refused_with_the_shipped_switches(self, rv, table):
        """With expose_tools and allow_write at their defaults (off), no tool is offered or runs."""
        from ai.common.tool_context import ToolCallContext

        rng = np.random.default_rng(40)
        glb, inst = _begin_vector_node(
            rv, {'collection': table, 'similarity': 'cosine', 'expose_tools': False, 'allow_write': False}
        )
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        try:
            self._seed(rv, glb, rng)
            assert inst._collect_tool_methods() == {}
            with _called_as(rv, ctx):
                for answer in (inst.stats({}), inst.objdir({}), self._write(inst, rng, 'delete', 'doc')):
                    assert answer['success'] is False and 'expose_tools=true' in answer['error'], answer
            self._unchanged(rv, glb)
        finally:
            glb.endGlobal()

    def test_write_tools_are_hidden_and_refused_until_allow_write(self, rv, table):
        from ai.common.tool_context import ToolCallContext

        rng = np.random.default_rng(39)
        glb, inst = _begin_vector_node(
            rv, {'collection': table, 'similarity': 'cosine', 'allow_write': False, 'allow_writes': True}
        )
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        try:
            self._seed(rv, glb, rng)
            offered = set(inst._collect_tool_methods())
            assert {'search', 'objdir', 'get', 'stats'} <= offered
            assert offered.isdisjoint({'upsert', 'delete', 'soft_delete', 'restore'})
            with _called_as(rv, ctx):
                answer = self._write(inst, rng, 'delete', 'doc')
            assert answer['success'] is False and 'allow_write=true' in answer['error'], answer
            self._unchanged(rv, glb)
        finally:
            glb.endGlobal()

    def test_begin_global_opens_the_store_and_keys_on_the_tenant(self, rv, table):
        glb, inst = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine'})
        try:
            assert glb.TRANFORM_KEY_TAG_NAME == f'rocketride_vector://{TEST_DB_NAME}/{table}/status'.lower()
            stats = inst.stats({})
            assert stats['success'] is True and stats['count'] == 0
        finally:
            glb.endGlobal()
        assert glb.store is None

    def test_stats_after_restart_report_the_stored_model(self, rv, table):
        """A fresh task (nothing written by it) still reports the collection's model and dimension (D6)."""
        rng = np.random.default_rng(41)
        writer, _ = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine'})
        try:
            writer.store.addChunks(
                [
                    rv.Doc(
                        page_content='kestrel',
                        metadata=rv.DocMetadata(objectId='doc', chunkId=0, isDeleted=False),
                        embedding=_unit_vec(rng),
                        embedding_model='test-model',
                    )
                ]
            )
        finally:
            writer.endGlobal()
        reader, inst = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine'})
        try:
            stats = inst.stats({})
            assert (stats['model'], stats['vector_size'], stats['count']) == ('test-model', DIMS, 2)
        finally:
            reader.endGlobal()

    @staticmethod
    def _seed(rv, glb, rng):
        glb.store.addChunks(
            [
                rv.Doc(
                    page_content='kept',
                    metadata=rv.DocMetadata(objectId='doc', chunkId=0, isDeleted=False),
                    embedding=_unit_vec(rng),
                    embedding_model='test-model',
                )
            ]
        )

    @staticmethod
    def _write(inst, rng, tool, object_id):
        if tool == 'delete':
            return inst.delete({'object_ids': [object_id]})
        document = {
            'content': 'new',
            'object_id': object_id,
            'embedding': _unit_vec(rng),
            'embedding_model': 'test-model',
        }
        return inst.upsert({'documents': [document]})

    @staticmethod
    def _unchanged(rv, glb):
        """The seeded document is still there, nothing else was written, and the control record is intact."""
        assert glb.store.countChunks(rv.DocFilter()) == 1
        assert glb.store.countChunks(rv.DocFilter(objectIds=['doc'])) == 1
        assert glb.store.count_documents() == 2
        assert (glb.store.modelName, glb.store.vectorSize) == ('test-model', DIMS)

    def test_write_tools_stay_listed(self, rv):
        from ai.common.store import StoreInstanceBase

        for name in ('upsert', 'delete'):
            assert getattr(rv.IInstance, name).__tool_meta__ == getattr(StoreInstanceBase, name).__tool_meta__

    @pytest.mark.parametrize('allow_writes', [False, True])
    @pytest.mark.parametrize('tool', ['delete', 'upsert'])
    def test_tool_writes_without_a_call_context_are_refused(self, rv, table, allow_writes, tool):
        """A write that carries no call context is refused whatever the switch says; the rows stay."""
        rng = np.random.default_rng(44)
        config = {'collection': table, 'similarity': 'cosine', 'allow_writes': allow_writes}
        glb, inst = _begin_vector_node(rv, config)
        try:
            self._seed(rv, glb, rng)
            for object_id in ('doc', 'other', 'schema'):
                answer = self._write(inst, rng, tool, object_id)
                assert answer['success'] is False, answer
                assert answer['code'] == ('RESERVED_ID' if object_id == 'schema' else 'WRITES_UNKNOWN_CALLER')
            self._unchanged(rv, glb)
        finally:
            glb.endGlobal()

    @pytest.mark.parametrize(
        ('origin', 'switches', 'object_id', 'code'),
        [
            ('dap', {'allow_writes': False}, 'doc', 'WRITES_DISABLED'),
            ('agent', {}, 'schema', 'RESERVED_ID'),
            ('dap', {'allow_writes': True}, 'schema', 'RESERVED_ID'),
        ],
    )
    @pytest.mark.parametrize('tool', ['delete', 'upsert'])
    def test_tool_writes_refused_by_the_switches_and_the_reserved_id(
        self, rv, table, origin, switches, object_id, code, tool
    ):
        from ai.common.tool_context import ToolCallContext

        rng = np.random.default_rng(45)
        glb, inst = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine', **switches})
        if origin == 'dap':
            ctx = ToolCallContext(origin='dap', source_type='tools', targeted=True, caller={'auth': 'account'})
        else:
            ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        try:
            self._seed(rv, glb, rng)
            with _called_as(rv, ctx):
                answer = self._write(inst, rng, tool, object_id)
            assert answer['success'] is False and answer['code'] == code, answer
            self._unchanged(rv, glb)
        finally:
            glb.endGlobal()

    @pytest.mark.parametrize(
        'switches',
        [{}, {'allow_writes': False, 'agent_writes': False}],
        ids=['defaults', 'dap-writes-off-and-a-stray-agent-switch'],
    )
    def test_an_agent_s_upsert_and_delete_with_a_call_context_reach_the_store(self, rv, table, switches):
        """allow_write alone decides an agent's write: allow_writes and a stray agent_writes key are not read."""
        from ai.common.tool_context import ToolCallContext

        rng = np.random.default_rng(46)
        glb, inst = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine', **switches})
        assert not hasattr(glb, 'agent_writes')
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        try:
            self._seed(rv, glb, rng)
            with _called_as(rv, ctx):
                stored = self._write(inst, rng, 'upsert', 'other')
                removed = self._write(inst, rng, 'delete', 'doc')
            assert stored['success'] is True and removed['success'] is True, (stored, removed)
            assert glb.store.countChunks(rv.DocFilter(objectIds=['other'])) == 1
            assert glb.store.countChunks(rv.DocFilter(objectIds=['doc'])) == 0
        finally:
            glb.endGlobal()

    def test_writes_refused_with_the_switch_off(self, rv, table):
        """A DAP call from a Tools source is refused while rrvector.allow_writes is off; the rows stay."""
        from ai.common.tool_context import ToolCallContext, tool_call

        rng = np.random.default_rng(42)
        glb, inst = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine', 'allow_writes': False})
        try:
            glb.store.addChunks(
                [
                    rv.Doc(
                        page_content='kept',
                        metadata=rv.DocMetadata(objectId='doc', chunkId=0, isDeleted=False),
                        embedding=_unit_vec(rng),
                        embedding_model='test-model',
                    )
                ]
            )
            ctx = ToolCallContext(origin='dap', source_type='tools', targeted=True, caller={'auth': 'account'})
            with tool_call(ctx):
                removed = inst.soft_delete({'object_ids': ['doc']})
                deleted = inst.delete({'object_ids': ['doc']})
            assert removed['success'] is False and removed['code'] == 'WRITES_DISABLED'
            assert deleted['success'] is False and deleted['code'] == 'WRITES_DISABLED'
            assert glb.store.countChunks(rv.DocFilter()) == 1
        finally:
            glb.endGlobal()

    def test_writes_refused_without_a_call_context(self, rv, table):
        """With the switch on, a call that carries no call context is refused; the rows stay."""
        rng = np.random.default_rng(43)
        glb, inst = _begin_vector_node(rv, {'collection': table, 'similarity': 'cosine', 'allow_writes': True})
        try:
            glb.store.addChunks(
                [
                    rv.Doc(
                        page_content='kept',
                        metadata=rv.DocMetadata(objectId='doc', chunkId=0, isDeleted=False),
                        embedding=_unit_vec(rng),
                        embedding_model='test-model',
                    )
                ]
            )
            for tool in (inst.soft_delete, inst.restore, inst.delete):
                answer = tool({'object_ids': ['doc']})
                assert answer['success'] is False and answer['code'] == 'WRITES_UNKNOWN_CALLER'
            assert glb.store.countChunks(rv.DocFilter()) == 1
        finally:
            glb.endGlobal()
