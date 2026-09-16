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

"""Tests for begin/commit/rollback tool functions and session-aware execute."""

import contextlib
import types

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import StaticPool

from ai.common.database.db_global_base import DatabaseGlobalBase
from ai.common.database.db_instance_base import DatabaseInstanceBase
from ai.common.database.tx_registry import TransactionRegistry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _engine_shared():
    """In-memory SQLite engine with a shared StaticPool connection (like test_tx_registry)."""
    e = create_engine(
        'sqlite://',
        connect_args={'check_same_thread': False},
        poolclass=StaticPool,
    )
    with e.begin() as c:
        c.execute(text('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'))
    return e


def _make_iglobal(*, allow_execute: bool, engine=None):
    """Build a minimal IGlobal stub with a real TransactionRegistry."""
    if engine is None:
        engine = _engine_shared()
    registry = TransactionRegistry(engine, max_rows=1000)
    iglobal = types.SimpleNamespace(
        allow_execute=allow_execute,
        max_execute_rows=1000,
        engine=engine,
        tx_registry=registry,
    )
    # A failed stateless execute formats the driver error through IGlobal, so
    # the stub borrows the real implementation. Without it the failure path
    # dies with AttributeError instead of raising the RuntimeError under test.
    iglobal._format_db_error = types.MethodType(DatabaseGlobalBase._format_db_error, iglobal)
    return iglobal


def _make_instance(iglobal):
    """Instantiate a concrete DatabaseInstanceBase subclass with the given IGlobal."""

    class _Concrete(DatabaseInstanceBase):
        def _db_display_name(self):
            return 'TestDB'

        def _db_dialect(self):
            return 'sqlite'

    inst = _Concrete.__new__(_Concrete)
    inst.IGlobal = iglobal
    return inst


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def instance_with_execute_disabled():
    iglobal = _make_iglobal(allow_execute=False)
    return _make_instance(iglobal)


@pytest.fixture
def instance_with_sqlite_registry():
    iglobal = _make_iglobal(allow_execute=True)
    return _make_instance(iglobal)


# ---------------------------------------------------------------------------
# (a) Gate enforcement: all tx tools refuse when allow_execute=False
# ---------------------------------------------------------------------------


def test_begin_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.begin({})


def test_commit_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.commit({'session_id': 'fake'})


def test_rollback_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.rollback({'session_id': 'fake'})


def test_execute_with_session_id_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.execute({'sql': 'SELECT 1', 'session_id': 'fake'})


# ---------------------------------------------------------------------------
# (b) Full roundtrip: begin → execute(INSERT with params) → commit → stateless SELECT
# ---------------------------------------------------------------------------


def test_session_roundtrip(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['z'], 'session_id': sid})
    inst.commit({'session_id': sid})
    out = inst.execute({'sql': 'SELECT v FROM t'})
    assert out['rows'] == [{'v': 'z'}]


def test_begin_returns_session_id(instance_with_sqlite_registry):
    result = instance_with_sqlite_registry.begin({})
    assert 'session_id' in result
    assert isinstance(result['session_id'], str)
    assert len(result['session_id']) > 0


def test_commit_returns_ok(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    result = inst.commit({'session_id': sid})
    assert result == {'ok': True}


# ---------------------------------------------------------------------------
# (c) Rollback discards uncommitted rows
# ---------------------------------------------------------------------------


def test_rollback_discards_row(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['should_vanish'], 'session_id': sid})
    result = inst.rollback({'session_id': sid})
    assert result == {'ok': True}
    # Stateless read should see no rows
    out = inst.execute({'sql': 'SELECT v FROM t'})
    assert out['rows'] == []
    # The session is invalidated after rollback: reusing the sid must error
    # (mirrors the post-reap invalidation in test_reap_idle_rolls_back).
    with pytest.raises(ValueError):
        inst.execute({'sql': 'SELECT 1', 'session_id': sid})
    with pytest.raises(ValueError):
        inst.commit({'session_id': sid})


