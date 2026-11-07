"""A real eaas.py runs a pipeline whose Python node crashes its task process.

The node is written into a temporary --node_path workspace. The server passes
that path, and its own --dumps, on to the task process it starts, so the node
never enters dist.
"""

import asyncio
import contextlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from ai.constants import CONST_TASK_DATA_PATH
from rocketride import TASK_STATE, RocketRideClient

_SERVER_DIR = Path(sys.executable).resolve().parent
_APIKEY = 'MYAPIKEY'

pytestmark = pytest.mark.skipif(
    not (_SERVER_DIR / 'ai' / 'eaas.py').is_file(), reason='needs the built server next to the engine'
)

_SERVICES = {
    'title': 'Crash Probe',
    'protocol': 'crash_probe://',
    'classType': ['text'],
    'capabilities': [],
    'register': 'filter',
    'node': 'python',
    'path': 'local_nodes.crash_probe',
    'prefix': 'crash_probe',
    'description': ['Ends its task process the way the text asks.'],
    'documentation': 'https://docs.rocketride.org',
    'lanes': {'text': ['text']},
    'preconfig': {'default': 'default', 'profiles': {'default': {}}},
    'fields': {},
    'shape': [],
}

_IGLOBAL = """from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    pass
"""

# A plain read of address 0: ctypes.string_at(0) would only raise OSError on
# Windows, where ctypes guards its foreign calls. A fast fail and SIGKILL skip
# every handler in the process; exit(-1) is no crash.
_IINSTANCE = """import ctypes
import os
import signal

from rocketlib import IInstanceBase


class IInstance(IInstanceBase):
    def writeText(self, text: str):
        if text == 'segv':
            ctypes.c_int.from_address(0).value
        elif text == 'failfast':
            ctypes.windll.kernel32.RaiseFailFastException(None, None, 0)
        elif text == 'sigkill':
            os.kill(os.getpid(), signal.SIGKILL)
        elif text == 'exit':
            os._exit(-1)
"""

_PIPELINE = {
    'components': [
        {
            'id': 'webhook_1',
            'provider': 'webhook',
            'name': 'Webhook',
            'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'},
        },
        {
            'id': 'crash_probe_1',
            'provider': 'crash_probe',
            'config': {},
            'input': [{'lane': 'text', 'from': 'webhook_1'}],
        },
    ],
    'source': 'webhook_1',
    'project_id': '6f1c2b9e-3d4a-4c8e-9b7f-2a5d8e1f0c43',
}


def _write_node(workspace: Path) -> None:
    node = workspace / 'local_nodes' / 'crash_probe'
    node.mkdir(parents=True)
    (workspace / 'local_nodes' / '__init__.py').write_text('')
    (node / '__init__.py').write_text('from .IGlobal import IGlobal\nfrom .IInstance import IInstance\n')
    (node / 'services.json').write_text(json.dumps(_SERVICES))
    (node / 'IGlobal.py').write_text(_IGLOBAL)
    (node / 'IInstance.py').write_text(_IINSTANCE)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _no_core_file() -> None:
    """Keep a crashing task from leaving a core file in dist/server."""
    import resource

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


@pytest.fixture(scope='module', params=[False, True], ids=['no-dumps', 'dumps'])
def server(request, tmp_path_factory):
    """A real server with the crash node, without and with --dumps."""
    dumps = request.param
    workspace = tmp_path_factory.mktemp('crash-node')
    _write_node(workspace)

    port = _free_port()
    # Task ports too, apart from those of the builder's test servers, which start at 20000
    args = [sys.executable, 'ai/eaas.py', f'--port={port}', f'--base_port={_free_port()}', f'--node_path={workspace}']
    if dumps:
        args.append('--dumps')

    # Its own crash database, so no other engine's dump reaches the test task
    env = dict(os.environ, ROCKETRIDE_APIKEY=_APIKEY, ROCKETRIDE_CRASHDB_DIR=str(workspace / 'crashdb'))
    log = open(workspace / 'server.log', 'wb')
    proc = subprocess.Popen(
        args,
        cwd=_SERVER_DIR,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        preexec_fn=None if os.name == 'nt' else _no_core_file,
    )
    try:
        yield {'uri': f'http://127.0.0.1:{port}', 'dumps': dumps, 'log': workspace / 'server.log'}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        log.close()


