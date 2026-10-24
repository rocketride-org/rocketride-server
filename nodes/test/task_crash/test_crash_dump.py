# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
What a crashed task leaves on the engine's host, the same under spawn and docker.

A task whose process faults writes a minidump and dies. Under spawn the dump
lands in the engine's log directory. Under docker it lands inside the task's
container, which the engine then removes, so the launcher copies it out first,
into a directory per task. Either way the engine's host ends up holding a
minidump of that task, and under docker no container of it.

Under k8s the dump lands inside the task's pod and goes with it: the launcher
does not fetch it yet. What holds there already is checked — the task ends
with a failure and neither its Job nor its pod stays — and the dump is left to
the change that fetches it.

No node crashes on demand, so the mocked LLM does: a question carrying
`CRASH_PHRASE` faults the task that answers it (`mocks/langchain_openai`).

    webhook -> llm_openai_api (mocked) -> response_answers
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import shutil
import struct
import subprocess
import time
import uuid
from typing import Any, Dict, List
from urllib.parse import urlsplit

import pytest

# What the mocked LLM faults on (nodes/test/mocks/langchain_openai)
CRASH_PHRASE = 'rocketride-mock: crash this task'

# The runtime the test server runs tasks with (set by the builder)
_RUNTIME = os.environ.get('ROCKETRIDE_TEST_RUNTIME', 'spawn')
_DOCKER = _RUNTIME == 'docker'
_K8S = _RUNTIME == 'k8s'

# Why the dump is not looked for under k8s
_K8S_DUMP_NOT_FETCHED = (
    'under --runtime=k8s the minidump of a crashed task stays in its pod and goes with it; '
    'fetching it is the follow-up to that runtime (crash dumps under k8s, which needs pods/exec)'
)

# The dump is looked for on this host, so the server must run here
_SERVER_HOST = urlsplit(os.environ.get('ROCKETRIDE_URI', 'http://localhost')).hostname
pytestmark = pytest.mark.skipif(
    _SERVER_HOST not in ('localhost', '127.0.0.1', '::1'),
    reason='the test server runs on another host, and the dump stays there',
)

# Minidump stream types (MINIDUMP_STREAM_TYPE)
_THREAD_LIST = 3
_EXCEPTION = 6


def _pipeline() -> Dict[str, Any]:
    """
    A pipeline whose LLM is the mocked one.

    Returns:
        A pipeline dict ready for `client.use()`, with a fresh `project_id` so the run is a task of its own.
    """
    return {
        'project_id': str(uuid.uuid4()),
        'source': 'webhook_1',
        'components': [
            {'id': 'webhook_1', 'provider': 'webhook', 'config': {}, 'input': []},
            {
                'id': 'llm_1',
                'provider': 'llm_openai_api',
                'config': {
                    'profile': 'custom',
                    'custom': {'apikey': 'sk-mock-placeholder-for-tests', 'model': 'mock-model'},
                },
                'input': [{'lane': 'questions', 'from': 'webhook_1'}],
            },
            {
                'id': 'response_1',
                'provider': 'response_answers',
                'config': {},
                'input': [{'lane': 'answers', 'from': 'llm_1'}],
            },
        ],
    }


def _dumps(token: str) -> List[str]:
    """
    The minidumps of one task on the engine's host.

    Args:
        token: The task's token, which the engine puts into the dump's name.

    Returns:
        The paths found.
    """
    from ai.constants import CONST_TASK_DATA_PATH

    logs = os.path.join(CONST_TASK_DATA_PATH, 'logs')
    if _DOCKER:
        # Copied out of the container, into a directory per task
        return glob.glob(os.path.join(logs, '*', f'*{glob.escape(token)}*.dmp'))
    # .mdmp on Windows, .dmp from Crashpad elsewhere
    return glob.glob(os.path.join(logs, f'*{glob.escape(token)}*dmp'))


def _stream_types(path: str) -> List[int]:
    """
    The streams a minidump holds, from its header and stream directory.

    Args:
        path: The dump.

    Returns:
        The stream types, or nothing when the file is no minidump.
    """
    with open(path, 'rb') as f:
        signature, _version, count, directory = struct.unpack('<4sIII', f.read(16))
        if signature != b'MDMP':
            return []
        f.seek(directory)
        return [struct.unpack('<III', f.read(12))[0] for _ in range(count)]


