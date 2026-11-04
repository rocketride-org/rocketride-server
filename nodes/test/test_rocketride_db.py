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
``rocketride_vector`` on the shared pgvector driver (its transactions, support
level and write gate, over the psycopg2 test double) and the
``rocketride_graph`` connection. Real base classes are loaded from disk with
``rocketlib`` and heavy drivers stubbed, mirroring ``test_graph_neo4j.py``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import re
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


def _load_from_path(name: str, path: Path, *, is_package: bool = False, register: bool = True):
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    if register:
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


class TestDbTarget:
    """A node's (scope, target), read from its resolved config."""

    def test_defaults_to_the_org_database(self):
        assert rrdb.db_target({}) == ('org', '')
        assert rrdb.db_target({'scope': None, 'target': None}) == ('org', '')

    @pytest.mark.parametrize(
        ('config', 'expected'),
        [
            ({'scope': 'team'}, ('team', '')),
            ({'scope': ' team ', 'target': ' t-1 '}, ('team', 't-1')),
            (
                {'scope': 'user', 'target': '5f0c2a9e-1b2c-4d3e-8f90-123456789abc'},
                ('user', '5f0c2a9e-1b2c-4d3e-8f90-123456789abc'),
            ),
        ],
    )
    def test_reads_scope_and_target(self, config, expected):
        assert rrdb.db_target(config) == expected

    @pytest.mark.parametrize(
        ('config', 'message'),
        [
            ({'scope': 'tenant'}, 'scope must be one of org, team, user'),
            ({'scope': 'org', 'target': 't-1'}, 'the org scope takes no target'),
            ({'scope': 'team', 'target': 'team:other'}, 'not a valid team or user id'),
            ({'scope': 'team', 'target': 'x' * 65}, 'not a valid team or user id'),
            ({'scope': 'user', 'target': 42}, 'target must be a team or user id'),
        ],
    )
    def test_rejects_bad_config(self, config, message):
        with pytest.raises(ValueError, match=message):
            rrdb.db_target(config)

    def test_dsn_key(self):
        assert rrdb.dsn_key('org') == 'org'
        assert rrdb.dsn_key('team') == 'team'
        assert rrdb.dsn_key('user', 'u-1') == 'user:u-1'

    def test_public_endpoint_comes_from_the_source_providers(self):
        assert rrdb.exposes_public_endpoint([{'provider': 'webhook'}, {'provider': 'rocketride_sql'}])
        assert rrdb.exposes_public_endpoint([{'provider': 'discord'}])
        assert not rrdb.exposes_public_endpoint([{'provider': 'tools'}, {'provider': 'rocketride_sql'}])
        assert not rrdb.exposes_public_endpoint(None)


class TestResolveRocketrideDsn:
    """Nodes only read what the task engine delivered; they never resolve."""

    @pytest.fixture(autouse=True)
    def _clean_env(self, monkeypatch):
        for name in (rrdb.DB_DSNS_ENV, 'ROCKETRIDE_DB_DSN', rrdb.DB_RESOLVE_ERROR_ENV):
            monkeypatch.delenv(name, raising=False)

    def _deliver(self, monkeypatch, dsns):
        monkeypatch.setenv(rrdb.DB_DSNS_ENV, json.dumps(dsns))

    def test_map_entry_for_each_scope(self, monkeypatch):
        self._deliver(monkeypatch, {'org': 'postgresql://o', 'team': 'postgresql://t', 'user:u-2': 'postgresql://u2'})
        assert rrdb.resolve_rocketride_dsn() == 'postgresql://o'
        assert rrdb.resolve_rocketride_dsn('team') == 'postgresql://t'
        assert rrdb.resolve_rocketride_dsn('user', 'u-2') == 'postgresql://u2'

    def test_missing_map_key_raises_and_never_falls_back(self, monkeypatch):
        """A key the engine did not authorize must raise, even with an org DSN at hand."""
        self._deliver(monkeypatch, {'org': 'postgresql://o'})
        with pytest.raises(ValueError, match="was not given the team database 't-9'"):
            rrdb.resolve_rocketride_dsn('team', 't-9')
        with pytest.raises(ValueError, match="was not given the run's own user database"):
            rrdb.resolve_rocketride_dsn('user')

    def test_malformed_map_raises(self, monkeypatch):
        monkeypatch.setenv(rrdb.DB_DSNS_ENV, '{not json')
        with pytest.raises(ValueError, match='not valid JSON'):
            rrdb.resolve_rocketride_dsn()

    def test_a_lone_single_dsn_variable_is_not_a_delivery(self, monkeypatch):
        """Only the map counts: a stray ROCKETRIDE_DB_DSN is never read."""
        monkeypatch.setenv('ROCKETRIDE_DB_DSN', TEST_DSN)
        with pytest.raises(rrdb.DsnNotDelivered):
            rrdb.resolve_rocketride_dsn()

    def test_resolve_error_env_surfaces_broker_failure(self, monkeypatch):
        """A server-side resolution failure names the real cause, not sign-in."""
        monkeypatch.setenv(rrdb.DB_RESOLVE_ERROR_ENV, 'DB broker request failed: HTTP 503')
        with pytest.raises(
            ValueError, match='cloud database is not available for this task: DB broker request failed: HTTP 503'
        ):
            rrdb.resolve_rocketride_dsn()

    def test_resolve_error_env_reports_missing_cloud_database(self, monkeypatch):
        """An engine without a broker passes the reason down the same way (#2463)."""
        monkeypatch.setenv(
            rrdb.DB_RESOLVE_ERROR_ENV, 'this server has no RocketRide cloud database (no database broker is configured)'
        )
        with pytest.raises(ValueError) as excinfo:
            rrdb.resolve_rocketride_dsn()
        assert 'this server has no RocketRide cloud database' in str(excinfo.value)
        assert not isinstance(excinfo.value, rrdb.DsnNotDelivered)

    def test_outside_a_task_nothing_is_resolved(self, monkeypatch):
        """No DSN delivered (a save-time probe in the server process): raise
        DsnNotDelivered and never call the account layer, which holds the
        broker token and would mint any tenant's DSN with no authorization.
        """
        account_mod = types.ModuleType('ai.account')

        async def poisoned(*args, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError('nodes must never resolve a DSN through the account layer')

        account_mod.account = types.SimpleNamespace(resolve_db_dsn=poisoned)
        monkeypatch.setitem(sys.modules, 'ai.account', account_mod)
        monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', 'tenant-42')
        with pytest.raises(rrdb.DsnNotDelivered, match='connectivity is checked when it runs'):
            rrdb.resolve_rocketride_dsn()

    def test_bad_scope_is_refused_before_any_lookup(self, monkeypatch):
        self._deliver(monkeypatch, {'org': 'postgresql://o'})
        with pytest.raises(ValueError, match='scope must be one of'):
            rrdb.resolve_rocketride_dsn('everyone')


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

    def test_oss_stub_raises_no_cloud_db_message(self, account_cls):
        _, account = account_cls
        with pytest.raises(NotImplementedError, match='no RocketRide cloud database is configured on this server'):
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
    def _deliver_org_dsn(self, monkeypatch):
        """Deliver the org DSN the way the task engine does."""
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))

    def test_connection_params_come_from_resolved_dsn(self, monkeypatch):
        cls, _ = _sql_iglobal_cls(monkeypatch)
        self._deliver_org_dsn(monkeypatch)
        glb = cls()
        params = glb._connection_params({'table': ' widgets '})
        assert params['host'] == 'localhost'
        assert params['user'] == 'rruser'
        assert params['password'] == 'rrpass'
        assert params['database'] == 'rrtenant'
        assert params['table'] == 'widgets'

    def test_build_connection_url_uses_cached_dsn(self, monkeypatch):
        cls, _ = _sql_iglobal_cls(monkeypatch)
        self._deliver_org_dsn(monkeypatch)
        glb = cls()
        params = glb._connection_params({})
        url = glb._build_connection_url(params)
        assert url == 'postgresql+psycopg2://rruser:rrpass@localhost:55432/rrtenant'

    def test_no_connection_fields_read_from_config(self, monkeypatch):
        """host/user/password in config must be ignored — the DSN wins."""
        cls, _ = _sql_iglobal_cls(monkeypatch)
        self._deliver_org_dsn(monkeypatch)
        glb = cls()
        params = glb._connection_params({'host': 'evil', 'user': 'evil', 'password': 'evil'})
        assert params['host'] == 'localhost'
        assert params['user'] == 'rruser'
        url = glb._build_connection_url(params)
        assert 'evil' not in url

    def test_connection_params_read_the_nodes_scope(self, monkeypatch):
        """A team-scoped node gets the team entry of the map, not the org's."""
        cls, _ = _sql_iglobal_cls(monkeypatch)
        team_dsn = 'postgresql://team_rw:pw@pooler:5432/t_team'
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN, 'team': team_dsn}))
        glb = cls()
        params = glb._connection_params({'scope': 'team', 'table': 'widgets'})
        assert params['database'] == 't_team'
        assert glb._build_connection_url(params) == 'postgresql+psycopg2://team_rw:pw@pooler:5432/t_team'

    def test_save_time_probe_outside_a_task_is_silent(self, monkeypatch):
        """No DSN in the server process: static checks only, no warning (any
        warning keeps the node config panel open), no connection attempt.
        """
        cls, rrdb_mod = _sql_iglobal_cls(monkeypatch)
        monkeypatch.delenv('ROCKETRIDE_DB_DSNS', raising=False)
        monkeypatch.delenv('ROCKETRIDE_DB_RESOLVE_ERROR', raising=False)
        warnings = []
        iglobal_mod = sys.modules['nodes.rocketride_sql.IGlobal']
        monkeypatch.setattr(iglobal_mod, 'warning', warnings.append)
        monkeypatch.setattr(iglobal_mod.DatabaseGlobalBase, 'validateConfig', lambda self: warnings.append('probed'))
        glb = cls()
        glb.glb = types.SimpleNamespace(logicalType='rocketride_sql', connConfig={'scope': 'team'})
        glb.validateConfig()
        assert warnings == []

    def test_save_time_probe_reports_a_bad_scope(self, monkeypatch):
        cls, _ = _sql_iglobal_cls(monkeypatch)
        warnings = []
        iglobal_mod = sys.modules['nodes.rocketride_sql.IGlobal']
        monkeypatch.setattr(iglobal_mod, 'warning', warnings.append)
        monkeypatch.setattr(iglobal_mod.Config, 'getNodeConfig', lambda provider, cfg: dict(cfg))
        glb = cls()
        glb.glb = types.SimpleNamespace(logicalType='rocketride_sql', connConfig={'scope': 'everyone'})
        glb.validateConfig()
        assert len(warnings) == 1 and 'scope must be one of org, team, user' in warnings[0]


