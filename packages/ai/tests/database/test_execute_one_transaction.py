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

"""Tests for the ``execute`` tool function: one transaction per call (plan 4.1 rule 3).

A call opens its transaction, commits it when every statement succeeded, rolls
it back when one failed, and returns its connection to the pool before it
answers. There is no session that a later call can continue: the next call of
the same control may land on another replica.
"""

import contextlib
import types

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import StaticPool

from ai.common.database.db_global_base import DatabaseGlobalBase
from ai.common.database.db_instance_base import MAX_EXECUTE_STATEMENTS, DatabaseInstanceBase


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _engine_shared():
    """In-memory SQLite engine whose one connection every thread shares (StaticPool)."""
    e = create_engine(
        'sqlite://',
        connect_args={'check_same_thread': False},
        poolclass=StaticPool,
    )
    with e.begin() as c:
        c.execute(text('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'))
    return e


def _engine_pooled(tmp_path):
    """File SQLite engine on a real connection pool, so checked-out connections can be counted."""
    e = create_engine(f'sqlite:///{tmp_path / "pooled.db"}', connect_args={'check_same_thread': False})
    with e.begin() as c:
        c.execute(text('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'))
    return e


def _make_iglobal(engine=None):
    """Build a minimal IGlobal stub: the engine and the row cap, nothing a call decides."""
    if engine is None:
        engine = _engine_shared()
    iglobal = types.SimpleNamespace(max_execute_rows=1000, engine=engine)
    # A failed execute formats the driver error through IGlobal, so the stub
    # borrows the real implementation.
    iglobal._format_db_error = types.MethodType(DatabaseGlobalBase._format_db_error, iglobal)
    return iglobal


def _make_instance(iglobal, *, allow_execute=True, display_name='TestDB', transactional=True):
    """Instantiate a concrete DatabaseInstanceBase subclass whose call carries ``allow_execute``."""

    class _Concrete(DatabaseInstanceBase):
        def _db_display_name(self):
            return display_name

        def _db_dialect(self):
            return 'sqlite'

        def _callsAreTransactions(self):
            return transactional

    inst = _Concrete.__new__(_Concrete)
    inst.IGlobal = iglobal
    # The call's parameters, as `settings` serves them
    inst._settings = {'table': 't', 'db_description': '', 'max_attempts': 1, 'allow_execute': allow_execute}
    return inst


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def instance_with_execute_disabled():
    return _make_instance(_make_iglobal(), allow_execute=False)


@pytest.fixture
def instance():
    return _make_instance(_make_iglobal())


@pytest.fixture
def pooled_instance(tmp_path):
    inst = _make_instance(_make_iglobal(_engine_pooled(tmp_path)))
    yield inst
    inst.IGlobal.engine.dispose()


# ---------------------------------------------------------------------------
# (a) The gate is the call's own parameter
# ---------------------------------------------------------------------------


def test_execute_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.execute({'sql': 'SELECT 1'})


def test_a_batch_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.execute({'statements': [{'sql': 'SELECT 1'}]})


def test_two_calls_on_one_global_carry_their_own_gate():
    """One control, two calls: the gate is read per call, the IGlobal is not rebuilt."""
    iglobal = _make_iglobal()
    allowed = _make_instance(iglobal, allow_execute=True)
    refused = _make_instance(iglobal, allow_execute=False)

    assert allowed.execute({'sql': 'SELECT 1 AS one'})['rows'] == [{'one': 1}]
    with pytest.raises(ValueError, match='allow_execute'):
        refused.execute({'sql': 'SELECT 1 AS one'})
    assert allowed.IGlobal is refused.IGlobal


# ---------------------------------------------------------------------------
# (b) No tool begins a transaction in one call for another to continue
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('name', ['begin', 'commit', 'rollback'])
def test_there_is_no_session_tool(name):
    """The begin, commit and rollback tools are retired with the cross-call sessions."""
    assert not hasattr(DatabaseInstanceBase, name)


def test_the_execute_schema_names_no_session():
    schema = DatabaseInstanceBase.execute.__tool_meta__['input_schema']
    assert 'session_id' not in schema['properties']
    assert 'statements' in schema['properties']