def test_stateless_execute_overflow_rolls_back_write(instance_with_sqlite_registry):
    """A non-session write whose RETURNING overflows max_execute_rows must roll back.

    Regression: _executeRawQuery used to log + return None inside engine.begin(),
    so the write committed even though execute() raised.
    """
    inst = instance_with_sqlite_registry
    inst.IGlobal.max_execute_rows = 0  # any RETURNING row overflows
    with pytest.raises(RuntimeError, match='max_execute_rows'):
        inst.execute({'sql': "INSERT INTO t (v) VALUES ('rollback_me') RETURNING v"})
    # The overflowing write must NOT have persisted.
    inst.IGlobal.max_execute_rows = 1000
    out = inst.execute({'sql': 'SELECT v FROM t'})
    assert out['rows'] == []


def test_session_execute_overflow_keeps_session_alive(instance_with_sqlite_registry):
    """A session-bound execute that overflows leaves the session open.

    The failed statement does not auto-destroy the session: the client owns
    recovery via an explicit rollback (or `rollback to savepoint`), so the
    connection stays pinned until the client releases it or the idle reaper
    reclaims it.
    """
    inst = instance_with_sqlite_registry
    # 0-row cap so a session RETURNING overflows.
    inst.IGlobal.tx_registry = TransactionRegistry(inst.IGlobal.engine, max_rows=0)
    sid = inst.begin({})['session_id']
    with pytest.raises(RuntimeError, match='max_rows'):
        inst.execute({'sql': "INSERT INTO t (v) VALUES ('x') RETURNING v", 'session_id': sid})
    # The session survives the failed statement: an explicit rollback succeeds.
    assert inst.rollback({'session_id': sid}) == {'ok': True}


def test_failed_statement_keeps_session_alive(instance_with_sqlite_registry):
    """A syntactically invalid statement leaves the session open for recovery."""
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    with pytest.raises(Exception):
        inst.execute({'sql': 'select broken', 'session_id': sid})
    # Session must still exist: rollback succeeds instead of ValueError.
    assert inst.rollback({'session_id': sid}) == {'ok': True}


# ---------------------------------------------------------------------------
# (d) execute with unknown session_id raises ValueError
# ---------------------------------------------------------------------------


def test_stateless_execute_surfaces_the_driver_error(instance_with_sqlite_registry):
    """A bad statement outside a session raises with the database's own message.

    Also pins the fixture: execute()'s failure path calls IGlobal._format_db_error,
    so an IGlobal stub without it fails with AttributeError instead. The tail
    assertions are the load-bearing half: a test that only matched the
    'SQL execution failed: ' prefix would also pass against a message that
    still carried the statement, because the driver text comes first.
    """
    with pytest.raises(RuntimeError) as excinfo:
        instance_with_sqlite_registry.execute(
            {'sql': 'SELECT * FROM no_such_table WHERE v = $1', 'params': ['ada@example.com']}
        )

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: ')
    assert 'no_such_table' in message
    assert 'ada@example.com' not in message
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


def test_session_execute_surfaces_the_driver_error(instance_with_sqlite_registry):
    """The session-bound half of execute owes the caller the same contract.

    ``TransactionRegistry.execute`` has no try/except, so before this fix the
    raw SQLAlchemy exception reached the caller of the same tool, behind the
    same allow_execute gate, with the ``[SQL: ...]`` / ``[parameters: ...]``
    tail the sessionless half strips.
    """
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']

    with pytest.raises(RuntimeError) as excinfo:
        inst.execute({'sql': 'SELECT * FROM no_such_table', 'session_id': sid})

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: ')
    assert 'no_such_table' in message
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


def test_session_execute_error_does_not_echo_bound_parameters(instance_with_sqlite_registry):
    """A value the caller bound must not come back inside the error message."""
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']

    with pytest.raises(RuntimeError) as excinfo:
        inst.execute(
            {'sql': 'SELECT * FROM no_such_table WHERE v = $1', 'params': ['ada@example.com'], 'session_id': sid}
        )

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: ')
    assert 'ada@example.com' not in message
    assert '[parameters:' not in message


def test_session_execute_failure_leaves_the_session_open(instance_with_sqlite_registry):
    """The formatted error is raised and the session stays open for the client to recover.

    The formatting is this PR's; the lifecycle is develop's (#1908): a failed
    statement no longer releases the session, so the client recovers with an
    explicit ``rollback`` (or ``rollback to savepoint``) and the registry is
    what refuses to commit an aborted transaction.
    """
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']

    with pytest.raises(RuntimeError, match='SQL execution failed: '):
        inst.execute({'sql': 'SELECT * FROM no_such_table', 'session_id': sid})

    assert inst.rollback({'session_id': sid}) == {'ok': True}


