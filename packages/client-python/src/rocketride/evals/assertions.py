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
Assertion Evaluation for the RocketRide Eval Runner.

This module evaluates a single assertion from a golden-dataset eval spec
against a pipeline's output. It backs the ``expect`` blocks of
``<name>.eval.json`` files run by ``rocketride eval``.

Supported assertion types:
    - ``contains`` / ``not_contains``: substring check, optional ignore_case
    - ``regex``: ``re.search`` match against the output
    - ``equals``: exact comparison, optional ignore_case, strip (default on)
    - ``min_length`` / ``max_length``: output length bounds (inclusive)
    - ``json_path``: parse the output as JSON and check a dot-path value
      (``a.b.0.c``, integer segments index into lists) for existence,
      ``equals``, ``gte``, and/or ``lte``
    - ``latency_max_ms``: bound on the measured chat round-trip duration
    - ``llm_judge``: delegate grading to an LLM judge pipeline (see
      :mod:`rocketride.evals.judge`) and compare its score to ``min_score``

Error philosophy: data-shaped failures (non-JSON output, missing JSON path,
invalid user-supplied regex, unparseable judge verdicts, judge run failures)
NEVER raise — they return ``passed=False`` with an explanatory detail so one
bad case cannot abort an eval run. Only programmer errors (an assertion type
that spec validation should have rejected) raise.

Usage:
    result = evaluate_assertion(
        spec, output_text=answer, duration_ms=1234.5, case_input=question, judge=judge
    )

Components:
    AssertionResult: Outcome of evaluating one assertion
    evaluate_assertion: Evaluate one AssertionSpec against a pipeline output
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .judge import JudgeFn, JudgeParseError

if TYPE_CHECKING:
    from .spec import AssertionSpec

# Maximum characters of pipeline output echoed into assertion details
_DETAIL_PREVIEW_LIMIT = 200

# Default minimum judge score for llm_judge assertions
_DEFAULT_MIN_SCORE = 0.7


@dataclass
class AssertionResult:
    """
    Outcome of evaluating a single assertion against a pipeline output.

    Attributes:
        spec: The assertion that was evaluated
        passed: True if the assertion held
        detail: Human-readable explanation of the outcome (pass or fail)
    """

    spec: 'AssertionSpec'
    passed: bool
    detail: str


def evaluate_assertion(
    spec: 'AssertionSpec',
    *,
    output_text: str,
    duration_ms: float,
    case_input: str,
    judge: JudgeFn | None,
) -> AssertionResult:
    """
    Evaluate one assertion against a pipeline output.

    Never raises for data-shaped failures (unexpected output, bad JSON,
    missing paths, judge errors) — those return ``passed=False`` with an
    explanatory detail. Raises only for programmer errors, i.e. an assertion
    type that spec validation should have rejected.

    Args:
        spec: The assertion to evaluate (type + params)
        output_text: The pipeline output for the case ('' if none)
        duration_ms: Measured duration of the chat call in milliseconds
        case_input: The input that was sent to the pipeline (given to the
            judge for context in ``llm_judge`` assertions)
        judge: Judge callable for ``llm_judge`` assertions, or None when no
            judge is available

    Returns:
        AssertionResult: The evaluation outcome with a human-readable detail

    Raises:
        ValueError: If ``spec.type`` is not a supported assertion type
    """
    if spec.type in ('contains', 'not_contains'):
        return _evaluate_contains(spec, output_text)
    if spec.type == 'regex':
        return _evaluate_regex(spec, output_text)
    if spec.type == 'equals':
        return _evaluate_equals(spec, output_text)
    if spec.type in ('min_length', 'max_length'):
        return _evaluate_length(spec, output_text)
    if spec.type == 'json_path':
        return _evaluate_json_path(spec, output_text)
    if spec.type == 'latency_max_ms':
        return _evaluate_latency(spec, duration_ms)
    if spec.type == 'llm_judge':
        return _evaluate_llm_judge(spec, output_text, case_input, judge)
    raise ValueError(f'Unknown assertion type: {spec.type!r}')


def _evaluate_contains(spec: 'AssertionSpec', output_text: str) -> AssertionResult:
    """
    Evaluate a ``contains`` or ``not_contains`` assertion.

    Case-insensitive comparison uses ``str.casefold`` so Unicode-aware
    matches (e.g. German eszett) behave correctly.

    Args:
        spec: The assertion (params: value, ignore_case=False)
        output_text: The pipeline output

    Returns:
        AssertionResult: The evaluation outcome
    """
    value = spec.params['value']
    ignore_case = bool(spec.params.get('ignore_case', False))

    haystack = output_text.casefold() if ignore_case else output_text
    needle = value.casefold() if ignore_case else value
    found = needle in haystack

    negate = spec.type == 'not_contains'
    passed = found != negate
    presence = 'contains' if found else 'does not contain'
    suffix = ' (ignoring case)' if ignore_case else ''
    return AssertionResult(spec=spec, passed=passed, detail=f'output {presence} {value!r}{suffix}')


