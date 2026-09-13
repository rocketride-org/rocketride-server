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
Golden-Dataset Eval Spec Loading and Validation.

This module defines the data model for RocketRide eval specs (``<name>.eval.json``
files) and the ``load_spec()`` loader that parses and validates them. An eval
spec describes a pipeline under test plus a list of named cases, each with an
input string and a non-empty list of assertions to run against the pipeline's
output.

Spec File Format (strict JSON):
    {
        "pipeline": "path/to/pipeline.pipe",     # required, relative to the spec file
        "source": "webhook_1",                   # optional source component override
        "judge_pipeline": "path/to/judge.pipe",  # optional spec-level judge override
        "cases": [
            {
                "name": "unique case name",       # required, unique within the spec
                "input": "question to send",      # required
                "judge_pipeline": "judge.pipe",   # optional per-case judge override
                "expect": [ { "type": "contains", "value": "hello" }, ... ]
            }
        ]
    }

All relative paths (``pipeline`` and both levels of ``judge_pipeline``) are
resolved relative to the directory containing the spec file, so a spec behaves
identically no matter which directory the CLI is invoked from.

Supported Assertion Types:
    contains / not_contains: substring match, optional ``ignore_case``
    regex: ``pattern`` must match the output (``re.search`` semantics)
    equals: exact match, optional ``ignore_case`` and ``strip`` (default true)
    min_length / max_length: bounds on output length in characters
    json_path: dot-path lookup into JSON output with ``equals``/``gte``/``lte``
    latency_max_ms: upper bound on the chat round-trip duration
    llm_judge: LLM-as-judge scoring with ``criteria`` and ``min_score``

Components:
    AssertionSpec: One parsed assertion (type plus its parameters)
    EvalCase: One named case with input and assertions
    EvalSpec: A fully parsed and validated eval spec file
    EvalSpecError: Raised for any spec parse or validation problem
    load_spec: Parse and validate a spec file into an EvalSpec
