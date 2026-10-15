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
from rocketlib.decisions import record

from ai.common.decision import DecisionError, fingerprint, parse_rule

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
    traces = []
    inst.instance = SimpleNamespace(
        currentObject=SimpleNamespace(response={}),
        writeDocuments=out['documents'].append,
        setTraceDetail=traces.append,
    )
    inst.IGlobal = SimpleNamespace(rule=parse_rule({'match': match, 'conditions': conditions}))
    # The installed rocketlib may predate IInstanceBase.setTraceDetail; bind it directly.
    inst.setTraceDetail = traces.append

    def block():
        raise Blocked()

    inst.preventDefault = block
    return inst, out, traces


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
    inst, _, _ = _gate(NOT_SPAM)
    _spam(inst, 'no')
    assert inst.writeText('hello') is None


def test_text_is_blocked_when_the_rule_fails():
    inst, _, _ = _gate(NOT_SPAM)
    _spam(inst, 'yes')
    with pytest.raises(Blocked):
        inst.writeText('hello')


def test_missing_decision_names_question_lane_and_fix():
    inst, _, _ = _gate(NOT_SPAM)
    with pytest.raises(DecisionError) as caught:
        inst.writeText('hello')
    message = str(caught.value)
    assert '"is_spam"' in message and 'text lane' in message and 'downstream' in message


@pytest.mark.parametrize('call', ['writeImage', 'writeAudio', 'writeVideo'])
def test_missing_decision_on_a_media_lane_explains_the_text_only_writer(call):
    inst, _, _ = _gate(NOT_SPAM)
    lane = call.removeprefix('write').lower()
    with pytest.raises(DecisionError) as caught:
        getattr(inst, call)(AVI_ACTION.BEGIN, 'x/y', b'')
    message = str(caught.value)
    assert '"is_spam"' in message and f'{lane} lane' in message
    assert f'before this {lane} item arrived' in message and 'text lanes only' in message


def test_missing_decision_on_the_json_lane_explains_the_text_only_writer():
    inst, _, _ = _gate(NOT_SPAM)
    with pytest.raises(DecisionError) as caught:
        inst.writeJson({'a': 1})
    message = str(caught.value)
    assert '"is_spam"' in message and 'json lane' in message
    assert 'before this json item arrived' in message and 'text lanes only' in message


def test_documents_are_filtered_per_document():
    inst, out, _ = _gate([{'question': 'topic', 'op': 'equals', 'value': 'billing'}])
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
    inst, out, _ = _gate([{'question': 'topic', 'op': 'equals', 'value': 'billing'}])
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
    inst, out, _ = _gate([{'question': 'topic', 'op': 'not_equals', 'value': 'billing'}])
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


def test_too_long_first_question_does_not_hide_a_missing_second_decision(monkeypatch):
    """Spec 7.2: every question is resolved before a NotDecided item may block."""
    warnings = []
    monkeypatch.setattr(gate_instance, 'warning', warnings.append)
    inst, _, _ = _gate(
        [
            {'question': 'topic', 'op': 'not_equals', 'value': 'billing'},
            {'question': 'is_spam', 'op': 'equals', 'value': 'no'},
        ]
    )
    record(
        inst.instance.currentObject.response,
        'so_2',
        writer='w',
        questions=TOPIC,
        item={'lane': 'documents', 'status': 'too_long', 'item': {'chunkId': 0}},
    )
    with pytest.raises(DecisionError) as caught:
        inst.writeDocuments([_doc('huge', {'so_2': 0})])
    assert '"is_spam"' in str(caught.value)
    assert warnings == []


def test_chunk_without_its_own_ref_uses_the_whole_object_decision():
    inst, out, traces = _gate(NOT_SPAM)
    _spam(inst, 'no')
    assert inst.writeDocuments([_doc('chunk')]) is None  # it passed, so the engine forwards the original list
    assert out['documents'] == []
    assert traces[0]['passed'] == 1


def test_table_uses_its_fingerprint_then_object_level():
    inst, _, _ = _gate([{'question': 'risky', 'op': 'equals', 'value': 'yes'}])
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
    inst, _, _ = _gate(NOT_SPAM)
    _spam(inst, 'yes')
    for action in (AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END):
        with pytest.raises(Blocked):
            getattr(inst, lane)(action, 'video/mp4', b'x')


def test_questions_answers_and_json_use_object_level():
    inst, _, _ = _gate(NOT_SPAM)
    _spam(inst, 'no')
    question = SimpleNamespace(questions=[SimpleNamespace(text='q?')])
    answer = SimpleNamespace(getText=lambda: 'a')
    assert inst.writeQuestions(question) is None
    assert inst.writeAnswers(answer) is None
    assert inst.writeJson({'k': 1}) is None


def test_match_any():
    inst, _, _ = _gate([*NOT_SPAM, {'question': 'is_spam', 'op': 'equals', 'value': 'yes'}], match='any')
    _spam(inst, 'yes')
    assert inst.writeText('x') is None


def test_lifecycle_calls_always_continue():
    inst, _, _ = _gate(NOT_SPAM)
    inst.open(None)
    inst.closing()
    inst.close()


SPAM_WITH_VALUES = {'is_spam': {'kind': 'yes_no', 'values': ['yes', 'no']}}


def _spam_with_values(inst, answer=None, status='ok'):
    item = {'lane': 'text', 'status': status}
    if status == 'ok':
        item['answers'] = {'is_spam': {'answer': answer}}
    record(
        inst.instance.currentObject.response,
        'so_1',
        writer='decision_ollama',
        questions=SPAM_WITH_VALUES,
        item=item,
    )


