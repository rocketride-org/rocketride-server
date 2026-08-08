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
Tests for the send_files() concurrency limit.

No server needed: client.pipe is replaced with a fake that records how many
pipes are open at the same time.
"""

import asyncio

import pytest

from rocketride import RocketRideClient


def make_files(tmp_path, count):
    """Create `count` small files and return their paths."""
    paths = []
    for index in range(count):
        path = tmp_path / f'file-{index}.txt'
        path.write_text(f'contents of file {index}')
        paths.append(str(path))
    return paths


def fake_pipes(client, fail_open=None, fail_write=None):
    """Point client.pipe at fakes and return the stats they record."""
    stats = {'opened': 0, 'active': 0, 'peak': 0}

    class FakePipe:
        """Mimics DataPipe's open/close bookkeeping, including the double-close guard."""

        def __init__(self, name):
            self.name = name
            self.pipe_id = stats['opened']
            self._opened = False
            self._closed = False

        @property
        def is_opened(self):
            return self._opened

        async def open(self):
            if self.name == fail_open:
                raise RuntimeError('pipe rejected')
            self._opened = True
            stats['active'] += 1
            stats['peak'] = max(stats['peak'], stats['active'])

        async def write(self, buffer):
            # Yield, so overlapping uploads are observable
            await asyncio.sleep(0)
            if self.name == fail_write:
                raise RuntimeError('write rejected')

        async def close(self):
            if not self._opened or self._closed:
                return {}
            self._closed = True
            await asyncio.sleep(0.01)
            stats['active'] -= 1
            return {}

    async def pipe(token, objinfo=None, mime_type=None, provider=None, on_sse=None):
        stats['opened'] += 1
        return FakePipe((objinfo or {}).get('name'))

    client.pipe = pipe
    return stats


@pytest.fixture
def client():
    """A client that never connects - send_files only needs the API key."""
    return RocketRideClient(uri='http://localhost:5565', auth='test-key', env={})


async def test_honors_max_concurrent(client, tmp_path):
    """No more than max_concurrent pipes are open at once, and every file uploads."""
    stats = fake_pipes(client)
    files = make_files(tmp_path, 8)

    results = await client.send_files(files, 'task-token', 2)

    assert stats['peak'] == 2
    assert stats['opened'] == 8
    assert [r['action'] for r in results] == ['complete'] * 8


async def test_default_limit(client, tmp_path):
    """Callers that pass no limit get the documented default of 5."""
    stats = fake_pipes(client)

    await client.send_files(make_files(tmp_path, 12), 'task-token')

    assert stats['peak'] == 5


async def test_failed_file_does_not_stop_batch(client, tmp_path):
    """One bad file fails on its own and results stay in input order."""
    fake_pipes(client, fail_open='file-1.txt')
    files = make_files(tmp_path, 4)

    results = await client.send_files(files, 'task-token', 2)

    assert [r['filepath'] for r in results] == files
    assert [r['action'] for r in results] == ['complete', 'error', 'complete', 'complete']
    assert 'pipe rejected' in results[1]['error']


async def test_failed_write_releases_its_pipe(client, tmp_path):
    """A file that fails mid-transfer closes its pipe instead of holding a slot."""
    stats = fake_pipes(client, fail_write='file-1.txt')
    files = make_files(tmp_path, 4)

    results = await client.send_files(files, 'task-token', 2)

    assert stats['active'] == 0
    assert results[1]['action'] == 'error'
    assert [r['action'] for r in results] == ['complete', 'error', 'complete', 'complete']


@pytest.mark.parametrize('max_concurrent', [0, -1, 2.5, True, 'five'])
async def test_rejects_invalid_max_concurrent(client, tmp_path, max_concurrent):
    """A bad limit raises before anything is uploaded."""
    stats = fake_pipes(client)

    with pytest.raises(ValueError, match='max_concurrent must be a positive integer'):
        await client.send_files(make_files(tmp_path, 3), 'task-token', max_concurrent)

    assert stats['opened'] == 0