def test_a_session_id_is_refused_not_ignored(instance):
    """Ignoring it would commit a statement its caller still believes it can roll back."""
    with pytest.raises(ValueError, match='"session_id" is not supported'):
        instance.execute({'sql': "INSERT INTO t (v) VALUES ('x')", 'session_id': 'abc'})
    assert instance.execute({'sql': 'SELECT v FROM t'})['rows'] == []


# ---------------------------------------------------------------------------
# (c) One transaction per call: commit on success, rollback on error, nothing open after
# ---------------------------------------------------------------------------


def test_a_successful_call_commits(pooled_instance):
    """What one call wrote is there for the next call: nothing waits for a commit."""
    pooled_instance.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['kept']})
    assert pooled_instance.execute({'sql': 'SELECT v FROM t'})['rows'] == [{'v': 'kept'}]


def test_a_batch_commits_every_statement_together(pooled_instance):
    out = pooled_instance.execute(
        {
            'statements': [
                {'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['a']},
                {'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['b']},
                {'sql': 'SELECT v FROM t ORDER BY v'},
            ]
        }
    )
    assert [r['affected_rows'] for r in out['results']] == [1, 1, 0]
    assert out['results'][2]['rows'] == [{'v': 'a'}, {'v': 'b'}]
    assert pooled_instance.execute({'sql': 'SELECT count(*) AS n FROM t'})['rows'] == [{'n': 2}]


def test_a_failed_statement_rolls_back_the_whole_call(pooled_instance):
    """The first INSERT ran; the second failed; neither is there afterwards."""
    with pytest.raises(RuntimeError, match='SQL execution failed: '):
        pooled_instance.execute(
            {
                'statements': [
                    {'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['undone']},
                    {'sql': 'INSERT INTO no_such_table (v) VALUES (1)'},
                ]
            }
        )
    assert pooled_instance.execute({'sql': 'SELECT v FROM t'})['rows'] == []


def test_no_connection_is_held_after_a_call(pooled_instance):
    """Success or failure, the call's connection is back in the pool before it answers."""
    pool = pooled_instance.IGlobal.engine.pool

    pooled_instance.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['x']})
    assert pool.checkedout() == 0

    with pytest.raises(RuntimeError):
        pooled_instance.execute({'sql': 'SELECT * FROM no_such_table'})
    assert pool.checkedout() == 0

    pooled_instance.IGlobal.max_execute_rows = 0
    with pytest.raises(RuntimeError, match='max_execute_rows'):
        pooled_instance.execute({'sql': "INSERT INTO t (v) VALUES ('y') RETURNING v"})
    assert pool.checkedout() == 0


def test_no_transaction_is_left_open_after_a_call(pooled_instance, tmp_path):
    """Another connection can write at once: a call that left its transaction open would lock it out."""
    pooled_instance.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['first']})

    other = create_engine(f'sqlite:///{tmp_path / "pooled.db"}', connect_args={'timeout': 0})
    try:
        with other.begin() as conn:
            conn.execute(text("INSERT INTO t (v) VALUES ('second')"))
    finally:
        other.dispose()
    assert len(pooled_instance.execute({'sql': 'SELECT v FROM t'})['rows']) == 2


def test_overflow_rolls_back_the_write(instance):
    """A write whose RETURNING overflows max_execute_rows must roll back.

    The overflow raises inside the transaction, so ``engine.begin()`` rolls it
    back; returning instead would let an overflowing write commit anyway.
    """
    instance.IGlobal.max_execute_rows = 0  # any RETURNING row overflows
    with pytest.raises(RuntimeError, match='max_execute_rows'):
        instance.execute({'sql': "INSERT INTO t (v) VALUES ('rollback_me') RETURNING v"})
    instance.IGlobal.max_execute_rows = 1000
    assert instance.execute({'sql': 'SELECT v FROM t'})['rows'] == []


# ---------------------------------------------------------------------------
# (d) The batch is validated whole before anything is sent
# ---------------------------------------------------------------------------


def test_sql_and_statements_are_not_both_accepted(instance):
    with pytest.raises(ValueError, match='not both'):
        instance.execute({'sql': 'SELECT 1', 'statements': [{'sql': 'SELECT 2'}]})


