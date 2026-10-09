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
"""Question config parsing, the System One wire format, and mapping answers to the decisions contract."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from ai.common.decision import UNCERTAIN

from .limits import DecisionLimits

YES_NO = 'yes_no'
PICK_ONE = 'pick_one'
RUBRIC = 'rubric'
RESERVED_ANSWERS = frozenset({UNCERTAIN})

_WIRE_TYPE = {YES_NO: 'noul', PICK_ONE: 'choice', RUBRIC: 'score'}
_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{0,47}$')
_VALUE_RE = re.compile(r'^[A-Za-z0-9_\-]{1,64}$')


class QuestionConfigError(ValueError):
    """The node's question configuration is invalid."""


class ProtocolError(Exception):
    """The backend returned an answer that does not match the question asked."""


@dataclass(frozen=True)
class QuestionSpec:
    """One configured question."""

    name: str
    kind: str
    question: str
    options: tuple[tuple[str, str | None], ...] = ()
    levels: tuple[str, ...] = ()
    yes_means: str | None = None
    no_means: str | None = None
    threshold: float = 0.5
    min_confidence: float = 0.0


def _lines(text) -> list[str]:
    return [line.strip() for line in str(text or '').splitlines() if line.strip()]


def _parse_options(name: str, text, limits: DecisionLimits) -> tuple[tuple[str, str | None], ...]:
    options = []
    for line in _lines(text):
        value, _, description = line.partition('|')
        value, description = value.strip(), description.strip() or None
        if not _VALUE_RE.match(value):
            raise QuestionConfigError(f'{name}: option value "{value}" must match {_VALUE_RE.pattern}')
        if value in RESERVED_ANSWERS:
            raise QuestionConfigError(f'{name}: option value "{value}" is reserved')
        if any(value == existing for existing, _ in options):
            raise QuestionConfigError(f'{name}: duplicate option "{value}"')
        options.append((value, description))
    if len(options) < 2:
        raise QuestionConfigError(f'{name}: pick-one needs at least 2 options')
    if len(options) > limits.max_options:
        raise QuestionConfigError(f'{name}: this backend allows at most {limits.max_options} options')
    return tuple(options)


def _parse_levels(name: str, text, limits: DecisionLimits) -> tuple[str, ...]:
    levels = tuple(_lines(text))
    for level in levels:
        if level in RESERVED_ANSWERS:
            raise QuestionConfigError(f'{name}: level "{level}" is reserved')
    if len(set(levels)) != len(levels):
        raise QuestionConfigError(f'{name}: duplicate level in {list(levels)}')
    if len(levels) < 2:
        raise QuestionConfigError(f'{name}: rubric needs at least 2 levels')
    if len(levels) > limits.max_levels:
        raise QuestionConfigError(f'{name}: this backend allows at most {limits.max_levels} levels')
    return levels


def _number(name: str, item: dict, key: str, default: float, low: float, high: float, open_ends: bool) -> float:
    value = float(item.get(key, default) if item.get(key) not in (None, '') else default)
    ok = low < value < high if open_ends else low <= value <= high
    if not ok:
        raise QuestionConfigError(f'{name}: {key} {value} out of range')
    return value


def parse_questions(config: dict, limits: DecisionLimits) -> list[QuestionSpec]:
    """Validate the node's three question arrays and return them as specs (config order)."""
    specs: list[QuestionSpec] = []
    seen: set[str] = set()
    for kind in (YES_NO, PICK_ONE, RUBRIC):
        for item in config.get(kind) or []:
            name = str(item.get('name', '')).strip()
            if not _NAME_RE.match(name):
                raise QuestionConfigError(f'question name "{name}" must match {_NAME_RE.pattern}')
            if name in seen:
                raise QuestionConfigError(f'duplicate question name "{name}"')
            seen.add(name)
            question = str(item.get('question', '')).strip()
            if not question:
                raise QuestionConfigError(f'{name}: question text is required')
            specs.append(
                QuestionSpec(
                    name=name,
                    kind=kind,
                    question=question,
                    options=_parse_options(name, item.get('options'), limits) if kind == PICK_ONE else (),
                    levels=_parse_levels(name, item.get('levels'), limits) if kind == RUBRIC else (),
                    yes_means=(str(item.get('yes_means') or '').strip() or None) if kind == YES_NO else None,
                    no_means=(str(item.get('no_means') or '').strip() or None) if kind == YES_NO else None,
                    threshold=_number(name, item, 'threshold', 0.5, 0.0, 1.0, True) if kind == YES_NO else 0.5,
                    min_confidence=_number(name, item, 'min_confidence', 0.0, 0.0, 1.0, False),
                )
            )
    if not specs:
        raise QuestionConfigError('configure at least one question')
    if len(specs) > limits.max_questions:
        raise QuestionConfigError(f'this backend allows at most {limits.max_questions} questions per node')
    return specs


def build_wire_questions(specs: list[QuestionSpec], limits: DecisionLimits) -> dict:
    """Build the ``questions`` map of a ``/v1/systemone`` request."""
    wire = {}
    for spec in specs:
        entry: dict = {'type': _WIRE_TYPE[spec.kind], 'instructions': spec.question}
        if spec.kind == YES_NO:
            if spec.yes_means or spec.no_means:
                entry['criteria'] = {'true': spec.yes_means or 'Yes', 'false': spec.no_means or 'No'}
        elif spec.kind == PICK_ONE:
            entry['criteria'] = {
                value: (description if description is not None or limits.object_criteria else value)
                for value, description in spec.options
            }
        else:
            entry['criteria'] = list(spec.levels)
        wire[spec.name] = entry
    return wire


