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

# rocketride_common ships INSIDE the rocketride wheel, but from source it is a
# sibling package — the subprocess path must carry it explicitly (same reason
# as the sys.path insert in conftest.py).
COMMON_SRC_DIR = Path(__file__).parents[2] / 'client-common' / 'python' / 'src'

# Equivalent of the installed `rocketride` console script. The source paths
# are injected INSIDE the bootstrap, not via PYTHONPATH: in CI sys.executable
# is the engine's embedded interpreter, which runs in isolated mode and
# ignores PYTHONPATH entirely — an env-var path never reaches it.
CLI_ENTRY = (
    f'import sys; sys.path[:0] = [{str(SRC_DIR)!r}, {str(COMMON_SRC_DIR)!r}]; '
    'from rocketride.cli.main import main; main()'
)

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


async def run_cli(*args: str, cwd: Optional[str] = None, pipeline: Optional[str] = None) -> Tuple[int, str]:
    """
    Run the CLI as a separate process and collect its output.

    Args:
        *args: Command line arguments, without the program name
        cwd: Working directory for the process
        pipeline: Pipeline file, delivered via the ROCKETRIDE_PIPELINE env
            default rather than --pipeline. When sys.executable is the
            engine's embedded interpreter (how CI runs this suite), the
            wrapper parses argv before Python does and consumes --pipeline
            (and --args) as its own options, leaving the value behind as a
            stray positional. Both spellings feed the same argparse dest.

    Returns:
        Tuple of (exit code, combined stdout and stderr)
    """
    env = dict(os.environ)

    # These tests are about what the commands do, not about what the console
    # can render; console encoding is covered by test_cli_console_encoding.py
    env['PYTHONIOENCODING'] = 'utf-8'

    for name in CLI_ENV_VARS:
        env.pop(name, None)
    if pipeline is not None:
        env['ROCKETRIDE_PIPELINE'] = pipeline

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
            code, output = await run_cli('start', '--token', self.PIPELINE_TOKEN, *server_args(), pipeline=pipeline)

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
            code, output = await run_cli('start', '--token', self.PIPELINE_TOKEN, *server_args(), pipeline=pipeline)

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
            code, output = await run_cli('start', '--token', self.PIPELINE_TOKEN, *server_args(), pipeline=missing)

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

            # The unified CLI's --json payload is an envelope object, not a
            # bare array: list emits {'tasks': [...]} (see run_list's
            # out.result call).
            tasks = json.loads(output)['tasks']
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

            code, output = await run_cli('upload', *files, *server_args(), pipeline=pipeline)

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
        assert '--pipeline or --token' in output

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