def _engine_pool_kwargs(monkeypatch, cls, logical_type, conn_config):
    """Run ``beginGlobal`` with ``create_engine`` patched; return its kwargs.

    Nothing connects: the engine, the transaction registry and both schema
    reflections are stand-ins, so only the pool sizing reaches the assertion.
    """
    db_global = sys.modules['ai.common.database.db_global_base']
    calls = []
    monkeypatch.setattr(db_global, 'create_engine', lambda url, **kw: calls.append(kw) or types.SimpleNamespace())
    tx_registry = types.ModuleType('ai.common.database.tx_registry')
    tx_registry.TransactionRegistry = lambda *a, **kw: None
    monkeypatch.setitem(sys.modules, 'ai.common.database.tx_registry', tx_registry)
    monkeypatch.setattr(sys.modules['ai.common.config'].Config, 'getNodeConfig', lambda provider, cfg: dict(cfg))
    monkeypatch.setattr(cls, '_getDatabaseSchema', lambda self: {})
    monkeypatch.setattr(cls, '_getTableSchema', lambda self, table: {})
    glb = cls()
    glb.glb = types.SimpleNamespace(logicalType=logical_type, connConfig=conn_config)
    glb.beginGlobal()
    assert len(calls) == 1
    return calls[0]


class TestSqlEnginePoolSize:
    """PgBouncer pools the cloud node's connections, so its engine stays small;
    every other SQL node keeps the base's larger pool.
    """

    def test_rocketride_sql_keeps_a_two_plus_two_pool(self, monkeypatch):
        cls, _ = _sql_iglobal_cls(monkeypatch)
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))
        kwargs = _engine_pool_kwargs(monkeypatch, cls, 'rocketride_sql', {'table': 'widgets'})
        assert kwargs['pool_size'] == 2
        assert kwargs['max_overflow'] == 2

    @pytest.mark.parametrize('node', ['db_postgres', 'db_mysql'])
    def test_other_sql_nodes_keep_the_default_pool(self, monkeypatch, node):
        _sql_iglobal_cls(monkeypatch)
        node_dir = _REPO / 'nodes' / 'src' / 'nodes' / node
        cls = _load_from_path(f'nodes.{node}.IGlobal', node_dir / 'IGlobal.py').IGlobal
        config = {'host': 'h', 'user': 'u', 'password': 'p', 'database': 'd', 'table': 'widgets'}
        kwargs = _engine_pool_kwargs(monkeypatch, cls, node, config)
        assert kwargs['pool_size'] == 10
        assert kwargs['max_overflow'] == 20


# ---------------------------------------------------------------------------
# rocketride_vector: the shared pgvector driver over the psycopg2 test double
#
# The real node Store and the real ai.common.store.pgvector driver run against
# nodes/test/mocks/psycopg2 (an in-memory database that understands the
# driver's statements). Every behaviour checked here is also checked live in
# test_rocketride_db_full.py / test_store_postgres_full.py.
# ---------------------------------------------------------------------------

