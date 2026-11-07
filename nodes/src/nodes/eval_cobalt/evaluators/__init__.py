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

"""Shared constants and function exports for Cobalt evaluators."""

import math

# Negation words ('not', 'nor', 'neither') are deliberately absent: the
# relevance and grounding evaluators score by content-word overlap, so
# discarding them would make "X is not Y" and "X is Y" score identically.
STOP_WORDS: set[str] = {
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'and',
    'but',
    'or',
    'so',
    'yet',
    'both',
    'either',
    'it',
    'its',
    'that',
    'this',
    'these',
    'those',
    'their',
    'them',
    'they',
    'what',
    'which',
    'who',
    'whom',
    'whose',
}

_DEFAULT_THRESHOLD = 0.5


def clamp_threshold(threshold: float, default: float = _DEFAULT_THRESHOLD) -> float:
    """Coerce a caller-supplied threshold into the closed interval [0.0, 1.0].

    The ``evaluate_*`` functions are public entry points, so a caller can pass
    a threshold that makes the verdict meaningless (``-1`` passes everything,
    ``2`` fails everything). Infinities clamp to the nearest bound; values that
    are not numbers at all, including NaN, fall back to ``default`` because no
    comparison against them is meaningful.

    Args:
        threshold: The caller-supplied threshold.
        default: Value substituted for a non-numeric or NaN threshold.

    Returns:
        A float in [0.0, 1.0].
    """
    try:
        value = float(threshold)
    except (TypeError, ValueError):
        return default
    if math.isnan(value):
        return default
    return max(0.0, min(1.0, value))


from .relevance import evaluate_relevance  # noqa: E402
from .grounding import evaluate_grounding  # noqa: E402
from .format_check import evaluate_format  # noqa: E402

__all__ = [
    'STOP_WORDS',
    'clamp_threshold',
    'evaluate_relevance',
    'evaluate_grounding',
    'evaluate_format',
]
