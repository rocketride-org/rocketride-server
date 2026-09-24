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

"""Unit tests for the listener engine (pipeline hand-off)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from . import _stubs

(engine,) = _stubs.load('listener.engine')


class FakePipe:
    def __init__(self, answers=None, raise_on=None):
        self.answers, self.raise_on, self.written = answers, raise_on, []

    def open(self, entry):
        self.entry = entry

    def writeQuestions(self, q):
        if self.raise_on == 'write':
            raise RuntimeError('lane closed')
        self.written.append(q)

    def close(self):
        self.entry.response = SimpleNamespace(toDict=lambda: {'answers': self.answers or []})


class FakeTarget:
    def __init__(self, pipe):
        self.pipe, self.returned = pipe, False

    def getPipe(self):
        return self.pipe

    def putPipe(self, pipe):
        self.returned = True


def test_run_item_returns_first_answer_and_writes_question():
    pipe = FakePipe(answers=['approved', 'x'])
    target = FakeTarget(pipe)
    assert engine.run_item(target, '[task t1 ...] check', 'listener://risk/t1') == 'approved'
    assert pipe.written[0].questions == ['[task t1 ...] check']
    assert pipe.entry.obj['url'] == 'listener://risk/t1' and target.returned


def test_run_item_serializes_non_string_answer():
    assert engine.run_item(FakeTarget(FakePipe(answers=[{'ok': True}])), 'q', 'n') == '{"ok": true}'


def test_run_item_raises_on_empty_answer_and_returns_pipe():
    target = FakeTarget(FakePipe(answers=[]))
    with pytest.raises(RuntimeError, match='no answer'):
        engine.run_item(target, 'q', 'n')
    assert target.returned


def test_run_item_propagates_pipeline_error():
    target = FakeTarget(FakePipe(raise_on='write'))
    with pytest.raises(RuntimeError, match='lane closed'):
        engine.run_item(target, 'q', 'n')
    assert target.returned


def test_run_item_raises_when_engine_marks_object_failed():
    pipe = FakePipe(answers=['partial'])
    orig_close = pipe.close

    def failing_close():
        orig_close()
        pipe.entry.objectFailed = True
        pipe.entry.completionError = {'message': 'llm 529 overloaded'}

    pipe.close = failing_close
    target = FakeTarget(pipe)
    with pytest.raises(RuntimeError, match='llm 529 overloaded'):
        engine.run_item(target, 'q', 'n')
    assert target.returned
