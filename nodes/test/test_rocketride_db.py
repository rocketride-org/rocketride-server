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
the ``rocketride_vector`` HNSW default-index logic, and the trash row counts
of ``rocketride_vector`` and ``store_postgres``, which share their SQL. Real base classes are
loaded from disk with ``rocketlib`` and heavy drivers stubbed, mirroring
``test_graph_neo4j.py``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types

from ._store_base_stubs import store_base_stubs

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

    def test_public_sources_match_whatever_their_case(self):
        """The service registry is case-insensitive, so the flag must be too."""
        for provider in ('WEBHOOK', 'Chat', 'Dropper', 'DISCORD', 'Telegram'):
            assert rrdb.exposes_public_endpoint([{'provider': provider}]), provider
        assert not rrdb.exposes_public_endpoint([{'provider': 'chat '}, {'provider': None}, {}])


class TestEngineOwnedEnv:
    """The broker credential and the DSN delivery names are the engine's."""

    def test_names_match_in_any_case(self):
        for name in (
            'RR_DB_BROKER_URL',
            'rr_db_broker_token',
            'ROCKETRIDE_DB_BROKER_URL',
            'Rocketride_Db_Broker_Token',
            'ROCKETRIDE_DB_DSNS',
            'rocketride_db_dsn',
            'ROCKETRIDE_DB_RESOLVE_ERROR',
            'RR_DB_TLS_ROOT_CERT',
            'RR_DB_ALLOW_INSECURE_DSN',
        ):
            assert rrdb.is_engine_db_env(name), name

    def test_other_names_are_left_alone(self):
        for name in ('ROCKETRIDE_DB_HOTDATA_KEY', 'ROCKETRIDE_OPENAI_KEY', 'RR_STORE_URL', 'ROCKETRIDE_DB_DSNS_X', ''):
            assert not rrdb.is_engine_db_env(name), name
        assert not rrdb.is_engine_db_env(None)

    def test_scrub_removes_only_engine_owned_names(self):
        env = {'RR_DB_BROKER_TOKEN': 'a', 'rocketride_db_broker_url': 'b', 'ROCKETRIDE_OPENAI_KEY': 'c', 'PATH': 'd'}
        rrdb.scrub_db_env(env)
        assert env == {'ROCKETRIDE_OPENAI_KEY': 'c', 'PATH': 'd'}


class TestBrokerConfig:
    """The URL picks the tier; the token comes from the same tier."""

    def test_operator_tier_wins(self):
        env = {
            'RR_DB_BROKER_URL': ' https://op ',
            'RR_DB_BROKER_TOKEN': 't1',
            'ROCKETRIDE_DB_BROKER_URL': 'https://legacy',
            'ROCKETRIDE_DB_BROKER_TOKEN': 't2',
        }
        assert rrdb.broker_config(env) == ('https://op', 't1', 'operator', ())

    def test_legacy_tier_is_the_fallback(self):
        env = {'ROCKETRIDE_DB_BROKER_URL': 'https://legacy', 'ROCKETRIDE_DB_BROKER_TOKEN': 't2'}
        assert rrdb.broker_config(env) == ('https://legacy', 't2', 'legacy', ())

    def test_tiers_are_never_mixed(self):
        config = rrdb.broker_config({'RR_DB_BROKER_URL': 'https://op', 'ROCKETRIDE_DB_BROKER_TOKEN': 't2'})
        assert (config.tier, config.missing) == ('operator', ('RR_DB_BROKER_TOKEN',))
        config = rrdb.broker_config({'ROCKETRIDE_DB_BROKER_URL': 'https://l', 'RR_DB_BROKER_TOKEN': 't1'})
        assert (config.tier, config.missing) == ('legacy', ('ROCKETRIDE_DB_BROKER_TOKEN',))

    def test_nothing_configured_names_the_operator_tier(self):
        config = rrdb.broker_config({'RR_DB_BROKER_URL': '  ', 'ROCKETRIDE_DB_BROKER_TOKEN': ''})
        assert (config.tier, config.missing) == ('', ('RR_DB_BROKER_URL', 'RR_DB_BROKER_TOKEN'))

    def test_a_lone_legacy_token_reports_the_legacy_url_missing(self):
        config = rrdb.broker_config({'ROCKETRIDE_DB_BROKER_TOKEN': 't2'})
        assert (config.tier, config.missing) == ('legacy', ('ROCKETRIDE_DB_BROKER_URL',))


