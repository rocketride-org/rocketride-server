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


"""#972 PR 1b: the live re-check of platform authority and its gate.

Revocations that never push (another replica, a CLI tool, direct SQL) are
caught by ``AuthzRecheck``: one batched ``live_authority`` read per sweep
revokes any subject whose row is gone, disabled or narrower, and the gate
refuses requests and events on a subject not verified within THRESHOLD
(10 s), so a database outage freezes admin authority instead of leaving it
live. Fake account, fake monotonic clock; sweeps are driven directly.

E-tests (E1, E5) fail on an assertion before the fix: without a re-check
the unverified subject's request is dispatched and its events delivered.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from rocketride import EVENT_TYPE

from ai.modules.task import deploy_events
from ai.modules.task.task_server import TaskServer

from ._r972_harness import WILDCARD_ALL, FakeAccount, events, identity, make_conn, make_server, never_returns

try:
    from ai.modules.task import authz_recheck
    from ai.modules.task.authz_recheck import THRESHOLD, AuthzRecheck
except ImportError:  # before PR 1b there is no re-check: nothing ever refuses
    authz_recheck = None
    AuthzRecheck = None
    THRESHOLD = 10.0

ADMIN = frozenset({'sys.admin'})
DASHBOARD = {'event': 'apaevt_dashboard', 'body': {'n': 1}}


class _Clock:
    """Monotonic clock stand-in."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def _attach(server: TaskServer, account: FakeAccount, clock: _Clock) -> None:
    """Give ``server`` the live re-check the SaaS edition gets in __init__."""
    if AuthzRecheck is not None:
        server._authz = AuthzRecheck(server, account, clock=clock, rng=lambda: 0.5)


def _setup(monkeypatch, rows):
    account = FakeAccount(rows)
    server = make_server(account, monkeypatch)
    clock = _Clock()
    _attach(server, account, clock)
    return account, server, clock


def _admin(server, clock, user='admin', perms=ADMIN, *, connection_id=1, verified=True, **kw):
    conn = make_conn(server, identity(user, perms, **kw), connection_id=connection_id, monitors=WILDCARD_ALL)
    conn._authz_verified_at = clock.now if verified else 0.0
    conn.on_launch = AsyncMock(return_value=None)
    return conn


async def _sweep(server) -> None:
    """One sweep, then let its revoke notices (independent tasks) finish."""
    await server._authz.sweep_once()
    await asyncio.gather(*list(getattr(server._authz, '_notices', ())))


def _request(command: str, **arguments) -> dict:
    return {'type': 'request', 'seq': 1, 'command': command, 'arguments': arguments}


async def _dispatched(conn) -> bool:
    """Send ``launch``; True when the handler ran."""
    before = conn.on_launch.await_count
    await conn.on_receive(_request('launch'))
    return conn.on_launch.await_count > before


async def _server_event_delivered(conn) -> bool:
    conn.sent.clear()
    await conn.send_server_event(EVENT_TYPE.DASHBOARD, DASHBOARD)
    return bool(events(conn))


async def _task_event_reached(conn) -> bool:
    """True when send_task_event got past the gate (it then looks the task up)."""
    conn._server.get_task_control = MagicMock(side_effect=LookupError('reached'))
    try:
        await conn.send_task_event(EVENT_TYPE.SUMMARY, 'tk_run', {'event': 'apaevt_status_update', 'body': {}})
    except LookupError:
        return True
    return False


async def _deploy_event_delivered(server, conn) -> bool:
    conn.sent.clear()
    await deploy_events.broadcast_review_state(server, 'org-other', 'app.x', 1, 'submit')
    return bool(events(conn, 'app:statusChanged'))


# ---------------------------------------------------------------------------
# E1, E5: red before the fix
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1b_unverified_subject_request_is_not_dispatched(monkeypatch):
    """E1: a subject whose authority was never verified cannot launch."""
    _, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    conn = _admin(server, clock, verified=False)

    await conn.on_receive(_request('launch'))

    conn.on_launch.assert_not_awaited()
    assert conn.sent[-1]['message'] == 'Authorization temporarily unavailable'
    assert conn._transport.disconnect.called is False


@pytest.mark.asyncio
async def test_r972_1b_revocation_on_one_replica_reaches_the_other(monkeypatch):
    """E5: two engines over one database; the push revokes on server 1, and
    server 2 (no push) refuses its stale subject, then its sweep revokes it.
    """
    account = FakeAccount({'admin': (True, ADMIN)})
    clock = _Clock()
    server1 = make_server(account, monkeypatch)
    server2 = make_server(account, monkeypatch)
    _attach(server1, account, clock)
    _attach(server2, account, clock)
    conn1 = _admin(server1, clock)
    conn2 = _admin(server2, clock)

    account.rows['admin'] = (False, ADMIN)
    await server1.push_account_update('admin')
    conn1._transport.disconnect.assert_called_once()

    clock.now += THRESHOLD + 1  # server 2's last verification is now stale
    assert await _dispatched(conn2) is False
    assert await _server_event_delivered(conn2) is False

    await _sweep(server2)
    conn2._transport.disconnect.assert_called_once()
    assert conn2._authenticated is False