def _containers(token: str) -> List[str]:
    """
    The containers of one task, running or not.

    Args:
        token: The task's token. The task id a container is labelled with starts as the token does.

    Returns:
        Their task labels.
    """
    listed = subprocess.run(
        ['docker', 'ps', '-a', '--filter', 'label=rocketride.task', '--format', '{{.Label "rocketride.task"}}'],
        capture_output=True,
        text=True,
        check=True,
    )
    start = token.split('_', 1)[-1][:8]
    return [label for label in listed.stdout.split() if label.startswith(start)]


def _jobs_and_pods(token: str) -> List[str]:
    """
    The Jobs and pods of one task that are still in the cluster.

    Args:
        token: The task's token. The task id they are labelled with starts as the token does.

    Returns:
        Their kinds and names.
    """
    scope = ['-n', os.environ.get('RR_K8S_NAMESPACE') or 'rocketride-tasks']
    if os.environ.get('RR_K8S_CONTEXT'):
        scope = ['--context', os.environ['RR_K8S_CONTEXT'], *scope]
    listed = subprocess.run(
        ['kubectl', *scope, 'get', 'jobs,pods', '-l', 'rocketride.task', '-o', 'json'],
        capture_output=True,
        text=True,
        check=True,
    )
    start = token.split('_', 1)[-1][:8]
    return [
        f'{item["kind"]}/{item["metadata"]["name"]}'
        for item in json.loads(listed.stdout)['items']
        if item['metadata']['labels']['rocketride.task'].startswith(start)
    ]


def _left_in_the_runtime(token: str) -> List[str]:
    """
    What the runtime still holds of one task: its containers, or its Job and pod.

    Args:
        token: The task's token.

    Returns:
        Their names; nothing under spawn, where the task is only a process.
    """
    if _DOCKER:
        return _containers(token)
    if _K8S:
        return _jobs_and_pods(token)
    return []


async def _ask(client, token: str, text: str) -> None:
    """
    Put one question through the pipeline.

    Args:
        client: Connected RocketRide client.
        token: The task's token.
        text: The question.
    """
    pipe = await client.pipe(token, objinfo={'name': 'crash'}, mime_type='lane/questions')
    await pipe.open()
    await pipe.write(json.dumps({'questions': [{'text': text}]}).encode('utf-8'))
    await pipe.close()


async def test_a_crashed_task_leaves_its_minidump_on_the_engines_host(client):
    """
    Crash a task and find its minidump where the runtime keeps it.

    Args:
        client: Connected RocketRide client (fixture).
    """
    token = (await client.use(pipeline=_pipeline()))['token']
    if _DOCKER or _K8S:
        assert _left_in_the_runtime(token), (
            'the task has no container or pod to be removed: the test would prove nothing'
        )

    dumps: List[str] = []
    status: Dict[str, Any] = {}
    # The task dies while it answers, so the question may get an error or no answer at all:
    # it is asked on the side, and the test watches what the crash leaves
    question = asyncio.ensure_future(_ask(client, token, f'{CRASH_PHRASE}, please'))
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status = await asyncio.wait_for(client.get_task_status(token), timeout=10)
            dumps = _dumps(token)
            # Under docker the dump is copied out just before the container is removed;
            # under k8s none comes, and the Job and its pod go
            if status.get('completed') and (dumps or _K8S) and not _left_in_the_runtime(token):
                break
            await asyncio.sleep(0.5)

        assert status.get('completed'), f'the task is still running: {status}'
        assert status.get('exitCode'), f'the task crashed, yet its status reports success: {status}'
        if _K8S:
            assert _jobs_and_pods(token) == [], 'the Job or the pod of the crashed task was not removed'
            pytest.skip(_K8S_DUMP_NOT_FETCHED)
        assert dumps, 'the crashed task left no minidump on the host of the engine'
        for dump in dumps:
            streams = _stream_types(dump)
            assert _EXCEPTION in streams and _THREAD_LIST in streams, (
                f'{dump} is not a minidump of a crash (streams {streams})'
            )
        if _DOCKER:
            assert _containers(token) == [], 'the container of the crashed task was not removed'
    finally:
        question.cancel()
        await asyncio.gather(question, return_exceptions=True)
        try:
            await asyncio.wait_for(client.terminate(token), timeout=10)
        except Exception:
            pass
        # The dumps were made on purpose: none is left behind
        for dump in dumps or _dumps(token):
            if _DOCKER:
                shutil.rmtree(os.path.dirname(dump), ignore_errors=True)
            elif os.path.exists(dump):
                os.remove(dump)
