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

import asyncio
from unittest.mock import AsyncMock

import pytest
from rocketride import EVENT_TYPE

from ai.account.base import AccountBase
from ai.modules.task import task_conn as task_conn_module
from ai.modules.task import task_server as task_server_module

from ._r972_harness import (
    IP,
    ORG,
    WILDCARD_ALL,
    FakeAccount,
    events,
    identity,
    make_conn,
    make_server,
    never_returns,
)

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
async def test_deauth_detaches_debugger_before_reauth_as_other_user(monkeypatch):
    """A deauthed debugger is detached, so a later re-auth as another user receives nothing."""
    from unittest.mock import MagicMock

    from ai.modules.task.task_engine import Task

    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'))
    task = Task.__new__(Task)
    task.id = 'run-1'
    task._run_log = None
    task._debugger = conn
    task._status = MagicMock()
    task.stamp_log_event = MagicMock()
    task.debug_message = MagicMock()
    server._task_control['run-1'] = MagicMock(task=task)

    await conn.on_deauth(_request('deauth'))
    server._server.authenticate_credential = AsyncMock(return_value=identity('user-b'))
    await conn.on_auth(_request('auth', auth='rr_session'))
    assert conn._account_info.userId == 'user-b'

    conn.sent.clear()
    message = {'event': 'stopped', 'body': {'project_id': 'p', 'runKind': 'dev'}}
    await task._forward_task_event(EVENT_TYPE.DEBUGGER, message)

    assert events(conn, 'stopped') == []
    assert task._debugger is None


def _debugged_task(server, conn):
    """A task whose debugger is ``conn``, registered on ``server``."""
    from unittest.mock import MagicMock

    from ai.modules.task.task_engine import Task

    task = Task.__new__(Task)
    task.id = 'run-1'
    task._run_log = None
    task._debugger = conn
    task._status = MagicMock()
    task.stamp_log_event = MagicMock()
    task.debug_message = MagicMock()
    server._task_control['run-1'] = MagicMock(task=task)
    return task


_STOPPED = {'event': 'stopped', 'body': {'project_id': 'p', 'runKind': 'dev'}}


@pytest.mark.asyncio
async def test_reauth_as_other_user_without_deauth_detaches_debugger(monkeypatch):
    """Re-authenticating as another user on a live socket drops the old debugger."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'))
    task = _debugged_task(server, conn)

    server._server.authenticate_credential = AsyncMock(return_value=identity('user-b'))
    await conn.on_auth(_request('auth', auth='rr_session'))
    assert conn._account_info.userId == 'user-b'

    conn.sent.clear()
    await task._forward_task_event(EVENT_TYPE.DEBUGGER, _STOPPED)

    assert task._debugger is None
    assert events(conn, 'stopped') == []


@pytest.mark.asyncio
async def test_reauth_as_same_user_keeps_debugger(monkeypatch):
    """Refreshing the same identity does not detach the debugger."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'))
    task = _debugged_task(server, conn)

    server._server.authenticate_credential = AsyncMock(return_value=identity('user-a'))
    await conn.on_auth(_request('auth', auth='rr_session'))

    conn.sent.clear()
    await task._forward_task_event(EVENT_TYPE.DEBUGGER, _STOPPED)

    assert task._debugger is conn
    assert events(conn, 'stopped')


@pytest.mark.asyncio
async def test_reauth_as_other_user_clears_monitors(monkeypatch):
    """The previous identity's event subscriptions do not survive a user switch."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'), monitors=WILDCARD_ALL)
    assert conn._monitors

    server._server.authenticate_credential = AsyncMock(return_value=identity('user-b'))
    await conn.on_auth(_request('auth', auth='rr_session'))

    assert conn._account_info.userId == 'user-b'
    assert not conn._monitors


@pytest.mark.asyncio
async def test_reauth_switch_closes_old_identity_before_detaching(monkeypatch):
    """While the old debugger is being detached, the old identity can no longer act."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'), monitors=WILDCARD_ALL)
    seen = {}
    real = conn._detach_debuggers

    async def detach_and_probe():
        await asyncio.sleep(0)
        seen['authenticated'] = conn._authenticated
        seen['monitors'] = dict(conn._monitors)
        conn.sent.clear()
        await conn.on_receive({'type': 'request', 'seq': 9, 'command': 'rrext_process', 'arguments': {}})
        seen['replies'] = list(conn.sent)
        await real()

    conn._detach_debuggers = detach_and_probe
    server._server.authenticate_credential = AsyncMock(return_value=identity('user-b'))
    slots = dict(server._unauthed_by_ip)
    await conn.on_auth(_request('auth', auth='rr_session'))

    assert seen['authenticated'] is False
    assert seen['monitors'] == {}
    assert seen['replies'] and all(m.get('success') is False for m in seen['replies'])
    assert conn._authenticated and conn._account_info.userId == 'user-b'
    assert server._unauthed_by_ip == slots