class TestCliProfile:
    """Test the profile commands against a live server.

    Every session is on a task of the test's own. One on the server process
    would profile everything else using this shared server, and leave data
    behind that test_cprofile_client.py expects to be absent.
    """

    PIPELINE_TOKEN = 'PY-CLI-PROFILE'
    PROJECT_ID = '5e1c2a90-7b3d-4f68-9a21-c4d8e6f03b17'
    TOKEN_ARGS = ('--token', PIPELINE_TOKEN)

    @pytest.mark.asyncio
    async def test_should_profile_a_task_across_separate_invocations(self):
        """A task's session belongs to the server's link to it, so it outlives each CLI process."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            code, output = await run_cli('profile', 'start', *self.TOKEN_ARGS, '--session', 'py-cli', *server_args())
            assert code == 0, output
            assert f"Profiling started: session 'py-cli' on task {self.PIPELINE_TOKEN}" in output

            code, output = await run_cli('profile', 'status', *self.TOKEN_ARGS, *server_args())
            assert code == 0, output
            assert f"Profiling active on task {self.PIPELINE_TOKEN}: session 'py-cli'" in output

            code, output = await run_cli('profile', 'stop', *self.TOKEN_ARGS, *server_args())
            assert code == 0, output
            assert "Profiling stopped: session 'py-cli'" in output

            code, output = await run_cli('profile', 'report', *self.TOKEN_ARGS, *server_args())
            assert code == 0, output
            assert output.startswith('Session: py-cli'), output[:200]
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_list_threads_and_draw_one_threads_tree(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            # Data goes through so engine worker threads run while profiled
            assert (await client.cprofile_start(target=self.PIPELINE_TOKEN)).get('status') == 'started'
            await client.send(self.PIPELINE_TOKEN, 'profile me', {}, 'text/plain')
            assert (await client.cprofile_stop(target=self.PIPELINE_TOKEN)).get('status') == 'completed'

            code, output = await run_cli('profile', 'threads', *self.TOKEN_ARGS, '--json', *server_args())
            assert code == 0, output
            threads = json.loads(output)['threads']
            busiest = threads[0]

            code, output = await run_cli('profile', 'threads', *self.TOKEN_ARGS, *server_args())
            assert code == 0, output
            assert output.splitlines()[0].split() == ['ID', 'NAME', 'TID', 'TIME', 'SHARE']
            assert f'{len(threads)} thread(s)' in output

            thread = ('--thread', str(busiest['id']), '--min-pct', '0')
            code, output = await run_cli('profile', 'tree', *self.TOKEN_ARGS, *thread, '--json', *server_args())
            assert code == 0, output
            # Only that thread's calls, so the total is the one listed for it
            assert json.loads(output)['total_calls'] == busiest['calls']

            code, output = await run_cli('profile', 'tree', *self.TOKEN_ARGS, *thread, *server_args())
            assert code == 0, output
            assert output.startswith(f'Call tree, thread {busiest["id"]}:'), output[:200]
            assert 'FUNCTION' in output

            missing = str(max(t['id'] for t in threads) + 1000)
            code, output = await run_cli('profile', 'tree', *self.TOKEN_ARGS, '--thread', missing, *server_args())
            assert code == 1
            assert f'Thread {missing} not found in the last session' in output
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_run_a_timed_session_to_completion(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            code, output = await run_cli('profile', 'run', *self.TOKEN_ARGS, '--duration', '1', *server_args())
            assert code == 0, output
            assert 'Profiling stopped: session' in output

            # The session it stopped left data behind to read
            status = await client.cprofile_status(target=self.PIPELINE_TOKEN)
            assert status.get('active') is False and status.get('has_report') is True, status
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_list_which_tasks_are_being_profiled(self):
        other = 'PY-CLI-LIST-OTHER'
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            for token in (self.PIPELINE_TOKEN, other):
                await ensure_clean_pipeline(client, token)
            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)
            await client.use(pipeline=get_echo_pipeline('8a3f1c52-6d7e-4b90-9c1a-2e4d6f8b0a13'), token=other)
            assert (await client.cprofile_start(target=self.PIPELINE_TOKEN)).get('status') == 'started'

            code, output = await run_cli('profile', 'list', '--json', *server_args())
            assert code == 0, output
            processes = {process['token']: process for process in json.loads(output)['processes']}
            # The server process, listed under a null token
            assert None in processes, processes
            assert processes[self.PIPELINE_TOKEN]['status']['active'] is True, processes
            assert processes[other]['status']['active'] is False, processes

            code, output = await run_cli('profile', 'list', '--active', *server_args())
            assert code == 0, output
            assert self.PIPELINE_TOKEN in output
            assert other not in output
        finally:
            for token in (self.PIPELINE_TOKEN, other):
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_fail_when_the_task_has_no_session_yet(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            await client.use(pipeline=get_echo_pipeline(self.PROJECT_ID), token=self.PIPELINE_TOKEN)

            code, output = await run_cli('profile', 'tree', *self.TOKEN_ARGS, *server_args())

            assert code == 1
            assert 'No profiling data available' in output
        finally:
            await ensure_clean_pipeline(client, self.PIPELINE_TOKEN)
            if client.is_connected():
                await client.disconnect()


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
        # Bare `store`, no connection args: the unified CLI attaches
        # --uri/--apikey to each store SUBcommand, so passing them to the
        # bare group is an argparse error (exit 2) that would mask the
        # missing-subcommand path this test is about.
        code, output = await run_cli('store')

        assert code == 1
        assert 'Store subcommand is required' in output

    @pytest.mark.asyncio
    async def test_should_require_a_profile_subcommand(self):
        code, output = await run_cli('profile')

        assert code == 1
        assert 'Profile subcommand is required' in output
