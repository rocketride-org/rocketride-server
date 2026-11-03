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

"""A cloud-DB lane never reports success for a statement that failed.

Covers ``DatabaseInstanceBase``'s pipeline lanes (``writeQuestions``,
``writeTable``, ``writeAnswers``) when the database cannot be reached or
refuses the statement. Before the fix:

- a failed read made ``writeQuestions`` emit the string ``"None"`` as the answer,
- a failed insert in ``writeTable`` / ``writeAnswers`` was logged and the lane
  returned normally, so the pipeline completed with the rows never written.

Now each lane raises ``DatabaseLaneError`` and emits nothing. The message stays
generic: the driver's sentence (host, port, statement fragment) is only in the
engine log. A separate module from ``test_db_base.py`` on purpose: that file is
appended to by more than one open pull request.
"""

from __future__ import annotations

import sqlite3
import threading

from sqlalchemy.exc import OperationalError

import pytest
from sqlalchemy import create_engine

import ai.common.database.db_global_base as db_global_base_module
import ai.common.database.db_instance_base as db_instance_module
from ai.common.database.db_global_base import DatabaseGlobalBase, DatabaseUnavailableError, is_connection_failure
from ai.common.database.db_instance_base import DatabaseInstanceBase, DatabaseLaneError

_DRIVER_SENTENCE = 'connection to server at "10.0.0.7", port 5432 failed: Connection refused'


class _Global(DatabaseGlobalBase):
    def _connection_params(self, config):
        return dict(config)

    def _build_connection_url(self, params):
        return 'sqlite:///:memory:'


class _Instance(DatabaseInstanceBase):
    def _db_display_name(self):
        return 'TestDB'

    def _db_dialect(self):
        return 'testdb'


class _Lanes:
    """Records everything a lane handler emits downstream."""

    def __init__(self, lanes):
        self._lanes = lanes
        self.text = []
        self.tables = []
        self.answers = []

    def getListeners(self):
        return list(self._lanes)

    def writeText(self, text):
        self.text.append(text)

    def writeTable(self, markdown):
        self.tables.append(markdown)

    def writeAnswers(self, answer):
        self.answers.append(answer)


def _refusing_engine():
    """A real engine whose every connection attempt raises a driver OperationalError."""

    def creator():
        raise sqlite3.OperationalError(_DRIVER_SENTENCE)

    return create_engine('sqlite://', creator=creator)


def _healthy_engine():
    return create_engine('sqlite:///:memory:')


def _make(engine, lanes=('text', 'table', 'answers')):
    iglobal = _Global.__new__(_Global)
    iglobal.engine = engine
    iglobal.schema = {}
    iglobal.db_schema = {}
    iglobal.database = 'main'
    iglobal.table = 'answers'
    iglobal.allow_execute = True
    iglobal.max_execute_rows = 1000
    iglobal.max_validation_attempts = 1
    iglobal.reflect_lock = threading.Lock()

    inst = _Instance.__new__(_Instance)
    inst.IGlobal = iglobal
    inst.instance = _Lanes(lanes)
    # The LLM step is not under test: hand the lane a valid SELECT.
    inst._buildSQLQuery = lambda question_text: {'isValid': True, 'query': 'SELECT 1 AS n'}
    return inst


def _question(text='how many?'):
    from ai.common.schema import Question

    question = Question()
    question.addQuestion(text)
    return question


def _answer(rows):
    from ai.common.schema import Answer

    answer = Answer()
    answer.setAnswer(rows)
    return answer


@pytest.fixture(autouse=True)
def logged(monkeypatch):
    """Record ``error()`` calls the way the engine binding takes them: positional arguments only.

    rocketlib's ``debug`` / ``error`` / ``warning`` are ``[](py::args &args)``, so a keyword
    argument raises ``TypeError`` in production. Recording through ``*args`` makes any
    keyword call in the lane code fail here too.
    """
    entries: list[tuple] = []

    def record(*args):
        entries.append(args)

    monkeypatch.setattr(db_instance_module, 'error', record)
    monkeypatch.setattr(db_global_base_module, 'error', record)
    return entries


def _assert_generic(exc: DatabaseLaneError):
    text = str(exc)
    assert 'TestDB' in text
    assert '10.0.0.7' not in text and 'Connection refused' not in text and '5432' not in text


