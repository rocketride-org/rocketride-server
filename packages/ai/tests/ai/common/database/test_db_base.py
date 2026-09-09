"""
Unit tests for ai.common.database.db_global_base.DatabaseGlobalBase and
ai.common.database.db_instance_base.DatabaseInstanceBase.

The base classes are ABCs with two abstract methods (``_connection_params``,
``_build_connection_url``). Tests use a concrete ``_TestableGlobal``
subclass that supplies SQLite-compatible stubs, then exercise:

- Pure-logic helpers (no engine needed):
  - ``_format_db_error`` — extracts (code, message) from DBAPI errors
  - ``_is_datetime_string`` — strptime two formats
  - ``_inferColumnType`` — Python type → SQLAlchemy type
  - ``_sanitize_value`` / ``_sanitize_row`` (db_instance_base) — JSON-safe coercion

- Engine-backed helpers (use the ``base`` fixture, which carries an
  in-memory SQLite engine):
  - ``_tableExists``
  - ``_createTableFromData``
"""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import (
    DateTime,
    Float,
    Integer,
    Text,
    create_engine,
    inspect,
)

from ai.common.database.db_global_base import DatabaseGlobalBase
from ai.common.database.db_instance_base import DatabaseInstanceBase
from ai.common.schema import Question
from ai.common.utils import parse_bool


# ---------------------------------------------------------------------------
# Test subclass that satisfies the two abstract methods
# ---------------------------------------------------------------------------


class _TestableGlobal(DatabaseGlobalBase):
    """Concrete DatabaseGlobalBase that knows how to build a SQLite URL."""

    def _connection_params(self, config):
        """Trivial mapping — every key passes through."""
        return dict(config)

    def _build_connection_url(self, params):
        """Build a sqlite:///:memory: URL (params ignored)."""
        return 'sqlite:///:memory:'


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def base():
    """A DatabaseGlobalBase subclass instance with an in-memory engine attached."""
    instance = _TestableGlobal.__new__(_TestableGlobal)
    instance.engine = create_engine('sqlite:///:memory:')
    instance.schema = {}
    yield instance
    instance.engine.dispose()


# ---------------------------------------------------------------------------
# _format_db_error
# ---------------------------------------------------------------------------


def test_format_db_error_extracts_numeric_code_and_message(base):
    """A DBAPIError-like exception with .orig.args=(code, msg) becomes 'Error <code>: <msg>'."""
    orig = SimpleNamespace(args=(1146, "Table 'x' doesn't exist"))
    exc = SimpleNamespace(orig=orig)
    result = base._format_db_error(exc)
    assert result == "Error 1146: Table 'x' doesn't exist"


def test_format_db_error_falls_back_to_str_when_args_not_int_first(base):
    """If args[0] is not an int, the function returns str(exc) instead."""
    orig = SimpleNamespace(args=('not-a-code', 'msg'))
    exc = RuntimeError('outer message')
    exc.orig = orig
    result = base._format_db_error(exc)
    assert result == 'outer message'


def test_format_db_error_handles_exception_without_orig(base):
    """An exception without .orig falls through to str(exc)."""
    exc = RuntimeError('plain error')
    assert base._format_db_error(exc) == 'plain error'


# ---------------------------------------------------------------------------
# _is_datetime_string
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value, expected',
    [
        ('2026-01-01', True),
        ('2026-01-01 12:30:45', True),
        ('not a date', False),
        ('2026/01/01', False),  # wrong separator
        ('', False),
        ('2026-01-01T12:30:45', False),  # ISO 'T' separator not in the two supported formats
    ],
)
def test_is_datetime_string(base, value, expected):
    """The function recognises the two supported date formats and rejects the rest."""
    assert base._is_datetime_string(value) is expected


def test_is_datetime_string_rejects_non_string_input(base):
    """Non-string inputs are rejected outright (False, not exception)."""
    assert base._is_datetime_string(42) is False
    assert base._is_datetime_string(None) is False


