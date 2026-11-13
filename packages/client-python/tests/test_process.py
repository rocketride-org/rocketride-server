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

"""``process()``: one-of arguments, inline versus streamed delivery, stamps (plan 3.1)."""

import asyncio

import pytest

from rocketride.mixins import execution
from rocketride.mixins.execution import ExecutionMixin

STAMPS = {'token': 'acme.docBrain.webhook_1', 'resolved': '@team', 'converged': 'none', 'ignored': []}


class _Client(ExecutionMixin):
    """ExecutionMixin over a recorded ``call``/``send``."""

    def __init__(self, fail: str = '') -> None:
        self.calls = []
        self.sent = []
        self._env = {'ROCKETRIDE_TONE': 'dry', 'OTHER': 'x'}
        self._fail = fail

    async def call(self, command, **arguments):
        self.calls.append((command, arguments))
        if self._fail:
            raise RuntimeError(self._fail)
        return {**STAMPS, **({'answers': ['inline']} if 'data' in arguments else {})}

    async def send(self, token, data, objinfo=None, mimetype=None, on_sse=None):
        self.sent.append((token, data, on_sse))
        return {'answers': ['streamed']}


def _run(coro):
    return asyncio.run(coro)


def test_exactly_one_of_name_pipeline_or_filepath():
    client = _Client()
    with pytest.raises(ValueError):
        _run(client.process())
    with pytest.raises(ValueError):
        _run(client.process(name='acme.docBrain', pipeline={'components': []}))


def test_small_data_travels_inline_in_one_request():
    client = _Client()
    result = _run(client.process(name='acme.docBrain', data='hi', threads=4))

    assert result['answers'] == ['inline'] and result['resolved'] == '@team'
    command, arguments = client.calls[0]
    assert command == 'process' and arguments['data'] == b'hi' and arguments['threads'] == 4
    assert 'env' not in arguments  # a name call never sends the client's env
    assert client.sent == []


def test_on_sse_always_streams_even_for_a_tiny_payload():
    client = _Client()

    async def on_sse(kind, body):
        return None

    result = _run(client.process(name='acme.docBrain', data=b'0123456789', on_sse=on_sse))

    assert 'data' not in client.calls[0][1]
    assert client.sent == [(STAMPS['token'], b'0123456789', on_sse)]
    assert result['answers'] == ['streamed'] and result['resolved'] == '@team'


def test_over_the_inline_limit_streams(monkeypatch):
    monkeypatch.setattr(execution, 'PROCESS_INLINE_MAX', 4)
    client = _Client()
    _run(client.process(name='acme.docBrain', data=b'12345'))
    assert 'data' not in client.calls[0][1] and len(client.sent) == 1


def test_a_spec_call_sends_on_change_and_the_rocketride_env():
    client = _Client()
    _run(client.process(pipeline={'components': []}, on_change='auto', pipeline_trace_level='full'))
    arguments = client.calls[0][1]
    assert arguments['onChange'] == 'auto' and arguments['pipelineTraceLevel'] == 'full'
    assert arguments['env'] == {'ROCKETRIDE_TONE': 'dry'}


def test_an_old_server_says_process_is_not_supported():
    client = _Client(fail='Unsupported command: process')
    with pytest.raises(RuntimeError, match='does not support process'):
        _run(client.process(name='acme.docBrain'))
