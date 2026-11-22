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
A data pipe's ``on_sse`` callback is dispatched by the request tree (``traceId``), not the slot.

The engine reuses a pipe slot for the next binding once a pipe closes, so an
SSE event that left the engine just before the close can arrive after the
next pipe opened on the same slot. Keyed by the never-reused ``traceId``, that
late event finds no callback instead of reaching the next caller's.
"""

import asyncio

from rocketride.mixins.data import DataMixin
from rocketride.mixins.events import EventMixin

# =============================================================================
# Helpers
# =============================================================================


class _SseClient(DataMixin, EventMixin):
    """The two mixins the SSE path crosses: DataPipe registers, EventMixin dispatches."""

    def __init__(self, **kwargs):
        """Start with no subscriptions recorded and no VS Code debugger to forward to."""
        super().__init__(**kwargs)
        self.subscriptions = []
        # RocketRideClient.__init__ sets these; the mixins alone do not
        self._dap_attempted = True
        self._dap_send = None

    async def set_events(self, token, event_types, pipe_id=None):
        """Record the SSE subscription a pipe asks for (its wire form is set_events' own concern)."""
        self.subscriptions.append((token, event_types, pipe_id))


class ScriptedTransport:
    """Answer each ``send()`` with the next scripted body and record what was sent."""

    def __init__(self, bodies):
        """Keep the bodies to answer with, in order."""
        self._bodies = list(bodies)
        self.client = None
        self.sent = []

    def bind(self, **handlers):
        """Accept the client's handlers (unused: responses are fed back directly)."""
        self.handlers = handlers

    def is_connected(self):
        """Always connected."""
        return True

    async def send(self, message):
        """Record the request and answer it with the next body."""
        self.sent.append(message)
        body = self._bodies.pop(0)
        await self.client.on_receive({'type': 'response', 'request_seq': message['seq'], 'success': True, 'body': body})


def _make_client(bodies):
    """A client over a scripted transport."""
    transport = ScriptedTransport(bodies)
    client = _SseClient(module='TEST', transport=transport)
    transport.client = client
    return client, transport


def _sse(pipe_id, trace_id, kind):
    """An ``apaevt_sse`` event as the server delivers it."""
    return {'type': 'event', 'event': 'apaevt_sse', 'body': {'pipeId': pipe_id, 'traceId': trace_id, 'type': kind}}


def _run(coro):
    """Run one coroutine on a fresh loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# =============================================================================
# Tests
# =============================================================================


def test_sse_reaches_the_callback_of_its_request_tree():
    """An event carrying the pipe's traceId reaches that pipe's callback, with its type and data."""
    client, _ = _make_client([{'pipeId': 7, 'traceId': 'n.e.1'}])
    seen = []

    async def on_sse(kind, data):
        seen.append((kind, data))

    async def run():
        pipe = DataMixin.DataPipe(client, token='tok', mime_type='text/plain', on_sse=on_sse)
        await pipe.open()
        event = _sse(7, 'n.e.1', 'thinking')
        event['body']['data'] = {'step': 1}
        await client.on_event(event)

    _run(run())
    assert seen == [('thinking', {'step': 1})]
    assert list(client._sse_pipe_callbacks) == ['n.e.1']


def test_a_late_event_of_a_closed_pipe_never_reaches_the_next_pipe_on_its_slot():
    """The engine reuses slot 7; the closed request's event finds no callback, the new one's reaches the new pipe."""
    # open A, close A, open B on the SAME slot
    client, _ = _make_client([{'pipeId': 7, 'traceId': 'n.e.1'}, {}, {'pipeId': 7, 'traceId': 'n.e.2'}])
    seen = []

    async def first(kind, data):
        seen.append(('first', kind))

    async def second(kind, data):
        seen.append(('second', kind))

    async def run():
        pipe_a = DataMixin.DataPipe(client, token='tok', mime_type='text/plain', on_sse=first)
        await pipe_a.open()
        await pipe_a.close()
        pipe_b = DataMixin.DataPipe(client, token='tok', mime_type='text/plain', on_sse=second)
        await pipe_b.open()
        await client.on_event(_sse(7, 'n.e.1', 'late'))
        await client.on_event(_sse(7, 'n.e.2', 'chunk'))

    _run(run())
    assert seen == [('second', 'chunk')]
    assert list(client._sse_pipe_callbacks) == ['n.e.2']


def test_the_subscription_still_names_the_slot_and_close_releases_the_tree():
    """The server narrows an SSE subscription by slot; the callback is gone once the pipe closes."""
    client, _ = _make_client([{'pipeId': 7, 'traceId': 'n.e.1'}, {}])

    async def on_sse(kind, data):
        pass

    async def run():
        pipe = DataMixin.DataPipe(client, token='tok', mime_type='text/plain', on_sse=on_sse)
        await pipe.open()
        assert list(client._sse_pipe_callbacks) == ['n.e.1']
        await pipe.close()

    _run(run())
    assert client.subscriptions == [('tok', ['SSE'], 7), ('tok', [], 7)]
    assert client._sse_pipe_callbacks == {}
