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
"""Contract tests: resolve() (spec §3.4)."""

import pytest

from ai.common.decision.contract import DecisionError, NotDecided, fingerprint, record, resolve

SPAM = {'is_spam': {'kind': 'yes_no'}}
TOPIC = {'topic': {'kind': 'pick_one', 'options': ['billing', 'legal']}}


def _ok(lane, answers, **extra):
    return {'lane': lane, 'status': 'ok', 'answers': answers, **extra}


def _build():
    """Text-lane spam decision (g1), two chunk decisions (g2), one table decision (g3)."""
    response = {}
    record(response, 'g1', writer='w', questions=SPAM, item=_ok('text', {'is_spam': {'answer': 'no'}}))
    record(
        response,
        'g2',
        writer='w',
        questions=TOPIC,
        item=_ok('documents', {'topic': {'answer': 'billing'}}, item={'chunkId': 0}),
    )
    record(
        response,
        'g2',
        writer='w',
        questions=TOPIC,
        item={'lane': 'documents', 'status': 'too_long', 'item': {'chunkId': 1}},
    )
    record(
        response,
        'g3',
        writer='w',
        questions={'risky': {'kind': 'yes_no'}},
        item=_ok('table', {'risky': {'answer': 'yes'}}, item={'table_index': 0, 'fingerprint': fingerprint('|t|')}),
    )
    return response['decisions']


def test_document_ref_finds_its_item():
    assert resolve(_build(), 'documents', 'topic', refs={'g2': 0}) == {'answer': 'billing'}


def test_document_ref_to_a_too_long_item_is_not_decided():
    assert resolve(_build(), 'documents', 'topic', refs={'g2': 1}) == NotDecided(status='too_long', group='g2')


def test_inherited_ref_from_a_parent_document_resolves():
    # A chunk produced from a referenced document carries the parent's refs unchanged.
    assert resolve(_build(), 'documents', 'topic', refs={'g2': 0, 'other_node': 7}) == {'answer': 'billing'}


def test_document_without_a_ref_for_the_question_falls_back_to_object_level():
    assert resolve(_build(), 'documents', 'is_spam', refs={'g2': 0}) == {'answer': 'no'}


def test_table_fingerprint_finds_its_item():
    assert resolve(_build(), 'table', 'risky', table_key=fingerprint('|t|')) == {'answer': 'yes'}


def test_text_lane_uses_the_object_level_item():
    assert resolve(_build(), 'text', 'is_spam') == {'answer': 'no'}


def test_unanswered_question_returns_none():
    assert resolve(_build(), 'text', 'nobody_asked') is None
    assert resolve(None, 'text', 'is_spam') is None
    assert resolve(_build(), 'documents', 'topic') is None  # no ref and no object-level topic item


def test_ref_to_a_missing_index_is_an_error():
    with pytest.raises(DecisionError, match='does not exist'):
        resolve(_build(), 'documents', 'topic', refs={'g2': 9})


def test_same_question_from_two_writers_is_ambiguous():
    decisions = _build()
    decisions['g4'] = {'writer': 'x', 'questions': SPAM, 'items': [_ok('text', {'is_spam': {'answer': 'yes'}})]}
    with pytest.raises(DecisionError, match='"is_spam" is answered by both g1 and g4; rename one'):
        resolve(decisions, 'text', 'is_spam')


def test_object_level_prefers_same_lane_then_text_then_the_only_one():
    group = {
        'writer': 'w',
        'questions': SPAM,
        'items': [
            _ok('text', {'is_spam': {'answer': 'no'}}),
            _ok('questions', {'is_spam': {'answer': 'yes'}}),
        ],
    }
    decisions = {'g': group}
    assert resolve(decisions, 'questions', 'is_spam') == {'answer': 'yes'}  # same lane
    assert resolve(decisions, 'json', 'is_spam') == {'answer': 'no'}  # text wins
    only = {'g': {'writer': 'w', 'questions': SPAM, 'items': [_ok('answers', {'is_spam': {'answer': 'yes'}})]}}
    assert resolve(only, 'image', 'is_spam') == {'answer': 'yes'}  # the only one


def test_several_object_level_items_with_no_preference_is_ambiguous():
    group = {
        'writer': 'w',
        'questions': SPAM,
        'items': [
            _ok('questions', {'is_spam': {'answer': 'no'}}),
            _ok('answers', {'is_spam': {'answer': 'yes'}}),
        ],
    }
    with pytest.raises(DecisionError, match='whole-object decisions'):
        resolve({'g': group}, 'image', 'is_spam')


def test_same_table_twice_in_one_group_is_not_ambiguous():
    response = {}
    for index in range(2):
        record(
            response,
            'g3',
            writer='w',
            questions={'risky': {'kind': 'yes_no'}},
            item=_ok(
                'table',
                {'risky': {'answer': 'yes' if index == 0 else 'no'}},
                item={'table_index': index, 'fingerprint': fingerprint('|t|')},
            ),
        )
    assert resolve(response['decisions'], 'table', 'risky', table_key=fingerprint('|t|')) == {'answer': 'yes'}


def test_item_level_hit_wins_over_object_level():
    decisions = _build()
    decisions['g5'] = {'writer': 'w', 'questions': TOPIC, 'items': [_ok('text', {'topic': {'answer': 'legal'}})]}
    assert resolve(decisions, 'documents', 'topic', refs={'g2': 0}) == {'answer': 'billing'}
