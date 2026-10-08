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
Unit tests for the `rocketride upload` command's concurrency flags.

Nothing connects: the parser tests are parse-only and the forwarding tests
run parse + dispatch against a fake client. The flags have to match the
TypeScript CLI, where --threads is the pipeline thread count and
--max-concurrent is the upload fan-out, and a bad limit has to be refused
before anything is started.
"""

import importlib

import pytest

# `rocketride.cli.main` must be imported as a module: the `rocketride.cli`
# package re-exports the `main()` function under the same name, which would
# shadow the module on attribute-style imports.
cli_main = importlib.import_module('rocketride.cli.main')
cli_common = importlib.import_module('rocketride.cli.utils.common')
# tasks binds connect_client into its own namespace at import time, so the
# patch must land there, not on utils.common.
cli_tasks = importlib.import_module('rocketride.cli.commands.tasks')


def parse_upload(*argv):
    """Parse an upload command line with the given extra flags."""
    return cli_main.setup_parser().parse_args(['upload', '--token', 'tok', *argv, 'a.txt'])


def test_defaults_match_typescript_cli():
    args = parse_upload()

    assert args.threads == 4
    assert args.max_concurrent == 5


def test_flags_are_independent():
    args = parse_upload('--threads', '8', '--max-concurrent', '2')

    assert args.threads == 8
    assert args.max_concurrent == 2


@pytest.mark.parametrize('value', ['0', '-1', '2.5', 'five'])
def test_rejects_invalid_max_concurrent(value, capsys):
    """A bad limit is refused at parse time, before any pipeline is started."""
    with pytest.raises(SystemExit):
        parse_upload('--max-concurrent', value)

    assert 'must be a positive integer' in capsys.readouterr().err


class FakeUploadClient:
    """Minimal stand-in for RocketRideClient that records what run_upload forwards."""

    def __init__(self):
        self.send_files_calls = []
        self.use_calls = []

    def is_connected(self) -> bool:
        return True

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def use(self, **kwargs):
        self.use_calls.append(kwargs)
        return {'token': 'started-token'}

    async def send_files(self, files, token, max_concurrent=5):
        self.send_files_calls.append({'token': token, 'max_concurrent': max_concurrent})
        return [{'action': 'complete', 'filepath': path, 'file_size': 0} for path in files]

    async def terminate(self, token) -> None:
        pass


async def run_upload_cli(monkeypatch, fake_client, argv):
    """Run the CLI's parse + dispatch path for upload, returning the exit code."""

    async def fake_connect_client(uri, apikey='', on_event=None):
        cli_common._active_clients.append(fake_client)
        await fake_client.connect()
        return fake_client

    monkeypatch.setattr(cli_tasks, 'connect_client', fake_connect_client)
    monkeypatch.setattr(cli_tasks, 'load_pipeline_config', lambda path: {'components': []})
    args = cli_main.setup_parser().parse_args(['upload', *argv])
    return await cli_main._dispatch(args)


@pytest.fixture
def upload_file(tmp_path):
    """Create one small file to upload and return its path as a string."""
    path = tmp_path / 'a.txt'
    path.write_text('hello')
    return str(path)


@pytest.mark.asyncio
async def test_token_path_forwards_max_concurrent(monkeypatch, upload_file):
    """Uploading into an existing task passes the configured limit through."""
    fake_client = FakeUploadClient()

    code = await run_upload_cli(monkeypatch, fake_client, ['--token', 'tok', '--max-concurrent', '3', upload_file])

    assert code == 0
    assert fake_client.use_calls == []
    assert fake_client.send_files_calls == [{'token': 'tok', 'max_concurrent': 3}]


@pytest.mark.asyncio
async def test_pipeline_path_forwards_max_concurrent(monkeypatch, tmp_path, upload_file):
    """Starting a pipeline sends --threads to use() and --max-concurrent to send_files()."""
    fake_client = FakeUploadClient()
    pipe_file = tmp_path / 'pipeline.pipe'
    pipe_file.write_text('{}')

    code = await run_upload_cli(
        monkeypatch,
        fake_client,
        ['--pipeline', str(pipe_file), '--threads', '9', '--max-concurrent', '3', upload_file],
    )

    assert code == 0
    assert fake_client.use_calls[0]['threads'] == 9
    assert fake_client.send_files_calls == [{'token': 'started-token', 'max_concurrent': 3}]