def test_session_execute_returns_rows_on_success(instance_with_sqlite_registry):
    """The success path through the session is unchanged by the error arm."""
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    assert inst.execute({'sql': 'SELECT 1 AS one', 'session_id': sid}) == {'rows': [{'one': 1}], 'affected_rows': 0}
    inst.rollback({'session_id': sid})


def test_execute_unknown_session_id_raises_value_error(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='unknown or expired transaction session'):
        instance_with_sqlite_registry.execute({'sql': 'SELECT 1', 'session_id': 'no-such-session'})


def test_commit_unknown_session_id_raises_value_error(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='unknown or expired transaction session'):
        instance_with_sqlite_registry.commit({'session_id': 'no-such-session'})


def test_rollback_unknown_session_id_raises_value_error(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='unknown or expired transaction session'):
        instance_with_sqlite_registry.rollback({'session_id': 'no-such-session'})


# ---------------------------------------------------------------------------
# (e) Both halves of execute report a driver failure identically
#
# Mock-based by necessity: the drivers whose messages quote literals
# (PostgreSQL, MySQL) are not available in this suite, so their exception
# shapes are reproduced and wrapped the way SQLAlchemy wraps a real one.
# ---------------------------------------------------------------------------


class _FakeDriverError(Exception):
    """Stand-in for a DBAPI driver exception (psycopg2 / pymysql shapes)."""


class _FailingConnection:
    """Connection stand-in whose execute() always raises the given exception."""

    def __init__(self, exc, inner=None):
        self._exc = exc
        self._inner = inner

    def execute(self, *args, **kwargs):
        """Fail the way a driver fails, with the statement already bound."""
        raise self._exc

    def close(self):
        """Release the real connection this stands in front of, if any."""
        if self._inner is not None:
            self._inner.close()


class _FailingEngine:
    """Engine stand-in whose begin() hands out a connection that always raises."""

    def __init__(self, exc):
        self._exc = exc

    @contextlib.contextmanager
    def begin(self):
        """Yield the failing connection, mirroring engine.begin()'s contract."""
        yield _FailingConnection(self._exc)


def _postgres_duplicate_key():
    """A psycopg2-shaped unique violation, wrapped as SQLAlchemy would wrap it."""
    orig = _FakeDriverError(
        'duplicate key value violates unique constraint "users_email_key"\n'
        'DETAIL:  Key (email)=(ada@example.com) already exists.\n'
    )
    orig.diag = types.SimpleNamespace(
        message_primary='duplicate key value violates unique constraint "users_email_key"'
    )
    orig.pgcode = '23505'
    return DBAPIError.instance(
        'INSERT INTO users (email) VALUES (%(email)s)',
        {'email': 'ada@example.com'},
        orig,
        dbapi_base_err=Exception,
    )


def _mysql_duplicate_entry():
    """A pymysql-shaped duplicate entry, wrapped as SQLAlchemy would wrap it."""
    orig = _FakeDriverError(1062, "Duplicate entry 'ada@example.com' for key 'users.email'")
    return DBAPIError.instance(
        'INSERT INTO users (email) VALUES (%s)',
        ('ada@example.com',),
        orig,
        dbapi_base_err=Exception,
    )


