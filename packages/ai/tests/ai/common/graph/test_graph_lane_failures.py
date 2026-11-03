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

"""A graph-DB lane never reports success for a statement that failed.

Covers ``GraphInstanceBase``'s lane handlers: ``writeQuestions`` for a question,
and the EXECUTE path (``QuestionType.EXECUTE``) that runs a raw statement. Before
the fix both caught every exception, logged it and returned, so a failed read
produced no answer at all and a failed write left the pipeline "completed" with
the write never made. Now each raises ``GraphLaneError`` and emits nothing, with
a generic message: the driver's sentence is only in the engine log.
"""

from __future__ import annotations

import types

import pytest

import ai.common.graph.graph_instance_base as graph_module
from ai.common.graph.graph_global_base import GraphUnavailableError
from ai.common.graph.graph_instance_base import GraphInstanceBase, GraphLaneError

# The lane compares against these members; a stand-in keeps the test independent of which
# QuestionType the installed client package carries.
QuestionType = types.SimpleNamespace(QUESTION='question', DIALECT='dialect', EXECUTE='execute')

_DRIVER_SENTENCE = 'Connection refused: redis://10.0.0.9:6379 MATCH (n) RETURN n'


class _Instance(GraphInstanceBase):
    def _db_display_name(self):
        return 'TestGraph'

    def _db_dialect(self):
        return 'testgraph'


class _Global:
    allow_execute = True
    max_validation_attempts = 1

    def __init__(self, *, fail):
        self._fail = fail

    def _run_query(self, query, params=None, limit=None):
        if self._fail:
            raise ConnectionError(_DRIVER_SENTENCE)
        return [{'n': 1}]

    def _run_query_raw(self, query, params=None):
        if self._fail:
            raise ConnectionError(_DRIVER_SENTENCE)
        return {'rows': [{'n': 1}], 'affected_rows': 0}


class _Lanes:
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


def _make(*, fail, lanes=('text', 'table', 'answers')):
    inst = _Instance.__new__(_Instance)
    inst.IGlobal = _Global(fail=fail)
    inst.instance = _Lanes(lanes)
    # The LLM step is not under test: hand the lane a valid read query.
    inst._buildQuery = lambda question_text: {'isValid': True, 'query': 'MATCH (n) RETURN n LIMIT 1'}
    return inst


def _question(kind=QuestionType.QUESTION, text='who knows Alice?'):
    return types.SimpleNamespace(type=kind, questions=[types.SimpleNamespace(text=text)])


@pytest.fixture(autouse=True)
def logged(monkeypatch):
    """Record ``error()`` with positional arguments only, like the engine binding (a keyword raises TypeError)."""
    entries: list[tuple] = []

    def record(*args):
        entries.append(args)

    monkeypatch.setattr(graph_module, 'error', record)
    monkeypatch.setattr(graph_module, 'QuestionType', QuestionType)
    return entries


def _assert_generic(exc):
    text = str(exc)
    assert 'TestGraph' in text
    assert '10.0.0.9' not in text and 'Connection refused' not in text and 'MATCH' not in text


def test_the_question_lane_fails_and_emits_nothing_when_the_read_fails(logged):
    inst = _make(fail=True)

    with pytest.raises(GraphLaneError) as raised:
        inst.writeQuestions(_question())

    _assert_generic(raised.value)
    assert inst.instance.text == [] and inst.instance.tables == [] and inst.instance.answers == []
    assert any(_DRIVER_SENTENCE in str(entry) for entry in logged)


@pytest.mark.parametrize('lanes', [('text',), ('answers',), ('table',), ()])
def test_the_question_lane_fails_whichever_lanes_are_wired(lanes):
    inst = _make(fail=True, lanes=lanes)

    with pytest.raises(GraphLaneError):
        inst.writeQuestions(_question())

    assert inst.instance.text == [] and inst.instance.answers == []


def test_the_execute_lane_fails_and_emits_nothing_when_the_statement_fails(logged):
    inst = _make(fail=True)

    with pytest.raises(GraphLaneError) as raised:
        inst.writeQuestions(_question(QuestionType.EXECUTE, 'CREATE (:Lease {id: 1})'))

    _assert_generic(raised.value)
    assert inst.instance.text == [] and inst.instance.tables == [] and inst.instance.answers == []
    assert any(_DRIVER_SENTENCE in str(entry) for entry in logged)


