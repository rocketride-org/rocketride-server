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
