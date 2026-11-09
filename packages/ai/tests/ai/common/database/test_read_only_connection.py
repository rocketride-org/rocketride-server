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
        """Unused: the tests attach an engine directly.

        Args:
            config: The node configuration.

        Returns:
            The configuration, unchanged.
        """
        return dict(config)

    def _build_connection_url(self, params):
        """Unused: the tests attach an engine directly.

        Args:
            params: The connection parameters.

        Returns:
            An empty URL.
        """
        return ''


class _Instance(DatabaseInstanceBase):
    """Concrete DatabaseInstanceBase."""

    def _db_display_name(self):
        """Name used in messages.

        Returns:
            The name ``TestDB``.
        """
        return 'TestDB'

    def _db_dialect(self):
        """Dialect used in prompts.

        Returns:
            The dialect ``testdb``.
        """
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
    """A read returns rows; a write inside the block is refused by the database.

    Args:
        sqlite_global: A global on an in-memory SQLite database with table ``t``, from the ``sqlite_global`` fixture.
    """
    with sqlite_global.read_only_connection() as conn:
        assert conn.exec_driver_sql('SELECT count(*) FROM t').scalar() == 2
    with pytest.raises(OperationalError, match='readonly'):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('DELETE FROM t')
    assert _count(sqlite_global.engine) == 2


def test_sqlite_refuses_a_chain(sqlite_global):
    """sqlite3 runs one statement per call, so a ;-chain cannot switch query_only off and then write.

    Args:
        sqlite_global: A global on an in-memory SQLite database with table ``t``, from the ``sqlite_global`` fixture.
    """
    # Python 3.10 raises sqlite3.Warning, which SQLAlchemy does not wrap; 3.11 and later raise ProgrammingError
    with pytest.raises((ProgrammingError, sqlite3.Warning), match='one statement'):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('PRAGMA query_only = OFF; DELETE FROM t')
    assert _count(sqlite_global.engine) == 2


def test_sqlite_connection_is_writable_again_after_the_block(sqlite_global):
    """The pooled connection goes back read-write, also after a refused write.

    Args:
        sqlite_global: A global on an in-memory SQLite database with table ``t``, from the ``sqlite_global`` fixture.
    """
    with pytest.raises(OperationalError):
        with sqlite_global.read_only_connection() as conn:
            conn.exec_driver_sql('INSERT INTO t VALUES (3)')
    with sqlite_global.engine.begin() as conn:
        conn.exec_driver_sql('INSERT INTO t VALUES (3)')
    assert _count(sqlite_global.engine) == 3


def test_sqlite_query_only_set_before_the_block_stays_on(sqlite_global):
    """A connection that was query-only before the block is query-only after it, not read-write.

    Args:
        sqlite_global: A global on an in-memory SQLite database with table ``t``, from the ``sqlite_global`` fixture.
    """
    with sqlite_global.engine.connect() as conn:
        conn.exec_driver_sql('PRAGMA query_only = ON')
    with sqlite_global.read_only_connection() as conn:
        conn.exec_driver_sql('SELECT 1')
    with sqlite_global.engine.connect() as conn:
        assert conn.exec_driver_sql('PRAGMA query_only').scalar() == 1
        conn.exec_driver_sql('PRAGMA query_only = OFF')


def test_generated_query_paths_use_the_read_only_connection(sqlite_global):
    """``_executeSQLQuery`` and the EXPLAIN check cannot write, whatever the statement says.

    Args:
        sqlite_global: A global on an in-memory SQLite database with table ``t``, from the ``sqlite_global`` fixture.
    """
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


# What _RecordingConnection records for a rollback, among the statements
_ROLLBACK = 'rollback()'


