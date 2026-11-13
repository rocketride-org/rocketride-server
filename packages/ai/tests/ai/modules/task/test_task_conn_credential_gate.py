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

"""Dispatch-level command gate for API keys with an ``endpoints`` scope.

A scoped key (a machine webhook's key, the MCP widget's caller-minted upload
key) is the owner's own ``rr_`` key: its session names the owner and org.
Without a gate at dispatch, such a socket reaches every ``on_*`` handler on
``TaskConn`` -- account, deploy, app pins, history, key issuance -- although
the scope only binds the commands that resolve runs.

These tests drive the REAL ``TaskConn.on_receive`` and the REAL ``DAPConn``
method dispatch (``on_<command>`` lookup). Only the handler bodies are
replaced by spies, so a command "reaches its handler" exactly when production
dispatch would call it. (Develop's #2961 pinned the same gate for the ``pk_``
and ``tk_`` task keys, which the named-pipes release deletes; the scoped key
is what replaces the ``pk_``.)
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride import EVENT_TYPE, TASK_STATE
from ai.account.file_store import StorageError
from ai.account.models import AccountInfo
from ai.account.store import Store
from ai.modules.task.task_conn import SCOPED_KEY_COMMANDS, TaskConn
from ai.modules.task.task_server import ControlRegistry, EngineRegistry, TaskServer

from .test_task_conn import _make_account_info, _make_conn

ADDRESS = 'acme.docBrain.chat'
OTHER_ADDRESS = 'acme.docBrain.upload'
SCOPED_KEY = 'rr_scoped_0000000000000000000000000001'
FULL_KEY = 'rr_fullusertoken'

# The commands a scoped socket legitimately sends: the SDK handshake, liveness
# and identity, and every command that resolves runs through the endpoints
# scope (resolver or listing filter).
ALLOWED = [
    'auth',
    'deauth',
    'rrext_ping',
    'rrext_identify',
    'rrext_process',
    'process',
    'rrext_monitor',
    'rrext_get_task_status',
    'rrext_get_pipeline',
    'terminate',
    'restart',
    'rrext_get_tasks',
    'rrext_list_tasks',
    'rrext_log',
]

# Account / deploy / history / app-pin / key-issuance / admin surfaces, the
# run-shaped commands the scope does not filter, plus the other handlers that
# act on the owner's own data.
DENIED = [
    'rrext_deploy_app',  # disable/remove/where/versions/publish/... (app_deploy.py)
    'rrext_deploy',  # history/versions/artifact/add(+deployTo)
    'rrext_app',  # desktop_add/desktop_remove
    'rrext_deploy_pipe',
    'rrext_account_me',
    'rrext_account_keys',
    'rrext_account_org',
    'rrext_account_members',
    'rrext_account_teams',
    'rrext_account_billing',
    'rrext_saas',
    'rrext_billing_rates',
    'rrext_store',
    'rrext_get_token',  # resolves by project/source without the scope
    'rrext_dashboard',  # lists the owner's connections
    'rrext_list_connections',  # lists the owner's connections
    'rrext_services',
    'rrext_validate',
    'rrext_resolve_config',
    'rrext_cprofile_start',
    'rrext_cprofile_stop',
    'execute',
    'launch',
    # Python attribute names that resolve through on_<command> dispatch.
    'receive',
    'command',
    'deauth_all',
    'rrext_not_a_command',
    '',
]


# =============================================================================
# Helpers
# =============================================================================


@pytest.fixture(autouse=True)
def store_backend(monkeypatch):
    """Install a fresh process Store over a stub backend for every test.

    Deauth closes the session's file handles through the server's Store, so
    each test gets its own empty handle registry instead of the real
    singleton. Returns the backend so a test can drive or inspect it.
    """
    backend = MagicMock()
    backend.open_read = AsyncMock(return_value={'context': object(), 'size': 3})
    backend.read_chunk = AsyncMock(return_value=b'abc')
    backend.close_read = AsyncMock()
    store = Store(backend)
    monkeypatch.setattr(Store, 'instance', staticmethod(lambda: store))
    return backend


def _scoped_identity(permissions=('task.data',), endpoints=(ADDRESS,)):
    """The session an endpoints-scoped key hydrates to: the owner, narrowed."""
    return AccountInfo(
        auth=SCOPED_KEY,
        userId='owner-1',
        devTeam='team-1',
        organization={
            'id': 'org-1',
            'name': '',
            'permissions': [],
            'teams': [{'id': 'team-1', 'name': '', 'permissions': list(permissions)}],
            'developerId': 'acme',
        },
        endpoints=list(endpoints),
    )


def _install_spies(conn, commands):
    """Replace on_<command> with an AsyncMock returning a DAP-shaped response."""
    spies = {}
    for cmd in commands:
        spy = AsyncMock(return_value={'type': 'response', 'command': cmd, 'success': True})
        setattr(conn, f'on_{cmd}', spy)
        spies[cmd] = spy
    return spies


def _sent(conn):
    """Return every message the connection wrote to its transport, in order."""
    return [call.args[0] for call in conn._transport.send.await_args_list]


async def _dispatch(conn, cmd, arguments=None):
    """Send one DAP request through the real TaskConn.on_receive."""
    await TaskConn.on_receive(conn, {'type': 'request', 'command': cmd, 'seq': 1, 'arguments': arguments or {}})


# =============================================================================
# The gate
# =============================================================================


def test_the_allow_list_is_exactly_the_documented_set():
    """The gate's set and this module's list cannot drift apart."""
    assert SCOPED_KEY_COMMANDS == frozenset(ALLOWED)


@pytest.mark.asyncio
@pytest.mark.parametrize('cmd', DENIED)
async def test_scoped_key_socket_cannot_reach_non_scoped_commands(cmd):
    """A scoped socket is refused at dispatch for every command the scope does not bind."""
    conn = _make_conn(authenticated=True, account_info=_scoped_identity())
    spies = _install_spies(conn, [cmd] if cmd else [])

    await _dispatch(conn, cmd, {'subcommand': 'remove', 'appId': 'a', 'target': '@me', 'deployTo': 'team-1'})

    for spy in spies.values():
        spy.assert_not_awaited()
    sent = _sent(conn)
    assert len(sent) == 1
    assert sent[0]['success'] is False
    # The refusal must not drop the socket: a client may probe.
    conn._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
async def test_scoped_key_socket_reaches_no_handler_outside_the_allow_list():
    """Fail closed: enumerate EVERY on_* attribute TaskConn can dispatch to.

    Whatever handlers exist now or are added later, only the allow-list is
    reachable from a scoped socket.
    """
    commands = sorted(
        name[3:] for name in dir(TaskConn) if name.startswith('on_') and callable(getattr(TaskConn, name))
    )
    assert 'rrext_deploy_app' in commands and 'rrext_account_keys' in commands  # enumeration sanity

    reached = []
    for cmd in commands:
        conn = _make_conn(authenticated=True, account_info=_scoped_identity())
        spies = _install_spies(conn, [cmd])
        await _dispatch(conn, cmd)
        if spies[cmd].await_count:
            reached.append(cmd)

    # rrext_public_* (server probe, catalog) are public by design: they are
    # served before authentication to every caller and carry no identity.
    public = {cmd for cmd in commands if cmd.startswith('rrext_public_')}
    assert set(reached) == (set(ALLOWED) & set(commands)) | public


@pytest.mark.asyncio
@pytest.mark.parametrize('cmd', ALLOWED)
async def test_scoped_key_socket_keeps_its_run_scoped_commands(cmd):
    """The data pipe, its monitor subscription and the scope-filtered run commands still dispatch."""
    conn = _make_conn(authenticated=True, account_info=_scoped_identity())
    spies = _install_spies(conn, [cmd])
    await _dispatch(conn, cmd)
    spies[cmd].assert_awaited_once()


@pytest.mark.asyncio
async def test_scoped_key_socket_drops_non_request_messages():
    """Only requests are dispatchable for a scoped key; anything else is dropped."""
    conn = _make_conn(authenticated=True, account_info=_scoped_identity())
    spies = _install_spies(conn, ['rrext_deploy_app'])
    await TaskConn.on_receive(conn, {'type': 'event', 'command': 'rrext_deploy_app', 'seq': 1})
    spies['rrext_deploy_app'].assert_not_awaited()


@pytest.mark.asyncio
async def test_an_empty_scope_is_still_a_scope():
    """``endpoints=[]`` reaches no address; it must not read as unscoped."""
    conn = _make_conn(authenticated=True, account_info=_scoped_identity(endpoints=()))
    spies = _install_spies(conn, ['rrext_deploy_app'])
    await _dispatch(conn, 'rrext_deploy_app')
    spies['rrext_deploy_app'].assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'cmd',
    [
        'rrext_deploy_app',
        'rrext_deploy',
        'rrext_app',
        'rrext_account_keys',
        'rrext_store',
        'rrext_deploy_pipe',
        'rrext_dashboard',
        'execute',
        'launch',
        'terminate',
        'rrext_get_task_status',
    ],
)
async def test_unscoped_credential_is_unaffected(cmd):
    """An unscoped rr_ account key still reaches every handler (deploy verbs included)."""
    conn = _make_conn(authenticated=True, account_info=_make_account_info(auth=FULL_KEY))
    spies = _install_spies(conn, [cmd])
    await _dispatch(conn, cmd, {'subcommand': 'history'})
    spies[cmd].assert_awaited_once()


# =============================================================================
# The gate on the real auth path
# =============================================================================


def _web_server_with_authenticator():
    """A real WebServer.authenticate_credential over an rr_ stub authenticator.

    ``authenticate_credential`` is the production entry ``TaskConn.on_auth``
    calls: it strips the optional ``Bearer `` prefix, then walks the registered
    authenticators. The stub hydrates the scoped key to a scoped session and
    any other ``rr_`` key to the full user.
    """
    from ai.web.server import WebServer

    async def authenticator(authorization):
        """Hydrate the scoped key as scoped, any other ``rr_`` as the full user."""
        if authorization == SCOPED_KEY:
            return _scoped_identity()
        if not authorization.startswith('rr_'):
            return None
        info = _make_account_info(auth=authorization)
        info.to_connect_result = lambda: {'userId': info.userId}
        return info

    web = WebServer.__new__(WebServer)
    web._authenticators = [authenticator]
    return web


def _wire_real_auth(conn):
    """Point the connection at the real authenticate_credential chain."""
    conn._server = SimpleNamespace(
        _server=_web_server_with_authenticator(),
        broadcast_server_event=AsyncMock(),
        release_unauthed_slot=lambda ip: None,
        _unauthed_by_ip={},
        _task_control={},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize('credential', [f'Bearer {SCOPED_KEY}', SCOPED_KEY])
async def test_gate_applies_to_identity_from_real_bearer_stripping_auth_path(credential):
    """A scoped key presented through the real auth command (Bearer prefix included) is gated."""
    conn = _make_conn(authenticated=False)
    _wire_real_auth(conn)
    spies = _install_spies(conn, ['rrext_deploy_app', 'rrext_process'])

    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'auth', 'seq': 1, 'arguments': {'auth': credential}})
    assert conn._authenticated is True
    assert conn._account_info.endpoints == [ADDRESS]

    await _dispatch(conn, 'rrext_deploy_app', {'subcommand': 'remove', 'target': '@me'})
    await _dispatch(conn, 'rrext_process')
    spies['rrext_deploy_app'].assert_not_awaited()
    spies['rrext_process'].assert_awaited_once()


@pytest.mark.asyncio
async def test_gate_follows_the_connection_through_reauth_and_deauth():
    """The scope is read per request: full user -> scoped is gated; deauth -> full user is restored."""
    conn = _make_conn(authenticated=True, account_info=_make_account_info(auth=FULL_KEY))
    _wire_real_auth(conn)
    spies = _install_spies(conn, ['rrext_deploy_app'])

    # 1. Full user reaches the deploy handler.
    await _dispatch(conn, 'rrext_deploy_app')
    assert spies['rrext_deploy_app'].await_count == 1

    # 2. Re-auth on the same socket with the scoped key: now gated.
    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'auth', 'seq': 2, 'arguments': {'auth': SCOPED_KEY}})
    assert conn._account_info.endpoints == [ADDRESS]
    await _dispatch(conn, 'rrext_deploy_app')
    assert spies['rrext_deploy_app'].await_count == 1

    # 3. Deauth drops identity entirely...
    await _dispatch(conn, 'deauth')
    assert conn._authenticated is False
    assert conn._account_info is None

    # 4. ...and re-auth as the full user regains the full command set.
    await TaskConn.on_receive(
        conn, {'type': 'request', 'command': 'auth', 'seq': 3, 'arguments': {'auth': f'Bearer {FULL_KEY}'}}
    )
    assert conn._account_info.auth == FULL_KEY
    await _dispatch(conn, 'rrext_deploy_app')
    assert spies['rrext_deploy_app'].await_count == 2


# =============================================================================
# rrext_monitor stays on the list, so what a subscription sends back is part
# of the gate. These run the REAL rrext_monitor handler and the REAL
# resolver: no spy.
# =============================================================================


def _team_run(address, task_id):
    """A team-owned deployment run of ``address`` on team-1 (the @team rung)."""
    developer_id, project_id, source = address.split('.')
    status = SimpleNamespace(
        state=TASK_STATE.RUNNING.value,
        name='run',
        model_dump=lambda: {'state': TASK_STATE.RUNNING.value},
    )
    return SimpleNamespace(
        id=task_id,
        key=f'team.team-1.{address}',
        address=address,
        developer_id=developer_id,
        project_id=project_id,
        source=source,
        run_kind='deploy',
        owner_kind='team',
        owner_id='team-1',
        userId='',
        teamId='team-1',
        orgId='org-1',
        live=True,
        task=SimpleNamespace(get_status=lambda: status, is_task_complete=lambda: False),
    )


async def _monitor_conn(identity):
    """A real TaskConn on a real TaskServer holding an in-scope and an out-of-scope run."""
    server = TaskServer.__new__(TaskServer)
    runs = [_team_run(ADDRESS, 'task-in'), _team_run(OTHER_ADDRESS, 'task-out')]
    server._task_control = ControlRegistry({run.key: run for run in runs})
    server._engines = EngineRegistry()
    server._engine_unavailable = {}
    server._control_starts = {}
    server._engine_restarts = {}
    server._restart_tasks = set()
    server._control_expiry = []
    server._engine_expiry = []
    server._expiry_gen = 0
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=identity, server=server)
    conn._monitors = {}
    return conn


@pytest.mark.asyncio
async def test_scoped_subscription_is_sent_only_its_own_runs():
    """A scoped key with task.monitor gets the catch-up events, listing only runs inside its scope."""
    conn = await _monitor_conn(_scoped_identity(permissions=('task.data', 'task.monitor')))

    await _dispatch(conn, 'rrext_monitor', {'token': ADDRESS, 'types': ['SUMMARY', 'TASK']})

    events = {m['event']: m['body'] for m in _sent(conn) if m['type'] == 'event'}
    assert list(events) == ['apaevt_status_update', 'apaevt_task']
    assert events['apaevt_status_update']['state'] == TASK_STATE.RUNNING.value
    assert [task['id'] for task in events['apaevt_task']['tasks']] == ['task-in']


@pytest.mark.asyncio
async def test_scoped_key_cannot_subscribe_outside_its_scope():
    """Naming an address outside the scope subscribes nothing and sends no event."""
    conn = await _monitor_conn(_scoped_identity(permissions=('task.data', 'task.monitor')))

    await _dispatch(conn, 'rrext_monitor', {'token': OTHER_ADDRESS, 'types': ['SUMMARY', 'TASK']})

    assert conn._monitors == {}
    assert [m for m in _sent(conn) if m['type'] == 'event'] == []


@pytest.mark.asyncio
async def test_data_only_scoped_key_is_sent_no_status_or_task_list():
    """A scoped key without task.monitor receives neither the run's status nor the task list."""
    conn = await _monitor_conn(_scoped_identity(permissions=('task.data',)))

    await _dispatch(conn, 'rrext_monitor', {'token': ADDRESS, 'types': ['SUMMARY', 'TASK', 'SSE']})

    assert [m for m in _sent(conn) if m['type'] == 'event'] == []


