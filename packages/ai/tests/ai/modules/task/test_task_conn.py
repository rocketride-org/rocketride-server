"""
Unit tests for ai.modules.task.task_conn.TaskConn.

TaskConn is the per-WebSocket DAP dispatcher that combines seven command
mixins (Task, Data, Monitor, Debug, Misc, Account, App) on top of DAPConn.
Constructing a real instance pulls in every mixin's __init__ and wires the
full server stack, so tests bypass __init__ via ``__new__`` and bind real
methods to a minimal namespace of attributes.

Focus areas:

- ``on_receive`` — pre-auth allowlist and post-auth dispatch
- ``on_auth`` — info-only probe, attempt cap, auth success / failure flow
- ``has_permission`` / ``verify_permission`` — permission gating
- ``verify_plans`` — pipeline plan validation
- ``get_task_token`` — tk_/pk_/api-key token resolution
- ``get_task`` — cross-tenant ownership check
- ``send`` — message-counter bookkeeping
- ``on_rrext_ping`` — sanity ping
- ``get_connection_id`` — accessor
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.models import RequestContext
from ai.modules.task.task_conn import TaskConn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(account_info=None, conn_id='conn-1', source='local'):
    """
    Build a RequestContext for a single DAP handler call.

    The refactored handlers read caller identity from ``ctx.account_info``
    instead of ``self._account_info``. Tests construct the ctx from the same
    account the connection is set up with and pass it at every call site.

    Args:
        account_info: AccountInfo-shaped stub for the caller (None pre-auth).
        conn_id: opaque connection id carried on the context.
        source: request origin ('local' for direct/OSS mode).

    Returns:
        RequestContext: per-request context for the handler under test.
    """
    return RequestContext(account_info=account_info, conn_id=conn_id, source=source)


def _make_conn(
    *,
    connection_id: int = 1,
    authenticated: bool = True,
    account_info=None,
    server=None,
):
    """
    Build a TaskConn whose multi-mixin __init__ is bypassed.

    Attributes consumed by the methods under test are set explicitly:
    ``_server``, ``_transport``, ``_account_info``, ``_authenticated``,
    ``_connection_id``, ``_client_ip``, ``_auth_attempts``, counters,
    ``_messages_in/out``, ``_last_activity``.

    Real DAPConn helpers (``build_response``, ``build_error``,
    ``build_event``, ``debug_message``) are stubbed with MagicMocks that
    return predictable shapes so assertions can inspect their args.

    Args:
        connection_id: identifier assigned to the connection.
        authenticated: initial auth state.
        account_info: optional AccountInfo-shaped stub.
        server: optional TaskServer-shaped stub.

    Returns:
        TaskConn: a test-ready instance with all interactions observable on
        its attributes.
    """
    conn = TaskConn.__new__(TaskConn)
    conn._connection_id = connection_id
    conn._client_ip = '127.0.0.1'
    conn._authenticated = authenticated
    conn._account_info = account_info
    conn._auth_attempts = 0
    conn._messages_in = 0
    conn._messages_out = 0
    conn._last_activity = 0.0
    conn._connected_at = 0.0
    conn._client_info = {}
    conn._server = server or MagicMock()

    transport = MagicMock()
    transport.send = AsyncMock()
    transport.disconnect = MagicMock()
    conn._transport = transport

    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.build_error = MagicMock(side_effect=lambda req, msg: {'type': 'response', 'success': False, 'message': msg})
    conn.build_event = MagicMock(
        side_effect=lambda evt, id='', body=None: {'type': 'event', 'event': evt, 'body': body}
    )
    conn.debug_message = MagicMock()
    return conn


def _make_account_info(*, auth: str = 'ak_user_token', user_id: str = 'user-1', default_team: str = 'team-1'):
    """
    Build a minimal AccountInfo-shaped object covering the attributes
    TaskConn touches: ``auth`` (the credential string), ``userId``,
    ``userToken``, ``defaultTeam``.

    Args:
        auth: credential string. Tests use ``pk_``, ``tk_``, ``ak_`` prefixes
            to exercise the different code paths in ``get_task_token``.
        user_id: opaque user identifier.
        default_team: team id used by ``has_permission``.

    Returns:
        SimpleNamespace: a stand-in object with the expected attributes.
    """
    return SimpleNamespace(
        auth=auth,
        userId=user_id,
        userToken='token-' + user_id,
        defaultTeam=default_team,
        sysPermissions=[],
        waitlisted=False,
    )


# ---------------------------------------------------------------------------
# on_receive — auth gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_receive_allows_auth_before_authentication():
    """``auth`` requests are dispatched even when the connection is unauthenticated."""
    conn = _make_conn(authenticated=False)
    # Stub the parent on_receive — we only care that it was reached.
    parent_called = AsyncMock()

    async def fake_parent(msg):
        """Capture the dispatched message for assertion."""
        await parent_called(msg)

    # Bypass super() chain by replacing on_receive's downstream call site.
    # The simplest way: monkey-patch the bound method's __func__ via an
    # attribute that the method consults — but here we instead patch the
    # MRO's next class. We just verify that build_error / disconnect were
    # NOT called and on_receive returned normally.
    conn.build_error = MagicMock()
    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'auth'})

    # No 'Not authenticated' error path triggered.
    conn.build_error.assert_not_called()
    conn._transport.disconnect.assert_not_called()


@pytest.mark.asyncio
async def test_on_receive_rejects_non_auth_when_unauthenticated():
    """Any non-auth command before auth is rejected with an error and disconnect."""
    conn = _make_conn(authenticated=False)
    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'launch'})

    conn.build_error.assert_called_once()
    args, _ = conn.build_error.call_args
    assert args[1] == 'Not authenticated'
    conn._transport.send.assert_awaited_once()
    conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_on_receive_increments_inbound_counter_and_activity():
    """Every received message updates `_messages_in` and `_last_activity`."""
    conn = _make_conn(authenticated=False)
    before = conn._messages_in
    await TaskConn.on_receive(conn, {'type': 'request', 'command': 'launch'})
    assert conn._messages_in == before + 1
    assert conn._last_activity > 0


@pytest.mark.asyncio
async def test_on_receive_handles_none_message():
    """Passing message=None coerces to {} and returns before dispatch."""
    conn = _make_conn(authenticated=False)
    await TaskConn.on_receive(conn, None)
    # Empty dict -> message_type '' != 'request' -> logged and returned early,
    # before the auth gate or any handler dispatch runs.
    conn.debug_message.assert_called_once()
    conn.build_error.assert_not_called()
    conn._transport.disconnect.assert_not_called()


# ---------------------------------------------------------------------------
# on_auth — auth flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_auth_caps_attempts_and_disconnects():
    """Beyond CONST_AUTH_MAX_ATTEMPTS_PER_CONN, further auth requests are rejected."""
    from ai.constants import CONST_AUTH_MAX_ATTEMPTS_PER_CONN

    conn = _make_conn(authenticated=False)
    conn._auth_attempts = CONST_AUTH_MAX_ATTEMPTS_PER_CONN  # next call goes over

    await TaskConn.on_auth(conn, {'command': 'auth', 'arguments': {'auth': 'something'}}, _ctx())

    conn.build_error.assert_called_once()
    assert 'Too many authentication attempts' in conn.build_error.call_args[0][1]
    conn._transport.disconnect.assert_called_once()


@pytest.mark.asyncio
async def test_on_auth_failed_credential_sends_error_and_disconnects():
    """authenticate_credential returning a (code, message) tuple is treated as failure."""
    server = MagicMock()
    server._server = MagicMock()
    server._server.authenticate_credential = AsyncMock(return_value=(401, 'bad credential'))
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(authenticated=False, server=server)

    await TaskConn.on_auth(conn, {'command': 'auth', 'arguments': {'auth': 'wrong'}}, _ctx())

    server.broadcast_server_event.assert_awaited_once()
    conn.build_error.assert_called_once()
    assert conn.build_error.call_args[0][1] == 'bad credential'
    conn._transport.disconnect.assert_called_once()
    assert conn._authenticated is False


@pytest.mark.asyncio
async def test_on_auth_success_sets_account_and_releases_unauthed_slot():
    """Successful auth captures account info, releases the IP slot, and broadcasts."""
    account = _make_account_info()
    account.to_connect_result = MagicMock(return_value={'session': 'abc'})

    server = MagicMock()
    server._server = MagicMock()
    server._server.authenticate_credential = AsyncMock(return_value=account)
    server.release_unauthed_slot = MagicMock()
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(authenticated=False, server=server)

    request = {
        'command': 'auth',
        'arguments': {
            'auth': 'secret-key',
            'clientName': 'rocketride-py',
            'clientVersion': '1.2.3',
        },
    }
    response = await TaskConn.on_auth(conn, request, _ctx())

    assert conn._authenticated is True
    assert conn._account_info is account
    server.release_unauthed_slot.assert_called_once_with(conn._client_ip)
    assert conn._client_info == {'name': 'rocketride-py', 'version': '1.2.3'}
    server.broadcast_server_event.assert_awaited_once()
    assert response == {'type': 'response', 'body': {'session': 'abc'}}


# ---------------------------------------------------------------------------
# has_permission / verify_permission
# ---------------------------------------------------------------------------


def test_has_permission_returns_false_without_account_info(monkeypatch):
    """An unauthenticated connection lacks all permissions."""
    conn = _make_conn(authenticated=False)
    assert conn.has_permission('task.control', _ctx()) is False
    assert conn.has_permission(['task.control', 'task.debug'], _ctx()) is False


def test_has_permission_resolves_team_permissions(monkeypatch):
    """has_permission delegates to ``resolve_team_permissions`` and matches any granted perm."""
    # resolve_team_permissions is imported into (and looked up from) dap_conn,
    # where the base has_permission implementation lives.
    from ai.common.dap import dap_conn as dc_mod

    monkeypatch.setattr(dc_mod, 'resolve_team_permissions', lambda info, team: {'task.control', 'task.debug'})

    account = _make_account_info()
    conn = _make_conn(account_info=account)
    assert conn.has_permission('task.control', _ctx(account_info=account)) is True
    assert conn.has_permission(['task.monitor', 'task.debug'], _ctx(account_info=account)) is True
    assert conn.has_permission('task.admin', _ctx(account_info=account)) is False


def test_has_permission_swallows_permission_error(monkeypatch):
    """resolve_team_permissions raising PermissionError yields False instead of bubbling."""
    from ai.common.dap import dap_conn as dc_mod

    def _raise(info, team):
        """Stand-in resolver that always denies."""
        raise PermissionError('no access')

    monkeypatch.setattr(dc_mod, 'resolve_team_permissions', _raise)

    account = _make_account_info()
    conn = _make_conn(account_info=account)
    assert conn.has_permission('task.control', _ctx(account_info=account)) is False


def test_verify_permission_raises_on_missing(monkeypatch):
    """verify_permission turns a missing permission into a PermissionError."""
    from ai.common.dap import dap_conn as dc_mod

    monkeypatch.setattr(dc_mod, 'resolve_team_permissions', lambda info, team: set())
    account = _make_account_info()
    conn = _make_conn(account_info=account)
    with pytest.raises(PermissionError, match="'task.control' denied"):
        conn.verify_permission('task.control', _ctx(account_info=account))


def test_verify_permission_passes_when_present(monkeypatch):
    """verify_permission is a no-op when the permission is granted."""
    from ai.common.dap import dap_conn as dc_mod

    monkeypatch.setattr(dc_mod, 'resolve_team_permissions', lambda info, team: {'task.control'})
    account = _make_account_info()
    conn = _make_conn(account_info=account)
    conn.verify_permission('task.control', _ctx(account_info=account))  # must not raise


# ---------------------------------------------------------------------------
# verify_auth
# ---------------------------------------------------------------------------


def test_verify_auth_raises_when_unauthenticated():
    """Unauthenticated connection raises PermissionError."""
    conn = _make_conn(authenticated=False, account_info=None)
    with pytest.raises(PermissionError, match='Authentication required'):
        conn.verify_auth(_ctx(account_info=None))


def test_verify_auth_passes_when_authenticated():
    """Authenticated connection with account_info passes silently."""
    account = _make_account_info()
    conn = _make_conn(authenticated=True, account_info=account)
    conn.verify_auth(_ctx(account_info=account))  # must not raise


# ---------------------------------------------------------------------------
# verify_plans
# ---------------------------------------------------------------------------


def test_verify_plans_returns_true_when_validation_succeeds(monkeypatch):
    """verify_plans returns True when the validator accepts the pipeline."""
    from ai.modules.task import task_conn as tc_mod

    fake_validator = MagicMock()
    fake_validator.validate = MagicMock(return_value=True)
    monkeypatch.setattr(tc_mod, 'AccountPipelineValidation', lambda: fake_validator)

    conn = _make_conn()
    assert conn.verify_plans(_make_account_info(), {'source': 's', 'components': []}) is True


def test_verify_plans_raises_when_validation_fails(monkeypatch):
    """A False validation result becomes a PermissionError."""
    from ai.modules.task import task_conn as tc_mod

    fake_validator = MagicMock()
    fake_validator.validate = MagicMock(return_value=False)
    monkeypatch.setattr(tc_mod, 'AccountPipelineValidation', lambda: fake_validator)

    conn = _make_conn()
    with pytest.raises(PermissionError, match='Invalid account plan'):
        conn.verify_plans(_make_account_info(), {})


# ---------------------------------------------------------------------------
# get_task_token
# ---------------------------------------------------------------------------


def test_get_task_token_unauthenticated_raises():
    """get_task_token without auth raises PermissionError."""
    conn = _make_conn(account_info=None)
    with pytest.raises(PermissionError, match='Not authenticated'):
        conn.get_task_token({}, _ctx(account_info=None))


def test_get_task_token_with_pk_auth_locks_to_owning_task():
    """A ``pk_`` credential resolves the task token via the server lookup."""
    server = MagicMock()
    fake_control = SimpleNamespace(token='tk_locked-task')
    server.get_task_control_by_public_key = MagicMock(return_value=fake_control)
    account = _make_account_info(auth='pk_public-1')
    conn = _make_conn(account_info=account, server=server)

    assert conn.get_task_token({}, _ctx(account_info=account)) == 'tk_locked-task'
    server.get_task_control_by_public_key.assert_called_once_with('pk_public-1')


def test_get_task_token_with_tk_auth_returns_credential_directly():
    """A ``tk_`` credential is itself the task token."""
    account = _make_account_info(auth='tk_my-task-token')
    conn = _make_conn(account_info=account)
    assert conn.get_task_token({}, _ctx(account_info=account)) == 'tk_my-task-token'


def test_get_task_token_with_apikey_reads_token_from_arguments():
    """An API key auth must pull the token from the request's arguments dict."""
    account = _make_account_info(auth='ak_user-key')
    conn = _make_conn(account_info=account)

    request = {'arguments': {'token': 'tk_from-args'}}
    assert conn.get_task_token(request, _ctx(account_info=account), permissions='task.control') == 'tk_from-args'