def test_the_question_lane_fails_and_never_emits_none_when_the_read_fails(logged):
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseLaneError) as raised:
        inst.writeQuestions(_question())

    _assert_generic(raised.value)
    sink = inst.instance
    assert sink.text == [] and sink.tables == [] and sink.answers == []
    # The cause still reaches the engine log.
    assert any(_DRIVER_SENTENCE in str(entry) for entry in logged)


@pytest.mark.parametrize('lanes', [('text',), ('answers',), ('table',), ()])
def test_the_question_lane_fails_whichever_lanes_are_wired(lanes):
    inst = _make(_refusing_engine(), lanes)

    with pytest.raises(DatabaseLaneError):
        inst.writeQuestions(_question())

    assert inst.instance.text == [] and inst.instance.answers == []


def test_the_answers_lane_fails_when_the_insert_cannot_reach_the_database(logged):
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseLaneError) as raised:
        inst.writeAnswers(_answer([{'lease': 'a', 'owner': 'run-1'}]))

    _assert_generic(raised.value)
    assert any('Error in writeAnswers' in str(entry) for entry in logged)


def test_the_table_lane_fails_when_the_insert_cannot_reach_the_database(logged):
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseLaneError) as raised:
        inst.writeTable('| lease | owner |\n| --- | --- |\n| a | run-1 |')

    _assert_generic(raised.value)
    assert any('Error inserting table data' in str(entry) for entry in logged)


def test_a_statement_the_database_refuses_fails_the_write_lanes():
    """Not only an unreachable database: a refused statement must not read as success either."""
    engine = _healthy_engine()
    inst = _make(engine)
    # A table whose NOT NULL column the row does not carry, so the INSERT is refused.
    with engine.begin() as conn:
        conn.exec_driver_sql('CREATE TABLE answers (id INTEGER PRIMARY KEY, who TEXT NOT NULL)')

    with pytest.raises(DatabaseLaneError):
        inst.writeAnswers(_answer([{'who': None}]))


def test_execute_sql_query_raises_instead_of_returning_none():
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseLaneError):
        inst._executeSQLQuery('SELECT 1')


def test_get_data_keeps_its_explicit_invalid_result_contract():
    """The tool reports the failure as data; only the lanes rely on the raise."""
    inst = _make(_refusing_engine())
    inst.get_sql = lambda args: {'valid': True, 'sql': 'SELECT 1 AS n'}

    result = inst.get_data({'question': 'how many?'})

    assert result == {'valid': False, 'error': 'Query execution failed', 'sql': 'SELECT 1 AS n', 'rows': []}


def test_the_healthy_lanes_still_emit_and_insert():
    engine = _healthy_engine()
    inst = _make(engine)

    inst.writeQuestions(_question())
    assert inst.instance.text == [str([{'n': 1}])]
    assert inst.instance.answers  # emitted, no exception

    inst.writeAnswers(_answer([{'who': 'run-1'}]))
    with engine.connect() as conn:
        assert conn.exec_driver_sql('SELECT who FROM answers').fetchall() == [('run-1',)]


def test_a_non_database_answer_is_still_passed_through_without_touching_the_database():
    """When the LLM says it is not a database question the lane answers with prose and never connects."""
    inst = _make(_refusing_engine(), ('text',))
    inst._buildSQLQuery = lambda question_text: {'isValid': False, 'query': 'Rome fell in 410.'}

    inst.writeQuestions(_question('When did Rome fall?'))

    assert inst.instance.text == ['Rome fell in 410.']


# ---------------------------------------------------------------------------
# The EXPLAIN step: an unreachable database is not a rejected query
# ---------------------------------------------------------------------------


class _LlmCounter:
    """Stands in for the LLM call so a test can see how often the repair loop asked it."""

    def __init__(self, query='SELECT * FROM leases'):
        self.calls = 0
        self.query = query

    def __call__(self, question_text, *, limit, previous_sql, error):
        self.calls += 1
        return {'isValid': True, 'query': self.query}


def _with_llm(inst, llm):
    """Use the real ``_buildSQLQuery`` (so the real ``_validateQuery`` runs) over a counted LLM stand-in."""
    del inst._buildSQLQuery  # the instance attribute _make installed; fall back to the class method
    inst._buildSQLQueryOnce = llm
    return inst