# =============================================================================
# A '*' subscription on a scoped socket: task events inside the scope only, no
# server events. Server events (dashboard, deploy, billing) describe the
# owner's account rather than runs, so the scope cannot filter them. These run
# the REAL TaskServer.broadcast_server_event and MonitorCommands delivery.
# =============================================================================


def _dashboard_event(action):
    """A server-level dashboard event as the server broadcasts it."""
    return {'event': 'apaevt_dashboard', 'body': {'action': action, 'connectionId': 7}}


async def _wildcard_conn(identity):
    """A monitor connection subscribed to '*' for dashboard and summary events, transport cleared."""
    conn = await _monitor_conn(identity)
    conn._server._connections = {1: conn}
    await _dispatch(conn, 'rrext_monitor', {'token': '*', 'types': ['DASHBOARD', 'SUMMARY']})
    assert '*' in conn._monitors
    conn._transport.send.reset_mock()
    return conn


@pytest.mark.asyncio
async def test_scoped_wildcard_subscription_receives_no_server_events():
    """The owner's connection details and unscoped auth failures never reach a scoped socket."""
    conn = await _wildcard_conn(_scoped_identity(permissions=('task.data', 'task.monitor')))

    await TaskServer.broadcast_server_event(
        conn._server, EVENT_TYPE.DASHBOARD, _dashboard_event('connection_added'), user_id='owner-1'
    )
    await TaskServer.broadcast_server_event(conn._server, EVENT_TYPE.DASHBOARD, _dashboard_event('auth_failed'))
    await conn.send_server_event(
        EVENT_TYPE.DASHBOARD, _dashboard_event('monitor_changed'), user_id='owner-1', org_id='org-1'
    )

    assert [m for m in _sent(conn) if m['type'] == 'event'] == []


