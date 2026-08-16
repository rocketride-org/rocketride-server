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
send_files() concurrency bound -- Python parity with #1381 / #1716 (issue #1841).

These run offline: the pipe is replaced with a recording double, so nothing here
needs a server, a token or an API key. Every test whose name starts with
`test_bounded` fails on the pre-#1841 tree, where send_files() built one coroutine
per file and handed the lot to asyncio.gather().
"""

import asyncio
import os
import inspect

import pytest

from rocketride.mixins.data import DataMixin


# =========================================================================
# TEST DOUBLES
# =========================================================================


class RecordingPipe:
    """A DataPipe stand-in that records how many pipes are open at once."""

    def __init__(self, ledger, latency=0.005, fail_on_open=False):
        self._ledger = ledger
        self._latency = latency
        self._fail_on_open = fail_on_open
        self._opened = False

    @property
    def pipe_id(self):
        return id(self)

    @property
    def is_opened(self):
        return self._opened

    async def open(self):
        if self._fail_on_open:
            raise RuntimeError('server refused the pipe')
        self._ledger['live'] += 1
        self._ledger['peak'] = max(self._ledger['peak'], self._ledger['live'])
        self._opened = True
        # A real open() is a server round trip. Yielding here is what lets other
        # uploads pile up, which is precisely the behaviour under test.
        await asyncio.sleep(self._latency)
        return self

    async def write(self, buffer):
        await asyncio.sleep(0)

    async def close(self):
        self._ledger['live'] -= 1
        self._opened = False
        return {'status': 'ok'}


class FakeClient(DataMixin):
    """DataMixin with the transport removed -- send_files() is the unit under test."""

    def __init__(self, fail_paths=(), latency=0.005):
        # Deliberately not calling super().__init__: DAPClient wants a transport.
        self._apikey = 'test-key'
        self._caller_on_event = None
        self.ledger = {'live': 0, 'peak': 0}
        self.events = []
        self._fail_paths = set(fail_paths)
        self._latency = latency
        self._pending_fail = False

    def debug_message(self, *args, **kwargs):
        pass

    async def pipe(self, token, objinfo=None, mime_type=None, provider=None, on_sse=None):
        fail = self._pending_fail
        self._pending_fail = False
        return RecordingPipe(self.ledger, latency=self._latency, fail_on_open=fail)


def write_files(tmp_path, count, size=16):
    paths = []
    for i in range(count):
        p = tmp_path / f'f{i:04d}.txt'
        p.write_bytes(b'x' * size)
        paths.append(str(p))
    return paths


class GatherSpy:
    """Records how many workers send_files() started and how each one ended."""

    def __init__(self):
        self.awaitable_count = 0
        self.outcomes = []

    @property
    def failures(self):
        return [o for o in self.outcomes if isinstance(o, BaseException)]


@pytest.fixture
def gather_spy(monkeypatch):
    spy = GatherSpy()
    real_gather = asyncio.gather

    async def spying_gather(*awaitables, **kwargs):
        spy.awaitable_count = len(awaitables)
        outcomes = await real_gather(*awaitables, **kwargs)
        spy.outcomes = list(outcomes)
        return outcomes

    monkeypatch.setattr('rocketride.mixins.data.asyncio.gather', spying_gather)
    return spy


# =========================================================================
# THE BOUND
# =========================================================================


@pytest.mark.asyncio
async def test_bounded_default_is_five(tmp_path):
    """40 files, no argument -> at most 5 pipes open at once. Pre-fix peak was 40."""
    client = FakeClient()
    files = write_files(tmp_path, 40)

    results = await client.send_files(files, 'token')

    assert client.ledger['peak'] == 5
    assert len(results) == 40


@pytest.mark.asyncio
@pytest.mark.parametrize('max_concurrent', [1, 2, 3, 7])
async def test_bounded_honours_the_argument(tmp_path, max_concurrent):
    client = FakeClient()
    files = write_files(tmp_path, 20)

    await client.send_files(files, 'token', max_concurrent=max_concurrent)

    assert client.ledger['peak'] == max_concurrent


@pytest.mark.asyncio
async def test_bounded_by_the_file_count_when_the_bound_is_larger(tmp_path, gather_spy):
    """
    Asking for 50 workers over 3 files must not spawn 50 workers.

    Counting open pipes is not enough to prove this: 47 surplus workers would each find
    the cursor exhausted and return without opening anything, so the pipe count would
    look right either way. The spy counts the coroutines actually handed to gather().
    """
    client = FakeClient()
    files = write_files(tmp_path, 3)

    results = await client.send_files(files, 'token', max_concurrent=50)

    assert client.ledger['peak'] == 3
    assert gather_spy.awaitable_count == 3
    assert len(results) == 3


@pytest.mark.asyncio
async def test_bounded_does_not_grow_with_the_file_list(tmp_path):
    """The bound is the point: 12 files and 120 files hold the same number open."""
    small_dir = tmp_path / 'small'
    small_dir.mkdir()
    small = FakeClient()
    await small.send_files(write_files(small_dir, 12), 'token')

    big_dir = tmp_path / 'big'
    big_dir.mkdir()
    big = FakeClient()
    await big.send_files(write_files(big_dir, 120), 'token')

    assert small.ledger['peak'] == big.ledger['peak'] == 5


# =========================================================================
# VALIDATION
# =========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize('bad', [0, -1, 2.5, 5.0, '5', None, True, False])
async def test_rejects_a_bad_bound(tmp_path, bad):
    """`True` is an int in Python and would have quietly meant 1."""
    client = FakeClient()
    files = write_files(tmp_path, 2)

    with pytest.raises(ValueError, match='max_concurrent must be a positive integer'):
        await client.send_files(files, 'token', max_concurrent=bad)


@pytest.mark.asyncio
async def test_rejects_before_opening_anything(tmp_path):
    """'reject ... before any upload starts' -- nothing is opened and nothing is read."""
    client = FakeClient()
    files = write_files(tmp_path, 5)

    with pytest.raises(ValueError):
        await client.send_files(files, 'token', max_concurrent=0)

    assert client.ledger['peak'] == 0


@pytest.mark.asyncio
async def test_a_missing_file_raises_what_the_docstring_says(tmp_path):
    """
    The `Raises:` block promised `FileNotFoundError` and the code has always raised
    `ValueError` -- both lines are older than this branch. Documented to match the
    shipped behaviour rather than the other way round, because `FileNotFoundError` is
    an `OSError` and not a `ValueError`, so swapping it is a public break. Nothing
    asserted either one, which is how it drifted for the life of the function.
    """
    client = FakeClient()
    files = write_files(tmp_path, 2) + [str(tmp_path / 'not-there.txt')]

    with pytest.raises(ValueError, match='File not found'):
        await client.send_files(files, 'token')

    assert client.ledger['peak'] == 0

    raises = DataMixin.send_files.__doc__.split('Raises:')[1].split('Example:')[0]
    assert 'FileNotFoundError' not in raises


@pytest.mark.asyncio
async def test_a_bad_bound_outranks_a_bad_file_list(tmp_path):
    """Both are caller errors; the one that does not depend on the data is reported."""
    client = FakeClient()

    with pytest.raises(ValueError, match='max_concurrent'):
        await client.send_files(['/does/not/exist'], 'token', max_concurrent=0)


# =========================================================================
# WHAT THE BOUND MUST NOT BREAK
# =========================================================================


@pytest.mark.asyncio
async def test_results_keep_input_order(tmp_path):
    """Uploads finish out of order; the returned list does not."""
    client = FakeClient()
    files = write_files(tmp_path, 25)

    results = await client.send_files(files, 'token', max_concurrent=4)

    assert [r['filepath'] for r in results] == files


@pytest.mark.asyncio
async def test_every_file_is_uploaded_exactly_once(tmp_path):
    """A shared cursor read by several workers must not skip or double-serve an index."""
    client = FakeClient()
    files = write_files(tmp_path, 60)

    results = await client.send_files(files, 'token', max_concurrent=6)

    assert sorted(r['filepath'] for r in results) == sorted(files)
    assert all(r['action'] == 'complete' for r in results)


@pytest.mark.asyncio
async def test_no_result_slot_is_left_empty(tmp_path):
    """send_files() is typed List[UPLOAD_RESULT]; a None in it is an AttributeError later."""
    client = FakeClient()
    files = write_files(tmp_path, 30)

    results = await client.send_files(files, 'token', max_concurrent=3)

    assert all(r is not None for r in results)


@pytest.mark.asyncio
async def test_one_failure_does_not_strand_the_queue(tmp_path):
    """
    The regression a worker pool can have and one-task-per-file could not: a file that
    blows up must not take the files queued behind it with it.
    """
    client = FakeClient()
    files = write_files(tmp_path, 10)

    original_pipe = client.pipe
    calls = {'n': 0}

    async def pipe(*args, **kwargs):
        calls['n'] += 1
        if calls['n'] == 2:
            client._pending_fail = True
        return await original_pipe(*args, **kwargs)

    client.pipe = pipe

    results = await client.send_files(files, 'token', max_concurrent=2)

    assert len(results) == 10
    assert sum(1 for r in results if r['action'] == 'error') == 1
    assert sum(1 for r in results if r['action'] == 'complete') == 9
    assert [r['filepath'] for r in results] == files


@pytest.mark.asyncio
async def test_no_worker_exits_by_exception(tmp_path, gather_spy):
    """
    gather(..., return_exceptions=True) turns a worker that dies into a value nobody
    reads. Anything that escapes a worker is therefore invisible in the return value
    and in the logs, so it is asserted on directly.
    """
    client = FakeClient()
    files = write_files(tmp_path, 40)

    await client.send_files(files, 'token', max_concurrent=6)

    assert gather_spy.failures == []


@pytest.mark.asyncio
async def test_a_file_that_vanishes_mid_upload_does_not_strand_the_queue(tmp_path, monkeypatch, gather_spy):
    """
    upload_file() builds its final event body OUTSIDE its own try/except, and that body
    calls os.path.getsize(). A file deleted between the exists() check and the getsize()
    call therefore raises out of the coroutine. One task per file could absorb that; a
    worker pool cannot, because the same worker owns every file still queued behind it.
    """
    client = FakeClient()
    files = write_files(tmp_path, 12)
    doomed = files[1]

    real_getsize = os.path.getsize
    seen = {'n': 0}

    def flaky_getsize(path):
        if path == doomed:
            seen['n'] += 1
            # The first call is inside upload_file's try; the second is not.
            if seen['n'] >= 2:
                raise OSError(2, 'No such file or directory', path)
        return real_getsize(path)

    monkeypatch.setattr(os.path, 'getsize', flaky_getsize)

    results = await client.send_files(files, 'token', max_concurrent=2)

    assert len(results) == 12
    assert all(r is not None for r in results)
    assert [r['filepath'] for r in results] == files
    assert results[1]['action'] == 'error'
    assert sum(1 for r in results if r['action'] == 'complete') == 11
    assert gather_spy.failures == []


async def _start_and_reach_a_worker(client, files, max_concurrent):
    """Start send_files() and hand back its task plus the worker tasks gather() made.

    Nothing public holds a reference to a gather() child, so the only way to cancel one
    without cancelling the caller is to go through the loop's task registry -- which is
    also the only way the case under test arises.
    """
    caller = asyncio.create_task(client.send_files(files, 'token', max_concurrent=max_concurrent))
    await asyncio.sleep(0.05)
    workers = [
        t
        for t in asyncio.all_tasks()
        if t is not caller and getattr(t.get_coro(), '__name__', None) == 'upload_worker'
    ]
    return caller, workers


@pytest.mark.asyncio
async def test_a_cancelled_worker_propagates_rather_than_returning_holes(tmp_path):
    """
    A cancelled worker is the one death `except Exception` does not cover: CancelledError
    is a BaseException, so the worker dies with an index already off the cursor and no
    survivor obliged to pick up what is left. Pre-fix this returned quietly with `None`
    entries in a `List[UPLOAD_RESULT]`, and with max_concurrent=1 that was every file.
    """
    client = FakeClient(latency=0.30)
    files = write_files(tmp_path, 9)

    caller, workers = await _start_and_reach_a_worker(client, files, max_concurrent=3)
    assert len(workers) == 3
    workers[0].cancel()

    with pytest.raises(asyncio.CancelledError):
        await caller


@pytest.mark.asyncio
async def test_cancelling_the_caller_still_propagates(tmp_path):
    """The reachable case -- wait_for, TaskGroup, loop shutdown -- must be unchanged."""
    client = FakeClient(latency=0.30)
    files = write_files(tmp_path, 9)

    caller, workers = await _start_and_reach_a_worker(client, files, max_concurrent=3)
    caller.cancel()

    with pytest.raises(asyncio.CancelledError):
        await caller


@pytest.mark.asyncio
async def test_progress_events_still_fire_for_every_file(tmp_path):
    client = FakeClient()
    seen = []

    async def on_event(message):
        seen.append(message['body'])

    client._caller_on_event = on_event
    files = write_files(tmp_path, 8)

    await client.send_files(files, 'token', max_concurrent=2)

    for action in ('open', 'write', 'close', 'complete'):
        assert sum(1 for b in seen if b['action'] == action) == 8


@pytest.mark.asyncio
async def test_a_single_file_still_works(tmp_path):
    client = FakeClient()
    files = write_files(tmp_path, 1)

    results = await client.send_files(files, 'token')

    assert len(results) == 1
    assert results[0]['action'] == 'complete'
    assert client.ledger['peak'] == 1


# =========================================================================
# THE PUBLISHED CONTRACT
# =========================================================================


def test_signature_matches_the_typescript_client():
    """sendFiles(files, token, maxConcurrent = 5) -- same order, same default."""
    params = list(inspect.signature(DataMixin.send_files).parameters)
    assert params == ['self', 'files', 'token', 'max_concurrent']
    assert inspect.signature(DataMixin.send_files).parameters['max_concurrent'].default == 5


def test_docstring_no_longer_promises_unbounded_parallelism():
    """The line #1716 removed from the TypeScript client."""
    doc = DataMixin.send_files.__doc__
    assert 'Server handles queuing automatically' not in doc
    assert 'max_concurrent' in doc


def test_returns_one_result_per_file_in_the_annotation_too():
    """
    `UPLOAD_RESULT` is one file's result -- types/data.py's own usage example says
    `uploads: List[UPLOAD_RESULT] = await client.send_files(...)`. The annotation said
    a single one, which disagreed with the docs tables and with every caller.
    """
    from typing import List as TypingList

    from rocketride.types import UPLOAD_RESULT

    returns = inspect.get_annotations(DataMixin.send_files, eval_str=True)['return']
    assert returns == TypingList[UPLOAD_RESULT]