# ---------------------------------------------------------------------------
# get_task — cross-team access check
# ---------------------------------------------------------------------------


def test_get_task_apikey_rejects_task_in_team_caller_cannot_access():
    """For API-key auth, the caller must belong to the task's team.

    The team-membership check now lives in ``TaskServer.verify_task_access``.
    ``get_task`` resolves the token, looks up the control via
    ``get_task_control_by_token``, then defers to ``verify_task_access`` —
    which here raises to model a caller with no access to the task's team.
    """
    account = _make_account_info(auth='ak_user-1', user_id='user-1')

    server = MagicMock()
    fake_control = SimpleNamespace(teamId='team-other', task=SimpleNamespace(name='target'))
    server.get_task_control_by_token = MagicMock(return_value=fake_control)
    # Caller has no membership in the task's team → verify_task_access denies.
    server.verify_task_access = MagicMock(side_effect=PermissionError('Access denied: no permissions for this task'))

    conn = _make_conn(account_info=account, server=server)

    with pytest.raises(PermissionError, match='Access denied'):
        conn.get_task({'arguments': {'token': 'tk_x'}}, _ctx(account_info=account), permissions='task.control')


def test_get_task_apikey_returns_task_when_team_grants_access():
    """API-key auth with the requested team permission returns the underlying task."""
    account = _make_account_info(auth='ak_user-1', user_id='user-1')

    target_task = SimpleNamespace(name='target')
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=SimpleNamespace(teamId='team-1', task=target_task))
    # Caller has the required permission → verify_task_access passes silently.
    server.verify_task_access = MagicMock(return_value=None)

    conn = _make_conn(account_info=account, server=server)

    assert (
        conn.get_task({'arguments': {'token': 'tk_x'}}, _ctx(account_info=account), permissions='task.control')
        is target_task
    )
    # get_task must delegate the access check to the server with the caller ctx.
    server.verify_task_access.assert_called_once()


