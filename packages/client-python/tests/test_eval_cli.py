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
Unit tests for the `rocketride eval` CLI command.

These tests exercise run_eval through the CLI's parse + dispatch path with
a fake client, so no live server or network is required. The assertion
evaluator is patched to a deterministic substring check so the tests pin the
CLI contract - glob expansion, spec validation, pipeline lifecycle,
--case/--fail-fast/--json/--junit behavior, and the exit code contract:
0 = all cases passed, 1 = at least one case failed or a spec could not run to
completion, 2 = usage/spec/connection error or no case produced a result.
"""

import argparse
import importlib
import json
import os
import xml.etree.ElementTree as ET
from typing import Any

import pytest

from rocketride.evals import runner as runner_module
from rocketride.evals.assertions import AssertionResult

# `rocketride.cli.main` must be imported as a module: the `rocketride.cli`
# package re-exports the `main()` function under the same name, which would
# shadow the module on attribute-style imports.
cli_main = importlib.import_module('rocketride.cli.main')
cli_common = importlib.import_module('rocketride.cli.utils.common')
# eval binds connect_client into its own namespace at import time, so the
# patch must land there, not on utils.common.
cli_eval = importlib.import_module('rocketride.cli.commands.eval')

SPEC_DOC = {
    'pipeline': 'chat.pipe',
    'cases': [
        {'name': 'greeting', 'input': 'Say hello', 'expect': [{'type': 'contains', 'value': 'hello'}]},
        {'name': 'farewell', 'input': 'Say goodbye', 'expect': [{'type': 'contains', 'value': 'goodbye'}]},
    ],
}


class FakeClient:
    """Minimal stand-in for RocketRideClient used by the CLI under test."""

    def __init__(self, connect_error=None, use_error_for=None):
        """
        Initialize the fake client.

        Args:
            connect_error: Exception to raise from connect(), if any
            use_error_for: Substring of a pipeline path whose use() should fail
        """
        self.connected = False
        self.connect_error = connect_error
        self.use_error_for = use_error_for
        self.calls: list[tuple[str, Any]] = []
        self._token_counter = 0

    def is_connected(self) -> bool:
        """Report the fake connection state."""
        return self.connected

    async def connect(self) -> None:
        """Simulate connecting, raising connect_error when configured."""
        if self.connect_error is not None:
            raise self.connect_error
        self.connected = True

    async def disconnect(self) -> None:
        """Simulate disconnecting."""
        self.connected = False

    async def use(self, *, filepath=None, source=None, **kwargs):
        """Record the call and hand out a fresh task token."""
        if self.use_error_for is not None and self.use_error_for in str(filepath):
            raise RuntimeError(f'cannot start pipeline: {filepath}')
        self._token_counter += 1
        token = f'task-{self._token_counter}'
        self.calls.append(('use', {'filepath': filepath, 'source': source}))
        return {'token': token}

    async def chat(self, *, token, question, on_sse=None):
        """Echo the question so 'contains' style checks are deterministic."""
        text = question.questions[0].text
        self.calls.append(('chat', {'token': token, 'question': text}))
        return {'answers': [f'answer: {text}']}

    async def terminate(self, token):
        """Record the teardown call."""
        self.calls.append(('terminate', token))

    def chats(self):
        """Return every recorded chat call payload."""
        return [payload for kind, payload in self.calls if kind == 'chat']

    def use_paths(self):
        """Return the filepath of every recorded use() call."""
        return [payload['filepath'] for kind, payload in self.calls if kind == 'use']


@pytest.fixture(autouse=True)
def deterministic_evaluate(monkeypatch):
    """Patch the assertion evaluator to a pure substring check."""

    def fake_evaluate(assertion, *, output_text, duration_ms, case_input, judge):
        return AssertionResult(
            spec=assertion,
            passed=assertion.params.get('value', '') in output_text,
            detail='',
        )

    monkeypatch.setattr(runner_module, 'evaluate_assertion', fake_evaluate)


async def run_cli(monkeypatch, fake_client: FakeClient, argv: list[str]) -> int:
    """Run the CLI's parse + dispatch path with a fake client, returning its exit code."""

    async def fake_connect_client(uri, apikey='', on_event=None):
        # Mirror the real connect_client contract: register for the
        # disconnect_all cleanup, connect (raising any configured error),
        # hand back the connected client.
        cli_common._active_clients.append(fake_client)
        await fake_client.connect()
        return fake_client

    monkeypatch.setattr(cli_eval, 'connect_client', fake_connect_client)
    parser = cli_main.setup_parser()
    args = parser.parse_args(['eval', *argv])
    return await cli_main._dispatch(args)


