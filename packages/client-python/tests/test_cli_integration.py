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
Integration tests for the RocketRide CLI.

The CLI is run as a real process against a live server, exactly the way a user
runs it, and the effect of each command is verified through a RocketRideClient
talking to the same server. Nothing is stubbed: a task the CLI starts is a task
the server reports, and a task the CLI stops is one the server drops.

Note:
    These integration tests require a running RocketRide server. Ensure the
    server is running and accessible at the configured URI before running tests.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

# Load .env from project root before any imports that need env vars
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
load_dotenv(PROJECT_ROOT / '.env')

from rocketride import RocketRideClient

from echo_pipeline import get_echo_pipeline


# Test configuration
TEST_CONFIG = {
    'uri': os.getenv('ROCKETRIDE_URI', 'http://localhost:5565'),
    'auth': os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY'),
    'timeout': 120.0,  # 120 second timeout for integration tests (CI runners can be slow)
}

# Package source, so the subprocess runs the CLI from this working tree
SRC_DIR = Path(__file__).parent.parent / 'src'

# Equivalent of the installed `rocketride` console script
CLI_ENTRY = 'import sys; from rocketride.cli.main import main; main()'

# Argparse reads these as option defaults, so the ambient configuration of
# whoever runs the suite must not reach the subprocess
CLI_ENV_VARS = ('ROCKETRIDE_URI', 'ROCKETRIDE_APIKEY', 'ROCKETRIDE_TOKEN', 'ROCKETRIDE_PIPELINE')


async def ensure_clean_pipeline(client: RocketRideClient, token: str) -> None:
    """Clean up pipeline if it exists, ignoring errors."""
    try:
        await client.terminate(token)
    except Exception:
        # Ignore errors - pipeline might not be running
        pass


async def run_cli(*args: str, cwd: Optional[str] = None) -> Tuple[int, str]:
    """
    Run the CLI as a separate process and collect its output.

    Args:
        *args: Command line arguments, without the program name
        cwd: Working directory for the process

    Returns:
        Tuple of (exit code, combined stdout and stderr)
    """
    env = dict(os.environ)
    env['PYTHONPATH'] = str(SRC_DIR)

    # These tests are about what the commands do, not about what the console
    # can render; console encoding is covered by test_cli_console_encoding.py
    env['PYTHONIOENCODING'] = 'utf-8'

    for name in CLI_ENV_VARS:
        env.pop(name, None)

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        '-c',
        CLI_ENTRY,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=cwd,
    )

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), TEST_CONFIG['timeout'])
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise

    output = stdout.decode('utf-8', errors='replace') + stderr.decode('utf-8', errors='replace')

    return process.returncode, output


def server_args() -> List[str]:
    """Connection arguments every CLI command needs."""
    return ['--uri', TEST_CONFIG['uri'], '--apikey', TEST_CONFIG['auth']]


def write_pipeline(tmp_path, project_id: str) -> str:
    """Write the echo pipeline to a file the CLI can load."""
    path = tmp_path / 'echo.pipe'
    path.write_text(json.dumps(get_echo_pipeline(project_id)), encoding='utf-8')
    return str(path)


async def list_task_tokens(client: RocketRideClient) -> List[str]:
    """Every task token the server currently reports."""
    response = await client.request(client.build_request(command='rrext_get_tasks'))
    tasks: List[Dict[str, Any]] = response.get('body', {}).get('tasks', [])
    return [task.get('token', '') for task in tasks]


async def wait_until_gone(client: RocketRideClient, token: str, timeout: float = 30.0) -> bool:
    """Poll until the server stops reporting the token, or the timeout expires."""
    deadline = asyncio.get_event_loop().time() + timeout

    while asyncio.get_event_loop().time() < deadline:
        if token not in await list_task_tokens(client):
            return True
        await asyncio.sleep(0.5)

    return False


