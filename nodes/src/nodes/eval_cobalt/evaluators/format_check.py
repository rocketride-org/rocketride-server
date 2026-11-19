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

"""Custom format evaluator for Cobalt experiments.

Evaluates whether LLM output matches an expected structural format
(prose, list, code, json). This evaluator is fully deterministic
and does not require any external API calls.
"""

import json
import re

from . import clamp_threshold

# What both format checkers count as a list line. One definition: ``prose``
# penalises these and ``list`` rewards them, so the two must never disagree
# about which lines they are.
_LIST_LINE_RE = re.compile(r'^\s*[-*•]\s|^\s*\d+[.)]\s')

# The fraction of list lines at which an output counts as list-shaped. One
# boundary for both checkers: at or above this ratio ``list`` rewards the
# output and ``prose`` applies its list penalty, so the two profiles agree on
# which outputs are list-shaped. The prose penalty is a deduction, not a
# failure on its own.
_LIST_SHAPED_RATIO = 0.5


def _list_line_ratio(non_empty_lines: list[str]) -> tuple[int, float]:
    """Return the count and the fraction of lines that look like list items.

    Args:
        non_empty_lines: The output's lines with blank ones already removed;
            must be non-empty (both callers return early when it is not).

    Returns:
        A ``(list_lines, ratio)`` pair; ``ratio`` is ``list_lines`` over the
        number of lines given.
    """
    list_lines = sum(1 for line in non_empty_lines if _LIST_LINE_RE.match(line))
    return list_lines, list_lines / len(non_empty_lines)


def _check_prose_format(output: str) -> dict:
    """Check if output follows prose format (continuous sentences).

    Args:
        output: The text to check.

    Returns:
        A dict with score and reasoning.
    """
    lines = output.strip().split('\n')
    non_empty_lines = [line for line in lines if line.strip()]

    if not non_empty_lines:
        return {'score': 0.0, 'reasoning': 'Output is empty.'}

    has_punctuation = bool(re.search(r'[.!?]', output))

    list_lines, list_ratio = _list_line_ratio(non_empty_lines)

    has_code_blocks = '```' in output

    score = 1.0
    reasons = []

    if not has_punctuation:
        score -= 0.3
        reasons.append('Missing sentence-ending punctuation')

    if list_ratio >= _LIST_SHAPED_RATIO:
        score -= 0.3
        reasons.append(f'{list_lines}/{len(non_empty_lines)} lines appear to be list items')

    if has_code_blocks:
        score -= 0.2
        reasons.append('Contains code blocks')

    score = max(0.0, score)
    reasoning = '; '.join(reasons) if reasons else 'Output follows prose format'

    return {'score': round(score, 4), 'reasoning': reasoning}


def _check_list_format(output: str) -> dict:
    """Check if output follows list format (bullet points or numbered items).

    Args:
        output: The text to check.

    Returns:
        A dict with score and reasoning.
    """
    lines = output.strip().split('\n')
    non_empty_lines = [line for line in lines if line.strip()]

    if not non_empty_lines:
        return {'score': 0.0, 'reasoning': 'Output is empty.'}

    list_lines, list_ratio = _list_line_ratio(non_empty_lines)

    if list_ratio >= _LIST_SHAPED_RATIO:
        score = min(1.0, list_ratio + 0.2)
        reasoning = f'{list_lines}/{len(non_empty_lines)} lines are list items'
    else:
        score = list_ratio
        reasoning = f'Only {list_lines}/{len(non_empty_lines)} lines are list items; expected list format'

    return {'score': round(score, 4), 'reasoning': reasoning}


def _check_code_format(output: str) -> dict:
    """Check if output contains code formatting.

    Args:
        output: The text to check.

    Returns:
        A dict with score and reasoning.
    """
    has_code_blocks = '```' in output
    lines = output.strip().split('\n')
    non_empty_lines = [line for line in lines if line.strip()]

    if not non_empty_lines:
        return {'score': 0.0, 'reasoning': 'Output is empty.'}

    if has_code_blocks:
        return {'score': 1.0, 'reasoning': 'Output contains code blocks.'}

    indented_lines = sum(1 for line in non_empty_lines if line.startswith(('    ', '\t')))
    indent_ratio = indented_lines / len(non_empty_lines)

    code_patterns = [r'[{}\[\]();]', r'def\s+\w+', r'class\s+\w+', r'import\s+', r'return\s+', r'=\s*\w+']
    code_matches = sum(1 for p in code_patterns if re.search(p, output))
    code_signal = code_matches / len(code_patterns)

    score = max(indent_ratio, code_signal)
    reasoning = f'Indentation ratio: {indent_ratio:.2f}; Code syntax signals: {code_signal:.2f}'

    return {'score': round(score, 4), 'reasoning': reasoning}


def _check_json_format(output: str) -> dict:
    """Check if output is valid JSON.

    Args:
        output: The text to check.

    Returns:
        A dict with score and reasoning.
    """
    stripped = output.strip()

    # No ``\s*`` around the group: with an unclosed fence they and the lazy
    # group could all match the same whitespace, and the search time grew with
    # the cube of its length. ``.strip()`` below removes that whitespace anyway.
    code_block_match = re.search(r'```(?:json)?(.*?)```', stripped, re.DOTALL)
    if code_block_match:
        stripped = code_block_match.group(1).strip()

    try:
        json.loads(stripped)
        return {'score': 1.0, 'reasoning': 'Output is valid JSON.'}
    except (json.JSONDecodeError, ValueError) as e:
        return {'score': 0.0, 'reasoning': f'Output is not valid JSON: {e}'}


_FORMAT_CHECKERS = {
    'prose': _check_prose_format,
    'list': _check_list_format,
    'code': _check_code_format,
    'json': _check_json_format,
}


def evaluate_format(output: str, expected_format: str = 'prose', threshold: float = 0.5) -> dict:
    """Evaluate output formatting against an expected structural format.

    Supports four format types: prose, list, code, and json.

    Args:
        output: The LLM-generated output to evaluate.
        expected_format: The expected format type. One of: prose, list, code, json.
        threshold: Minimum score to pass (default 0.5). Clamped to [0.0, 1.0].

    Returns:
        A dict with keys: score (float 0-1), passed (bool), reasoning (str).

    Raises:
        ValueError: If expected_format is not one of the supported types.
    """
    threshold = clamp_threshold(threshold)

    if expected_format not in _FORMAT_CHECKERS:
        raise ValueError(f'Unsupported format type: {expected_format!r}. Supported: {list(_FORMAT_CHECKERS.keys())}')

    if not output:
        return {
            'score': 0.0,
            'passed': False,
            'reasoning': f'Output is empty; expected {expected_format} format.',
        }

    result = _FORMAT_CHECKERS[expected_format](output)
    passed = result['score'] >= threshold

    return {
        'score': result['score'],
        'passed': passed,
        'reasoning': f'Format: {expected_format}; {result["reasoning"]}; Threshold: {threshold}; Result: {"PASS" if passed else "FAIL"}',
    }
