"""A real eaas.py runs a pipeline whose Python node crashes its task process.

Each server writes the node, under a name of its own, where the engine looks
for nodes, and removes it when it stops. The name starts with `_`, which the
node contract tests skip.
"""

import asyncio
import contextlib
import json
import os
import shutil
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
    'classType': ['text'],
    'capabilities': [],
    'register': 'filter',
    'node': 'python',
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


def _pipeline(provider: str) -> dict:
    return {
        'components': [
            {
                'id': 'webhook_1',
                'provider': 'webhook',
                'name': 'Webhook',
                'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'},
            },
            {
                'id': 'crash_probe_1',
                'provider': provider,
                'config': {},
                'input': [{'lane': 'text', 'from': 'webhook_1'}],
            },
        ],
        'source': 'webhook_1',
        'project_id': '6f1c2b9e-3d4a-4c8e-9b7f-2a5d8e1f0c43',
    }


def _nodes_dirs() -> list[Path]:
    """Where the engine reads a node's services.json (services.cpp) and where its Python imports the node (python/init.cpp).

    Both are the source tree's when the engine runs from <repo>/dist/server. When <repo> holds this repo as its
    rocketride-server submodule, services.cpp still reads dist/server/nodes, but Python imports the submodule's.
    """
    if _SERVER_DIR.parts[-2:] == ('dist', 'server'):
        repo = _SERVER_DIR.parents[1]
        source = repo / 'nodes' / 'src' / 'nodes'
        if source.is_dir():
            return [source]
        submodule = repo / 'rocketride-server' / 'nodes' / 'src' / 'nodes'
        if submodule.is_dir():
            return [_SERVER_DIR / 'nodes', submodule]
    return [_SERVER_DIR / 'nodes']


def _write_node(node: Path, provider: str) -> None:
    node.mkdir(exist_ok=True)  # only a killed run with the same PID leaves one
    services = dict(_SERVICES, protocol=f'{provider}://', prefix=provider, path=f'nodes._{provider}')
    (node / '__init__.py').write_text('from .IGlobal import IGlobal\nfrom .IInstance import IInstance\n')
    (node / 'services.json').write_text(json.dumps(services))
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
    # Its own name: xdist may run both servers at once, in two processes
    provider = f'crash_probe_{os.getpid()}_{int(dumps)}'
    nodes = [d / f'_{provider}' for d in _nodes_dirs()]
    try:
        for node in nodes:
            _write_node(node, provider)

        port = _free_port()
        # Task ports too, apart from those of the builder's test servers, which start at 20000
        args = [sys.executable, 'ai/eaas.py', f'--port={port}', f'--base_port={_free_port()}']
        if dumps:
            args.append('--dumps')

        # Its own crash database, so no other engine's dump reaches the test task
        env = dict(os.environ, ROCKETRIDE_APIKEY=_APIKEY, ROCKETRIDE_CRASHDB_DIR=str(workspace / 'crashdb'))
        with open(workspace / 'server.log', 'wb') as log:
            proc = subprocess.Popen(
                args,
                cwd=_SERVER_DIR,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                preexec_fn=None if os.name == 'nt' else _no_core_file,
            )
            try:
                yield {
                    'uri': f'http://127.0.0.1:{port}',
                    'provider': provider,
                    'dumps': dumps,
                    'log': workspace / 'server.log',
                }
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
    finally:
        for node in nodes:
            shutil.rmtree(node, ignore_errors=True)


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


async def _run(server, text: str):
    """Send the text to the crash node; return the final status and the console lines."""
    lines = []

    async def on_event(message):
        if message.get('event') == 'output':
            lines.append(message.get('body', {}).get('output', ''))

    client = await _connect(server['uri'], on_event)
    try:
        token = (await client.use(pipeline=_pipeline(server['provider'])))['token']
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
    return [line.rstrip() for line in lines if line.startswith('Unexpected termination: ')]


def _dump_lines(lines):
    return [line.rstrip() for line in lines if line.startswith('Crash dump: ')]


@pytest.mark.asyncio
async def test_a_node_that_crashes_stops_its_task_unexpectedly(server):
    token, status, lines = await _run(server, 'segv')
    dumps = _dumps_of(token)
    try:
        assert status['status'] == 'Stopped unexpectedly', server['log'].read_text(errors='replace')
        assert status['exitMessage'] == 'Stopped unexpectedly'

        expected = (
            'Application caught unhandled SEH exception: 0xc0000005'
            if os.name == 'nt'
            else 'Application received system signal: SIGSEGV: Invalid access to storage (11)'
        )
        assert _crash_lines(lines) == [f'Unexpected termination: {expected}'], lines
        if server['dumps']:
            assert len(dumps) == 1
            assert _dump_lines(lines) == [f'Crash dump: {dumps[0].name}'], lines
        else:
            assert dumps == []
            assert _dump_lines(lines) == [], lines
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
    token, status, lines = await _run(server, text)
    assert status['status'] == 'Stopped unexpectedly', server['log'].read_text(errors='replace')
    assert _crash_lines(lines) == [f'Unexpected termination: {crash}']
    assert _dump_lines(lines) == []
    assert _dumps_of(token) == []


@pytest.mark.asyncio
async def test_a_node_that_exits_stops_its_task(server):
    """exit(-1) is no crash, although on Windows its code 0xffffffff looks like an exception's."""
    token, status, lines = await _run(server, 'exit')
    assert status['status'] == 'Stopped', server['log'].read_text(errors='replace')
    assert _crash_lines(lines) == []
    assert _dumps_of(token) == []
