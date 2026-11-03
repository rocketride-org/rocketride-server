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

Each live test uses its own table and drops it; the role needs CREATE.
"""

import os
import time
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

from ai.common.database.db_global_base import DatabaseGlobalBase
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


def test_sqlite_connection_is_writable_again_after_the_block(sqlite_global):
    """The pooled connection goes back read-write, also after a refused write."""
    with pytest.raises(OperationalError):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('INSERT INTO t VALUES (3)')
    with sqlite_global.engine.begin() as conn:
        conn.exec_driver_sql('INSERT INTO t VALUES (3)')
    assert _count(sqlite_global.engine) == 3


def test_generated_query_paths_use_the_read_only_connection(sqlite_global):
    """``_executeSQLQuery`` and the EXPLAIN check cannot write, whatever the SQL says."""
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


class _ResetFailingConnection:
    """A connection whose session reset fails, recording what the block did to it."""

    dialect = SimpleNamespace(is_mariadb=False)

    def __init__(self):
        """Nothing run yet."""
        self.statements = []
        self.invalidated = False

    def exec_driver_sql(self, statement):
        """Record ``statement``; fail the reset.

        Args:
            statement: The SQL.
        """
        self.statements.append(statement)
        if statement == 'PRAGMA query_only = OFF':
            raise OperationalError(statement, {}, Exception('connection lost'))

    def rollback(self):
        """Roll back (nothing to do)."""

    def invalidate(self):
        """Note that the connection was discarded."""
        self.invalidated = True


def test_a_connection_whose_reset_fails_is_discarded(monkeypatch):
    """If the session cannot be made read-write again, it must not go back to the pool."""
    conn = _ResetFailingConnection()

    @contextmanager
    def connect():
        """Hand out the one connection."""
        yield conn

    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    engine = SimpleNamespace(dialect=SimpleNamespace(name='sqlite'), connect=connect)
    with _global(engine).read_only_connection():
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


def test_live_server_refuses_every_write(live):
    """Each write, lock and DDL statement is refused by the server inside the block."""
    glb, table, case = live
    for statement in case['refused']:
        with pytest.raises(Exception):  # noqa: B017 - each driver raises its own class
            with glb.read_only_connection() as conn:
                conn.execute(text(statement.format(t=table))).fetchall()


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
    """A ClickHouse connection stand-in that answers the profile's ``readonly`` level."""

    def __init__(self, level):
        """Answer ``level``; count the lookups.

        Args:
            level: The profile's readonly level.
        """
        self.level = level
        self.lookups = 0

    def exec_driver_sql(self, statement):
        """Answer the readonly lookup.

        Args:
            statement: The SQL; only the lookup is expected.

        Returns:
            An object whose ``scalar()`` is the level, as a string the way ClickHouse returns it.
        """
        assert statement == "SELECT getSetting('readonly')"
        self.lookups += 1
        return SimpleNamespace(scalar=lambda: str(self.level))


@pytest.mark.parametrize(
    ('level', 'settings'),
    [
        (0, {'max_execution_time': 2, 'readonly': 1}),
        (1, {}),
        (2, {'max_execution_time': 2}),
    ],
)
def test_clickhouse_sends_only_the_settings_the_profile_allows(level, settings):
    """A user already read-only by profile may not send readonly (readonly=1: no setting at all), or every query fails."""
    glb = _global(None)
    conn = _ProfileConnection(level)

    assert glb._clickhouse_read_settings(conn, 2) == settings
    assert glb._clickhouse_read_settings(conn, 2) == settings
    assert conn.lookups == 1