class _RecordingConnection:
    """A connection that records what the block runs on it, rollbacks included, and whose session reads ``session``."""

    def __init__(self, is_mariadb=False, session=(0, 0), version=(8, 0, 46)):
        """Nothing run yet.

        Args:
            is_mariadb: What the connection's dialect says about the server.
            session: What a read of the session's settings returns before the block.
            version: The server version the dialect reports.
        """
        self.dialect = SimpleNamespace(is_mariadb=is_mariadb, server_version_info=version)
        self.session = session
        self.statements = []
        self.invalidated = False

    def exec_driver_sql(self, statement):
        """Record ``statement``.

        Args:
            statement: The SQL.

        Returns:
            A result whose ``one()`` is ``session`` and whose ``scalar()`` is its first value.
        """
        self.statements.append(statement)
        return SimpleNamespace(one=lambda: self.session, scalar=lambda: self.session[0])

    def rollback(self):
        """Record the rollback."""
        self.statements.append(_ROLLBACK)

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
    ('dialect', 'is_mariadb', 'version', 'read_only', 'setting', 'value'),
    [
        ('mysql', False, (8, 0, 46), 'transaction_read_only', 'max_execution_time', 2000),
        ('mariadb', True, (11, 4, 13), 'transaction_read_only', 'max_statement_time', 2),
        ('mariadb', True, (10, 11, 19), 'tx_read_only', 'max_statement_time', 2),
    ],
)
def test_a_mariadb_url_gets_the_mysql_read_only_session(dialect, is_mariadb, version, read_only, setting, value):
    """A ``mariadb+`` URL names the dialect ``mariadb``: it gets the MySQL read-only session, with MariaDB's names.

    Args:
        dialect: The dialect name the engine reports.
        is_mariadb: Whether the server says it is MariaDB.
        version: The server version the dialect reports.
        read_only: The session variable that holds the read-only flag.
        setting: The session variable that holds the time limit.
        value: The time limit the block sets, in that variable's unit.
    """
    conn = _RecordingConnection(is_mariadb, version=version)
    with _global(_engine_with(dialect, conn)).read_only_connection():
        pass

    assert conn.statements == [
        f'SELECT @@SESSION.{read_only}, @@SESSION.{setting}',
        _ROLLBACK,
        'SET SESSION TRANSACTION READ ONLY',
        f'SET SESSION {setting} = {value}',
        _ROLLBACK,
        'SET SESSION TRANSACTION READ WRITE',
        f'SET SESSION {setting} = 0',
        _ROLLBACK,
    ]
    assert not conn.invalidated


@pytest.mark.parametrize(
    ('dialect', 'lookup', 'begin', 'end'),
    [
        (
            'mysql',
            ['SELECT @@SESSION.transaction_read_only, @@SESSION.max_execution_time'],
            ['SET SESSION TRANSACTION READ ONLY', 'SET SESSION max_execution_time = 2000'],
            ['SET SESSION TRANSACTION READ WRITE', 'SET SESSION max_execution_time = 0'],
        ),
        ('sqlite', ['PRAGMA query_only'], ['PRAGMA query_only = ON'], ['PRAGMA query_only = OFF']),
        ('postgresql', [], ['SET TRANSACTION READ ONLY', 'SET LOCAL statement_timeout = 2000'], []),
    ],
)
def test_the_lookup_transaction_ends_before_the_read_only_statements(dialect, lookup, begin, end):
    """A rollback comes between the session lookup and the read-only statements, and none between those and the query.

    MySQL applies ``SET SESSION TRANSACTION READ ONLY`` from the next transaction on, so one the lookup opened must
    end first; on PostgreSQL ``SET TRANSACTION READ ONLY`` opens the query's transaction, so nothing may end it.

    Args:
        dialect: The dialect name the engine reports.
        lookup: The statements that read the session before the block.
        begin: The statements that make the session read-only.
        end: The statements that give the session back its settings.
    """
    conn = _RecordingConnection()
    with _global(_engine_with(dialect, conn)).read_only_connection() as block:
        block.exec_driver_sql('SELECT 1')

    assert conn.statements == [*lookup, _ROLLBACK, *begin, 'SELECT 1', _ROLLBACK, *end, _ROLLBACK]


@pytest.mark.parametrize(
    ('dialect', 'session', 'end'),
    [
        ('mysql', (1, 5000), ['SET SESSION TRANSACTION READ ONLY', 'SET SESSION max_execution_time = 5000']),
        ('sqlite', (1,), ['PRAGMA query_only = ON']),
    ],
)
def test_the_session_gets_back_what_it_had_not_the_defaults(dialect, session, end):
    """A session the server or a role made read-only, or gave a stricter limit, is not reset to read-write.

    Args:
        dialect: The dialect name the engine reports.
        session: What the session lookup returns: the read-only flag and, on MySQL, the time limit.
        end: The statements that give the session back its settings.
    """
    conn = _RecordingConnection(session=session)
    with _global(_engine_with(dialect, conn)).read_only_connection():
        pass

    assert conn.statements[-len(end) - 1 :] == [*end, _ROLLBACK]


