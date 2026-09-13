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
Result Types and Report Rendering for the RocketRide Eval Runner.

This module defines the result containers produced by ``rocketride eval``
(per-case and per-spec) and renders them in the three supported output
formats: human-readable terminal text, a machine-readable JSON document, and
JUnit XML for CI systems.

The human format is a compact per-item report: a check/cross per item,
indented per-assertion details, and a final
``Summary: N case(s), P passed, F failed`` line. The JSON format is a single
document with per-spec/per-case detail plus an aggregate summary. The JUnit
format maps one ``<testsuite>`` per spec and one ``<testcase>`` per case,
with ``<failure>`` elements carrying failed-assertion details and ``<error>``
elements for cases that crashed before producing assertions.

A spec that could not be run at all (e.g. its pipeline failed to start)
produces no ``EvalReport``, so every renderer also takes a list of
``SpecError`` records. Without them the machine-readable reports would show
a clean run for a run that actually failed, which is exactly what a CI
consumer reads to decide whether a change is green.

Key Features:
    - CaseResult/EvalReport dataclasses with derived pass/fail counts
    - SpecError records for specs that never produced a report
    - Human-readable rendering with optional ANSI colors
    - Machine-readable JSON document for scripting
    - JUnit XML via xml.etree with fully escaped, XML-safe text

Usage:
    print(render_human(reports, use_color=sys.stdout.isatty(), spec_errors=spec_errors))
    json.dumps(render_json(reports, spec_errors))
    pathlib.Path('junit.xml').write_text(render_junit(reports, spec_errors))

Components:
    CaseResult: Result of one eval case
    EvalReport: Result of one eval spec (all its cases)
    SpecError: A spec that could not be run to completion
    render_human: Terminal-friendly report text
    render_json: Single JSON document for all specs
    render_junit: JUnit XML string for CI ingestion
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any

from .assertions import AssertionResult

# ANSI codes duplicated from rocketride.cli.ui.colors: importing them would
# pull in (and potentially cycle with) the CLI package during CLI startup.
_ANSI_RESET = '\033[0m'
_ANSI_RED = '\033[91m'
_ANSI_GREEN = '\033[92m'
_CHR_CHECK = '✓'
_CHR_CROSS = '✗'

# Name of the synthetic JUnit testcase standing in for a spec that never ran
_SPEC_ERROR_CASE_NAME = 'spec did not run'


@dataclass
class CaseResult:
    """
    Result of running one eval case against its pipeline.

    Attributes:
        name: Case name from the eval spec
        passed: True if every assertion passed and no error occurred
        assertion_results: Per-assertion outcomes (empty if the case errored
            before assertions could run)
        output_text: The pipeline output the assertions ran against
        duration_ms: Measured duration of the chat call in milliseconds
        error: Error message when the case crashed (None on a clean run)
    """

    name: str
    passed: bool
    assertion_results: list[AssertionResult] = field(default_factory=list)
    output_text: str = ''
    duration_ms: float = 0.0
    error: str | None = None


@dataclass
class EvalReport:
    """
    Result of running one eval spec (all of its cases).

    Attributes:
        spec_path: Path of the ``.eval.json`` spec file
        pipeline: Path of the pipeline the spec ran against
        case_results: Per-case results in execution order
        duration_ms: Total wall-clock duration for the spec in milliseconds
    """

    spec_path: str
    pipeline: str
    case_results: list[CaseResult] = field(default_factory=list)
    duration_ms: float = 0.0

    @property
    def passed_count(self) -> int:
        """Number of cases that passed."""
        return sum(1 for case in self.case_results if case.passed)

    @property
    def failed_count(self) -> int:
        """Number of cases that failed (including errored cases)."""
        return sum(1 for case in self.case_results if not case.passed)

    @property
    def all_passed(self) -> bool:
        """True if no case failed."""
        return self.failed_count == 0


@dataclass(frozen=True)
class SpecError:
    """
    A spec that could not be run to completion.

    Produced when running a spec raises before it yields an ``EvalReport``
    (e.g. its pipeline fails to start), so the failure is still carried into
    every report format instead of silently vanishing from them.

    Attributes:
        spec_path: Path of the ``.eval.json`` spec that could not be run
        message: Human-readable error message (never empty)
        error_type: Class name of the underlying exception
    """

    spec_path: str
    message: str
    error_type: str

    @classmethod
    def from_exception(cls, spec_path: str, error: BaseException) -> SpecError:
        """
        Build a SpecError from the exception a spec run raised.

        Args:
            spec_path: Path of the spec that could not be run
            error: The exception raised while running the spec

        Returns:
            SpecError: Record carrying the path, message, and exception type;
            the exception type stands in as the message when the exception
            carries no message of its own
        """
        return cls(
            spec_path=spec_path,
            message=str(error) or type(error).__name__,
            error_type=type(error).__name__,
        )