@pytest.mark.asyncio
async def test_scoped_wildcard_subscription_still_receives_task_events_in_scope():
    """The same '*' subscription delivers a run's status inside the scope and nothing outside it."""
    conn = await _wildcard_conn(_scoped_identity(permissions=('task.data', 'task.monitor')))
    status = {'event': 'apaevt_status_update', 'body': {'state': TASK_STATE.RUNNING.value}}

    await conn.send_task_event(EVENT_TYPE.SUMMARY, f'team.team-1.{ADDRESS}', status)
    await conn.send_task_event(EVENT_TYPE.SUMMARY, f'team.team-1.{OTHER_ADDRESS}', status)

    assert [m['event'] for m in _sent(conn) if m['type'] == 'event'] == ['apaevt_status_update']
    assert [call.kwargs['id'] for call in conn.build_event.call_args_list] == ['task-in']


@pytest.mark.asyncio
async def test_unscoped_wildcard_subscription_still_receives_server_events():
    """The owner's own full credential keeps its dashboard feed."""
    conn = await _wildcard_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))

    await TaskServer.broadcast_server_event(
        conn._server, EVENT_TYPE.DASHBOARD, _dashboard_event('connection_added'), user_id='owner-1'
    )

    events = [m for m in _sent(conn) if m['type'] == 'event']
    assert [m['body']['action'] for m in events] == ['connection_added']