class TestCliStart:
    """Test the start command against a live server."""

    PIPELINE_TOKEN = 'PY-CLI-START'
    PROJECT_ID = '3f2b1c88-5a41-4d7e-9c22-8b6f0e14a7d3'

    @pytest.mark.asyncio
    async def test_should_start_a_pipeline_the_server_reports(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            pipeline = write_pipeline(tmp_path, self.PROJECT_ID)
            code, output = await run_cli('start', pipeline, '--token', self.PIPELINE_TOKEN, *server_args())

            assert code == 0, output

            # The task the CLI started is a task the server knows about
            status = await client.get_task_status(self.PIPELINE_TOKEN)
            assert 'state' in status
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_report_the_token_for_monitoring(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            pipeline = write_pipeline(tmp_path, self.PROJECT_ID)
            code, output = await run_cli('start', pipeline, '--token', self.PIPELINE_TOKEN, *server_args())

            assert code == 0, output

            # The follow-up command it prints has to be one the user can run
            assert self.PIPELINE_TOKEN in output
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_fail_without_a_pipeline_file(self):
        code, output = await run_cli('start', *server_args())

        assert code == 1
        assert 'Pipeline file is required' in output

    @pytest.mark.asyncio
    async def test_should_fail_on_a_missing_pipeline_file(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()

            missing = str(tmp_path / 'no-such.pipe')
            code, output = await run_cli('start', missing, '--token', self.PIPELINE_TOKEN, *server_args())

            assert code == 1, output

            # A pipeline that never loaded must not leave a task behind
            assert self.PIPELINE_TOKEN not in await list_task_tokens(client)
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()


class TestCliStop:
    """Test the stop command against a live server."""

    PIPELINE_TOKEN = 'PY-CLI-STOP'
    PROJECT_ID = '5b7c2d99-6e52-4f8a-b133-9c7f1e25b8e4'

    @pytest.mark.asyncio
    async def test_should_stop_a_running_pipeline(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)
            assert self.PIPELINE_TOKEN in await list_task_tokens(client)

            code, output = await run_cli('stop', '--token', self.PIPELINE_TOKEN, *server_args())

            assert code == 0, output
            assert await wait_until_gone(client, self.PIPELINE_TOKEN), 'task still reported after stop'
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_fail_without_a_token(self):
        code, output = await run_cli('stop', *server_args())

        assert code == 1
        assert 'Token is required' in output


class TestCliList:
    """Test the list command against a live server."""

    PIPELINE_TOKEN = 'PY-CLI-LIST'
    PROJECT_ID = '7d9e4fbb-8a74-4c16-c355-be91f347d1f6'

    @pytest.mark.asyncio
    async def test_should_list_a_running_task_as_json(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            code, output = await run_cli('list', '--json', *server_args())

            assert code == 0, output

            tasks = json.loads(output)
            assert self.PIPELINE_TOKEN in [task.get('token') for task in tasks]
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_list_a_running_task_in_human_form(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            code, output = await run_cli('list', *server_args())

            assert code == 0, output
            assert self.PIPELINE_TOKEN in output
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()


class TestCliUpload:
    """Test the upload command against a live server."""

    PIPELINE_TOKEN = 'PY-CLI-UPLOAD'
    PROJECT_ID = '9fa16cdd-ab96-4e38-e577-da13f569f318'

    # The token the upload command hardcodes when it starts its own task
    MANAGED_TOKEN = 'UPLOAD_TASK'

    @staticmethod
    def write_files(tmp_path) -> List[str]:
        """Create two non-empty files to upload."""
        paths = []
        for name in ('alpha.txt', 'beta.txt'):
            path = tmp_path / name
            path.write_text(f'contents of {name}', encoding='utf-8')
            paths.append(str(path))
        return paths

    @pytest.mark.asyncio
    async def test_should_upload_files_to_an_existing_task(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            files = self.write_files(tmp_path)
            code, output = await run_cli('upload', *files, '--token', self.PIPELINE_TOKEN, *server_args())

            assert code == 0, output
            assert 'Upload Error' not in output

            # A task the CLI did not create is a task it must leave running
            assert self.PIPELINE_TOKEN in await list_task_tokens(client)
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_start_and_terminate_its_own_task(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.MANAGED_TOKEN)

            pipeline = write_pipeline(tmp_path, self.PROJECT_ID)
            files = self.write_files(tmp_path)

            code, output = await run_cli('upload', *files, '--pipeline_path', pipeline, *server_args())

            assert code == 0, output
            assert 'Upload Error' not in output

            # A task the CLI created is a task it has to clean up
            assert await wait_until_gone(client, self.MANAGED_TOKEN), 'upload task still reported after exit'
        finally:
            await ensure_clean_pipeline(client, self.MANAGED_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_fail_without_a_pipeline_or_token(self, tmp_path):
        files = self.write_files(tmp_path)

        code, output = await run_cli('upload', *files, *server_args())

        assert code == 1
        assert '--pipeline_path or --token' in output

    @pytest.mark.asyncio
    async def test_should_fail_when_no_file_matches(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)

            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            missing = str(tmp_path / 'nothing-*.txt')
            code, output = await run_cli('upload', missing, '--token', self.PIPELINE_TOKEN, *server_args())

            assert code == 1, output
            assert 'No files found' in output
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()


class TestCliEval:
    """Test the eval command's pre-connect spec handling."""

    @pytest.mark.asyncio
    async def test_should_fail_on_a_missing_spec_file(self, tmp_path):
        missing = str(tmp_path / 'no-such.eval.json')
        code, output = await run_cli('eval', missing, *server_args())

        # Specs are loaded before the CLI connects, so a missing spec is a
        # usage error (exit 2), never a failed-case result (exit 1)
        assert code == 2, output
        assert 'Error:' in output

    @pytest.mark.asyncio
    async def test_should_fail_on_an_unparsable_spec_file(self, tmp_path):
        broken = tmp_path / 'broken.eval.json'
        broken.write_text('{ not json', encoding='utf-8')

        code, output = await run_cli('eval', str(broken), *server_args())

        assert code == 2, output
        assert 'Error:' in output


class TestCliDispatch:
    """Test argument handling shared by every command."""

    @pytest.mark.asyncio
    async def test_should_print_help_without_a_command(self):
        code, output = await run_cli()

        assert code == 1
        assert 'COMMAND' in output

    @pytest.mark.asyncio
    async def test_should_reject_an_unknown_command(self):
        code, output = await run_cli('nonexistent')

        assert code == 2
        assert 'invalid choice' in output or 'argument COMMAND' in output

    @pytest.mark.asyncio
    async def test_should_require_a_store_subcommand(self):
        code, output = await run_cli('store', *server_args())

        assert code == 1
        assert 'Store subcommand is required' in output