class _FailingConnection(_RecordingConnection):
    """A connection that fails one statement, recording what the block did to it."""

    def __init__(self, fail_on):
        """Fail ``fail_on``; record the rest.

        Args:
            fail_on: The statement that fails.
        """
        super().__init__()
        self.fail_on = fail_on

    def exec_driver_sql(self, statement):
        """Record ``statement``; fail it if it is ``fail_on``.

        Args:
            statement: The SQL.

        Returns:
            The recorded result.
        """
        result = super().exec_driver_sql(statement)
        if statement == self.fail_on:
            raise OperationalError(statement, {}, Exception('connection lost'))
        return result


def test_a_session_changed_half_way_gets_its_settings_back():
    """If the second read-only statement fails, the first is still undone before the connection goes back."""
    conn = _FailingConnection('SET SESSION max_execution_time = 2000')
    with pytest.raises(OperationalError, match='connection lost'):
        with _global(_engine_with('mysql', conn)).read_only_connection():
            pass

    assert conn.statements == [
        'SELECT @@SESSION.transaction_read_only, @@SESSION.max_execution_time',
        _ROLLBACK,
        'SET SESSION TRANSACTION READ ONLY',
        'SET SESSION max_execution_time = 2000',
        _ROLLBACK,
        'SET SESSION TRANSACTION READ WRITE',
        'SET SESSION max_execution_time = 0',
        _ROLLBACK,
    ]
    assert not conn.invalidated


def test_a_connection_whose_reset_fails_is_discarded(monkeypatch):
    """If the session cannot be made read-write again, it must not go back to the pool.

    Args:
        monkeypatch: pytest's ``monkeypatch`` fixture.
    """
    conn = _FailingConnection('PRAGMA query_only = OFF')
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    with _global(_engine_with('sqlite', conn)).read_only_connection():
        pass

    assert conn.statements == [
        'PRAGMA query_only',
        _ROLLBACK,
        'PRAGMA query_only = ON',
        _ROLLBACK,
        'PRAGMA query_only = OFF',
    ]
    assert conn.invalidated
    assert 'discarding it' in warnings[0]


# ---------------------------------------------------------------------------
# Live servers: run when the DSN is set
# ---------------------------------------------------------------------------

# Per dialect: table DDL, statements the database must refuse inside the block with the server's own error, a
# query that runs past the time limit and the error that stops it, one whose EXPLAIN would (None where planning
# does not run it), and a query that reads the session settings the block changed (None where they live per query)
_LIVE = {
    'postgresql': {
        'env': 'RR_TEST_PG_DSN',
        'create': 'CREATE TABLE {t} (id int)',
        'refused': [
            ('INSERT INTO {t} VALUES (9)', 'read-only transaction'),
            ('CREATE TABLE {t}_new (id int)', 'read-only transaction'),
            ('SELECT * INTO {t}_copy FROM {t}', 'read-only transaction'),
            ("SELECT nextval('{t}_seq')", 'read-only transaction'),
            ("SELECT setval('{t}_seq', 5)", 'read-only transaction'),
            ('SELECT * FROM {t} FOR UPDATE', 'read-only transaction'),
        ],
        'extra': ['CREATE SEQUENCE {t}_seq'],
        'drop': [
            'DROP TABLE IF EXISTS {t}',
            'DROP TABLE IF EXISTS {t}_new',
            'DROP TABLE IF EXISTS {t}_copy',
            'DROP SEQUENCE IF EXISTS {t}_seq',
        ],
        'slow': 'SELECT pg_sleep(30)',
        'slow_error': 'statement timeout',
        'slow_explain': None,
        'session': "SELECT current_setting('statement_timeout'), current_setting('transaction_read_only')",
        'session_default': ('0', 'off'),
    },
    'mysql': {
        'env': 'RR_TEST_MYSQL_DSN',
        'create': 'CREATE TABLE {t} (id int)',
        'refused': [
            ('INSERT INTO {t} VALUES (9)', 'READ ONLY transaction'),
            ('CREATE TABLE {t}_new (id int)', 'READ ONLY transaction'),
            ('CREATE TABLE {t}_copy AS SELECT * FROM {t}', 'READ ONLY transaction'),
            ('SELECT * FROM {t} FOR UPDATE', 'READ ONLY transaction'),
            # pymysql connects without multi-statements, so a chain cannot switch the session back to read-write first
            ('SET SESSION TRANSACTION READ WRITE; INSERT INTO {t} VALUES (9)', 'SQL syntax'),
        ],
        'extra': [],
        'drop': ['DROP TABLE IF EXISTS {t}', 'DROP TABLE IF EXISTS {t}_new', 'DROP TABLE IF EXISTS {t}_copy'],
        'slow': 'SELECT count(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c',
        'slow_error': 'Query execution was interrupted',
        # MySQL runs a constant subquery while it plans, so this EXPLAIN sleeps; MariaDB's does not
        'slow_explain': 'SELECT * FROM (SELECT 1 a) x WHERE a = (SELECT SLEEP(30))',
        'session': 'SELECT @@SESSION.{read_only}',
        'session_default': (0,),
    },
    'clickhouse': {
        'env': 'RR_TEST_CLICKHOUSE_DSN',
        'create': 'CREATE TABLE {t} (id Int32) ENGINE = MergeTree ORDER BY id',
        'refused': [
            ('INSERT INTO {t} VALUES (9)', 'readonly mode'),
            ('CREATE TABLE {t}_new (id Int32) ENGINE = Memory', 'readonly mode'),
            ('SELECT 1 SETTINGS readonly = 0', 'readonly mode'),
            ('SELECT 1 SETTINGS max_execution_time = 0', 'readonly mode'),
            ("SELECT * FROM url('http://127.0.0.1:8123/?query=SELECT+1', CSV)", 'readonly mode'),
            ('SELECT 1; INSERT INTO {t} VALUES (9)', 'Multi-statements are not allowed'),
        ],
        'extra': [],
        'drop': ['DROP TABLE IF EXISTS {t}', 'DROP TABLE IF EXISTS {t}_new'],
        'slow': 'SELECT count() FROM numbers(1000000000000)',
        'slow_error': 'Timeout exceeded',
        'slow_explain': None,
        'session': None,
        'session_default': None,
    },
}


