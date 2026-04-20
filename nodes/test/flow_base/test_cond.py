# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_base.cond — the 8 condition helpers."""

from __future__ import annotations

import pytest

from nodes.flow_base import cond


class TestContains:
    def test_single_keyword_match(self):
        assert cond.contains('hello world', 'world') is True

    def test_single_keyword_no_match(self):
        assert cond.contains('hello world', 'foo') is False

    def test_case_insensitive_default(self):
        assert cond.contains('Hello World', 'hello') is True

    def test_case_sensitive_when_disabled(self):
        assert cond.contains('Hello World', 'hello', case_insensitive=False) is False

    def test_mode_any(self):
        assert cond.contains('hello world', ['foo', 'world'], mode='any') is True
        assert cond.contains('hello world', ['foo', 'bar'], mode='any') is False

    def test_mode_all(self):
        assert cond.contains('hello world', ['hello', 'world'], mode='all') is True
        assert cond.contains('hello world', ['hello', 'foo'], mode='all') is False

    def test_non_string_input(self):
        assert cond.contains(None, 'x') is False
        assert cond.contains(123, 'x') is False

    def test_empty_keywords(self):
        assert cond.contains('text', []) is False
        assert cond.contains('text', '') is False


class TestRegex:
    def test_match(self):
        assert cond.regex('order 42', r'\d+') is True

    def test_no_match(self):
        assert cond.regex('no numbers', r'\d+') is False

    def test_invalid_pattern_returns_false(self):
        assert cond.regex('text', '(unclosed') is False

    def test_non_string_input(self):
        assert cond.regex(None, r'\d+') is False


class TestLength:
    def test_within_bounds(self):
        assert cond.length('hello', min=1, max=10) is True

    def test_below_min(self):
        assert cond.length('', min=1) is False

    def test_above_max(self):
        assert cond.length('toolong', max=3) is False

    def test_no_bounds_always_true(self):
        assert cond.length('anything') is True

    def test_works_on_list(self):
        assert cond.length([1, 2, 3], min=2, max=5) is True

    def test_no_len_attribute(self):
        assert cond.length(42, min=1) is False


class TestScoreThreshold:
    @pytest.mark.parametrize(
        'score,op,threshold,expected',
        [
            (0.8, '>=', 0.7, True),
            (0.7, '>=', 0.7, True),
            (0.6, '>=', 0.7, False),
            (0.5, '<=', 0.7, True),
            (0.7, '<=', 0.7, True),
            (0.8, '<=', 0.7, False),
            (0.5, '==', 0.5, True),
            (0.5, '==', 0.6, False),
            (0.8, '>', 0.7, True),
            (0.7, '>', 0.7, False),
            (0.5, '<', 0.7, True),
            (0.7, '<', 0.7, False),
        ],
    )
    def test_comparisons(self, score, op, threshold, expected):
        assert cond.score_threshold(score, op, threshold) is expected

    def test_invalid_op(self):
        assert cond.score_threshold(0.5, '!!', 0.5) is False

    def test_non_numeric_returns_false(self):
        assert cond.score_threshold('abc', '>=', 0.5) is False

    def test_string_numeric_coerces(self):
        assert cond.score_threshold('0.8', '>=', 0.7) is True


class TestFieldEquals:
    def test_dict_match(self):
        assert cond.field_equals({'kind': 'error'}, 'kind', 'error') is True

    def test_dict_no_match(self):
        assert cond.field_equals({'kind': 'info'}, 'kind', 'error') is False

    def test_missing_field(self):
        assert cond.field_equals({}, 'kind', 'error') is False

    def test_object_attr_match(self):
        class Obj:
            kind = 'error'

        assert cond.field_equals(Obj(), 'kind', 'error') is True

    def test_non_mapping_no_attr(self):
        assert cond.field_equals(42, 'kind', 'error') is False


class TestSentiment:
    def test_positive(self):
        assert cond.sentiment('This is great and wonderful') == 'positive'

    def test_negative(self):
        assert cond.sentiment('This is awful and terrible') == 'negative'

    def test_neutral(self):
        assert cond.sentiment('The meeting is at noon') == 'neutral'

    def test_mixed_balanced_is_neutral(self):
        assert cond.sentiment('great but terrible') == 'neutral'

    def test_empty_is_neutral(self):
        assert cond.sentiment('') == 'neutral'

    def test_non_string_is_neutral(self):
        assert cond.sentiment(None) == 'neutral'


class TestConstants:
    def test_always_true(self):
        assert cond.always_true is True

    def test_always_false(self):
        assert cond.always_false is False