def test_get_task_tk_auth_bypasses_team_check():
    """tk_ auth is already scoped to a single task; verify_task_access short-circuits."""
    account = _make_account_info(auth='tk_x')
    target_task = SimpleNamespace(name='target')
    server = MagicMock()
    # tk_ auth is its own token, so get_task_token returns it directly and the
    # control lookup uses that token. verify_task_access returns early for tk_.
    server.get_task_control_by_token = MagicMock(return_value=SimpleNamespace(teamId='team-other', task=target_task))
    server.verify_task_access = MagicMock(return_value=None)
    conn = _make_conn(account_info=account, server=server)
    assert conn.get_task({}, _ctx(account_info=account)) is target_task


# ---------------------------------------------------------------------------
# send — outbound counter bookkeeping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_increments_outbound_counter_and_activity():
    """Each send() bumps _messages_out and refreshes _last_activity."""
    conn = _make_conn()
    before_count = conn._messages_out
    await TaskConn.send(conn, {'type': 'response'})
    assert conn._messages_out == before_count + 1
    assert conn._last_activity > 0
    conn._transport.send.assert_awaited_once_with({'type': 'response'})


# ---------------------------------------------------------------------------
# get_connection_id / on_rrext_ping
# ---------------------------------------------------------------------------


def test_get_connection_id_returns_init_value():
    """get_connection_id mirrors the integer passed at construction time."""
    conn = _make_conn(connection_id=42)
    assert conn.get_connection_id() == 42