def render_human(
    reports: list[EvalReport],
    use_color: bool,
    spec_errors: list[SpecError] | None = None,
) -> str:
    """
    Render eval reports as human-readable terminal text.

    Emits one check/cross line per case, indented per-assertion detail
    lines, a cross line per spec that could not be run, and a final summary
    line of the form ``Summary: N case(s), P passed, F failed`` — extended
    with ``, E spec error(s)`` when any spec failed to run.

    Args:
        reports: Eval reports in execution order
        use_color: True to wrap status symbols in ANSI color codes
        spec_errors: Specs that could not be run to completion

    Returns:
        str: The rendered report (no trailing newline)
    """
    check = f'{_ANSI_GREEN}{_CHR_CHECK}{_ANSI_RESET}' if use_color else _CHR_CHECK
    cross = f'{_ANSI_RED}{_CHR_CROSS}{_ANSI_RESET}' if use_color else _CHR_CROSS

    lines: list[str] = []
    for report in reports:
        lines.append(f'{report.spec_path} ({report.pipeline})')
        for case in report.case_results:
            symbol = check if case.passed else cross
            lines.append(f'  {symbol} {case.name} ({case.duration_ms:.0f}ms)')
            if case.error is not None:
                error_label = f'{_ANSI_RED}error{_ANSI_RESET}' if use_color else 'error'
                lines.append(f'      {error_label}: {case.error}')
            for outcome in case.assertion_results:
                assertion_symbol = check if outcome.passed else cross
                lines.append(f'      {assertion_symbol} {outcome.spec.type}: {outcome.detail}')

    # Specs that never produced a report get their own block: they have no
    # cases to list, but the run is not green and the report must say so
    spec_errors = spec_errors or []
    if spec_errors:
        lines.append('')
        for spec_error in spec_errors:
            lines.append(f'{cross} {spec_error.spec_path}: {spec_error.message}')

    total = sum(len(report.case_results) for report in reports)
    passed = sum(report.passed_count for report in reports)
    lines.append('')
    summary = f'Summary: {total} case(s), {passed} passed, {total - passed} failed'
    if spec_errors:
        summary += f', {len(spec_errors)} spec error(s)'
    lines.append(summary)
    return '\n'.join(lines)


def render_json(reports: list[EvalReport], spec_errors: list[SpecError] | None = None) -> dict:
    """
    Render eval reports as a single machine-readable JSON document.

    ``spec_errors`` and ``summary.spec_errors`` are always present (empty
    and ``0`` on a clean run) so a consumer can read them unconditionally.

    Args:
        reports: Eval reports in execution order
        spec_errors: Specs that could not be run to completion

    Returns:
        dict: ``{"specs": [...], "spec_errors": [...], "summary":
        {"total_cases", "passed", "failed", "spec_errors"}}`` where each spec
        entry carries its cases and each case its assertion outcomes, and
        each spec-error entry is ``{"spec": path, "error": message}``
    """
    specs: list[dict[str, Any]] = []
    for report in reports:
        specs.append(
            {
                'spec': report.spec_path,
                'pipeline': report.pipeline,
                'passed': report.all_passed,
                'duration_ms': report.duration_ms,
                'cases': [
                    {
                        'name': case.name,
                        'passed': case.passed,
                        'duration_ms': case.duration_ms,
                        'output_text': case.output_text,
                        'error': case.error,
                        'assertions': [
                            {
                                'type': outcome.spec.type,
                                'passed': outcome.passed,
                                'detail': outcome.detail,
                            }
                            for outcome in case.assertion_results
                        ],
                    }
                    for case in report.case_results
                ],
            }
        )

    spec_errors = spec_errors or []
    total = sum(len(report.case_results) for report in reports)
    passed = sum(report.passed_count for report in reports)
    return {
        'specs': specs,
        'spec_errors': [{'spec': spec_error.spec_path, 'error': spec_error.message} for spec_error in spec_errors],
        'summary': {
            'total_cases': total,
            'passed': passed,
            'failed': total - passed,
            'spec_errors': len(spec_errors),
        },
    }