# ---------------------------------------------------------------------------
# Sweep outcomes (green only)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1b_sweep_revokes_deleted_row(monkeypatch):
    """N1: a subject whose users row is gone is revoked by the next sweep."""
    account, server, clock = _setup(monkeypatch, {})
    conn = _admin(server, clock)

    await _sweep(server)

    conn._transport.disconnect.assert_called_once()
    assert conn._revoked is True
    assert events(conn, 'apaext_account')[-1]['body']['sysPermissions'] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'row',
    [(False, ADMIN), (True, frozenset()), (True, frozenset({'sys.view'}))],
    ids=['disabled', 'emptied', 'narrowed'],
)
async def test_r972_1b_sweep_revokes_disabled_or_narrowed(monkeypatch, row):
    """A disabled user, or a row missing any cached element, is revoked."""
    account, server, clock = _setup(monkeypatch, {'admin': row})
    conn = _admin(server, clock, perms={'sys.admin', 'sys.view'})

    await _sweep(server)

    conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_r972_1b_failed_read_gates_after_threshold_then_resumes(monkeypatch):
    """N2: failed reads deny nothing before THRESHOLD; after it requests and all
    three event paths are refused (socket kept); a good read resumes them.
    """
    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    conn = _admin(server, clock)
    account.fail = True

    clock.now += 5
    await _sweep(server)
    clock.now += 5
    await _sweep(server)
    assert server._authz_counters['read_failed'] == 2
    assert await _dispatched(conn) is True  # exactly THRESHOLD: still allowed

    clock.now += 1
    assert await _dispatched(conn) is False
    assert await _server_event_delivered(conn) is False
    assert await _task_event_reached(conn) is False
    assert await _deploy_event_delivered(server, conn) is False
    assert server._authz_counters['denied_unavailable'] == 1
    conn._transport.disconnect.assert_not_called()

    account.fail = False
    await _sweep(server)
    assert await _dispatched(conn) is True
    assert await _server_event_delivered(conn) is True
    assert await _task_event_reached(conn) is True
    assert await _deploy_event_delivered(server, conn) is True


@pytest.mark.asyncio
async def test_r972_1b_push_error_defers_to_sweep_value_error_revokes(monkeypatch):
    """N3: with the re-check, a rebuild error marks the subject unverified (no
    revoke) and the sweep decides; a deleted user (ValueError) is revoked.
    """
    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN), 'gone': (True, ADMIN)})
    conn = _admin(server, clock)
    account.fail_rebuild = RuntimeError('database unavailable')

    await server.push_account_update('admin')
    assert conn._authz_verified_at == 0.0
    assert conn._revoked is False
    assert await _dispatched(conn) is False

    await _sweep(server)
    assert await _dispatched(conn) is True
    conn._transport.disconnect.assert_not_called()

    gone = _admin(server, clock, 'gone', connection_id=2)
    account.fail_rebuild = None
    del account.rows['gone']
    await server.push_account_update('gone')
    gone._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_r972_1b_push_install_stamps_verification(monkeypatch):
    """A good push installs the identity verified as of the clock read before
    the rebuild, including one that widens a user into a subject.
    """
    account, server, clock = _setup(monkeypatch, {'u': (True, frozenset({'sys.view'}))})
    conn = make_conn(server, identity('u'), monitors=WILDCARD_ALL)
    conn.on_launch = AsyncMock(return_value=None)

    await server.push_account_update('u')

    assert conn._account_info.sysPermissions == ['sys.view']
    assert conn._authz_verified_at == clock.now
    assert await _dispatched(conn) is True


@pytest.mark.asyncio
async def test_r972_1b_auth_stamps_verification_before_await(monkeypatch):
    """on_auth stamps the clock read before its await; a fresh subject needs no extra read."""
    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    conn = make_conn(server, None)
    conn.on_launch = AsyncMock(return_value=None)
    stamp = clock.now

    async def authenticate_credential(credential):
        clock.now += 3
        return identity('admin', ADMIN)

    server._server.authenticate_credential = authenticate_credential
    await conn.on_auth(_request('auth', auth='rr_session'))

    assert conn._authz_verified_at == stamp
    assert account.reads == []
    clock.now = stamp + THRESHOLD + 0.5
    assert await _dispatched(conn) is False