@pytest.mark.parametrize(
    ('build_error', 'expected'),
    [
        (
            _postgres_duplicate_key,
            'SQL execution failed: Error 23505: duplicate key value violates unique constraint "users_email_key"',
        ),
        (
            _mysql_duplicate_entry,
            "SQL execution failed: Error 1062: Duplicate entry 'ada@example.com' for key 'users.email'",
        ),
    ],
    ids=['postgres', 'mysql'],
)
def test_both_execute_paths_report_a_driver_failure_identically(instance_with_sqlite_registry, build_error, expected):
    """One tool, one gate, one error contract -- whether or not a session is used.

    The PostgreSQL case also pins what the policy does and does not hide: the
    DETAIL block restating the key value is dropped, while MySQL's primary
    sentence keeps the value the caller itself submitted. In both cases the
    statement and the bind list stay in the server log.
    """
    inst = instance_with_sqlite_registry
    real_engine = inst.IGlobal.engine

    sid = inst.begin({})['session_id']
    held = inst.IGlobal.tx_registry._sessions[sid]
    held.conn = _FailingConnection(build_error(), inner=held.conn)
    with pytest.raises(RuntimeError) as session_exc:
        inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['ada@example.com'], 'session_id': sid})

    inst.IGlobal.engine = _FailingEngine(build_error())
    try:
        with pytest.raises(RuntimeError) as stateless_exc:
            inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['ada@example.com']})
    finally:
        inst.IGlobal.engine = real_engine

    session_message = str(session_exc.value)
    stateless_message = str(stateless_exc.value)
    assert session_message == stateless_message == expected
    for message in (session_message, stateless_message):
        assert '[SQL:' not in message
        assert '[parameters:' not in message
        assert 'sqlalche.me' not in message
        assert 'DETAIL' not in message


def test_session_execute_passes_the_primary_sentence_through_verbatim(instance_with_sqlite_registry):
    """The session half gives the same real contract as the sessionless one.

    The twin of ``test_execute_error_passes_the_primary_sentence_through_verbatim``
    in tests/ai/common/database/test_db_execute_errors.py: a real SQLite
    syntax error, whose primary sentence quotes the statement fragment it
    failed on, with SQLAlchemy's statement/parameter tail removed.
    """
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']

    with pytest.raises(RuntimeError) as excinfo:
        inst.execute({'sql': "INSERT INTO t VALUES 'hunter2'", 'session_id': sid})

    message = str(excinfo.value)
    assert message == 'SQL execution failed: near "\'hunter2\'": syntax error'
    assert 'hunter2' in message  # the fragment is documented, not stripped
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


# ---------------------------------------------------------------------------
# (f) A driver error the dialect does NOT wrap in a SQLAlchemy exception
#
# Constructed shape; driver not installed. clickhouse-sqlalchemy's native
# connector (the one `clickhouse+native://` selects) raises its own
# `DatabaseException` -- a plain Exception subclass carrying the driver's
# ServerException in `.orig` -- and SQLAlchemy does not wrap a non-DBAPI
# exception, so `except SQLAlchemyError` never fires for that node. The classes
# below are shaped exactly like that pair.
# ---------------------------------------------------------------------------


class _StandInServerException(Exception):
    """Stand-in for clickhouse_driver.errors.ServerException."""

    def __init__(self, code, message, trailer=''):
        super().__init__(message)
        self.code = code
        self.message = message
        self._trailer = trailer

    def __str__(self):
        """Render the driver's ``Code: N.`` form, stack trace included."""
        return (
            f'Code: {self.code}.\n{self.message}{self._trailer}. '
            'Stack trace:\n\n0. DB::Exception::Exception(...) @ 0x1a2b3c\n'
        )


class _StandInDatabaseException(Exception):
    """Stand-in for clickhouse_sqlalchemy.exceptions.DatabaseException."""

    def __init__(self, orig):
        super().__init__(orig)
        self.orig = orig

    def __str__(self):
        """Prefix the wrapped driver error, as the real class does."""
        return f'Orig exception: {self.orig}'


def _clickhouse_syntax_error():
    """A ClickHouse syntax error, wrapped the way its connector wraps one."""
    return _StandInDatabaseException(
        _StandInServerException(62, 'Syntax error', trailer=": failed at position 21 ('hunter2') (line 1, col 21)")
    )


