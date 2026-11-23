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

"""A pipe's trace level is part of its transaction: given to ``client.pipe()``, sent on the open frame only."""

import asyncio
from typing import Any, Dict, List

from rocketride.mixins.data import DataMixin


class RecordingTransport:
    """Fake transport that records each frame's arguments and answers it the way a server would."""

    def __init__(self):
        """Start with no frames sent; the client is bound after construction."""
        self.client = None
        self.sent: List[Dict[str, Any]] = []

    def bind(self, **handlers):
        """Accept the client's handlers (unused)."""
        self.handlers = handlers

    def is_connected(self):
        """Always connected."""
        return True

    async def send(self, message):
        """Record the frame's arguments; answer an open with a slot, every other frame with an empty body."""
        arguments = message.get('arguments') or {}
        self.sent.append(dict(arguments))
        body = {'pipeId': 3, 'traceId': '1.1.9'} if arguments.get('subcommand') == 'open' else {}
        await self.client.on_receive({'type': 'response', 'request_seq': message['seq'], 'success': True, 'body': body})


def _client():
    """A client whose transport records every frame."""
    transport = RecordingTransport()
    client = DataMixin(module='TEST', transport=transport)
    transport.client = client
    return client, transport


def test_the_pipes_trace_level_rides_its_open_and_no_later_frame():
    """The level is the transaction's: named on the open, absent from the write and the close."""
    client, transport = _client()

    async def run_test():
        pipe = await client.pipe('tok', mime_type='text/plain', pipeline_trace_level='full')
        await pipe.open()
        await pipe.write(b'hello')
        await pipe.close()

    asyncio.run(run_test())

    assert [frame['subcommand'] for frame in transport.sent] == ['open', 'write', 'close']
    assert transport.sent[0]['pipelineTraceLevel'] == 'full'
    assert all('pipelineTraceLevel' not in frame for frame in transport.sent[1:])


def test_a_pipe_given_no_trace_level_opens_naming_none():
    """Without a level the open names none, and the server applies the control's own."""
    client, transport = _client()

    async def run_test():
        pipe = await client.pipe('tok', mime_type='text/plain')
        await pipe.open()

    asyncio.run(run_test())

    assert 'pipelineTraceLevel' not in transport.sent[0]