@pytest.mark.asyncio
async def test_on_rrext_ping_returns_pong():
    """The ping handler returns a response with ``{'pong': True}``."""
    conn = _make_conn()
    response = await TaskConn.on_rrext_ping(conn, {'command': 'rrext_ping'}, _ctx())
    assert response == {'type': 'response', 'body': {'pong': True}}


# ---------------------------------------------------------------------------
# request / on_command — debug routing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_rejects_internal_rrext_command():
    """Any command starting with ``rrext_`` is rejected as internal-only."""
    conn = _make_conn()
    response = await TaskConn.request(conn, {'command': 'rrext_internal'}, _ctx())
    assert response['success'] is False
    assert 'Invalid command' in response['message']


@pytest.mark.asyncio
async def test_request_rejects_empty_command():
    """An empty / missing ``command`` field is rejected."""
    conn = _make_conn()
    response = await TaskConn.request(conn, {}, _ctx())
    assert response['success'] is False


@pytest.mark.asyncio
async def test_request_errors_when_debug_interface_missing():
    """If the underlying task has no `_debug_python`, an error response is built."""
    account = _make_account_info(auth='ak_user-1', user_id='user-1')

    # Caller has task.debug on the task's team — verify_task_access passes and
    # get_task() returns the task, which then fails the _debug_python check.
    fake_task = SimpleNamespace(_debug_python=None)
    server = MagicMock()
    server.get_task_control_by_token = MagicMock(return_value=SimpleNamespace(teamId='team-1', task=fake_task))
    server.verify_task_access = MagicMock(return_value=None)
    conn = _make_conn(account_info=account, server=server)

    response = await TaskConn.request(
        conn, {'command': 'continue', 'arguments': {'token': 'tk_x'}}, _ctx(account_info=account)
    )
    assert response['success'] is False
    assert 'Debug interface not available' in response['message']


@pytest.mark.asyncio
async def test_on_command_rejects_internal_rrext():
    """on_command also rejects rrext_ commands at the dispatcher level."""
    conn = _make_conn()
    response = await TaskConn.on_command(conn, {'command': 'rrext_evil'}, _ctx())
    assert response['success'] is False
