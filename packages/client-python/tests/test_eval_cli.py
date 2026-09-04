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

These tests exercise the EvalCommand through the full CLI entry point
(RocketRideCLI.run) with a fake client, so no live server or network is
required. The assertion evaluator is patched to a deterministic substring
check so the tests pin the CLI contract - glob expansion, spec validation,
pipeline lifecycle, --case/--fail-fast/--json/--junit behavior, and the
exit code contract: 0 = all cases passed, 1 = at least one case failed,
2 = usage/spec/connection error or no case produced a result.
"""

import importlib
import json
import os
import sys
from typing import Any

import pytest

from rocketride.evals import runner as runner_module
from rocketride.evals.assertions import AssertionResult

# `rocketride.cli.main` must be imported as a module: the `rocketride.cli`
# package re-exports the `main()` function under the same name, which would
# shadow the module on attribute-style imports.
cli_main = importlib.import_module('rocketride.cli.main')

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
    """Run the CLI end-to-end with a fake client and return its exit code."""
    monkeypatch.setattr(cli_main, 'RocketRideClient', lambda **kwargs: fake_client)
    monkeypatch.setattr(sys, 'argv', ['rocketride', 'eval', *argv])
    cli = cli_main.RocketRideCLI()
    return await cli.run()


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
        assert set(document.keys()) == {'specs', 'summary'}
        assert document['summary']['total_cases'] == 2
        assert document['summary']['passed'] == 1
        assert document['summary']['failed'] == 1
        assert len(document['specs']) == 1

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
