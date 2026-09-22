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

"""Exercise streamed media through a live engine and stock persistence nodes."""

import asyncio
from collections import deque
import json
import time
import uuid

import pytest
import pytest_asyncio

from .test_streams import NODE, media as media_fixture

media = media_fixture

pytestmark = [pytest.mark.requires_server, pytest.mark.integration, pytest.mark.timeout(600)]


@pytest_asyncio.fixture
async def observed_client(server_available, test_config):  # noqa: ARG001
    """Retain bounded worker diagnostics so native exits do not look like slow inference."""
    from rocketride import RocketRideClient

    events = deque(maxlen=30)
    ended = asyncio.Event()

    async def on_event(event):
        body = event.get('body', {})
        fields = ('state', 'status', 'exitCode', 'exitMessage', 'errors', 'final', 'action', 'reason', 'output')
        detail = {key: body[key] for key in fields if key in body}
        if detail:
            events.append({'event': event.get('event'), **detail})
        if (
            body.get('final')
            or event.get('event') == 'exited'
            or (event.get('event') == 'apaevt_task' and body.get('action') == 'end')
        ):
            ended.set()

    client = RocketRideClient(uri=test_config.uri, auth=test_config.auth, on_event=on_event)
    await client.connect()
    try:
        yield client, events, ended
    finally:
        await asyncio.wait_for(client.disconnect(), 10)


async def close_with_diagnostics(pipe, ended, events, timeout):
    """Fail promptly with the captured exit event if a native worker disappears."""
    closing = asyncio.create_task(pipe.close())
    stopped = asyncio.create_task(ended.wait())
    try:
        completed, _ = await asyncio.wait((closing, stopped), timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if closing not in completed:
            pytest.fail(f'Pipeline stopped or exceeded {timeout}s; worker diagnostics: {list(events)}')
        return await closing
    finally:
        for task in (closing, stopped):
            if not task.done():
                task.cancel()
        await asyncio.gather(closing, stopped, return_exceptions=True)


def pipeline(request, output):
    """Build a real streaming pipeline with stock persistence sinks."""
    lanes = {'media_inspect': ['image'], 'media_speech': ['audio'], 'media_render': ['image', 'audio', 'video']}[NODE]
    components = [
        {'id': 'source', 'provider': 'webhook', 'config': {'mode': 'Source', 'type': 'webhook'}},
        {'id': 'parse', 'provider': 'parse', 'config': {}, 'input': [{'from': 'source', 'lane': 'tags'}]},
        {
            'id': 'media',
            'provider': NODE,
            'config': {'profile': 'default', 'default': {'request': json.dumps(request)}},
            'input': [{'from': 'parse', 'lane': 'video'}],
        },
        {
            'id': 'answer',
            'provider': 'response_answers',
            'config': {'laneName': 'answers'},
            'input': [{'from': 'media', 'lane': 'answers'}],
        },
    ]
    for lane in lanes:
        components.append(
            {
                'id': 'save_' + lane,
                'provider': 'filestore',
                'config': {'profile': 'default', 'default': {'targetDir': output + '/' + lane, 'onConflict': 'unique'}},
                'input': [{'from': 'media', 'lane': lane}],
            }
        )
    return {'version': 1, 'project_id': str(uuid.uuid4()), 'components': components}


def requests():
    """Return bounded operation requests for this node."""
    if NODE == 'media_inspect':
        return [
            {'mode': 'probe'},
            {'mode': 'levels', 'scan_scenes': 'no'},
            {'mode': 'stills', 'stills': [{'id': 'poster', 't_ms': 500, 'width': 160}]},
        ]
    if NODE == 'media_speech':
        return [{'mode': 'pieces'}, {'mode': 'words', 'model': 'tiny', 'range': '0-1000'}]
    return [
        {
            'mode': 'render',
            'spec': {
                'kind': 'media_render_spec',
                'keep': [[0, 1500]],
                'audio': {'master': False},
                'thumbnail': False,
                'subtitles': {'enabled': False, 'sidecars': False},
            },
        }
    ]


@pytest.mark.parametrize('operation', requests(), ids=lambda value: value['mode'])
async def test_streamed_operations_through_engine(observed_client, media, record_property, operation):
    """Verify streamed operations through engine."""
    client, events, ended = observed_client
    root = 'media-stream-test-' + uuid.uuid4().hex
    request = operation
    document = pipeline(request, root + '/' + request['mode'])
    validation = await client.validate(document)
    assert not validation.get('errors'), validation.get('errors')
    token = (await client.use(pipeline=document, source='source', threads=1))['token']
    try:
        await client.add_monitor({'token': token}, ['summary', 'task', 'debugger'])
        started = time.perf_counter()
        pipe = await client.pipe(
            token, objinfo={'name': media.name, 'size': media.stat().st_size}, mime_type='video/mp4'
        )
        await pipe.open()
        with media.open('rb') as stream:
            while chunk := stream.read(65536):
                await pipe.write(chunk)
        # A fresh CI runner also downloads the Whisper model and initializes
        # its native runtime. Record that cold-start cost separately per mode;
        # do not treat this timeout as a steady-state performance target.
        timeout = 420 if request['mode'] == 'words' else 180
        result = await close_with_diagnostics(pipe, ended, events, timeout)
        record_property(request['mode'] + '_seconds', time.perf_counter() - started)
        assert len(result.get('answers', [])) == 1, result
        answer = result['answers'][0]
        assert not answer.get('error'), answer
        if request['mode'] == 'probe':
            assert answer['width'] == 320 and answer['height'] == 180
        if request['mode'] in ('stills', 'pieces', 'render'):
            lane = {'stills': 'image', 'pieces': 'audio', 'render': 'video'}[request['mode']]
            entries = (await client.fs_list_dir(root + '/' + request['mode'] + '/' + lane))['entries']
            assert any(entry['type'] == 'file' and entry['size'] > 0 for entry in entries)
    finally:
        try:
            await client.terminate(token)
        except RuntimeError as exc:
            if 'not running' not in str(exc):
                raise
    # Preserve test outputs for inspection; each run uses a unique directory.
