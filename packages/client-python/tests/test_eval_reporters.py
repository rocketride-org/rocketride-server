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
Unit tests for rocketride.evals.reporters.

Covers the CaseResult/EvalReport derived counts, the SpecError record for
specs that never produced a report, and the three output formats:
human-readable text (with and without ANSI color), the JSON document shape,
and JUnit XML structure (parsed back with xml.etree), including escaping of
markup characters and stripping of XML-invalid control characters.
"""

import json
import xml.etree.ElementTree as ET

from rocketride.evals.assertions import AssertionResult
from rocketride.evals.reporters import (
    CaseResult,
    EvalReport,
    SpecError,
    render_human,
    render_json,
    render_junit,
)
from rocketride.evals.spec import AssertionSpec


def make_assertion_result(assertion_type: str, passed: bool, detail: str) -> AssertionResult:
    """Build an AssertionResult for report rendering tests."""
    return AssertionResult(spec=AssertionSpec(type=assertion_type, params={}), passed=passed, detail=detail)


def make_report() -> EvalReport:
    """Build a report with one passing, one failing, and one errored case."""
    return EvalReport(
        spec_path='specs/smoke.eval.json',
        pipeline='pipelines/chat.pipe',
        case_results=[
            CaseResult(
                name='greets politely',
                passed=True,
                assertion_results=[make_assertion_result('contains', True, "output contains 'hello'")],
                output_text='hello there',
                duration_ms=120.5,
            ),
            CaseResult(
                name='knows the capital',
                passed=False,
                assertion_results=[
                    make_assertion_result('contains', True, "output contains 'city'"),
                    make_assertion_result('equals', False, "expected 'Paris', got 'London'"),
                ],
                output_text='the city is London',
                duration_ms=340.0,
            ),
            CaseResult(
                name='crashes hard',
                passed=False,
                assertion_results=[],
                output_text='',
                duration_ms=15.0,
                error='chat failed: connection reset',
            ),
        ],
        duration_ms=1500.0,
    )


# =========================================================================
# derived properties
# =========================================================================


def test_report_counts():
    report = make_report()
    assert report.passed_count == 1
    assert report.failed_count == 2
    assert not report.all_passed


def test_all_passed_when_every_case_passes():
    report = EvalReport(
        spec_path='s.eval.json',
        pipeline='p.pipe',
        case_results=[CaseResult(name='only', passed=True)],
        duration_ms=1.0,
    )
    assert report.all_passed
    assert report.passed_count == 1
    assert report.failed_count == 0


def test_empty_report_is_all_passed():
    report = EvalReport(spec_path='s.eval.json', pipeline='p.pipe', case_results=[], duration_ms=0.0)
    assert report.all_passed


# =========================================================================
# render_human
# =========================================================================


def test_human_output_lists_spec_cases_and_assertions():
    text = render_human([make_report()], use_color=False)
    assert 'specs/smoke.eval.json (pipelines/chat.pipe)' in text
    assert '✓ greets politely (120ms)' in text
    assert '✗ knows the capital (340ms)' in text
    assert "✗ equals: expected 'Paris', got 'London'" in text
    assert 'error: chat failed: connection reset' in text


def test_human_output_summary_line_matches_validate_style():
    text = render_human([make_report()], use_color=False)
    assert text.endswith('Summary: 3 case(s), 1 passed, 2 failed')


def test_human_output_without_color_has_no_ansi():
    assert '\033[' not in render_human([make_report()], use_color=False)


def test_human_output_with_color_has_ansi():
    text = render_human([make_report()], use_color=True)
    assert '\033[92m✓' in text
    assert '\033[91m✗' in text


def test_human_output_aggregates_multiple_reports():
    text = render_human([make_report(), make_report()], use_color=False)
    assert text.endswith('Summary: 6 case(s), 2 passed, 4 failed')


# =========================================================================
# render_json
# =========================================================================


def test_json_document_shape():
    document = render_json([make_report()])
    assert set(document.keys()) == {'specs', 'spec_errors', 'summary'}
    assert document['summary'] == {'total_cases': 3, 'passed': 1, 'failed': 2, 'spec_errors': 0}
    assert document['spec_errors'] == []

    spec_entry = document['specs'][0]
    assert spec_entry['spec'] == 'specs/smoke.eval.json'
    assert spec_entry['pipeline'] == 'pipelines/chat.pipe'
    assert spec_entry['passed'] is False
    assert spec_entry['duration_ms'] == 1500.0
    assert [case['name'] for case in spec_entry['cases']] == [
        'greets politely',
        'knows the capital',
        'crashes hard',
    ]


def test_json_case_entries_carry_assertions_and_errors():
    document = render_json([make_report()])
    cases = document['specs'][0]['cases']

    failing = cases[1]
    assert failing['passed'] is False
    assert failing['error'] is None
    assert failing['assertions'][1] == {
        'type': 'equals',
        'passed': False,
        'detail': "expected 'Paris', got 'London'",
    }

    errored = cases[2]
    assert errored['error'] == 'chat failed: connection reset'
    assert errored['assertions'] == []


def test_json_document_is_json_serializable():
    json.dumps(render_json([make_report()]))


def test_json_empty_reports():
    document = render_json([])
    assert document == {
        'specs': [],
        'spec_errors': [],
        'summary': {'total_cases': 0, 'passed': 0, 'failed': 0, 'spec_errors': 0},
    }


# =========================================================================
# render_junit
# =========================================================================


def test_junit_structure_round_trips_through_etree():
    root = ET.fromstring(render_junit([make_report()]))
    assert root.tag == 'testsuites'
    assert root.get('tests') == '3'
    assert root.get('failures') == '1'
    assert root.get('errors') == '1'

    suites = root.findall('testsuite')
    assert len(suites) == 1
    suite = suites[0]
    assert suite.get('name') == 'specs/smoke.eval.json'
    assert suite.get('tests') == '3'
    assert suite.get('failures') == '1'
    assert suite.get('errors') == '1'
    assert suite.get('time') == '1.500'

    testcases = suite.findall('testcase')
    assert [testcase.get('name') for testcase in testcases] == [
        'greets politely',
        'knows the capital',
        'crashes hard',
    ]
    assert all(testcase.get('classname') == 'pipelines/chat.pipe' for testcase in testcases)


def test_junit_failure_element_carries_assertion_details():
    root = ET.fromstring(render_junit([make_report()]))
    failing = root.findall('testsuite/testcase')[1]
    failure = failing.find('failure')
    assert failure is not None
    assert failure.get('message') == '1 assertion(s) failed'
    assert "equals: expected 'Paris', got 'London'" in failure.text
    # Passing assertions are not listed in the failure body
    assert 'contains' not in failure.text


def test_junit_error_element_for_errored_case():
    root = ET.fromstring(render_junit([make_report()]))
    errored = root.findall('testsuite/testcase')[2]
    assert errored.find('failure') is None
    error = errored.find('error')
    assert error is not None
    assert error.get('message') == 'chat failed: connection reset'


def test_junit_passing_case_has_no_children():
    root = ET.fromstring(render_junit([make_report()]))
    passing = root.findall('testsuite/testcase')[0]
    assert list(passing) == []


def test_junit_time_attributes_are_seconds():
    report = EvalReport(
        spec_path='s.eval.json',
        pipeline='p.pipe',
        case_results=[CaseResult(name='timed', passed=True, duration_ms=1234.0)],
        duration_ms=1234.0,
    )
    root = ET.fromstring(render_junit([report]))
    assert root.find('testsuite/testcase').get('time') == '1.234'


def test_junit_escapes_markup_and_unicode():
    report = EvalReport(
        spec_path='specs/<weird> & "quoted".eval.json',
        pipeline='p.pipe',
        case_results=[
            CaseResult(
                name='handles <tags> & "quotes" and unicode Grüße',
                passed=False,
                assertion_results=[
                    make_assertion_result('contains', False, 'expected <b>bold</b> & more'),
                ],
                output_text='<html>',
                duration_ms=1.0,
            )
        ],
        duration_ms=1.0,
    )
    root = ET.fromstring(render_junit([report]))
    testcase = root.find('testsuite/testcase')
    assert testcase.get('name') == 'handles <tags> & "quotes" and unicode Grüße'
    assert 'expected <b>bold</b> & more' in testcase.find('failure').text


def test_junit_strips_xml_invalid_control_characters():
    report = EvalReport(
        spec_path='s.eval.json',
        pipeline='p.pipe',
        case_results=[
            CaseResult(
                name='case with control chars',
                passed=False,
                assertion_results=[],
                output_text='',
                duration_ms=1.0,
                error='ansi \x1b[91mred\x1b[0m and nul \x00 bytes',
            )
        ],
        duration_ms=1.0,
    )
    root = ET.fromstring(render_junit([report]))
    error = root.find('testsuite/testcase/error')
    assert error.get('message') == 'ansi [91mred[0m and nul  bytes'


def test_junit_multiple_reports_produce_multiple_suites():
    xml_text = render_junit([make_report(), make_report()])
    root = ET.fromstring(xml_text)
    assert len(root.findall('testsuite')) == 2
    assert root.get('tests') == '6'


# =========================================================================
# spec errors — specs that never produced a report
# =========================================================================


def make_spec_errors() -> list[SpecError]:
    """Build the spec-error record for a spec whose pipeline never started."""
    return [
        SpecError.from_exception(
            'specs/broken.eval.json',
            RuntimeError('cannot start pipeline: broken.pipe'),
        )
    ]


def make_passing_report() -> EvalReport:
    """Build a report whose single case passed."""
    return EvalReport(
        spec_path='specs/good.eval.json',
        pipeline='pipelines/chat.pipe',
        case_results=[CaseResult(name='only', passed=True, duration_ms=10.0)],
        duration_ms=10.0,
    )


def test_spec_error_from_exception_captures_message_and_type():
    spec_error = SpecError.from_exception('s.eval.json', ValueError('boom'))
    assert spec_error.spec_path == 's.eval.json'
    assert spec_error.message == 'boom'
    assert spec_error.error_type == 'ValueError'


def test_spec_error_falls_back_to_type_when_exception_has_no_message():
    # str(TimeoutError()) is '' - the record must still say something useful
    spec_error = SpecError.from_exception('s.eval.json', TimeoutError())
    assert spec_error.message == 'TimeoutError'
    assert spec_error.error_type == 'TimeoutError'


def test_json_lists_spec_errors_and_counts_them():
    document = render_json([make_passing_report()], make_spec_errors())
    assert document['spec_errors'] == [
        {'spec': 'specs/broken.eval.json', 'error': 'cannot start pipeline: broken.pipe'}
    ]
    # The passing spec's own counts are untouched by the failure next to it
    assert document['summary'] == {'total_cases': 1, 'passed': 1, 'failed': 0, 'spec_errors': 1}


def test_json_carries_spec_errors_when_no_spec_produced_a_report():
    document = render_json([], make_spec_errors())
    assert document['specs'] == []
    assert len(document['spec_errors']) == 1
    assert document['summary']['spec_errors'] == 1


def test_junit_renders_a_spec_error_as_an_errored_suite():
    root = ET.fromstring(render_junit([make_passing_report()], make_spec_errors()))
    assert root.get('tests') == '2'
    assert root.get('errors') == '1'
    assert root.get('failures') == '0'

    suite = root.findall('testsuite')[-1]
    assert suite.get('name') == 'specs/broken.eval.json'
    assert suite.get('tests') == '1'
    assert suite.get('failures') == '0'
    assert suite.get('errors') == '1'

    testcase = suite.find('testcase')
    assert testcase.get('classname') == 'specs/broken.eval.json'
    error = testcase.find('error')
    assert error.get('message') == 'cannot start pipeline: broken.pipe'
    assert error.get('type') == 'RuntimeError'
    assert 'specs/broken.eval.json' in error.text


def test_junit_spec_error_survives_with_no_reports_at_all():
    root = ET.fromstring(render_junit([], make_spec_errors()))
    assert root.get('tests') == '1'
    assert root.get('errors') == '1'
    assert root.find('testsuite/testcase/error') is not None


def test_junit_escapes_markup_in_spec_errors():
    spec_errors = [
        SpecError.from_exception(
            'specs/<weird> & "quoted".eval.json',
            RuntimeError('failed on <tag> & \x00 nul'),
        )
    ]
    root = ET.fromstring(render_junit([], spec_errors))
    suite = root.find('testsuite')
    assert suite.get('name') == 'specs/<weird> & "quoted".eval.json'
    assert suite.find('testcase/error').get('message') == 'failed on <tag> &  nul'


def test_human_lists_spec_errors_in_its_summary():
    text = render_human([make_passing_report()], use_color=False, spec_errors=make_spec_errors())
    assert '✗ specs/broken.eval.json: cannot start pipeline: broken.pipe' in text
    assert text.endswith('Summary: 1 case(s), 1 passed, 0 failed, 1 spec error(s)')


def test_human_summary_unchanged_without_spec_errors():
    # The summary line only grows the extra clause when there is one to report
    assert render_human([make_passing_report()], use_color=False).endswith('Summary: 1 case(s), 1 passed, 0 failed')