def test_the_healthy_lanes_still_emit():
    inst = _make(fail=False)

    inst.writeQuestions(_question())
    assert inst.instance.text and inst.instance.answers

    executed = _make(fail=False)
    executed.writeQuestions(_question(QuestionType.EXECUTE, 'MATCH (n) RETURN n'))
    assert executed.instance.text and executed.instance.answers


def test_a_disabled_execute_lane_is_still_a_warning_not_a_failure(monkeypatch):
    warned = []
    monkeypatch.setattr(graph_module, 'warning', lambda *args: warned.append(args))
    inst = _make(fail=True)
    inst.IGlobal.allow_execute = False

    inst.writeQuestions(_question(QuestionType.EXECUTE, 'CREATE (:Lease)'))

    assert warned and inst.instance.text == []


# ---------------------------------------------------------------------------
# The EXPLAIN step: an unreachable database is not a rejected query
# ---------------------------------------------------------------------------


class _ValidatingGlobal(_Global):
    """A global whose EXPLAIN step either reports the outage or rejects the query."""

    max_validation_attempts = 5
    read_row_cap = 1000

    def __init__(self, *, outage):
        super().__init__(fail=False)
        self._outage = outage
        self.db_description = ''
        self.graph_schema = {}

    def _validate_query(self, query):
        if self._outage:
            raise GraphUnavailableError('Graph database is unavailable (details are in the engine log)')
        return False, 'Syntax error at MATCH'


def _validating(*, outage, lanes=('text', 'answers')):
    inst = _make(fail=False, lanes=lanes)
    inst.IGlobal = _ValidatingGlobal(outage=outage)
    del inst._buildQuery  # use the real repair loop, so the real _validate_query is consulted
    inst.llm_calls = 0

    def once(question_text, *, limit, previous_query, error_message):
        inst.llm_calls += 1
        return {'isValid': True, 'query': 'MATCH (n) RETURN n LIMIT 1'}

    inst._buildQueryOnce = once
    return inst


def test_an_unreachable_database_during_explain_fails_the_question_lane_without_asking_the_llm_again():
    inst = _validating(outage=True)

    with pytest.raises(GraphUnavailableError):
        inst.writeQuestions(_question())

    assert inst.llm_calls == 1  # no repair loop: the outage is not the query's fault
    assert inst.instance.text == [] and inst.instance.answers == []


def test_an_unreachable_database_during_explain_is_an_explicit_result_for_the_tools():
    inst = _validating(outage=True)

    for result in (inst.get_query({'question': 'who?'}), inst.get_data({'question': 'who?'})):
        assert result['valid'] is False and 'unavailable' in result['error']


def test_a_genuine_validation_rejection_keeps_its_behaviour():
    inst = _validating(outage=False)

    inst.writeQuestions(_question())  # does not raise

    assert inst.llm_calls == 5  # the repair loop ran to exhaustion
    assert 'Syntax error' in inst.instance.text[0]
    assert 'Syntax error' in inst.instance.answers[0].getJson()['error']


# ---------------------------------------------------------------------------
# A failing downstream write is not swallowed here
# ---------------------------------------------------------------------------


class _DownstreamFails(_Lanes):
    """A downstream node whose own lane failed; the engine re-raises it here as a plain ``Exception``."""

    def writeText(self, text):
        raise Exception('Exception: rocketride_sql answers write failed; no rows were saved')

    def writeTable(self, markdown):
        raise Exception('Exception: rocketride_sql table write failed; no rows were saved')

    def writeAnswers(self, answer):
        raise Exception('Exception: rocketride_sql answers write failed; no rows were saved')


@pytest.mark.parametrize('kind', ['QUESTION', 'EXECUTE'])
@pytest.mark.parametrize('lanes', [('text',), ('table',), ('answers',)])
def test_the_lane_fails_when_a_downstream_write_fails(lanes, kind):
    inst = _make(fail=False, lanes=lanes)
    inst.instance = _DownstreamFails(lanes)

    with pytest.raises(Exception, match='write failed'):
        inst.writeQuestions(_question(getattr(QuestionType, kind), 'MATCH (n) RETURN n'))