def _evaluate_regex(spec: 'AssertionSpec', output_text: str) -> AssertionResult:
    """
    Evaluate a ``regex`` assertion using ``re.search``.

    An invalid pattern is a data-shaped failure (it comes from the spec
    file), so it fails the assertion instead of raising.

    Args:
        spec: The assertion (params: pattern)
        output_text: The pipeline output

    Returns:
        AssertionResult: The evaluation outcome
    """
    pattern = spec.params['pattern']
    try:
        match = re.search(pattern, output_text)
    except re.error as err:
        return AssertionResult(spec=spec, passed=False, detail=f'invalid regex pattern {pattern!r}: {err}')

    if match is None:
        return AssertionResult(
            spec=spec,
            passed=False,
            detail=f'pattern {pattern!r} not found in output {_preview(output_text)!r}',
        )
    return AssertionResult(spec=spec, passed=True, detail=f'pattern {pattern!r} matched {match.group(0)!r}')


def _evaluate_equals(spec: 'AssertionSpec', output_text: str) -> AssertionResult:
    """
    Evaluate an ``equals`` assertion.

    ``strip`` (default True) strips surrounding whitespace from BOTH sides
    before comparing; ``ignore_case`` compares casefolded text.

    Args:
        spec: The assertion (params: value, ignore_case=False, strip=True)
        output_text: The pipeline output

    Returns:
        AssertionResult: The evaluation outcome
    """
    expected = spec.params['value']
    ignore_case = bool(spec.params.get('ignore_case', False))
    strip = bool(spec.params.get('strip', True))

    actual = output_text
    if strip:
        actual = actual.strip()
        expected = expected.strip()
    if ignore_case:
        actual_cmp, expected_cmp = actual.casefold(), expected.casefold()
    else:
        actual_cmp, expected_cmp = actual, expected

    if actual_cmp == expected_cmp:
        return AssertionResult(spec=spec, passed=True, detail=f'output equals {expected!r}')
    return AssertionResult(
        spec=spec,
        passed=False,
        detail=f'expected {_preview(expected)!r}, got {_preview(actual)!r}',
    )


def _evaluate_length(spec: 'AssertionSpec', output_text: str) -> AssertionResult:
    """
    Evaluate a ``min_length`` or ``max_length`` assertion (inclusive bounds).

    Args:
        spec: The assertion (params: value)
        output_text: The pipeline output

    Returns:
        AssertionResult: The evaluation outcome
    """
    bound = int(spec.params['value'])
    length = len(output_text)
    if spec.type == 'min_length':
        passed = length >= bound
        relation = '>='
    else:
        passed = length <= bound
        relation = '<='
    verdict = 'satisfies' if passed else 'violates'
    return AssertionResult(
        spec=spec,
        passed=passed,
        detail=f'output length {length} {verdict} {spec.type} {relation} {bound}',
    )


