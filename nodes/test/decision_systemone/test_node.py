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
"""Node-level tests for decision_systemone with a stubbed engine and a fake runner."""

import importlib
import sys
import types
from types import SimpleNamespace

import pytest

from ai.common.systemone.runner import DecisionResult


class _Meta(SimpleNamespace):
    def __init__(self, pInstance=None, chunkId=0, **kw):
        super().__init__(chunkId=chunkId, **kw)

    def model_dump(self):
        return dict(vars(self))


class _Doc(SimpleNamespace):
    def model_copy(self, deep=False):
        meta = _Meta(**vars(self.metadata)) if self.metadata is not None else None
        return _Doc(page_content=self.page_content, metadata=meta)


class _Answer:
    """Mirror of the real Answer: keyword-only ``expectJson``, payload set via ``setAnswer``."""

    def __init__(self, expectJson=False):
        self.expectJson = expectJson
        self.answer = None

    def setAnswer(self, value):
        self.answer = value


class _PreventDefault(Exception):
    pass


@pytest.fixture
def node(monkeypatch):
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = object
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')
    rocketlib.warning = lambda *_a, **_k: None
    rocketlib.debug = lambda *_a, **_k: None
    schema = types.ModuleType('ai.common.schema')
    schema.Doc, schema.DocMetadata, schema.Answer = _Doc, _Meta, _Answer
    config = types.ModuleType('ai.common.config')
    config.Config = SimpleNamespace(getNodeConfig=lambda *_a, **_k: {})
    for name, mod in {'rocketlib': rocketlib, 'ai.common.schema': schema, 'ai.common.config': config}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.delitem(sys.modules, 'ai.common.systemone.instance_base', raising=False)
    module = importlib.import_module('ai.common.systemone.instance_base')

    class Node(module.SystemOneInstanceBase):
        pass

    inst = Node()
    written = {'documents': [], 'answers': []}
    listeners = {'answers'}
    inst.instance = SimpleNamespace(
        writeDocuments=lambda docs: written['documents'].append(docs),
        writeAnswers=lambda ans: written['answers'].append(ans),
        hasListener=lambda lane: lane in listeners,
        pipeType={'id': 'decision_ollama_1'},
    )

    def prevent():
        raise _PreventDefault()

    inst.preventDefault = prevent
    calls = []

    class FakeRunner:
        def decide(self, content, metadata, *, source):
            calls.append((content, metadata, source))
            if not content.strip():
                return DecisionResult({}, None, False, skipped=True)
            return DecisionResult(
                {'urgent': {'answer': 'yes', 'source': source}}, {'input_tokens': 5, 'output_tokens': 1}, False
            )

    inst.IGlobal = SimpleNamespace(runner=FakeRunner())
    yield SimpleNamespace(inst=inst, written=written, calls=calls, listeners=listeners)
    # The module was imported against the stubs; don't let it outlive them on this worker.
    sys.modules.pop('ai.common.systemone.instance_base', None)
    package = sys.modules.get('ai.common.systemone')
    if package is not None and hasattr(package, 'instance_base'):
        delattr(package, 'instance_base')


def _doc(text, meta=True):
    return _Doc(page_content=text, metadata=_Meta(objectId='o1', parent='a.txt') if meta else None)


def test_writes_documents_once_with_decisions_and_prevents_default(node):
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello'), _doc('world')])
    assert len(node.written['documents']) == 1
    docs = node.written['documents'][0]
    assert [d.metadata.decisions['urgent']['answer'] for d in docs] == ['yes', 'yes']
    assert node.calls[0][2] == 'decision_ollama_1'


def test_input_docs_not_mutated(node):
    original = _doc('hello')
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([original])
    assert not hasattr(original.metadata, 'decisions')


def test_none_metadata_gets_created(node):
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello', meta=False)])
    assert node.written['documents'][0][0].metadata.decisions['urgent']['answer'] == 'yes'


def test_answers_emitted_only_when_listened(node):
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello')])
    payload = node.written['answers'][0].answer
    assert payload['parent'] == 'a.txt' and payload['decisions']['urgent']['answer'] == 'yes'
    assert node.written['answers'][0].expectJson is True
    node.listeners.clear()
    node.written['answers'].clear()
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello')])
    assert node.written['answers'] == []


def test_skipped_empty_doc_forwarded_without_decisions(node):
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('   ')])
    assert not hasattr(node.written['documents'][0][0].metadata, 'decisions')


def test_truncated_flag_set(node):
    node.inst.IGlobal.runner.decide = lambda c, m, *, source: DecisionResult({'u': {'source': source}}, None, True)
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello')])
    assert node.written['documents'][0][0].metadata.decisions_truncated is True


def test_source_falls_back_to_logical_type_when_pipe_type_is_an_object(node):
    node.inst.instance.pipeType = SimpleNamespace(id='decision_typesafe_2')
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello')])
    assert node.calls[0][2] == 'decision_typesafe_2'
    node.inst.instance.pipeType = None
    node.inst.IGlobal.glb = SimpleNamespace(logicalType='decision_ollama')
    with pytest.raises(_PreventDefault):
        node.inst.writeDocuments([_doc('hello')])
    assert node.calls[1][2] == 'decision_ollama'