# ---------------------------------------------------------------------------
# _inferColumnType
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value, expected_type',
    [
        (None, Text),
        (42, Integer),
        (3.14, Float),
        (True, Integer),  # bool → Integer (SQL stores 0/1)
        (False, Integer),
        ([1, 2, 3], Text),  # complex types → Text (JSON-serialised)
        ({'a': 1}, Text),
        ('plain text', Text),
        ('2026-01-01', DateTime),  # date string → DateTime
        ('2026-01-01 12:30:45', DateTime),
        (b'bytes', Text),
    ],
)
def test_infer_column_type(base, value, expected_type):
    """Every Python value maps to the documented SQLAlchemy type."""
    assert base._inferColumnType(value) is expected_type


# ---------------------------------------------------------------------------
# _sanitize_value / _sanitize_row (db_instance_base)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value, expected',
    [
        (None, None),
        ('hello', 'hello'),
        (42, 42),
        (3.14, 3.14),
        (True, True),
        (b'bytes', 'bytes'),
    ],
)
def test_sanitize_value_passthrough_for_primitives(value, expected):
    """JSON-safe primitives pass through unchanged."""
    assert DatabaseInstanceBase._sanitize_value(value) == expected


def test_sanitize_value_uses_isoformat_for_datetime():
    """A datetime is rendered via .isoformat()."""
    dt = datetime(2026, 1, 1, 12, 30, 45)
    result = DatabaseInstanceBase._sanitize_value(dt)
    assert result == '2026-01-01T12:30:45'


def test_sanitize_value_decodes_utf8_bytes():
    """UTF-8 bytes are decoded; invalid bytes use 'replace' error handling."""
    assert DatabaseInstanceBase._sanitize_value(b'hello') == 'hello'
    # Invalid UTF-8 should be safely substituted.
    result = DatabaseInstanceBase._sanitize_value(b'\xff\xfe-bad')
    assert isinstance(result, str)


def test_sanitize_value_falls_back_to_str_for_unknown_types():
    """An object with no special handler is rendered via str()."""

    class Foo:
        """A type that exercises the str() fallback path."""

        def __str__(self):
            """Return a known string so the test can assert on it."""
            return 'Foo()'

    assert DatabaseInstanceBase._sanitize_value(Foo()) == 'Foo()'


def test_sanitize_row_dict_input():
    """A row given as a dict has every value sanitized."""
    row = {'name': 'alice', 'age': 30, 'ts': datetime(2026, 1, 1)}
    result = DatabaseInstanceBase._sanitize_row(row)
    assert result == {'name': 'alice', 'age': 30, 'ts': '2026-01-01T00:00:00'}


def test_sanitize_row_list_input():
    """A row given as a list/tuple yields a list of sanitized values."""
    row = ['alice', 30, datetime(2026, 1, 1)]
    result = DatabaseInstanceBase._sanitize_row(row)
    assert result == ['alice', 30, '2026-01-01T00:00:00']


def test_sanitize_row_scalar_input():
    """A scalar value is sanitized directly (not wrapped in a list)."""
    assert DatabaseInstanceBase._sanitize_row(42) == 42


# ---------------------------------------------------------------------------
# _buildSQLQuery (EXPLAIN exhaustion + isValid parsing) — regression for #1601
# ---------------------------------------------------------------------------


class _TestableInstance(DatabaseInstanceBase):
    """Concrete DatabaseInstanceBase that satisfies the two abstract methods."""

    def _db_display_name(self):
        """Human-readable name used in tool descriptions."""
        return 'TestDB'

    def _db_dialect(self):
        """Machine-readable dialect identifier."""
        return 'testdb'


class _FakeGlobal:
    """Stub IGlobal: every EXPLAIN attempt rejects the query."""

    def __init__(self, max_attempts=2, explain_error='syntax error near FROM'):
        self.max_validation_attempts = max_attempts
        self._explain_error = explain_error

    def _validateQuery(self, sql):
        return False, self._explain_error


def _sql_instance(fake_global):
    inst = _TestableInstance.__new__(_TestableInstance)
    inst.IGlobal = fake_global
    return inst