def write_spec(tmp_path, document, name='sample.eval.json'):
    """Write an eval spec document to a temp file and return its path string."""
    path = tmp_path / name
    path.write_text(json.dumps(document), encoding='utf-8')
    return str(path)


@pytest.fixture
def spec_file(tmp_path):
    """Create a valid two-case eval spec and return its path as a string."""
    return write_spec(tmp_path, SPEC_DOC)


class TestEvalCli:
    async def test_all_cases_pass_exits_0(self, monkeypatch, capsys, spec_file):
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [spec_file])

        assert exit_code == 0
        # Pipeline lifecycle: started once, chatted per case, torn down
        kinds = [kind for kind, _ in fake.calls]
        assert kinds == ['use', 'chat', 'chat', 'terminate']
        out = capsys.readouterr().out
        assert 'greeting' in out
        assert 'farewell' in out

    async def test_failing_case_exits_1(self, monkeypatch, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['cases'][1]['expect'] = [{'type': 'contains', 'value': 'impossible-substring'}]
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(tmp_path, document)])

        assert exit_code == 1

    async def test_pipeline_path_resolves_relative_to_spec_file(self, monkeypatch, tmp_path):
        nested = tmp_path / 'suites'
        nested.mkdir()
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = '../pipes/chat.pipe'
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(nested, document)])

        assert exit_code == 0
        assert fake.use_paths() == [os.path.normpath(str(tmp_path / 'pipes' / 'chat.pipe'))]

    async def test_glob_expansion_runs_every_spec(self, monkeypatch, tmp_path):
        for name in ('a.eval.json', 'b.eval.json'):
            write_spec(tmp_path, SPEC_DOC, name=name)
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.eval.json')])

        assert exit_code == 0
        assert len(fake.use_paths()) == 2

    async def test_spec_parse_error_exits_2_without_connecting(self, monkeypatch, capsys, tmp_path):
        broken = tmp_path / 'broken.eval.json'
        broken.write_text('{ not valid json', encoding='utf-8')
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [str(broken)])

        assert exit_code == 2
        assert fake.calls == []
        assert not fake.connected
        assert 'Invalid JSON' in capsys.readouterr().err

    async def test_spec_validation_error_exits_2(self, monkeypatch, capsys, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['cases'][1]['name'] = document['cases'][0]['name']
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(tmp_path, document)])

        assert exit_code == 2
        assert fake.calls == []
        err = capsys.readouterr().err
        assert 'duplicate case name' in err
        assert 'sample.eval.json' in err

    async def test_missing_spec_file_exits_2(self, monkeypatch, capsys, tmp_path):
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / 'missing.eval.json')])

        assert exit_code == 2
        assert 'not found' in capsys.readouterr().err

    async def test_one_broken_spec_blocks_the_run(self, monkeypatch, capsys, tmp_path):
        # Spec validation is all-or-nothing: a broken spec is a usage error
        good = write_spec(tmp_path, SPEC_DOC, name='good.eval.json')
        broken = tmp_path / 'broken.eval.json'
        broken.write_text('[]', encoding='utf-8')
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [good, str(broken)])

        assert exit_code == 2
        assert fake.calls == []

    async def test_connection_failure_exits_2(self, monkeypatch, capsys, spec_file):
        fake = FakeClient(connect_error=ConnectionError('connection refused'))

        exit_code = await run_cli(monkeypatch, fake, [spec_file])

        assert exit_code == 2
        assert fake.calls == []
        assert 'connection refused' in capsys.readouterr().err

    async def test_pipeline_start_failure_alone_exits_2(self, monkeypatch, capsys, spec_file):
        fake = FakeClient(use_error_for='chat.pipe')

        exit_code = await run_cli(monkeypatch, fake, [spec_file])

        # No case produced a result, and the error names the spec
        assert exit_code == 2
        err = capsys.readouterr().err
        assert 'cannot start pipeline' in err
        assert 'sample.eval.json' in err

    async def test_pipeline_start_failure_with_passing_spec_exits_1(self, monkeypatch, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = 'broken.pipe'
        write_spec(tmp_path, document, name='a-broken.eval.json')
        write_spec(tmp_path, SPEC_DOC, name='b-good.eval.json')
        fake = FakeClient(use_error_for='broken.pipe')

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.eval.json')])

        # The good spec still ran to completion, but the run cannot be green
        assert exit_code == 1
        assert len(fake.chats()) == 2

    async def test_case_filter_runs_matching_cases_only(self, monkeypatch, spec_file):
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--case', 'greet'])

        assert exit_code == 0
        assert [chat['question'] for chat in fake.chats()] == ['Say hello']

    async def test_case_filter_matching_nothing_exits_2(self, monkeypatch, spec_file):
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--case', 'no-such-case'])

        assert exit_code == 2
        assert fake.chats() == []

    async def test_fail_fast_stops_after_first_failure(self, monkeypatch, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['cases'][0]['expect'] = [{'type': 'contains', 'value': 'impossible-substring'}]
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(tmp_path, document), '--fail-fast'])

        assert exit_code == 1
        # The second case never ran
        assert [chat['question'] for chat in fake.chats()] == ['Say hello']

    async def test_json_output_shape(self, monkeypatch, capsys, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['cases'][1]['expect'] = [{'type': 'contains', 'value': 'impossible-substring'}]
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(tmp_path, document), '--json'])

        assert exit_code == 1
        out = capsys.readouterr().out

        # stdout must be exactly one machine-readable JSON document
        document = json.loads(out)
        assert set(document.keys()) == {'specs', 'spec_errors', 'summary'}
        assert document['summary']['total_cases'] == 2
        assert document['summary']['passed'] == 1
        assert document['summary']['failed'] == 1
        assert len(document['specs']) == 1

    async def test_json_file_writes_the_report_and_keeps_human_output(self, monkeypatch, capsys, tmp_path):
        # The regression: `--json <file>` used to be a usage error (exit 2,
        # nothing evaluated). It must now run the specs, write the document to
        # the file, and leave the human report on stdout - exactly what
        # `validate --json <file>` does.
        report_path = tmp_path / 'report.json'
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(tmp_path, SPEC_DOC), '--json', str(report_path)])

        assert exit_code == 0
        document = json.loads(report_path.read_text(encoding='utf-8'))
        assert set(document.keys()) == {'specs', 'spec_errors', 'summary'}
        assert document['summary'] == {'total_cases': 2, 'passed': 2, 'failed': 0, 'spec_errors': 0}
        # ...and the human report still went to stdout
        out = capsys.readouterr().out
        assert 'greeting' in out
        assert 'farewell' in out

    async def test_json_file_exits_1_on_a_failing_case(self, monkeypatch, tmp_path):
        # The exit code follows the results (0/1), never the old usage-error 2
        document = json.loads(json.dumps(SPEC_DOC))
        document['cases'][1]['expect'] = [{'type': 'contains', 'value': 'impossible-substring'}]
        report_path = tmp_path / 'report.json'
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [write_spec(tmp_path, document), '--json', str(report_path)])

        assert exit_code == 1
        written = json.loads(report_path.read_text(encoding='utf-8'))
        assert written['summary']['failed'] == 1
        assert written['spec_errors'] == []

    async def test_json_file_carries_spec_errors(self, monkeypatch, tmp_path):
        # A spec that cannot run is in the written document too, so a CI
        # artifact never shows a green run for a run that exited non-zero
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = 'broken.pipe'
        write_spec(tmp_path, document, name='a-broken.eval.json')
        write_spec(tmp_path, SPEC_DOC, name='b-good.eval.json')
        report_path = tmp_path / 'report.json'
        fake = FakeClient(use_error_for='broken.pipe')

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.eval.json'), '--json', str(report_path)])

        assert exit_code == 1
        written = json.loads(report_path.read_text(encoding='utf-8'))
        assert [entry['spec'] for entry in written['spec_errors']] == [str(tmp_path / 'a-broken.eval.json')]
        assert written['summary']['spec_errors'] == 1

    async def test_json_file_carries_a_spec_parse_error_envelope(self, monkeypatch, capsys, tmp_path):
        # Exit 2 before any case runs still leaves a document behind: the
        # shared {"error": ...} envelope every other subcommand writes.
        broken = tmp_path / 'broken.eval.json'
        broken.write_text('{ not valid json', encoding='utf-8')
        report_path = tmp_path / 'report.json'
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [str(broken), '--json', str(report_path)])

        assert exit_code == 2
        assert fake.calls == []
        assert report_path.exists()
        written = json.loads(report_path.read_text(encoding='utf-8'))
        assert set(written.keys()) == {'error'}
        assert 'Invalid JSON' in written['error']['message']
        assert str(broken) in written['error']['message']
        # ...and the sentence on stderr is printed exactly once
        captured = capsys.readouterr()
        assert captured.err.count('Error:') == 1
        assert 'Invalid JSON' in captured.err

    async def test_json_file_carries_a_connection_error_envelope(self, monkeypatch, capsys, tmp_path, spec_file):
        # The other exit-2 path: the specs parsed, the server is down
        report_path = tmp_path / 'report.json'
        fake = FakeClient(connect_error=ConnectionError('connection refused'))

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--json', str(report_path)])

        assert exit_code == 2
        assert report_path.exists()
        written = json.loads(report_path.read_text(encoding='utf-8'))
        assert set(written.keys()) == {'error'}
        assert 'Unable to connect to server' in written['error']['message']
        assert 'connection refused' in written['error']['message']
        # hint_for() turns the refusal into the next step to take
        assert written['error']['hint'].startswith('is the server at ')
        assert written['error']['hint'].endswith('running?')
        # One sentence on stderr, carrying the same message and hint
        captured = capsys.readouterr()
        assert captured.err.count('Error:') == 1
        assert 'Unable to connect to server' in captured.err
        assert 'running?' in captured.err

    async def test_stale_json_report_is_overwritten_by_the_error_envelope(self, monkeypatch, tmp_path, spec_file):
        # The failure that costs someone time: run 1 passes and writes the
        # report, run 2 cannot reach the server. The reporting step must not
        # read run 1's green summary as run 2's result.
        report_path = tmp_path / 'report.json'
        passing = FakeClient()
        assert await run_cli(monkeypatch, passing, [spec_file, '--json', str(report_path)]) == 0
        assert json.loads(report_path.read_text(encoding='utf-8'))['summary']['passed'] == 2

        offline = FakeClient(connect_error=ConnectionError('connection refused'))
        exit_code = await run_cli(monkeypatch, offline, [spec_file, '--json', str(report_path)])

        assert exit_code == 2
        written = json.loads(report_path.read_text(encoding='utf-8'))
        assert 'summary' not in written
        assert 'Unable to connect to server' in written['error']['message']

    async def test_bare_json_carries_only_the_error_envelope(self, monkeypatch, capsys, spec_file):
        # Bare --json owns stdout: exactly one JSON document there, nothing else
        fake = FakeClient(connect_error=ConnectionError('connection refused'))

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--json'])

        assert exit_code == 2
        captured = capsys.readouterr()
        document = json.loads(captured.out)
        assert set(document.keys()) == {'error'}
        assert 'Unable to connect to server' in document['error']['message']
        # stdout is the document and nothing but the document
        assert captured.out.strip() == json.dumps(document, indent=2)
        assert captured.err.count('Error:') == 1

    async def test_human_mode_reports_the_failure_on_stderr_only(self, monkeypatch, capsys, spec_file):
        # No --json: no document anywhere, one sentence on stderr, clean stdout
        fake = FakeClient(connect_error=ConnectionError('connection refused'))

        exit_code = await run_cli(monkeypatch, fake, [spec_file])

        assert exit_code == 2
        captured = capsys.readouterr()
        assert captured.out == ''
        assert captured.err.count('Error:') == 1
        assert captured.err.strip().startswith('Error: Unable to connect to server')

    async def test_json_file_and_junit_are_written_together(self, monkeypatch, capsys, tmp_path, spec_file):
        # Both machine reports, plus the human one on stdout; missing parent
        # directories are created for each
        report_path = tmp_path / 'reports' / 'evals.json'
        junit_path = tmp_path / 'reports' / 'evals.xml'
        fake = FakeClient()

        exit_code = await run_cli(
            monkeypatch,
            fake,
            [spec_file, '--json', str(report_path), '--junit', str(junit_path)],
        )

        assert exit_code == 0
        assert json.loads(report_path.read_text(encoding='utf-8'))['summary']['passed'] == 2
        assert '<testsuite' in junit_path.read_text(encoding='utf-8')
        assert 'greeting' in capsys.readouterr().out

    async def test_clean_run_reports_no_spec_errors(self, monkeypatch, capsys, spec_file):
        # spec_errors is always present, so a consumer can read it without
        # having to probe for the key first
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--json'])

        assert exit_code == 0
        document = json.loads(capsys.readouterr().out)
        assert document['spec_errors'] == []
        assert document['summary'] == {'total_cases': 2, 'passed': 2, 'failed': 0, 'spec_errors': 0}

    async def test_json_carries_spec_error_alongside_passing_spec(self, monkeypatch, capsys, tmp_path):
        # The regression this pins: the run exits 1, so the JSON artifact CI
        # displays must not read as a clean pass just because the spec that
        # broke produced no report of its own.
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = 'broken.pipe'
        write_spec(tmp_path, document, name='a-broken.eval.json')
        write_spec(tmp_path, SPEC_DOC, name='b-good.eval.json')
        fake = FakeClient(use_error_for='broken.pipe')

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.eval.json'), '--json'])

        assert exit_code == 1
        captured = capsys.readouterr()
        # --json owns stdout: the spec error goes to stderr *and* into the document
        assert 'cannot start pipeline' in captured.err
        report = json.loads(captured.out)

        assert len(report['spec_errors']) == 1
        assert report['spec_errors'][0]['spec'] == str(tmp_path / 'a-broken.eval.json')
        assert 'cannot start pipeline' in report['spec_errors'][0]['error']
        assert report['summary']['spec_errors'] == 1
        # ...and the spec that did run is still reported in full
        assert len(report['specs']) == 1
        assert report['summary']['total_cases'] == 2
        assert report['summary']['failed'] == 0

    async def test_junit_carries_spec_error_alongside_passing_spec(self, monkeypatch, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = 'broken.pipe'
        write_spec(tmp_path, document, name='a-broken.eval.json')
        write_spec(tmp_path, SPEC_DOC, name='b-good.eval.json')
        junit_path = tmp_path / 'reports' / 'evals.xml'
        fake = FakeClient(use_error_for='broken.pipe')

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.eval.json'), '--junit', str(junit_path)])

        assert exit_code == 1
        root = ET.fromstring(junit_path.read_text(encoding='utf-8'))
        # 2 cases from the spec that ran + 1 synthetic test for the one that did not
        assert root.get('tests') == '3'
        assert root.get('errors') == '1'
        assert root.get('failures') == '0'

        errored = [suite for suite in root.findall('testsuite') if suite.get('errors') == '1']
        assert len(errored) == 1
        assert errored[0].get('name') == str(tmp_path / 'a-broken.eval.json')
        assert errored[0].get('tests') == '1'
        assert errored[0].get('failures') == '0'
        error = errored[0].find('testcase/error')
        assert error is not None
        assert 'cannot start pipeline' in error.get('message')

    async def test_every_spec_erroring_exits_2_but_reports_still_carry_the_errors(self, monkeypatch, capsys, tmp_path):
        # "all specs errored" stays exit 2, but the reports written on that
        # path must still name every spec that could not run
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = 'broken.pipe'
        write_spec(tmp_path, document, name='a.eval.json')
        write_spec(tmp_path, document, name='b.eval.json')
        junit_path = tmp_path / 'evals.xml'
        fake = FakeClient(use_error_for='broken.pipe')

        exit_code = await run_cli(
            monkeypatch,
            fake,
            [str(tmp_path / '*.eval.json'), '--json', '--junit', str(junit_path)],
        )

        assert exit_code == 2
        report = json.loads(capsys.readouterr().out)
        assert report['specs'] == []
        assert [entry['spec'] for entry in report['spec_errors']] == [
            str(tmp_path / 'a.eval.json'),
            str(tmp_path / 'b.eval.json'),
        ]
        assert report['summary'] == {'total_cases': 0, 'passed': 0, 'failed': 0, 'spec_errors': 2}

        root = ET.fromstring(junit_path.read_text(encoding='utf-8'))
        assert root.get('tests') == '2'
        assert root.get('errors') == '2'
        assert len(root.findall('testsuite/testcase/error')) == 2

    async def test_human_output_lists_spec_errors(self, monkeypatch, capsys, tmp_path):
        document = json.loads(json.dumps(SPEC_DOC))
        document['pipeline'] = 'broken.pipe'
        write_spec(tmp_path, document, name='a-broken.eval.json')
        write_spec(tmp_path, SPEC_DOC, name='b-good.eval.json')
        fake = FakeClient(use_error_for='broken.pipe')

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.eval.json')])

        assert exit_code == 1
        captured = capsys.readouterr()
        # Still on stderr, and now also in the report the human reads
        assert 'cannot start pipeline' in captured.err
        assert 'a-broken.eval.json: cannot start pipeline' in captured.out
        assert captured.out.rstrip().endswith('Summary: 2 case(s), 2 passed, 0 failed, 1 spec error(s)')

    async def test_junit_report_written_alongside_human_output(self, monkeypatch, capsys, tmp_path, spec_file):
        junit_path = tmp_path / 'reports' / 'evals.xml'
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--junit', str(junit_path)])

        assert exit_code == 0
        # The XML report was written...
        content = junit_path.read_text(encoding='utf-8')
        assert '<testsuite' in content
        # ...and the human output still went to stdout
        out = capsys.readouterr().out
        assert 'greeting' in out

    async def test_unwritable_junit_path_exits_2(self, monkeypatch, tmp_path, spec_file):
        # A directory path cannot be opened as a file for writing
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [spec_file, '--junit', str(tmp_path)])

        assert exit_code == 2


