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
"""End-to-end System One node test: real DecisionRunner and SystemOneClient over a mocked HTTP transport.

Only rocketlib and the document schema are stubbed (see ``conftest.py``). The backend reply is the literal TypeSafe
answers from the protocol notes (section 1.3), merged into one reply for the one-call-per-item request.
"""

import json
from types import SimpleNamespace

import httpx
import pytest

from ai.common.decision import resolve, snapshot
from ai.common.systemone.client import SystemOneClient
from ai.common.systemone.limits import DecisionLimits
from ai.common.systemone.questions import PICK_ONE, RUBRIC, YES_NO, QuestionSpec
from ai.common.systemone.runner import DecisionRunner

from .conftest import Doc, Meta, Prevented

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


def test_real_runner_and_client_record_contract_answers(systemone):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=BACKEND_REPLY)

    client = SystemOneClient('http://jev.test', transport=httpx.MockTransport(handler), sleep=lambda _s: None)

    class Node(systemone.instance_base.SystemOneInstanceBase):
        pass

    inst = Node()
    out = []
    inst.instance = SimpleNamespace(
        currentObject=SimpleNamespace(response={}), writeDocuments=out.append, pipeType={'id': 'decision_typesafe_1'}
    )
    inst.IGlobal = SimpleNamespace(
        runner=DecisionRunner(client, 'jev-1.13.0', SPECS, LIMITS), glb=SimpleNamespace(logicalType='decision_typesafe')
    )

    def prevent():
        raise Prevented()

    inst.preventDefault = prevent
    inst.open(None)
    with pytest.raises(Prevented):
        inst.writeDocuments([Doc('I was double charged!', Meta(objectId='o1', chunkId=0))])

    assert requests[0]['state'] == 'I was double charged!'
    assert set(requests[0]['questions']) == {'is_urgent', 'department', 'frustration'}
    decisions = snapshot(inst.instance.currentObject.response)
    refs = out[0][0].metadata.decision_refs
    assert resolve(decisions, 'documents', 'department', refs=refs)['answer'] == 'billing'
    frustration = resolve(decisions, 'documents', 'frustration', refs=refs)
    assert frustration['answer'] == 'Frustrated' and frustration['index'] == 1
    assert frustration['probabilities'] == {'Calm': 0.0, 'Frustrated': 0.95, 'Very angry': 0.05}
    assert resolve(decisions, 'documents', 'is_urgent', refs=refs)['answer'] == 'yes'
    assert decisions['decision_typesafe_1']['usage'] == {'calls': 1, 'input_tokens': 296, 'output_tokens': 20}