def test_validate_query_raises_when_the_connection_is_refused():
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseUnavailableError) as raised:
        inst.IGlobal._validateQuery('SELECT 1')

    assert 'Connection refused' not in str(raised.value) and '10.0.0.7' not in str(raised.value)


def test_a_refused_connection_during_explain_fails_the_question_lane_without_asking_the_llm_again(logged):
    llm = _LlmCounter()
    inst = _with_llm(_make(_refusing_engine(), ('text', 'answers')), llm)
    inst.IGlobal.max_validation_attempts = 5

    with pytest.raises(DatabaseUnavailableError):
        inst.writeQuestions(_question())

    assert llm.calls == 1  # no repair loop: the outage is not the SQL's fault
    assert inst.instance.text == [] and inst.instance.answers == []
    assert any(_DRIVER_SENTENCE in str(entry) for entry in logged)


def test_a_refused_connection_during_explain_is_an_explicit_result_for_the_tools():
    inst = _with_llm(_make(_refusing_engine()), _LlmCounter())

    result = inst.get_sql({'question': 'how many?'})

    assert result['valid'] is False and 'unavailable' in result['error']
    assert inst.get_data({'question': 'how many?'})['valid'] is False


def test_a_genuine_validation_rejection_keeps_its_behaviour():
    """Bad SQL is still the LLM's to repair and still reported as an error on the lanes."""
    engine = _healthy_engine()
    llm = _LlmCounter(query='SELECT * FROM no_such_table')
    inst = _with_llm(_make(engine, ('text', 'answers')), llm)
    inst.IGlobal.max_validation_attempts = 2

    ok, message = inst.IGlobal._validateQuery('SELECT * FROM no_such_table')
    assert ok is False and 'no such table' in message

    inst.writeQuestions(_question())  # does not raise

    assert llm.calls == 2  # the repair loop ran
    assert 'no such table' in inst.instance.text[0]
    assert 'no such table' in inst.instance.answers[0].getJson()['error']


def _engine_failing_execute_with(exc):
    """A connected engine whose statement execution then fails with ``exc``."""
    engine = _healthy_engine()

    def failing(cursor, statement, parameters, context=None):
        raise exc

    engine.dialect.do_execute = failing
    return engine


def test_a_connection_dropped_while_explain_runs_is_unavailable():
    """SQLAlchemy marked the connection invalid (the dialect recognised the disconnect): type-based, no message match."""
    engine = _engine_failing_execute_with(sqlite3.ProgrammingError('Cannot operate on a closed database.'))
    inst = _make(engine)

    with pytest.raises(DatabaseUnavailableError):
        inst.IGlobal._validateQuery('SELECT 1')


def test_a_cannot_connect_now_sqlstate_during_explain_is_unavailable():
    exc = sqlite3.OperationalError('the server said no')
    exc.pgcode = '57P03'
    inst = _make(_engine_failing_execute_with(exc))

    with pytest.raises(DatabaseUnavailableError):
        inst.IGlobal._validateQuery('SELECT 1')


def test_an_operational_error_about_the_sql_is_still_a_rejection():
    """PyMySQL raises OperationalError for an unknown column: the SQL's fault, so the LLM repairs it."""
    inst = _make(_engine_failing_execute_with(sqlite3.OperationalError("Unknown column 'x' in 'field list'")))

    ok, message = inst.IGlobal._validateQuery('SELECT x FROM t')

    assert ok is False and 'Unknown column' in message


class _Named:
    """Builds an exception whose class name, but nothing else, matches a driver's."""

    @staticmethod
    def make(name, base=Exception):
        return type(name, (base,), {})('boom')


@pytest.mark.parametrize(
    'exc, expected',
    [
        (ConnectionRefusedError('refused'), True),
        (TimeoutError('timed out'), True),
        (_Named.make('InterfaceError'), True),
        (_Named.make('NetworkError'), True),
        (_Named.make('SocketTimeoutError'), True),
        (OperationalError('SELECT 1', {}, sqlite3.OperationalError('x')), False),
        (ValueError('nope'), False),
    ],
)
def test_is_connection_failure_by_exception_type(exc, expected):
    assert is_connection_failure(exc) is expected


def _mysql_error(number):
    return sqlite3.OperationalError(number, 'driver text')