async def _connect(uri: str, on_event) -> RocketRideClient:
    deadline = time.monotonic() + 120
    while True:
        client = RocketRideClient(auth=_APIKEY, uri=uri, on_event=on_event)
        try:
            await client.connect()
            return client
        except Exception:
            if time.monotonic() > deadline:
                raise
            await asyncio.sleep(1)


async def _run(uri: str, text: str):
    """Send the text to the crash node; return the final status and the console lines."""
    lines = []

    async def on_event(message):
        if message.get('event') == 'output':
            lines.append(message.get('body', {}).get('output', ''))

    client = await _connect(uri, on_event)
    try:
        token = (await client.use(pipeline=_PIPELINE))['token']
        await client.add_monitor({'token': token}, ['output'])

        # The task dies while it handles the text, so the send itself may fail
        with contextlib.suppress(Exception):
            await asyncio.wait_for(client.send(token, text, {}, 'text/plain'), 60)

        ended = [TASK_STATE.COMPLETED.value, TASK_STATE.CANCELLED.value]
        deadline = time.monotonic() + 120
        while (status := await client.get_task_status(token))['state'] not in ended:
            assert time.monotonic() < deadline, f'the task did not end: {status}'
            await asyncio.sleep(0.5)
        return token, status, lines
    finally:
        await client.disconnect()


def _dumps_of(token: str):
    return [p for p in Path(CONST_TASK_DATA_PATH).rglob('*') if token in p.name and p.suffix in ('.dmp', '.mdmp')]


def _crash_lines(lines):
    return [line.rstrip() for line in lines if line.startswith('Crash: ')]


@pytest.mark.asyncio
async def test_a_node_that_crashes_stops_its_task_unexpectedly(server):
    token, status, lines = await _run(server['uri'], 'segv')
    dumps = _dumps_of(token)
    try:
        assert status['status'] == 'Stopped unexpectedly', server['log'].read_text(errors='replace')
        assert status['exitMessage'] == 'Stopped unexpectedly'

        crash = _crash_lines(lines)
        assert len(crash) == 1, lines
        expected = 'SEH exception 0xc0000005' if os.name == 'nt' else 'SIGSEGV: Invalid access to storage'
        assert crash[0].startswith(f'Crash: {expected} (code ')
        if server['dumps']:
            assert len(dumps) == 1
            assert crash[0].endswith(f'dump {dumps[0].name}')
        else:
            assert dumps == []
            assert crash[0].endswith('no dump')
    finally:
        for dump in dumps:
            dump.unlink()


@pytest.mark.asyncio
async def test_a_crash_past_the_handlers_stops_its_task_unexpectedly(server):
    """The engine reports nothing; only the exit code tells the server."""
    text, crash = (
        ('failfast', 'STATUS_FAIL_FAST_EXCEPTION (code 0xc0000602)')
        if os.name == 'nt'
        else ('sigkill', 'SIGKILL (code 9)')
    )
    token, status, lines = await _run(server['uri'], text)
    assert status['status'] == 'Stopped unexpectedly', server['log'].read_text(errors='replace')
    assert _crash_lines(lines) == [f'Crash: {crash}, no dump']
    assert _dumps_of(token) == []


@pytest.mark.asyncio
async def test_a_node_that_exits_stops_its_task(server):
    """exit(-1) is no crash, although on Windows its code 0xffffffff looks like an exception's."""
    token, status, lines = await _run(server['uri'], 'exit')
    assert status['status'] == 'Stopped', server['log'].read_text(errors='replace')
    assert _crash_lines(lines) == []
    assert _dumps_of(token) == []