@pytest.mark.asyncio
async def test_reauth_same_user_other_credential_kind_detaches_debugger(monkeypatch):
    """A tk_ credential carries the launcher's userId: switching kind is a switch."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'), monitors=WILDCARD_ALL)
    task = _debugged_task(server, conn)

    server._server.authenticate_credential = AsyncMock(return_value=identity('user-a', auth='tk_' + 'x' * 32))
    await conn.on_auth(_request('auth', auth='tk_' + 'x' * 32))

    conn.sent.clear()
    await task._forward_task_event(EVENT_TYPE.DEBUGGER, _STOPPED)
    assert task._debugger is None
    assert events(conn, 'stopped') == []
    assert not conn._monitors


@pytest.mark.asyncio
async def test_reauth_same_user_same_credential_kind_keeps_debugger(monkeypatch):
    """Two different full-user sessions of one user are the same identity."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('user-a'))
    task = _debugged_task(server, conn)

    server._server.authenticate_credential = AsyncMock(return_value=identity('user-a', auth='rr_other'))
    await conn.on_auth(_request('auth', auth='rr_other'))

    assert task._debugger is conn


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


# ---------------------------------------------------------------------------
# Review fixes: bounded notices, no install over a deauth
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1a_revoke_notice_is_bounded_and_always_disconnects(monkeypatch):
    """A client that stopped reading cannot hold revoke: the notice times out and
    the socket is still disconnected.
    """
    monkeypatch.setattr(task_conn_module, 'NOTICE_SEND_TIMEOUT', 0.05)
    account = FakeAccount({'admin': (False, ADMIN)})
    server = make_server(account, monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN))
    conn._transport.send = never_returns

    await asyncio.wait_for(server.push_account_update('admin'), 1)

    conn._transport.disconnect.assert_called_once()
    assert conn._authenticated is False


@pytest.mark.asyncio
async def test_r972_1a_push_install_send_is_bounded(monkeypatch):
    """The identity push's own notice is bounded too: one stuck client does not
    hold the push for the next connection.
    """
    monkeypatch.setattr(task_conn_module, 'NOTICE_SEND_TIMEOUT', 0.05)
    monkeypatch.setattr(task_server_module, 'NOTICE_SEND_TIMEOUT', 0.05)
    account = FakeAccount({'u': (True, frozenset({'sys.view'}))})
    server = make_server(account, monkeypatch)
    stuck = make_conn(server, identity('u', {'sys.view'}), connection_id=1)
    stuck._transport.send = never_returns
    other = make_conn(server, identity('u', {'sys.view'}), connection_id=2)

    await asyncio.wait_for(server.push_account_update('u'), 1)

    assert events(other, 'apaext_account')
    stuck._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('perms', [frozenset(), ADMIN], ids=['non-subject', 'subject'])
async def test_r972_1a_push_never_installs_over_a_deauth(monkeypatch, perms):
    """A socket deauthed while its rebuild was awaited keeps the bare identity."""
    account = FakeAccount({'u': (True, perms)})
    server = make_server(account, monkeypatch)
    conn = make_conn(server, identity('u', perms), monitors=WILDCARD_ALL)
    account.during_rebuild = lambda: conn._drop_authority()

    await server.push_account_update('u')

    assert conn._authenticated is False
    assert conn._account_info.userId == ''
    assert conn._account_info.sysPermissions == []
    assert events(conn, 'apaext_account') == []


@pytest.mark.asyncio
async def test_r972_deauth_disconnect_event_stays_user_scoped(monkeypatch):
    """A deauthed socket's connection_removed is scoped to its former user, not ''."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN), monitors=WILDCARD_ALL)

    await conn.on_deauth(_request('deauth'))
    server.broadcast_server_event = AsyncMock()
    await server._dapbase_on_disconnected(conn)

    assert server.broadcast_server_event.call_args.kwargs['user_id'] == 'admin'


@pytest.mark.asyncio
async def test_r972_empty_user_id_disconnect_event_stays_scoped(monkeypatch):
    """A never-deauthed connection with userId '' disconnects scoped to '', not None."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('', []), monitors=WILDCARD_ALL)

    server.broadcast_server_event = AsyncMock()
    await server._dapbase_on_disconnected(conn)

    assert server.broadcast_server_event.call_args.kwargs['user_id'] == ''


@pytest.mark.asyncio
async def test_r972_reauth_after_deauth_scopes_disconnect_event_to_new_user(monkeypatch):
    """A socket that deauths then re-auths as someone else reports its removal to the new user."""
    server = make_server(FakeAccount(), monkeypatch)
    conn = make_conn(server, identity('admin', ADMIN))

    await conn.on_deauth(_request('deauth'))

    async def authenticate_credential(credential):
        return identity('bob', ADMIN)

    server._server.authenticate_credential = authenticate_credential
    await conn.on_auth(_request('auth', auth='rr_session'))
    assert conn._authenticated is True
    assert conn._account_info.userId == 'bob'

    server.broadcast_server_event = AsyncMock()
    await server._dapbase_on_disconnected(conn)

    assert server.broadcast_server_event.call_args.kwargs['user_id'] == 'bob'
