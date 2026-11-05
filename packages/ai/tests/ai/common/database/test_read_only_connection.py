# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""DatabaseGlobalBase.read_only_connection: the database itself refuses a generated query's writes (#2087).

``is_sql_safe`` only checks the shape of the SQL; a ``SELECT`` can still write
(``SELECT ... INTO``, ``nextval``), lock rows or run for an hour. The
generated-query paths (``_executeSQLQuery`` and the EXPLAIN check) now run on a
connection the database keeps read-only, with a time limit.

The SQLite tests always run. The live tests run against a real server when its
DSN is set, and skip otherwise:

- ``RR_TEST_PG_DSN`` (PostgreSQL, the variable the store suites use),
- ``RR_TEST_MYSQL_DSN`` (MySQL or MariaDB, ``mysql+pymysql://...``),
- ``RR_TEST_CLICKHOUSE_DSN`` (``clickhouse+native://...``).

Each live test uses its own table and drops it; the role needs CREATE. The ClickHouse profile test creates
and drops its own users, and skips when the role may not.
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.exc import OperationalError, ProgrammingError

from ai.common.database.db_global_base import DatabaseGlobalBase
from ai.common.database.sql_safety import is_sql_safe
from ai.common.database.db_instance_base import DatabaseInstanceBase


class _Global(DatabaseGlobalBase):
    """Concrete DatabaseGlobalBase with a short time limit."""

    READ_QUERY_TIMEOUT = 2

    def _connection_params(self, config):
        """Unused: the tests attach an engine directly."""
        return dict(config)

    def _build_connection_url(self, params):
        """Unused: the tests attach an engine directly."""
        return ''


class _Instance(DatabaseInstanceBase):
    """Concrete DatabaseInstanceBase."""

    def _db_display_name(self):
        """Name used in messages."""
        return 'TestDB'

    def _db_dialect(self):
        """Dialect used in prompts."""
        return 'testdb'


def _global(engine):
    """Return a global bound to ``engine``.

    Args:
        engine: The SQLAlchemy engine.

    Returns:
        The global.
    """
    glb = _Global.__new__(_Global)
    glb.engine = engine
    return glb


# ---------------------------------------------------------------------------
# SQLite: always run
# ---------------------------------------------------------------------------


@pytest.fixture
def sqlite_global():
    """Yield a global on an in-memory SQLite database holding table ``t`` with two rows."""
    # One in-memory database, one connection: what the block sets is visible to the next checkout
    engine = create_engine('sqlite://')
    with engine.begin() as conn:
        conn.exec_driver_sql('CREATE TABLE t (id INTEGER)')
        conn.exec_driver_sql('INSERT INTO t VALUES (1), (2)')
    yield _global(engine)
    engine.dispose()


def _count(engine):
    """Return the number of rows in ``t``.

    Args:
        engine: The engine to read through.

    Returns:
        The row count.
    """
    with engine.connect() as conn:
        return conn.exec_driver_sql('SELECT count(*) FROM t').scalar()


def test_sqlite_reads_and_refuses_writes(sqlite_global):
    """A read returns rows; a write inside the block is refused by the database."""
    with sqlite_global.read_only_connection() as conn:
        assert conn.exec_driver_sql('SELECT count(*) FROM t').scalar() == 2
    with pytest.raises(OperationalError, match='readonly'):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('DELETE FROM t')
    assert _count(sqlite_global.engine) == 2


def test_sqlite_refuses_a_chain(sqlite_global):
    """sqlite3 runs one statement per call, so a ;-chain cannot switch query_only off and then write."""
    # Python 3.10 raises sqlite3.Warning, which SQLAlchemy does not wrap; 3.11 and later raise ProgrammingError
    with pytest.raises((ProgrammingError, sqlite3.Warning), match='one statement'):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('PRAGMA query_only = OFF; DELETE FROM t')
    assert _count(sqlite_global.engine) == 2


def test_sqlite_connection_is_writable_again_after_the_block(sqlite_global):
    """The pooled connection goes back read-write, also after a refused write."""
    with pytest.raises(OperationalError):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('INSERT INTO t VALUES (3)')
    with sqlite_global.engine.begin() as conn:
        conn.exec_driver_sql('INSERT INTO t VALUES (3)')
    assert _count(sqlite_global.engine) == 3


def test_generated_query_paths_use_the_read_only_connection(sqlite_global):
    """``_executeSQLQuery`` and the EXPLAIN check cannot write, whatever the statement says."""
    inst = _Instance.__new__(_Instance)
    inst.IGlobal = sqlite_global

    assert inst._executeSQLQuery('SELECT id FROM t ORDER BY id') == [{'id': 1}, {'id': 2}]
    assert inst._executeSQLQuery('DELETE FROM t') is None
    ok, _message = sqlite_global._validateQuery('SELECT id FROM t')
    assert ok
    assert _count(sqlite_global.engine) == 2


def test_an_unknown_dialect_runs_nothing():
    """A dialect without a read-only mode fails closed instead of running the query unprotected."""
    connected = []
    engine = SimpleNamespace(dialect=SimpleNamespace(name='oracle'), connect=lambda: connected.append(True))
    with pytest.raises(RuntimeError, match='No read-only mode for the oracle dialect'):
        with _global(engine).read_only_connection():
            pass
    assert connected == []


class _RecordingConnection:
    """A connection that records what the block runs on it."""

    def __init__(self, is_mariadb=False):
        """Nothing run yet.

        Args:
            is_mariadb: What the connection's dialect says about the server.
        """
        self.dialect = SimpleNamespace(is_mariadb=is_mariadb)
        self.statements = []
        self.invalidated = False

    def exec_driver_sql(self, statement):
        """Record ``statement``.

        Args:
            statement: The SQL.
        """
        self.statements.append(statement)

    def rollback(self):
        """Roll back (nothing to do)."""

    def invalidate(self):
        """Note that the connection was discarded."""
        self.invalidated = True


def _engine_with(dialect, conn):
    """Return an engine stand-in of ``dialect`` that hands out ``conn``.

    Args:
        dialect: The dialect name the engine reports.
        conn: The one connection.

    Returns:
        The engine.
    """

    @contextmanager
    def connect():
        """Hand out the one connection."""
        yield conn

    return SimpleNamespace(dialect=SimpleNamespace(name=dialect), connect=connect)


@pytest.mark.parametrize(
    ('dialect', 'is_mariadb', 'setting', 'value'),
    [('mysql', False, 'max_execution_time', 2000), ('mariadb', True, 'max_statement_time', 2)],
)
def test_a_mariadb_url_gets_the_mysql_read_only_session(dialect, is_mariadb, setting, value):
    """A ``mariadb+`` URL names the dialect ``mariadb``: it gets the MySQL read-only session with MariaDB's limit."""
    conn = _RecordingConnection(is_mariadb)
    with _global(_engine_with(dialect, conn)).read_only_connection():
        pass

    assert conn.statements == [
        'SET SESSION TRANSACTION READ ONLY',
        f'SET SESSION {setting} = {value}',
        'SET SESSION TRANSACTION READ WRITE',
        f'SET SESSION {setting} = DEFAULT',
    ]
    assert not conn.invalidated


class _ResetFailingConnection(_RecordingConnection):
    """A connection whose session reset fails, recording what the block did to it."""

    def exec_driver_sql(self, statement):
        """Record ``statement``; fail the reset.

        Args:
            statement: The SQL.
        """
        super().exec_driver_sql(statement)
        if statement == 'PRAGMA query_only = OFF':
            raise OperationalError(statement, {}, Exception('connection lost'))


def test_a_connection_whose_reset_fails_is_discarded(monkeypatch):
    """If the session cannot be made read-write again, it must not go back to the pool."""
    conn = _ResetFailingConnection()
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    with _global(_engine_with('sqlite', conn)).read_only_connection():
        pass

    assert conn.statements == ['PRAGMA query_only = ON', 'PRAGMA query_only = OFF']
    assert conn.invalidated
    assert 'discarding it' in warnings[0]


# ---------------------------------------------------------------------------
# Live servers: run when the DSN is set
# ---------------------------------------------------------------------------

# Per dialect: table DDL, statements the database must refuse inside the block, a query that runs past the
# time limit, and a query that reads the session settings the block changed (None where they live per query)
_LIVE = {
    'postgresql': {
        'env': 'RR_TEST_PG_DSN',
        'create': 'CREATE TABLE {t} (id int)',
        'refused': [
            'INSERT INTO {t} VALUES (9)',
            'CREATE TABLE {t}_new (id int)',
            'SELECT * INTO {t}_copy FROM {t}',
            "SELECT nextval('{t}_seq')",
            "SELECT setval('{t}_seq', 5)",
            'SELECT * FROM {t} FOR UPDATE',
        ],
        'extra': ['CREATE SEQUENCE {t}_seq'],
        'drop': [
            'DROP TABLE IF EXISTS {t}',
            'DROP TABLE IF EXISTS {t}_new',
            'DROP TABLE IF EXISTS {t}_copy',
            'DROP SEQUENCE IF EXISTS {t}_seq',
        ],
        'slow': 'SELECT pg_sleep(30)',
        'session': "SELECT current_setting('statement_timeout'), current_setting('transaction_read_only')",
        'session_default': ('0', 'off'),
    },
    'mysql': {
        'env': 'RR_TEST_MYSQL_DSN',
        'create': 'CREATE TABLE {t} (id int)',
        'refused': [
            'INSERT INTO {t} VALUES (9)',
            'CREATE TABLE {t}_new (id int)',
            'CREATE TABLE {t}_copy AS SELECT * FROM {t}',
            'SELECT * FROM {t} FOR UPDATE',
            # pymysql connects without multi-statements, so a chain cannot switch the session back to read-write first
            'SET SESSION TRANSACTION READ WRITE; INSERT INTO {t} VALUES (9)',
        ],
        'extra': [],
        'drop': ['DROP TABLE IF EXISTS {t}', 'DROP TABLE IF EXISTS {t}_new', 'DROP TABLE IF EXISTS {t}_copy'],
        'slow': 'SELECT count(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c',
        'session': 'SELECT @@SESSION.transaction_read_only',
        'session_default': (0,),
    },
    'clickhouse': {
        'env': 'RR_TEST_CLICKHOUSE_DSN',
        'create': 'CREATE TABLE {t} (id Int32) ENGINE = MergeTree ORDER BY id',
        'refused': [
            'INSERT INTO {t} VALUES (9)',
            'CREATE TABLE {t}_new (id Int32) ENGINE = Memory',
            'SELECT 1 SETTINGS readonly = 0',
            'SELECT 1 SETTINGS max_execution_time = 0',
            "SELECT * FROM url('http://127.0.0.1:8123/?query=SELECT+1', CSV)",
            'SELECT 1; INSERT INTO {t} VALUES (9)',
        ],
        'extra': [],
        'drop': ['DROP TABLE IF EXISTS {t}', 'DROP TABLE IF EXISTS {t}_new'],
        'slow': 'SELECT count() FROM numbers(1000000000000)',
        'session': None,
        'session_default': None,
    },
}


@pytest.fixture(params=sorted(_LIVE))
def live(request):
    """Yield ``(global, table, case)`` for each configured server, on a one-connection pool.

    One connection means the write after the block reuses exactly the connection the block changed.
    """
    case = _LIVE[request.param]
    dsn = os.environ.get(case['env'])
    if not dsn:
        pytest.skip(f'Set {case["env"]} to run against a live {request.param} server')
    engine = create_engine(dsn, pool_size=1, max_overflow=0)
    table = f'rr_read_only_{uuid4().hex[:12]}'
    with engine.begin() as conn:
        for statement in [case['create'], *case['extra']]:
            conn.exec_driver_sql(statement.format(t=table))
    try:
        yield _global(engine), table, case
    finally:
        with engine.begin() as conn:
            for statement in case['drop']:
                conn.exec_driver_sql(statement.format(t=table))
        engine.dispose()


def test_live_server_reads_inside_the_block(live):
    """A read runs inside the block, so the refusals below come from the server, not from a block that runs nothing."""
    glb, table, _case = live
    with glb.read_only_connection() as conn:
        assert conn.execute(text(f'SELECT count(*) FROM {table}')).scalar() == 0


def test_live_server_refuses_every_write(live):
    """Each write, lock and DDL statement is refused by the server inside the block, and the table stays empty."""
    glb, table, case = live
    for statement in case['refused']:
        with pytest.raises(Exception):  # noqa: B017 - each driver raises its own class
            with glb.read_only_connection() as conn:
                conn.execute(text(statement.format(t=table))).fetchall()
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 0


def test_live_postgres_chain_needs_the_shape_check(live):
    """On PostgreSQL a COMMIT in a ;-chain leaves the read-only transaction, so is_sql_safe's chain rule must stop it."""
    glb, table, _case = live
    if glb.engine.dialect.name != 'postgresql':
        pytest.skip('this driver refuses a ;-chain: see the refused statements')
    chain = f'COMMIT; INSERT INTO {table} VALUES (9)'
    assert not is_sql_safe(chain)
    with glb.read_only_connection() as conn:
        conn.execute(text(chain))
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 1


def test_live_postgres_chain_of_reads_lifts_the_time_limit(live):
    """On PostgreSQL a later SELECT of a ;-chain can switch the time limit off, so is_sql_safe refuses any chain."""
    glb, _table, _case = live
    if glb.engine.dialect.name != 'postgresql':
        pytest.skip('this driver refuses a ;-chain: see the refused statements')
    sleep = glb.READ_QUERY_TIMEOUT + 2
    chain = f"SELECT 1; SELECT set_config('statement_timeout', '0', false); SELECT pg_sleep({sleep})"
    assert not is_sql_safe(chain)
    start = time.monotonic()
    with glb.read_only_connection() as conn:
        conn.execute(text(chain))
    # Well past the limit, which would have stopped the sleep; not >= sleep, as the clocks tick in ~16 ms steps
    assert time.monotonic() - start > glb.READ_QUERY_TIMEOUT + 1


def test_live_server_stops_a_long_query(live):
    """A query that would run long is stopped near the time limit."""
    glb, _table, case = live
    start = time.monotonic()
    with pytest.raises(Exception):  # noqa: B017 - each driver raises its own class
        with glb.read_only_connection() as conn:
            conn.execute(text(case['slow'])).fetchall()
    assert time.monotonic() - start < glb.READ_QUERY_TIMEOUT + 10


def test_live_connection_is_ordinary_again_after_the_block(live):
    """After refused writes, the pooled connection writes again and its session settings are back."""
    glb, table, case = live
    with pytest.raises(Exception):  # noqa: B017 - each driver raises its own class
        with glb.read_only_connection() as conn:
            conn.execute(text(case['refused'][0].format(t=table)))
    with glb.engine.begin() as conn:
        conn.exec_driver_sql(f'INSERT INTO {table} VALUES (1)')
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 1
        if case['session']:
            assert tuple(conn.exec_driver_sql(case['session']).one()) == case['session_default']


class _ProfileConnection:
    """A ClickHouse connection stand-in that answers the ``system.settings`` lookup."""

    def __init__(self, readonly, max_execution_time):
        """Answer with these rows; count the lookups.

        Args:
            readonly: ``(value, readonly, min, max)`` of the ``readonly`` setting, as ClickHouse returns them.
            max_execution_time: The same for ``max_execution_time``.
        """
        self.rows = [('readonly', *readonly), ('max_execution_time', *max_execution_time)]
        self.lookups = 0

    def exec_driver_sql(self, statement):
        """Answer the settings lookup.

        Args:
            statement: The SQL; only the lookup is expected.

        Returns:
            The rows ``(name, value, readonly, min, max)``.
        """
        assert statement.startswith('SELECT name, value, readonly, min, max FROM system.settings')
        self.lookups += 1
        return iter(self.rows)


# (value, readonly, min, max) per setting, as system.settings shows them for each kind of profile (ClickHouse 24.8)
_WRITABLE = ('0', 0, None, None)
_READONLY_1 = ('1', 1, None, None)


@pytest.mark.parametrize(
    ('readonly', 'max_execution_time', 'settings', 'warns'),
    [
        pytest.param(_WRITABLE, ('0', 0, None, None), {'readonly': 1, 'max_execution_time': 2}, False, id='writable'),
        pytest.param(_READONLY_1, ('0', 1, None, None), {}, True, id='readonly1-no-limit'),
        pytest.param(_READONLY_1, ('300', 1, None, None), {}, True, id='readonly1-longer-limit'),
        pytest.param(_READONLY_1, ('1', 1, None, None), {}, False, id='readonly1-stricter-limit'),
        pytest.param(_READONLY_1, ('0', 0, '1', '60'), {'max_execution_time': 2}, False, id='changeable-in-readonly'),
        pytest.param(('2', 1, None, None), ('0', 0, None, None), {'max_execution_time': 2}, False, id='readonly2'),
        pytest.param(_WRITABLE, ('0', 0, None, '1'), {'readonly': 1, 'max_execution_time': 1}, False, id='max-below'),
        pytest.param(
            _WRITABLE, ('0', 0, None, '1.5'), {'readonly': 1, 'max_execution_time': 1.5}, False, id='max-fraction'
        ),
        pytest.param(_WRITABLE, ('0', 0, '5', None), {'readonly': 1, 'max_execution_time': 5}, False, id='min-above'),
        pytest.param(_WRITABLE, ('1.5', 0, None, None), {'readonly': 1}, False, id='stricter-profile-limit'),
        pytest.param(_WRITABLE, ('0', 1, None, None), {'readonly': 1}, True, id='const-limit'),
    ],
)
def test_clickhouse_sends_only_the_settings_the_profile_allows(
    monkeypatch, readonly, max_execution_time, settings, warns
):
    """A setting the user may not change fails every query, a looser limit would replace the profile's: neither is sent."""
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    glb = _global(None)
    conn = _ProfileConnection(readonly, max_execution_time)

    assert glb._clickhouse_read_settings(conn, 2) == settings
    assert glb._clickhouse_read_settings(conn, 2) == settings
    assert conn.lookups == 1
    assert len(warnings) == (1 if warns else 0)
    if warns:
        assert 'max_execution_time' in warnings[0] and 'CHANGEABLE_IN_READONLY' in warnings[0]


# Profiles of the live users: (SETTINGS clause, the time limit a query runs under, whether the node warns)
_LIVE_PROFILES = [
    pytest.param('readonly = 1', 0, True, id='readonly1'),
    pytest.param('readonly = 1, max_execution_time MIN 1 MAX 60 CHANGEABLE_IN_READONLY', 2, False, id='changeable'),
    pytest.param('readonly = 2', 2, False, id='readonly2'),
    pytest.param('max_execution_time MAX 1', 1, False, id='max-below'),
    pytest.param('max_execution_time = 1', 1, False, id='stricter-profile-limit'),
    pytest.param('max_execution_time = 0 CONST', 0, True, id='const-limit'),
]


@pytest.mark.parametrize(('profile', 'limit', 'warns'), _LIVE_PROFILES)
def test_live_clickhouse_profiles_run_read_only(monkeypatch, profile, limit, warns):
    """A ClickHouse user with each kind of profile runs a query read-only, under the strictest limit it may have."""
    dsn = os.environ.get('RR_TEST_CLICKHOUSE_DSN')
    if not dsn:
        pytest.skip('Set RR_TEST_CLICKHOUSE_DSN to run against a live ClickHouse server')
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    admin = create_engine(dsn)
    user, password = f'rr_profile_{uuid4().hex[:12]}', uuid4().hex
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(
                f"CREATE USER {user} IDENTIFIED WITH sha256_password BY '{password}' SETTINGS {profile}"
            )
    except Exception as e:  # noqa: BLE001 - each server says no in its own way
        admin.dispose()
        pytest.skip(f'The DSN user cannot create users: {e}')
    engine = create_engine(make_url(dsn).set(username=user, password=password))
    try:
        glb = _global(engine)
        with glb.read_only_connection() as conn:
            row = conn.exec_driver_sql("SELECT getSetting('readonly'), getSetting('max_execution_time')").one()
        assert int(row[0]) >= 1
        assert float(row[1]) == limit
        assert len(warnings) == (1 if warns else 0)
        with pytest.raises(Exception):  # noqa: B017 - the driver raises its own class
            with glb.read_only_connection() as conn:
                conn.exec_driver_sql(f'CREATE TABLE {user}_t (id Int32) ENGINE = Memory')
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP USER IF EXISTS {user}')
        admin.dispose()


class _DriverError(Exception):
    """Stands in for clickhouse-sqlalchemy's DatabaseException: not a SQLAlchemyError, the driver error on ``.orig``."""

    def __init__(self, message):
        """Carry ``message`` and a driver error on ``.orig``.

        Args:
            message: The error text.
        """
        super().__init__(message)
        self.orig = Exception(message)


def _instance_over(exc):
    """Return an instance whose read-only connection fails every statement with ``exc``.

    Args:
        exc: The exception to raise.

    Returns:
        The instance.
    """

    @contextmanager
    def read_only_connection():
        """Yield a connection whose ``execute`` raises ``exc``."""

        def fail(*_args, **_kwargs):
            """Raise ``exc``."""
            raise exc

        yield SimpleNamespace(execute=fail)

    inst = _Instance.__new__(_Instance)
    inst.IGlobal = SimpleNamespace(read_only_connection=read_only_connection)
    return inst


def test_a_clickhouse_refusal_is_a_failed_query():
    """ClickHouse refuses a write under readonly=1 with its own DatabaseException; that is a failed query, not a crash."""
    exc = _DriverError('Code: 164. DB::Exception: Cannot execute query in readonly mode')
    assert _instance_over(exc)._executeSQLQuery('INSERT INTO t VALUES (1)') is None


def test_a_non_database_error_still_propagates():
    """Only database failures become None: a dialect without a read-only mode still stops the query loudly."""
    with pytest.raises(RuntimeError, match='No read-only mode'):
        _instance_over(RuntimeError('No read-only mode for the oracle dialect'))._executeSQLQuery('SELECT 1')