@pytest.mark.asyncio
async def test_r972_1b_internal_holder_is_a_subject(monkeypatch):
    """N8: a row that granted itself ``internal`` is re-checked like any other;
    dropping it from the row revokes the connection.
    """
    account, server, clock = _setup(monkeypatch, {'svc': (True, frozenset({'internal'}))})
    conn = _admin(server, clock, 'svc', perms={'internal'})

    await _sweep(server)
    assert account.reads == [['svc']]
    conn._transport.disconnect.assert_not_called()

    account.rows['svc'] = (True, frozenset())
    await _sweep(server)
    conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_r972_1b_oss_has_no_recheck(monkeypatch):
    """N9: an edition without live authority gets no re-check: no reads, no gate."""
    from ai.account.base import AccountBase

    class _Oss(AccountBase):
        capabilities = ('oss',)

        async def authenticate(self, credential):
            return (401, 'no')

    monkeypatch.delenv('RR_TASK_TOKEN_KEY', raising=False)
    import ai.account

    for account, expected in ((_Oss(), False), (FakeAccount({'admin': (True, ADMIN)}), True)):
        monkeypatch.setattr(ai.account, 'account', account)
        web = MagicMock()
        web.config = {}
        server = TaskServer(web)
        try:
            assert (server._authz is not None) is expected
            assert len(server._bg_tasks) == (3 if expected else 2)
        finally:
            await server.shutdown()

    _, server, clock = _setup(monkeypatch, {})
    server._authz = None
    conn = _admin(server, clock, verified=False)
    assert await _dispatched(conn) is True
    assert await _server_event_delivered(conn) is True


@pytest.mark.asyncio
async def test_r972_1b_user_id_matched_exactly(monkeypatch):
    """N10: ids are compared exactly (case-sensitive), never lowercased."""
    account, server, clock = _setup(monkeypatch, {'User-AbC': (True, ADMIN)})
    exact = _admin(server, clock, 'User-AbC', connection_id=1)
    folded = _admin(server, clock, 'user-abc', connection_id=2)

    await _sweep(server)

    assert account.reads == [['User-AbC', 'user-abc']]
    exact._transport.disconnect.assert_not_called()
    folded._transport.disconnect.assert_called_once()


# ---------------------------------------------------------------------------
# Controls
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1b_unchanged_rows_one_batched_read(monkeypatch):
    """L1: unchanged rows revoke nothing; 50 sockets of one user cost one read of one id."""
    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    conns = [_admin(server, clock, connection_id=i, verified=False) for i in range(1, 51)]

    await _sweep(server)

    assert account.reads == [['admin']]
    for conn in conns:
        conn._transport.disconnect.assert_not_called()
        assert conn._authz_verified_at == clock.now


@pytest.mark.asyncio
async def test_r972_1b_widening_is_kept(monkeypatch):
    """L2: a row granting more than the connection holds is not a revoke."""
    account, server, clock = _setup(monkeypatch, {'viewer': (True, frozenset({'sys.view', 'sys.admin'}))})
    conn = _admin(server, clock, 'viewer', perms={'sys.view'}, verified=False)

    await _sweep(server)

    conn._transport.disconnect.assert_not_called()
    assert conn._account_info.sysPermissions == ['sys.view']
    assert await _dispatched(conn) is True


@pytest.mark.asyncio
async def test_r972_1b_non_subjects_never_read_or_gated(monkeypatch):
    """L3: pk_/tk_ sockets, users without sys.*, and in-process deploy
    connections are never read, revoked or refused.
    """
    from ai.modules.task.task_server_facade import _InProcessConn

    account, server, clock = _setup(monkeypatch, {})
    task = _admin(server, clock, connection_id=1, verified=False, auth='tk_task')
    public = _admin(server, clock, connection_id=2, verified=False, auth='pk_public')
    plain = _admin(server, clock, 'plain', frozenset(), connection_id=3, verified=False)
    # Real constructor; its debug logging needs the native engine, so mute it.
    monkeypatch.setattr(_InProcessConn, 'debug_message', lambda self, *a, **k: None)
    in_process = _InProcessConn(server)
    in_process._authenticated = True
    in_process._account_info = identity('admin', ADMIN)

    await _sweep(server)

    assert account.reads == []
    for conn in (task, public, plain):
        conn._transport.disconnect.assert_not_called()
    assert server._authz.gate_ok(in_process) is True
    assert await _dispatched(plain) is True
    assert server._authz.gate_ok(task) and server._authz.gate_ok(public)


@pytest.mark.asyncio
async def test_r972_1b_gate_costs_no_reads(monkeypatch):
    """L4: the gate is a clock compare: many requests, zero reads."""
    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    conn = _admin(server, clock)

    for _ in range(100):
        assert await _dispatched(conn) is True
    assert account.reads == []


