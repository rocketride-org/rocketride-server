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
"""DecisionWriterBase with a toy writer: the lane plumbing any pure decision node inherits."""

from types import SimpleNamespace

import pytest

from .conftest import Doc, Meta, Prevented

QUESTIONS = {'long': {'kind': 'yes_no', 'values': ['yes', 'no']}}


@pytest.fixture
def toy(systemone):
    writer = systemone.writer

    class Toy(writer.DecisionWriterBase):
        def questions(self):
            return QUESTIONS

        def decide(self, state, lane):
            if 'HUGE' in str(state):
                return writer.TooLong({'tokens': 999, 'limit': 10})
            return writer.Decided({'long': {'answer': 'yes' if len(str(state)) > 5 else 'no'}}, usage={'calls': 1})

    inst = Toy()
    written = {'text': [], 'documents': []}
    inst.instance = SimpleNamespace(
        currentObject=SimpleNamespace(response={}),
        writeText=written['text'].append,
        writeDocuments=written['documents'].append,
        pipeType={'id': 'toy_1'},
    )
    inst.IGlobal = SimpleNamespace(glb=SimpleNamespace(logicalType='toy'))

    def prevent():
        raise Prevented()

    inst.preventDefault = prevent
    inst.open(None)
    return SimpleNamespace(inst=inst, written=written, warnings=systemone.warnings)


def _items(toy):
    return toy.inst.instance.currentObject.response['decisions']['toy_1']['items']


def test_text_is_buffered_then_decided_once_at_closing_and_replayed(toy):
    with pytest.raises(Prevented):
        toy.inst.writeText('hello ')
    with pytest.raises(Prevented):
        toy.inst.writeText('world')
    assert toy.written['text'] == []
    toy.inst.closing()
    assert toy.written['text'] == ['hello ', 'world']
    assert _items(toy) == [
        {'lane': 'text', 'status': 'ok', 'preview': 'hello world', 'answers': {'long': {'answer': 'yes'}}}
    ]


def test_documents_are_decided_stamped_and_forwarded_once(toy):
    docs = [Doc('hi', Meta(chunkId=0)), Doc('a longer one', Meta(chunkId=1))]
    with pytest.raises(Prevented):
        toy.inst.writeDocuments(docs)
    (forwarded,) = toy.written['documents']
    assert [d.metadata.decision_refs for d in forwarded] == [{'toy_1': 0}, {'toy_1': 1}]
    assert [i['answers']['long']['answer'] for i in _items(toy)] == ['no', 'yes']


def test_a_too_long_document_is_recorded_not_raised(toy):
    with pytest.raises(Prevented):
        toy.inst.writeDocuments([Doc('HUGE text', Meta(chunkId=0))])
    assert _items(toy)[0]['status'] == 'too_long'
    assert any('too long' in w for w in toy.warnings)


def test_too_long_text_fails_the_object(toy):
    with pytest.raises(Prevented):
        toy.inst.writeText('HUGE')
    with pytest.raises(ValueError, match='too long'):
        toy.inst.closing()