def _run_all(engine, statements):
    """Run the statements in one transaction and commit it.

    Args:
        engine: The engine to connect with.
        statements: The SQL statements, run in order.
    """
    with engine.begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)


@pytest.fixture(params=sorted(_LIVE))
def live(request):
    """Yield ``(global, table, case)`` for each configured server, on a one-connection pool.

    One connection means the write after the block reuses exactly the connection the block changed.

    Args:
        request: pytest's request; ``request.param`` names the server.
    """
    case = _LIVE[request.param]
    dsn = os.environ.get(case['env'])
    if not dsn:
        pytest.skip(f'Set {case["env"]} to run against a live {request.param} server')
    engine = create_engine(dsn, pool_size=1, max_overflow=0)
    table = f'rr_read_only_{uuid4().hex[:12]}'
    try:
        _run_all(engine, [statement.format(t=table) for statement in [case['create'], *case['extra']]])
        yield _global(engine), table, case
    finally:
        _run_all(engine, [statement.format(t=table) for statement in case['drop']])
        engine.dispose()


def test_live_server_reads_inside_the_block(live):
    """A read runs inside the block, so the refusals below come from the server, not from a block that runs nothing.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, table, _case = live
    with glb.read_only_connection() as conn:
        assert conn.execute(text(f'SELECT count(*) FROM {table}')).scalar() == 0


def _mysql_read_only(engine):
    """Return the name of the session variable that holds the read-only flag.

    Args:
        engine: The engine of the server.

    Returns:
        ``tx_read_only``, which every MariaDB knows, or MySQL's ``transaction_read_only``.
    """
    return 'tx_read_only' if getattr(engine.dialect, 'is_mariadb', False) else 'transaction_read_only'


def test_live_server_refuses_every_write(live):
    """Each write, lock and DDL statement is refused by the server inside the block, and the table stays empty.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, table, case = live
    for statement, refusal in case['refused']:
        with pytest.raises(Exception, match=refusal), glb.read_only_connection() as conn:
            conn.execute(text(statement.format(t=table))).fetchall()
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 0


# The helper that looks up each dialect's session before the block
_LOOKUP = {
    'postgresql': '_postgres_read_only_statements',
    'mysql': '_mysql_read_only_statements',
    'mariadb': '_mysql_read_only_statements',
    'clickhouse': '_clickhouse_read_only_statements',
}


def test_live_a_lookup_that_reads_a_table_leaves_the_write_refused(live, monkeypatch):
    """Should the session lookup ever read a table, a write in the block is still refused.

    MySQL and MariaDB open a transaction at the first table read and apply ``SET SESSION TRANSACTION READ ONLY``
    from the next one on: the block ends the lookup's transaction first, or this write would run.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
        monkeypatch: pytest's ``monkeypatch`` fixture.
    """
    glb, table, case = live
    name = _LOOKUP[glb.engine.dialect.name]
    lookup = getattr(glb, name)

    def lookup_reading_a_table(conn, timeout):
        """Read the table, then look the session up as usual.

        Args:
            conn: The block's connection.
            timeout: The time limit in seconds.

        Returns:
            What the real lookup returns.
        """
        conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar()
        return lookup(conn, timeout)

    monkeypatch.setattr(glb, name, lookup_reading_a_table)
    statement, refusal = case['refused'][0]
    with pytest.raises(Exception, match=refusal):
        with glb.read_only_connection() as conn:
            conn.execute(text(statement.format(t=table)))


