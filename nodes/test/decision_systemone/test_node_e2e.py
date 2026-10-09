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
"""End-to-end node test: real DecisionRunner and SystemOneClient over a mocked HTTP transport.

Only rocketlib and the document schema are stubbed (as in ``test_node.py``). The backend replies are the
literal TypeSafe answers from the protocol notes (section 1.3), merged into one reply for the one-call-per-document
request.
"""

import importlib
import json
import sys
import types
from types import SimpleNamespace

import httpx
import pytest

from ai.common.systemone.client import SystemOneClient
from ai.common.systemone.limits import DecisionLimits
from ai.common.systemone.questions import PICK_ONE, RUBRIC, YES_NO, QuestionSpec
from ai.common.systemone.runner import DecisionRunner

LIMITS = DecisionLimits(max_options=26, max_levels=10, max_questions=64, max_state_tokens=10_000)
SPECS = [
    QuestionSpec('is_urgent', YES_NO, 'Does this convey urgency?'),
    QuestionSpec(
        'department',
        PICK_ONE,
        'Which team should handle this?',
        options=(('billing', 'Payments'), ('technical', 'Bugs'), ('sales', 'Pricing')),
    ),
    QuestionSpec('frustration', RUBRIC, 'How frustrated is the customer?', levels=('Calm', 'Frustrated', 'Very angry')),
]
# Literal answers from protocol.md section 1.3, merged into one response.
BACKEND_REPLY = {
    'model': 'jev-1.13.0',
    'answers': {
        'is_urgent': {'type': 'noul', 'noul': 0.95},
        'department': {
            'type': 'choice',
            'choice': 'billing',
            'probabilities': {'billing': 0.88, 'technical': 0.12, 'sales': 0.0},
            'confidence': 0.81,
        },
        'frustration': {
            'type': 'score',
            'score': 1.05,
            'legend': {'0': 'Calm', '1': 'Frustrated', '2': 'Very angry'},
            'probabilities': {'0': 0.0, '1': 0.95, '2': 0.05},
            'confidence': 0.92,
        },
    },
    'usage': {'input_tokens': 296, 'output_tokens': 20},
}


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
    def __init__(self, expectJson=False):
        self.expectJson = expectJson
        self.answer = None

    def setAnswer(self, value):
        self.answer = value


class _PreventDefault(Exception):
    pass


@pytest.fixture
def e2e(monkeypatch):
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = object
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')
    rocketlib.warning = lambda *_a, **_k: None
    rocketlib.debug = lambda *_a, **_k: None
    schema = types.ModuleType('ai.common.schema')
    schema.Doc, schema.DocMetadata, schema.Answer = _Doc, _Meta, _Answer
    for name, mod in {'rocketlib': rocketlib, 'ai.common.schema': schema}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.delitem(sys.modules, 'ai.common.systemone.instance_base', raising=False)
    module = importlib.import_module('ai.common.systemone.instance_base')

    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=BACKEND_REPLY, headers={'x-typesafe-request-id': 'req-1'})

    client = SystemOneClient(
        'https://api.typesafe.ai', 'sk-test', transport=httpx.MockTransport(handler), sleep=lambda _s: None
    )
    runner = DecisionRunner(client, 'jev-latest', SPECS, LIMITS, warn=lambda _m: None)

    class Node(module.SystemOneInstanceBase):
        pass

    inst = Node()
    written = {'documents': [], 'answers': []}
    inst.instance = SimpleNamespace(
        writeDocuments=lambda docs: written['documents'].append(docs),
        writeAnswers=lambda ans: written['answers'].append(ans),
        hasListener=lambda lane: lane == 'answers',
        pipeType={'id': 'decision_typesafe_1'},
    )
    prevented = []

    def prevent():
        prevented.append(True)
        raise _PreventDefault()

    inst.preventDefault = prevent
    inst.IGlobal = SimpleNamespace(runner=runner)
    yield SimpleNamespace(inst=inst, written=written, requests=requests, prevented=prevented)
    client.close()
    sys.modules.pop('ai.common.systemone.instance_base', None)
    package = sys.modules.get('ai.common.systemone')
    if package is not None and hasattr(package, 'instance_base'):
        delattr(package, 'instance_base')


def _doc(text, object_id):
    return _Doc(page_content=text, metadata=_Meta(objectId=object_id, parent=f'{object_id}.txt'))


def test_node_asks_backend_once_per_document_and_annotates(e2e):
    docs = [_doc('Help! My payouts have been failing for 3 days.', 'o1'), _doc('Where is my invoice?', 'o2')]

    with pytest.raises(_PreventDefault):
        e2e.inst.writeDocuments(docs)

    # One HTTP request per document, each carrying all three questions.
    assert len(e2e.requests) == 2
    bodies = [json.loads(r.content) for r in e2e.requests]
    assert [b['state'] for b in bodies] == [d.page_content for d in docs]
    for body in bodies:
        assert body['model'] == 'jev-latest'
        assert set(body['questions']) == {'is_urgent', 'department', 'frustration'}
    assert e2e.requests[0].url == 'https://api.typesafe.ai/v1/systemone'
    assert e2e.requests[0].headers['authorization'] == 'Bearer sk-test'

    # Documents written once, annotated per spec section 6, originals untouched.
    assert e2e.prevented == [True]
    assert len(e2e.written['documents']) == 1
    written = e2e.written['documents'][0]
    assert [d.metadata.objectId for d in written] == ['o1', 'o2']
    for doc in written:
        decisions = doc.metadata.decisions
        assert decisions['is_urgent']['answer'] == 'yes' and decisions['is_urgent']['probability'] == 0.95
        assert decisions['is_urgent']['confidence'] == pytest.approx(0.9)
        assert (
            decisions['is_urgent']['model'] == 'jev-1.13.0'
            and decisions['is_urgent']['source'] == 'decision_typesafe_1'
        )
        assert decisions['department']['answer'] == 'billing' and decisions['department']['confidence'] == 0.81
        assert decisions['department']['probabilities']['technical'] == 0.12
        assert decisions['frustration']['answer'] == 1 and decisions['frustration']['level'] == 'Frustrated'
        assert decisions['frustration']['score'] == 1.05 and decisions['frustration']['confidence'] == 0.92
        assert not hasattr(doc.metadata, 'decisions_truncated')
    assert not hasattr(docs[0].metadata, 'decisions')

    # One answers payload per document.
    payloads = [a.answer for a in e2e.written['answers']]
    assert [p['objectId'] for p in payloads] == ['o1', 'o2']
    assert payloads[0]['decisions']['department']['answer'] == 'billing'
    assert payloads[0]['usage'] == {'input_tokens': 296, 'output_tokens': 20}
    assert all(a.expectJson is True for a in e2e.written['answers'])
