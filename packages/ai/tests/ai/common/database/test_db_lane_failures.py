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

import pytest
from sqlalchemy import create_engine

import ai.common.database.db_instance_base as db_instance_module
from ai.common.database.db_global_base import DatabaseGlobalBase
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