def test_live_postgres_chain_needs_the_shape_check(live):
    """On PostgreSQL a COMMIT in a ;-chain leaves the read-only transaction, so is_sql_safe's chain rule must stop it.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, table, _case = live
    if glb.engine.dialect.name != 'postgresql':
        pytest.skip('this driver refuses a ;-chain: see the refused statements')
    chain = f'COMMIT; INSERT INTO {table} VALUES (9)'
    assert not is_sql_safe(chain)
    with glb.read_only_connection() as conn:
        conn.execute(text(chain))
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 1


@pytest.mark.parametrize(
    'conforming, chain',
    [
        ('on', 'SELECT 1 #2 AS a$$x$; COMMIT; INSERT INTO {t} VALUES (9); SELECT 2 AS b$$x$'),
        ('on', 'SELECT 1 #2 AS a $x$; COMMIT; INSERT INTO {t} VALUES (9); SELECT 2 AS b $x$'),
        ('on', "SELECT $é$'$é$; COMMIT; INSERT INTO {t} VALUES (9); SELECT 'x' -- '"),
        ('off', "SELECT 1 #2, 'a\\''; COMMIT; INSERT INTO {t} VALUES (9); SELECT 'x' -- '"),
    ],
)
def test_live_postgres_reads_a_chain_where_a_misread_quote_would_hide_it(live, conforming, chain):
    """PostgreSQL's lexer splits each of these into statements and the INSERT runs, so is_sql_safe must refuse them.

    Each one passed is_sql_safe while it read ``$`` and non-ASCII characters in names, and ``\\'`` with
    ``standard_conforming_strings`` off, differently from PostgreSQL.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
        conforming: The session's ``standard_conforming_strings``, ``on`` or ``off``.
        chain: The input, with ``{t}`` for the test table.
    """
    glb, table, _case = live
    if glb.engine.dialect.name != 'postgresql':
        pytest.skip('this driver refuses a ;-chain: see the refused statements')
    statement = chain.format(t=table)
    assert not is_sql_safe(statement)
    with glb.engine.connect() as conn:
        # The one pooled connection keeps this for the block below
        conn.exec_driver_sql(f'SET standard_conforming_strings = {conforming}')
        conn.commit()
    with glb.read_only_connection() as conn:
        conn.execute(text(statement))
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 1


def test_live_postgres_fails_a_backtick_before_anything_after_it_runs(live):
    """The PostgreSQL reading masks a MySQL backtick identifier, so it relies on PostgreSQL failing the backtick.

    PostgreSQL reads a backtick as an operator character and ships no operator with one, so the first
    statement fails and the chain the mask hid never runs.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, table, _case = live
    if glb.engine.dialect.name != 'postgresql':
        pytest.skip('this driver refuses a ;-chain: see the refused statements')
    chain = f'SELECT 1 ` 2; COMMIT; INSERT INTO {table} VALUES (9); SELECT ` 3'
    assert is_sql_safe(chain)
    with pytest.raises(Exception, match='operator does not exist'):
        with glb.read_only_connection() as conn:
            conn.execute(text(chain))
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 0
        assert conn.exec_driver_sql("SELECT count(*) FROM pg_operator WHERE strpos(oprname, '`') > 0").scalar() == 0


def test_live_postgres_chain_of_reads_lifts_the_time_limit(live):
    """On PostgreSQL a later SELECT of a ;-chain can switch the time limit off, so is_sql_safe refuses any chain.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
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
    """A query that would run long is stopped by the server's time limit, when it is reached.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, _table, case = live
    start = time.monotonic()
    with pytest.raises(Exception, match=case['slow_error']):
        with glb.read_only_connection() as conn:
            conn.execute(text(case['slow'])).fetchall()
    assert glb.READ_QUERY_TIMEOUT - 1 < time.monotonic() - start < glb.READ_QUERY_TIMEOUT + 10


