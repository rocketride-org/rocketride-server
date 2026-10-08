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
"""Unit tests for ai.common.decision.questions."""

import pytest

from ai.common.decision.limits import DecisionLimits
from ai.common.decision.questions import (
    PICK_ONE,
    RUBRIC,
    YES_NO,
    ProtocolError,
    QuestionConfigError,
    QuestionSpec,
    build_wire_questions,
    error_decision,
    map_answer,
    parse_questions,
)

LIM = DecisionLimits(max_options=4, max_levels=3, max_questions=3, max_state_tokens=1000)


def test_parse_all_three_kinds():
    cfg = {
        'yes_no': [{'name': 'urgent', 'question': 'Is it urgent?', 'yes_means': 'Deadline today', 'threshold': 0.7}],
        'pick_one': [{'name': 'team', 'question': 'Which team?', 'options': 'billing | Payments\nbug\n\n'}],
        'rubric': [{'name': 'severity', 'question': 'How bad?', 'levels': 'Fine\nBroken with workaround\nDown'}],
    }
    specs = parse_questions(cfg, LIM)
    assert [s.kind for s in specs] == [YES_NO, PICK_ONE, RUBRIC]
    assert specs[0].threshold == 0.7 and specs[0].yes_means == 'Deadline today'
    assert specs[1].options == (('billing', 'Payments'), ('bug', None))
    assert specs[2].levels == ('Fine', 'Broken with workaround', 'Down')


@pytest.mark.parametrize(
    'cfg, message',
    [
        ({}, 'at least one question'),
        ({'yes_no': [{'name': 'Bad Name', 'question': 'q'}]}, 'name'),
        ({'yes_no': [{'name': 'a', 'question': 'q'}, {'name': 'a', 'question': 'q'}]}, 'duplicate'),
        ({'yes_no': [{'name': 'a', 'question': ''}]}, 'question'),
        ({'pick_one': [{'name': 'a', 'question': 'q', 'options': 'only'}]}, 'at least 2'),
        ({'pick_one': [{'name': 'a', 'question': 'q', 'options': 'a\nb\nc\nd\ne'}]}, 'at most 4'),
        ({'pick_one': [{'name': 'a', 'question': 'q', 'options': 'a\na'}]}, 'duplicate option'),
        ({'pick_one': [{'name': 'a', 'question': 'q', 'options': 'ok\nuncertain'}]}, 'reserved'),
        ({'pick_one': [{'name': 'a', 'question': 'q', 'options': 'ok\nbad value'}]}, 'option value'),
        ({'rubric': [{'name': 'a', 'question': 'q', 'levels': 'a\nb\nc\nd'}]}, 'at most 3'),
        ({'yes_no': [{'name': 'a', 'question': 'q', 'threshold': 1.0}]}, 'threshold'),
        ({'yes_no': [{'name': n, 'question': 'q'} for n in ('a', 'b', 'c', 'd')]}, 'at most 3 questions'),
    ],
)
def test_parse_rejects_invalid(cfg, message):
    with pytest.raises(QuestionConfigError, match=message):
        parse_questions(cfg, LIM)


def test_build_wire_object_and_string_criteria():
    specs = [
        QuestionSpec('urgent', YES_NO, 'Urgent?', yes_means='Deadline', no_means='None'),
        QuestionSpec('team', PICK_ONE, 'Team?', options=(('billing', 'Payments'), ('bug', None))),
        QuestionSpec('sev', RUBRIC, 'Sev?', levels=('Fine', 'Down')),
    ]
    wire = build_wire_questions(specs, LIM)
    assert wire['urgent'] == {
        'type': 'noul',
        'instructions': 'Urgent?',
        'criteria': {'true': 'Deadline', 'false': 'None'},
    }
    assert wire['team'] == {'type': 'choice', 'instructions': 'Team?', 'criteria': {'billing': 'Payments', 'bug': None}}
    assert wire['sev'] == {'type': 'score', 'instructions': 'Sev?', 'criteria': ['Fine', 'Down']}


def test_build_wire_string_only_backend_replaces_null_descriptions():
    lim = DecisionLimits(max_options=4, max_levels=3, max_questions=3, max_state_tokens=1000, object_criteria=False)
    spec = QuestionSpec('team', PICK_ONE, 'Team?', options=(('billing', 'Payments'), ('bug', None)))
    assert build_wire_questions([spec], lim)['team']['criteria'] == {'billing': 'Payments', 'bug': 'bug'}


