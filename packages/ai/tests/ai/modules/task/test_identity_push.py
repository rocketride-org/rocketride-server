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

"""What an identity push does to an open connection.

An account change reaches open connections by a push
(``TaskServer.push_account_update`` / ``push_org_update``): the identity is
rebuilt from the account store and installed. These tests pin the three
outcomes of that rebuild:

- a fresh identity is installed and pushed to the client;
- a user the store no longer has is signed out and disconnected (the
  connection used to keep the identity it held);
- a store that did not answer changes nothing.

The connections are real ``TaskConn`` objects, so the sign-out is the real one.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.task_server import TaskServer

from .test_task_conn import _make_conn
from .test_task_server import _make_server

# =============================================================================
# FIXTURES
# =============================================================================

ORG = 'org-1'


def _identity(user_id: str = 'u1', auth: str = 'rr_session') -> SimpleNamespace:
    """An identity as the account store builds it, reduced to what a push reads."""
    info = SimpleNamespace(userId=user_id, auth=auth, organization={'id': ORG})
    info.to_push_result = lambda: {'userId': user_id, 'userToken': ''}
    return info


def _server_with(monkeypatch, rebuild) -> tuple:
    """A TaskServer whose account store answers a rebuild with ``rebuild`` (a value or an exception)."""
    from ai.account import account as real_account

    service = MagicMock()
    if isinstance(rebuild, BaseException):
        service.get_authentication_result = AsyncMock(side_effect=rebuild)
    else:
        service.get_authentication_result = AsyncMock(return_value=rebuild)
    # raising=False: the default (OSS) facade has no _service; the SaaS one does
    monkeypatch.setattr(real_account, '_service', service, raising=False)

    server = _make_server()
    server._unauthed_by_ip = {}
    store = MagicMock()
    store.close_all_handles = AsyncMock()
    monkeypatch.setattr(TaskServer, 'store', property(lambda self: store))
    return server, service, store


def _connected(server, info, *, connection_id: int = 1):
    """A real, authenticated connection on ``server`` holding ``info``, with one subscription."""
    conn = _make_conn(connection_id=connection_id, account_info=info, server=server)
    conn._monitors = {'*': 1}
    server._connections[connection_id] = conn
    return conn


def _pushed(conn) -> list:
    """The ``apaext_account`` events the connection sent to its client."""
    sent = [call.args[0] for call in conn._transport.send.await_args_list]
    return [m for m in sent if m.get('event') == 'apaext_account']


# =============================================================================
# THE CONNECTION'S SIGN-OUT
# =============================================================================


@pytest.mark.asyncio
async def test_sign_out_identity_ends_the_session_and_closes_the_socket(monkeypatch):
    server, _service, store = _server_with(monkeypatch, None)
    held = _identity()
    conn = _connected(server, held)

    assert await conn.sign_out_identity(held) is True

    assert conn._authenticated is False
    assert conn._account_info is None
    assert conn._monitors == {}
    store.close_all_handles.assert_awaited_once_with(1)
    conn._transport.disconnect.assert_called_once()
    # The unauthenticated slot the login released is held again, so the
    # disconnect handler's release balances
    assert server._unauthed_by_ip == {'127.0.0.1': 1}


@pytest.mark.asyncio
async def test_sign_out_identity_leaves_a_connection_that_acts_as_someone_else(monkeypatch):
    """The decision was about one identity: a newer login on the socket is not signed out."""
    server, _service, store = _server_with(monkeypatch, None)
    newer = _identity('u2')
    conn = _connected(server, newer)

    assert await conn.sign_out_identity(_identity('u1')) is False

    assert conn._authenticated is True
    assert conn._account_info is newer
    assert conn._monitors == {'*': 1}
    store.close_all_handles.assert_not_awaited()
    conn._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
async def test_sign_out_identity_does_nothing_on_a_signed_out_connection(monkeypatch):
    server, _service, _store = _server_with(monkeypatch, None)
    held = _identity()
    conn = _connected(server, held)
    conn._authenticated = False

    assert await conn.sign_out_identity(held) is False

    conn._transport.disconnect.assert_not_called()
    assert server._unauthed_by_ip == {}


# =============================================================================
# THE THREE OUTCOMES OF A REBUILD
# =============================================================================


@pytest.mark.asyncio
async def test_a_push_installs_the_rebuilt_identity_and_tells_the_client(monkeypatch):
    fresh = _identity()
    server, service, _store = _server_with(monkeypatch, fresh)
    held = _identity()
    conn = _connected(server, held)

    await server.push_account_update('u1')

    service.get_authentication_result.assert_awaited_once_with('u1', 'rr_session')
    assert conn._account_info is fresh
    assert [m['body'] for m in _pushed(conn)] == [{'userId': 'u1', 'userToken': ''}]
    conn._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('push', ['user', 'org'])
async def test_a_push_for_a_user_who_is_gone_signs_the_connection_out(monkeypatch, push):
    """The store answers ``ValueError`` for a deleted user: the open socket must not keep acting as them."""
    server, _service, store = _server_with(monkeypatch, ValueError('User u1 not found'))
    held = _identity()
    conn = _connected(server, held)

    if push == 'user':
        await server.push_account_update('u1')
    else:
        await server.push_org_update(ORG)

    assert conn._authenticated is False
    assert conn._account_info is None
    assert conn._monitors == {}
    store.close_all_handles.assert_awaited_once_with(1)
    conn._transport.disconnect.assert_called_once()
    assert _pushed(conn) == []


@pytest.mark.asyncio
async def test_a_push_while_the_store_is_down_changes_nothing(monkeypatch):
    """An outage is not a verdict about the user: the connection keeps its identity and stays open."""
    server, _service, store = _server_with(monkeypatch, RuntimeError('database unavailable'))
    held = _identity()
    conn = _connected(server, held)

    await server.push_account_update('u1')

    assert conn._authenticated is True
    assert conn._account_info is held
    assert conn._monitors == {'*': 1}
    store.close_all_handles.assert_not_awaited()
    conn._transport.disconnect.assert_not_called()
    assert _pushed(conn) == []


@pytest.mark.asyncio
async def test_a_rebuild_is_not_installed_over_a_login_that_landed_meanwhile(monkeypatch):
    fresh = _identity()
    server, service, _store = _server_with(monkeypatch, fresh)
    held = _identity()
    conn = _connected(server, held)
    newer = _identity('u1', auth='rr_other')

    async def rebuild(user_id, auth):
        # The client authenticated again while the store was being read
        conn._account_info = newer
        return fresh

    service.get_authentication_result = AsyncMock(side_effect=rebuild)

    await server.push_account_update('u1')

    assert conn._account_info is newer
    assert _pushed(conn) == []


@pytest.mark.asyncio
async def test_one_gone_user_does_not_stop_the_push_to_the_others(monkeypatch):
    """An org push walks every member: a deleted one is signed out, the rest are refreshed."""
    fresh = _identity('u2')
    server, service, _store = _server_with(monkeypatch, None)
    gone = _connected(server, _identity('u1'), connection_id=1)
    stays = _connected(server, _identity('u2'), connection_id=2)

    async def rebuild(user_id, auth):
        if user_id == 'u1':
            raise ValueError('User u1 not found')
        return fresh

    service.get_authentication_result = AsyncMock(side_effect=rebuild)

    await server.push_org_update(ORG)

    assert gone._account_info is None
    gone._transport.disconnect.assert_called_once()
    assert stays._account_info is fresh
    stays._transport.disconnect.assert_not_called()
    assert len(_pushed(stays)) == 1
