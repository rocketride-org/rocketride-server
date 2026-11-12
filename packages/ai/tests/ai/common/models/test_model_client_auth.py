# =============================================================================
# MIT License
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

"""
ModelClient sends the model server's shared secret on the /models handshake.

The SaaS model server refuses /models connections that do not carry
``Authorization: Bearer $RR_MODEL_SERVER_AUTH_TOKEN`` (rocketride-saas #974).
These tests drive the real ModelClient attach path with only websockets.connect
faked, and check what reaches the handshake.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import rocketride.core.transport_websocket as transport_module
from ai.common.models.base import ModelClient

TOKEN_ENV = 'RR_MODEL_SERVER_AUTH_TOKEN'


class _FakeSocket:
    """A connected client socket whose recv() waits until it is closed."""

    def __init__(self):
        """Create the socket with an unset close event."""
        self._closed = asyncio.Event()

    async def recv(self):
        """Block until close(), then report the connection closed.

        Raises:
            ConnectionError: Always, once the socket is closed.
        """
        await self._closed.wait()
        raise ConnectionError('closed')

    async def close(self):
        """Close the socket and release recv()."""
        self._closed.set()


@pytest.fixture
def connect(monkeypatch):
    """Replace websockets in the SDK transport; return the fake connect for inspection."""
    fake = AsyncMock(side_effect=lambda *args, **kwargs: _FakeSocket())
    monkeypatch.setattr(transport_module, 'websockets', SimpleNamespace(__version__='16.0', connect=fake))
    return fake


async def _attach_once(client):
    """Open the transport the way connect() does, then close it again.

    Args:
        client: The ModelClient under test.
    """
    await client._internal_attach()
    await client._transport.disconnect()
    client._transport = None


async def test_token_is_sent_as_bearer_on_the_models_handshake(monkeypatch, connect):
    """With the secret set, the handshake to /models carries it."""
    monkeypatch.setenv(TOKEN_ENV, ' s3cret ')

    await _attach_once(ModelClient('wss://model.example.test:443'))

    args, kwargs = connect.call_args
    assert args[0].endswith('/models')
    assert kwargs.get('additional_headers') == {'Authorization': 'Bearer s3cret'}


async def test_no_token_leaves_the_handshake_unchanged(monkeypatch, connect):
    """Without the secret nothing is added (local dev servers stay reachable)."""
    monkeypatch.delenv(TOKEN_ENV, raising=False)

    await _attach_once(ModelClient('ws://localhost:5590'))

    kwargs = connect.call_args.kwargs
    assert 'additional_headers' not in kwargs
    assert 'extra_headers' not in kwargs


async def test_reconnect_reads_the_current_token(monkeypatch, connect):
    """A reconnect (new transport) sends the token in force at that moment."""
    client = ModelClient('wss://model.example.test:443')
    monkeypatch.setenv(TOKEN_ENV, 'old')
    await _attach_once(client)
    monkeypatch.setenv(TOKEN_ENV, 'new')
    await _attach_once(client)

    sent = [c.kwargs.get('additional_headers') for c in connect.call_args_list]
    assert sent == [{'Authorization': 'Bearer old'}, {'Authorization': 'Bearer new'}]
