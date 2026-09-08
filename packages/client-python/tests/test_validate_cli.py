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
Unit tests for the `rocketride validate` CLI command.

These tests exercise the ValidateCommand through the full CLI entry point
(RocketRideCLI.run) with a fake client, so no live server or network is
required. They cover glob expansion, per-file validation results, JSON
output shape, --source passthrough, and the exit code contract:
0 = all valid, 1 = at least one invalid, 2 = nothing processable or
connection failure.
"""

import importlib
import json
import sys
from typing import Any, Dict, List, Optional

import pytest

# `rocketride.cli.main` must be imported as a module: the `rocketride.cli`
# package re-exports the `main()` function under the same name, which would
# shadow the module on attribute-style imports.
cli_main = importlib.import_module('rocketride.cli.main')

VALID_PIPELINE = {
    'project_id': 'test-project',
    'components': [
        {
            'id': 'webhook_1',
            'provider': 'webhook',
            'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'},
        },
        {
            'id': 'response_1',
            'provider': 'response',
            'config': {'lanes': []},
            'input': [{'lane': 'text', 'from': 'webhook_1'}],
        },
    ],
    'source': 'webhook_1',
}

CLEAN_RESULT: Dict[str, Any] = {'errors': [], 'warnings': []}

FAILED_RESULT: Dict[str, Any] = {
    'errors': [{'message': 'Component has no input', 'id': 'response_1'}],
    'warnings': [{'message': 'Source has no consumers', 'id': 'webhook_1'}],
}


class FakeClient:
    """Minimal stand-in for RocketRideClient used by the CLI under test."""

    def __init__(self, results: Optional[List[Any]] = None, connect_error: Optional[Exception] = None):
        """
        Initialize the fake client.

        Args:
            results: Validation results (or exceptions) consumed in call order
            connect_error: Exception to raise from connect(), if any
        """
        self.results = list(results or [])
        self.connect_error = connect_error
        self.connected = False
        self.validate_calls: List[Dict[str, Any]] = []

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

    async def validate(self, pipeline: Dict[str, Any], *, source: Optional[str] = None) -> Dict[str, Any]:
        """Record the call and return (or raise) the next queued result."""
        self.validate_calls.append({'pipeline': pipeline, 'source': source})
        result = self.results.pop(0) if self.results else CLEAN_RESULT
        if isinstance(result, Exception):
            raise result
        return result


async def run_cli(monkeypatch, fake_client: FakeClient, argv: List[str]) -> int:
    """Run the CLI end-to-end with a fake client and return its exit code."""
    monkeypatch.setattr(cli_main, 'RocketRideClient', lambda **kwargs: fake_client)
    monkeypatch.setattr(sys, 'argv', ['rocketride', 'validate', *argv])
    cli = cli_main.RocketRideCLI()
    return await cli.run()


@pytest.fixture
def pipe_file(tmp_path):
    """Create a valid .pipe file and return its path as a string."""
    path = tmp_path / 'pipeline.pipe'
    path.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
    return str(path)


class TestValidateCli:
    async def test_single_valid_file(self, monkeypatch, capsys, pipe_file):
        fake = FakeClient(results=[CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [pipe_file])

        assert exit_code == 0
        assert len(fake.validate_calls) == 1
        assert fake.validate_calls[0]['pipeline'] == VALID_PIPELINE
        out = capsys.readouterr().out
        assert pipe_file in out
        assert 'valid' in out
        assert 'Summary: 1 file(s), 1 valid, 0 invalid' in out

    async def test_unwraps_pipeline_wrapper(self, monkeypatch, tmp_path):
        wrapped = tmp_path / 'wrapped.pipe'
        wrapped.write_text(json.dumps({'pipeline': VALID_PIPELINE}), encoding='utf-8')
        fake = FakeClient(results=[CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [str(wrapped)])

        # The { "pipeline": { ... } } wrapper is stripped before the SDK call
        assert exit_code == 0
        assert len(fake.validate_calls) == 1
        assert fake.validate_calls[0]['pipeline'] == VALID_PIPELINE

    async def test_invalid_file_surfaces_errors(self, monkeypatch, capsys, pipe_file):
        fake = FakeClient(results=[FAILED_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [pipe_file])

        assert exit_code == 1
        out = capsys.readouterr().out
        assert 'Component has no input' in out
        assert 'response_1' in out
        assert 'Source has no consumers' in out
        assert 'Summary: 1 file(s), 0 valid, 1 invalid' in out

    async def test_multiple_files_mixed(self, monkeypatch, capsys, tmp_path):
        good = tmp_path / 'good.pipe'
        good.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        bad = tmp_path / 'bad.pipe'
        bad.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        fake = FakeClient(results=[CLEAN_RESULT, FAILED_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [str(good), str(bad)])

        assert exit_code == 1
        assert len(fake.validate_calls) == 2
        out = capsys.readouterr().out
        assert 'Summary: 2 file(s), 1 valid, 1 invalid' in out

    async def test_unparseable_file_alone_exits_2(self, monkeypatch, capsys, tmp_path):
        broken = tmp_path / 'broken.pipe'
        broken.write_text('{ not valid json', encoding='utf-8')
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [str(broken)])

        # No file could be processed, so exit 2 and never touch the server
        assert exit_code == 2
        assert fake.validate_calls == []
        assert not fake.connected
        out = capsys.readouterr().out
        assert 'Invalid JSON' in out

    async def test_unparseable_file_with_valid_file_exits_1(self, monkeypatch, capsys, tmp_path):
        broken = tmp_path / 'broken.pipe'
        broken.write_text('{ not valid json', encoding='utf-8')
        good = tmp_path / 'good.pipe'
        good.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        fake = FakeClient(results=[CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [str(broken), str(good)])

        # Unparseable file counts as invalid when other files were processed
        assert exit_code == 1
        assert len(fake.validate_calls) == 1
        out = capsys.readouterr().out
        assert 'Invalid JSON' in out
        assert 'Summary: 2 file(s), 1 valid, 1 invalid' in out

    async def test_non_object_json_alone_exits_2(self, monkeypatch, capsys, tmp_path):
        array_file = tmp_path / 'array.pipe'
        array_file.write_text('[1, 2, 3]', encoding='utf-8')
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [str(array_file)])

        # Non-object JSON is rejected locally: no connection, no server call
        assert exit_code == 2
        assert fake.validate_calls == []
        assert not fake.connected
        out = capsys.readouterr().out
        assert 'expected a JSON object' in out

    async def test_missing_file_alone_exits_2(self, monkeypatch, capsys, tmp_path):
        missing = str(tmp_path / 'does-not-exist.pipe')
        fake = FakeClient()

        exit_code = await run_cli(monkeypatch, fake, [missing])

        assert exit_code == 2
        assert fake.validate_calls == []
        out = capsys.readouterr().out
        assert 'File not found' in out

    async def test_glob_expansion(self, monkeypatch, capsys, tmp_path):
        for name in ('a.pipe', 'b.pipe'):
            (tmp_path / name).write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        fake = FakeClient(results=[CLEAN_RESULT, CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [str(tmp_path / '*.pipe')])

        assert exit_code == 0
        assert len(fake.validate_calls) == 2
        out = capsys.readouterr().out
        assert 'Summary: 2 file(s), 2 valid, 0 invalid' in out

    async def test_json_output_shape(self, monkeypatch, capsys, tmp_path):
        good = tmp_path / 'good.pipe'
        good.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        bad = tmp_path / 'bad.pipe'
        bad.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        fake = FakeClient(results=[CLEAN_RESULT, FAILED_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [str(good), str(bad), '--json'])

        assert exit_code == 1
        out = capsys.readouterr().out

        # stdout must be exactly one machine-readable JSON document
        document = json.loads(out)
        assert set(document.keys()) == {'files', 'summary'}
        assert document['summary'] == {'total': 2, 'valid': 1, 'invalid': 1}

        good_entry, bad_entry = document['files']
        assert good_entry == {'file': str(good), 'valid': True, 'errors': [], 'warnings': []}
        assert bad_entry['file'] == str(bad)
        assert bad_entry['valid'] is False
        assert bad_entry['errors'] == FAILED_RESULT['errors']
        assert bad_entry['warnings'] == FAILED_RESULT['warnings']

    async def test_source_passthrough(self, monkeypatch, pipe_file):
        fake = FakeClient(results=[CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [pipe_file, '--source', 'webhook_1'])

        assert exit_code == 0
        assert fake.validate_calls[0]['source'] == 'webhook_1'

    async def test_source_defaults_to_none(self, monkeypatch, pipe_file):
        fake = FakeClient(results=[CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [pipe_file])

        assert exit_code == 0
        assert fake.validate_calls[0]['source'] is None

    async def test_connection_failure_exits_2(self, monkeypatch, capsys, pipe_file):
        fake = FakeClient(connect_error=ConnectionError('connection refused'))

        exit_code = await run_cli(monkeypatch, fake, [pipe_file])

        assert exit_code == 2
        assert fake.validate_calls == []
        err = capsys.readouterr().err
        assert 'connection refused' in err

    async def test_server_error_marks_file_invalid(self, monkeypatch, capsys, tmp_path):
        good = tmp_path / 'good.pipe'
        good.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        bad = tmp_path / 'bad.pipe'
        bad.write_text(json.dumps(VALID_PIPELINE), encoding='utf-8')
        fake = FakeClient(results=[RuntimeError('Pipeline validation failed: boom'), CLEAN_RESULT])

        exit_code = await run_cli(monkeypatch, fake, [str(good), str(bad)])

        assert exit_code == 1
        out = capsys.readouterr().out
        assert 'boom' in out
        assert 'Summary: 2 file(s), 1 valid, 1 invalid' in out
