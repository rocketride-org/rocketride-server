# =============================================================================
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

"""``self.state`` and ``self.files`` from the node's side (plan 5.7): only the binding and the node's key leave the engine."""

from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest
from rocketlib import doors
from rocketlib.doors import DoorError, NodeFiles, NodeState, setNodeChannel
from rocketlib.filters import IInstanceBase

# ==== A recording channel ========================================================


class _Channel:
    """Records every request and answers from a script of (body, data) or exceptions."""

    def __init__(self, *answers):
        self.requests = []
        self._answers = list(answers)

    def __call__(self, command, arguments, data):
        self.requests.append((command, dict(arguments), data))
        answer = self._answers.pop(0) if self._answers else ({}, None)
        if isinstance(answer, Exception):
            raise answer
        return answer


@pytest.fixture
def channel():
    """Install a recording channel with a 4-byte chunk; removed after."""
    installed = []

    def install(*answers):
        recorder = _Channel(*answers)
        setNodeChannel(recorder, chunk=4)
        installed.append(recorder)
        return recorder

    yield install
    setNodeChannel(None)


# ==== self.state =================================================================


def test_a_request_carries_the_binding_and_the_key_only(channel):
    recorder = channel(({'found': True, 'value': [1, 2]}, None), ({}, None))
    state = NodeState('cid-41')
    assert state.get('series:cpu') == [1, 2]
    state.put('series:cpu', [1, 2, 3], ttl=60)
    assert recorder.requests == [
        ('state.get', {'correlationId': 'cid-41', 'key': 'series:cpu'}, None),
        ('state.put', {'correlationId': 'cid-41', 'key': 'series:cpu', 'value': [1, 2, 3], 'ttl': 60}, None),
    ]


def test_absent_is_the_default_and_a_stored_null_is_null(channel):
    channel(({'found': False}, None), ({'found': True, 'value': None}, None))
    state = NodeState('cid')
    assert state.get('k', 'fallback') == 'fallback'
    assert state.get('k', 'fallback') is None


def test_incr_and_delete(channel):
    recorder = channel(({'value': 5}, None), ({'deleted': True}, None))
    state = NodeState('cid')
    assert state.incr('n', 5) == 5
    assert state.delete('n') is True
    assert recorder.requests[0] == ('state.incr', {'correlationId': 'cid', 'key': 'n', 'amount': 5, 'ttl': None}, None)


def test_lock_retries_until_free_and_releases_with_its_token(channel, monkeypatch):
    monkeypatch.setattr(doors.time, 'sleep', lambda seconds: None)
    recorder = channel(
        ({'acquired': False}, None),
        ({'acquired': False}, None),
        ({'acquired': True, 'token': 't1'}, None),
        ({'released': True}, None),
    )
    with NodeState('cid').lock('k'):
        assert [r[0] for r in recorder.requests] == ['state.lock'] * 3
    assert recorder.requests[-1] == ('state.unlock', {'correlationId': 'cid', 'key': 'k', 'token': 't1'}, None)


def test_writes_to_a_held_key_are_fenced_by_its_lease(channel):
    recorder = channel(
        ({'acquired': True, 'token': 't1'}, None),
        ({}, None),
        ({'value': 1}, None),
        ({}, None),
        ({'released': True}, None),
        ({}, None),
    )
    state = NodeState('cid')
    with state.lock('k'):
        state.put('k', 1)
        state.incr('k')
        state.put('other', 2)
    state.put('k', 3)
    sent = {(r[0], r[1]['key'], r[1].get('token')) for r in recorder.requests if r[0] != 'state.lock'}
    assert ('state.put', 'k', 't1') in sent and ('state.incr', 'k', 't1') in sent
    # Another key, and the key after the block, name no lease
    assert ('state.put', 'other', None) in sent and ('state.put', 'k', None) in sent


def test_two_threads_sharing_a_door_never_mix_lease_tokens():
    # A takes the key, stalls past its lease, B takes it; A then writes and
    # leaves while B still holds it. A's write names A's token (the server
    # refuses it), and A's exit leaves B's token alone
    sent, tokens, guard = [], iter(['t-a', 't-b']), threading.Lock()

    def request(command, arguments, data):
        with guard:
            sent.append((threading.current_thread().name, command, arguments.get('token')))
            if command == 'state.lock':
                return {'acquired': True, 'token': next(tokens)}, None
        return {}, None

    state = NodeState('cid')
    a_locked, b_locked, a_done = threading.Event(), threading.Event(), threading.Event()

    def holder_a():
        with state.lock('k'):
            a_locked.set()
            b_locked.wait(5)
            state.put('k', 'stale')
        a_done.set()

    def holder_b():
        a_locked.wait(5)
        with state.lock('k'):
            b_locked.set()
            a_done.wait(5)
            state.put('k', 'fresh')

    setNodeChannel(request)
    try:
        threads = [threading.Thread(target=holder_a, name='A'), threading.Thread(target=holder_b, name='B')]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
    finally:
        setNodeChannel(None)

    writes = [(name, token) for name, command, token in sent if command in ('state.put', 'state.unlock')]
    assert writes == [('A', 't-a'), ('A', 't-a'), ('B', 't-b'), ('B', 't-b')]


