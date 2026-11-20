"""Presenting-key liveness on open sockets, independent of cached user permissions."""

import asyncio
import hashlib
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.base import AccountBase
from ai.account.models import AccountInfo
from ai.modules.task.authz_recheck import AuthzRecheck, THRESHOLD, validate_credential_provider
from ai.modules.task.task_server import TaskServer

from ._r972_harness import FakeAccount, WILDCARD_ALL, identity, make_conn, make_server
from .test_r972_authz_recheck import (
    _deploy_event_delivered,
    _dispatched,
    _request,
    _server_event_delivered,
    _sweep,
    _task_event_reached,
)


def digest(credential):
    return hashlib.sha256(credential.encode()).hexdigest()


class Clocks:
    monotonic = 1000.0
    utc = 1800000000.0

    def clock(self):
        return self.monotonic

    def wall(self):
        return self.utc


class LiveAccount(FakeAccount):
    supports_live_credentials = True

    def __init__(self):
        super().__init__({'member': (True, frozenset()), 'admin': (True, frozenset({'sys.admin'}))})
        self.keys = {}
        self.key_reads = []
        self.fail_keys = False
        self.during_keys = None

    async def live_credentials(self, hashes):
        self.key_reads.append(list(hashes))
        if self.during_keys is not None:
            await self.during_keys()
        if self.fail_keys:
            raise RuntimeError('unavailable; rr_do-not-log-this-token')
        return {key: self.keys[key] for key in hashes if key in self.keys}


def setup(monkeypatch, account=None):
    account = account or LiveAccount()
    server = make_server(account, monkeypatch)
    clocks = Clocks()
    server._authz = AuthzRecheck(server, account, clock=clocks.clock, rng=lambda: 0.5)
    server._authz._wall_clock = clocks.wall
    return account, server, clocks


def connection(server, user='member', *, auth='rr_member', connection_id=1, permissions=()):
    conn = make_conn(server, identity(user, permissions, auth=auth), connection_id=connection_id, monitors=WILDCARD_ALL)
    conn.on_launch = AsyncMock(return_value=None)
    return conn


@pytest.mark.asyncio
async def test_ordinary_socket_stops_at_known_expiry_before_the_next_sweep(monkeypatch):
    account, server, clocks = setup(monkeypatch)
    conn = connection(server)
    account.keys[digest(conn._account_info.auth)] = ('member', clocks.utc + 1)
    await _sweep(server)
    assert await _dispatched(conn)

    # No periodic sweep or monotonic staleness is needed at the absolute bound.
    clocks.utc += 1
    assert not server._authz.gate_ok(conn)
    assert not await _dispatched(conn)
    assert not await _server_event_delivered(conn)
    assert not await _task_event_reached(conn)
    assert not await _deploy_event_delivered(server, conn)
    conn.sent.clear()
    await conn.send_event('apaext_org_changed', body={'orgId': 'private-org'})
    await conn.send({'type': 'event', 'event': 'future-notification', 'body': {'private': 'value'}})
    assert conn.sent == []
    assert account.reads == []  # a plain user did not need sys-authority reads


@pytest.mark.asyncio
@pytest.mark.parametrize('action', ['revoke', 'deauth'])
async def test_prepared_account_event_is_denied_after_authority_is_dropped(monkeypatch, action):
    account, server, _ = setup(monkeypatch)
    conn = connection(server)
    info = conn._account_info
    account.keys[digest(info.auth)] = ('member', None)
    await _sweep(server)
    prepared = info.to_push_result()
    queued = asyncio.create_task(conn.send_event('apaext_account', body=prepared))
    if action == 'revoke':
        assert conn.revoke_authority(info, 'test credential revoked')
    else:
        conn._drop_authority()
    await queued
    assert conn.sent == []
    if action == 'revoke':
        await conn.send_revoke_notice(pushed=info)
        assert len(conn.sent) == 1
        assert conn.sent[0]['body'] == AccountInfo(waitlisted=True).to_push_result()
        conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_revocation_of_one_key_reaches_other_replica_and_leaves_sibling_key(monkeypatch):
    account = LiveAccount()
    _, first, _ = setup(monkeypatch, account)
    _, second, _ = setup(monkeypatch, account)
    revoked = connection(first, auth='rr_revoked')
    same_key = connection(second, auth='rr_revoked')
    sibling = connection(second, auth='rr_sibling', connection_id=2)
    account.keys = {digest(key): ('member', None) for key in ('rr_revoked', 'rr_sibling')}
    await _sweep(first)
    await _sweep(second)
    del account.keys[digest('rr_revoked')]  # revoked, deleted, or cap-evicted by another replica
    await _sweep(first)
    await _sweep(second)
    for conn in (revoked, same_key):
        assert not conn._authenticated
        conn._transport.disconnect.assert_called_once()
        assert not await _dispatched(conn)
    assert sibling._authenticated
    assert await _dispatched(sibling)
    assert account._service.rebuilds == []


@pytest.mark.asyncio
@pytest.mark.parametrize('record', [('another-user', None), ('member', float('nan')), ('member', True), ('member', -1)])
async def test_wrong_owner_or_invalid_deadline_revokes_without_granting_scope(monkeypatch, record):
    account, server, _ = setup(monkeypatch)
    conn = connection(server)
    account.keys[digest('rr_member')] = record
    await _sweep(server)
    assert not conn._authenticated
    conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_scoped_pat_is_verified_without_replacing_cached_permissions(monkeypatch):
    account, server, _ = setup(monkeypatch)
    conn = connection(server, auth='rr_scoped')
    info = conn._account_info
    info.organization['permissions'] = []
    account.rows['member'] = (True, frozenset({'sys.admin'}))
    account.keys[digest('rr_scoped')] = ('member', None)
    await _sweep(server)
    assert conn._account_info is info
    assert info.sysPermissions == []
    assert info.organization['permissions'] == []
    assert account.reads == []
    assert account.key_reads == [[digest('rr_scoped')]]
    assert 'rr_scoped' not in repr(account.key_reads)


