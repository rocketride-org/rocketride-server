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
    state = NodeState(41)
    assert state.get('series:cpu') == [1, 2]
    state.put('series:cpu', [1, 2, 3], ttl=60)
    assert recorder.requests == [
        ('state.get', {'traceId': 41, 'key': 'series:cpu'}, None),
        ('state.put', {'traceId': 41, 'key': 'series:cpu', 'value': [1, 2, 3], 'ttl': 60}, None),
    ]


def test_absent_is_the_default_and_a_stored_null_is_null(channel):
    channel(({'found': False}, None), ({'found': True, 'value': None}, None))
    state = NodeState(1)
    assert state.get('k', 'fallback') == 'fallback'
    assert state.get('k', 'fallback') is None


def test_incr_and_delete(channel):
    recorder = channel(({'value': 5}, None), ({'deleted': True}, None))
    state = NodeState(1)
    assert state.incr('n', 5) == 5
    assert state.delete('n') is True
    assert recorder.requests[0] == ('state.incr', {'traceId': 1, 'key': 'n', 'amount': 5, 'ttl': None}, None)


def test_lock_retries_until_free_and_releases_with_its_token(channel, monkeypatch):
    monkeypatch.setattr(doors.time, 'sleep', lambda seconds: None)
    recorder = channel(
        ({'acquired': False}, None),
        ({'acquired': False}, None),
        ({'acquired': True, 'token': 't1'}, None),
        ({'released': True}, None),
    )
    with NodeState(1).lock('k'):
        assert [r[0] for r in recorder.requests] == ['state.lock'] * 3
    assert recorder.requests[-1] == ('state.unlock', {'traceId': 1, 'key': 'k', 'token': 't1'}, None)


def test_lock_gives_up_after_its_timeout(channel, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(doors.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(doors.time, 'sleep', lambda seconds: now.__setitem__(0, now[0] + seconds))
    channel(*[({'acquired': False}, None)] * 100)
    with pytest.raises(DoorError, match='held by another binding'):
        with NodeState(1).lock('k', timeout=1.0):
            pass


def test_a_refusal_is_a_door_error_with_the_servers_reason(channel):
    channel(RuntimeError('state.get: this binding belongs to no control the server can name'))
    with pytest.raises(DoorError, match='belongs to no control'):
        NodeState(1).get('k')


def test_no_channel_outside_the_engine():
    setNodeChannel(None)
    with pytest.raises(DoorError, match='no data channel'):
        NodeState(1).get('k')


# ==== self.files =================================================================


def test_read_pulls_chunks_and_closes(channel):
    recorder = channel(
        ({'handle': 'h', 'size': 6}, None),
        ({'size': 4}, b'abcd'),
        ({'size': 2}, b'ef'),
        ({'size': 0}, b''),
        ({}, None),
    )
    assert NodeFiles(9).read('a.txt') == b'abcdef'
    assert [r[0] for r in recorder.requests] == ['fs_open', 'fs_read', 'fs_read', 'fs_read', 'fs_close']
    assert all(r[1]['traceId'] == 9 for r in recorder.requests)


def test_read_refuses_a_file_over_max_size_and_still_closes(channel):
    recorder = channel(({'handle': 'h', 'size': 100}, None), ({}, None))
    with pytest.raises(DoorError, match='more than the 10 allowed'):
        NodeFiles(9).read('big.bin', max_size=10)
    assert recorder.requests[-1][0] == 'fs_close'


def test_write_splits_at_the_channel_chunk(channel):
    recorder = channel(({'handle': 'h'}, None), ({'bytesWritten': 4}, None), ({'bytesWritten': 2}, None), ({}, None))
    NodeFiles(9).write('a.txt', b'abcdef')
    assert [(r[0], r[2]) for r in recorder.requests] == [
        ('fs_open', None),
        ('fs_write', b'abcd'),
        ('fs_write', b'ef'),
        ('fs_close', None),
    ]


def test_get_url_defaults_to_a_short_expiry(channel):
    recorder = channel(({'url': 'https://x/task/fetch?t=1'}, None))
    assert NodeFiles(9).get_url('a.txt') == 'https://x/task/fetch?t=1'
    assert recorder.requests[0][1]['expires_in'] == doors.FILES_URL_EXPIRES_IN


# ==== The doors on an instance ===================================================


class _Instance(IInstanceBase):
    """An instance the way the engine builds one: its binding's engine object."""

    def __init__(self, trace_id):
        self.instance = SimpleNamespace(traceId=trace_id)


def test_the_doors_bind_to_the_instances_binding_at_first_use(channel):
    recorder = channel(({'found': False}, None), ({'found': False}, None))
    inst = _Instance(17)
    state = inst.state
    assert inst.state is state
    # A worker thread that keeps the door stays on this binding
    inst.instance.traceId = 99
    state.get('k')
    inst.state.get('k')
    assert [r[1]['traceId'] for r in recorder.requests] == [17, 17]
    assert inst.files is inst.files
