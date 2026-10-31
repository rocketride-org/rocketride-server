"""
Authentication of the task's ``/task/data`` WebSocket (T1a).

``AuthMiddleware`` is a ``BaseHTTPMiddleware`` and never sees WebSocket
scopes, so ``DataServer.listen`` checks the run's token itself, before the
socket is accepted. The task knows only the token's SHA-256. These tests
drive a real handshake through Starlette's ``TestClient`` — no network —
and pin the reconnect rule: one live connection at a time, a reconnect
after close accepted.
"""

from __future__ import annotations

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect, WebSocketState

from ai.modules.data import initModule
from ai.modules.data.data_server import CONST_DATA_REFUSED, DataServer

TOKEN = 'run-token-a'


def _sha256(token):
    """Hash a token the way the engine does before putting it on argv.

    Args:
        token: The token.

    Returns:
        str: Its hex SHA-256.
    """
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _client(token):
    """Mount a DataServer expecting ``token`` on a bare FastAPI app.

    Args:
        token: The token the server expects (it is given only its hash);
            None for a task started without one.

    Returns:
        tuple: ``(TestClient, DataServer)``; ``_dapbase_on_connected`` is a spy.
    """
    server = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(target=None)))
    data_server = DataServer(server=server, token_sha256=_sha256(token) if token else None)
    data_server._dapbase_on_connected = AsyncMock()

    app = FastAPI()
    app.add_api_websocket_route('/task/data', data_server.listen)
    return TestClient(app), data_server


def _bearer(token):
    """Build handshake headers carrying ``token``.

    Args:
        token: The value to present.

    Returns:
        dict: An ``Authorization`` header.
    """
    return {'Authorization': f'Bearer {token}'}


def _refused(client, headers=None):
    """Connect and return the close code of a connection refused before accept.

    Args:
        client: The TestClient to connect with.
        headers: Handshake headers, or None for none.

    Returns:
        int: The close code the server sent.
    """
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect('/task/data', headers=headers or {}):
            pass
    return exc.value.code


# ---------------------------------------------------------------------------
# The token
# ---------------------------------------------------------------------------


def test_valid_token_is_accepted():
    """The run's own token opens the channel and creates a connection."""
    client, data_server = _client(TOKEN)

    with client.websocket_connect('/task/data', headers=_bearer(TOKEN)):
        pass

    data_server._dapbase_on_connected.assert_awaited_once()


def test_token_without_bearer_prefix_is_accepted():
    """The prefix is optional, as on every other authenticated route."""
    client, data_server = _client(TOKEN)

    with client.websocket_connect('/task/data', headers={'Authorization': TOKEN}):
        pass

    data_server._dapbase_on_connected.assert_awaited_once()


@pytest.mark.parametrize(
    'headers',
    [
        None,
        {'Authorization': ''},
        {'Authorization': 'Bearer '},
        _bearer('wrong'),
        _bearer(TOKEN + 'x'),
        _bearer(TOKEN[:-1]),
    ],
    ids=['missing', 'empty', 'bearer-only', 'wrong', 'longer', 'shorter'],
)
def test_bad_token_is_refused_before_accept(headers):
    """A missing or wrong token is closed before accept and never reaches a DataConn."""
    client, data_server = _client(TOKEN)

    assert _refused(client, headers) == CONST_DATA_REFUSED
    data_server._dapbase_on_connected.assert_not_awaited()


def test_another_tasks_token_is_refused():
    """Task A's token does not open task B's channel."""
    client_b, data_server_b = _client('run-token-b')

    assert _refused(client_b, _bearer(TOKEN)) == CONST_DATA_REFUSED
    data_server_b._dapbase_on_connected.assert_not_awaited()


def test_the_hash_from_argv_does_not_open_the_channel():
    """Whoever reads the task's argv sees only the hash, and the hash is not the token."""
    client, data_server = _client(TOKEN)

    assert _refused(client, _bearer(_sha256(TOKEN))) == CONST_DATA_REFUSED
    data_server._dapbase_on_connected.assert_not_awaited()


