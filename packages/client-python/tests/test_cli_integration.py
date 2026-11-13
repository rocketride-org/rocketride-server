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
import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

import pytest

# Load .env from project root before any imports that need env vars
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
load_dotenv(PROJECT_ROOT / '.env')

from rocketride import RocketRideClient

from echo_pipeline import get_echo_pipeline


# Test configuration
TEST_CONFIG = {
    'uri': os.getenv('ROCKETRIDE_URI', 'http://127.0.0.1:5565'),
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

# Under the engine's embedded interpreter (how CI runs this suite) the engine
# writes its own log to stdout, status lines included: "Waiting for another
# installation to complete..." while another engine holds install.lock. The
# CLI's stdout is the command's output, so the engine log goes to a file.
UNDER_ENGINE = Path(sys.executable).stem.lower() == 'engine'


async def ensure_clean_pipeline(client: RocketRideClient, token: str) -> None:
    """Clean up pipeline if it exists, ignoring errors."""
    try:
        await client.terminate(token)
    except Exception:
        # Ignore errors - pipeline might not be running
        pass


def private_token(base: str) -> str:
    """
    Return a unique token so a run gets an address of its own.

    use(token=X) and start --token X override the pipeline-id segment of the
    task address, so a unique X keeps the run apart from every other test,
    worker and client on the same server.

    Args:
        base: Readable prefix naming the test family.

    Returns:
        The token: the prefix plus eight random hex characters.
    """
    return f'{base}-{uuid4().hex[:8]}'


async def run_cli_streams(
    *args: str, cwd: Optional[str] = None, pipeline: Optional[str] = None
) -> Tuple[int, str, str]:
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
        Tuple of (exit code, stdout, stderr). Under the engine, a failing or
        timed-out command prints the engine log to stderr (see UNDER_ENGINE).
    """
    env = dict(os.environ)

    # These tests are about what the commands do, not about what the console
    # can render; console encoding is covered by test_cli_console_encoding.py
    env['PYTHONIOENCODING'] = 'utf-8'

    for name in CLI_ENV_VARS:
        env.pop(name, None)
    if pipeline is not None:
        env['ROCKETRIDE_PIPELINE'] = pipeline

    engine_log = None
    engine_args: List[str] = []
    if UNDER_ENGINE:
        fd, engine_log = tempfile.mkstemp(prefix='rr-cli-engine-', suffix='.log')
        os.close(fd)
        engine_args = [f'--log.file={engine_log}']

    failed = True
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            *engine_args,
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

        out = stdout.decode('utf-8', errors='replace')
        err = stderr.decode('utf-8', errors='replace')
        failed = process.returncode != 0
        return process.returncode, out, err
    finally:
        if engine_log:
            with contextlib.suppress(OSError):
                if failed:
                    log_text = Path(engine_log).read_text(encoding='utf-8', errors='replace')
                    if log_text:
                        print(f'--- engine log ---\n{log_text}', file=sys.stderr)
                os.unlink(engine_log)


async def run_cli(*args: str, cwd: Optional[str] = None, pipeline: Optional[str] = None) -> Tuple[int, str]:
    """
    Run the CLI (see run_cli_streams).

    Returns:
        Tuple of (exit code, combined stdout and stderr)
    """
    code, stdout, stderr = await run_cli_streams(*args, cwd=cwd, pipeline=pipeline)
    return code, stdout + stderr


async def run_cli_json(*args: str) -> Dict[str, Any]:
    """
    Run a --json command that must succeed, and return the document it printed.

    The document is all of stdout: anything else there breaks --json consumers,
    so it fails the test rather than being skipped.
    """
    code, stdout, stderr = await run_cli_streams(*args)
    assert code == 0, stdout + stderr
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as e:
        pytest.fail(f'stdout is not a JSON document ({e}):\n{stdout}\n--- stderr ---\n{stderr}')


def server_args() -> List[str]:
    """Connection arguments every CLI command needs."""
    return ['--uri', TEST_CONFIG['uri'], '--apikey', TEST_CONFIG['auth']]


def write_pipeline(tmp_path) -> str:
    """Write the echo pipeline to a file the CLI can load."""
    path = tmp_path / 'echo.pipe'
    path.write_text(json.dumps(get_echo_pipeline()), encoding='utf-8')
    return str(path)


def started_token(output: str) -> str:
    """
    The task address a start or managed upload command printed.

    The token only overrides the pipeline-id segment; the server adds the
    developer id and the source, so the test reads the full address back.

    Args:
        output: Combined output of a successful command

    Returns:
        The address from the "Token:" line
    """
    for line in output.splitlines():
        if line.startswith('Token: '):
            return line[len('Token: ') :].strip()
    pytest.fail(f'start printed no token:\n{output}')


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

    TOKEN_BASE = 'py-cli-start'

    @pytest.mark.asyncio
    async def test_should_start_a_pipeline_the_server_reports(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()

            pipeline = write_pipeline(tmp_path)
            code, output = await run_cli(
                'start', '--token', private_token(self.TOKEN_BASE), *server_args(), pipeline=pipeline
            )

            assert code == 0, output
            token = started_token(output)

            # The task the CLI started is a task the server knows about
            status = await client.get_task_status(token)
            assert 'state' in status
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_report_the_token_for_monitoring(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()

            pipeline = write_pipeline(tmp_path)
            code, output = await run_cli(
                'start', '--token', private_token(self.TOKEN_BASE), *server_args(), pipeline=pipeline
            )

            assert code == 0, output
            token = started_token(output)

            # The follow-up command it prints has to be one the user can run
            assert f'rocketride stop --token {token}' in output
            assert token in await list_task_tokens(client)
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
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

            # A private token names the only address this invocation could
            # have started, so other clients' tasks cannot affect the check
            token = private_token(self.TOKEN_BASE)
            missing = str(tmp_path / 'no-such.pipe')
            code, output = await run_cli('start', '--token', token, *server_args(), pipeline=missing)

            assert code == 1, output

            # A pipeline that never loaded must not leave a task behind
            assert [address for address in await list_task_tokens(client) if address.split('.')[1:2] == [token]] == []
        finally:
            if client.is_connected():
                await client.disconnect()


class TestCliStop:
    """Test the stop command against a live server."""

    TOKEN_BASE = 'py-cli-stop'

    @pytest.mark.asyncio
    async def test_should_stop_a_running_pipeline(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()

            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']
            assert token in await list_task_tokens(client)

            code, output = await run_cli('stop', '--token', token, *server_args())

            assert code == 0, output
            assert await wait_until_gone(client, token), 'task still reported after stop'
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_fail_without_a_token(self):
        code, output = await run_cli('stop', *server_args())

        assert code == 1
        assert 'Token is required' in output


class TestCliList:
    """Test the list command against a live server."""

    TOKEN_BASE = 'py-cli-list'

    @pytest.mark.asyncio
    async def test_should_list_a_running_task_as_json(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()

            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            # The unified CLI's --json payload is an envelope object, not a
            # bare array: list emits {'tasks': [...]} (see run_list's
            # out.result call).
            tasks = (await run_cli_json('list', '--json', *server_args()))['tasks']
            assert token in [task.get('token') for task in tasks]
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_list_a_running_task_in_human_form(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()

            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            code, output = await run_cli('list', *server_args())

            assert code == 0, output
            assert token in output
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()


class TestCliUpload:
    """Test the upload command against a live server."""

    TOKEN_BASE = 'py-cli-upload'

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
        token = None
        try:
            await client.connect()

            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            files = self.write_files(tmp_path)
            code, output = await run_cli('upload', *files, '--token', token, *server_args())

            assert code == 0, output
            assert 'Upload Error' not in output

            # A task the CLI did not create is a task it must leave running
            assert token in await list_task_tokens(client)
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_start_and_terminate_its_own_task(self, tmp_path):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()

            pipeline = write_pipeline(tmp_path)
            files = self.write_files(tmp_path)

            code, output = await run_cli('upload', *files, *server_args(), pipeline=pipeline)

            assert code == 0, output
            assert 'Upload Error' not in output

            # A task the CLI created is a task it has to clean up: the one
            # at the private address it printed
            token = started_token(output)
            assert await wait_until_gone(client, token), 'upload task still reported after exit'
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
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
        token = None
        try:
            await client.connect()

            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            missing = str(tmp_path / 'nothing-*.txt')
            code, output = await run_cli('upload', missing, '--token', token, *server_args())

            assert code == 1, output
            assert 'No files found' in output
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()


class TestCliProfile:
    """Test the profile commands against a live server.

    Every session is on a task of the test's own. One on the server process
    would profile everything else using this shared server, and leave data
    behind that test_cprofile_client.py expects to be absent.
    """

    TOKEN_BASE = 'py-cli-profile'

    @pytest.mark.asyncio
    async def test_should_profile_a_task_across_separate_invocations(self):
        """A task's session belongs to the server's link to it, so it outlives each CLI process."""
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            code, output = await run_cli('profile', 'start', '--token', token, '--session', 'py-cli', *server_args())
            assert code == 0, output
            assert f"Profiling started: session 'py-cli' on task {token}" in output

            code, output = await run_cli('profile', 'status', '--token', token, *server_args())
            assert code == 0, output
            assert f"Profiling active on task {token}: session 'py-cli'" in output

            code, output = await run_cli('profile', 'stop', '--token', token, *server_args())
            assert code == 0, output
            assert "Profiling stopped: session 'py-cli'" in output

            code, output = await run_cli('profile', 'report', '--token', token, *server_args())
            assert code == 0, output
            assert output.startswith('Session: py-cli'), output[:200]
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_list_threads_and_draw_one_threads_tree(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            # Data goes through so engine worker threads run while profiled
            assert (await client.cprofile_start(target=token)).get('status') == 'started'
            await client.send(token, 'profile me', {}, 'text/plain')
            assert (await client.cprofile_stop(target=token)).get('status') == 'completed'

            threads = (await run_cli_json('profile', 'threads', '--token', token, '--json', *server_args()))['threads']
            busiest = threads[0]

            code, output = await run_cli('profile', 'threads', '--token', token, *server_args())
            assert code == 0, output
            assert output.splitlines()[0].split() == ['ID', 'NAME', 'TID', 'TIME', 'SHARE']
            assert f'{len(threads)} thread(s)' in output

            thread = ('--thread', str(busiest['id']), '--min-pct', '0')
            tree = await run_cli_json('profile', 'tree', '--token', token, *thread, '--json', *server_args())
            # Only that thread's calls, so the total is the one listed for it
            assert tree['total_calls'] == busiest['calls']

            code, output = await run_cli('profile', 'tree', '--token', token, *thread, *server_args())
            assert code == 0, output
            assert output.startswith(f'Call tree, thread {busiest["id"]}:'), output[:200]
            assert 'FUNCTION' in output

            missing = str(max(t['id'] for t in threads) + 1000)
            code, output = await run_cli('profile', 'tree', '--token', token, '--thread', missing, *server_args())
            assert code == 1
            assert f'Thread {missing} not found in the last session' in output
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_run_a_timed_session_to_completion(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            code, output = await run_cli('profile', 'run', '--token', token, '--duration', '1', *server_args())
            assert code == 0, output
            assert 'Profiling stopped: session' in output
            # A task's session outlives this command, so it says how to end one left behind
            assert f'Killing this command leaves the session running: rocketride profile stop --token {token}' in output

            # The session it stopped left data behind to read
            status = await client.cprofile_status(target=token)
            assert status.get('active') is False and status.get('has_report') is True, status
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_list_which_tasks_are_being_profiled(self):
        token = None
        other = None
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        try:
            await client.connect()
            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']
            # Engines are content-addressed and the profiler is engine-level: a second run of the
            # IDENTICAL spec would share this run's engine and list as profiled too. The other run
            # wires a differently named response component, so it has an engine of its own.
            other_spec = get_echo_pipeline()
            other_spec['components'][1]['id'] = 'response_2'
            other = (await client.use(pipeline=other_spec, token=private_token(f'{self.TOKEN_BASE}-other')))['token']
            assert (await client.cprofile_start(target=token)).get('status') == 'started'

            listed = await run_cli_json('profile', 'list', '--json', *server_args())
            processes = {process['token']: process for process in listed['processes']}
            # The server process, listed under a null token
            assert None in processes, processes
            assert processes[token]['status']['active'] is True, processes
            assert processes[other]['status']['active'] is False, processes

            code, output = await run_cli('profile', 'list', '--active', *server_args())
            assert code == 0, output
            assert token in output
            assert other not in output
        finally:
            for address in (token, other):
                if address:
                    await ensure_clean_pipeline(client, address)
            if client.is_connected():
                await client.disconnect()

    @pytest.mark.asyncio
    async def test_should_fail_when_the_task_has_no_session_yet(self):
        client = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
        token = None
        try:
            await client.connect()
            token = (await client.use(pipeline=get_echo_pipeline(), token=private_token(self.TOKEN_BASE)))['token']

            code, output = await run_cli('profile', 'tree', '--token', token, *server_args())

            assert code == 1
            assert 'No profiling data available' in output
        finally:
            if token:
                await ensure_clean_pipeline(client, token)
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
