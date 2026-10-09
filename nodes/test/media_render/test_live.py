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
import contextlib
import json
import time
import uuid

import pytest

from .test_streams import NODE, media as media_fixture

media = media_fixture

# Profiles share the engine dependency environment; keep their live cold starts
# on one worker under the builder's --dist=loadgroup setting.
pytestmark = [
    pytest.mark.requires_server,
    pytest.mark.integration,
    pytest.mark.timeout(600),
    pytest.mark.xdist_group('media_render_live'),
]


def pipeline(request, output, profile='default'):
    """Build a real streaming pipeline with stock persistence sinks."""
    lanes = ['image', 'audio', 'video']
    components = [
        {'id': 'source', 'provider': 'webhook', 'config': {'mode': 'Source', 'type': 'webhook'}},
        {'id': 'parse', 'provider': 'parse', 'config': {}, 'input': [{'from': 'source', 'lane': 'tags'}]},
        {
            'id': 'media',
            'provider': NODE,
            'config': {'profile': profile, profile: {'request': json.dumps(request)}},
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
    return [
        {
            'mode': 'render',
            'spec': {
                'kind': 'media_render_spec',
                'keep': [[0, 1500]],
                'audio': {'master': False},
                'thumbnail': False,
                'outputs': [{'key': 'wide', 'file': 'render.mp4', 'aspect': '16:9', 'width': 320, 'height': 180}],
                'subtitles': {'enabled': False, 'sidecars': False},
            },
        }
    ]


@pytest.mark.parametrize('profile', ['default', 'export'])
async def test_streamed_operations_through_engine(client, media, record_property, profile):
    """Verify streamed operations through engine."""
    root = 'media-stream-test-' + uuid.uuid4().hex
    try:
        for request in requests():
            document = pipeline(request, root + '/' + request['mode'], profile)
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
                result = await asyncio.wait_for(pipe.close(), 180)
                record_property(request['mode'] + '_seconds', time.perf_counter() - started)
                assert len(result.get('answers', [])) == 1, result
                answer = result['answers'][0]
                assert not answer.get('error'), answer
                entries = (await client.fs_list_dir(root + '/' + request['mode'] + '/video'))['entries']
                assert any(entry['type'] == 'file' and entry['size'] > 0 for entry in entries)
            finally:
                await client.terminate(token)
    finally:
        # Each run writes under its own root; remove it so the engine store does
        # not keep one directory per run. The root never exists when validation
        # failed before any object was streamed, and the store reports that as
        # an error rather than a no-op.
        with contextlib.suppress(RuntimeError):
            await client.fs_rmdir(root, recursive=True)