BASE_DSN = 'postgresql://role:pw@rocketride-data-pool.ns.svc:5432/t_acme'
CA = '/etc/rocketride/trust/db-ca.crt'


class TestEnforceDsnTls:
    """The DSN is parsed and rebuilt, never appended to; anything it does not
    understand fails closed instead of being dropped.
    """

    def _hosted(self, dsn):
        return rrdb.enforce_dsn_tls(dsn, hosted=True, ca_file=CA)

    @pytest.mark.parametrize('query', ['?sslmode=require', '', '?sslmode=verify-ca', '?sslmode=verify-full'])
    def test_hosted_upgrades_to_verify_full_against_the_operator_ca(self, query):
        out = self._hosted(BASE_DSN + query)
        assert out == f'{BASE_DSN}?sslmode=verify-full&sslrootcert={CA}'

    def test_hosted_keeps_userinfo_host_port_and_database_byte_for_byte(self):
        dsn = 'postgresql://ro%40le:p%40ss%25w%2Fd@pool.internal:6432/t_acme?sslmode=require'
        out = self._hosted(dsn)
        before, after = urllib_split(dsn), urllib_split(out)
        assert (after.netloc, after.path) == (before.netloc, before.path)
        assert after.scheme == 'postgresql' and not after.fragment

    @pytest.mark.parametrize(
        'dsn',
        [
            BASE_DSN + '?sslmode=disable',
            BASE_DSN + '?sslmode=allow',
            BASE_DSN + '?sslmode=prefer',
            BASE_DSN + '?sslmode=Require',
            BASE_DSN + '?sslmode=',
            BASE_DSN + '?sslmode=verify-full&sslmode=disable',
            BASE_DSN + '?sslmode=disable&sslmode=verify-full',
            BASE_DSN + '?sslmode=require&ssl%6dode=disable',
            BASE_DSN + '?host=evil.example',
            BASE_DSN + '?hostaddr=203.0.113.9',
            BASE_DSN + '?service=x',
            BASE_DSN + '?passfile=/tmp/x',
            BASE_DSN + '?options=-c%20search_path%3Dpublic',
            BASE_DSN + '?sslcert=/tmp/c',
            BASE_DSN + '?sslkey=/tmp/k',
            BASE_DSN + '?sslnegotiation=direct',
            BASE_DSN + '?requiressl=0',
            BASE_DSN + '?channel_binding=disable',
            BASE_DSN + '?target_session_attrs=any',
            BASE_DSN + '?dbname=t_other',
            BASE_DSN + '?user=other',
            BASE_DSN + '?sslrootcert=/dev/null',
            BASE_DSN + '?sslmode=require#frag',
            BASE_DSN + '?foo',
            'postgresql://role:pw@a:5432,evil:5432/t_acme?sslmode=require',
            'postgresql:///t_acme?sslmode=require',
            'host=evil sslmode=disable',
            'mysql://u:p@h/db',
        ],
    )
    def test_hosted_refuses_what_it_does_not_understand(self, dsn):
        with pytest.raises(RuntimeError) as excinfo:
            self._hosted(dsn)
        assert 'pw' not in str(excinfo.value).replace('password', '')  # never echoes the DSN
        assert 'rocketride-data-pool' not in str(excinfo.value)

    def test_hosted_without_a_ca_fails_closed_naming_the_variable(self):
        with pytest.raises(RuntimeError, match='RR_DB_TLS_ROOT_CERT'):
            rrdb.enforce_dsn_tls(BASE_DSN + '?sslmode=require', hosted=True, ca_file='')

    def test_non_hosted_default_pins_require_and_keeps_stronger_modes(self):
        assert rrdb.enforce_dsn_tls(BASE_DSN, hosted=False) == BASE_DSN + '?sslmode=require'
        assert rrdb.enforce_dsn_tls(BASE_DSN + '?sslmode=require', hosted=False) == BASE_DSN + '?sslmode=require'
        out = rrdb.enforce_dsn_tls(f'{BASE_DSN}?sslmode=verify-full&sslrootcert=/ca.pem', hosted=False)
        assert out == f'{BASE_DSN}?sslmode=verify-full&sslrootcert=/ca.pem'

    @pytest.mark.parametrize('mode', ['disable', 'allow', 'prefer'])
    def test_non_hosted_rejects_a_downgrade_unless_the_operator_opts_in(self, mode):
        with pytest.raises(RuntimeError, match='RR_DB_ALLOW_INSECURE_DSN'):
            rrdb.enforce_dsn_tls(f'{BASE_DSN}?sslmode={mode}', hosted=False)
        out = rrdb.enforce_dsn_tls(f'{BASE_DSN}?sslmode={mode}', hosted=False, allow_insecure=True)
        assert out == f'{BASE_DSN}?sslmode={mode}'

    def test_the_insecure_opt_in_is_ignored_on_a_hosted_engine(self):
        with pytest.raises(RuntimeError):
            rrdb.enforce_dsn_tls(BASE_DSN + '?sslmode=disable', hosted=True, ca_file=CA, allow_insecure=True)

    @pytest.mark.parametrize('dsn', [BASE_DSN + '?host=evil.example', BASE_DSN + '?sslmode=a&sslmode=b'])
    def test_non_hosted_still_refuses_overrides_and_duplicates(self, dsn):
        with pytest.raises(RuntimeError):
            rrdb.enforce_dsn_tls(dsn, hosted=False)

    def test_the_sqlalchemy_form_keeps_the_rebuilt_query_unchanged(self):
        out = self._hosted(BASE_DSN + '?sslmode=require')
        url = rrdb.to_sqlalchemy_url(out)
        assert url == out.replace('postgresql://', 'postgresql+psycopg2://', 1)
        assert url.endswith('?sslmode=verify-full&sslrootcert=' + CA)