@pytest.mark.asyncio
async def test_wildcard_subscription_ends_with_the_session():
    """A '*' subscription made by a scoped key does not outlive deauth.

    Once deauthenticated the socket has no account, so nothing could scope a
    retained subscription: it would receive every server event broadcast.
    """
    conn = await _wildcard_conn(_scoped_identity(permissions=('task.data', 'task.monitor')))
    conn._server._unauthed_by_ip = {}

    await _dispatch(conn, 'deauth')
    assert conn._authenticated is False
    assert conn._monitors == {}
    conn._transport.send.reset_mock()

    await TaskServer.broadcast_server_event(conn._server, EVENT_TYPE.DASHBOARD, _dashboard_event('connection_added'))
    await TaskServer.broadcast_server_event(conn._server, EVENT_TYPE.DASHBOARD, _dashboard_event('auth_failed'))

    assert [m for m in _sent(conn) if m['type'] == 'event'] == []


# =============================================================================
# Deauth ends everything the session held on the socket: its open file-store
# handles and its debugger attachments. Handles are owned by the connection
# id, so one left open would serve whoever authenticates next on the socket.
# These run the REAL fs_open/fs_read handlers over a real Store registry.
# =============================================================================


def _session_conn(identity):
    """An authenticated TaskConn on a TaskServer with no runs, ready to deauth."""
    server = TaskServer.__new__(TaskServer)
    server._task_control = ControlRegistry()
    server._engines = EngineRegistry()
    server._engine_unavailable = {}
    server._control_starts = {}
    server._engine_restarts = {}
    server._restart_tasks = set()
    server._control_expiry = []
    server._engine_expiry = []
    server._expiry_gen = 0
    server._unauthed_by_ip = {}
    server.broadcast_server_event = AsyncMock()
    return _make_conn(account_info=identity, server=server)