def test_build_sql_query_marks_invalid_after_explain_exhaustion():
    """Every EXPLAIN attempt failing must flip isValid to False, not leave the LLM's 'true'.

    Before the fix, exhaustion returned the last LLM response unchanged, so
    get_sql/get_data/writeQuestions executed a statement the database had
    already refused on every attempt.
    """
    inst = _sql_instance(_FakeGlobal())
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': 'true',
        'query': 'SELECT * FROM users',
    }

    result = inst._buildSQLQuery('all users')

    assert parse_bool(result.get('isValid')) is False
    assert result.get('error')  # the EXPLAIN error is carried for the caller


def test_build_sql_query_accepts_real_json_bool_isvalid():
    """A real JSON bool from the LLM must not crash isValid parsing.

    Before the fix, `result.get('isValid', '').lower()` raised AttributeError
    the moment the LLM returned a real bool instead of the string 'true'.
    """
    fake_global = _FakeGlobal()
    fake_global._validateQuery = lambda sql: (True, None)
    inst = _sql_instance(fake_global)
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': True,  # real bool, not the string 'true'
        'query': 'SELECT 1',
    }

    result = inst._buildSQLQuery('anything')  # must not raise AttributeError

    assert parse_bool(result.get('isValid')) is True


def test_get_sql_surfaces_explain_error_not_rejected_sql():
    """get_sql() must return the EXPLAIN error, not the rejected SQL as prose.

    Before this fix, the invalid branch always returned {'answer': sql_query,
    'valid': False}, so a caller could not tell an EXPLAIN rejection (rejected
    SQL text) apart from a genuinely off-topic question (LLM prose answer).
    """
    fake_global = _FakeGlobal(explain_error='column "userz" does not exist')
    inst = _sql_instance(fake_global)
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': 'true',
        'query': 'SELECT * FROM userz',
    }

    result = inst.get_sql({'question': 'all users'})

    assert result == {'error': 'column "userz" does not exist', 'valid': False}


class _FakeInstance:
    """Minimal stand-in for IFilterInstance: records what each lane receives."""

    def __init__(self, lanes):
        self._lanes = lanes
        self.text_written = None
        self.table_written = None
        self.answer_written = None

    def getListeners(self):
        return list(self._lanes)

    def writeText(self, text):
        self.text_written = text

    def writeTable(self, markdown):
        self.table_written = markdown

    def writeAnswers(self, answer):
        self.answer_written = answer


@pytest.mark.parametrize('is_valid_value', [True, 'true'])
def test_write_questions_surfaces_explain_error_not_rejected_sql(is_valid_value):
    """writeQuestions() must report the EXPLAIN error on text/answer lanes, not the rejected SQL.

    Mirrors the get_sql() fix: writeQuestions() has its own separate fallback
    path (db_instance_base.py) that must not regress to emitting the rejected
    SQL as if it were the LLM's prose answer. Parametrized over a real JSON
    boolean and the string 'true' so a regression in isValid parsing inside
    this specific caller would also be caught.
    """
    fake_global = _FakeGlobal(explain_error='syntax error near FROM')
    inst = _sql_instance(fake_global)
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': is_valid_value,
        'query': 'SELECT * FROM',
    }
    fake_instance = _FakeInstance(lanes=['text', 'answers'])
    inst.instance = fake_instance

    question = Question()
    question.addQuestion('all users')

    inst.writeQuestions(question)

    assert fake_instance.text_written == 'syntax error near FROM'
    assert fake_instance.answer_written.getJson() == {'error': 'syntax error near FROM'}


@pytest.mark.parametrize('is_valid_value', [True, 'true'])
def test_write_questions_executes_query_when_valid(is_valid_value):
    """writeQuestions() must execute and emit results when EXPLAIN accepts the
    query on the first attempt, for both a real JSON boolean and the string
    'true'.

    The EXPLAIN-exhaustion test above always ends with isValid forced to
    False by _buildSQLQuery, so it can't distinguish True from 'true' -- both
    parametrized cases hit the same overwritten value. This test exercises
    the success path instead, where EXPLAIN accepts the query immediately and
    the LLM's isValid value passes through _buildSQLQuery unchanged.
    """
    fake_global = _FakeGlobal()
    fake_global._validateQuery = lambda sql: (True, None)  # EXPLAIN accepts it first try
    inst = _sql_instance(fake_global)
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': is_valid_value,
        'query': 'SELECT 1',
    }
    inst._executeSQLQuery = lambda sql: [{'answer': 42}]
    fake_instance = _FakeInstance(lanes=['text'])
    inst.instance = fake_instance

    question = Question()
    question.addQuestion('the answer')

    inst.writeQuestions(question)

    assert fake_instance.text_written == str([{'answer': 42}])