@pytest.mark.asyncio
async def test_database_failure_blocks_plain_user_requests_and_all_event_paths(monkeypatch):
    account, server, clocks = setup(monkeypatch)
    conn = connection(server)
    account.keys[digest('rr_member')] = ('member', None)
    await _sweep(server)
    account.fail_keys = True
    clocks.monotonic += THRESHOLD + 0.01
    warnings = []
    from ai.modules.task import authz_recheck

    monkeypatch.setattr(authz_recheck, 'warning', warnings.append)
    await _sweep(server)
    assert not await _dispatched(conn)
    assert not await _server_event_delivered(conn)
    assert not await _task_event_reached(conn)
    assert not await _deploy_event_delivered(server, conn)
    conn.sent.clear()
    await conn.send_event('apaext_account', body={'private': 'value'})
    await conn.send({'type': 'event', 'event': 'future-notification', 'body': {'private': 'value'}})
    assert conn.sent == []
    assert 'rr_do-not-log-this-token' not in repr(warnings)
    account.fail_keys = False
    await _sweep(server)
    assert await _dispatched(conn)


@pytest.mark.asyncio
@pytest.mark.parametrize('failed_read', ['authority', 'credentials'])
async def test_admin_authority_and_credential_stamps_are_independent(monkeypatch, failed_read):
    account, server, clocks = setup(monkeypatch)
    conn = connection(server, 'admin', auth='rr_admin', permissions={'sys.admin'})
    account.keys[digest('rr_admin')] = ('admin', None)
    await _sweep(server)
    clocks.monotonic += THRESHOLD + 0.01
    account.fail = failed_read == 'authority'
    account.fail_keys = failed_read == 'credentials'
    await _sweep(server)
    assert not server._authz.gate_ok(conn)
    if failed_read == 'authority':
        assert conn._credential_verified_at == clocks.monotonic
        assert conn._authz_verified_at < clocks.monotonic
    else:
        assert conn._authz_verified_at == clocks.monotonic
        assert conn._credential_verified_at < clocks.monotonic


@pytest.mark.asyncio
async def test_account_push_cannot_refresh_presenting_key_liveness(monkeypatch):
    account, server, clocks = setup(monkeypatch)
    conn = connection(server, 'admin', auth='rr_admin', permissions={'sys.admin'})
    account.keys[digest('rr_admin')] = ('admin', None)
    await _sweep(server)
    clocks.monotonic += THRESHOLD + 0.01
    await server.push_account_update('admin')
    assert conn._authz_verified_at == clocks.monotonic
    assert conn._credential_verified_at < clocks.monotonic
    assert not server._authz.gate_ok(conn)


@pytest.mark.asyncio
async def test_a_stale_read_cannot_revoke_a_new_identity(monkeypatch):
    account, server, _ = setup(monkeypatch)
    conn = connection(server, auth='rr_old')
    replacement = identity('member', auth='rr_new')

    async def replace():
        conn._account_info = replacement

    account.during_keys = replace
    await _sweep(server)
    assert conn._account_info is replacement
    assert conn._authenticated
    conn._transport.disconnect.assert_not_called()
    assert not server._authz.gate_ok(conn)  # the new key must be independently verified


@pytest.mark.asyncio
async def test_hung_key_read_is_bounded_and_keeps_gate_closed(monkeypatch):
    from ai.modules.task import authz_recheck

    monkeypatch.setattr(authz_recheck, 'R', 0.01)
    account, server, _ = setup(monkeypatch)
    conn = connection(server)

    async def stuck():
        await asyncio.Event().wait()

    account.during_keys = stuck
    await asyncio.wait_for(_sweep(server), 1.5)
    assert not server._authz.gate_ok(conn)


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['live', 'wrong-owner', 'expired', 'unavailable'])
async def test_auth_installs_only_a_verified_key_and_its_expiry(monkeypatch, mode):
    account, server, clocks = setup(monkeypatch)
    result = identity('member', auth='rr_new')
    conn = make_conn(server, None)
    server._server.authenticate_credential = AsyncMock(return_value=result)
    server.broadcast_server_event = AsyncMock()
    account.keys[digest('rr_new')] = (
        'another' if mode == 'wrong-owner' else 'member',
        clocks.utc - 1 if mode == 'expired' else clocks.utc + 1,
    )
    account.fail_keys = mode == 'unavailable'
    await conn.on_auth(_request('auth', auth='rr_new'))
    assert conn._authenticated is (mode == 'live')
    if mode == 'live':
        assert conn._credential_expires_at == clocks.utc + 1
        clocks.utc += 1
        assert not server._authz.gate_ok(conn)
    else:
        conn._transport.disconnect.assert_called_once()


def test_hosted_overlay_cannot_silently_omit_the_liveness_provider():
    class Unimplemented(AccountBase):
        capabilities = ('saas',)
        supports_live_credentials = True

        async def authenticate(self, credential):
            return (401, 'no')

    with pytest.raises(RuntimeError, match='must enable live credential'):
        validate_credential_provider(FakeAccount())
    with pytest.raises(RuntimeError, match='must implement live_credentials'):
        validate_credential_provider(Unimplemented())
    validate_credential_provider(LiveAccount())


def test_old_saas_overlay_fails_before_task_server_starts_background_tasks(monkeypatch):
    import ai.account

    monkeypatch.setattr(ai.account, 'account', FakeAccount())
    with pytest.raises(RuntimeError, match='live credential'):
        TaskServer(MagicMock())
