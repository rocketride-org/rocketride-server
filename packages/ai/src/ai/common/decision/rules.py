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
"""Gate rules over decisions: parse a gate's config and evaluate it against resolved answers (spec §7.1)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .contract import UNCERTAIN

OPS = ('equals', 'not_equals', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists')
_NUMERIC = frozenset({'gt', 'gte', 'lt', 'lte'})
_LISTS = frozenset({'in', 'not_in'})
_NO_VALUE = frozenset({'exists', 'not_exists'})
_NO_MATCH = object()


class RuleConfigError(ValueError):
    """The gate's rule configuration is invalid."""


@dataclass(frozen=True)
class Condition:
    """One condition: ``<question> <op> <value>``."""

    question: str
    op: str
    value: Any = None


@dataclass(frozen=True)
class Rule:
    """A gate rule: all or any of its conditions must hold."""

    match: str
    conditions: tuple[Condition, ...]

    @property
    def questions(self) -> tuple[str, ...]:
        """Return the question names the rule reads, unique and in config order."""
        return tuple(dict.fromkeys(condition.question for condition in self.conditions))


def parse_rule(config: dict) -> Rule:
    """Validate a gate config (``match`` + ``conditions``) and return the rule; raise RuleConfigError."""
    match = str(config.get('match') or 'all').strip()
    if match not in ('all', 'any'):
        raise RuleConfigError(f'match must be "all" or "any", got "{match}"')
    raw = config.get('conditions') or []
    if not isinstance(raw, list) or not raw:
        raise RuleConfigError('add at least one condition')
    return Rule(match, tuple(_parse_condition(number, item) for number, item in enumerate(raw, 1)))


def check(condition: Condition, answer: dict) -> bool:
    """Return whether one resolved answer satisfies one condition."""
    value, op = answer['answer'], condition.op
    if op == 'equals':
        return _equals(value, condition.value)
    if op == 'not_equals':
        return not _equals(value, condition.value)
    if op == 'in':
        return any(_equals(value, item) for item in condition.value)
    if op == 'not_in':
        return not any(_equals(value, item) for item in condition.value)
    if op == 'exists':
        return value != UNCERTAIN
    if op == 'not_exists':
        return value == UNCERTAIN
    number = _ordinal(answer)
    if number is None:
        return False
    if op == 'gt':
        return number > condition.value
    if op == 'gte':
        return number >= condition.value
    if op == 'lt':
        return number < condition.value
    if op == 'lte':
        return number <= condition.value
    low, high = condition.value
    return low <= number <= high


def evaluate(rule: Rule, answers: dict) -> bool:
    """Evaluate ``rule``; ``answers`` maps every name in ``rule.questions`` to its resolved answer dict."""
    results = (check(condition, answers[condition.question]) for condition in rule.conditions)
    return all(results) if rule.match == 'all' else any(results)


def _parse_condition(number: int, item) -> Condition:
    where = f'condition {number}'
    if not isinstance(item, dict):
        raise RuleConfigError(f'{where} must be an object')
    question = str(item.get('question') or '').strip()
    if not question:
        raise RuleConfigError(f'{where}: question name is required')
    op = str(item.get('op') or '').strip()
    if op not in OPS:
        raise RuleConfigError(f'{where}: unknown operator "{op}" (use one of {", ".join(OPS)})')
    where = f'{where} ({question} {op})'
    value = item.get('value')
    if op in _NO_VALUE:
        if value not in (None, '', []):
            raise RuleConfigError(f'{where}: takes no value')
        return Condition(question, op)
    if op in _NUMERIC:
        return Condition(question, op, _number(value, where))
    if op == 'between':
        parts = _split(value)
        if len(parts) != 2:
            raise RuleConfigError(f'{where}: needs two numbers "low, high"')
        low, high = _number(parts[0], where), _number(parts[1], where)
        if low > high:
            raise RuleConfigError(f'{where}: low {low} is greater than high {high}')
        return Condition(question, op, (low, high))
    if op in _LISTS:
        values = tuple(_split(value))
        if not values:
            raise RuleConfigError(f'{where}: needs a non-empty list of values')
        return Condition(question, op, values)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise RuleConfigError(f'{where}: needs a value')
    return Condition(question, op, value.strip() if isinstance(value, str) else value)


def _split(value) -> list[str]:
    parts = value if isinstance(value, (list, tuple)) else str(value or '').replace('\n', ',').split(',')
    return [str(part).strip() for part in parts if str(part).strip()]


def _number(value, where: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RuleConfigError(f'{where}: "{value}" is not a number') from None
    if not math.isfinite(number):
        raise RuleConfigError(f'{where}: "{value}" is not a finite number')
    return number


def _coerce(value, like):
    """Convert a config value to the stored answer's type, or return ``_NO_MATCH``."""
    if isinstance(like, bool):
        if isinstance(value, bool):
            return value
        return {'true': True, 'false': False}.get(str(value).strip().lower(), _NO_MATCH)
    if isinstance(like, (int, float)):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
        try:
            return float(value)
        except (TypeError, ValueError):
            return _NO_MATCH
    return str(value)


def _equals(answer, value) -> bool:
    target = _coerce(value, answer)
    return target is not _NO_MATCH and target == answer


def _ordinal(answer: dict):
    if 'index' in answer:
        return answer['index']
    value = answer['answer']
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