@pytest.mark.asyncio
async def test_r972_1b_failing_hook_one_read_per_sweep(monkeypatch):
    """L5: 100 subjects and a failing read: one read per sweep, nothing revoked."""
    account, server, clock = _setup(monkeypatch, {})
    conns = [_admin(server, clock, f'admin-{i}', connection_id=i) for i in range(100)]
    account.fail = True

    for _ in range(3):
        clock.now += 5
        await _sweep(server)

    assert len(account.reads) == 3
    assert all(len(batch) == 100 for batch in account.reads)
    for conn in conns:
        conn._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
async def test_r972_1b_run_sweeps_until_stopped(monkeypatch):
    """The loop sweeps every T (start to start) and exits on stop()."""
    monkeypatch.setattr(authz_recheck, 'T', 0.01)
    account = FakeAccount({'admin': (True, ADMIN)})
    server = make_server(account, monkeypatch)
    server._authz = AuthzRecheck(server, account)
    make_conn(server, identity('admin', ADMIN))

    runner = asyncio.create_task(server._authz.run())
    await asyncio.sleep(0.1)
    await server._authz.stop()
    await asyncio.wait_for(runner, 1)

    assert len(account.reads) >= 3
    assert all(batch == ['admin'] for batch in account.reads)


@pytest.mark.asyncio
async def test_r972_1b_sweep_skips_identity_replaced_mid_read(monkeypatch):
    """A newer auth that replaced the identity during the read is not revoked
    on the old one's row.
    """
    account, server, clock = _setup(monkeypatch, {})
    conn = _admin(server, clock)
    newer = identity('admin', ADMIN)
    original = account.live_authority

    async def read_then_reauth(user_ids):
        conn._account_info = newer
        return await original(user_ids)

    account.live_authority = read_then_reauth
    await _sweep(server)

    conn._transport.disconnect.assert_not_called()
    assert conn._account_info is newer


# ---------------------------------------------------------------------------
# Review fixes: a stuck client never stalls the sweep; debugger events; deny log
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r972_1b_stuck_client_does_not_delay_other_stamps(monkeypatch):
    """Revoked clients that stopped reading their sockets do not delay the sweep
    or anyone's stamp; each is still revoked and disconnected.
    """
    from ai.modules.task import task_conn as task_conn_module

    monkeypatch.setattr(task_conn_module, 'NOTICE_SEND_TIMEOUT', 0.05)
    account, server, clock = _setup(monkeypatch, {'ok': (True, ADMIN)})
    stuck = [_admin(server, clock, f'gone-{i}', connection_id=i) for i in range(1, 4)]
    for conn in stuck:
        conn._transport.send = never_returns
    fine = _admin(server, clock, 'ok', connection_id=9, verified=False)

    await asyncio.wait_for(server._authz.sweep_once(), 0.2)

    assert fine._authz_verified_at == clock.now
    for conn in stuck:
        assert conn._revoked is True and conn._authenticated is False
    await asyncio.sleep(0.2)
    for conn in stuck:
        conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_r972_1b_debugger_events_are_gated(monkeypatch):
    """Debugger events to an unverified subject are not sent; after a good read they are."""
    from ai.modules.task.task_engine import Task

    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    debugger = _admin(server, clock, verified=False)
    task = Task.__new__(Task)
    task.id = 'run-1'
    task._run_log = None
    task._debugger = debugger
    task.stamp_log_event = MagicMock()
    message = {'event': 'stopped', 'body': {'project_id': 'p', 'runKind': 'dev'}}

    await task._forward_task_event(EVENT_TYPE.DEBUGGER, message)
    assert events(debugger, 'stopped') == []

    await _sweep(server)
    await task._forward_task_event(EVENT_TYPE.DEBUGGER, message)
    assert events(debugger, 'stopped')


@pytest.mark.asyncio
async def test_r972_1b_denied_warning_once_per_connection_per_minute(monkeypatch):
    """Every refusal is counted; the warning is logged once per connection per 60 s."""
    logged = []
    monkeypatch.setattr(authz_recheck, 'warning', lambda line: logged.append(line))
    account, server, clock = _setup(monkeypatch, {'admin': (True, ADMIN)})
    first = _admin(server, clock, connection_id=1, verified=False)
    second = _admin(server, clock, connection_id=2, verified=False)

    for _ in range(3):
        assert await _dispatched(first) is False
    assert await _dispatched(second) is False
    clock.now += 61
    assert await _dispatched(first) is False

    assert server._authz_counters['denied_unavailable'] == 5
    assert [line.split()[2] for line in logged] == ['conn=1', 'conn=2', 'conn=1']