def _open_handles():
    """The handles the process Store currently holds open."""
    return list(Store.instance()._shared_handles.values())


@pytest.mark.asyncio
async def test_deauth_closes_the_sessions_file_handles(store_backend):
    """A handle opened before deauth is closed by it and refused to the next identity on the socket."""
    conn = _session_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))
    opened = await conn._store_fs_open({}, {'path': 'notes.txt'})
    handle = opened['body']['handle']
    assert [h.handle_id for h in _open_handles()] == [handle]

    await _dispatch(conn, 'deauth')

    assert conn._authenticated is False
    assert _open_handles() == []
    store_backend.close_read.assert_awaited_once()

    # Another user authenticates on the same socket and presents the handle
    conn._account_info = _make_account_info(auth='rr_other', user_id='other-1')
    conn._authenticated = True
    with pytest.raises(StorageError, match='Invalid handle'):
        await conn._store_fs_read({}, {'handle': handle})
    store_backend.read_chunk.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_open_in_flight_at_deauth_does_not_keep_its_handle(store_backend):
    """An open that registers its handle after deauth's cleanup closes it and fails."""
    conn = _session_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))

    async def open_across_deauth(path):
        # The backend is still opening when the client deauthenticates
        await _dispatch(conn, 'deauth')
        return {'context': object(), 'size': 3}

    store_backend.open_read.side_effect = open_across_deauth

    with pytest.raises(PermissionError, match='session ended'):
        await conn._store_fs_open({}, {'path': 'notes.txt'})

    assert conn._authenticated is False
    assert _open_handles() == []
    store_backend.close_read.assert_awaited_once()