_MOCK_PSYCOPG2 = _REPO / 'nodes' / 'test' / 'mocks' / 'psycopg2'
_SWAPPED_MODULES = (
    'psycopg2',
    'psycopg2.sql',
    'psycopg2.extensions',
    'depends',
    'ai.common.store.pgvector',
    'ai.common.store.pgvector.sql',
    'ai.common.store.pgvector.pool',
    'ai.common.store.pgvector.driver',
    'nodes.rocketride_vector',
    'nodes.rocketride_vector.IEndpoint',
    'nodes.rocketride_vector.IGlobal',
    'nodes.rocketride_vector.IInstance',
    'nodes.rocketride_vector.rocketride_vector',
    'nodes.store_postgres',
    'nodes.store_postgres.IEndpoint',
    'nodes.store_postgres.IGlobal',
    'nodes.store_postgres.IInstance',
    'nodes.store_postgres.postgres',
)


@pytest.fixture()
def mock_rv(monkeypatch):
    """The real rocketride_vector Store, with psycopg2 replaced by the test double; sys.modules restored afterwards."""
    import importlib

    saved = {name: sys.modules.get(name) for name in _SWAPPED_MODULES}
    import ai.common.store as store_pkg

    saved_attr = store_pkg.__dict__.get('pgvector')
    for name in _SWAPPED_MODULES:
        sys.modules.pop(name, None)
    try:
        import depends as real_depends  # noqa: F401 - reloaded below as a stand-in

        depends_mod = types.ModuleType('depends')
        depends_mod.__dict__.update(saved['depends'].__dict__ if saved['depends'] else {})
        depends_mod.depends = lambda *a, **kw: None
        sys.modules['depends'] = depends_mod
        spec = importlib.util.spec_from_file_location(
            'psycopg2', _MOCK_PSYCOPG2 / '__init__.py', submodule_search_locations=[str(_MOCK_PSYCOPG2)]
        )
        psycopg2_mock = importlib.util.module_from_spec(spec)
        sys.modules['psycopg2'] = psycopg2_mock
        spec.loader.exec_module(psycopg2_mock)
        psycopg2_mock.MockConnection.reset()

        from ai.common.config import Config

        monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, connConfig: dict(connConfig)))
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))
        monkeypatch.delenv('ROCKETRIDE_DB_RESOLVE_ERROR', raising=False)
        store_mod = importlib.import_module('nodes.rocketride_vector.rocketride_vector')
        driver = importlib.import_module('ai.common.store.pgvector.driver')
        warnings: list[str] = []
        monkeypatch.setattr(driver, 'warning', warnings.append)
        yield types.SimpleNamespace(
            Store=store_mod.Store, db=psycopg2_mock.MockConnection, psycopg2=psycopg2_mock, warnings=warnings
        )
    finally:
        for name in _SWAPPED_MODULES:
            sys.modules.pop(name, None)
            if saved[name] is not None:
                sys.modules[name] = saved[name]
        if saved_attr is not None:
            store_pkg.pgvector = saved_attr
        else:
            store_pkg.__dict__.pop('pgvector', None)


def _make_store(env, config):
    return env.Store('rocketride_vector', config, {})


def _statements(env, tag=None):
    """Every statement the driver sent, optionally only those named ``tag``."""
    out = []
    for conn in env.db.opened:
        for text, _params in conn.executed:
            if tag is None or text.startswith(f'/* rr-pgvector:{tag} */'):
                out.append(text)
    return out


def _doc(object_id, chunk_id, embedding, content=None):
    from ai.common.schema import Doc, DocMetadata

    return Doc(
        page_content=content if content is not None else f'{object_id}/{chunk_id}',
        metadata=DocMetadata(objectId=object_id, chunkId=chunk_id, isDeleted=False, signature='sig', size=7),
        embedding=list(embedding),
        embedding_model='m',
    )