def test_value_typo_is_a_loud_error():
    inst, _, _ = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'Yes'}])
    _spam_with_values(inst, 'yes')
    with pytest.raises(DecisionError) as caught:
        inst.writeText('hello')
    assert 'is not an answer "is_spam" can have (so_1 answers: yes, no)' in str(caught.value)


def test_value_typo_errors_even_when_the_item_was_not_decided():
    inst, _, _ = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'Yes'}])
    _spam_with_values(inst, status='too_long')
    with pytest.raises(DecisionError, match='is not an answer'):
        inst.writeText('hello')


def test_valid_values_still_route():
    inst, _, _ = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    _spam_with_values(inst, 'no')
    assert inst.writeText('hello') is None


def test_writer_without_values_is_not_checked():
    inst, _, _ = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'Yes'}])
    _spam(inst, 'yes')  # header has no values
    with pytest.raises(Blocked):
        inst.writeText('hello')


def test_value_typo_raises_on_every_item_not_just_the_first():
    inst, _, _ = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'Yes'}])
    _spam_with_values(inst, 'yes')
    for _ in range(2):
        with pytest.raises(DecisionError, match='is not an answer'):
            inst.writeText('hello')


def test_a_passed_value_check_is_remembered_per_instance_only():
    first, _, _ = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    _spam_with_values(first, 'no')
    first.writeText('a')
    assert first._values_checked == {(0, 'so_1')}
    assert gate_instance.IInstance._values_checked == frozenset()


def test_text_detail_explains_a_pass():
    inst, _, traces = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    _spam(inst, 'no')
    inst.writeText('hello')
    assert traces == [
        {
            'outcome': 'passed',
            'match': 'all',
            'conditions': [
                {'question': 'is_spam', 'op': 'equals', 'value': 'no', 'answer': 'no', 'from': 'so_1', 'matched': True}
            ],
        }
    ]


def test_text_detail_explains_a_block_by_status():
    inst, _, traces = _gate(NOT_SPAM)
    record(
        inst.instance.currentObject.response,
        'so_1',
        writer='decision_ollama',
        questions=SPAM,
        item={'lane': 'text', 'status': 'too_long'},
    )
    with pytest.raises(Blocked):
        inst.writeText('hello')
    assert traces == [{'outcome': 'blocked', 'reason': 'so_1 recorded "too_long"', 'conditions': []}]


def test_text_detail_explains_a_block_by_the_rule_with_confidence_and_list_values():
    inst, _, traces = _gate([{'question': 'is_spam', 'op': 'in', 'value': ['no']}])
    record(
        inst.instance.currentObject.response,
        'so_1',
        writer='decision_ollama',
        questions=SPAM,
        item={'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': 'yes', 'confidence': 0.9}}},
    )
    with pytest.raises(Blocked):
        inst.writeText('hello')
    (condition,) = traces[0]['conditions']
    assert traces[0]['outcome'] == 'blocked'
    assert condition['value'] == ['no'] and condition['matched'] is False and condition['confidence'] == 0.9


def test_documents_all_pass_returns_normally_without_forwarding_itself():
    inst, out, traces = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    record(
        inst.instance.currentObject.response,
        'so_1',
        writer='decision_ollama',
        questions=SPAM,
        item={'lane': 'documents', 'status': 'ok', 'item': {'chunkId': 0}, 'answers': {'is_spam': {'answer': 'no'}}},
    )
    docs = [_doc('a', {'so_1': 0}), _doc('b', {'so_1': 0})]
    assert inst.writeDocuments(docs) is None  # the engine forwards the original list
    assert out['documents'] == []
    assert traces[0]['outcome'] == 'passed' and traces[0]['passed'] == 2 and traces[0]['blocked'] == 0


def test_documents_partial_forwards_subset_and_blocks():
    inst, out, traces = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    response = inst.instance.currentObject.response
    for index, answer in enumerate(['no', 'yes']):
        record(
            response,
            'so_1',
            writer='decision_ollama',
            questions=SPAM,
            item={
                'lane': 'documents',
                'status': 'ok',
                'item': {'chunkId': index},
                'answers': {'is_spam': {'answer': answer}},
            },
        )
    docs = [_doc('keep', {'so_1': 0}), _doc('drop', {'so_1': 1})]
    with pytest.raises(Blocked):
        inst.writeDocuments(docs)
    assert [d.page_content for d in out['documents'][0]] == ['keep']
    detail = traces[0]
    assert detail['outcome'] == 'partial' and [i['outcome'] for i in detail['items']] == ['passed', 'blocked']
    assert detail['items'][0]['preview'] == 'keep'


def test_documents_none_passing_detail_is_blocked():
    inst, _, traces = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    _spam(inst, 'yes')
    with pytest.raises(Blocked):
        inst.writeDocuments([_doc('a'), _doc('b')])
    assert traces[0]['outcome'] == 'blocked' and traces[0]['passed'] == 0 and traces[0]['blocked'] == 2


def test_documents_detail_caps_items():
    inst, _, traces = _gate([{'question': 'is_spam', 'op': 'equals', 'value': 'no'}])
    record(
        inst.instance.currentObject.response,
        'so_1',
        writer='decision_ollama',
        questions=SPAM,
        item={'lane': 'documents', 'status': 'ok', 'item': {'chunkId': 0}, 'answers': {'is_spam': {'answer': 'no'}}},
    )
    docs = [_doc(f'd{i}', {'so_1': 0}) for i in range(150)]
    assert inst.writeDocuments(docs) is None
    detail = traces[0]
    assert len(detail['items']) == 100 and detail['items_truncated'] == 50 and detail['passed'] == 150