class TestEvalRegistration:
    def test_eval_is_registered_exactly_once_alongside_validate(self):
        # The command table must carry both the upstream 'validate' verb and
        # this PR's 'eval' verb, each registered exactly once.
        parser = cli_main.setup_parser()
        subparsers = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
        names = [choice.dest for choice in subparsers._choices_actions]
        assert names.count('eval') == 1
        assert names.count('validate') == 1

    def test_eval_takes_the_shared_json_file_option(self):
        # `eval --json` is the shared --json [FILE] option every other
        # subcommand takes: bare --json means stdout ('-'), and both spellings
        # of --json <file> name a destination file.
        parser = cli_main.setup_parser()
        args = parser.parse_args(['eval', 'a.eval.json', '--json'])
        assert args.json == '-'
        assert args.uri is not None
        assert parser.parse_args(['eval', 'a.eval.json', '--json=out.json']).json == 'out.json'

    def test_json_file_argument_is_not_swallowed_by_the_files_positional(self):
        # The regression: with a store_true --json, the space-separated
        # `--json out.json` spelling was a usage error (argparse rejected the
        # leftover as an unrecognized argument), and with the flag written
        # first the report path was consumed as an eval spec instead.
        parser = cli_main.setup_parser()

        args = parser.parse_args(['eval', 'a.eval.json', '--json', 'out.json'])
        assert args.json == 'out.json'
        assert args.files == ['a.eval.json']

        flag_first = parser.parse_args(['eval', '--json', 'out.json', 'a.eval.json'])
        assert flag_first.json == 'out.json'
        assert flag_first.files == ['a.eval.json']

    def test_validate_keeps_the_shared_json_file_option(self):
        # The upstream contract for `validate` must survive this merge.
        parser = cli_main.setup_parser()
        assert parser.parse_args(['validate', 'a.pipe', '--json']).json == '-'
        assert parser.parse_args(['validate', 'a.pipe', '--json=out.json']).json == 'out.json'