@pytest.mark.asyncio
async def test_deauth_detaches_the_debugger_from_its_tasks():
    """Every task the connection debugs is told to detach it on deauth."""
    conn = _session_conn(_scoped_identity(permissions=('task.data', 'task.monitor')))
    run = _team_run(ADDRESS, 'task-in')
    run.task.detach_task = AsyncMock()
    conn._server._task_control = ControlRegistry({run.key: run})

    await _dispatch(conn, 'deauth')

    assert conn._authenticated is False
    run.task.detach_task.assert_awaited_once_with(conn)


# =============================================================================
# An auth that replaces the identity of a live connection ends the previous
# session exactly as deauth does, and session transitions are serialised: the
# transport dispatches requests concurrently, so an open or an auth racing the
# cleanup must never see a half-ended session.
# =============================================================================


def _reauth_conn(identity):
    """A session connection whose auth command hydrates any ``rr_`` key to its own user."""
    conn = _session_conn(identity)
    conn._server._server = _web_server_with_authenticator()
    return conn


async def _auth(conn, credential, seq=2):
    """Send one auth request through the real TaskConn.on_receive."""
    await TaskConn.on_receive(
        conn, {'type': 'request', 'command': 'auth', 'seq': seq, 'arguments': {'auth': credential}}
    )


