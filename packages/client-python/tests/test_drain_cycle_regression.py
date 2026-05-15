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

"""Regression tests for the disconnect-cycle bug.

The bug manifests as
  RecursionError: maximum recursion depth exceeded
inside _GatheringFuture.cancel during shutdown / cancellation. Root cause is
a cycle in asyncio's await graph formed when a handler awaits the transport
disconnect while it is itself a member of _message_tasks.

Two complementary regression tests, each pinning a different fix:

- test_drain_cycle_does_not_recurse:
    Builds the smallest task graph that exhibits the cycle. Pinned by Fix A:
    `_drain_message_tasks` must filter out tasks whose await-chain reaches
    the drainer.

- test_request_does_not_await_self_disconnect_on_connection_error:
    Asserts dap_client.request()'s ConnectionError handler does not await
    self.disconnect(). Pinned by Fix C: the line should be the
    fire-and-forget self._transport.disconnect() form.

Both tests are expected to FAIL on current (pre-fix) develop.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride.core.dap_client import DAPClient
from rocketride.core.transport_websocket import TransportWebSocket


async def test_drain_cycle_does_not_recurse():
    """A handler awaiting transport.disconnect() must not deadlock or recurse.

    Pre-fix: _drain_message_tasks gathers over _message_tasks without
    excluding the task that is awaiting the drainer. The structure
    X -> Y -> G -> X forms; cancellation walks it until RecursionError.

    Post-Fix-A: the drain filters X out of `pending`; gather is empty;
    Y returns; X resumes; everything completes within milliseconds.
    """
    transport = TransportWebSocket()
    transport._connected = True
    transport._websocket = object()  # any truthy placeholder

    async def handler():
        await transport.disconnect()

    X = asyncio.create_task(handler())
    transport._message_tasks.add(X)
    X.add_done_callback(transport._on_message_task_done)

    # Poll for completion. Avoid asyncio.wait_for here: when the cycle deadlocks
    # the task, wait_for's own cancel-on-timeout walks the same cycle and can
    # itself wedge — making the test hang at the harness-level timeout instead
    # of failing cleanly.
    for _ in range(40):  # 40 * 0.05s = 2.0s budget
        if X.done():
            # Surface any exception X raised (e.g., RecursionError from the cycle).
            X.result()
            return
        await asyncio.sleep(0.05)

    pytest.fail('drain did not complete within 2s — self-await cycle deadlocked')


async def test_request_does_not_await_self_disconnect_on_connection_error():
    """request()'s ConnectionError handler must not await self.disconnect().

    Pre-fix dap_client.py:250 does `await self.disconnect()` -- this closes
    the cycle when request() runs inside a _message_tasks handler.

    Post-Fix-C the line is `self._transport.disconnect()` (fire-and-forget,
    relies on develop's sync-returns-Task disconnect). self.disconnect() is
    never reached.
    """
    client = DAPClient(transport=_make_fake_transport())
    client._authenticated = True

    # Spy on the DAPClient-level disconnect. Pre-fix code awaits this; Fix C
    # bypasses it in favour of self._transport.disconnect().
    client.disconnect = AsyncMock(name='DAPClient.disconnect')

    # When request() calls _send, immediately fail the pending future so the
    # subsequent `await future` raises ConnectionError, hitting the except
    # block under test.
    async def fake_send(message):
        seq = message['seq']
        fut = client._pending_requests.get(seq)
        if fut is not None and not fut.done():
            fut.set_exception(ConnectionError('simulated peer drop'))

    client._send = fake_send

    request = {'command': 'pause', 'type': 'request', 'seq': 42}

    with pytest.raises(ConnectionError):
        await client.request(request)

    # Pre-fix: client.disconnect is called. Post-Fix-C: it is not.
    client.disconnect.assert_not_called()


def _make_fake_transport():
    """Minimal transport mock satisfying DAPClient construction + request()."""
    transport = MagicMock(name='FakeTransport')
    transport.is_connected = MagicMock(return_value=True)
    # develop's transport.disconnect is sync and returns asyncio.Task.
    transport.disconnect = MagicMock(return_value=MagicMock(name='FakeDisconnectTask'))
    transport.send = AsyncMock()
    return transport
