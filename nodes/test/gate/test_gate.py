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

"""Gate node: passes or blocks each item by response['decisions'] (spec §7)."""

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from rocketlib import AVI_ACTION

from ai.common.decision import DecisionError, fingerprint, parse_rule, record

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

# The package re-exports the IInstance class under the module's name, so `import gate.IInstance as x` would bind the class.
gate_instance = importlib.import_module('gate.IInstance')

SPAM = {'is_spam': {'kind': 'yes_no'}}
TOPIC = {'topic': {'kind': 'pick_one'}}


class Blocked(Exception):
    pass


def _gate(conditions, match='all'):
    inst = gate_instance.IInstance()
    out = {'documents': []}
    inst.instance = SimpleNamespace(currentObject=SimpleNamespace(response={}), writeDocuments=out['documents'].append)
    inst.IGlobal = SimpleNamespace(rule=parse_rule({'match': match, 'conditions': conditions}))

    def block():
        raise Blocked()

    inst.preventDefault = block
    return inst, out


def _spam(inst, answer):
    record(
        inst.instance.currentObject.response,
        'so_1',
        writer='decision_ollama',
        questions=SPAM,
        item={'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': answer}}},
    )


def _doc(text, refs=None):
    meta = SimpleNamespace(decision_refs=refs) if refs is not None else SimpleNamespace()
    return SimpleNamespace(page_content=text, metadata=meta)


NOT_SPAM = [{'question': 'is_spam', 'op': 'equals', 'value': 'no'}]


def test_text_passes_when_the_rule_holds():
    inst, _ = _gate(NOT_SPAM)
    _spam(inst, 'no')
    assert inst.writeText('hello') is None


def test_text_is_blocked_when_the_rule_fails():
    inst, _ = _gate(NOT_SPAM)
    _spam(inst, 'yes')
    with pytest.raises(Blocked):
        inst.writeText('hello')


def test_missing_decision_names_question_lane_and_fix():
    inst, _ = _gate(NOT_SPAM)
    with pytest.raises(DecisionError) as caught:
        inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    message = str(caught.value)
    assert '"is_spam"' in message and 'image lane' in message and 'downstream' in message


def test_documents_are_filtered_per_document():
    inst, out = _gate([{'question': 'topic', 'op': 'equals', 'value': 'billing'}])
    response = inst.instance.currentObject.response
    for answer in ('billing', 'legal'):
        record(
            response,
            'so_2',
            writer='w',
            questions=TOPIC,
            item={
                'lane': 'documents',
                'status': 'ok',
                'item': {'chunkId': 0},
                'answers': {'topic': {'answer': answer}},
            },
        )
    with pytest.raises(Blocked):
        inst.writeDocuments([_doc('a', {'so_2': 0}), _doc('b', {'so_2': 1})])
    assert [d.page_content for d in out['documents'][0]] == ['a']


def test_documents_none_passing_forwards_nothing():
    inst, out = _gate([{'question': 'topic', 'op': 'equals', 'value': 'billing'}])
    record(
        inst.instance.currentObject.response,
        'so_2',
        writer='w',
        questions=TOPIC,
        item={'lane': 'documents', 'status': 'ok', 'item': {'chunkId': 0}, 'answers': {'topic': {'answer': 'legal'}}},
    )
    with pytest.raises(Blocked):
        inst.writeDocuments([_doc('a', {'so_2': 0})])
    assert out['documents'] == []


def test_too_long_item_is_blocked_whatever_the_rule_and_warned(monkeypatch):
    warnings = []
    monkeypatch.setattr(gate_instance, 'warning', warnings.append)
    inst, out = _gate([{'question': 'topic', 'op': 'not_equals', 'value': 'billing'}])
    record(
        inst.instance.currentObject.response,
        'so_2',
        writer='w',
        questions=TOPIC,
        item={'lane': 'documents', 'status': 'too_long', 'item': {'chunkId': 0}},
    )
    with pytest.raises(Blocked):
        inst.writeDocuments([_doc('huge', {'so_2': 0})])
    assert out['documents'] == []
    assert 'too_long' in warnings[0]


def test_chunk_without_its_own_ref_uses_the_whole_object_decision():
    inst, out = _gate(NOT_SPAM)
    _spam(inst, 'no')
    with pytest.raises(Blocked):
        inst.writeDocuments([_doc('chunk')])
    assert len(out['documents'][0]) == 1


def test_table_uses_its_fingerprint_then_object_level():
    inst, _ = _gate([{'question': 'risky', 'op': 'equals', 'value': 'yes'}])
    record(
        inst.instance.currentObject.response,
        'so_3',
        writer='w',
        questions={'risky': {'kind': 'yes_no'}},
        item={
            'lane': 'table',
            'status': 'ok',
            'item': {'table_index': 0, 'fingerprint': fingerprint('|t|')},
            'answers': {'risky': {'answer': 'yes'}},
        },
    )
    assert inst.writeTable('|t|') is None
    with pytest.raises(DecisionError):
        inst.writeTable('|other|')


@pytest.mark.parametrize('lane', ['writeImage', 'writeAudio', 'writeVideo'])
def test_media_checks_every_call_on_the_object_decision(lane):
    inst, _ = _gate(NOT_SPAM)
    _spam(inst, 'yes')
    for action in (AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END):
        with pytest.raises(Blocked):
            getattr(inst, lane)(action, 'video/mp4', b'x')


def test_questions_answers_and_json_use_object_level():
    inst, _ = _gate(NOT_SPAM)
    _spam(inst, 'no')
    question = SimpleNamespace(questions=[SimpleNamespace(text='q?')])
    answer = SimpleNamespace(getText=lambda: 'a')
    assert inst.writeQuestions(question) is None
    assert inst.writeAnswers(answer) is None
    assert inst.writeJson({'k': 1}) is None


def test_match_any():
    inst, _ = _gate([*NOT_SPAM, {'question': 'is_spam', 'op': 'equals', 'value': 'yes'}], match='any')
    _spam(inst, 'yes')
    assert inst.writeText('x') is None


def test_lifecycle_calls_always_continue():
    inst, _ = _gate(NOT_SPAM)
    inst.open(None)
    inst.closing()
    inst.close()