@pytest.mark.parametrize('use_session', [False, True], ids=['sessionless', 'session'])
def test_both_paths_format_a_driver_error_sqlalchemy_did_not_wrap(instance_with_sqlite_registry, use_session):
    """The contract must not depend on whether the dialect raises a DBAPI error.

    Constructed shape; clickhouse-sqlalchemy is not installed here. Without an
    arm for it the caller got `Orig exception: Code: 62.` followed by the
    server stack trace and the statement fragment the parser stopped on.
    """
    inst = instance_with_sqlite_registry
    real_engine = inst.IGlobal.engine

    if use_session:
        sid = inst.begin({})['session_id']
        held = inst.IGlobal.tx_registry._sessions[sid]
        held.conn = _FailingConnection(_clickhouse_syntax_error(), inner=held.conn)
        args = {'sql': "INSERT INTO t VALUES 'hunter2'", 'session_id': sid}
    else:
        inst.IGlobal.engine = _FailingEngine(_clickhouse_syntax_error())
        args = {'sql': "INSERT INTO t VALUES 'hunter2'"}

    try:
        with pytest.raises(RuntimeError) as excinfo:
            inst.execute(args)
    finally:
        inst.IGlobal.engine = real_engine

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: Error 62: ')
    assert 'Stack trace' not in message
    assert 'failed at position' not in message
    assert "('hunter2')" not in message
    assert 'Orig exception' not in message

    if use_session:
        # The session stays open on this path too, as it does for a wrapped error.
        assert inst.rollback({'session_id': sid}) == {'ok': True}


@pytest.mark.parametrize('use_session', [False, True], ids=['sessionless', 'session'])
def test_an_exception_without_orig_is_not_treated_as_a_database_error(instance_with_sqlite_registry, use_session):
    """The new arm keys on ``.orig``, so it must not swallow anything else.

    A programming error inside the driver is not a statement failure and must
    reach the caller unchanged. The max-rows ``RuntimeError`` is the other
    member of this class and is covered by
    ``test_stateless_execute_overflow_rolls_back_write`` and
    ``test_session_execute_overflow_keeps_session_alive``.
    """
    inst = instance_with_sqlite_registry
    real_engine = inst.IGlobal.engine
    boom = ValueError('driver bug, not a database error')

    if use_session:
        sid = inst.begin({})['session_id']
        held = inst.IGlobal.tx_registry._sessions[sid]
        held.conn = _FailingConnection(boom, inner=held.conn)
        args = {'sql': 'SELECT 1', 'session_id': sid}
    else:
        inst.IGlobal.engine = _FailingEngine(boom)
        args = {'sql': 'SELECT 1'}

    try:
        with pytest.raises(ValueError) as excinfo:
            inst.execute(args)
    finally:
        inst.IGlobal.engine = real_engine

    assert str(excinfo.value) == 'driver bug, not a database error'
    assert 'SQL execution failed' not in str(excinfo.value)


# ---------------------------------------------------------------------------
# (g) A malformed `params` argument must be rejected, not misreported
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('use_session', [False, True], ids=['sessionless', 'session'])
def test_params_must_be_an_array(instance_with_sqlite_registry, use_session):
    """A JSON object for `params` used to surface as the wrong error entirely.

    `to_sqlalchemy_text` indexes `params[n - 1]`, so a dict raised `KeyError:
    0` -- which the session path's `except KeyError` reported as "unknown or
    expired transaction session" while the session was in fact still open, and
    which escaped the sessionless path as a bare KeyError.
    """
    inst = instance_with_sqlite_registry
    args = {'sql': 'SELECT * FROM t WHERE v = $1', 'params': {'v': 'x'}}
    if use_session:
        args['session_id'] = inst.begin({})['session_id']

    with pytest.raises(ValueError, match='"params" must be an array'):
        inst.execute(args)

    if use_session:
        # The session was never touched, so it is still usable.
        assert inst.execute({'sql': 'SELECT 1 AS one', 'session_id': args['session_id']})['rows'] == [{'one': 1}]
        inst.rollback({'session_id': args['session_id']})


@pytest.mark.parametrize('use_session', [False, True], ids=['sessionless', 'session'])
def test_params_must_cover_every_placeholder(instance_with_sqlite_registry, use_session):
    """Too few values used to raise a bare IndexError from inside the rewriter."""
    inst = instance_with_sqlite_registry
    args = {'sql': 'SELECT * FROM t WHERE v = $1 OR v = $2', 'params': ['only-one']}
    if use_session:
        args['session_id'] = inst.begin({})['session_id']

    with pytest.raises(ValueError) as excinfo:
        inst.execute(args)

    message = str(excinfo.value)
    assert '$2' in message  # the placeholder that has no value
    assert 'out of range' in message

    if use_session:
        assert inst.execute({'sql': 'SELECT 1 AS one', 'session_id': args['session_id']})['rows'] == [{'one': 1}]
        inst.rollback({'session_id': args['session_id']})