@pytest.mark.parametrize('headers', [None, {'Authorization': ''}, _bearer('None')], ids=['missing', 'empty', 'text'])
def test_task_without_token_refuses_every_connection(headers):
    """A task started without a token fails closed."""
    client, data_server = _client(None)

    assert _refused(client, headers) == CONST_DATA_REFUSED
    data_server._dapbase_on_connected.assert_not_awaited()


def test_non_ascii_authorization_is_refused_not_raised():
    """A header outside ASCII is a mismatch, not an error."""
    _, data_server = _client(TOKEN)

    assert data_server._authorized(SimpleNamespace(headers={'authorization': 'Bearer té'})) is False


def test_non_ascii_expected_hash_is_a_mismatch_not_raised():
    """A malformed hash on argv is a mismatch, not a TypeError from compare_digest."""
    data_server = DataServer(server=SimpleNamespace(), token_sha256='haïsh')

    assert data_server._authorized(SimpleNamespace(headers={'authorization': f'Bearer {TOKEN}'})) is False


# ---------------------------------------------------------------------------
# One live connection at a time
# ---------------------------------------------------------------------------


def test_second_concurrent_connection_is_refused():
    """While the parent's connection is open, a second one is refused."""
    client, data_server = _client(TOKEN)

    with client.websocket_connect('/task/data', headers=_bearer(TOKEN)):
        assert _refused(client, _bearer(TOKEN)) == CONST_DATA_REFUSED

    data_server._dapbase_on_connected.assert_awaited_once()


def test_reconnect_after_close_is_accepted():
    """A dropped data connection is re-established lazily, as today."""
    client, data_server = _client(TOKEN)

    with client.websocket_connect('/task/data', headers=_bearer(TOKEN)):
        pass
    with client.websocket_connect('/task/data', headers=_bearer(TOKEN)):
        pass

    assert data_server._dapbase_on_connected.await_count == 2


def _socket(client_state, application_state):
    """Build a stand-in for the Starlette socket holding the channel.

    Args:
        client_state: The peer side's state.
        application_state: The server side's state.

    Returns:
        MagicMock: An object with the two state attributes.
    """
    return MagicMock(client_state=client_state, application_state=application_state)


@pytest.mark.parametrize(
    'client_state, application_state, busy',
    [
        (WebSocketState.CONNECTING, WebSocketState.CONNECTING, True),
        (WebSocketState.CONNECTED, WebSocketState.CONNECTED, True),
        (WebSocketState.DISCONNECTED, WebSocketState.CONNECTED, False),
        (WebSocketState.CONNECTED, WebSocketState.DISCONNECTED, False),
    ],
    ids=['handshaking', 'open', 'peer-closed', 'server-closed'],
)
def test_channel_is_free_once_the_holder_is_closed(client_state, application_state, busy):
    """A closed holder frees the channel even while its handlers still drain."""
    _, data_server = _client(TOKEN)
    data_server._live = _socket(client_state, application_state)

    assert data_server._channel_busy() is busy


def test_channel_is_free_with_no_holder():
    """No connection yet: the channel is free."""
    _, data_server = _client(TOKEN)

    assert data_server._channel_busy() is False


# ---------------------------------------------------------------------------
# Module wiring
# ---------------------------------------------------------------------------


def test_initModule_hands_the_configured_hash_to_the_server():
    """``use('data', {'token_sha256': ...})`` reaches the DataServer behind /task/data."""
    server = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()), add_socket=MagicMock())

    initModule(server, {'token_sha256': _sha256(TOKEN)})

    path, listener = server.add_socket.call_args.args
    assert path == '/task/data'
    assert listener.__self__._token_sha256 == _sha256(TOKEN)


def test_initModule_without_a_hash_configures_none():
    """No hash in the config: the server refuses every connection."""
    server = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()), add_socket=MagicMock())

    initModule(server, {})

    assert server.add_socket.call_args.args[1].__self__._token_sha256 is None
