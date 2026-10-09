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
"""Contract tests: record, stamp, fingerprint, preview, snapshot."""

import hashlib
from types import SimpleNamespace

import pytest

from ai.common.decision.contract import (
    DecisionError,
    fingerprint,
    preview,
    record,
    snapshot,
    stamp,
)

QUESTIONS = {'is_spam': {'kind': 'yes_no', 'question': 'Is this spam?', 'threshold': 0.5}}
OK_ITEM = {'lane': 'text', 'status': 'ok', 'preview': 'hi', 'answers': {'is_spam': {'answer': 'no', 'confidence': 0.8}}}


def _record(response, item=OK_ITEM, **kw):
    args = {'writer': 'decision_ollama', 'questions': QUESTIONS, 'item': item, **kw}
    return record(response, 'decision_ollama_1', **args)


def test_key_appears_only_on_first_write():
    response = {'text': ['x']}
    assert snapshot(response) is None
    assert 'decisions' not in response
    assert _record(response, model='nimble') == 0
    assert response['result_types'] == {'decisions': 'decisions'}
    group = response['decisions']['decision_ollama_1']
    assert group == {'writer': 'decision_ollama', 'questions': QUESTIONS, 'model': 'nimble', 'items': [OK_ITEM]}


def test_items_append_and_index_is_permanent():
    response = {}
    assert [_record(response) for _ in range(3)] == [0, 1, 2]
    assert len(response['decisions']['decision_ollama_1']['items']) == 3


def test_existing_result_types_are_kept():
    response = {'result_types': {'text': 'text'}}
    _record(response)
    assert response['result_types'] == {'text': 'text', 'decisions': 'decisions'}


def test_usage_adds_up():
    response = {}
    _record(response, usage={'calls': 1, 'input_tokens': 10})
    _record(response, usage={'calls': 1, 'input_tokens': 5, 'output_tokens': 2})
    assert response['decisions']['decision_ollama_1']['usage'] == {'calls': 2, 'input_tokens': 15, 'output_tokens': 2}


def test_floats_are_rounded_to_four_places():
    response = {}
    item = {**OK_ITEM, 'answers': {'is_spam': {'answer': 'no', 'confidence': 0.123456789, 'probability': 0.987654321}}}
    _record(response, item=item)
    stored = response['decisions']['decision_ollama_1']['items'][0]['answers']['is_spam']
    assert stored == {'answer': 'no', 'confidence': 0.1235, 'probability': 0.9877}


def test_record_does_not_mutate_the_callers_item():
    response = {}
    item = {**OK_ITEM, 'answers': {'is_spam': {'answer': 'no', 'confidence': 0.123456789}}}
    _record(response, item=item)
    assert item['answers']['is_spam']['confidence'] == 0.123456789


def test_non_ok_status_needs_no_answers_and_may_not_carry_them():
    response = {}
    _record(
        response,
        item={'lane': 'documents', 'status': 'too_long', 'item': {'chunkId': 2}, 'size': {'tokens': 9, 'limit': 8}},
    )
    with pytest.raises(DecisionError, match='must not carry answers'):
        _record(response, item={**OK_ITEM, 'status': 'skipped'})


def test_fake_non_system_one_writer_with_number_answers_and_custom_status():
    response = {}
    questions = {'anomaly_score': {'kind': 'number'}}
    record(
        response,
        'anomaly_detector_1',
        writer='anomaly_detector',
        questions=questions,
        item={
            'lane': 'table',
            'status': 'ok',
            'item': {'table_index': 0, 'fingerprint': fingerprint('|a|')},
            'answers': {'anomaly_score': {'answer': 0.93}},
        },
    )
    record(
        response,
        'anomaly_detector_1',
        writer='anomaly_detector',
        questions=questions,
        item={'lane': 'table', 'status': 'unsupported', 'item': {'table_index': 1, 'fingerprint': fingerprint('|b|')}},
    )
    items = response['decisions']['anomaly_detector_1']['items']
    assert [i['status'] for i in items] == ['ok', 'unsupported']
    assert 'model' not in response['decisions']['anomaly_detector_1']