@pytest.mark.parametrize(
    ('batch', 'match'),
    [
        ([], 'non-empty array'),
        ('SELECT 1', 'non-empty array'),
        (['SELECT 1'], r'statements\[0\]'),
        ([{'sql': ''}], r'statements\[0\]\.sql'),
        ([{'sql': 'SELECT 1', 'params': {'a': 1}}], '"params" must be an array'),
    ],
    ids=['empty', 'not-a-list', 'not-an-object', 'empty-sql', 'object-params'],
)
def test_a_malformed_batch_is_refused(instance, batch, match):
    with pytest.raises(ValueError, match=match):
        instance.execute({'statements': batch})


def test_a_batch_over_the_bound_is_refused_before_anything_runs(instance):
    batch = [{'sql': "INSERT INTO t (v) VALUES ('x')"}] * (MAX_EXECUTE_STATEMENTS + 1)
    with pytest.raises(ValueError, match=f'at most {MAX_EXECUTE_STATEMENTS}'):
        instance.execute({'statements': batch})
    assert instance.execute({'sql': 'SELECT v FROM t'})['rows'] == []


def test_a_later_malformed_statement_stops_the_earlier_ones_from_running(instance):
    with pytest.raises(ValueError, match=r'statements\[1\]'):
        instance.execute({'statements': [{'sql': "INSERT INTO t (v) VALUES ('x')"}, {'sql': '  '}]})
    assert instance.execute({'sql': 'SELECT v FROM t'})['rows'] == []


# ---------------------------------------------------------------------------
# (e) A driver failure comes back as the driver's own sentence, and nothing else
# ---------------------------------------------------------------------------


def test_execute_surfaces_the_driver_error(instance):
    """A bad statement raises with the database's own message, without the statement or its binds."""
    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': 'SELECT * FROM no_such_table WHERE v = $1', 'params': ['ada@example.com']})

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: ')
    assert 'no_such_table' in message
    assert 'ada@example.com' not in message
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


class _FakeDriverError(Exception):
    """Stand-in for a DBAPI driver exception (psycopg2 / pymysql shapes)."""


class _FailingConnection:
    """Connection stand-in whose execute() always raises the given exception."""

    def __init__(self, exc):
        self._exc = exc

    def execute(self, *args, **kwargs):
        """Fail the way a driver fails, with the statement already bound."""
        raise self._exc


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
def test_a_driver_failure_is_reported_by_its_primary_sentence(instance, build_error, expected):
    """The PostgreSQL DETAIL block restating the key is dropped; MySQL's sentence keeps the caller's own value."""
    instance.IGlobal.engine = _FailingEngine(build_error())
    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['ada@example.com']})

    message = str(excinfo.value)
    assert message == expected
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message
    assert 'DETAIL' not in message


def test_execute_passes_the_primary_sentence_through_verbatim(instance):
    """A real SQLite syntax error: its primary sentence quotes the fragment, the tail is removed."""
    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': "INSERT INTO t VALUES 'hunter2'"})

    message = str(excinfo.value)
    assert message == 'SQL execution failed: near "\'hunter2\'": syntax error'
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


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


def test_a_driver_error_sqlalchemy_did_not_wrap_is_formatted_too(instance):
    """clickhouse-sqlalchemy's native connector raises its own exception; the contract is the same.

    Constructed shape; clickhouse-sqlalchemy is not installed here.
    """
    instance.IGlobal.engine = _FailingEngine(
        _StandInDatabaseException(
            _StandInServerException(62, 'Syntax error', trailer=": failed at position 21 ('hunter2') (line 1, col 21)")
        )
    )
    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': "INSERT INTO t VALUES 'hunter2'"})

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: Error 62: ')
    assert 'Stack trace' not in message
    assert 'failed at position' not in message
    assert "('hunter2')" not in message
    assert 'Orig exception' not in message


def test_an_exception_without_orig_is_not_treated_as_a_database_error(instance):
    """A programming error inside the driver is not a statement failure and reaches the caller unchanged."""
    instance.IGlobal.engine = _FailingEngine(ValueError('driver bug, not a database error'))
    with pytest.raises(ValueError) as excinfo:
        instance.execute({'sql': 'SELECT 1'})

    assert str(excinfo.value) == 'driver bug, not a database error'


# ---------------------------------------------------------------------------
# (f) `params` is validated before dispatch
# ---------------------------------------------------------------------------


def test_params_must_be_an_array(instance):
    """A JSON object for `params` is refused by name, not as a KeyError from the rewriter."""
    with pytest.raises(ValueError, match='"params" must be an array'):
        instance.execute({'sql': 'SELECT * FROM t WHERE v = $1', 'params': {'v': 'x'}})