def test_live_connection_is_ordinary_again_after_the_block(live):
    """After refused writes, the pooled connection writes again and its session settings are back.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, table, case = live
    statement, refusal = case['refused'][0]
    with pytest.raises(Exception, match=refusal):
        with glb.read_only_connection() as conn:
            conn.execute(text(statement.format(t=table)))
    with glb.engine.begin() as conn:
        conn.exec_driver_sql(f'INSERT INTO {table} VALUES (1)')
    with glb.engine.connect() as conn:
        assert conn.exec_driver_sql(f'SELECT count(*) FROM {table}').scalar() == 1
        if case['session']:
            session = case['session'].format(read_only=_mysql_read_only(glb.engine))
            assert tuple(conn.exec_driver_sql(session).one()) == case['session_default']


def test_live_explain_check_stops_near_the_limit(live):
    """The EXPLAIN check is time-limited too: on MySQL, whose planner runs a constant subquery, the limit stops it.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, _table, case = live
    if not case['slow_explain']:
        pytest.skip('this server plans the slow query without running it')
    start = time.monotonic()
    ok, message = glb._validateQuery(case['slow_explain'])
    elapsed = time.monotonic() - start
    if glb.engine.dialect.is_mariadb:
        # MariaDB plans it without running the subquery
        assert ok
        assert elapsed < glb.READ_QUERY_TIMEOUT
    else:
        assert not ok
        assert case['slow_error'] in message
        assert glb.READ_QUERY_TIMEOUT - 1 < elapsed < glb.READ_QUERY_TIMEOUT + 10


# Per server: statements that make a session read-only with a stricter limit (what a role default, the server's
# global value or init_connect can do), a read of both, what it returns, and the statements that undo them
_STRICT_SESSION = {
    'postgresql': (
        ['SET SESSION default_transaction_read_only = on', 'SET SESSION statement_timeout = 5000'],
        "SELECT current_setting('transaction_read_only'), current_setting('statement_timeout')",
        ('on', '5s'),
        ['SET SESSION default_transaction_read_only = off', 'SET SESSION statement_timeout = DEFAULT'],
    ),
    'mysql': (
        ['SET SESSION TRANSACTION READ ONLY', 'SET SESSION max_execution_time = 5000'],
        'SELECT @@SESSION.transaction_read_only, @@SESSION.max_execution_time',
        (1, 5000),
        ['SET SESSION TRANSACTION READ WRITE', 'SET SESSION max_execution_time = DEFAULT'],
    ),
    'mariadb': (
        ['SET SESSION TRANSACTION READ ONLY', 'SET SESSION max_statement_time = 5'],
        # Every MariaDB knows tx_read_only; 10.x does not know transaction_read_only
        'SELECT @@SESSION.tx_read_only, @@SESSION.max_statement_time',
        (1, 5.0),
        ['SET SESSION TRANSACTION READ WRITE', 'SET SESSION max_statement_time = DEFAULT'],
    ),
}


def test_live_a_strict_session_comes_back_as_it_was(live):
    """A pooled session that was read-only with a stricter limit is not reset to read-write and the defaults.

    Args:
        live: ``(global, table, case)`` for one live server, from the ``live`` fixture.
    """
    glb, _table, _case = live
    dialect = glb.engine.dialect
    server = 'mariadb' if getattr(dialect, 'is_mariadb', False) else dialect.name
    if server not in _STRICT_SESSION:
        pytest.skip('ClickHouse sends its settings with each query: there is no session to restore')
    strict, read, expected, undo = _STRICT_SESSION[server]
    try:
        _run_all(glb.engine, strict)
        with glb.read_only_connection() as conn:
            conn.execute(text('SELECT 1')).fetchall()
        with glb.engine.connect() as conn:
            assert tuple(conn.exec_driver_sql(read).one()) == expected
    finally:
        _run_all(glb.engine, undo)


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
        pytest.param(_WRITABLE, ('0', 0, '5', None), {'readonly': 1, 'max_execution_time': 5}, True, id='min-above'),
        pytest.param(_WRITABLE, ('5', 0, '5', None), {'readonly': 1}, True, id='min-above-is-the-profile-limit'),
        pytest.param(_WRITABLE, ('1.5', 0, None, None), {'readonly': 1}, False, id='stricter-profile-limit'),
        pytest.param(_WRITABLE, ('0', 1, None, None), {'readonly': 1}, True, id='const-limit'),
    ],
)
def test_clickhouse_sends_only_the_settings_the_profile_allows(
    monkeypatch, readonly, max_execution_time, settings, warns
):
    """A setting the user may not change fails every query, a looser limit would replace the profile's: neither is sent.

    A query that runs with no limit or a longer one than the node's gets one warning, also over several blocks.

    Args:
        monkeypatch: pytest's ``monkeypatch`` fixture.
        readonly: The ``readonly`` row of ``system.settings``: ``(value, readonly, min, max)``.
        max_execution_time: The ``max_execution_time`` row of ``system.settings``: ``(value, readonly, min, max)``.
        settings: The settings the node should send with each query.
        warns: Whether the node should warn that the query runs with no limit or a longer one.
    """
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    glb = _global(None)
    conn = _ProfileConnection(readonly, max_execution_time)

    assert glb._clickhouse_read_settings(conn, 2) == settings
    assert glb._clickhouse_read_settings(conn, 2) == settings
    assert conn.lookups == 2
    assert len(warnings) == (1 if warns else 0)
    if warns:
        assert 'max_execution_time' in warnings[0] and 'CHANGEABLE_IN_READONLY' in warnings[0]


