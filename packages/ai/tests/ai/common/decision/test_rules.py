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
"""Gate rule tests: parse_rule shapes and every operator (spec §7.1)."""

import pytest

from ai.common.decision.rules import Condition, Rule, RuleConfigError, check, evaluate, parse_rule

YES = {'answer': 'yes', 'confidence': 0.9}
UNSURE = {'answer': 'uncertain', 'best': 'yes', 'confidence': 0.1}
HIGH = {'answer': 'high', 'index': 2, 'score': 1.9}
UNSURE_RUBRIC = {'answer': 'uncertain', 'best': 'high'}
SCORE = {'answer': 0.93}
FLAG = {'answer': True}


def _c(op, value=None, question='q'):
    return parse_rule({'conditions': [{'question': question, 'op': op, 'value': value}]}).conditions[0]


@pytest.mark.parametrize(
    'op, value, answer, expected',
    [
        ('equals', 'yes', YES, True),
        ('equals', 'no', YES, False),
        ('not_equals', 'yes', YES, False),
        ('not_equals', 'yes', UNSURE, True),  # uncertain is an ordinary value: makes not_equals work as "otherwise"
        ('equals', 'yes', UNSURE, False),
        ('in', 'billing, yes', YES, True),
        ('in', ['billing', 'legal'], YES, False),
        ('not_in', 'billing\nlegal', YES, True),
        ('equals', 'high', HIGH, True),  # labels compare the answer
        ('gte', '1', HIGH, True),  # numeric ops compare index
        ('lt', 2, HIGH, False),
        ('between', '1, 2', HIGH, True),
        ('gt', 0, UNSURE_RUBRIC, False),  # uncertain has no index
        ('gt', '0.9', SCORE, True),
        ('lte', 0.5, SCORE, False),
        ('between', [0.9, 1], SCORE, True),
        ('gt', 0, YES, False),  # a string label has no number
        ('exists', None, YES, True),
        ('exists', None, UNSURE, False),
        ('not_exists', '', UNSURE, True),
        ('not_exists', None, HIGH, False),
    ],
)
def test_operators(op, value, answer, expected):
    assert check(_c(op, value), answer) is expected


def test_values_are_converted_to_the_answer_type():
    assert check(_c('equals', '0.93'), SCORE) is True
    assert check(_c('equals', 'true'), FLAG) is True
    assert check(_c('equals', 'false'), FLAG) is False
    assert check(_c('equals', 'abc'), SCORE) is False  # unconvertible: equals is false
    assert check(_c('not_equals', 'abc'), SCORE) is True  # ... and not_equals is true
    assert check(_c('in', '1, 2'), {'answer': 2}) is True


def test_match_all_and_any():
    rule = parse_rule(
        {
            'match': 'all',
            'conditions': [
                {'question': 'a', 'op': 'equals', 'value': 'yes'},
                {'question': 'b', 'op': 'equals', 'value': 'yes'},
            ],
        }
    )
    answers = {'a': YES, 'b': {'answer': 'no'}}
    assert evaluate(rule, answers) is False
    assert evaluate(Rule('any', rule.conditions), answers) is True


def test_match_defaults_to_all_and_questions_are_unique_in_order():
    rule = parse_rule(
        {
            'conditions': [
                {'question': 'b', 'op': 'exists'},
                {'question': 'a', 'op': 'exists'},
                {'question': 'b', 'op': 'not_equals', 'value': 'x'},
            ]
        }
    )
    assert rule.match == 'all'
    assert rule.questions == ('b', 'a')


@pytest.mark.parametrize(
    'config, message',
    [
        ({}, 'at least one condition'),
        ({'conditions': []}, 'at least one condition'),
        ({'match': 'some', 'conditions': [{'question': 'a', 'op': 'exists'}]}, 'match must be'),
        ({'conditions': ['x']}, 'must be an object'),
        ({'conditions': [{'op': 'exists'}]}, 'question name is required'),
        ({'conditions': [{'question': 'a', 'op': 'like'}]}, 'unknown operator'),
        ({'conditions': [{'question': 'a', 'op': 'gt', 'value': 'high'}]}, 'not a number'),
        ({'conditions': [{'question': 'a', 'op': 'between', 'value': '1'}]}, 'two numbers'),
        ({'conditions': [{'question': 'a', 'op': 'between', 'value': '3, 1'}]}, 'greater than high'),
        ({'conditions': [{'question': 'a', 'op': 'in', 'value': ' , '}]}, 'non-empty list'),
        ({'conditions': [{'question': 'a', 'op': 'equals', 'value': '  '}]}, 'needs a value'),
        ({'conditions': [{'question': 'a', 'op': 'exists', 'value': 'yes'}]}, 'takes no value'),
    ],
)
def test_bad_configs(config, message):
    with pytest.raises(RuleConfigError, match=message):
        parse_rule(config)


def test_condition_is_hashable_and_immutable():
    assert _c('in', 'a, b') == Condition('q', 'in', ('a', 'b'))