class TestRocketrideVectorStore:
    def test_store_connects_to_its_scopes_database(self, mock_rv, monkeypatch):
        user_dsn = 'postgresql://u_rw:pw@pooler:5432/t_user_u1'
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN, 'user:u-1': user_dsn}))
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine', 'scope': 'user', 'target': 'u-1'})
        assert store.database == 't_user_u1'

    def test_store_refuses_a_scope_the_task_was_not_given(self, mock_rv):
        with pytest.raises(ValueError, match="was not given the team database 't-9'"):
            _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine', 'scope': 'team', 'target': 't-9'})

    def test_save_time_probe_outside_a_task_is_silent(self, mock_rv, monkeypatch):
        monkeypatch.delenv('ROCKETRIDE_DB_DSNS', raising=False)
        iglobal_mod = sys.modules['nodes.rocketride_vector.IGlobal']
        warnings = []
        monkeypatch.setattr(iglobal_mod, 'warning', warnings.append)
        glb = iglobal_mod.IGlobal()
        glb.glb = types.SimpleNamespace(
            logicalType='rocketride_vector', connConfig={'collection': 'rr_vec', 'scope': 'team'}
        )
        glb._probe_connection(glb.glb.connConfig)
        assert warnings == [] and mock_rv.db.opened == []

    def test_save_time_probe_still_checks_the_scope(self, mock_rv, monkeypatch):
        monkeypatch.delenv('ROCKETRIDE_DB_DSNS', raising=False)
        iglobal_mod = sys.modules['nodes.rocketride_vector.IGlobal']
        warnings = []
        monkeypatch.setattr(iglobal_mod, 'warning', warnings.append)
        glb = iglobal_mod.IGlobal()
        glb.glb = types.SimpleNamespace(
            logicalType='rocketride_vector', connConfig={'collection': 'rr_vec', 'scope': 'org', 'target': 't-1'}
        )
        glb._probe_connection(glb.glb.connConfig)
        assert len(warnings) == 1 and 'the org scope takes no target' in warnings[0]

    def test_connects_via_resolved_dsn(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        # No client_id on the store: identity rides the task file (#1686);
        # tenant scoping keys on the DSN's database (see IGlobal's subKey).
        assert store.host == 'localhost'
        assert store.port == 55432
        assert store.database == 'rrtenant'
        conn = mock_rv.db.opened[0]
        assert conn.dsn == TEST_DSN and conn.application_name == 'rocketride-pgvector'

    def test_invalid_collection_rejected(self, mock_rv):
        with pytest.raises(ValueError, match='Invalid collection name'):
            _make_store(mock_rv, {'collection': 'bad-name;drop', 'similarity': 'cosine'})

    @pytest.mark.parametrize(
        ('similarity', 'opclass'),
        [
            ('cosine', 'vector_cosine_ops'),
            ('l2', 'vector_l2_ops'),
            ('inner_product', 'vector_ip_ops'),
        ],
    )
    def test_hnsw_index_opclass_follows_similarity(self, mock_rv, similarity, opclass):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': similarity})
        store._createCollection(vectorSize=5)
        assert any(
            sql.startswith('/* rr-pgvector:create_table */ CREATE TABLE IF NOT EXISTS "rr_vec"')
            for sql in _statements(mock_rv)
        )
        index_sql = _statements(mock_rv, 'create_hnsw_index')
        assert len(index_sql) == 1
        assert f'USING hnsw ("embedding" {opclass})' in index_sql[0]
        assert '"rr_vec_embedding_hnsw"' in index_sql[0]
        assert 'm = 16' in index_sql[0]
        assert 'ef_construction = 64' in index_sql[0]

    @pytest.mark.parametrize(
        ('similarity', 'metric'),
        [('cosine', 'cosine'), ('l2', 'l2'), ('inner_product', 'ip')],
    )
    def test_the_explorer_tools_read_the_table_metric(self, mock_rv, similarity, metric):
        """stats, sample, project and neighbors compute with the table's metric, not the SQL operator."""
        from ai.common.store import VectorStoreToolMixin
        from ai.common.store.vx_math import normalize_metric

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': similarity})
        store.addChunks([_doc('doc', 0, [1, 0, 0, 0, 0])])
        assert normalize_metric(store.similarity) == metric
        assert store.describe().metric == metric
        node = VectorStoreToolMixin()
        node.IGlobal = types.SimpleNamespace(store=store)
        assert node.stats({'mode': 'full'})['metric'] == metric

    def test_hnsw_params_overridable(self, mock_rv):
        store = _make_store(
            mock_rv,
            {'collection': 'rr_vec', 'similarity': 'cosine', 'hnsw_m': 32, 'hnsw_ef_construction': 128},
        )
        store._createCollection(vectorSize=5)
        index_sql = _statements(mock_rv, 'create_hnsw_index')
        assert 'm = 32' in index_sql[0]
        assert 'ef_construction = 128' in index_sql[0]

    def test_render_orders_chunks_and_bridges_gaps(self, mock_rv):
        """Chunks at 0, 1 and 3 (gap at 2): index order preserved, gap skipped."""
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('obj-1', 0, [1, 0, 0, 0, 0], 'A')])
        store.addChunks([_doc('obj-1', 3, [1, 0, 0, 0, 0], 'D'), _doc('obj-1', 1, [1, 0, 0, 0, 0], 'B')])
        out: list[str] = []
        store.render('obj-1', out.append)
        assert ''.join(out) == 'ABD'

    def test_render_empty_batch_emits_nothing(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('obj-2', 0, [1, 0, 0, 0, 0], 'A')])
        out: list[str] = []
        store.render('obj-1', out.append)
        assert out == []

    def test_render_single_high_chunk_id(self, mock_rv):
        """One row with a high chunkId renders that row — allocation is bounded
        by rows fetched, never by the chunkId value.
        """
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('obj-0', 0, [1, 0, 0, 0, 0], 'seed')])
        store.addChunks([_doc('obj-1', 999_999, [1, 0, 0, 0, 0], 'X')])
        out: list[str] = []
        store.render('obj-1', out.append)
        assert out == ['X']

    def test_hnsw_params_clamped_to_pgvector_bounds(self, mock_rv):
        store = _make_store(
            mock_rv,
            {'collection': 'rr_vec', 'similarity': 'cosine', 'hnsw_m': 1, 'hnsw_ef_construction': 1},
        )
        # pgvector requires m >= 2, ef_construction >= 4 and >= 2 * m.
        assert store.hnsw_m == 2
        assert store.hnsw_ef_construction == 4

    def test_hnsw_ef_construction_raised_to_twice_m(self, mock_rv):
        store = _make_store(
            mock_rv,
            {'collection': 'rr_vec', 'similarity': 'cosine', 'hnsw_m': 64, 'hnsw_ef_construction': 64},
        )
        assert store.hnsw_ef_construction == 128

    def test_long_table_names_get_distinct_index_names(self, mock_rv):
        for length in (61, 62, 63):
            name = ('t' * 70)[:length]
            store = _make_store(mock_rv, {'collection': name, 'similarity': 'cosine'})
            store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0])])
            indexes = set(mock_rv.db.table(name).indexes)
            assert len(indexes) == 2 and name not in indexes and all(len(n) <= 63 for n in indexes)

    def test_hnsw_skipped_above_dimension_ceiling(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store._createCollection(vectorSize=2001)
        assert _statements(mock_rv, 'create_table')
        assert not _statements(mock_rv, 'create_hnsw_index')
        assert any('2000' in w and 'Skipping index' in w for w in mock_rv.warnings)

    def test_hnsw_created_at_dimension_ceiling(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store._createCollection(vectorSize=2000)
        assert _statements(mock_rv, 'create_hnsw_index')
        assert not mock_rv.warnings


class TestPgVectorTransactions:
    """Transaction hygiene of the shared driver (live twins: test_store_postgres_full.py TestConnections)."""

    def test_reads_are_read_only_bounded_and_end_their_transaction(self, mock_rv):
        from ai.common.schema import DocFilter, QuestionText

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0])])
        query = QuestionText(text='q')
        query.embedding = [1, 0, 0, 0, 0]
        assert [d.metadata.objectId for d in store.searchSemantic(query, DocFilter(limit=3))] == ['a']
        begins = _statements(mock_rv, 'begin_read')
        assert len(begins) > 1
        assert all('SET TRANSACTION READ ONLY' in b and "statement_timeout = '30000ms'" in b for b in begins)
        # The open probe reads the pgvector version; every read after it sets the iterative scan.
        assert 'hnsw.iterative_scan' not in begins[0]
        assert all('hnsw.iterative_scan = relaxed_order' in b for b in begins[1:])
        assert all(b.startswith("/* rr-pgvector:begin_read */ SELECT '[0]'::vector;") for b in begins)
        # Nothing is ever set for the session (a transaction-mode pooler would leak it).
        every = _statements(mock_rv)
        assert not [s for s in every if re.search(r'(^|; )SET (?!LOCAL|TRANSACTION)', s.split('*/', 1)[-1].strip())]
        assert all(conn.get_transaction_status() == 0 for conn in mock_rv.db.opened)

    def test_iterative_scan_left_out_before_pgvector_0_8(self, mock_rv):
        mock_rv.db.extension_version = '0.7.4'
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.countChunks(None)
        assert not any('hnsw.iterative_scan' in b for b in _statements(mock_rv, 'begin_read'))
        # Without the iterative scan a filtered search may return fewer than k rows: say so.
        assert 'filtered_search_may_underfill' in store.describe().caveats
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0])])
        assert 'filtered_search_may_underfill' in store.describe().caveats

    def test_no_underfill_caveat_from_pgvector_0_8(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0])])
        assert 'filtered_search_may_underfill' not in store.describe().caveats

    def test_failed_statement_does_not_poison_the_next_call(self, mock_rv):
        from ai.common.schema import DocFilter

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0])])
        mock_rv.db.fail_next['count_chunks'] = mock_rv.psycopg2.ProgrammingError('boom', '42000')
        with pytest.raises(Exception, match='boom'):
            store.countChunks(DocFilter())
        assert store.countChunks(DocFilter()) == 1
        assert all(conn.get_transaction_status() == 0 for conn in mock_rv.db.opened)

    def test_failed_write_rolls_back_the_whole_batch(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0]), _doc('a', 1, [1, 0, 0, 0, 0])])
        mock_rv.db.fail_next['insert'] = mock_rv.psycopg2.OperationalError('insert failed', '53100')
        with pytest.raises(Exception):
            store.addChunks([_doc('a', 0, [0, 1, 0, 0, 0], 'new')])
        rows = sorted((r['objectid'], r['chunkid']) for r in mock_rv.db.table('rr_vec').rows.values())
        assert rows == [('a', 0), ('a', 1), ('schema', 0)]  # the delete of the failed batch was undone

    def test_connection_slots_are_handed_out_first_come_first_served(self, mock_rv):
        """A released slot goes to the longest waiter, never back to a caller that arrives later."""
        import threading
        import time

        from ai.common.store.pgvector.pool import FairGate

        gate = FairGate(1)
        assert gate.acquire(1.0)
        order: list[str] = []

        def waiter(name):
            assert gate.acquire(5.0)
            order.append(name)
            time.sleep(0.05)
            gate.release()

        first = threading.Thread(target=waiter, args=('first',))
        first.start()
        time.sleep(0.1)
        second = threading.Thread(target=waiter, args=('second',))
        second.start()
        time.sleep(0.1)
        gate.release()
        # A caller arriving right after the release must queue behind both waiters.
        assert gate.acquire(5.0)
        order.append('late')
        gate.release()
        first.join(5)
        second.join(5)
        assert order == ['first', 'second', 'late']
        assert gate.acquire(0.01)
        assert not gate.acquire(0.05)  # the only slot is taken: a bounded wait gives up

    def test_seeded_samples_set_nothing_for_the_session(self, mock_rv):
        from ai.common.schema import DocFilter

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        for i in range(6):
            store.addChunks([_doc(f'd{i}', c, [1, 0, 0, 0, c]) for c in range(4)])

        def keys(seed, strategy):
            docs, _ = store.sampleChunks(n=9, seed=seed, strategy=strategy, docFilter=DocFilter(), include_keys=[])
            return [(d.metadata.objectId, d.metadata.chunkId) for d in docs]

        for strategy in ('random', 'stratified'):
            assert keys(3, strategy) == keys(3, strategy)
            assert any(keys(seed, strategy) != keys(3, strategy) for seed in (4, 5, 6))
        assert len({oid for oid, _cid in keys(3, 'stratified')}) == 6
        samples = _statements(mock_rv, 'sample_random') + _statements(mock_rv, 'sample_stratified')
        assert samples and all('hashtextextended("id"::text, %s)' in text for text in samples)
        assert not [text for text in _statements(mock_rv) if 'setseed' in text or 'random()' in text]

    def test_mark_deleted_and_active_return_the_chunks_they_moved(self, mock_rv):
        """One UPDATE over the rows in the other state; its row count is soft_delete's matched_chunks."""
        from ai.common.schema import DocFilter

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', c, [1, 0, 0, 0, c]) for c in range(3)] + [_doc('b', 0, [0, 1, 0, 0, 0])])
        assert store.markDeleted(['a', 'ghost']) == 3
        assert store.markDeleted(['a']) == 0, 'already in the trash: nothing moves'
        assert store.markActive(['a', 'b']) == 3, 'b was never in the trash'
        assert store.markActive(['a']) == 0
        assert store.markDeleted([]) == 0
        assert store.countChunks(DocFilter()) == 4
        for row in mock_rv.db.table('rr_vec').rows.values():
            if row['objectid'] == 'b':
                row['isdeleted'] = None  # NULL reads as active: restoring it moves nothing
        assert store.markActive(['b']) == 0
        assert store.markDeleted(['b']) == 1

    def test_rows_with_a_null_deleted_flag_read_as_active(self, mock_rv):
        from ai.common.schema import DocFilter

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0]), _doc('a', 1, [1, 0, 0, 0, 0])])
        for row in mock_rv.db.table('rr_vec').rows.values():
            if row['objectid'] == 'a':
                row['isdeleted'] = None  # a row written by hand or by another client
        assert store.countChunks(DocFilter()) == 2
        assert store.countDocumentsWhere(DocFilter()) == 1
        listed = store.listDocumentPage(cursor=None, limit=5, object_ids=None, deleted='active', sort='path')
        assert [(r.objectId, r.chunks, r.deleted) for r in listed.items] == [('a', 2, False)]
        assert all(d.metadata.isDeleted is False for d in store.get(DocFilter(objectIds=['a'])))

    def test_document_pages_aggregate_only_their_own_documents(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        for i in range(5):
            store.addChunks([_doc(f'd{i}', c, [1, 0, 0, 0, c]) for c in range(2)])
        cursor, seen, totals = None, [], []
        while True:
            page = store.listDocumentPage(cursor=cursor, limit=2, object_ids=None, deleted='active', sort='path')
            seen += [r.objectId for r in page.items]
            totals.append(page.total)
            cursor = page.next_cursor
            if cursor is None:
                break
        assert seen == [f'd{i}' for i in range(5)] and totals == [5, 5, 5]
        assert not _statements(mock_rv, 'count_documents')
        details = _statements(mock_rv, 'list_documents')
        assert len(details) == 3 and all('"objectid" = ANY(%s)' in text for text in details)
        assert all('HAVING' not in text and 'LIMIT' not in text for text in details)

    def test_unreachable_server_error_names_no_host(self, mock_rv):
        from ai.common.store.errors import StoreError

        mock_rv.db.fail_next['connect'] = mock_rv.psycopg2.OperationalError(
            'connection to server at "10.1.2.3", port 6432 failed: password authentication failed for user "rruser"'
        )
        with pytest.raises(StoreError) as err:
            _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        assert '10.1.2.3' not in str(err.value) and 'rruser' not in str(err.value)

    def test_meta_column_falls_back_while_the_table_is_locked(self, mock_rv):
        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('a', 0, [1, 0, 0, 0, 0])])
        table = mock_rv.db.table('rr_vec')
        table.columns = [c for c in table.columns if c[0] != 'meta']  # a table without the column
        for row in table.rows.values():
            row.pop('meta', None)
        mock_rv.db.locked_tables.add('rr_vec')
        reopened = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        reopened.addChunks([_doc('b', 0, [1, 0, 0, 0, 0])])
        info = reopened.describe()
        assert info.meta_column is False and 'extras_not_stored' in info.caveats
        mock_rv.db.locked_tables.clear()
        reopened.META_RETRY_S = 0.0
        reopened.addChunks([_doc('c', 0, [1, 0, 0, 0, 0])])
        assert reopened.describe().meta_column is True
        assert 'meta' in [name for name, _type in mock_rv.db.table('rr_vec').columns]
        rows = {r['objectid']: r for r in mock_rv.db.table('rr_vec').rows.values()}
        assert rows['c']['meta'] == {'size': 7} and 'meta' not in rows['b']