def test_yes_no_omits_criteria_when_unset():
    wire = build_wire_questions([QuestionSpec('u', YES_NO, 'Urgent?')], LIM)
    assert 'criteria' not in wire['u']


def test_map_yes_no_margin_confidence():
    spec = QuestionSpec('urgent', YES_NO, 'q', threshold=0.5)
    d = map_answer(spec, {'type': 'noul', 'noul': 0.95}, model='jev-1.13.0', source='n1')
    assert d['answer'] == 'yes' and d['probability'] == 0.95
    assert d['confidence'] == pytest.approx(0.9)
    assert d['uncertain'] is False and d['model'] == 'jev-1.13.0' and d['source'] == 'n1' and d['kind'] == YES_NO
    d = map_answer(spec, {'type': 'noul', 'noul': 0.2}, model=None, source='n1')
    assert d['answer'] == 'no' and d['confidence'] == pytest.approx(0.6)


def test_map_yes_no_custom_threshold():
    spec = QuestionSpec('urgent', YES_NO, 'q', threshold=0.8)
    d = map_answer(spec, {'type': 'noul', 'noul': 0.7}, model=None, source='n')
    assert d['answer'] == 'no' and d['confidence'] == pytest.approx(0.125)


def test_map_uncertain_below_min_confidence():
    spec = QuestionSpec('urgent', YES_NO, 'q', min_confidence=0.5)
    d = map_answer(spec, {'type': 'noul', 'noul': 0.6}, model=None, source='n')
    assert d['answer'] == 'uncertain' and d['uncertain'] is True and d['probability'] == 0.6


def test_map_pick_one_uses_backend_confidence():
    spec = QuestionSpec('team', PICK_ONE, 'q', options=(('billing', None), ('bug', None)))
    wire = {'type': 'choice', 'choice': 'bug', 'probabilities': {'billing': 0.1, 'bug': 0.9}, 'confidence': 0.8}
    d = map_answer(spec, wire, model=None, source='n')
    assert d['answer'] == 'bug' and d['probabilities'] == {'billing': 0.1, 'bug': 0.9} and d['confidence'] == 0.8


def test_map_pick_one_computes_confidence_when_absent():
    spec = QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None)))
    d = map_answer(
        spec, {'type': 'choice', 'choice': 'a', 'probabilities': {'a': 0.75, 'b': 0.25}}, model=None, source='n'
    )
    assert d['confidence'] == pytest.approx(0.5)


def test_spread_confidence_uses_option_count_not_returned_probabilities():
    """Spec 6.2: n is the number of options, even if the backend returns fewer probabilities."""
    spec = QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None), ('c', None)))
    d = map_answer(
        spec, {'type': 'choice', 'choice': 'a', 'probabilities': {'a': 0.8, 'b': 0.2}}, model=None, source='n'
    )
    assert d['confidence'] == pytest.approx((0.8 - 1 / 3) / (1 - 1 / 3))


def test_map_rubric_argmax_and_level_text():
    spec = QuestionSpec('sev', RUBRIC, 'q', levels=('Calm', 'Frustrated', 'Very angry'))
    wire = {
        'type': 'score',
        'score': 1.05,
        'legend': {'0': 'Calm'},
        'probabilities': {'0': 0.0, '1': 0.95, '2': 0.05},
        'confidence': 0.92,
    }
    d = map_answer(spec, wire, model=None, source='n')
    assert d['answer'] == 1 and d['score'] == 1.05 and d['level'] == 'Frustrated' and d['confidence'] == 0.92


def test_map_wrong_type_raises_protocol_error():
    with pytest.raises(ProtocolError):
        map_answer(QuestionSpec('u', YES_NO, 'q'), {'type': 'choice', 'choice': 'x'}, model=None, source='n')


def test_map_unknown_choice_raises_protocol_error():
    spec = QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None)))
    with pytest.raises(ProtocolError):
        map_answer(spec, {'type': 'choice', 'choice': 'zzz', 'probabilities': {}}, model=None, source='n')