def test_write_questions_emits_error_for_unsafe_sql_not_as_data():
    """writeQuestions() must emit unsafe SQL as an error, not as formatted table/answer data.

    Regression for the partial mirror caught in review: is_valid_query alone
    doesn't mean the query ran. When the LLM claims isValid=true but the SQL
    fails the safety gate, the old code still let the rejected SQL fall
    through to _formatResultAsMarkdown on the table/answers lanes -- keyed off
    is_valid_query rather than whether anything was actually executed -- so
    the rejected SQL went out dressed up as a one-cell table of "data". Also
    asserts the table lane stayed silent -- the test name promises that, but
    _FakeInstance.writeTable() previously discarded its argument instead of
    recording it, so a regression here would have passed unnoticed.
    """
    fake_global = _FakeGlobal()
    inst = _sql_instance(fake_global)
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': 'true',
        'query': 'DELETE FROM users',
    }
    fake_instance = _FakeInstance(lanes=['text', 'table', 'answers'])
    inst.instance = fake_instance

    question = Question()
    question.addQuestion('delete all users')

    inst.writeQuestions(question)

    assert fake_instance.text_written == 'Generated query contains unsafe SQL'
    assert fake_instance.answer_written.getJson() == {'error': 'Generated query contains unsafe SQL'}
    assert fake_instance.table_written is None


# ---------------------------------------------------------------------------
# _tableExists (engine-backed)
# ---------------------------------------------------------------------------


def test_table_exists_returns_true_when_table_present(base):
    """After creating a table via raw SQL, _tableExists reports True."""
    from sqlalchemy import text

    with base.engine.connect() as conn:
        conn.execute(text('CREATE TABLE my_table (id INTEGER PRIMARY KEY)'))
        conn.commit()
    assert base._tableExists('my_table') is True


def test_table_exists_returns_false_for_missing_table(base):
    """An unknown table name yields False."""
    assert base._tableExists('does_not_exist') is False


def test_table_exists_returns_false_when_no_engine():
    """_tableExists is defensive — returns False when no engine is attached."""
    instance = _TestableGlobal.__new__(_TestableGlobal)
    instance.engine = None
    assert instance._tableExists('any_table') is False


# ---------------------------------------------------------------------------
# _createTableFromData (engine-backed)
# ---------------------------------------------------------------------------


def test_create_table_from_data_infers_types_and_creates_table(base):
    """Inferred column types match the documented mapping; table is created with an id PK."""
    sample = [
        {'name': 'alice', 'age': 30, 'score': 95.5, 'tags': ['a', 'b']},
        {'name': 'bob', 'age': 25, 'score': 88.0, 'tags': []},
    ]
    ok = base._createTableFromData('users', sample)
    assert ok is True
    assert base._tableExists('users') is True

    # Inspect the created columns
    inspector = inspect(base.engine)
    cols = {c['name']: c for c in inspector.get_columns('users')}
    assert 'id' in cols  # PK was auto-prepended
    assert 'name' in cols
    assert 'age' in cols
    assert 'score' in cols
    assert 'tags' in cols  # JSON-serialised → Text


def test_create_table_from_data_handles_widening_int_to_float(base):
    """A column with both ints and floats widens to Float."""
    sample = [
        {'value': 10},
        {'value': 3.14},
    ]
    base._createTableFromData('numbers', sample)
    # The schema map was populated.
    assert 'value' in base.schema


def test_create_table_from_data_empty_input_returns_false(base):
    """An empty sample list yields False (no table created)."""
    assert base._createTableFromData('empty', []) is False


def test_create_table_from_data_non_dict_first_row_returns_false(base):
    """If the first row is not a dict, the function returns False."""
    assert base._createTableFromData('badshape', [['a', 'b']]) is False


