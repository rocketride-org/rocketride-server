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
import json
import time
import uuid

import pytest

from .test_streams import NODE, media as media_fixture

media = media_fixture

pytestmark = [pytest.mark.requires_server, pytest.mark.integration, pytest.mark.timeout(600)]


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
async def test_streamed_operations_through_engine(client, media, record_property, operation):
    """Verify streamed operations through engine."""
    root = 'media-stream-test-' + uuid.uuid4().hex
    request = operation
    document = pipeline(request, root + '/' + request['mode'])
    validation = await client.validate(document)
    assert not validation.get('errors'), validation.get('errors')
    token = (await client.use(pipeline=document, source='source', threads=1))['token']
    try:
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
        try:
            result = await asyncio.wait_for(pipe.close(), timeout)
        except TimeoutError:
            status = await asyncio.wait_for(client.get_task_status(token), 10)
            pytest.fail(f'{request["mode"]} exceeded {timeout}s; task state: {status.get("state")}')
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
        await client.terminate(token)
    # Preserve test outputs for inspection; each run uses a unique directory.
