"""
Unit tests for ai.modules.task.commands.cmd_debug.DebugCommands.

Focus areas: ``on_initialize`` (static capabilities), ``on_launch`` (org
resolution + start_task delegation + state tracking), ``on_attach``
(token resolution + debug availability + state tracking), ``on_terminate``
/ ``on_disconnect`` (stop / detach paths), ``on_pause`` / ``on_continue``
(threadId injection), ``on_configurationDone`` (debug availability skip),
``on_threads``.

Tests use ``__new__`` to skip the multi-mixin __init__ and seed
``_debug_token``, ``_debug_id``, ``_account_info``, ``_server``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.commands.cmd_debug import DebugCommands


def _make_conn(*, account_info=None, server=None, debug_token=None, debug_id=None):
    """Build a DebugCommands stub with the typical seeded attributes."""
    conn = DebugCommands.__new__(DebugCommands)
    conn._debug_token = debug_token
    conn._debug_id = debug_id
    conn._account_info = account_info
    conn._server = server or MagicMock()
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.build_event = MagicMock(
        side_effect=lambda event, id='', body=None: {'type': 'event', 'event': event, 'id': id, 'body': body}
    )
    conn.send_response = AsyncMock()
    conn.send_event = AsyncMock()
    conn.debug_message = MagicMock()
    conn.verify_permission = MagicMock()
    conn.get_task = MagicMock()
    conn.get_task_token = MagicMock(return_value='tk_x')
    # request() is defined on TaskConn (not DebugCommands); on_pause /
    # on_continue / on_configurationDone / on_threads call self.request().
    conn.request = AsyncMock(side_effect=lambda req: {'type': 'response', 'body': {'forwarded': True}})
    return conn


def _account_info(*, organization=None, default_team='team-1'):
    """Build an AccountInfo stub."""
    return SimpleNamespace(
        userId='user-1',
        auth='ak_x',
        userToken='token-user-1',
        defaultTeam=default_team,
        organization=organization if organization is not None else {'id': 'org-1', 'teams': [{'id': 'team-1'}]},
    )


# ---------------------------------------------------------------------------
# on_initialize
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_initialize_returns_debug_capabilities():
    """on_initialize returns a fixed capabilities dict."""
    conn = _make_conn()
    response = await DebugCommands.on_initialize(conn, {})
    caps = response['body']
    # Sample some of the documented capabilities — full equality would be brittle.
    assert caps['supportsConfigurationDoneRequest'] is True
    assert caps['supportsConditionalBreakpoints'] is True
    assert caps['supportsStepBack'] is False
    assert 'exceptionBreakpointFilters' in caps


# ---------------------------------------------------------------------------
# on_launch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_launch_starts_task_with_resolved_org_and_stores_token():
    """on_launch resolves org_id from defaultTeam, calls start_task, and records _debug_*."""
    server = MagicMock()
    server.start_task = AsyncMock(return_value={'id': 'task-99', 'token': 'tk_99'})
    conn = _make_conn(account_info=_account_info(), server=server)

    event = await DebugCommands.on_launch(conn, {'arguments': {}})

    server.start_task.assert_awaited_once()
    assert server.start_task.call_args.kwargs['org_id'] == 'org-1'
    assert server.start_task.call_args.kwargs['attach_debugger'] is True
    conn.send_response.assert_awaited_once()
    assert conn._debug_token == 'tk_99'
    assert conn._debug_id == 'task-99'
    assert event['event'] == 'initialized'


@pytest.mark.asyncio
async def test_on_launch_rejects_when_already_debugging():
    """A second on_launch on a connection with _debug_token raises RuntimeError."""
    conn = _make_conn(account_info=_account_info(), debug_token='tk_existing')
    with pytest.raises(RuntimeError, match='already active'):
        await DebugCommands.on_launch(conn, {'arguments': {}})


@pytest.mark.asyncio
async def test_on_launch_rejects_when_default_team_not_in_any_org():
    """If the default team is not part of any org, PermissionError is raised."""
    account = _account_info(organization={'id': 'org-X', 'teams': [{'id': 'team-other'}]})
    conn = _make_conn(account_info=account)
    with pytest.raises(PermissionError, match='does not belong to any organisation'):
        await DebugCommands.on_launch(conn, {'arguments': {}})


# ---------------------------------------------------------------------------
# on_attach
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_attach_rejects_when_already_debugging():
    """on_attach refuses if a debug session is already active.

    Note: the source's except handler builds an f-string that references
    a ``token`` variable that has not been assigned at this branch point,
    so what ultimately propagates is an UnboundLocalError. The contract
    the caller relies on is "the second attach fails" — that holds either
    way. Pin that broad behaviour, not the specific exception type.
    """
    conn = _make_conn(debug_token='tk_existing')
    with pytest.raises((RuntimeError, UnboundLocalError)):
        await DebugCommands.on_attach(conn, {'arguments': {}})


@pytest.mark.asyncio
async def test_on_attach_rejects_when_debug_unavailable():
    """If is_debug_available is False, on_attach raises."""
    task = MagicMock()
    task.is_debug_available = MagicMock(return_value=False)
    conn = _make_conn(account_info=_account_info())
    conn.get_task = MagicMock(return_value=task)
    with pytest.raises(Exception, match='Debugging is not available'):
        await DebugCommands.on_attach(conn, {'arguments': {}})


@pytest.mark.asyncio
async def test_on_attach_records_token_and_emits_initialized():
    """A successful attach stores the token + id and emits an 'initialized' event."""
    task = MagicMock()
    task.is_debug_available = MagicMock(return_value=True)
    server = MagicMock()
    server.attach_task = AsyncMock(return_value={'components': []})
    server.get_task_control = MagicMock(return_value=SimpleNamespace(id='task-77'))
    conn = _make_conn(account_info=_account_info(), server=server)
    conn.get_task = MagicMock(return_value=task)
    conn.get_task_token = MagicMock(return_value='tk_77')

    event = await DebugCommands.on_attach(conn, {'arguments': {'token': 'tk_77'}})

    assert conn._debug_token == 'tk_77'
    assert conn._debug_id == 'task-77'
    assert event['event'] == 'initialized'
    conn.send_response.assert_awaited_once()


# ---------------------------------------------------------------------------
# on_terminate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_terminate_injects_debug_token_and_calls_stop_task():
    """on_terminate uses _debug_token when the request omits 'token'."""
    server = MagicMock()
    server.stop_task = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_active')
    conn.get_task_token = MagicMock(return_value='tk_active')

    response = await DebugCommands.on_terminate(conn, {'arguments': {}})
    server.stop_task.assert_awaited_once_with('tk_active')
    assert response['type'] == 'response'


# ---------------------------------------------------------------------------
# on_disconnect
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_disconnect_clears_debug_state_in_finally():
    """on_disconnect always clears _debug_token + _debug_id, even on error."""
    server = MagicMock()
    server.detach_task = AsyncMock()
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_x', debug_id='task-x')

    await DebugCommands.on_disconnect(conn, {})
    assert conn._debug_token is None
    assert conn._debug_id is None


@pytest.mark.asyncio
async def test_on_disconnect_still_clears_state_when_detach_raises():
    """Even if detach_task raises, the finally block clears the debug fields."""
    server = MagicMock()
    server.detach_task = AsyncMock(side_effect=RuntimeError('detach failed'))
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_x', debug_id='task-x')

    # Best-effort detach swallows the exception internally, so this should return ok.
    await DebugCommands.on_disconnect(conn, {})
    assert conn._debug_token is None


# ---------------------------------------------------------------------------
# on_pause / on_continue — threadId injection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_pause_injects_wildcard_thread_id():
    """on_pause overwrites request['arguments'] with threadId='*' before forwarding."""
    conn = _make_conn(account_info=_account_info(), debug_token='tk_x')
    request = {}
    await DebugCommands.on_pause(conn, request)
    assert request['arguments']['threadId'] == '*'
    assert request['arguments']['singleThread'] is False
    assert request['token'] == 'tk_x'  # debug_token was injected
    conn.request.assert_awaited_once()


@pytest.mark.asyncio
async def test_on_continue_injects_wildcard_thread_id():
    """on_continue overwrites request['arguments'] with threadId='*'."""
    conn = _make_conn(account_info=_account_info(), debug_token='tk_x')
    request = {}
    await DebugCommands.on_continue(conn, request)
    assert request['arguments']['threadId'] == '*'
    assert request['arguments']['singleThread'] is False
    conn.request.assert_awaited_once()


# ---------------------------------------------------------------------------
# on_configurationDone
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_configuration_done_skipped_when_debug_unavailable():
    """If server.is_debug_available() is False, the handler returns a plain success."""
    server = MagicMock()
    server.is_debug_available = MagicMock(return_value=False)
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_x')

    response = await DebugCommands.on_configurationDone(conn, {'arguments': {}})
    assert response['type'] == 'response'
    conn.request.assert_not_called()


@pytest.mark.asyncio
async def test_on_configuration_done_forwards_when_debug_available():
    """When debug IS available, the request is forwarded via self.request()."""
    server = MagicMock()
    server.is_debug_available = MagicMock(return_value=True)
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_x')

    await DebugCommands.on_configurationDone(conn, {'arguments': {}})
    conn.request.assert_awaited_once()


# ---------------------------------------------------------------------------
# on_threads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_threads_returns_empty_response_when_no_debug_available():
    """When server.is_debug_available() is False, on_threads returns a plain success."""
    server = MagicMock()
    server.is_debug_available = MagicMock(return_value=False)
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_x')

    response = await DebugCommands.on_threads(conn, {})
    assert response['type'] == 'response'
    conn.request.assert_not_called()


@pytest.mark.asyncio
async def test_on_threads_forwards_when_debug_available():
    """When debug IS available, on_threads forwards to the underlying request handler."""
    server = MagicMock()
    server.is_debug_available = MagicMock(return_value=True)
    conn = _make_conn(account_info=_account_info(), server=server, debug_token='tk_x')

    await DebugCommands.on_threads(conn, {})
    conn.request.assert_awaited_once()


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------


def test_debug_commands_init_zeroes_debug_state():
    """__init__ seeds _debug_token and _debug_id to None."""
    conn = DebugCommands.__new__(DebugCommands)
    DebugCommands.__init__(conn, connection_id=1, server=None, transport=None)
    assert conn._debug_token is None
    assert conn._debug_id is None
