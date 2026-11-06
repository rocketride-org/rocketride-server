"""
TransportWebSocket — extra handshake headers on client connections.

The engine authenticates to a task's data socket with ``Authorization`` on the
handshake. websockets 14 renamed the client keyword that carries such headers
(``extra_headers`` → ``additional_headers``); the SDK supports both.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import rocketride.core.transport_websocket as transport_module
from rocketride.core.transport_websocket import TransportWebSocket


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


def _fake_websockets(monkeypatch, version):
    """Replace the module's websockets with a stub of the given version.

    Args:
        monkeypatch: pytest fixture.
        version: The ``websockets.__version__`` to report.

    Returns:
        AsyncMock: The stub's ``connect``, for inspecting its kwargs.
    """
    connect = AsyncMock(side_effect=lambda *args, **kwargs: _FakeSocket())
    monkeypatch.setattr(transport_module, 'websockets', SimpleNamespace(__version__=version, connect=connect))
    return connect


async def _connect_and_close(transport):
    """Connect the transport, then disconnect it.

    Args:
        transport: The TransportWebSocket under test.
    """
    await transport.connect()
    await transport.disconnect()


@pytest.mark.parametrize(
    'version, keyword, other',
    [
        ('16.0', 'additional_headers', 'extra_headers'),
        ('14.0', 'additional_headers', 'extra_headers'),
        ('13.1', 'extra_headers', 'additional_headers'),
        ('11.0.3', 'extra_headers', 'additional_headers'),
    ],
)
async def test_headers_go_under_the_keyword_of_the_installed_websockets(monkeypatch, version, keyword, other):
    """Headers reach websockets.connect under the name that version accepts."""
    connect = _fake_websockets(monkeypatch, version)
    headers = {'Authorization': 'Bearer t'}

    await _connect_and_close(TransportWebSocket('ws://127.0.0.1:1/task/data', headers=headers))

    kwargs = connect.call_args.kwargs
    assert kwargs[keyword] == headers
    assert other not in kwargs


async def test_no_headers_leaves_the_connect_call_unchanged(monkeypatch):
    """Without headers, neither keyword is passed — the call is as before."""
    connect = _fake_websockets(monkeypatch, '16.0')

    await _connect_and_close(TransportWebSocket('ws://127.0.0.1:1/task/data'))

    kwargs = connect.call_args.kwargs
    assert 'additional_headers' not in kwargs
    assert 'extra_headers' not in kwargs
