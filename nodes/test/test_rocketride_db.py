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

"""Unit tests for the RocketRide cloud DB nodes (no database required).

Covers the shared connection seam (``ai.common.rocketride_db``), the OSS
``Account.resolve_db_dsn`` stub, the ``rocketride_sql`` connection override,
and the ``rocketride_vector`` HNSW default-index logic. Real base classes are
loaded from disk with ``rocketlib`` and heavy drivers stubbed, mirroring
``test_graph_neo4j.py``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types

from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_AI_SRC = _REPO / 'packages' / 'ai' / 'src'
_RRDB_PATH = _AI_SRC / 'ai' / 'common' / 'rocketride_db.py'
_ACCOUNT_BASE = _AI_SRC / 'ai' / 'account' / 'base.py'
_ACCOUNT_OSS = _AI_SRC / 'ai' / 'account' / 'oss' / '__init__.py'
_SQL_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_sql'
_VEC_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_vector'

TEST_DSN = 'postgresql://rruser:rrpass@localhost:55432/rrtenant'


def _load_from_path(name: str, path: Path, *, is_package: bool = False):
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_rrdb():
    """Load ai.common.rocketride_db in isolation (it only imports stdlib)."""
    return _load_from_path('_test_rocketride_db_helpers', _RRDB_PATH)


rrdb = _load_rrdb()


# ---------------------------------------------------------------------------
# Shared seam helpers
# ---------------------------------------------------------------------------


class TestDsnHelpers:
    def test_url_gets_psycopg2_driver(self):
        assert rrdb.to_sqlalchemy_url(TEST_DSN) == 'postgresql+psycopg2://rruser:rrpass@localhost:55432/rrtenant'

    def test_postgres_scheme_gets_psycopg2_driver(self):
        assert rrdb.to_sqlalchemy_url('postgres://u:p@h/db') == 'postgresql+psycopg2://u:p@h/db'

    def test_explicit_driver_passes_through(self):
        dsn = 'postgresql+psycopg2://u:p@h/db'
        assert rrdb.to_sqlalchemy_url(dsn) == dsn

    def test_keyvalue_dsn_passes_through(self):
        dsn = 'host=localhost dbname=rrtenant user=rruser'
        assert rrdb.to_sqlalchemy_url(dsn) == dsn

    def test_parse_dsn_fields(self):
        fields = rrdb.parse_dsn_fields(TEST_DSN)
        assert fields == {
            'host': 'localhost',
            'port': 55432,
            'user': 'rruser',
            'password': 'rrpass',
            'database': 'rrtenant',
        }

    def test_parse_dsn_fields_unquotes_credentials(self):
        fields = rrdb.parse_dsn_fields('postgresql://u%40x:p%23w@h:5432/db')
        assert fields['user'] == 'u@x'
        assert fields['password'] == 'p#w'

    def test_parse_keyvalue_dsn_yields_empty_fields(self):
        fields = rrdb.parse_dsn_fields('host=x dbname=y')
        assert fields['host'] == ''
        assert fields['database'] == ''

    def test_parse_malformed_port_degrades_that_field_only(self):
        fields = rrdb.parse_dsn_fields('postgresql://u:p@h:notaport/db')
        assert fields['port'] is None
        assert fields['host'] == 'h'
        assert fields['database'] == 'db'

    def test_parse_malformed_authority_yields_empty_fields(self):
        # Mismatched IPv6 bracket — urlparse itself raises ValueError.
        fields = rrdb.parse_dsn_fields('postgresql://[::1/db')
        assert fields == {'host': '', 'port': None, 'user': '', 'password': '', 'database': ''}


class TestClientId:
    def test_missing_env_raises(self, monkeypatch):
        monkeypatch.delenv(rrdb.CLIENT_ID_ENV, raising=False)
        with pytest.raises(ValueError, match='signed-in RocketRide cloud identity'):
            rrdb.current_client_id()

    def test_present_env_returned_stripped(self, monkeypatch):
        monkeypatch.setenv(rrdb.CLIENT_ID_ENV, '  tenant-42  ')
        assert rrdb.current_client_id() == 'tenant-42'


class TestResolveRocketrideDsn:
    """The full seam: injected env DSN first, else account singleton via async bridge."""

    def _install_fake_account(self, monkeypatch, resolver):
        monkeypatch.delenv(rrdb.DB_DSN_ENV, raising=False)
        ai_pkg = types.ModuleType('ai')
        ai_pkg.__path__ = []
        account_mod = types.ModuleType('ai.account')
        account_mod.account = types.SimpleNamespace(resolve_db_dsn=resolver)
        monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
        monkeypatch.setitem(sys.modules, 'ai.account', account_mod)

    def test_injected_env_dsn_wins(self, monkeypatch):
        """The task-engine-injected ROCKETRIDE_DB_DSN short-circuits everything."""

        async def fake(client_id):  # pragma: no cover — must not be reached
            raise AssertionError('account must not be consulted when the env DSN is present')

        self._install_fake_account(monkeypatch, fake)
        monkeypatch.setenv(rrdb.DB_DSN_ENV, f'  {TEST_DSN}  ')
        # No client id needed on the injected path either.
        monkeypatch.delenv(rrdb.CLIENT_ID_ENV, raising=False)
        assert rrdb.resolve_rocketride_dsn() == TEST_DSN

    def test_resolve_error_env_surfaces_broker_failure(self, monkeypatch):
        """A server-side resolution failure names the real cause, not sign-in."""

        async def fake(client_id):  # pragma: no cover — must not be reached
            raise AssertionError('account must not be consulted when a resolve error is present')

        self._install_fake_account(monkeypatch, fake)
        monkeypatch.delenv(rrdb.DB_DSN_ENV, raising=False)
        monkeypatch.setenv(rrdb.DB_RESOLVE_ERROR_ENV, 'DB broker request failed: HTTP 503')
        with pytest.raises(ValueError, match='HTTP 503'):
            rrdb.resolve_rocketride_dsn()

    def test_empty_env_dsn_falls_back_to_account(self, monkeypatch):
        async def fake(client_id):
            return TEST_DSN

        self._install_fake_account(monkeypatch, fake)
        monkeypatch.setenv(rrdb.DB_DSN_ENV, '   ')
        monkeypatch.setenv(rrdb.CLIENT_ID_ENV, 'tenant-42')
        assert rrdb.resolve_rocketride_dsn() == TEST_DSN

    def test_resolves_via_fake_account(self, monkeypatch):
        seen = {}

        async def fake(client_id):
            seen['client_id'] = client_id
            return TEST_DSN

        self._install_fake_account(monkeypatch, fake)
        monkeypatch.setenv(rrdb.CLIENT_ID_ENV, 'tenant-42')
        assert rrdb.resolve_rocketride_dsn() == TEST_DSN
        assert seen['client_id'] == 'tenant-42'

    def test_empty_dsn_raises(self, monkeypatch):
        async def fake(client_id):
            return ''

        self._install_fake_account(monkeypatch, fake)
        monkeypatch.setenv(rrdb.CLIENT_ID_ENV, 'tenant-42')
        with pytest.raises(ValueError, match='empty DSN'):
            rrdb.resolve_rocketride_dsn()

    def test_rejects_running_event_loop(self, monkeypatch):
        async def fake(client_id):
            return TEST_DSN

        self._install_fake_account(monkeypatch, fake)
        monkeypatch.setenv(rrdb.CLIENT_ID_ENV, 'tenant-42')

        async def call_from_loop():
            return rrdb.resolve_rocketride_dsn()

        with pytest.raises(RuntimeError, match='running event loop'):
            asyncio.run(call_from_loop())


# ---------------------------------------------------------------------------
# Account layer: OSS stub + base default
# ---------------------------------------------------------------------------


class TestAccountStub:
    @pytest.fixture()
    def account_cls(self, monkeypatch):
        """Load the OSS Account with ``depends`` stubbed out."""
        depends_mod = types.ModuleType('depends')
        depends_mod.depends = lambda *a, **kw: None
        monkeypatch.setitem(sys.modules, 'depends', depends_mod)

        ai_pkg = types.ModuleType('ai')
        ai_pkg.__path__ = [str(_AI_SRC / 'ai')]
        monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
        account_pkg = types.ModuleType('ai.account')
        account_pkg.__path__ = [str(_ACCOUNT_BASE.parent)]
        monkeypatch.setitem(sys.modules, 'ai.account', account_pkg)
        base_mod = _load_from_path('ai.account.base', _ACCOUNT_BASE)
        monkeypatch.setitem(sys.modules, 'ai.account.base', base_mod)
        oss_mod = _load_from_path('ai.account.oss', _ACCOUNT_OSS, is_package=True)
        monkeypatch.setitem(sys.modules, 'ai.account.oss', oss_mod)
        return base_mod.AccountBase, oss_mod.Account

    def test_oss_stub_raises_cloud_signin_message(self, account_cls):
        _, account = account_cls
        with pytest.raises(NotImplementedError, match='require signing into RocketRide cloud'):
            asyncio.run(account().resolve_db_dsn('tenant-42'))

    def test_base_default_raises(self, account_cls):
        base, _ = account_cls

        class Minimal(base):
            async def authenticate(self, credential):
                return None

        with pytest.raises(NotImplementedError):
            asyncio.run(Minimal().resolve_db_dsn('tenant-42'))


# ---------------------------------------------------------------------------
# rocketride_sql: connection resolution override
# ---------------------------------------------------------------------------


def _sql_iglobal_cls(monkeypatch):
    """Load rocketride_sql/IGlobal with the database base loaded from disk."""
    pytest.importorskip('sqlalchemy')

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []
    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=lambda *a, **kw: {})
    monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common', common_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config)

    rrdb_mod = _load_from_path('ai.common.rocketride_db', _RRDB_PATH)
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', rrdb_mod)

    db_global = _load_from_path(
        'ai.common.database.db_global_base',
        _AI_SRC / 'ai' / 'common' / 'database' / 'db_global_base.py',
    )
    database_pkg = types.ModuleType('ai.common.database')
    database_pkg.__path__ = []
    database_pkg.DatabaseGlobalBase = db_global.DatabaseGlobalBase
    monkeypatch.setitem(sys.modules, 'ai.common.database', database_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.database.db_global_base', db_global)

    iglobal = _load_from_path('nodes.rocketride_sql.IGlobal', _SQL_NODE_DIR / 'IGlobal.py')
    return iglobal.IGlobal, rrdb_mod


class TestRocketrideSqlConnection:
    def _with_fake_account(self, monkeypatch):
        account_mod = types.ModuleType('ai.account')

        async def fake(client_id):
            return TEST_DSN

        account_mod.account = types.SimpleNamespace(resolve_db_dsn=fake)
        monkeypatch.setitem(sys.modules, 'ai.account', account_mod)
        monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', 'tenant-42')
        monkeypatch.delenv('ROCKETRIDE_DB_DSN', raising=False)

    def test_connection_params_come_from_resolved_dsn(self, monkeypatch):
        cls, _ = _sql_iglobal_cls(monkeypatch)
        self._with_fake_account(monkeypatch)
        glb = cls()
        params = glb._connection_params({'table': ' widgets '})
        assert params['host'] == 'localhost'
        assert params['user'] == 'rruser'
        assert params['password'] == 'rrpass'
        assert params['database'] == 'rrtenant'
        assert params['table'] == 'widgets'

    def test_build_connection_url_uses_cached_dsn(self, monkeypatch):
        cls, _ = _sql_iglobal_cls(monkeypatch)
        self._with_fake_account(monkeypatch)
        glb = cls()
        params = glb._connection_params({})
        url = glb._build_connection_url(params)
        assert url == 'postgresql+psycopg2://rruser:rrpass@localhost:55432/rrtenant'

    def test_no_connection_fields_read_from_config(self, monkeypatch):
        """host/user/password in config must be ignored — the DSN wins."""
        cls, _ = _sql_iglobal_cls(monkeypatch)
        self._with_fake_account(monkeypatch)
        glb = cls()
        params = glb._connection_params({'host': 'evil', 'user': 'evil', 'password': 'evil'})
        assert params['host'] == 'localhost'
        assert params['user'] == 'rruser'
        url = glb._build_connection_url(params)
        assert 'evil' not in url


# ---------------------------------------------------------------------------
# rocketride_vector: HNSW default-index logic
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, executed, fetch_batches):
        self._executed = executed
        self._fetch_batches = fetch_batches

    def execute(self, sql, params=None):
        self._executed.append(sql)

    def fetchone(self):
        # Existence probes (_doesCollectionExist) read a single boolean.
        return (True,)

    def fetchall(self):
        return self._fetch_batches.pop(0) if self._fetch_batches else []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeClient:
    def __init__(self):
        self.executed: list[str] = []
        self.commits = 0
        # Queue of row batches returned by successive fetchall() calls.
        self.fetch_batches: list[list] = []

    def cursor(self):
        return _FakeCursor(self.executed, self.fetch_batches)

    def commit(self):
        self.commits += 1

    def close(self):
        pass


def _vector_store_cls(monkeypatch):
    """Load the rocketride_vector Store with heavy deps stubbed."""
    warnings: list[str] = []

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *a, **kw: None
    monkeypatch.setitem(sys.modules, 'depends', depends_mod)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.warning = warnings.append
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG=object())
    rocketlib.Entry = type('Entry', (), {})
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    numpy_mod = types.ModuleType('numpy')
    numpy_mod.array = lambda x: x
    monkeypatch.setitem(sys.modules, 'numpy', numpy_mod)

    psycopg2_mod = types.ModuleType('psycopg2')
    psycopg2_mod.connect = lambda *a, **kw: _FakeClient()
    monkeypatch.setitem(sys.modules, 'psycopg2', psycopg2_mod)
    pgvector_mod = types.ModuleType('pgvector')
    pgvector_psycopg2 = types.ModuleType('pgvector.psycopg2')
    pgvector_psycopg2.register_vector = lambda client: None
    pgvector_mod.psycopg2 = pgvector_psycopg2
    monkeypatch.setitem(sys.modules, 'pgvector', pgvector_mod)
    monkeypatch.setitem(sys.modules, 'pgvector.psycopg2', pgvector_psycopg2)

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []
    schema = types.ModuleType('ai.common.schema')
    for name in ('Doc', 'DocFilter', 'DocMetadata', 'QuestionText'):
        setattr(schema, name, type(name, (), {}))
    store_mod = types.ModuleType('ai.common.store')

    class _StubDocumentStoreBase:
        def __init__(self, provider, connConfig, bag):
            self.vectorSize = 0
            self.modelName = ''
            self.threshold_search = 0.5

    store_mod.DocumentStoreBase = _StubDocumentStoreBase
    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=lambda provider, connConfig: dict(connConfig))
    transform = types.ModuleType('ai.common.transform')
    for name in ('IGlobalTransform', 'IInstanceTransform', 'IEndpointTransform'):
        setattr(transform, name, type(name, (), {}))
    monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common', common_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.schema', schema)
    monkeypatch.setitem(sys.modules, 'ai.common.store', store_mod)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config)
    monkeypatch.setitem(sys.modules, 'ai.common.transform', transform)

    rrdb_mod = _load_from_path('ai.common.rocketride_db', _RRDB_PATH)
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', rrdb_mod)

    account_mod = types.ModuleType('ai.account')

    async def fake(client_id):
        return TEST_DSN

    account_mod.account = types.SimpleNamespace(resolve_db_dsn=fake)
    monkeypatch.setitem(sys.modules, 'ai.account', account_mod)
    monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', 'tenant-42')
    monkeypatch.delenv('ROCKETRIDE_DB_DSN', raising=False)

    iglobal = _load_from_path('nodes.rocketride_vector.IGlobal', _VEC_NODE_DIR / 'IGlobal.py')
    pkg = types.ModuleType('nodes.rocketride_vector')
    pkg.__path__ = [str(_VEC_NODE_DIR)]
    pkg.IGlobal = iglobal
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector', pkg)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector.IGlobal', iglobal)
    store = _load_from_path('nodes.rocketride_vector.rocketride_vector', _VEC_NODE_DIR / 'rocketride_vector.py')
    return store.Store, warnings


def _make_store(cls, config):
    return cls('rocketride_vector', config, {})


class TestRocketrideVectorStore:
    def test_connects_via_resolved_dsn(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        assert store.client_id == 'tenant-42'
        assert store.host == 'localhost'
        assert store.port == 55432
        assert store.database == 'rrtenant'
        assert isinstance(store.client, _FakeClient)

    def test_invalid_collection_rejected(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        with pytest.raises(ValueError, match='Invalid collection name'):
            _make_store(cls, {'collection': 'bad-name;drop', 'similarity': 'cosine'})

    @pytest.mark.parametrize(
        ('similarity', 'opclass'),
        [
            ('cosine', 'vector_cosine_ops'),
            ('l2', 'vector_l2_ops'),
            ('inner_product', 'vector_ip_ops'),
        ],
    )
    def test_hnsw_index_opclass_follows_similarity(self, monkeypatch, similarity, opclass):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': similarity})
        store._createCollection(vectorSize=5)
        ddl = store.client.executed
        assert any('CREATE TABLE IF NOT EXISTS rr_vec' in sql for sql in ddl)
        index_sql = [sql for sql in ddl if 'USING hnsw' in sql]
        assert len(index_sql) == 1
        assert f'(embedding {opclass})' in index_sql[0]
        assert 'rr_vec_embedding_hnsw' in index_sql[0]
        assert 'm = 16' in index_sql[0]
        assert 'ef_construction = 64' in index_sql[0]

    def test_hnsw_params_overridable(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(
            cls,
            {'collection': 'rr_vec', 'similarity': 'cosine', 'hnsw_m': 32, 'hnsw_ef_construction': 128},
        )
        store._createCollection(vectorSize=5)
        index_sql = [sql for sql in store.client.executed if 'USING hnsw' in sql]
        assert 'm = 32' in index_sql[0]
        assert 'ef_construction = 128' in index_sql[0]

    def test_render_orders_chunks_and_bridges_gaps(self, monkeypatch):
        """Chunks at 0, 1 and 3 (gap at 2): index order preserved, gap skipped."""
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.client.fetch_batches = [[('A', 0), ('D', 3), ('B', 1)]]
        out: list[str] = []
        store.render('obj-1', out.append)
        assert out == ['ABD']

    def test_render_empty_batch_emits_nothing(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.client.fetch_batches = [[]]
        out: list[str] = []
        store.render('obj-1', out.append)
        assert out == []

    def test_render_single_high_chunk_id(self, monkeypatch):
        """One row with a high chunkId renders that row — allocation is bounded
        by rows fetched, never by the chunkId value.
        """
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.client.fetch_batches = [[('X', 999_999)]]
        out: list[str] = []
        store.render('obj-1', out.append)
        assert out == ['X']

    def test_hnsw_params_clamped_to_pgvector_bounds(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(
            cls,
            {'collection': 'rr_vec', 'similarity': 'cosine', 'hnsw_m': 1, 'hnsw_ef_construction': 1},
        )
        # pgvector requires m >= 2, ef_construction >= 4 and >= 2 * m.
        assert store.hnsw_m == 2
        assert store.hnsw_ef_construction == 4

    def test_hnsw_ef_construction_raised_to_twice_m(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(
            cls,
            {'collection': 'rr_vec', 'similarity': 'cosine', 'hnsw_m': 64, 'hnsw_ef_construction': 64},
        )
        assert store.hnsw_ef_construction == 128

    def test_hnsw_skipped_above_dimension_ceiling(self, monkeypatch):
        cls, warnings = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store._createCollection(vectorSize=2001)
        ddl = store.client.executed
        assert any('CREATE TABLE IF NOT EXISTS rr_vec' in sql for sql in ddl)
        assert not any('USING hnsw' in sql for sql in ddl)
        assert any('2000' in w and 'Skipping index' in w for w in warnings)

    def test_hnsw_created_at_dimension_ceiling(self, monkeypatch):
        cls, warnings = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store._createCollection(vectorSize=2000)
        assert any('USING hnsw' in sql for sql in store.client.executed)
        assert not warnings
