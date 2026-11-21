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

"""``DataPipe.cancel()``: one ``cancel`` frame on the open pipe; the pipe stays open for ``close()``."""

import asyncio

import pytest

from rocketride.core.exceptions import PipeException
from rocketride.mixins.data import DataMixin


class ScriptedTransport:
    """Answer each ``send()`` with a scripted response and record what was sent."""

    def __init__(self, results):
        self._results = list(results)
        self.client = None
        self.sent = []

    def bind(self, **handlers):
        self.handlers = handlers

    def is_connected(self):
        return True

    async def send(self, message):
        self.sent.append(message)
        kind, payload = self._results.pop(0)
        response = {'type': 'response', 'request_seq': message['seq']}
        if kind == 'ok':
            response['success'] = True
            response['body'] = payload
        else:
            response['success'] = False
            response['message'] = payload
            if isinstance(payload, tuple):
                response['message'], response['code'] = payload
        await self.client.on_receive(response)


def _make_pipe(results):
    transport = ScriptedTransport(results)
    client = DataMixin(module='TEST', transport=transport)
    transport.client = client
    pipe = DataMixin.DataPipe(client, token='@Production/acme.docBrain', mime_type='text/plain')
    return pipe, transport


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_cancel_sends_one_frame_on_the_open_pipe_and_leaves_it_open():
    """The frame names the pipe on the token it opened with; nothing about the pipe's state changes."""
    pipe, transport = _make_pipe([('ok', {'pipeId': 7}), ('ok', {'pipeId': 7, 'cancelled': True}), ('ok', {})])

    async def run():
        await pipe.open()
        await pipe.cancel()
        assert pipe.is_opened
        await pipe.close()

    _run(run())
    cancel = transport.sent[1]
    assert cancel['command'] == 'rrext_process'
    assert cancel['arguments'] == {'subcommand': 'cancel', 'pipeId': 7, 'token': '@Production/acme.docBrain'}
    assert transport.sent[2]['arguments']['subcommand'] == 'close'


def test_cancel_before_open_or_after_close_is_refused_locally():
    """There is no request to cancel: no frame is sent."""
    pipe, transport = _make_pipe([('ok', {'pipeId': 7}), ('ok', {})])
    with pytest.raises(RuntimeError, match='not opened'):
        _run(pipe.cancel())
    assert transport.sent == []

    async def run():
        await pipe.open()
        await pipe.close()
        with pytest.raises(RuntimeError, match='not opened'):
            await pipe.cancel()

    _run(run())
    assert len(transport.sent) == 2


def test_a_refused_cancel_raises_the_servers_message():
    """The server's refusal (a slot open for another request) is the exception the caller sees."""
    pipe, _ = _make_pipe([('ok', {'pipeId': 7}), ('fail', 'Cancel pipe with id 7 is open for another request')])

    async def run():
        await pipe.open()
        with pytest.raises(PipeException, match='another request'):
            await pipe.cancel()

    _run(run())


def test_the_write_a_cancel_interrupted_carries_the_cancelled_code():
    """The failed write arrives as a PipeException classified by ``code``, not by its prose."""
    pipe, _ = _make_pipe([('ok', {'pipeId': 7}), ('fail', ('Pipe 7: the request was cancelled', 'TASK_CANCELLED'))])

    async def run():
        await pipe.open()
        with pytest.raises(PipeException) as err:
            await pipe.write(b'more')
        assert err.value.code == 'TASK_CANCELLED'

    _run(run())


def test_a_cancelled_tool_call_carries_the_cancelled_code_too():
    """tool() on a cancelled pipe fails like write(): a PipeException classified by ``code``."""
    pipe, _ = _make_pipe([('ok', {'pipeId': 7}), ('fail', ('Pipe 7: the request was cancelled', 'TASK_CANCELLED'))])

    async def run():
        await pipe.open()
        with pytest.raises(PipeException) as err:
            await pipe.tool(tool='lookup')
        assert err.value.code == 'TASK_CANCELLED'

    _run(run())