def _evaluate_json_path(spec: 'AssertionSpec', output_text: str) -> AssertionResult:
    """
    Evaluate a ``json_path`` assertion.

    Parses the output as JSON and walks the dot-separated path (integer
    segments index into lists). With no ``equals``/``gte``/``lte`` param the
    assertion is an existence check; otherwise every supplied check must
    hold. ``gte``/``lte`` require the resolved value to be a number.

    Args:
        spec: The assertion (params: path, equals?, gte?, lte?)
        output_text: The pipeline output (must be a JSON document)

    Returns:
        AssertionResult: The evaluation outcome
    """
    path = spec.params['path']
    try:
        node: Any = json.loads(output_text)
    except (json.JSONDecodeError, ValueError) as err:
        return AssertionResult(spec=spec, passed=False, detail=f'output is not valid JSON: {err}')

    # Walk the dot-path; '' addresses the document root
    segments = path.split('.') if path else []
    for position, segment in enumerate(segments):
        location = '.'.join(segments[: position + 1])
        if isinstance(node, dict):
            if segment not in node:
                return AssertionResult(spec=spec, passed=False, detail=f'json path {location!r} not found')
            node = node[segment]
        elif isinstance(node, list):
            try:
                index = int(segment)
            except ValueError:
                return AssertionResult(
                    spec=spec,
                    passed=False,
                    detail=f'json path {location!r}: list index expected, got {segment!r}',
                )
            if not -len(node) <= index < len(node):
                return AssertionResult(
                    spec=spec,
                    passed=False,
                    detail=f'json path {location!r}: index {index} out of range for list of length {len(node)}',
                )
            node = node[index]
        else:
            return AssertionResult(
                spec=spec,
                passed=False,
                detail=f'json path {location!r}: cannot descend into {type(node).__name__}',
            )

    checks: list[str] = []
    if 'equals' in spec.params:
        expected = spec.params['equals']
        # Python treats True == 1 and False == 0, so a bare `!=` would let a
        # JSON boolean satisfy `equals: 1` (and a JSON number satisfy
        # `equals: true`). Require the bool-ness of both sides to match first,
        # as the gte/lte branch below already does for its numeric operand.
        if isinstance(node, bool) != isinstance(expected, bool) or node != expected:
            return AssertionResult(
                spec=spec,
                passed=False,
                detail=f'json path {path!r} = {node!r}, expected {expected!r}',
            )
        checks.append(f'equals {expected!r}')
    for comparison in ('gte', 'lte'):
        if comparison not in spec.params:
            continue
        bound = spec.params[comparison]
        if isinstance(node, bool) or not isinstance(node, (int, float)):
            return AssertionResult(
                spec=spec,
                passed=False,
                detail=f'json path {path!r} = {node!r} is not a number, cannot compare {comparison}={bound}',
            )
        satisfied = node >= bound if comparison == 'gte' else node <= bound
        if not satisfied:
            return AssertionResult(
                spec=spec,
                passed=False,
                detail=f'json path {path!r} = {node!r} violates {comparison}={bound}',
            )
        checks.append(f'{comparison}={bound}')

    described = ' and '.join(checks) if checks else 'exists'
    return AssertionResult(spec=spec, passed=True, detail=f'json path {path!r} = {_preview(repr(node))} ({described})')


def _evaluate_latency(spec: 'AssertionSpec', duration_ms: float) -> AssertionResult:
    """
    Evaluate a ``latency_max_ms`` assertion against the measured duration.

    Args:
        spec: The assertion (params: value, in milliseconds)
        duration_ms: Measured duration of the chat call in milliseconds

    Returns:
        AssertionResult: The evaluation outcome
    """
    bound = float(spec.params['value'])
    passed = duration_ms <= bound
    relation = '<=' if passed else '>'
    return AssertionResult(
        spec=spec,
        passed=passed,
        detail=f'duration {duration_ms:.1f}ms {relation} {bound:g}ms',
    )


def _evaluate_llm_judge(
    spec: 'AssertionSpec',
    output_text: str,
    case_input: str,
    judge: JudgeFn | None,
) -> AssertionResult:
    """
    Evaluate an ``llm_judge`` assertion by delegating to the judge callable.

    Judge failures are data/environment-shaped (LLM output, pipeline runs),
    so an unparseable verdict or a failed judge run fails the assertion with
    the raw reply/error in the detail instead of raising.

    Args:
        spec: The assertion (params: criteria, min_score=0.7)
        output_text: The pipeline output to grade
        case_input: The input that produced the output (judge context)
        judge: Judge callable, or None when no judge is available

    Returns:
        AssertionResult: The evaluation outcome
    """
    criteria = spec.params['criteria']
    min_score = float(spec.params.get('min_score', _DEFAULT_MIN_SCORE))

    if judge is None:
        return AssertionResult(
            spec=spec,
            passed=False,
            detail='llm_judge assertion requires a judge pipeline, but none is available',
        )

    try:
        verdict = judge(criteria=criteria, case_input=case_input, output_text=output_text)
    except JudgeParseError as err:
        return AssertionResult(
            spec=spec,
            passed=False,
            detail=f'judge verdict unparseable: {err} (raw: {_preview(err.raw)!r})',
        )
    except Exception as err:  # noqa: BLE001 - judge runs an external pipeline
        return AssertionResult(spec=spec, passed=False, detail=f'judge run failed: {err}')

    passed = verdict.score >= min_score
    reasoning = f': {verdict.reasoning}' if verdict.reasoning else ''
    return AssertionResult(
        spec=spec,
        passed=passed,
        detail=f'judge score {verdict.score:.2f} (min_score {min_score:g}){reasoning}',
    )


def _preview(text: str, limit: int = _DETAIL_PREVIEW_LIMIT) -> str:
    """
    Return a length-limited preview of text for assertion details.

    Args:
        text: Arbitrary text to preview
        limit: Maximum number of characters to keep

    Returns:
        str: The preview, ellipsized when truncated
    """
    if len(text) <= limit:
        return text
    return text[:limit] + '...'