class TestPgVectorSearchRecovery:
    """The filtered-search recovery of the shared driver (#2955; live twin: test_pgvector_search.py).

    HNSW filters its candidate list after scanning it, so excluded neighbours (a trashed document's
    chunks, other paths) can hide eligible matches. The driver recovers an underfilled answer with
    the exact search, in the same read transaction, where an approximate index could have hidden them.
    """

    @staticmethod
    def _store(env, version='0.8.0', **config):
        env.db.extension_version = version
        store = _make_store(env, {'collection': 'rr_vec', 'similarity': 'cosine', 'score': 0.5, **config})
        store.addChunks([_doc('recovered', 0, [1, 0, 0, 0, 0])])  # creates the table and its HNSW index
        return store

    @staticmethod
    def _question():
        from ai.common.schema import QuestionText

        question = QuestionText(text='q')
        question.embedding = [1, 0, 0, 0, 0]
        return question

    @staticmethod
    def _scan_with(store, monkeypatch, weak_score, weak_rows=5):
        """Make the approximate scan answer ``weak_rows`` candidates of ``weak_score``; the exact one is real."""
        from ai.common.schema import DocFilter

        calls = []
        real = store._search_semantic_in

        def scan(cur, embedding, doc_filter, *, exact=False):
            calls.append('exact' if exact else 'ann')
            rows = real(cur, embedding, doc_filter, exact=exact)
            if exact or not weak_rows:
                return rows if exact else []
            template = real(cur, embedding, DocFilter(limit=1), exact=True)[0]
            return [dict(template, objectid=f'weak-{i}', distance=1 - weak_score) for i in range(weak_rows)]

        monkeypatch.setattr(store, '_search_semantic_in', scan)
        return calls

    @pytest.mark.parametrize('version', ['0.7.4', '0.8.0'])
    @pytest.mark.parametrize('weak_score', [0.1, 0.3])
    def test_a_full_batch_of_weak_candidates_does_not_hide_a_strong_match(
        self, mock_rv, monkeypatch, version, weak_score
    ):
        """Candidates under the 0.20 floor or the node's threshold do not count: the exact retry finds the match."""
        from ai.common.schema import DocFilter

        store = self._store(mock_rv, version)
        calls = self._scan_with(store, monkeypatch, weak_score)

        docs = store.searchSemantic(self._question(), DocFilter(limit=5))

        assert [d.metadata.objectId for d in docs] == ['recovered']
        assert abs(docs[0].score - 1.0) < 1e-9
        assert calls[:2] == ['ann', 'exact']

    @pytest.mark.parametrize('version, retried', [('0.7.4', True), ('0.8.0', False)])
    def test_an_underfilled_nonempty_answer_is_recovered_only_before_the_iterative_scan(
        self, mock_rv, monkeypatch, version, retried
    ):
        """On pgvector 0.8 a nonempty answer stays approximate: fewer than limit alone costs no full scan."""
        from ai.common.schema import DocFilter

        store = self._store(mock_rv, version)
        calls = []
        real = store._search_semantic_in

        def scan(cur, embedding, doc_filter, *, exact=False):
            calls.append('exact' if exact else 'ann')
            return real(cur, embedding, doc_filter, exact=exact)

        monkeypatch.setattr(store, '_search_semantic_in', scan)

        docs = store.searchSemantic(self._question(), DocFilter(limit=5))

        assert [d.metadata.objectId for d in docs] == ['recovered']
        assert calls == (['ann', 'exact'] if retried else ['ann'])

    def test_an_empty_answer_is_confirmed_exactly_where_an_approximate_index_exists(self, mock_rv, monkeypatch):
        from ai.common.schema import DocFilter

        store = self._store(mock_rv)
        calls = self._scan_with(store, monkeypatch, weak_score=0.1, weak_rows=0)

        assert store.searchSemantic(self._question(), DocFilter(limit=5, parent='/missing')) == []
        assert calls[:2] == ['ann', 'exact']

    def test_a_table_without_an_approximate_index_is_never_scanned_twice(self, mock_rv, monkeypatch):
        from ai.common.schema import DocFilter

        store = self._store(mock_rv)
        mock_rv.db.table('rr_vec').indexes.clear()
        calls = self._scan_with(store, monkeypatch, weak_score=0.1, weak_rows=0)

        assert store.searchSemantic(self._question(), DocFilter(limit=5, parent='/missing')) == []
        assert calls == ['ann']

    def test_an_unbounded_search_runs_the_exact_statement_at_once(self, mock_rv):
        from ai.common.schema import DocFilter

        store = self._store(mock_rv)
        store.addChunks([_doc('b', 0, [0.5, 0.5, 0, 0, 0])])

        docs = store.searchSemantic(self._question(), DocFilter(limit=None))

        assert [d.metadata.objectId for d in docs] == ['recovered', 'b']
        assert len(_statements(mock_rv, 'semantic_exact')) == 1
        assert _statements(mock_rv, 'semantic') == []

    def test_the_exact_statement_leaves_out_undefined_distances(self, mock_rv):
        """A zero vector has no cosine distance: the exact search must not return it as a match."""
        from ai.common.schema import DocFilter

        store = self._store(mock_rv)
        store.addChunks([_doc('zero', 0, [0, 0, 0, 0, 0])])

        docs = store.searchSemantic(self._question(), DocFilter(limit=None))

        assert [d.metadata.objectId for d in docs] == ['recovered']


