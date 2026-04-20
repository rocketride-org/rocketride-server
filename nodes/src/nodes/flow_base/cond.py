# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Condition helpers exposed to user expressions inside the sandbox.

These are the 8 condition predicates absorbed from PR #528
(`feature/conditional-branch-node` by @nihalnihalani), reorganized as a
namespace so user expressions read naturally:

    cond.contains(text, ['error', 'failure'], mode='any')
    cond.regex(text, r'\\d+')
    cond.score_threshold(score, '>=', 0.8)

All helpers are fail-closed: invalid input returns `False` rather than
raising. This keeps user expressions robust against malformed payloads
without forcing defensive try/except in every condition.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional, Union

# ──────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────

always_true: bool = True
always_false: bool = False

# Keyword lists for basic sentiment classification. Absorbed from PR #528.
# Intentionally small — users who need real sentiment analysis should
# chain an LLM classifier upstream and pass the result through
# `score_threshold` or `field_equals` instead.
_POSITIVE_WORDS = frozenset(
    {
        'good',
        'great',
        'excellent',
        'amazing',
        'wonderful',
        'fantastic',
        'love',
        'best',
        'happy',
        'pleased',
        'satisfied',
        'perfect',
    }
)
_NEGATIVE_WORDS = frozenset(
    {
        'bad',
        'terrible',
        'awful',
        'horrible',
        'hate',
        'worst',
        'disappointed',
        'frustrated',
        'angry',
        'poor',
        'useless',
        'broken',
    }
)


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def contains(
    text: Any,
    keywords: Union[str, Iterable[str]],
    *,
    mode: str = 'any',
    case_insensitive: bool = True,
) -> bool:
    """Return True if `text` contains the keyword(s).

    `mode='any'` returns True if any keyword matches.
    `mode='all'` returns True only if every keyword matches.
    """
    if not isinstance(text, str):
        return False

    if isinstance(keywords, str):
        keywords = [keywords]
    keywords = [k for k in keywords if isinstance(k, str) and k]
    if not keywords:
        return False

    haystack = text.lower() if case_insensitive else text
    needles = [k.lower() for k in keywords] if case_insensitive else keywords

    if mode == 'all':
        return all(n in haystack for n in needles)
    return any(n in haystack for n in needles)


def regex(text: Any, pattern: str, *, flags: int = 0) -> bool:
    """Return True if `pattern` matches anywhere in `text`. Invalid pattern → False."""
    if not isinstance(text, str) or not isinstance(pattern, str):
        return False
    try:
        return re.search(pattern, text, flags) is not None
    except re.error:
        return False


def length(
    text: Any,
    *,
    min: Optional[int] = None,
    max: Optional[int] = None,
) -> bool:
    """Return True if `len(text)` is within `[min, max]` (inclusive, either bound optional)."""
    if not hasattr(text, '__len__'):
        return False
    n = len(text)
    if min is not None and n < min:
        return False
    if max is not None and n > max:
        return False
    return True


def score_threshold(score: Any, op: str, threshold: float) -> bool:
    """Compare a numeric score against a threshold.

    `op` ∈ `{'>=', '<=', '==', '>', '<'}`. Unknown op or non-numeric score → False.
    """
    try:
        s = float(score)
        t = float(threshold)
    except (TypeError, ValueError):
        return False

    ops = {
        '>=': lambda a, b: a >= b,
        '<=': lambda a, b: a <= b,
        '==': lambda a, b: a == b,
        '>': lambda a, b: a > b,
        '<': lambda a, b: a < b,
    }
    fn = ops.get(op)
    if fn is None:
        return False
    return fn(s, t)


def field_equals(obj: Any, field: str, expected: Any) -> bool:
    """Return True if `obj[field] == expected`. Missing field / non-mapping → False."""
    if isinstance(obj, Mapping):
        if field not in obj:
            return False
        return obj[field] == expected
    if hasattr(obj, field):
        return getattr(obj, field) == expected
    return False


def sentiment(text: Any) -> str:
    """Classify text as `'positive'`, `'negative'`, or `'neutral'`.

    Keyword-based heuristic — NOT a real sentiment model. Use as a
    routing hint, not as ground truth.
    """
    if not isinstance(text, str) or not text.strip():
        return 'neutral'
    words = set(re.findall(r'\w+', text.lower()))
    pos_hits = len(words & _POSITIVE_WORDS)
    neg_hits = len(words & _NEGATIVE_WORDS)
    if pos_hits > neg_hits:
        return 'positive'
    if neg_hits > pos_hits:
        return 'negative'
    return 'neutral'


__all__ = [
    'always_true',
    'always_false',
    'contains',
    'regex',
    'length',
    'score_threshold',
    'field_equals',
    'sentiment',
]