@pytest.mark.asyncio
async def test_reauth_as_another_user_ends_the_first_session(store_backend):
    """Handles, monitors and debugger attachments of the first identity do not pass to the second."""
    conn = _reauth_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))
    run = _team_run(ADDRESS, 'task-in')
    run.task.detach_task = AsyncMock()
    conn._server._task_control = ControlRegistry({run.key: run})
    conn._monitors = {'*': object()}
    opened = await conn._store_fs_open({}, {'path': 'notes.txt'})
    handle = opened['body']['handle']
    epoch = conn._session_epoch

    await _auth(conn, 'rr_other')

    # The second identity is installed on a fresh session
    assert conn._authenticated is True
    assert conn._account_info.auth == 'rr_other'
    assert conn._session_epoch == epoch + 1
    # ...and nothing of the first one survived
    assert conn._monitors == {}
    run.task.detach_task.assert_awaited_once_with(conn)
    assert _open_handles() == []
    store_backend.close_read.assert_awaited_once()
    with pytest.raises(StorageError, match='Invalid handle'):
        await conn._store_fs_read({}, {'handle': handle})
    store_backend.read_chunk.assert_not_awaited()


@pytest.mark.asyncio
async def test_first_auth_ends_no_session_and_releases_the_unauthed_slot():
    """Only a replacement ends a session; a first auth gives up the IP's unauthenticated slot once."""
    conn = _reauth_conn(None)
    conn._authenticated = False
    conn._server._unauthed_by_ip = {conn._client_ip: 2}
    epoch = conn._session_epoch

    await _auth(conn, FULL_KEY)
    assert conn._session_epoch == epoch
    assert conn._server._unauthed_by_ip == {conn._client_ip: 1}

    # A replacement keeps the slot count: the connection holds no slot
    await _auth(conn, 'rr_other', seq=3)
    assert conn._session_epoch == epoch + 1
    assert conn._server._unauthed_by_ip == {conn._client_ip: 1}


@pytest.mark.asyncio
async def test_an_open_in_flight_at_reauth_does_not_keep_its_handle(store_backend):
    """An open begun by the first identity and finished after the replacement is closed and refused."""
    conn = _reauth_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))

    async def open_across_reauth(path):
        # The backend is still opening when another identity authenticates
        await _auth(conn, 'rr_other')
        return {'context': object(), 'size': 3}

    store_backend.open_read.side_effect = open_across_reauth

    with pytest.raises(PermissionError, match='session ended'):
        await conn._store_fs_open({}, {'path': 'notes.txt'})

    assert conn._account_info.auth == 'rr_other'
    assert _open_handles() == []
    store_backend.close_read.assert_awaited_once()


@pytest.mark.asyncio
async def test_an_open_racing_the_cleanup_never_leaves_a_handle(store_backend):
    """Opens issued while the session is being ended are refused or closed; none stays registered."""
    conn = _reauth_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))
    run = _team_run(ADDRESS, 'task-in')
    in_cleanup = asyncio.Event()
    release = asyncio.Event()

    async def slow_detach(_conn):
        # Hold the cleanup open after the identity was cleared
        in_cleanup.set()
        await release.wait()

    run.task.detach_task = slow_detach
    conn._server._task_control = ControlRegistry({run.key: run})

    # An open already awaiting the backend when the deauth begins
    backend_entered = asyncio.Event()
    backend_release = asyncio.Event()

    async def slow_open(path):
        backend_entered.set()
        await backend_release.wait()
        return {'context': object(), 'size': 3}

    store_backend.open_read.side_effect = slow_open
    in_flight = asyncio.create_task(conn._store_fs_open({}, {'path': 'early.txt'}))
    await backend_entered.wait()

    deauth = asyncio.create_task(_dispatch(conn, 'deauth'))
    await in_cleanup.wait()

    # Mid-cleanup the identity is already gone: a direct open is refused
    # before it reaches the store, and a dispatched one is refused at the gate
    assert conn._authenticated is False
    with pytest.raises(PermissionError, match='session ended'):
        await conn._store_fs_open({}, {'path': 'late.txt'})
    gate = _install_spies(conn, ['rrext_store'])
    await _dispatch(conn, 'rrext_store', {'subcommand': 'fs_open', 'path': 'late.txt'})
    gate['rrext_store'].assert_not_awaited()

    # The in-flight open resumes during the cleanup and registers its handle
    backend_release.set()
    with pytest.raises(PermissionError, match='session ended'):
        await in_flight

    release.set()
    await deauth

    assert _open_handles() == []
    assert store_backend.open_read.await_count == 1
    store_backend.close_read.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.asyncio