def test_lock_gives_up_after_its_timeout(channel, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(doors.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(doors.time, 'sleep', lambda seconds: now.__setitem__(0, now[0] + seconds))
    channel(*[({'acquired': False}, None)] * 100)
    with pytest.raises(DoorError, match='held by another binding'):
        with NodeState('cid').lock('k', timeout=1.0):
            pass


def test_a_refusal_is_a_door_error_with_the_servers_reason(channel):
    channel(RuntimeError('state.get: this binding belongs to no control the server can name'))
    with pytest.raises(DoorError, match='belongs to no control'):
        NodeState('cid').get('k')


def test_no_channel_outside_the_engine():
    setNodeChannel(None)
    with pytest.raises(DoorError, match='no data channel'):
        NodeState('cid').get('k')


# ==== self.files =================================================================


def test_read_pulls_chunks_and_closes(channel):
    recorder = channel(
        ({'handle': 'h', 'size': 6}, None),
        ({'size': 4}, b'abcd'),
        ({'size': 2}, b'ef'),
        ({'size': 0}, b''),
        ({}, None),
    )
    assert NodeFiles('cid').read('a.txt') == b'abcdef'
    assert [r[0] for r in recorder.requests] == ['fs_open', 'fs_read', 'fs_read', 'fs_read', 'fs_close']
    assert all(r[1]['correlationId'] == 'cid' for r in recorder.requests)


def test_read_refuses_a_file_over_max_size_and_still_closes(channel):
    recorder = channel(({'handle': 'h', 'size': 100}, None), ({}, None))
    with pytest.raises(DoorError, match='more than the 10 allowed'):
        NodeFiles('cid').read('big.bin', max_size=10)
    assert recorder.requests[-1][0] == 'fs_close'


def test_read_is_bounded_by_default(channel):
    recorder = channel(({'handle': 'h', 'size': doors.FILES_READ_MAX_SIZE + 1}, None), ({}, None))
    with pytest.raises(DoorError, match='more than the'):
        NodeFiles('cid').read('huge.bin')
    assert recorder.requests[-1][0] == 'fs_close'


def test_read_counts_the_bytes_it_receives_too(channel):
    # The server said 2 bytes; the file grew while it was read
    recorder = channel(
        ({'handle': 'h', 'size': 2}, None),
        ({'size': 4}, b'abcd'),
        ({}, None),
    )
    with pytest.raises(DoorError, match='more than the 3 bytes allowed'):
        NodeFiles('cid').read('growing.txt', max_size=3)
    assert recorder.requests[-1][0] == 'fs_close'


def test_write_splits_at_the_channel_chunk(channel):
    recorder = channel(({'handle': 'h'}, None), ({'bytesWritten': 4}, None), ({'bytesWritten': 2}, None), ({}, None))
    NodeFiles('cid').write('a.txt', b'abcdef')
    assert [(r[0], r[2]) for r in recorder.requests] == [
        ('fs_open', None),
        ('fs_write', b'abcd'),
        ('fs_write', b'ef'),
        ('fs_close', None),
    ]


def test_get_url_defaults_to_a_short_expiry(channel):
    recorder = channel(({'url': 'https://x/task/fetch?t=1'}, None))
    assert NodeFiles('cid').get_url('a.txt') == 'https://x/task/fetch?t=1'
    assert recorder.requests[0][1]['expires_in'] == doors.FILES_URL_EXPIRES_IN


# ==== The doors on an instance ===================================================


class _Instance(IInstanceBase):
    """An instance the way the engine builds one: a pipe that serves one binding at a time."""

    def __init__(self, caller):
        self.instance = SimpleNamespace(traceId=17, caller=caller)
        # The engine's one write, before beginInstance()
        self._caller = caller


def test_the_doors_name_the_binding_frozen_at_bind(channel):
    recorder = channel(({'found': False}, None), ({'found': False}, None))
    inst = _Instance({'correlationId': 'cid-a', 'userId': 'alice'})
    # putPipe() and a new binding on the same pipe: the shared pipe now serves
    # someone else, before this instance ever touched a door
    inst.instance.traceId = 99
    inst.instance.caller = {'correlationId': 'cid-b', 'userId': 'bob'}
    state = inst.state
    assert inst.state is state
    state.get('k')
    inst.state.get('k')
    assert [r[1]['correlationId'] for r in recorder.requests] == ['cid-a', 'cid-a']
    assert inst.files is inst.files


def test_a_binding_without_a_caller_is_engine_level_work(channel):
    recorder = channel(({'found': False}, None))

    class _Unbound(IInstanceBase):
        def __init__(self):
            self.instance = SimpleNamespace(traceId=5, caller=None)

    _Unbound().state.get('k')
    assert recorder.requests[0][1]['correlationId'] == ''