def render_junit(reports: list[EvalReport], spec_errors: list[SpecError] | None = None) -> str:
    """
    Render eval reports as JUnit XML for CI ingestion.

    Structure: one ``<testsuite>`` per spec under a ``<testsuites>`` root,
    one ``<testcase>`` per case. Failed assertions produce a ``<failure>``
    element whose text lists each failed assertion; a case that crashed
    produces an ``<error>`` element instead. A spec that could not be run at
    all is rendered as a one-test suite holding a single errored
    ``<testcase>``, so a CI system never reads the run as green. ``time``
    attributes are in seconds. All text is XML-escaped and stripped of
    characters that are invalid in XML 1.0 (e.g. ANSI escapes and NUL bytes).

    Args:
        reports: Eval reports in execution order
        spec_errors: Specs that could not be run to completion

    Returns:
        str: The JUnit XML document, including the XML declaration
    """
    spec_errors = spec_errors or []
    # Each spec that could not run contributes one synthetic errored test
    total = sum(len(report.case_results) for report in reports) + len(spec_errors)
    total_failures = 0
    total_errors = len(spec_errors)
    for report in reports:
        for case in report.case_results:
            if case.error is not None:
                total_errors += 1
            elif not case.passed:
                total_failures += 1

    root = ET.Element(
        'testsuites',
        {
            'name': 'rocketride eval',
            'tests': str(total),
            'failures': str(total_failures),
            'errors': str(total_errors),
            'time': _seconds(sum(report.duration_ms for report in reports)),
        },
    )

    for report in reports:
        errors = sum(1 for case in report.case_results if case.error is not None)
        failures = report.failed_count - errors
        suite = ET.SubElement(
            root,
            'testsuite',
            {
                'name': _xml_safe(report.spec_path),
                'tests': str(len(report.case_results)),
                'failures': str(failures),
                'errors': str(errors),
                'time': _seconds(report.duration_ms),
            },
        )
        for case in report.case_results:
            testcase = ET.SubElement(
                suite,
                'testcase',
                {
                    'name': _xml_safe(case.name),
                    'classname': _xml_safe(report.pipeline),
                    'time': _seconds(case.duration_ms),
                },
            )
            if case.error is not None:
                error_element = ET.SubElement(testcase, 'error', {'message': _xml_safe(case.error)})
                error_element.text = _xml_safe(case.error)
            elif not case.passed:
                failed = [outcome for outcome in case.assertion_results if not outcome.passed]
                failure_element = ET.SubElement(
                    testcase,
                    'failure',
                    {'message': _xml_safe(f'{len(failed)} assertion(s) failed')},
                )
                failure_element.text = _xml_safe(
                    '\n'.join(f'{outcome.spec.type}: {outcome.detail}' for outcome in failed)
                )

    # One synthetic suite per spec that never ran, so the failure is visible
    # in the CI test tree rather than only on stderr
    for spec_error in spec_errors:
        suite = ET.SubElement(
            root,
            'testsuite',
            {
                'name': _xml_safe(spec_error.spec_path),
                'tests': '1',
                'failures': '0',
                'errors': '1',
                'time': _seconds(0.0),
            },
        )
        testcase = ET.SubElement(
            suite,
            'testcase',
            {
                'name': _SPEC_ERROR_CASE_NAME,
                'classname': _xml_safe(spec_error.spec_path),
                'time': _seconds(0.0),
            },
        )
        error_element = ET.SubElement(
            testcase,
            'error',
            {'message': _xml_safe(spec_error.message), 'type': _xml_safe(spec_error.error_type)},
        )
        error_element.text = _xml_safe(f'{spec_error.spec_path}: {spec_error.message}')

    ET.indent(root)
    return "<?xml version='1.0' encoding='utf-8'?>\n" + ET.tostring(root, encoding='unicode')


def _seconds(duration_ms: float) -> str:
    """
    Format a millisecond duration as a JUnit ``time`` attribute in seconds.

    Args:
        duration_ms: Duration in milliseconds

    Returns:
        str: Seconds with millisecond precision, e.g. ``'1.234'``
    """
    return f'{duration_ms / 1000.0:.3f}'


def _xml_safe(text: str) -> str:
    """
    Strip characters that are invalid in XML 1.0 from text.

    ElementTree escapes markup but happily serializes control characters
    (e.g. NUL bytes or ANSI escape sequences from pipeline output) that make
    the document unparseable; those are removed here. Tab, newline, and
    carriage return are preserved.

    Args:
        text: Arbitrary text destined for an XML attribute or text node

    Returns:
        str: The text with XML-invalid characters removed
    """
    return ''.join(char for char in text if _is_xml_char(ord(char)))


def _is_xml_char(codepoint: int) -> bool:
    """
    Report whether a codepoint is a valid XML 1.0 character.

    Args:
        codepoint: Unicode codepoint to test

    Returns:
        bool: True if the codepoint may appear in an XML 1.0 document
    """
    return (
        codepoint in (0x09, 0x0A, 0x0D)
        or 0x20 <= codepoint <= 0xD7FF
        or 0xE000 <= codepoint <= 0xFFFD
        or 0x10000 <= codepoint <= 0x10FFFF
    )