def test_clickhouse_settings_follow_a_profile_changed_while_the_node_runs(monkeypatch):
    """A profile changed from readonly=1 to writable gets readonly=1 sent from the next block on.

    Args:
        monkeypatch: pytest's ``monkeypatch`` fixture.
    """
    monkeypatch.setattr('ai.common.database.db_global_base.warning', lambda message: None)
    glb = _global(None)
    conn = _ProfileConnection(_READONLY_1, ('1', 1, None, None))
    assert glb._clickhouse_read_settings(conn, 2) == {}

    conn.rows = [('readonly', *_WRITABLE), ('max_execution_time', '1', 0, None, None)]
    assert glb._clickhouse_read_settings(conn, 2) == {'readonly': 1}


def test_clickhouse_writes_each_new_warning(monkeypatch):
    """The warning is written again when the limit the query runs under changes, not for every block.

    Args:
        monkeypatch: pytest's ``monkeypatch`` fixture.
    """
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    glb = _global(None)
    conn = _ProfileConnection(_READONLY_1, ('0', 1, None, None))
    glb._clickhouse_read_settings(conn, 2)
    glb._clickhouse_read_settings(conn, 2)
    conn.rows = [('readonly', *_READONLY_1), ('max_execution_time', '300', 1, None, None)]
    glb._clickhouse_read_settings(conn, 2)

    assert len(warnings) == 2
    assert 'unlimited' in warnings[0] and '300 s' in warnings[1]


# Profiles of the live users: (SETTINGS clause, the time limit a query runs under, whether the node warns)
_LIVE_PROFILES = [
    pytest.param('readonly = 1', 0, True, id='readonly1'),
    pytest.param('readonly = 1, max_execution_time MIN 1 MAX 60 CHANGEABLE_IN_READONLY', 2, False, id='changeable'),
    pytest.param('readonly = 2', 2, False, id='readonly2'),
    pytest.param('max_execution_time MAX 1', 1, False, id='max-below'),
    pytest.param('max_execution_time = 1', 1, False, id='stricter-profile-limit'),
    pytest.param('max_execution_time = 0 CONST', 0, True, id='const-limit'),
    pytest.param('max_execution_time MIN 5', 5, True, id='min-above'),
]


def _create_writing_user(admin, user, password, profile, database):
    """Create a ClickHouse user with ``profile`` that may create tables in ``database`` and insert into them.

    The user may write, so a refused write is the read-only setting, not a missing grant.

    Args:
        admin: An engine whose user may create users.
        user: The new user's name.
        password: Its password.
        profile: The ``SETTINGS`` clause of its profile.
        database: The database it may write to.

    Returns:
        ``(created, error)``: whether ``CREATE USER`` ran, and what stopped the setup, or None.
    """
    created = False
    try:
        with admin.connect() as conn:
            conn.exec_driver_sql(
                f"CREATE USER {user} IDENTIFIED WITH sha256_password BY '{password}' SETTINGS {profile}"
            )
            created = True
            conn.exec_driver_sql(f'GRANT CREATE TABLE, INSERT ON {database}.* TO {user}')
    except Exception as e:  # noqa: BLE001 - each server says no in its own way
        return created, e
    return created, None


def _drop_writing_user(admin, user, database):
    """Drop the user, and the table that is there only if the read-only setting failed to refuse it.

    Args:
        admin: An engine whose user may drop users.
        user: The user's name.
        database: The database it could write to.
    """
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP TABLE IF EXISTS {database}.{user}_t')
        conn.exec_driver_sql(f'DROP USER IF EXISTS {user}')


