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

"""``submit()``: one-of arguments, inline versus streamed delivery, stamps (plan 3.1)."""

import asyncio

import pytest

from rocketride.core.constants import SUBMIT_INLINE_MAX, SUBMIT_TRANSPORT_MARGIN
from rocketride.mixins import execution
from rocketride.mixins.execution import ExecutionMixin

STAMPS = {'token': 'acme.docBrain.webhook_1', 'resolved': '@team', 'converged': 'none', 'ignored': []}


class _Client(ExecutionMixin):
    """ExecutionMixin over a recorded request path (``build_request``/``request``) and ``send``."""

    TRACE_REQUEST = 0
    TRACE_SUCCESS = 1
    TRACE_ERROR = 2
    _on_trace = None

    def __init__(self, fail: str = '') -> None:
        self.calls = []
        self.timeouts = []
        self.sent = []
        self.sent_teams = []
        self.sent_params = []
        self._env = {'ROCKETRIDE_TONE': 'dry', 'OTHER': 'x'}
        self._fail = fail

    def build_request(self, command, arguments=None, token=None):
        return {'type': 'request', 'command': command, 'arguments': dict(arguments or {}), 'token': token}

    async def request(self, message, timeout=None):
        self.calls.append((message['command'], message['arguments']))
        self.timeouts.append(timeout)
        if self._fail:
            return {'success': False, 'message': self._fail}
        arguments = message['arguments']
        return {'success': True, 'body': {**STAMPS, **({'answers': ['inline']} if 'data' in arguments else {})}}

    @staticmethod
    def did_fail(response):
        return not response.get('success')

    async def send(self, token, data, objinfo=None, mimetype=None, on_sse=None, team=None, params=None):
        self.sent.append((token, data, on_sse))
        self.sent_teams.append(team)
        self.sent_params.append(params)
        return {'answers': ['streamed']}


def _run(coro):
    return asyncio.run(coro)


def test_exactly_one_of_name_pipeline_or_filepath():
    client = _Client()
    with pytest.raises(ValueError):
        _run(client.submit())
    with pytest.raises(ValueError):
        _run(client.submit(name='acme.docBrain', pipeline={'components': []}))


def test_small_data_travels_inline_in_one_request():
    client = _Client()
    result = _run(client.submit(name='acme.docBrain', data='hi', threads=4))

    assert result['answers'] == ['inline'] and result['resolved'] == '@team'
    command, arguments = client.calls[0]
    assert command == 'rrext_submit' and arguments['data'] == b'hi' and arguments['threads'] == 4
    assert 'env' not in arguments  # a name call never sends the client's env
    assert client.sent == []


def test_on_sse_always_streams_even_for_a_tiny_payload():
    client = _Client()

    async def on_sse(kind, body):
        return None

    result = _run(client.submit(name='acme.docBrain', data=b'0123456789', on_sse=on_sse))

    assert 'data' not in client.calls[0][1]
    assert client.sent == [(STAMPS['token'], b'0123456789', on_sse)]
    assert result['answers'] == ['streamed'] and result['resolved'] == '@team'


def test_over_the_inline_limit_streams(monkeypatch):
    monkeypatch.setattr(execution, 'SUBMIT_INLINE_MAX', 4)
    client = _Client()
    _run(client.submit(name='acme.docBrain', data=b'12345'))
    assert 'data' not in client.calls[0][1] and len(client.sent) == 1


def test_a_spec_call_sends_on_change_and_the_rocketride_env():
    client = _Client()
    _run(client.submit(pipeline={'components': []}, on_change='auto', pipeline_trace_level='full'))
    arguments = client.calls[0][1]
    assert arguments['onChange'] == 'auto' and arguments['pipelineTraceLevel'] == 'full'
    assert arguments['env'] == {'ROCKETRIDE_TONE': 'dry'}


def test_an_old_server_says_submit_is_not_supported():
    client = _Client(fail='Unsupported command: rrext_submit')
    with pytest.raises(RuntimeError, match='does not support submit'):
        _run(client.submit(name='acme.docBrain'))


def test_the_timeout_is_a_server_argument_in_seconds_and_the_transport_deadline_outlives_it():
    """``timeout`` rides the arguments (the server enforces it, open to close); the transport waits longer."""
    client = _Client()
    _run(client.submit(name='acme.docBrain', data=b'x', timeout=30))
    assert client.calls[0][1]['timeout'] == 30
    assert client.timeouts == [(30 + SUBMIT_TRANSPORT_MARGIN) * 1000]

    client = _Client()
    _run(client.submit(name='acme.docBrain', data=b'x'))
    assert 'timeout' not in client.calls[0][1] and client.timeouts == [None]


def test_a_streamed_payload_is_sent_through_the_team_that_answered():
    """The data path resolves the address again: the stamped team keeps it on the same control."""
    client = _Client()
    _run(client.submit(name='acme.docBrain', data=b'0' * (SUBMIT_INLINE_MAX + 1)))
    assert client.sent_teams == [STAMPS.get('team')]


def test_params_ride_the_inline_request_and_the_streamed_send():
    """One door for per-call values: inline they ride the request, streamed they ride send(params=)."""
    client = _Client()
    _run(client.submit(name='acme.docBrain', data=b'x', params={'tone': 'dry'}))
    assert client.calls[0][1]['params'] == {'tone': 'dry'} and client.sent_params == []

    client = _Client()
    _run(client.submit(name='acme.docBrain', data=b'0' * (SUBMIT_INLINE_MAX + 1), params={'tone': 'dry'}))
    assert client.sent_params == [{'tone': 'dry'}]


def test_the_trace_level_has_one_spelling():
    """Python public API is snake_case: the camel spelling is not a second accepted name."""
    client = _Client()
    with pytest.raises(TypeError):
        _run(client.submit(name='acme.docBrain', pipelineTraceLevel='full'))
