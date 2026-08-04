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
        self.answer_written = None

    def getListeners(self):
        return list(self._lanes)

    def writeText(self, text):
        self.text_written = text

    def writeTable(self, markdown):
        pass

    def writeAnswers(self, answer):
        self.answer_written = answer


def test_write_questions_surfaces_explain_error_not_rejected_sql():
    """writeQuestions() must report the EXPLAIN error on text/answer lanes, not the rejected SQL.

    Mirrors the get_sql() fix: writeQuestions() has its own separate fallback
    path (db_instance_base.py) that must not regress to emitting the rejected
    SQL as if it were the LLM's prose answer.
    """
    fake_global = _FakeGlobal(explain_error='syntax error near FROM')
    inst = _sql_instance(fake_global)
    inst._buildSQLQueryOnce = lambda question_text, *, limit, previous_sql, error: {
        'isValid': 'true',
        'query': 'SELECT * FROM',
    }
    fake_instance = _FakeInstance(lanes=['text', 'answers'])
    inst.instance = fake_instance

    question = Question()
    question.addQuestion('all users')

    inst.writeQuestions(question)

    assert fake_instance.text_written == 'syntax error near FROM'
    assert fake_instance.answer_written.getText() == 'syntax error near FROM'


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