@pytest.mark.parametrize(
    'exc, expected',
    [
        (_mysql_error(1053), True),  # ER_SERVER_SHUTDOWN: the server is going away
        (_mysql_error(1054), False),  # ER_BAD_FIELD_ERROR: the LLM's SQL
        (_mysql_error(1064), False),  # ER_PARSE_ERROR
    ],
)
def test_is_connection_failure_by_mysql_error_number(exc, expected):
    assert is_connection_failure(exc) is expected


class _ClickHouseError(Exception):
    """A ClickHouse server error: the numeric code rides on ``.code``."""

    def __init__(self, code):
        super().__init__(f'Code: {code}.')
        self.code = code


@pytest.mark.parametrize('code', [202, 241])
def test_clickhouse_resource_limit_errors_are_known_rejections(code):
    """TOO_MANY_SIMULTANEOUS_QUERIES and MEMORY_LIMIT_EXCEEDED are about the query, not the link."""
    assert is_connection_failure(_ClickHouseError(code)) is False


@pytest.mark.parametrize(
    'code, expected',
    [
        ('08006', True),
        ('53300', True),
        ('57P01', True),
        ('57P03', True),
        ('42601', False),
        ('42703', False),
        ('57014', False),  # statement timeout / query_canceled: about the query
        ('55P03', False),  # lock_timeout / lock_not_available: about the query
    ],
)
def test_is_connection_failure_by_sqlstate(code, expected):
    exc = sqlite3.OperationalError('driver text')
    exc.pgcode = code

    assert is_connection_failure(exc) is expected


# ---------------------------------------------------------------------------
# _tableExists: an outage is not "the table does not exist"
# ---------------------------------------------------------------------------


def test_table_exists_raises_when_the_database_cannot_be_reached():
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseUnavailableError):
        inst.IGlobal._tableExists('answers')


def test_table_exists_still_reports_a_missing_table_as_false_and_a_present_one_as_true():
    engine = _healthy_engine()
    inst = _make(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql('CREATE TABLE present (id INTEGER PRIMARY KEY)')

    assert inst.IGlobal._tableExists('present') is True
    assert inst.IGlobal._tableExists('missing') is False


def test_get_table_schema_raises_during_an_outage_instead_of_reporting_no_table():
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseUnavailableError):
        inst.IGlobal._getTableSchema('answers')


def test_an_insert_during_an_outage_reports_the_outage_not_a_failed_table_creation(logged):
    inst = _make(_refusing_engine())

    with pytest.raises(DatabaseLaneError):
        inst.writeAnswers(_answer([{'lease': 'a'}]))

    messages = ' '.join(str(entry) for entry in logged)
    assert 'unavailable' in messages
    assert 'could not be created' not in messages and 'Failed to create table' not in messages


# ---------------------------------------------------------------------------
# A failing downstream write is not swallowed here
# ---------------------------------------------------------------------------


class _DownstreamFails(_Lanes):
    """A downstream node whose own lane failed.

    The engine re-raises a Python exception from a downstream node in its upstream
    caller as a plain ``Exception``, never as the original class, so that is what is
    raised here.
    """

    def writeText(self, text):
        raise Exception('Exception: PostgreSQL answers write failed; no rows were saved')

    def writeTable(self, markdown):
        raise Exception('Exception: PostgreSQL table write failed; no rows were saved')

    def writeAnswers(self, answer):
        raise Exception('Exception: PostgreSQL answers write failed; no rows were saved')


@pytest.mark.parametrize('lanes', [('text',), ('table',), ('answers',)])
def test_the_question_lane_fails_when_a_downstream_write_fails(lanes):
    """The question was answered, but its rows were not written downstream: the step must fail."""
    inst = _make(_healthy_engine(), lanes)
    inst.instance = _DownstreamFails(lanes)

    with pytest.raises(Exception, match='write failed'):
        inst.writeQuestions(_question())


def test_the_error_lane_write_is_not_swallowed_either():
    inst = _make(_healthy_engine(), ('text',))
    inst._buildSQLQuery = lambda question_text: {'isValid': True, 'query': 'DELETE FROM users'}
    inst.instance = _DownstreamFails(('text',))

    with pytest.raises(Exception, match='write failed'):
        inst.writeQuestions(_question())
