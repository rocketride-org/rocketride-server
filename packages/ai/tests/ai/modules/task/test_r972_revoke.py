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


"""#972 PR 1a: a failed or narrowing identity push revokes; deauth drops events.

A connection holding platform authority (non-empty ``sysPermissions``, not
``pk_``/``tk_``) must not keep its old identity when the push that should
refresh it finds the user disabled, demoted, deleted, or cannot rebuild it:
the connection is revoked (bare identity, subscriptions dropped, closed).
A deauthed socket must stop receiving server events and stay re-usable.

E-tests reproduce the gap through today's names and fail on an assertion
before the fix; the rest pin the new revoke contract.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from rocketride import EVENT_TYPE

from ai.account.base import AccountBase

from ._r972_harness import IP, ORG, WILDCARD_ALL, FakeAccount, events, identity, make_conn, make_server

ADMIN = frozenset({'sys.admin'})


def _request(command: str, **arguments) -> dict:
    return {'type': 'request', 'seq': 1, 'command': command, 'arguments': arguments}


# ---------------------------------------------------------------------------
# E2, E3, E6, E8: red before the fix
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1a_push_disabled_rebuild_revokes_admin(monkeypatch):
    """E2: a push whose rebuild says "disabled" closes the admin's socket."""
    account = FakeAccount({'admin': (False, ADMIN)})
    server = make_server(account, monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN), monitors=WILDCARD_ALL)
    slots_before = dict(server._unauthed_by_ip)

    await server.push_account_update('admin')

    conn._transport.disconnect.assert_called_once()
    assert conn._monitors == {}
    assert conn._authenticated is False
    assert conn._account_info.sysPermissions == []
    # The disconnect cleanup balances the slot revoke re-acquired.
    await server._dapbase_on_disconnected(conn)
    assert server._unauthed_by_ip == slots_before


@pytest.mark.asyncio
@pytest.mark.parametrize('push', ['user', 'org'])
async def test_r972_1a_push_rebuild_error_revokes_subject_only(monkeypatch, push):
    """E3: with no live re-check, a rebuild that raises revokes a subject only."""
    account = FakeAccount({'admin': (True, ADMIN), 'plain': (True, frozenset())})
    account.fail_rebuild = RuntimeError('database unavailable')
    server = make_server(account, monkeypatch)
    admin = make_conn(server, identity('admin', ADMIN), connection_id=1, monitors=WILDCARD_ALL)
    plain = make_conn(server, identity('plain'), connection_id=2, monitors=WILDCARD_ALL)
    plain_info = plain._account_info

    if push == 'user':
        await server.push_account_update('admin')
        await server.push_account_update('plain')
    else:
        await server.push_org_update(ORG)

    admin._transport.disconnect.assert_called_once()
    assert admin._authenticated is False
    assert admin._account_info.sysPermissions == []
    assert admin._monitors == {}
    plain._transport.disconnect.assert_not_called()
    assert plain._authenticated is True
    assert plain._account_info is plain_info
    assert plain._monitors == WILDCARD_ALL