def describe_questions(specs: list[QuestionSpec]) -> dict:
    """Return the group's ``questions`` header for ``response['decisions']`` (spec §3.2)."""
    described = {}
    for spec in specs:
        entry: dict = {'kind': spec.kind, 'question': spec.question}
        if spec.kind == YES_NO:
            entry['threshold'] = spec.threshold
        elif spec.kind == PICK_ONE:
            entry['options'] = [value for value, _ in spec.options]
        else:
            entry['levels'] = list(spec.levels)
        if spec.min_confidence:
            entry['min_confidence'] = spec.min_confidence
        described[spec.name] = entry
    return described


def _spread_confidence(probabilities: dict, n: int) -> float:
    """Return the spec 6.2 spread confidence; ``n`` is the number of options or levels asked."""
    if n < 2 or not probabilities:
        return 1.0
    top = max(probabilities.values())
    return max(0.0, min(1.0, (top - 1 / n) / (1 - 1 / n)))


def _finish(spec: QuestionSpec, decision: dict) -> dict:
    if decision['confidence'] < spec.min_confidence:
        decision['best'] = decision['answer']
        decision['answer'] = UNCERTAIN
        decision.pop('index', None)
    return decision


def _check_sum(name: str, probabilities: dict, n: int) -> None:
    """Raise ProtocolError unless the probabilities sum to 1 within ``1e-6 + n * 0.005``."""
    total = sum(probabilities.values())
    if abs(total - 1.0) > 1e-6 + n * 0.005:
        raise ProtocolError(f'{name}: probabilities sum to {total:.4f}, not 1')


def _validate_probability(name: str, value: float, field: str) -> None:
    """Raise ProtocolError if value is not finite or outside [0, 1]."""
    if not math.isfinite(value) or not (0.0 <= value <= 1.0):
        raise ProtocolError(f'{name}: {field} {value} must be finite and in [0, 1]')


def _extract_wire_field(spec: QuestionSpec, wire: dict, field: str):
    """Extract a wire field, converting extraction errors to ProtocolError."""
    try:
        return wire[field]
    except (KeyError, TypeError, ValueError, AttributeError) as e:
        raise ProtocolError(f'{spec.name}: failed to read {field}: {e}') from e


def map_answer(spec: QuestionSpec, wire: dict) -> dict:
    """Map one wire answer to a decisions-contract answer (spec §3.2); raise ProtocolError on a bad reply."""
    if not isinstance(wire, dict) or wire.get('type') != _WIRE_TYPE[spec.kind]:
        raise ProtocolError(f'{spec.name}: expected a {_WIRE_TYPE[spec.kind]} answer, got {wire!r}')
    if spec.kind == YES_NO:
        try:
            p = float(_extract_wire_field(spec, wire, 'noul'))
        except (TypeError, ValueError) as e:
            raise ProtocolError(f'{spec.name}: noul must be a number, got {wire.get("noul")!r}') from e
        _validate_probability(spec.name, p, 'noul')
        t = spec.threshold
        answer = 'yes' if p >= t else 'no'
        confidence = (p - t) / (1 - t) if answer == 'yes' else (t - p) / t
        return _finish(spec, {'answer': answer, 'confidence': max(0.0, min(1.0, confidence)), 'probability': p})
    try:
        prob_raw = wire.get('probabilities') or {}
        probabilities = {str(k): float(v) for k, v in prob_raw.items()}
    except (TypeError, ValueError, AttributeError) as e:
        raise ProtocolError(f'{spec.name}: probabilities must be a dict with numeric values: {e}') from e
    for prob_val in probabilities.values():
        _validate_probability(spec.name, prob_val, 'probability value')
    n = len(spec.options) if spec.kind == PICK_ONE else len(spec.levels)
    if probabilities:
        _check_sum(spec.name, probabilities, n)
    conf_raw = wire.get('confidence')
    if conf_raw is not None:
        try:
            confidence = float(conf_raw)
        except (TypeError, ValueError) as e:
            raise ProtocolError(f'{spec.name}: confidence must be a number, got {conf_raw!r}') from e
        _validate_probability(spec.name, confidence, 'confidence')
    else:
        confidence = _spread_confidence(probabilities, n)
    if spec.kind == PICK_ONE:
        choice = wire.get('choice')
        try:
            if choice not in {value for value, _ in spec.options}:
                raise ProtocolError(f'{spec.name}: backend chose unknown option {choice!r}')
        except TypeError as e:
            raise ProtocolError(f'{spec.name}: choice must be a hashable value: {e}') from e
        if not probabilities and conf_raw is None:
            raise ProtocolError(f'{spec.name}: pick-one requires either probabilities or backend confidence')
        return _finish(spec, {'answer': choice, 'confidence': confidence, 'probabilities': probabilities})
    if not probabilities:
        raise ProtocolError(f'{spec.name}: rubric answer has no probabilities')
    labelled = {}
    for key, value in probabilities.items():
        try:
            position = int(key)
        except ValueError:
            raise ProtocolError(f'{spec.name}: rubric probability key {key!r} is not a level index') from None
        if not 0 <= position < n:
            raise ProtocolError(f'{spec.name}: rubric probability key {key!r} out of range [0, {n - 1}]')
        labelled[spec.levels[position]] = value
    index = spec.levels.index(max(labelled, key=labelled.get))
    try:
        score = float(_extract_wire_field(spec, wire, 'score'))
    except (TypeError, ValueError) as e:
        raise ProtocolError(f'{spec.name}: score must be a number, got {wire.get("score")!r}') from e
    if not math.isfinite(score) or not 0 <= score <= n - 1:
        raise ProtocolError(f'{spec.name}: score {score} out of range [0, {n - 1}]')
    return _finish(
        spec,
        {
            'answer': spec.levels[index],
            'index': index,
            'score': score,
            'confidence': confidence,
            'probabilities': labelled,
        },
    )
