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

import re
from typing import Any, Dict, List, Optional


# Keyword lists for basic sentiment classification
_POSITIVE_WORDS = frozenset(
    {
        'good',
        'great',
        'excellent',
        'amazing',
        'wonderful',
        'fantastic',
        'awesome',
        'love',
        'happy',
        'pleased',
        'satisfied',
        'perfect',
        'best',
        'brilliant',
        'superb',
        'outstanding',
        'positive',
        'beautiful',
        'delightful',
        'thank',
        'thanks',
        'appreciate',
        'helpful',
        'nice',
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
        'poor',
        'disappointed',
        'angry',
        'frustrated',
        'unhappy',
        'negative',
        'broken',
        'fail',
        'failed',
        'failure',
        'wrong',
        'error',
        'useless',
        'annoying',
        'ugly',
        'disgusting',
        'painful',
        'sad',
    }
)


class BranchEngine:
    """Evaluates conditional rules and determines which output lane data should be routed to."""

    def __init__(self, config: Dict[str, Any]):
        """Parse condition rules from configuration.

        Args:
            config: Node configuration dictionary containing rules and default_lane.
        """
        self.rules: List[Dict[str, Any]] = config.get('rules', [])
        self.default_lane: str = config.get('default_lane', 'questions')

    # -------------------------------------------------------------------------
    # Condition evaluators
    # -------------------------------------------------------------------------

    @staticmethod
    def contains(text: str, keywords: str, mode: str = 'any') -> Dict[str, Any]:
        """Check whether *text* contains keywords from a comma-separated list.

        Args:
            text: The text to search in.
            keywords: Comma-separated keyword list.
            mode: 'any' (default) matches if at least one keyword is found,
                  'all' requires every keyword to be present.

        Returns:
            Evaluation result dict with matched/condition/details keys.
        """
        if not text or not keywords:
            return {'matched': False, 'condition': 'contains', 'details': 'empty text or keywords'}

        text_lower = text.lower()
        keyword_list = [k.strip().lower() for k in keywords.split(',') if k.strip()]

        if not keyword_list:
            return {'matched': False, 'condition': 'contains', 'details': 'no valid keywords'}

        found = [kw for kw in keyword_list if kw in text_lower]

        if mode == 'all':
            matched = len(found) == len(keyword_list)
        else:
            matched = len(found) > 0

        return {
            'matched': matched,
            'condition': 'contains',
            'details': f'mode={mode}, found={found}, keywords={keyword_list}',
        }

    @staticmethod
    def regex(text: str, pattern: str) -> Dict[str, Any]:
        """Match *text* against a regex *pattern*.

        Invalid patterns are handled gracefully and never raise.

        Args:
            text: The text to match.
            pattern: Regular expression pattern string.

        Returns:
            Evaluation result dict.
        """
        if not text or not pattern:
            return {'matched': False, 'condition': 'regex', 'details': 'empty text or pattern'}

        try:
            # Timeout protects against catastrophic backtracking (ReDoS) from
            # user-supplied patterns. Python 3.11+ supports the timeout kwarg.
            import sys
            kwargs = {'timeout': 2.0} if sys.version_info >= (3, 11) else {}
            match = re.search(pattern, text, **kwargs)
            matched = match is not None
            details = f'pattern={pattern}, match={match.group() if match else None}'
        except re.error as exc:
            matched = False
            details = f'invalid regex: {exc}'
        except TimeoutError:
            matched = False
            details = f'regex timed out (pattern too complex): {pattern[:50]}'

        return {'matched': matched, 'condition': 'regex', 'details': details}

    @staticmethod
    def length(text: str, min_len: Optional[int] = None, max_len: Optional[int] = None) -> Dict[str, Any]:
        """Check whether the length of *text* falls within [min_len, max_len].

        Args:
            text: The text to measure.
            min_len: Minimum acceptable length (inclusive). ``None`` means no lower bound.
            max_len: Maximum acceptable length (inclusive). ``None`` means no upper bound.

        Returns:
            Evaluation result dict.
        """
        text_len = len(text) if text else 0

        above_min = min_len is None or text_len >= min_len
        below_max = max_len is None or text_len <= max_len
        matched = above_min and below_max

        return {
            'matched': matched,
            'condition': 'length',
            'details': f'len={text_len}, min={min_len}, max={max_len}',
        }

    @staticmethod
    def score_threshold(score: float, threshold: float, operator: str = '>=') -> Dict[str, Any]:
        """Compare a numeric *score* against a *threshold* using *operator*.

        Supported operators: ``>=``, ``<=``, ``==``, ``>``, ``<``.

        Args:
            score: The numeric value to test.
            threshold: The threshold value.
            operator: Comparison operator string.

        Returns:
            Evaluation result dict.
        """
        ops = {
            '>=': lambda s, t: s >= t,
            '<=': lambda s, t: s <= t,
            '==': lambda s, t: s == t,
            '>': lambda s, t: s > t,
            '<': lambda s, t: s < t,
        }

        cmp = ops.get(operator)
        if cmp is None:
            return {'matched': False, 'condition': 'score_threshold', 'details': f'unknown operator: {operator}'}

        try:
            matched = cmp(float(score), float(threshold))
        except (TypeError, ValueError) as exc:
            return {'matched': False, 'condition': 'score_threshold', 'details': f'conversion error: {exc}'}

        return {
            'matched': matched,
            'condition': 'score_threshold',
            'details': f'score={score} {operator} threshold={threshold}',
        }

    @staticmethod
    def field_equals(metadata: Dict[str, Any], field: str, value: Any) -> Dict[str, Any]:
        """Check whether *metadata[field]* equals *value*.

        Missing fields are handled gracefully (no ``KeyError``).

        Args:
            metadata: Dictionary of metadata fields.
            field: The field name to look up.
            value: The expected value.

        Returns:
            Evaluation result dict.
        """
        if not isinstance(metadata, dict):
            return {'matched': False, 'condition': 'field_equals', 'details': 'metadata is not a dict'}

        actual = metadata.get(field)
        matched = actual is not None and str(actual) == str(value)

        return {
            'matched': matched,
            'condition': 'field_equals',
            'details': f'field={field}, expected={value}, actual={actual}',
        }

    @staticmethod
    def sentiment(text: str) -> Dict[str, Any]:
        """Classify text sentiment using keyword-based analysis.

        Returns one of ``positive``, ``negative``, or ``neutral`` in the
        details field. Matching is always ``True`` -- the caller decides
        which sentiment values to route on.

        Args:
            text: The text to classify.

        Returns:
            Evaluation result dict with sentiment label in details.
        """
        if not text:
            return {'matched': True, 'condition': 'sentiment', 'details': 'neutral'}

        words = set(re.findall(r'[a-z]+', text.lower()))

        pos_count = len(words & _POSITIVE_WORDS)
        neg_count = len(words & _NEGATIVE_WORDS)

        if pos_count > neg_count:
            label = 'positive'
        elif neg_count > pos_count:
            label = 'negative'
        else:
            label = 'neutral'

        return {'matched': True, 'condition': 'sentiment', 'details': label}

    @staticmethod
    def always_true() -> Dict[str, Any]:
        """Constant condition that always matches."""
        return {'matched': True, 'condition': 'always_true', 'details': 'constant'}

    @staticmethod
    def always_false() -> Dict[str, Any]:
        """Constant condition that never matches."""
        return {'matched': False, 'condition': 'always_false', 'details': 'constant'}

    # -------------------------------------------------------------------------
    # Core evaluation / routing
    # -------------------------------------------------------------------------

    def evaluate(self, data: Dict[str, Any], condition_config: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate a single condition against *data*.

        Args:
            data: Dictionary with at least ``text`` and optionally ``metadata``
                  and ``score`` keys.
            condition_config: Dictionary describing the condition. Must include
                a ``type`` key (one of the condition method names).

        Returns:
            Evaluation result dict.
        """
        ctype = condition_config.get('type', '')
        text = data.get('text', '')
        metadata = data.get('metadata', {})
        score = data.get('score', 0.0)

        if ctype == 'contains':
            return self.contains(
                text,
                condition_config.get('keywords', ''),
                condition_config.get('mode', 'any'),
            )
        elif ctype == 'regex':
            return self.regex(text, condition_config.get('pattern', ''))
        elif ctype == 'length':
            return self.length(
                text,
                condition_config.get('min'),
                condition_config.get('max'),
            )
        elif ctype == 'score_threshold':
            return self.score_threshold(
                score,
                condition_config.get('threshold', 0.0),
                condition_config.get('operator', '>='),
            )
        elif ctype == 'field_equals':
            return self.field_equals(
                metadata,
                condition_config.get('field', ''),
                condition_config.get('value', ''),
            )
        elif ctype == 'sentiment':
            result = self.sentiment(text)
            expected = condition_config.get('expected', '')
            if expected:
                result['matched'] = result['details'] == expected
            return result
        elif ctype == 'always_true':
            return self.always_true()
        elif ctype == 'always_false':
            return self.always_false()

        return {'matched': False, 'condition': ctype, 'details': f'unknown condition type: {ctype}'}

    def route(self, data: Dict[str, Any], rules: Optional[List[Dict[str, Any]]] = None) -> str:
        """Determine the output lane by evaluating rules in order.

        First matching rule wins.  If no rule matches the configured
        ``default_lane`` is returned.

        Args:
            data: Data dictionary passed to :meth:`evaluate`.
            rules: Optional list of rule dicts.  Each rule must have a
                ``condition`` key (passed to :meth:`evaluate`) and a ``lane``
                key indicating the target output lane.  Falls back to
                ``self.rules`` when *None*.

        Returns:
            The lane name to route to.
        """
        if rules is None:
            rules = self.rules

        for rule in rules:
            condition = rule.get('condition', {})
            result = self.evaluate(data, condition)
            if result.get('matched'):
                return rule.get('lane', self.default_lane)

        return self.default_lane