def test_error_decision_shape():
    d = error_decision(QuestionSpec('u', YES_NO, 'q'), 'boom', source='n')
    assert d == {
        'kind': YES_NO,
        'answer': 'error',
        'uncertain': True,
        'confidence': 0.0,
        'error': 'boom',
        'model': None,
        'source': 'n',
    }


@pytest.mark.parametrize(
    'spec_obj, wire, description',
    [
        # YES_NO malformed: missing noul field
        (QuestionSpec('u', YES_NO, 'q'), {'type': 'noul'}, 'missing noul'),
        # YES_NO malformed: noul is None
        (QuestionSpec('u', YES_NO, 'q'), {'type': 'noul', 'noul': None}, 'noul is None'),
        # YES_NO malformed: noul is string
        (QuestionSpec('u', YES_NO, 'q'), {'type': 'noul', 'noul': 'hi'}, 'noul is string'),
        # YES_NO malformed: noul is NaN
        (QuestionSpec('u', YES_NO, 'q'), {'type': 'noul', 'noul': float('nan')}, 'noul is NaN'),
        # YES_NO malformed: noul is inf
        (QuestionSpec('u', YES_NO, 'q'), {'type': 'noul', 'noul': float('inf')}, 'noul is inf'),
        # YES_NO malformed: noul out of range [0, 1]
        (QuestionSpec('u', YES_NO, 'q'), {'type': 'noul', 'noul': 7.0}, 'noul out of range'),
        # PICK_ONE malformed: choice is list (unhashable)
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': ['a'], 'probabilities': {}},
            'choice is list',
        ),
        # PICK_ONE malformed: probabilities is list
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': [1]},
            'probabilities is list',
        ),
        # PICK_ONE malformed: probability value is string
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': {'a': 'high'}},
            'probability value is string',
        ),
        # PICK_ONE malformed: probability value NaN
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': {'a': float('nan')}},
            'probability value NaN',
        ),
        # PICK_ONE malformed: probability out of [0, 1]
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': {'a': 1.5}},
            'probability out of range',
        ),
        # PICK_ONE malformed: confidence is string
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': {}, 'confidence': 'high'},
            'confidence is string',
        ),
        # PICK_ONE malformed: confidence NaN
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': {}, 'confidence': float('nan')},
            'confidence NaN',
        ),
        # PICK_ONE malformed: confidence out of [0, 1]
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a', 'probabilities': {}, 'confidence': 1.5},
            'confidence out of range',
        ),
        # PICK_ONE malformed: no probabilities and no backend confidence
        (
            QuestionSpec('team', PICK_ONE, 'q', options=(('a', None), ('b', None))),
            {'type': 'choice', 'choice': 'a'},
            'missing both probabilities and confidence',
        ),
        # RUBRIC malformed: missing score
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'probabilities': {'0': 0.5, '1': 0.5}},
            'missing score',
        ),
        # RUBRIC malformed: score is None
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'score': None, 'probabilities': {'0': 0.5, '1': 0.5}},
            'score is None',
        ),
        # RUBRIC malformed: score is string
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'score': 'high', 'probabilities': {'0': 0.5, '1': 0.5}},
            'score is string',
        ),
        # RUBRIC malformed: probability key non-integer
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'score': 1.0, 'probabilities': {'x': 0.5, '1': 0.5}},
            'probability key non-integer',
        ),
        # RUBRIC malformed: probability value NaN
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'score': 1.0, 'probabilities': {'0': float('nan'), '1': 0.5}},
            'probability value NaN',
        ),
        # RUBRIC malformed: index out of range negative
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'score': 1.0, 'probabilities': {'-1': 0.9, '0': 0.1}},
            'index out of range negative',
        ),
        # RUBRIC malformed: index out of range too high
        (
            QuestionSpec('sev', RUBRIC, 'q', levels=('Low', 'High')),
            {'type': 'score', 'score': 1.0, 'probabilities': {'9': 0.9, '0': 0.1}},
            'index out of range too high',
        ),
    ],
)
def test_map_malformed_payloads_raise_protocol_error(spec_obj, wire, description):
    """Test that malformed backend answers raise ProtocolError instead of crashing."""
    with pytest.raises(ProtocolError):
        map_answer(spec_obj, wire, model=None, source='n')
