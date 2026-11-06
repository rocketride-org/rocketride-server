# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Unit tests for rocketride.evals.assertions.

Covers every assertion type of the eval spec (contains/not_contains, regex,
equals, min/max_length, json_path, latency_max_ms, llm_judge) including
Unicode case folding, strip semantics, dot-paths into lists, missing paths,
judge failures, and the never-raise-on-data-failures contract.
"""

import json

import pytest

from rocketride.evals.assertions import AssertionResult, evaluate_assertion
from rocketride.evals.judge import JudgeParseError, JudgeVerdict
from rocketride.evals.spec import AssertionSpec


def make_spec(assertion_type: str, **params) -> AssertionSpec:
    """Build an AssertionSpec for a single assertion under test."""
    return AssertionSpec(type=assertion_type, params=params)


def evaluate(
    assertion_type: str,
    output_text: str = '',
    *,
    duration_ms: float = 0.0,
    case_input: str = 'question',
    judge=None,
    **params,
) -> AssertionResult:
    """Evaluate one assertion with defaults suitable for most tests."""
    return evaluate_assertion(
        make_spec(assertion_type, **params),
        output_text=output_text,
        duration_ms=duration_ms,
        case_input=case_input,
        judge=judge,
    )


# =========================================================================
# contains / not_contains
# =========================================================================


def test_contains_passes_on_substring():
    result = evaluate('contains', 'The quick brown fox', value='quick')
    assert result.passed
    assert 'quick' in result.detail


def test_contains_fails_on_missing_substring():
    result = evaluate('contains', 'The quick brown fox', value='slow')
    assert not result.passed
    assert 'slow' in result.detail


def test_contains_is_case_sensitive_by_default():
    assert not evaluate('contains', 'Hello World', value='hello world').passed


def test_contains_ignore_case():
    assert evaluate('contains', 'Hello World', value='hello world', ignore_case=True).passed


def test_contains_ignore_case_unicode_casefold():
    # casefold maps the German eszett to 'ss'; lower() alone would miss this
    assert evaluate('contains', 'Die STRASSE ist lang', value='straße', ignore_case=True).passed


def test_not_contains_passes_when_absent():
    assert evaluate('not_contains', 'all good here', value='error').passed


def test_not_contains_fails_when_present():
    result = evaluate('not_contains', 'an error occurred', value='error')
    assert not result.passed


def test_not_contains_ignore_case_fails_when_present():
    assert not evaluate('not_contains', 'An ERROR occurred', value='error', ignore_case=True).passed


# =========================================================================
# regex
# =========================================================================


def test_regex_search_matches_anywhere():
    result = evaluate('regex', 'order id: ABC-1234 confirmed', pattern=r'[A-Z]{3}-\d{4}')
    assert result.passed
    assert 'ABC-1234' in result.detail


def test_regex_no_match_fails():
    assert not evaluate('regex', 'no numbers here', pattern=r'\d+').passed


def test_regex_invalid_pattern_fails_without_raising():
    result = evaluate('regex', 'anything', pattern='([unclosed')
    assert not result.passed
    assert 'invalid regex' in result.detail


# =========================================================================
# equals
# =========================================================================


def test_equals_exact_match():
    assert evaluate('equals', 'hello', value='hello').passed


def test_equals_strips_whitespace_by_default():
    assert evaluate('equals', '  hello \n', value='hello').passed


def test_equals_strip_disabled_fails_on_whitespace():
    assert not evaluate('equals', ' hello\n', value='hello', strip=False).passed


def test_equals_ignore_case():
    assert evaluate('equals', 'HELLO', value='hello', ignore_case=True).passed


def test_equals_mismatch_reports_both_sides():
    result = evaluate('equals', 'actual text', value='expected text')
    assert not result.passed
    assert 'expected text' in result.detail
    assert 'actual text' in result.detail


def test_equals_unicode_casefold():
    assert evaluate('equals', 'STRASSE', value='straße', ignore_case=True).passed


# =========================================================================
# min_length / max_length
# =========================================================================


def test_min_length_inclusive_boundary():
    assert evaluate('min_length', 'abcde', value=5).passed
    assert not evaluate('min_length', 'abcd', value=5).passed


def test_max_length_inclusive_boundary():
    assert evaluate('max_length', 'abcde', value=5).passed
    assert not evaluate('max_length', 'abcdef', value=5).passed


def test_min_length_empty_output():
    assert not evaluate('min_length', '', value=1).passed
    assert evaluate('min_length', '', value=0).passed


# =========================================================================
# json_path
# =========================================================================

JSON_DOC = json.dumps(
    {
        'answer': {'text': 'Paris', 'confidence': 0.92},
        'citations': [{'title': 'Wiki'}, {'title': 'Atlas'}],
        'count': 2,
    }
)


def test_json_path_existence_check():
    assert evaluate('json_path', JSON_DOC, path='answer.text').passed


def test_json_path_missing_key_fails():
    result = evaluate('json_path', JSON_DOC, path='answer.missing')
    assert not result.passed
    assert 'not found' in result.detail


def test_json_path_equals():
    assert evaluate('json_path', JSON_DOC, path='answer.text', equals='Paris').passed
    assert not evaluate('json_path', JSON_DOC, path='answer.text', equals='London').passed


def test_json_path_equals_does_not_conflate_bool_and_number():
    """True == 1 in Python; the assertion must still reject the mismatch."""
    document = json.dumps({'flag': True, 'count': 1, 'off': False, 'zero': 0})

    assert not evaluate('json_path', document, path='flag', equals=1).passed
    assert not evaluate('json_path', document, path='count', equals=True).passed
    assert not evaluate('json_path', document, path='off', equals=0).passed
    assert not evaluate('json_path', document, path='zero', equals=False).passed
    # Same-type comparisons still pass
    assert evaluate('json_path', document, path='flag', equals=True).passed
    assert evaluate('json_path', document, path='count', equals=1).passed
    assert evaluate('json_path', document, path='off', equals=False).passed


def test_json_path_list_index():
    assert evaluate('json_path', JSON_DOC, path='citations.1.title', equals='Atlas').passed


def test_json_path_list_index_out_of_range_fails():
    result = evaluate('json_path', JSON_DOC, path='citations.5.title')
    assert not result.passed
    assert 'out of range' in result.detail


def test_json_path_non_integer_list_index_fails():
    result = evaluate('json_path', JSON_DOC, path='citations.first.title')
    assert not result.passed
    assert 'list index expected' in result.detail


def test_json_path_descend_into_scalar_fails():
    result = evaluate('json_path', JSON_DOC, path='count.deeper')
    assert not result.passed
    assert 'cannot descend' in result.detail


def test_json_path_gte_lte():
    assert evaluate('json_path', JSON_DOC, path='answer.confidence', gte=0.9).passed
    assert not evaluate('json_path', JSON_DOC, path='answer.confidence', gte=0.95).passed
    assert evaluate('json_path', JSON_DOC, path='count', lte=2).passed
    assert not evaluate('json_path', JSON_DOC, path='count', lte=1).passed


def test_json_path_gte_and_lte_combined():
    assert evaluate('json_path', JSON_DOC, path='count', gte=1, lte=3).passed


def test_json_path_gte_on_non_number_fails():
    result = evaluate('json_path', JSON_DOC, path='answer.text', gte=1)
    assert not result.passed
    assert 'not a number' in result.detail


def test_json_path_gte_on_boolean_fails():
    result = evaluate('json_path', json.dumps({'flag': True}), path='flag', gte=1)
    assert not result.passed
    assert 'not a number' in result.detail


def test_json_path_non_json_output_fails_without_raising():
    result = evaluate('json_path', 'plain text, not JSON', path='a.b')
    assert not result.passed
    assert 'not valid JSON' in result.detail


def test_json_path_root_list():
    assert evaluate('json_path', json.dumps(['zero', 'one']), path='1', equals='one').passed


# =========================================================================
# latency_max_ms
# =========================================================================


def test_latency_under_bound_passes():
    assert evaluate('latency_max_ms', duration_ms=120.0, value=500).passed


def test_latency_at_bound_passes():
    assert evaluate('latency_max_ms', duration_ms=500.0, value=500).passed


def test_latency_over_bound_fails():
    result = evaluate('latency_max_ms', duration_ms=750.0, value=500)
    assert not result.passed
    assert '750.0ms' in result.detail


# =========================================================================
# llm_judge
# =========================================================================


def make_judge_stub(verdict=None, error=None):
    """Build a judge callable returning a fixed verdict or raising an error."""
    calls = []

    def judge(**kwargs):
        calls.append(kwargs)
        if error is not None:
            raise error
        return verdict

    judge.calls = calls
    return judge


def test_llm_judge_pass_above_min_score():
    judge = make_judge_stub(JudgeVerdict(score=0.9, reasoning='meets criteria', raw='{}'))
    result = evaluate('llm_judge', 'output', judge=judge, criteria='is polite')
    assert result.passed
    assert 'meets criteria' in result.detail
    assert judge.calls == [{'criteria': 'is polite', 'case_input': 'question', 'output_text': 'output'}]


def test_llm_judge_default_min_score_boundary():
    # default min_score is 0.7 and the comparison is inclusive
    judge = make_judge_stub(JudgeVerdict(score=0.7, reasoning='', raw='{}'))
    assert evaluate('llm_judge', 'output', judge=judge, criteria='c').passed


def test_llm_judge_fails_below_min_score():
    judge = make_judge_stub(JudgeVerdict(score=0.4, reasoning='misses the point', raw='{}'))
    result = evaluate('llm_judge', 'output', judge=judge, criteria='c', min_score=0.8)
    assert not result.passed
    assert '0.40' in result.detail


def test_llm_judge_parse_error_fails_with_raw_detail():
    judge = make_judge_stub(error=JudgeParseError('no JSON object found', raw='total garbage reply'))
    result = evaluate('llm_judge', 'output', judge=judge, criteria='c')
    assert not result.passed
    assert 'total garbage reply' in result.detail


def test_llm_judge_run_failure_fails_without_raising():
    judge = make_judge_stub(error=RuntimeError('judge pipeline exploded'))
    result = evaluate('llm_judge', 'output', judge=judge, criteria='c')
    assert not result.passed
    assert 'judge pipeline exploded' in result.detail


def test_llm_judge_without_judge_fails():
    result = evaluate('llm_judge', 'output', judge=None, criteria='c')
    assert not result.passed
    assert 'none is available' in result.detail


# =========================================================================
# programmer errors
# =========================================================================


def test_unknown_assertion_type_raises():
    with pytest.raises(ValueError, match='Unknown assertion type'):
        evaluate('almost_equals', 'output', value='x')


def test_result_carries_the_spec():
    spec = make_spec('contains', value='x')
    result = evaluate_assertion(spec, output_text='x', duration_ms=0.0, case_input='', judge=None)
    assert result.spec is spec
