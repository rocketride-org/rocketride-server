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

"""Custom relevance evaluator for Cobalt experiments.

Evaluates response relevance using keyword overlap and length-ratio
heuristics. This evaluator is fully deterministic and does not require
any external API calls.
"""

import re

from . import STOP_WORDS


def _tokenize(text: str) -> set[str]:
    """Tokenize text into a set of lowercase alphanumeric words.

    Args:
        text: The input text to tokenize.

    Returns:
        A set of unique lowercase tokens.
    """
    return set(re.findall(r'[a-z0-9]+', text.lower()))


def _compute_keyword_overlap(output_tokens: set[str], expected_tokens: set[str]) -> float:
    """Compute the Jaccard-like keyword overlap score.

    Uses the ratio of shared tokens to the union of both token sets.
    Stop words are excluded to focus on content-bearing terms.

    Args:
        output_tokens: Tokens from the actual output.
        expected_tokens: Tokens from the expected reference.

    Returns:
        A float between 0.0 and 1.0 representing keyword overlap.
    """
    output_filtered = output_tokens - STOP_WORDS
    expected_filtered = expected_tokens - STOP_WORDS

    if not expected_filtered:
        return 1.0 if not output_filtered else 0.0

    intersection = output_filtered & expected_filtered
    union = output_filtered | expected_filtered

    if not union:
        return 1.0

    return len(intersection) / len(union)


def _compute_length_ratio(output: str, expected: str) -> float:
    """Compute a length-ratio score penalizing extreme brevity or verbosity.

    Ideal responses are similar in length to the expected reference.
    Responses shorter than 30% or longer than 300% of the expected
    length receive reduced scores.

    Args:
        output: The actual output text.
        expected: The expected reference text.

    Returns:
        A float between 0.0 and 1.0 representing length appropriateness.
    """
    if not expected:
        return 1.0 if not output else 0.5

    ratio = len(output) / len(expected)

    if 0.5 <= ratio <= 2.0:
        return 1.0
    if 0.3 <= ratio < 0.5:
        return 0.5 + 2.5 * (ratio - 0.3)
    if 2.0 < ratio <= 3.0:
        return 1.0 - 0.5 * (ratio - 2.0)
    if ratio < 0.3:
        return max(0.0, ratio / 0.3 * 0.5)
    return max(0.0, 0.5 - 0.1 * (ratio - 3.0))


def evaluate_relevance(output: str, expected: str, keyword_weight: float = 0.7, length_weight: float = 0.3, threshold: float = 0.5) -> dict:
    """Evaluate response relevance using keyword overlap and length heuristics.

    This evaluator is deterministic and works entirely offline. It combines
    two signals: keyword overlap (weighted at 70% by default) and length
    ratio (weighted at 30% by default).

    Args:
        output: The actual response text to evaluate.
        expected: The expected reference text.
        keyword_weight: Weight for the keyword overlap score (default 0.7).
        length_weight: Weight for the length ratio score (default 0.3).
        threshold: Minimum score to pass (default 0.5).

    Returns:
        A dict with keys: score (float 0-1), passed (bool), reasoning (str).
    """
    output = output.strip()
    expected = expected.strip()

    if not output and not expected:
        return {'score': 1.0, 'passed': True, 'reasoning': 'Both output and expected are empty.'}

    if not output:
        return {'score': 0.0, 'passed': False, 'reasoning': 'Output is empty but expected content was provided.'}

    output_tokens = _tokenize(output)
    expected_tokens = _tokenize(expected)

    keyword_score = _compute_keyword_overlap(output_tokens, expected_tokens)
    length_score = _compute_length_ratio(output, expected)

    if keyword_weight < 0 or length_weight < 0:
        raise ValueError('keyword_weight and length_weight must be >= 0')

    keyword_score = max(0.0, min(1.0, keyword_score))
    length_score = max(0.0, min(1.0, length_score))
    total_weight = keyword_weight + length_weight
    if total_weight <= 0:
        raise ValueError('keyword_weight + length_weight must be > 0')
    score = round((keyword_weight * keyword_score + length_weight * length_score) / total_weight, 4)

    passed = score >= threshold

    reasoning_parts = [
        f'Keyword overlap: {keyword_score:.2f} (weight {keyword_weight})',
        f'Length ratio: {length_score:.2f} (weight {length_weight})',
        f'Weighted score: {score:.2f}',
        f'Threshold: {threshold}',
        f'Result: {"PASS" if passed else "FAIL"}',
    ]

    return {
        'score': score,
        'passed': passed,
        'reasoning': '; '.join(reasoning_parts),
    }