@pytest.mark.parametrize(
    'item, message',
    [
        ({'status': 'ok', 'answers': {}}, 'needs a "lane"'),
        ({'lane': 'text', 'answers': {}}, 'needs a "status"'),
        ({'lane': 'text', 'status': 'ok'}, 'answer exactly'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'other': {'answer': 'x'}}}, 'answer exactly'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'confidence': 0.5}}}, 'with an "answer"'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': None}}}, 'string, a finite number'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': float('nan')}}}, 'string, a finite number'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': 'no', 'confidence': 2}}}, 'confidence'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': 'x', 'index': 1.5}}}, 'index'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': 'no', 'best': 'yes'}}}, 'best'),
        ({'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': 'no'}}, 'extra': 1}, 'unknown keys'),
        (
            {'lane': 'text', 'status': 'ok', 'item': 3, 'answers': {'is_spam': {'answer': 'no'}}},
            '"item" must be a dict',
        ),
    ],
)
def test_bad_items_raise_in_the_writer(item, message):
    with pytest.raises(DecisionError, match=message):
        _record({}, item=item)


def test_bad_group_arguments_raise():
    with pytest.raises(DecisionError, match='group_id'):
        record({}, '', writer='w', questions=QUESTIONS, item=OK_ITEM)
    with pytest.raises(DecisionError, match='writer'):
        record({}, 'g', writer='', questions=QUESTIONS, item=OK_ITEM)
    with pytest.raises(DecisionError, match='needs a "kind"'):
        record({}, 'g', writer='w', questions={'is_spam': {}}, item=OK_ITEM)


def test_group_questions_are_fixed_by_the_first_write():
    response = {}
    _record(response)
    with pytest.raises(DecisionError, match='different writer or question set'):
        record(
            response,
            'decision_ollama_1',
            writer='decision_ollama',
            questions={'is_spam': {'kind': 'yes_no', 'question': 'Changed?'}},
            item=OK_ITEM,
        )


def test_stamp_adds_its_own_key_and_keeps_others():
    doc = SimpleNamespace(metadata=SimpleNamespace(decision_refs={'decision_ollama_1': 0}))
    stamp(doc, 'decision_ollama_2', 4)
    assert doc.metadata.decision_refs == {'decision_ollama_1': 0, 'decision_ollama_2': 4}


def test_stamp_copies_inherited_refs_instead_of_sharing_them():
    inherited = {'decision_ollama_1': 0}
    first = SimpleNamespace(metadata=SimpleNamespace(decision_refs=inherited))
    second = SimpleNamespace(metadata=SimpleNamespace(decision_refs=inherited))
    stamp(first, 'decision_ollama_2', 0)
    stamp(second, 'decision_ollama_2', 1)
    assert inherited == {'decision_ollama_1': 0}
    assert first.metadata.decision_refs['decision_ollama_2'] == 0
    assert second.metadata.decision_refs['decision_ollama_2'] == 1


def test_stamp_without_metadata_raises():
    with pytest.raises(DecisionError):
        stamp(SimpleNamespace(metadata=None), 'g', 0)


def test_fingerprint_is_sha256_of_exact_text():
    assert fingerprint('| a |') == 'sha256:' + hashlib.sha256('| a |'.encode('utf-8')).hexdigest()
    assert fingerprint('| a |') != fingerprint('| a | ')


def test_preview_is_one_line_and_at_most_80_chars():
    assert preview('  Hi\n\nthere  ') == 'Hi there'
    long = preview('word ' * 40)
    assert len(long) == 80 and long.endswith('…')
    assert preview(None) == ''


def test_snapshot_is_a_plain_copy():
    response = {}
    _record(response)
    copy = snapshot(response)
    copy['decision_ollama_1']['items'].clear()
    assert len(response['decisions']['decision_ollama_1']['items']) == 1
