"""
TransportWebSocket — ``on_closing`` reports a closed socket before handlers drain.

``on_disconnected`` waits for every in-flight message handler; a caller that
must react at once (the task's data channel failing its pending requests)
binds ``on_closing``, which fires as soon as the receive loop stops.
"""

import asyncio

from rocketride.core.transport_websocket import TransportWebSocket


class _Socket:
    """A client socket that delivers its messages, then reports the connection closed."""

    def __init__(self, messages):
        """Create the socket with the messages recv() returns in turn."""
        self._messages = list(messages)

    async def recv(self):
        """Return the next message, then raise once there is none left.

        Raises:
            ConnectionError: Once every message was delivered.
        """
        await asyncio.sleep(0)
        if self._messages:
            return self._messages.pop(0)
        raise ConnectionError('closed')

    async def close(self):
        """Nothing to release."""


async def test_on_closing_fires_before_a_running_handler_is_waited_for():
    order = []
    released = asyncio.Event()

    async def on_receive(message):
        order.append('handler')
        await released.wait()

    async def on_closing():
        order.append('closing')
        released.set()

    async def on_disconnected(reason, has_error):
        order.append('disconnected')

    transport = TransportWebSocket('ws://localhost:1')
    transport.bind(on_receive=on_receive, on_closing=on_closing, on_disconnected=on_disconnected)
    transport._websocket = _Socket(['{"type": "event", "event": "x"}'])
    transport._connected = True

    # Without on_closing the drain would wait on the handler for ever
    await asyncio.wait_for(transport._run_receive_task(), 2)

    assert order == ['handler', 'closing', 'disconnected']
