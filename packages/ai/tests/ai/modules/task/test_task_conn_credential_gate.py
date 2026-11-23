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

"""Dispatch-level credential-class gate for task-capability sockets.

``pk_`` (public key, the credential embedded in the chat widget) and ``tk_``
(private task token) sockets carry a synthetic identity that still names the
launching user and org. Without a gate at dispatch, such a socket reaches
every ``on_*`` handler on ``TaskConn`` -- account, deploy, app pins, history,
key issuance -- not just the commands that address its own task.

These tests drive the REAL ``TaskConn.on_receive`` and the REAL ``DAPConn``
method dispatch (``on_<command>`` lookup). Only the handler bodies are
replaced by spies, so a command "reaches its handler" exactly when production
dispatch would call it. The pk_/tk_ identities are produced by the real
``TaskServer.authenticate``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from rocketride import EVENT_TYPE, TASK_STATE
from ai.modules.task.task_conn import TaskConn
from ai.modules.task.task_server import TaskServer

from .test_task_conn import _make_account_info, _make_conn

TASK_TOKEN = 'tk_00000000000000000000000000000001'
PUBLIC_KEY = 'pk_00000000000000000000000000000001'

# The run's source component and the pipeline that declares it a chat endpoint.
PUBLIC_SOURCE = 'chat_1'
PUBLIC_PIPELINE = {'components': [{'id': PUBLIC_SOURCE, 'provider': 'chat'}]}

# Commands a pk_ (task.data) socket legitimately sends: the SDK handshake
# (auth/deauth), liveness/identity, and the data pipe the chat widget and
# chat UI drive (rrext_process open/write/close, plus the per-pipe SSE
# subscription DataPipe.open() makes through rrext_monitor).
PK_ALLOWED = ['auth', 'deauth', 'rrext_ping', 'rrext_identify', 'rrext_process', 'rrext_monitor']

# A tk_ socket (full scope of ONE task) additionally addresses that task:
# status, pipeline read, terminate, restart.
TK_EXTRA_ALLOWED = ['rrext_get_task_status', 'rrext_get_pipeline', 'terminate', 'restart']
TK_ALLOWED = PK_ALLOWED + TK_EXTRA_ALLOWED

# Account / deploy / history / app-pin / key-issuance / admin surfaces named by
# the issue, plus the other handlers that act on the launching user's data.
DENIED_FOR_TASK_KEYS = [
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
    'rrext_log',
    'rrext_get_token',
    'rrext_get_tasks',
    'rrext_dashboard',
    'rrext_list_tasks',
    'rrext_list_connections',
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


def _task_control(**extra):
    """Build the one running task both keys belong to.

    Its source is a public endpoint (chat): the kind of run a ``pk_`` key is
    issued for, and the only kind it authenticates against.

    Args:
        **extra: further TASK_CONTROL attributes a test reads.
    """
    return SimpleNamespace(
        userId='launching-user',
        orgId='org-1',
        teamId='team-1',
        public_auth=PUBLIC_KEY,
        source=PUBLIC_SOURCE,
        pipeline=PUBLIC_PIPELINE,
        **extra,
    )


def _task_server(control=None):
    """Build a real TaskServer (``__init__`` bypassed) with the one task registered."""
    server = TaskServer.__new__(TaskServer)
    server._task_control = {TASK_TOKEN: control or _task_control()}
    return server


async def _task_identity(prefix: str, server=None):
    """Authenticate through the production TaskServer.authenticate."""
    server = server or _task_server()
    credential = PUBLIC_KEY if prefix == 'pk_' else TASK_TOKEN
    info = await server.authenticate(credential)
    assert info.auth == credential
    return info


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


@pytest.mark.asyncio
@pytest.mark.parametrize('prefix', ['pk_', 'tk_'])
@pytest.mark.parametrize('cmd', DENIED_FOR_TASK_KEYS)
async def test_task_key_socket_cannot_reach_non_task_commands(prefix, cmd):
    """pk_/tk_ sockets are refused at dispatch for every non-task command."""
    conn = _make_conn(authenticated=True, account_info=await _task_identity(prefix))
    spies = _install_spies(conn, [cmd] if cmd else [])

    await _dispatch(conn, cmd, {'subcommand': 'remove', 'appId': 'a', 'target': '@me', 'deployTo': 'team-1'})

    for spy in spies.values():
        spy.assert_not_awaited()
    sent = _sent(conn)
    assert len(sent) == 1
    assert sent[0]['success'] is False
    # The refusal must not drop the socket: a task client may probe.
    conn._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('prefix', ['pk_', 'tk_'])
async def test_task_key_socket_reaches_no_handler_outside_the_allow_list(prefix):
    """Fail closed: enumerate EVERY on_* attribute TaskConn can dispatch to.

    Whatever handlers exist now or are added later, only the allow-list is
    reachable from a pk_/tk_ socket.
    """
    allowed = set(PK_ALLOWED if prefix == 'pk_' else TK_ALLOWED)
    commands = sorted(
        name[3:] for name in dir(TaskConn) if name.startswith('on_') and callable(getattr(TaskConn, name))
    )
    assert 'rrext_deploy_app' in commands and 'rrext_account_keys' in commands  # enumeration sanity

    reached = []
    for cmd in commands:
        conn = _make_conn(authenticated=True, account_info=await _task_identity(prefix))
        spies = _install_spies(conn, [cmd])
        await _dispatch(conn, cmd)
        if spies[cmd].await_count:
            reached.append(cmd)

    # rrext_public_* (server probe, catalog) are public by design: they are
    # served before authentication to every caller and carry no identity.
    public = {cmd for cmd in commands if cmd.startswith('rrext_public_')}
    assert set(reached) == (allowed & set(commands)) | public


@pytest.mark.asyncio
@pytest.mark.parametrize('cmd', PK_ALLOWED)
async def test_public_key_socket_keeps_chat_widget_commands(cmd):
    """The commands the chat widget / chat UI SDK path sends still dispatch."""
    conn = _make_conn(authenticated=True, account_info=await _task_identity('pk_'))
    spies = _install_spies(conn, [cmd])
    await _dispatch(conn, cmd)
    spies[cmd].assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('cmd', TK_ALLOWED)
async def test_task_token_socket_keeps_task_scoped_commands(cmd):
    """A tk_ socket keeps data, monitor, status, pipeline, terminate, restart."""
    conn = _make_conn(authenticated=True, account_info=await _task_identity('tk_'))
    spies = _install_spies(conn, [cmd])
    await _dispatch(conn, cmd)
    spies[cmd].assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('cmd', TK_EXTRA_ALLOWED)
async def test_public_key_socket_is_not_granted_task_control_commands(cmd):
    """pk_ is data-only: it does not get the tk_ control/status commands."""
    conn = _make_conn(authenticated=True, account_info=await _task_identity('pk_'))
    spies = _install_spies(conn, [cmd])
    await _dispatch(conn, cmd)
    spies[cmd].assert_not_awaited()
    assert _sent(conn)[0]['success'] is False


@pytest.mark.asyncio
@pytest.mark.parametrize('prefix', ['pk_', 'tk_'])
async def test_task_key_socket_drops_non_request_messages(prefix):
    """Only requests are dispatchable for task credentials; anything else is dropped."""
    conn = _make_conn(authenticated=True, account_info=await _task_identity(prefix))
    spies = _install_spies(conn, ['rrext_deploy_app'])
    await TaskConn.on_receive(conn, {'type': 'event', 'command': 'rrext_deploy_app', 'seq': 1})
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
async def test_full_user_credential_is_unaffected(cmd):
    """An rr_ account key still reaches every handler (deploy verbs included)."""
    conn = _make_conn(authenticated=True, account_info=_make_account_info(auth='rr_fullusertoken'))
    spies = _install_spies(conn, [cmd])
    await _dispatch(conn, cmd, {'subcommand': 'history'})
    spies[cmd].assert_awaited_once()


def _web_server_with_authenticators(task_identity_server):
    """A real WebServer.authenticate_credential over [TaskServer.authenticate, rr_ stub].

    ``authenticate_credential`` is the production entry ``TaskConn.on_auth``
    calls: it strips the optional ``Bearer `` prefix, then walks the registered
    authenticators (TaskServer.authenticate first, as in production).
    """
    from ai.web.server import WebServer

    async def full_user_authenticator(authorization):
        """Accept ``rr_`` credentials as a full user; pass on anything else."""
        if not authorization.startswith('rr_'):
            return None
        info = _make_account_info(auth=authorization)
        info.to_connect_result = lambda: {'userId': info.userId}
        return info

    web = WebServer.__new__(WebServer)
    web._authenticators = [task_identity_server.authenticate, full_user_authenticator]
    return web


def _wire_real_auth(conn):
    """Point the connection at the real authenticate_credential chain."""
    conn._server = SimpleNamespace(
        _server=_web_server_with_authenticators(_task_server()),
        broadcast_server_event=AsyncMock(),
        release_unauthed_slot=lambda ip: None,
        acquire_unauthed_slot=lambda ip: None,
        _unauthed_by_ip={},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize('credential', [f'Bearer {PUBLIC_KEY}', PUBLIC_KEY, f'Bearer {TASK_TOKEN}'])
async def test_gate_applies_to_identity_from_real_bearer_stripping_auth_path(credential):
    """pk_/tk_ presented through the real auth command (Bearer prefix included) is gated."""
    conn = _make_conn(authenticated=False)
    _wire_real_auth(conn)
    spies = _install_spies(conn, ['rrext_deploy_app', 'rrext_process'])

    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'auth', 'seq': 1, 'arguments': {'auth': credential}})
    assert conn._authenticated is True
    assert conn._account_info.auth == credential.removeprefix('Bearer ')

    await _dispatch(conn, 'rrext_deploy_app', {'subcommand': 'remove', 'target': '@me'})
    await _dispatch(conn, 'rrext_process')
    spies['rrext_deploy_app'].assert_not_awaited()
    spies['rrext_process'].assert_awaited_once()


@pytest.mark.asyncio
async def test_gate_follows_the_connection_through_reauth_and_deauth():
    """The class is read per request: full user -> pk_ is gated; deauth -> full user is restored."""
    conn = _make_conn(authenticated=True, account_info=_make_account_info(auth='rr_fullusertoken'))
    _wire_real_auth(conn)
    spies = _install_spies(conn, ['rrext_deploy_app'])

    # 1. Full user reaches the deploy handler.
    await _dispatch(conn, 'rrext_deploy_app')
    assert spies['rrext_deploy_app'].await_count == 1

    # 2. Re-auth on the same socket with a pk_ key: now gated.
    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'auth', 'seq': 2, 'arguments': {'auth': PUBLIC_KEY}})
    assert conn._account_info.auth == PUBLIC_KEY
    await _dispatch(conn, 'rrext_deploy_app')
    assert spies['rrext_deploy_app'].await_count == 1

    # 3. Deauth drops identity entirely (nothing dispatches, socket is closed on the next request);
    #    the connection holds the bare identity, which matches no user, org or credential class...
    await _dispatch(conn, 'deauth')
    assert conn._authenticated is False
    assert conn._account_info.userId == '' and conn._account_info.auth == ''
    assert conn._account_info.waitlisted is True

    # 4. ...and re-auth as the full user regains the full command set.
    await TaskConn.on_receive(
        conn, {'type': 'request', 'command': 'auth', 'seq': 3, 'arguments': {'auth': 'Bearer rr_fullusertoken'}}
    )
    assert conn._account_info.auth == 'rr_fullusertoken'
    await _dispatch(conn, 'rrext_deploy_app')
    assert spies['rrext_deploy_app'].await_count == 2


# ---------------------------------------------------------------------------
# rrext_monitor stays on the pk_ list (the data pipe subscribes for SSE through
# it), so what a subscription sends back is part of the gate. These two run the
# REAL rrext_monitor handler: no spy.
# ---------------------------------------------------------------------------


def _monitored_run():
    """Build the running task with what the real rrext_monitor handler reads.

    Its status carries the run's private token in a note, as the status of a
    chat, dropper or webhook source does.
    """
    status = SimpleNamespace(
        state=TASK_STATE.RUNNING.value,
        name='run',
        model_dump=lambda: {'state': TASK_STATE.RUNNING.value, 'notes': [{'token-key': TASK_TOKEN}]},
    )
    return _task_control(
        id='task-1',
        token=TASK_TOKEN,
        project_id='proj-1',
        run_kind='dev',
        owner_kind='user',
        owner_id='launching-user',
        task=SimpleNamespace(get_status=lambda: status, _pipeline=PUBLIC_PIPELINE),
    )


async def _monitor_conn(prefix: str):
    """Build a real TaskConn authenticated as ``prefix`` against a real TaskServer."""
    server = _task_server(_monitored_run())
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(account_info=await _task_identity(prefix, server), server=server)
    conn._monitors = {}
    return conn


@pytest.mark.asyncio
async def test_public_key_subscription_is_sent_no_status_or_task_list():
    """A pk_ socket may subscribe, but subscribing sends it neither the run's status nor the task list."""
    conn = await _monitor_conn('pk_')

    await _dispatch(conn, 'rrext_monitor', {'types': ['SUMMARY', 'TASK', 'SSE']})

    # The subscription itself is accepted and acknowledged...
    assert list(conn._monitors.values()) == [EVENT_TYPE.SUMMARY | EVENT_TYPE.TASK | EVENT_TYPE.SSE]
    sent = _sent(conn)
    assert sent == [{'type': 'response', 'body': None}]
    # ...and nothing sent carries the private token.
    assert TASK_TOKEN not in repr(sent)


@pytest.mark.asyncio
async def test_task_token_subscription_is_still_sent_status_and_task_list():
    """A tk_ socket holds task.monitor, so subscribing still sends the catch-up events."""
    conn = await _monitor_conn('tk_')

    await _dispatch(conn, 'rrext_monitor', {'types': ['SUMMARY', 'TASK']})

    events = {m['event']: m['body'] for m in _sent(conn) if m['type'] == 'event'}
    assert list(events) == ['apaevt_status_update', 'apaevt_task']
    assert events['apaevt_status_update']['state'] == TASK_STATE.RUNNING.value
    assert [task['id'] for task in events['apaevt_task']['tasks']] == ['task-1']