@pytest.mark.parametrize(('profile', 'limit', 'warns'), _LIVE_PROFILES)
def test_live_clickhouse_profiles_run_read_only(monkeypatch, profile, limit, warns):
    """A ClickHouse user with each kind of profile runs a query read-only, under the strictest limit it may have.

    Args:
        monkeypatch: pytest's ``monkeypatch`` fixture.
        profile: The ``SETTINGS`` clause of the test user's profile.
        limit: The time limit in seconds the query should run under, 0 for none.
        warns: Whether the node should warn that the query runs with no limit or a longer one.
    """
    dsn = os.environ.get('RR_TEST_CLICKHOUSE_DSN')
    if not dsn:
        pytest.skip('Set RR_TEST_CLICKHOUSE_DSN to run against a live ClickHouse server')
    warnings = []
    monkeypatch.setattr('ai.common.database.db_global_base.warning', warnings.append)
    admin = create_engine(dsn)
    user, password = f'rr_profile_{uuid4().hex[:12]}', uuid4().hex
    database = make_url(dsn).database
    created, engine = False, None
    try:
        created, error = _create_writing_user(admin, user, password, profile, database)
        if error is not None:
            pytest.skip(f'The DSN user cannot create a user and let it write: {error}')
        engine = create_engine(make_url(dsn).set(username=user, password=password))
        glb = _global(engine)
        with glb.read_only_connection() as conn:
            row = conn.exec_driver_sql("SELECT getSetting('readonly'), getSetting('max_execution_time')").one()
        assert int(row[0]) >= 1
        assert float(row[1]) == limit
        assert len(warnings) == (1 if warns else 0)
        with pytest.raises(Exception, match='readonly mode'), glb.read_only_connection() as conn:
            conn.exec_driver_sql(f'CREATE TABLE {user}_t (id Int32) ENGINE = Memory')
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            _drop_writing_user(admin, user, database)
        admin.dispose()


# Queries whose SETTINGS clause the PostgreSQL and MySQL readings take for a literal or a comment; {get} reads the limit
_CLICKHOUSE_HIDDEN_SETTINGS = [
    pytest.param("SELECT \u2018'\u2019 AS s, {get} SETTINGS max_execution_time = 7 --'", id='curly-string'),
    pytest.param('SELECT {get} SETTINGS \u201cmax_execution_time\u201d = 7', id='curly-name'),
    pytest.param('SELECT {get} SETTINGS`max_execution_time`=7', id='backtick-name-after-the-keyword'),
    pytest.param('SELECT {get} SETTINGS"max_execution_time"=7', id='quoted-name-after-the-keyword'),
    pytest.param("SELECT {get} // '\nSETTINGS max_execution_time = 7 --'", id='slash-comment'),
    pytest.param(
        "SELECT $1$'$1$ AS s, {get} SETTINGS max_execution_time = 7 --'", id='heredoc-tag-starting-with-a-digit'
    ),
]


@pytest.mark.parametrize('template', _CLICKHOUSE_HIDDEN_SETTINGS)
def test_live_clickhouse_runs_a_settings_clause_the_other_readings_miss(template):
    """A readonly=2 user lifts the node's time limit with each of these, so is_sql_safe must refuse them.

    The query runs on the node's read-only connection: without the clause it gets the node's limit, with it the
    query's own value replaces that limit.

    Args:
        template: The query, with ``{get}`` for the column that reads the time limit.
    """
    dsn = os.environ.get('RR_TEST_CLICKHOUSE_DSN')
    if not dsn:
        pytest.skip('Set RR_TEST_CLICKHOUSE_DSN to run against a live ClickHouse server')
    statement = template.format(get="getSetting('max_execution_time') AS t")
    assert not is_sql_safe(statement)
    admin = create_engine(dsn)
    user, password = f'rr_settings_{uuid4().hex[:12]}', uuid4().hex
    database = make_url(dsn).database
    created, engine = False, None
    try:
        created, error = _create_writing_user(admin, user, password, 'readonly = 2', database)
        if error is not None:
            pytest.skip(f'The DSN user cannot create a user: {error}')
        engine = create_engine(make_url(dsn).set(username=user, password=password))
        with _global(engine).read_only_connection() as conn:
            limit = conn.exec_driver_sql("SELECT getSetting('max_execution_time')").scalar()
            lifted = conn.exec_driver_sql(statement).one()
        assert float(limit) == _Global.READ_QUERY_TIMEOUT
        assert float(lifted[-1]) == 7
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            _drop_writing_user(admin, user, database)
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