"""

import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class EvalSpecError(Exception):
    """
    Raised when an eval spec file cannot be parsed or fails validation.

    The message always includes the spec file path and, where applicable,
    the case name and assertion index so failures are actionable without
    opening the file.
    """


@dataclass
class AssertionSpec:
    """
    A single parsed assertion from a case's ``expect`` list.

    Attributes:
        type: The assertion type (e.g. ``contains``, ``regex``, ``llm_judge``)
        params: All remaining keys of the assertion object (e.g. ``value``,
            ``pattern``, ``ignore_case``); defaults for optional parameters
            are applied by the assertion evaluator, not here
    """

    type: str
    params: dict = field(default_factory=dict)


@dataclass
class EvalCase:
    """
    One named eval case: an input string plus the assertions it must satisfy.

    Attributes:
        name: Unique (within the spec) human-readable case name
        input: The question/input text sent to the pipeline
        expect: Non-empty list of assertions to evaluate against the output
        judge_pipeline: Optional per-case judge pipeline path (already resolved
            relative to the spec file), overriding the spec-level judge
    """

    name: str
    input: str
    expect: list[AssertionSpec] = field(default_factory=list)
    judge_pipeline: str | None = None


@dataclass
class EvalSpec:
    """
    A fully parsed and validated eval spec file.

    Attributes:
        path: Path of the spec file as given to ``load_spec()``
        pipeline: Pipeline file path, resolved relative to the spec file
        source: Optional source component override passed to the pipeline start
        judge_pipeline: Optional spec-level judge pipeline path (resolved
            relative to the spec file); cases may override it individually
        cases: Non-empty list of validated eval cases
    """

    path: str
    pipeline: str
    source: str | None = None
    judge_pipeline: str | None = None
    cases: list[EvalCase] = field(default_factory=list)


def _resolve_path(base_dir: str, value: str) -> str:
    """
    Resolve a (possibly relative) path against the spec file's directory.

    Args:
        base_dir: Absolute directory containing the spec file
        value: Path value from the spec file (absolute paths pass through)

    Returns:
        Normalized absolute path
    """
    if os.path.isabs(value):
        return os.path.normpath(value)
    return os.path.normpath(os.path.join(base_dir, value))


def _require_str(params: dict, key: str, context: str, *, allow_empty: bool = True) -> str:
    """
    Fetch a required string parameter from an assertion, raising on absence.

    Args:
        params: Assertion parameters (the assertion object minus ``type``)
        key: Required parameter name
        context: Human-readable location prefix for error messages
        allow_empty: Whether an empty string is acceptable

    Returns:
        The validated string value

    Raises:
        EvalSpecError: If the parameter is missing, not a string, or empty
            when ``allow_empty`` is False
    """
    value = params.get(key)
    if not isinstance(value, str):
        raise EvalSpecError(f"{context}: '{key}' is required and must be a string")
    if not allow_empty and not value:
        raise EvalSpecError(f"{context}: '{key}' must be a non-empty string")
    return value


def _check_bool(params: dict, key: str, context: str) -> None:
    """
    Validate that an optional parameter, when present, is a boolean.

    Args:
        params: Assertion parameters
        key: Optional parameter name
        context: Human-readable location prefix for error messages

    Raises:
        EvalSpecError: If the parameter is present but not a boolean
    """
    if key in params and not isinstance(params[key], bool):
        raise EvalSpecError(f"{context}: '{key}' must be a boolean")


def _check_number(params: dict, key: str, context: str) -> None:
    """
    Validate that an optional parameter, when present, is a number.

    Booleans are explicitly rejected even though ``bool`` subclasses ``int``.

    Args:
        params: Assertion parameters
        key: Optional parameter name
        context: Human-readable location prefix for error messages

    Raises:
        EvalSpecError: If the parameter is present but not a number
    """
    if key in params:
        value = params[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise EvalSpecError(f"{context}: '{key}' must be a number")


def _validate_text_match(params: dict, context: str) -> None:
    """Validate ``contains`` / ``not_contains`` parameters."""
    _require_str(params, 'value', context)
    _check_bool(params, 'ignore_case', context)


def _validate_regex(params: dict, context: str) -> None:
    """Validate ``regex`` parameters, including that the pattern compiles."""
    pattern = _require_str(params, 'pattern', context, allow_empty=False)
    try:
        re.compile(pattern)
    except re.error as err:
        raise EvalSpecError(f'{context}: invalid regex pattern: {err}') from err


def _validate_equals(params: dict, context: str) -> None:
    """Validate ``equals`` parameters."""
    _require_str(params, 'value', context)
    _check_bool(params, 'ignore_case', context)
    _check_bool(params, 'strip', context)


def _validate_length(params: dict, context: str) -> None:
    """Validate ``min_length`` / ``max_length`` parameters."""
    value = params.get('value')
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvalSpecError(f"{context}: 'value' must be an integer")
    if value < 0:
        raise EvalSpecError(f"{context}: 'value' must be >= 0")


def _validate_json_path(params: dict, context: str) -> None:
    """Validate ``json_path`` parameters."""
    _require_str(params, 'path', context, allow_empty=False)
    _check_number(params, 'gte', context)
    _check_number(params, 'lte', context)


def _validate_latency(params: dict, context: str) -> None:
    """Validate ``latency_max_ms`` parameters."""
    value = params.get('value')
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvalSpecError(f"{context}: 'value' must be a number (milliseconds)")
    if value <= 0:
        raise EvalSpecError(f"{context}: 'value' must be a positive number of milliseconds")


def _validate_llm_judge(params: dict, context: str) -> None:
    """Validate ``llm_judge`` parameters, including the ``min_score`` range."""
    _require_str(params, 'criteria', context, allow_empty=False)
    if 'min_score' in params:
        score = params['min_score']
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            raise EvalSpecError(f"{context}: 'min_score' must be a number")
        if not 0.0 <= score <= 1.0:
            raise EvalSpecError(f"{context}: 'min_score' must be between 0 and 1")


# Maps each known assertion type to its parameter validator and the full set
# of parameter keys it accepts. This is the single source of truth for which
# assertion types a spec may reference and which parameters each type takes;
# keys outside the allowed set are rejected so a typo (e.g. ``ignore_cas`` or
# ``patern``) fails loudly instead of silently changing what a case tests.
_ASSERTION_TYPES: dict[str, tuple[Callable[[dict, str], None], frozenset[str]]] = {
    'contains': (_validate_text_match, frozenset({'value', 'ignore_case'})),
    'not_contains': (_validate_text_match, frozenset({'value', 'ignore_case'})),
    'regex': (_validate_regex, frozenset({'pattern'})),
    'equals': (_validate_equals, frozenset({'value', 'ignore_case', 'strip'})),
    'min_length': (_validate_length, frozenset({'value'})),
    'max_length': (_validate_length, frozenset({'value'})),
    'json_path': (_validate_json_path, frozenset({'path', 'equals', 'gte', 'lte'})),
    'latency_max_ms': (_validate_latency, frozenset({'value'})),
    'llm_judge': (_validate_llm_judge, frozenset({'criteria', 'min_score'})),
}


def _parse_assertion(entry: Any, context: str) -> AssertionSpec:
    """
    Validate one entry of a case's ``expect`` list.

    Args:
        entry: Raw JSON value for the assertion
        context: Human-readable location prefix for error messages

    Returns:
        AssertionSpec with the assertion type and its remaining parameters

    Raises:
        EvalSpecError: If the entry is not an object, has no/unknown ``type``,
            carries parameter keys the type does not accept, or its
            type-specific parameters are invalid
    """
    if not isinstance(entry, dict):
        raise EvalSpecError(f'{context}: each assertion must be a JSON object')

    assertion_type = entry.get('type')
    if not isinstance(assertion_type, str) or not assertion_type:
        raise EvalSpecError(f"{context}: assertion is missing a 'type' string")

    if assertion_type not in _ASSERTION_TYPES:
        known = ', '.join(sorted(_ASSERTION_TYPES))
        raise EvalSpecError(f"{context}: unknown assertion type '{assertion_type}' (known types: {known})")
    validator, allowed_params = _ASSERTION_TYPES[assertion_type]

    params = {key: value for key, value in entry.items() if key != 'type'}
    unknown_params = sorted(set(params) - allowed_params)
    if unknown_params:
        unknown = ', '.join(f"'{key}'" for key in unknown_params)
        allowed = ', '.join(f"'{key}'" for key in sorted(allowed_params))
        raise EvalSpecError(
            f"{context}: '{assertion_type}': unknown parameter(s) {unknown} (allowed parameters: {allowed})"
        )

    validator(params, f"{context}: '{assertion_type}'")
    return AssertionSpec(type=assertion_type, params=params)


def _parse_case(entry: Any, index: int, base_dir: str, seen_names: set) -> EvalCase:
    """
    Validate one entry of the spec's ``cases`` list.

    Args:
        entry: Raw JSON value for the case
        index: Zero-based position in the ``cases`` list (for error context)
        base_dir: Spec file directory used to resolve relative judge paths
        seen_names: Case names already used (mutated to include this case)

    Returns:
        EvalCase with validated fields and parsed assertions

    Raises:
        EvalSpecError: If the case is malformed, its name duplicates another
            case, its ``expect`` list is empty, or any assertion is invalid
    """
    context = f'cases[{index}]'
    if not isinstance(entry, dict):
        raise EvalSpecError(f'{context}: each case must be a JSON object')

    name = entry.get('name')
    if not isinstance(name, str) or not name:
        raise EvalSpecError(f"{context}: 'name' is required and must be a non-empty string")
    if name in seen_names:
        raise EvalSpecError(f"case '{name}': duplicate case name (case names must be unique)")
    seen_names.add(name)
    context = f"case '{name}'"

    input_value = entry.get('input')
    if not isinstance(input_value, str):
        raise EvalSpecError(f"{context}: 'input' is required and must be a string")

    judge_pipeline = entry.get('judge_pipeline')
    if judge_pipeline is not None:
        if not isinstance(judge_pipeline, str) or not judge_pipeline:
            raise EvalSpecError(f"{context}: 'judge_pipeline' must be a non-empty string")
        judge_pipeline = _resolve_path(base_dir, judge_pipeline)

    expect = entry.get('expect')
    if not isinstance(expect, list) or not expect:
        raise EvalSpecError(f"{context}: 'expect' must be a non-empty list of assertions")

    assertions = [_parse_assertion(item, f'{context}: expect[{position}]') for position, item in enumerate(expect)]
    return EvalCase(name=name, input=input_value, expect=assertions, judge_pipeline=judge_pipeline)


def _parse_spec(data: Any, path: str, base_dir: str) -> EvalSpec:
    """
    Validate the parsed JSON document of an eval spec.

    Args:
        data: Parsed top-level JSON value of the spec file
        path: Spec file path (recorded on the resulting EvalSpec)
        base_dir: Spec file directory used to resolve relative paths

    Returns:
        Fully validated EvalSpec

    Raises:
        EvalSpecError: For any structural or semantic validation failure
            (messages carry case/assertion context but not the file path;
            ``load_spec`` prefixes the path)
    """
    if not isinstance(data, dict):
        raise EvalSpecError('expected a JSON object at the top level')

    pipeline = data.get('pipeline')
    if not isinstance(pipeline, str) or not pipeline:
        raise EvalSpecError("'pipeline' is required and must be a non-empty string")
    pipeline = _resolve_path(base_dir, pipeline)

    source = data.get('source')
    if source is not None and (not isinstance(source, str) or not source):
        raise EvalSpecError("'source' must be a non-empty string when present")

    judge_pipeline = data.get('judge_pipeline')
    if judge_pipeline is not None:
        if not isinstance(judge_pipeline, str) or not judge_pipeline:
            raise EvalSpecError("'judge_pipeline' must be a non-empty string when present")
        judge_pipeline = _resolve_path(base_dir, judge_pipeline)

    cases_data = data.get('cases')
    if not isinstance(cases_data, list) or not cases_data:
        raise EvalSpecError("'cases' must be a non-empty list of case objects")

    seen_names: set = set()
    cases = [_parse_case(entry, index, base_dir, seen_names) for index, entry in enumerate(cases_data)]

    return EvalSpec(path=path, pipeline=pipeline, source=source, judge_pipeline=judge_pipeline, cases=cases)


def load_spec(path: str) -> EvalSpec:
    """
    Load and validate an eval spec file.

    Parses the file as strict JSON and validates the full spec structure:
    required fields, unique case names, non-empty ``expect`` lists, known
    assertion types, per-type required parameters (rejecting parameter keys
    the type does not accept, so typos fail loudly), and the ``min_score``
    range for ``llm_judge`` assertions. All relative paths are resolved
    against the spec file's directory.

    Args:
        path: Path to the ``<name>.eval.json`` spec file

    Returns:
        EvalSpec: The fully parsed and validated spec

    Raises:
        EvalSpecError: If the file is missing/unreadable, is not valid JSON,
            or fails validation; the message includes the file path and, for
            case-level problems, the case name and assertion index
    """
    if not os.path.isfile(path):
        raise EvalSpecError(f'Eval spec file not found: {path}')

    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except json.JSONDecodeError as err:
        raise EvalSpecError(f'Invalid JSON in {path}: {err}') from err
    except UnicodeDecodeError as err:
        # A spec saved in a non-UTF-8 encoding must still surface as a spec
        # error (CLI exit 2), not as an unexpected error (exit 1, which the
        # documented contract reserves for "at least one case failed").
        raise EvalSpecError(f'{path} is not valid UTF-8: {err}') from err
    except OSError as err:
        raise EvalSpecError(f'Cannot read {path}: {err}') from err

    base_dir = os.path.dirname(os.path.abspath(path))
    try:
        return _parse_spec(data, path, base_dir)
    except EvalSpecError as err:
        # Prefix every validation failure with the spec file path so multi-spec
        # CLI runs report exactly which file is broken.
        raise EvalSpecError(f'{path}: {err}') from None