def urllib_split(dsn):
    import urllib.parse

    return urllib.parse.urlsplit(dsn)


class TestHostedChildAssertion:
    """A hosted task re-checks the delivered DSN; it never rewrites it."""

    GOOD = f'{BASE_DSN}?sslmode=verify-full&sslrootcert={CA}'

    @pytest.fixture(autouse=True)
    def _clean_env(self, monkeypatch):
        for name in (rrdb.DB_DSNS_ENV, rrdb.DB_RESOLVE_ERROR_ENV):
            monkeypatch.delenv(name, raising=False)

    def _deliver(self, monkeypatch, dsn, *, hosted):
        monkeypatch.setenv(rrdb.DB_DSNS_ENV, json.dumps({'org': dsn}))
        monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--hosted'] if hosted else ['engine', 'node.py'])

    def test_a_conforming_dsn_passes_unchanged(self, monkeypatch):
        self._deliver(monkeypatch, self.GOOD, hosted=True)
        assert rrdb.resolve_rocketride_dsn() == self.GOOD

    @pytest.mark.parametrize(
        'dsn',
        [
            BASE_DSN + '?sslmode=require',
            BASE_DSN,
            BASE_DSN + '?sslmode=verify-full',
            f'{BASE_DSN}?sslmode=verify-full&sslrootcert={CA}&sslmode=disable',
            f'{BASE_DSN}?sslmode=verify-full&sslrootcert={CA}&host=evil.example',
            f'{BASE_DSN}?sslmode=disable&sslrootcert={CA}',
        ],
    )
    def test_a_weaker_or_conflicting_dsn_is_refused_in_a_hosted_task(self, monkeypatch, dsn):
        self._deliver(monkeypatch, dsn, hosted=True)
        with pytest.raises(ValueError, match='hosted'):
            rrdb.resolve_rocketride_dsn()

    def test_a_task_that_is_not_hosted_is_not_asserted(self, monkeypatch):
        self._deliver(monkeypatch, BASE_DSN + '?sslmode=require', hosted=False)
        assert rrdb.resolve_rocketride_dsn() == BASE_DSN + '?sslmode=require'


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
# rocketride_vector: HNSW default-index logic
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
    # rocketride_vector's IGlobal / IInstance sit on the store base since #2587;
    # these tests drive the driver Store directly, so only the names matter.
    bases = store_base_stubs()
    store_mod.StoreGlobalBase = bases.StoreGlobalBase
    store_mod.StoreInstanceBase = bases.StoreInstanceBase
    store_mod.CONTROL_OBJECT_ID = bases.CONTROL_OBJECT_ID
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

    # Deliver the org DSN the way the task engine does.
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))

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
    def test_store_connects_to_its_scopes_database(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        user_dsn = 'postgresql://u_rw:pw@pooler:5432/t_user_u1'
        monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN, 'user:u-1': user_dsn}))
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine', 'scope': 'user', 'target': 'u-1'})
        assert store.database == 't_user_u1'

    def test_store_refuses_a_scope_the_task_was_not_given(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        with pytest.raises(ValueError, match="was not given the team database 't-9'"):
            _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine', 'scope': 'team', 'target': 't-9'})

    def test_save_time_probe_outside_a_task_is_silent(self, monkeypatch):
        _vector_store_cls(monkeypatch)
        monkeypatch.delenv('ROCKETRIDE_DB_DSNS', raising=False)
        iglobal_mod = sys.modules['nodes.rocketride_vector.IGlobal']
        warnings = []
        monkeypatch.setattr(iglobal_mod, 'warning', warnings.append)
        connects = []
        monkeypatch.setattr(sys.modules['psycopg2'], 'connect', lambda *a, **kw: connects.append(a))
        glb = iglobal_mod.IGlobal()
        glb.glb = types.SimpleNamespace(
            logicalType='rocketride_vector', connConfig={'collection': 'rr_vec', 'scope': 'team'}
        )
        glb._probe_connection(glb.glb.connConfig)
        assert warnings == [] and connects == []

    def test_save_time_probe_still_checks_the_scope(self, monkeypatch):
        _vector_store_cls(monkeypatch)
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

    def test_connects_via_resolved_dsn(self, monkeypatch):
        cls, _ = _vector_store_cls(monkeypatch)
        store = _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
        # No client_id on the store: identity rides the task file (#1686);
        # tenant scoping keys on the DSN's database (see IGlobal's subKey).
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


# ---------------------------------------------------------------------------
# rocketride_vector and store_postgres: trash row counts
# ---------------------------------------------------------------------------

_PG_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'store_postgres'


def _trash_store(monkeypatch, node):
    """One of the two Postgres drivers on a fake client, with the stubs of _vector_store_cls."""
    cls, _ = _vector_store_cls(monkeypatch)
    if node == 'rocketride_vector':
        return _make_store(cls, {'collection': 'rr_vec', 'similarity': 'cosine'})
    pkg = types.ModuleType('nodes.store_postgres')
    pkg.__path__ = [str(_PG_NODE_DIR)]
    monkeypatch.setitem(sys.modules, 'nodes.store_postgres', pkg)
    iglobal = _load_from_path('nodes.store_postgres.IGlobal', _PG_NODE_DIR / 'IGlobal.py')
    monkeypatch.setitem(sys.modules, 'nodes.store_postgres.IGlobal', iglobal)
    driver = _load_from_path('nodes.store_postgres.postgres', _PG_NODE_DIR / 'postgres.py')
    return driver.Store('postgres', {'collection': 'pg_vec', 'host': 'localhost', 'similarity': 'cosine'}, {})


@pytest.mark.parametrize('node', ['rocketride_vector', 'store_postgres'])
@pytest.mark.parametrize('method', ['markDeleted', 'markActive'])
@pytest.mark.parametrize('rowcount, matched', [(3, 3), (0, 0), (-1, None)])
def test_trash_reports_the_row_count_and_none_when_it_is_unknown(monkeypatch, node, method, rowcount, matched):
    """The UPDATE's row count is matched_chunks; psycopg2's -1 (not known) is None, never a claimed 0."""
    store = _trash_store(monkeypatch, node)
    store.client.rowcount = rowcount

    assert getattr(store, method)(['a']) == matched
    assert any(sql.startswith(f'UPDATE {store.collection} SET isDeleted') for sql in store.client.executed)


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