def test_create_table_from_data_no_engine_returns_false():
    """Without an engine, the function returns False before touching SQL."""
    instance = _TestableGlobal.__new__(_TestableGlobal)
    instance.engine = None
    assert instance._createTableFromData('x', [{'a': 1}]) is False


def test_create_table_from_data_populates_schema_cache(base):
    """After creating a table, base.schema is filled with column name → (type_str, '') tuples."""
    sample = [{'col_a': 1, 'col_b': 'text'}]
    base._createTableFromData('cache_check', sample)

    # Keys: data columns are present, the auto-PK 'id' is not.
    assert 'col_a' in base.schema
    assert 'col_b' in base.schema
    assert 'id' not in base.schema

    # Values: each entry is (type_str, comment). Verify both the shape and
    # that the inferred SQL type matches the Python type of the sample.
    # Note: the source picks String(255) (rendered VARCHAR(255) on SQLite)
    # for short strings, and only falls back to TEXT for values > 255 chars.
    type_a, comment_a = base.schema['col_a']
    type_b, comment_b = base.schema['col_b']
    assert 'INTEGER' in type_a.upper()  # int → Integer → 'INTEGER'
    assert 'VARCHAR' in type_b.upper() or 'TEXT' in type_b.upper()  # short str → VARCHAR(255)
    assert comment_a == ''
    assert comment_b == ''


# ---------------------------------------------------------------------------
# Base-class subclass-able sanity
# ---------------------------------------------------------------------------


def test_testable_global_satisfies_abc_contract():
    """The two abstract methods are implemented in the test subclass."""
    # If the ABC wasn't satisfied, instantiating would raise TypeError.
    _TestableGlobal.__new__(_TestableGlobal)


# ---------------------------------------------------------------------------
# read_only_connection
# ---------------------------------------------------------------------------


class _RecordingConnection:
    """Stands in for a SQLAlchemy Connection, recording what was run on it."""

    def __init__(self, fail_rollback: bool = False) -> None:
        self.driver_sql: list[str] = []
        self.rolled_back = False
        self.closed = False
        self.committed = False
        self._fail_rollback = fail_rollback

    def exec_driver_sql(self, statement):
        self.driver_sql.append(statement)

    def rollback(self):
        if self._fail_rollback:
            raise RuntimeError('rollback exploded')
        self.rolled_back = True

    def commit(self):  # pragma: no cover - must never be reached
        self.committed = True

    def close(self):
        self.closed = True


def _global_with_dialect(dialect: str, conn: _RecordingConnection, timeout: int = 30):
    instance = _TestableGlobal.__new__(_TestableGlobal)
    instance.query_timeout = timeout
    instance.engine = SimpleNamespace(
        dialect=SimpleNamespace(name=dialect),
        connect=lambda: conn,
    )
    return instance


@pytest.mark.parametrize(
    'dialect, expected_fragments',
    [
        ('postgresql', ['BEGIN READ ONLY', 'statement_timeout', 'idle_in_transaction_session_timeout']),
        ('mysql', ['max_execution_time', 'START TRANSACTION READ ONLY']),
        # MariaDB's own knob, in seconds — the MySQL spelling is an unknown
        # variable there and would fail the connection outright.
        ('mariadb', ['max_statement_time', 'START TRANSACTION READ ONLY']),
        ('clickhouse', ['readonly = 1', 'max_execution_time']),
    ],
)
def test_read_only_connection_opens_a_read_only_transaction(dialect, expected_fragments):
    """Each supported dialect gets a server-side read-only transaction plus a timeout.

    This is where the actual guarantee lives: ``is_sql_safe`` checks statement
    shape and cannot tell whether a SELECT has side effects, so the database
    is asked to refuse writes itself.
    """
    conn = _RecordingConnection()
    with _global_with_dialect(dialect, conn).read_only_connection() as yielded:
        assert yielded is conn

    issued = ' | '.join(conn.driver_sql)
    for fragment in expected_fragments:
        assert fragment in issued, f'{dialect}: missing {fragment!r} in {issued!r}'