def test_params_must_cover_every_placeholder(instance):
    """Too few values name the placeholder that has none."""
    with pytest.raises(ValueError) as excinfo:
        instance.execute({'sql': 'SELECT * FROM t WHERE v = $1 OR v = $2', 'params': ['only-one']})

    message = str(excinfo.value)
    assert '$2' in message
    assert 'out of range' in message


def test_params_are_still_bound_when_they_cover_the_placeholders(instance):
    instance.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['kept']})
    assert instance.execute({'sql': 'SELECT v FROM t WHERE v = $1', 'params': ['kept']})['rows'] == [{'v': 'kept'}]
    assert instance.execute({'sql': 'SELECT 2 AS two'})['rows'] == [{'two': 2}]


def test_a_dollar_number_inside_a_string_literal_is_not_a_placeholder(instance):
    """The rewriter is quote-aware: `$5` inside a literal is text."""
    assert instance.execute({'sql': "SELECT '$5' AS v", 'params': ['x']})['rows'] == [{'v': '$5'}]


# ---------------------------------------------------------------------------
# (g) row_mode='array' -- positional rows for ORM clients (Drizzle)
# ---------------------------------------------------------------------------


def test_execute_tool_array_row_mode(instance):
    instance.execute({'sql': "INSERT INTO t (id, v) VALUES (1, 'x')"})
    instance.execute({'sql': "INSERT INTO t (id, v) VALUES (2, 'y')"})
    result = instance.execute({'sql': 'SELECT id, v FROM t ORDER BY id', 'row_mode': 'array'})
    assert result['rows'] == [[1, 'x'], [2, 'y']]


def test_a_batch_honours_row_mode(instance):
    out = instance.execute(
        {
            'statements': [{'sql': "INSERT INTO t (id, v) VALUES (1, 'x')"}, {'sql': 'SELECT id, v FROM t'}],
            'row_mode': 'array',
        }
    )
    assert out['results'][1]['rows'] == [[1, 'x']]


def test_execute_tool_rejects_bad_row_mode(instance):
    with pytest.raises(ValueError, match='row_mode'):
        instance.execute({'sql': 'SELECT 1', 'row_mode': 'csv'})


def test_execute_tool_rejects_falsy_row_mode(instance):
    # '' violates the declared enum; only an ABSENT field defaults to 'object'.
    with pytest.raises(ValueError, match='row_mode'):
        instance.execute({'sql': 'SELECT 1', 'row_mode': ''})


# ---------------------------------------------------------------------------
# (h) _sanitize_value JSON-encodes dicts and lists (psycopg2 json/jsonb parse)
# ---------------------------------------------------------------------------


def test_sanitize_value_json_encodes_dicts():
    assert DatabaseInstanceBase._sanitize_value({'a': 1}) == '{"a": 1}'


def test_sanitize_value_json_encodes_lists():
    assert DatabaseInstanceBase._sanitize_value([1, 'x']) == '[1, "x"]'


def test_sanitize_value_json_encodes_nested_with_fallback():
    import datetime

    assert '"2026-01-01"' in DatabaseInstanceBase._sanitize_value({'t': datetime.date(2026, 1, 1)})


def test_sanitize_value_json_encodes_tuples():
    assert DatabaseInstanceBase._sanitize_value((1, 'x')) == '[1, "x"]'


# ---------------------------------------------------------------------------
# (i) The tool description says what one call commits or undoes
# ---------------------------------------------------------------------------


def test_the_description_states_one_transaction_per_call(instance):
    description = DatabaseInstanceBase.execute.__tool_meta__['description'](instance)

    assert 'One call is one transaction' in description
    assert 'rolls back entirely when one fails' in description
    assert 'session' not in description


def test_a_node_without_transactions_promises_no_rollback():
    """ClickHouse's commit and rollback are no-ops: its description must not promise either."""
    inst = _make_instance(_make_iglobal(), display_name='ClickHouse', transactional=False)
    description = DatabaseInstanceBase.execute.__tool_meta__['description'](inst)

    assert description.startswith('Execute raw SQL against this ClickHouse database')
    assert 'ClickHouse has no transactions' in description
    assert 'undoes nothing' in description
    assert 'rolls back' not in description