@pytest.mark.parametrize('method', ['markDeleted', 'markActive'])
@pytest.mark.parametrize('rowcount, moved', [(3, 3), (0, 0), (-1, None)])
def test_the_trash_reports_the_rows_it_moved_and_none_when_the_count_is_unknown(
    mock_rv, monkeypatch, method, rowcount, moved
):
    """The UPDATE's row count is the chunks moved; psycopg2's -1 (not known) is None, never a claimed 0."""
    store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
    store.addChunks([_doc('a', i, [1, 0, 0, 0, 0]) for i in range(3)])
    if method == 'markActive':
        store.markDeleted(['a'])
    original = mock_rv.psycopg2.MockCursor._op_set_deleted

    def count_as(self, body, params, tag):
        original(self, body, params, tag)
        self.rowcount = rowcount

    monkeypatch.setattr(mock_rv.psycopg2.MockCursor, '_op_set_deleted', count_as)

    assert getattr(store, method)(['a']) == moved


def test_getpaths_pages_distinct_paths_whatever_the_chunk_ids(mock_rv):
    """One row per distinct path (its lowest object id); a document counts whatever chunk ids it has."""
    from ai.common.schema import Doc, DocMetadata

    store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})

    def doc(object_id, chunk_id, parent):
        return Doc(
            page_content='x',
            metadata=DocMetadata(objectId=object_id, chunkId=chunk_id, parent=parent, isDeleted=False),
            embedding=[1, 0, 0, 0, 0],
            embedding_model='m',
        )

    store.addChunks([doc('b', 0, '/same'), doc('a', 0, '/same'), doc('c', 2, '/other'), doc('d', 0, '/z')])
    assert store.getPaths() == {'/other': 'c', '/same': 'a', '/z': 'd'}
    assert store.getPaths(offset=1, limit=1) == {'/same': 'a'}
    store.markDeleted(['c'])
    assert store.getPaths() == {'/same': 'a', '/z': 'd'}