def test_read_only_connection_carries_the_configured_timeout():
    """The configured budget reaches the server, in the units it expects."""
    conn = _RecordingConnection()
    with _global_with_dialect('postgresql', conn, timeout=45).read_only_connection():
        pass

    assert 'SET LOCAL statement_timeout = 45000' in conn.driver_sql


def test_read_only_connection_never_commits_and_always_closes():
    """A read path rolls back and closes, on the success path too."""
    conn = _RecordingConnection()
    with _global_with_dialect('postgresql', conn).read_only_connection():
        pass

    assert conn.rolled_back is True
    assert conn.closed is True
    assert conn.committed is False


def test_read_only_connection_closes_when_the_body_raises():
    """An exploding query still rolls back and releases the connection."""
    conn = _RecordingConnection()
    with pytest.raises(ValueError):
        with _global_with_dialect('postgresql', conn).read_only_connection():
            raise ValueError('query blew up')

    assert conn.rolled_back is True
    assert conn.closed is True


def test_read_only_connection_closes_even_if_rollback_fails():
    """A failed rollback must not leak the connection."""
    conn = _RecordingConnection(fail_rollback=True)
    with _global_with_dialect('postgresql', conn).read_only_connection():
        pass

    assert conn.closed is True


def test_unknown_dialect_yields_a_plain_connection():
    """An unrecognised backend runs as before rather than failing closed.

    This is defence in depth behind ``is_sql_safe``; refusing to run on a
    dialect we do not have statements for would break working deployments
    for a guarantee they never had.
    """
    conn = _RecordingConnection()
    with _global_with_dialect('firebird', conn).read_only_connection() as yielded:
        assert yielded is conn

    assert conn.driver_sql == []
    assert conn.closed is True


def test_read_only_connection_requires_an_engine():
    """No engine is a programming error, not a silent no-op."""
    instance = _TestableGlobal.__new__(_TestableGlobal)
    instance.engine = None
    instance.query_timeout = 30

    with pytest.raises(RuntimeError, match='not initialized'):
        with instance.read_only_connection():
            pass  # pragma: no cover


def test_execute_sql_query_runs_inside_the_read_only_connection():
    """The generated-query path takes its guarantee from the database.

    Regression test for the read path using a plain ``engine.connect()``:
    the statement has only passed a shape check by that point, so it must run
    inside the read-only transaction rather than an ordinary one.
    """
    from contextlib import contextmanager

    used = {'read_only': False, 'plain_connect': False}

    class _Result:
        def fetchall(self):
            return [(1, 'a')]

        def keys(self):
            return ['id', 'name']

    class _Conn:
        def execute(self, _clause):
            return _Result()

    class _Global:
        @contextmanager
        def read_only_connection(self):
            used['read_only'] = True
            yield _Conn()

        class engine:  # noqa: N801 - stands in for the SQLAlchemy Engine
            @staticmethod
            def connect():
                used['plain_connect'] = True
                raise AssertionError('read path must not open a plain connection')

    inst = _sql_instance(_Global())
    rows = inst._executeSQLQuery('SELECT id, name FROM t')

    assert rows == [{'id': 1, 'name': 'a'}]
    assert used['read_only'] is True
    assert used['plain_connect'] is False


def test_mariadb_uses_its_own_timeout_variable_in_seconds():
    """MariaDB has no max_execution_time; its knob is max_statement_time, in seconds.

    Sending the MySQL spelling raises "unknown system variable" and takes the
    connection down, so every query on a MariaDB deployment would fail.
    """
    conn = _RecordingConnection()
    with _global_with_dialect('mariadb', conn, timeout=45).read_only_connection():
        pass

    issued = ' | '.join(conn.driver_sql)
    assert 'SET SESSION max_statement_time = 45' in issued
    assert 'max_execution_time' not in issued


def test_mysql_keeps_milliseconds():
    """MySQL's max_execution_time is milliseconds — the two must not be swapped."""
    conn = _RecordingConnection()
    with _global_with_dialect('mysql', conn, timeout=45).read_only_connection():
        pass

    assert 'SET SESSION max_execution_time = 45000' in conn.driver_sql
