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

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from rocketride import EVENT_TYPE, TASK_STATE
from ai.account.models import AccountInfo
from ai.modules.task.task_conn import SCOPED_KEY_COMMANDS, TaskConn
from ai.modules.task.task_server import TaskServer

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
        key=f'deploy.team-1.{address}',
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
        task=SimpleNamespace(get_status=lambda: status),
    )


async def _monitor_conn(identity):
    """A real TaskConn on a real TaskServer holding an in-scope and an out-of-scope run."""
    server = TaskServer.__new__(TaskServer)
    runs = [_team_run(ADDRESS, 'task-in'), _team_run(OTHER_ADDRESS, 'task-out')]
    server._task_control = {run.key: run for run in runs}
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

    await conn.send_task_event(EVENT_TYPE.SUMMARY, f'deploy.team-1.{ADDRESS}', status)
    await conn.send_task_event(EVENT_TYPE.SUMMARY, f'deploy.team-1.{OTHER_ADDRESS}', status)

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