class TestPgVectorSupportLevel:
    """Both pgvector providers report support 'supported' (vector-tool-contract.md §3).

    The level is set from the unmocked evidence, never from this file: the live suites
    test_store_postgres_full.py and test_rocketride_db_full.py (direct DSN and
    RR_TEST_PGVECTOR_POOLER_DSN) and test_vector_toolpath_full.py (postgres.pipe and
    rocketride_vector.pipe on a new and a legacy table, and through the pooler). These
    pins only keep the constant and the dialect answer from drifting.
    """

    def test_the_shared_driver_and_both_node_stores_are_supported(self, mock_rv):
        import importlib

        driver = importlib.import_module('ai.common.store.pgvector.driver')
        postgres = importlib.import_module('nodes.store_postgres.postgres')
        assert driver.PgVectorStore.VX_SUPPORT == 'supported'
        assert mock_rv.Store.VX_SUPPORT == 'supported'
        assert postgres.Store.VX_SUPPORT == 'supported'

    def test_dialect_reports_supported_without_the_experimental_caveat(self, mock_rv):
        from ai.common.store import VectorStoreToolMixin

        store = _make_store(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine'})
        store.addChunks([_doc('doc', 0, [1, 0, 0, 0, 0])])
        node = VectorStoreToolMixin()
        node.IGlobal = types.SimpleNamespace(store=store)
        answer = node.dialect({})
        assert answer['success'] is True
        assert answer['support'] == 'supported'
        assert 'experimental' not in answer['caveats']


class TestRocketrideVectorWriteGate:
    """The node's tool writes, behind both gates (live twins: test_rocketride_db_full.py TestRocketrideVectorNode).

    The outer gate is the node's expose_tools and allow_write switches (both off
    by default); past it, every write runs the store write gate
    (vx_write_gate.check_write), whose one switch, allow_writes, governs DAP
    callers. Agents have no switch of their own: allow_write alone decides theirs.
    """

    # The two outer switches on: what a pipeline that lets tools write sets.
    _OPEN = {'expose_tools': True, 'allow_write': True}

    @staticmethod
    def _node(env, config):
        import importlib

        from rocketlib import OPEN_MODE

        IGlobal = importlib.import_module('nodes.rocketride_vector.IGlobal').IGlobal
        IInstance = importlib.import_module('nodes.rocketride_vector.IInstance').IInstance
        glb = IGlobal()
        glb.IEndpoint = types.SimpleNamespace(
            endpoint=types.SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}, parameters={})
        )
        glb.glb = types.SimpleNamespace(logicalType='rocketride_vector', connConfig=config)
        glb.beginGlobal()
        inst = IInstance()
        inst.IGlobal = glb
        glb.store.addChunks([_doc('doc', 0, [1, 0, 0, 0, 0])])
        return glb, inst

    @staticmethod
    def _rows(env):
        return sorted(r['objectid'] for r in env.db.table('rr_vec').rows.values())

    def test_tools_are_hidden_and_refused_with_the_shipped_switches(self, mock_rv):
        """Neither outer switch set: no tool is offered, and a direct call is refused before the store."""
        from ai.common.tool_context import ToolCallContext, tool_call

        glb, inst = self._node(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine', 'allow_writes': True})
        assert glb.expose_tools is False and glb.allow_write is False
        assert inst._collect_tool_methods() == {}
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        with tool_call(ctx):
            answer = inst.delete({'object_ids': ['doc']})
        assert answer['success'] is False and 'expose_tools=true' in answer['error']
        assert self._rows(mock_rv) == ['doc', 'schema']
        glb.endGlobal()

    def test_write_tools_are_hidden_and_refused_until_allow_write(self, mock_rv):
        from ai.common.tool_context import ToolCallContext, tool_call

        config = {'collection': 'rr_vec', 'similarity': 'cosine', 'expose_tools': True, 'allow_writes': True}
        glb, inst = self._node(mock_rv, config)
        offered = set(inst._collect_tool_methods())
        assert {'search', 'objdir', 'get', 'stats', 'dialect', 'list_documents'} <= offered
        assert offered.isdisjoint({'upsert', 'delete', 'soft_delete', 'restore'})
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        with tool_call(ctx):
            answer = inst.delete({'object_ids': ['doc']})
        assert answer['success'] is False and 'allow_write=true' in answer['error']
        assert self._rows(mock_rv) == ['doc', 'schema']
        glb.endGlobal()

    def test_delete_without_a_call_context_is_refused(self, mock_rv):
        config = {'collection': 'rr_vec', 'similarity': 'cosine', 'allow_writes': True, **self._OPEN}
        glb, inst = self._node(mock_rv, config)
        answer = inst.delete({'object_ids': ['doc']})
        assert answer['success'] is False and answer['code'] == 'WRITES_UNKNOWN_CALLER'
        assert inst.delete({'object_ids': ['schema']})['code'] == 'RESERVED_ID'
        assert self._rows(mock_rv) == ['doc', 'schema']
        glb.endGlobal()

    def test_allow_writes_off_refuses_dap_calls_with_a_context(self, mock_rv):
        from ai.common.tool_context import ToolCallContext, tool_call

        config = {'collection': 'rr_vec', 'similarity': 'cosine', **self._OPEN, 'allow_writes': False}
        glb, inst = self._node(mock_rv, config)
        ctx = ToolCallContext(origin='dap', source_type='tools', targeted=True, caller={'auth': 'account'})
        upsert = {
            'documents': [{'content': 'x', 'object_id': 'new', 'embedding': [0, 1, 0, 0, 0], 'embedding_model': 'm'}]
        }
        with tool_call(ctx):
            assert inst.delete({'object_ids': ['doc']})['code'] == 'WRITES_DISABLED'
            assert inst.upsert(upsert)['code'] == 'WRITES_DISABLED'
        assert self._rows(mock_rv) == ['doc', 'schema']
        glb.endGlobal()

    def test_an_agent_write_needs_only_allow_write(self, mock_rv):
        """allow_writes off and a stray agent_writes off in the config: an agent's upsert and delete still go through."""
        from ai.common.tool_context import ToolCallContext, tool_call

        config = {'collection': 'rr_vec', 'similarity': 'cosine', **self._OPEN, 'allow_writes': False}
        glb, inst = self._node(mock_rv, {**config, 'agent_writes': False})
        assert not hasattr(glb, 'agent_writes'), 'the node reads no agent switch'
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        upsert = {
            'documents': [{'content': 'x', 'object_id': 'new', 'embedding': [0, 1, 0, 0, 0], 'embedding_model': 'm'}]
        }
        with tool_call(ctx):
            stored = inst.upsert(upsert)
            removed = inst.delete({'object_ids': ['doc']})
        assert stored['success'] is True and removed['success'] is True, (stored, removed)
        assert self._rows(mock_rv) == ['new', 'schema']
        glb.endGlobal()

    def test_agent_call_with_allow_write_on_reaches_the_store(self, mock_rv):
        """allow_write is the one switch an agent needs: the write gate reads the bound context and lets it through."""
        from ai.common.tool_context import ToolCallContext, tool_call

        glb, inst = self._node(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine', **self._OPEN})
        ctx = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
        with tool_call(ctx):
            assert inst.delete({'object_ids': ['doc']})['success'] is True
        assert self._rows(mock_rv) == ['schema']
        glb.endGlobal()

    def test_dap_call_without_allow_writes_is_refused_and_keeps_the_rows(self, mock_rv):
        """A console (DAP) delete past the outer gate, allow_writes off: WRITES_DISABLED, nothing removed."""
        from ai.common.tool_context import ToolCallContext, tool_call

        glb, inst = self._node(mock_rv, {'collection': 'rr_vec', 'similarity': 'cosine', **self._OPEN})
        ctx = ToolCallContext(
            origin='dap', source_type='tools', targeted=True, caller={'auth': 'account', 'userId': 'u-1'}
        )
        with tool_call(ctx):
            answer = inst.delete({'object_ids': ['doc']})
        assert answer['success'] is False and answer['code'] == 'WRITES_DISABLED'
        assert self._rows(mock_rv) == ['doc', 'schema']
        glb.endGlobal()

    def test_dap_call_with_allow_writes_on_passes_both_gates(self, mock_rv):
        """With the outer switches and rrvector.allow_writes on, a Tools-source delete removes the document."""
        from ai.common.tool_context import ToolCallContext, tool_call

        config = {'collection': 'rr_vec', 'similarity': 'cosine', 'allow_writes': True, **self._OPEN}
        glb, inst = self._node(mock_rv, config)
        assert glb.allow_writes is True
        ctx = ToolCallContext(
            origin='dap', source_type='tools', targeted=True, caller={'auth': 'account', 'userId': 'u-1'}
        )
        with tool_call(ctx):
            answer = inst.delete({'object_ids': ['doc']})
        assert answer['success'] is True, answer
        assert self._rows(mock_rv) == ['schema']
        glb.endGlobal()


# ---------------------------------------------------------------------------
# psycopg2 doubles for the rocketride_graph connection tests below
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, executed, fetch_batches, rowcount=-1):
        self._executed = executed
        self._fetch_batches = fetch_batches
        # What psycopg2 reports after a statement; -1 when it does not know.
        self.rowcount = rowcount

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
        # The row count every cursor reports after its statement.
        self.rowcount = -1

    def cursor(self):
        return _FakeCursor(self.executed, self.fetch_batches, self.rowcount)

    def commit(self):
        self.commits += 1

    def close(self):
        pass


# ---------------------------------------------------------------------------
# rocketride_graph: scope-aware connection and the save-time probe
# ---------------------------------------------------------------------------

_GRAPH_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_graph'


class _GraphCursor(_FakeCursor):
    def fetchone(self):
        return ('1.5.0',)


class _GraphClient(_FakeClient):
    def cursor(self):
        return _GraphCursor(self.executed, self.fetch_batches)


def _graph_iglobal(monkeypatch):
    """Load rocketride_graph/IGlobal with its graph base and driver stubbed."""
    warnings: list[str] = []
    connects: list[str] = []

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.warning = warnings.append
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    psycopg2_mod = types.ModuleType('psycopg2')

    def connect(dsn, **kw):
        connects.append(dsn)
        return _GraphClient()

    psycopg2_mod.connect = connect
    psycopg2_mod.sql = types.ModuleType('psycopg2.sql')
    monkeypatch.setitem(sys.modules, 'psycopg2', psycopg2_mod)
    monkeypatch.setitem(sys.modules, 'psycopg2.sql', psycopg2_mod.sql)

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []
    graph_pkg = types.ModuleType('ai.common.graph')
    graph_pkg.__path__ = []
    graph_pkg.GraphGlobalBase = type(
        'GraphGlobalBase', (), {'_config_int': staticmethod(lambda cfg, key, default: default)}
    )
    age = types.ModuleType('ai.common.graph.age')
    for name in ('AgeTranslationError', 'FirewallConfig', 'TranslatedQuery'):
        setattr(age, name, type(name, (), {}))
    age.TranslateMode = types.SimpleNamespace(SAFE='safe')
    age.CAPABILITY_TABLES = {'1.5.0': {}, '1.6.0': {}}
    age.DEFAULT_AGE_VERSION = '1.5.0'
    for name in ('decode_agtype', 'decode_row', 'translate'):
        setattr(age, name, lambda *a, **kw: None)
    for name, mod in (
        ('ai', ai_pkg),
        ('ai.common', common_pkg),
        ('ai.common.graph', graph_pkg),
        ('ai.common.graph.age', age),
    ):
        monkeypatch.setitem(sys.modules, name, mod)

    rrdb_mod = _load_from_path('ai.common.rocketride_db', _RRDB_PATH)
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', rrdb_mod)
    for name in ('ROCKETRIDE_DB_DSNS', 'ROCKETRIDE_DB_RESOLVE_ERROR'):
        monkeypatch.delenv(name, raising=False)

    iglobal = _load_from_path('nodes.rocketride_graph.IGlobal', _GRAPH_NODE_DIR / 'IGlobal.py')
    return iglobal.IGlobal(), warnings, connects


class TestRocketrideGraphConnection:
    def test_open_driver_connects_to_its_scopes_database(self, monkeypatch):
        glb, _, connects = _graph_iglobal(monkeypatch)
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN, 'team:t-1': 'postgresql://t1'}))
        glb._open_driver({'scope': 'team', 'target': 't-1'})
        assert connects == ['postgresql://t1']

    def test_save_time_probe_outside_a_task_is_silent(self, monkeypatch):
        glb, warnings, connects = _graph_iglobal(monkeypatch)
        glb._probe_connection({'scope': 'user'})
        assert warnings == [] and connects == []

    def test_save_time_probe_still_checks_the_scope(self, monkeypatch):
        glb, warnings, connects = _graph_iglobal(monkeypatch)
        glb._probe_connection({'scope': 'team', 'target': 'team:x'})
        assert connects == []
        assert len(warnings) == 1 and 'not a valid team or user id' in warnings[0]