@pytest.mark.asyncio
async def test_r972_1a_deauth_drops_events_and_allows_reauth(monkeypatch):
    """E6: after deauth no org- or user-scoped server event is delivered; re-auth works."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN), monitors=WILDCARD_ALL)

    await conn.on_deauth(_request('deauth'))
    conn.sent.clear()
    await conn.send_server_event(
        EVENT_TYPE.DASHBOARD, {'event': 'apaevt_dashboard', 'body': {'n': 1}}, org_id='org-other'
    )
    await conn.send_server_event(EVENT_TYPE.BILLING, {'event': 'apaevt_billing', 'body': {'n': 2}}, user_id='other')
    assert events(conn) == []
    assert server._unauthed_by_ip == {IP: 1}

    server._server.authenticate_credential = AsyncMock(return_value=identity('admin', ADMIN))
    response = await conn.on_auth(_request('auth', auth='rr_session'))
    assert response['type'] == 'response' and response.get('success', True)
    assert conn._authenticated is True
    assert conn._account_info.userId == 'admin'
    assert server._unauthed_by_ip == {}


@pytest.mark.asyncio
async def test_r972_1a_self_demotion_revokes_caller_and_scopes_removal(monkeypatch):
    """E8: a SaaS-shaped push after self-demotion revokes the caller's socket;
    its ``connection_removed`` event still carries the original user.
    """
    account = FakeAccount({'admin': (True, frozenset())})  # the row after the commit
    server = make_server(account, monkeypatch)
    caller = make_conn(server, identity('admin', ADMIN), monitors=WILDCARD_ALL)

    await server.push_account_update('admin')

    caller._transport.disconnect.assert_called_once()
    pushed = events(caller, 'apaext_account')
    assert pushed and pushed[-1]['body']['sysPermissions'] == []
    server.broadcast_server_event = AsyncMock()
    await server._dapbase_on_disconnected(caller)
    removed = server.broadcast_server_event.call_args
    assert removed.args[1]['body']['action'] == 'connection_removed'
    assert removed.kwargs['user_id'] == 'admin'


# ---------------------------------------------------------------------------
# New revoke contract (green only)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1a_push_value_error_revokes(monkeypatch):
    """A deleted user (rebuild raises ValueError) is revoked."""
    server = make_server(FakeAccount({}), monkeypatch)
    conn = make_conn(server, identity('gone', ADMIN))

    await server.push_account_update('gone')

    conn._transport.disconnect.assert_called_once()
    assert conn._revoked is True


@pytest.mark.asyncio
async def test_r972_1a_push_unchanged_or_widened_keeps_connection(monkeypatch):
    """Control: an unchanged or widened rebuild is installed and pushed, never revoked."""
    account = FakeAccount({'admin': (True, ADMIN), 'viewer': (True, frozenset({'sys.view', 'sys.app'}))})
    server = make_server(account, monkeypatch)
    admin = make_conn(server, identity('admin', ADMIN), connection_id=1)
    viewer = make_conn(server, identity('viewer', {'sys.view'}), connection_id=2)

    await server.push_account_update('admin')
    await server.push_account_update('viewer')

    for conn in (admin, viewer):
        conn._transport.disconnect.assert_not_called()
        assert conn._authenticated is True
        assert events(conn, 'apaext_account')
    assert viewer._account_info.sysPermissions == ['sys.app', 'sys.view']


@pytest.mark.asyncio
async def test_r972_1a_push_skips_task_scoped_and_unauthenticated(monkeypatch):
    """L3 (pushes): pk_/tk_ and unauthenticated connections are never rebuilt or revoked."""
    account = FakeAccount({'admin': (False, ADMIN)})
    server = make_server(account, monkeypatch)
    task = make_conn(server, identity('admin', ADMIN, auth='tk_task'), connection_id=1)
    public = make_conn(server, identity('admin', ADMIN, auth='pk_public'), connection_id=2)
    idle = make_conn(server, identity('admin', ADMIN), connection_id=3)
    idle._authenticated = False

    await server.push_account_update('admin')
    await server.push_org_update(ORG)

    assert account._service.rebuilds == []
    for conn in (task, public, idle):
        conn._transport.disconnect.assert_not_called()
        assert conn._revoked is False


@pytest.mark.asyncio
async def test_r972_1a_revoke_gone_or_replaced_is_noop(monkeypatch):
    """N5: revoking a connection already gone, or whose identity was replaced,
    changes nothing; a second revoke does not re-acquire the slot.
    """
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN))
    info = conn._account_info

    await conn.revoke(identity('admin', ADMIN), 'stale expectation')
    assert conn._revoked is False and conn._authenticated is True

    await conn.revoke(info, 'first')
    await conn.revoke(conn._account_info, 'second')
    assert server._unauthed_by_ip == {IP: 1}
    conn._transport.disconnect.assert_called_once()

    gone = make_conn(server, identity('other', ADMIN), connection_id=7)
    gone_info = gone._account_info
    await server._dapbase_on_disconnected(gone)
    slots = dict(server._unauthed_by_ip)
    await gone.revoke(gone_info, 'after disconnect')
    assert server._unauthed_by_ip == slots
    assert gone._revoked is False
    gone._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
async def test_r972_1a_revoke_during_auth_await_stays_unauthenticated(monkeypatch):
    """N6: a revoke landing while on_auth awaits the credential check wins."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN))
    info = conn._account_info

    async def authenticate_credential(credential):
        await conn.revoke(info, 'race')
        return identity('admin', ADMIN)

    server._server.authenticate_credential = authenticate_credential
    response = await conn.on_auth(_request('auth', auth='rr_session'))

    assert response is None
    assert conn._authenticated is False
    assert conn._account_info.userId == ''
    assert any(m.get('message') == 'Connection revoked' for m in conn.sent)
    assert server._unauthed_by_ip == {IP: 1}


@pytest.mark.asyncio
async def test_r972_1a_rebuild_account_info_default(monkeypatch):
    """N7: the base rebuild uses the edition's _service, else returns None (push skips)."""
    account = FakeAccount({'u': (True, frozenset({'sys.view'}))})
    fresh = await account.rebuild_account_info(identity('u', {'sys.view'}))
    assert fresh.userId == 'u' and fresh.sysPermissions == ['sys.view']

    class _Bare(AccountBase):
        async def authenticate(self, credential):
            return (401, 'no')

    bare = _Bare()
    assert await bare.rebuild_account_info(identity('u', {'sys.view'})) is None

    server = make_server(bare, monkeypatch)
    conn = make_conn(server, identity('u', {'sys.view'}))
    info = conn._account_info
    await server.push_account_update('u')
    assert conn._account_info is info
    assert conn._revoked is False
    assert events(conn) == []


@pytest.mark.asyncio
async def test_r972_1a_revoked_write_is_refused_and_handles_close(monkeypatch):
    """L6: after a revoke the next store request is refused; the disconnect
    cleanup still closes (commits) the connection's open handles.
    """
    account = FakeAccount({'admin': (False, ADMIN)})
    server = make_server(account, monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN))

    await server.push_account_update('admin')
    conn.sent.clear()
    await conn.on_receive(_request('rrext_store', subcommand='fs_write', handle='h1', data='eA=='))

    assert conn.sent and conn.sent[-1]['message'] == 'Not authenticated'
    await server._dapbase_on_disconnected(conn)
    server.store_stub.close_all_handles.assert_awaited_once_with(conn.get_connection_id())