async def test_a_request_during_a_replacing_auth_is_told_to_retry_and_creates_nothing(store_backend):
    """While a replacing auth ends the old session, a request is answered 'session changing'
    without a disconnect, and it can neither be served nor leave a monitor behind.
    """
    conn = _reauth_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))
    conn._monitors = {'*': object()}

    run = _team_run(ADDRESS, 'task-in')
    in_cleanup = asyncio.Event()
    release = asyncio.Event()

    async def slow_detach(_conn):
        in_cleanup.set()
        await release.wait()

    run.task.detach_task = slow_detach
    conn._server._task_control = ControlRegistry({run.key: run})

    auth = asyncio.create_task(_auth(conn, 'rr_other', seq=3))
    await in_cleanup.wait()

    # A request landing in the window: refused softly, socket kept, nothing created
    sent_before = len(_sent(conn))
    await _dispatch(conn, 'rrext_monitor', {'token': '*', 'types': ['SUMMARY']})
    reply = _sent(conn)[sent_before]
    assert reply['success'] is False and 'Session is changing' in reply['message']
    conn._transport.disconnect.assert_not_called()
    assert conn._monitors == {}

    release.set()
    await auth

    # The switch completed: the transition is over and the new identity is served
    assert conn._session_transition is False
    assert conn._authenticated is True
    assert conn._account_info is not None


async def test_an_auth_during_cleanup_waits_and_starts_on_a_clean_session(store_backend):
    """A new identity is installed only after the previous session's cleanup has finished."""
    conn = _reauth_conn(_make_account_info(auth=FULL_KEY, user_id='owner-1'))
    opened = await conn._store_fs_open({}, {'path': 'notes.txt'})
    handle = opened['body']['handle']
    conn._monitors = {'*': object()}

    run = _team_run(ADDRESS, 'task-in')
    in_cleanup = asyncio.Event()
    release = asyncio.Event()
    order = []

    async def slow_detach(_conn):
        in_cleanup.set()
        await release.wait()
        order.append('detached')

    run.task.detach_task = slow_detach
    conn._server._task_control = ControlRegistry({run.key: run})

    authenticate = conn._server._server.authenticate_credential

    async def recording_authenticate(credential):
        order.append('authenticate')
        return await authenticate(credential)

    conn._server._server.authenticate_credential = recording_authenticate

    deauth = asyncio.create_task(_dispatch(conn, 'deauth'))
    await in_cleanup.wait()
    auth = asyncio.create_task(_auth(conn, 'rr_other', seq=3))

    # The auth is parked on the session lock while the cleanup runs
    for _ in range(5):
        await asyncio.sleep(0)
    assert order == []
    assert conn._authenticated is False

    release.set()
    await deauth
    await auth

    # Cleanup finished (handles closed) before the new identity was validated
    assert order == ['detached', 'authenticate']
    assert conn._authenticated is True
    assert conn._account_info.auth == 'rr_other'
    assert conn._monitors == {}
    assert _open_handles() == []
    with pytest.raises(StorageError, match='Invalid handle'):
        await conn._store_fs_read({}, {'handle': handle})