def test_params_are_still_bound_when_they_cover_the_placeholders(instance_with_sqlite_registry):
    """The check must not get in the way of a well-formed call."""
    inst = instance_with_sqlite_registry
    inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['kept']})
    assert inst.execute({'sql': 'SELECT v FROM t WHERE v = $1', 'params': ['kept']})['rows'] == [{'v': 'kept'}]
    # A statement with no placeholders and no params is unaffected.
    assert inst.execute({'sql': 'SELECT 2 AS two'})['rows'] == [{'two': 2}]


# ---------------------------------------------------------------------------
# (h) row_mode='array' — positional rows for ORM clients (Drizzle)
# ---------------------------------------------------------------------------


def test_execute_tool_array_row_mode(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    inst.execute({'sql': "INSERT INTO t (id, v) VALUES (1, 'x')"})
    inst.execute({'sql': "INSERT INTO t (id, v) VALUES (2, 'y')"})
    result = inst.execute({'sql': 'SELECT id, v FROM t ORDER BY id', 'row_mode': 'array'})
    assert result['rows'] == [[1, 'x'], [2, 'y']]
    assert all(isinstance(r, list) for r in result['rows'])


def test_execute_tool_session_array_row_mode(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    inst.execute({'sql': "INSERT INTO t (id, v) VALUES (1, 'x')", 'session_id': sid})
    result = inst.execute({'sql': 'SELECT id, v FROM t ORDER BY id', 'session_id': sid, 'row_mode': 'array'})
    inst.rollback({'session_id': sid})
    assert result['rows'] == [[1, 'x']]


def test_execute_tool_rejects_bad_row_mode(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='row_mode'):
        instance_with_sqlite_registry.execute({'sql': 'SELECT 1', 'row_mode': 'csv'})


def test_execute_tool_rejects_falsy_row_mode(instance_with_sqlite_registry):
    # '' violates the declared enum; only an ABSENT field defaults to 'object'.
    with pytest.raises(ValueError, match='row_mode'):
        instance_with_sqlite_registry.execute({'sql': 'SELECT 1', 'row_mode': ''})


# ---------------------------------------------------------------------------
# (i) _sanitize_value JSON-encodes dicts and lists (psycopg2 json/jsonb parse)
# ---------------------------------------------------------------------------


def test_sanitize_value_json_encodes_dicts():
    """Dict values must be JSON-encoded, not Python repr'd."""
    result = DatabaseInstanceBase._sanitize_value({'a': 1})
    assert result == '{"a": 1}'


def test_sanitize_value_json_encodes_lists():
    """List values must be JSON-encoded, not Python repr'd."""
    result = DatabaseInstanceBase._sanitize_value([1, 'x'])
    assert result == '[1, "x"]'


def test_sanitize_value_json_encodes_nested_with_fallback():
    """Nested non-JSON types fall back to str via default=str."""
    import datetime

    result = DatabaseInstanceBase._sanitize_value({'t': datetime.date(2026, 1, 1)})
    assert '"2026-01-01"' in result


def test_sanitize_value_json_encodes_tuples():
    """Tuple values (psycopg2 composite types) must be JSON-encoded."""
    result = DatabaseInstanceBase._sanitize_value((1, 'x'))
    assert result == '[1, "x"]'


@pytest.mark.parametrize('use_session', [False, True], ids=['sessionless', 'session'])
def test_a_dollar_number_inside_a_string_literal_is_not_a_placeholder(instance_with_sqlite_registry, use_session):
    """The rewriter is quote-aware, so no pre-pass may reject `$5` inside a literal.

    `to_sqlalchemy_text` skips `$n` in string literals, quoted identifiers,
    dollar-quoted bodies and comments; the placeholder pre-pass this PR used to
    run before dispatch did not, and rejected this statement on both paths.
    """
    inst = instance_with_sqlite_registry
    args = {'sql': "SELECT '$5' AS v", 'params': ['x']}
    if use_session:
        args['session_id'] = inst.begin({})['session_id']

    assert inst.execute(args)['rows'] == [{'v': '$5'}]

    if use_session:
        inst.rollback({'session_id': args['session_id']})
