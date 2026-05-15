"""
Unit tests for ai.common.dap.dap_conn.DAPConn.

DAPConn is the WebSocket-side dispatcher in the Debug Adapter Protocol stack.
For each incoming ``request`` message it tries ``on_<command>`` first, then a
generic ``on_command`` fallback, and finally a default success response. The
``send_response`` / ``send_event`` / ``send_error`` helpers wrap a transport
``send`` call around the corresponding builder.

DAPBase, DAPClient, transports, etc. come from ``rocketride.core`` (bundled
with the engine). Tests bypass DAPBase.__init__ via ``__new__`` and attach
AsyncMocks for the methods DAPConn delegates to (``_transport.send``,
``_call_method``, ``build_response``, ``build_event``, ``build_error``,
``debug_message``).
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.common.dap.dap_conn import DAPConn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(*, call_method_result=(False, None), build_response_value=None):
    """
    Construct a DAPConn whose DAPBase init is bypassed and whose dependent
    methods are AsyncMock / MagicMock instances.

    Args:
        call_method_result: tuple ``(handled, response)`` returned by the
            mocked ``_call_method`` coroutine.
        build_response_value: value returned by the mocked ``build_response``.

    Returns:
        DAPConn: a test-ready instance with all interactions observable on its
        attributes (``_transport``, ``_call_method``, ``build_response``,
        ``build_event``, ``build_error``, ``debug_message``).
    """
    conn = DAPConn.__new__(DAPConn)  # bypass DAPBase.__init__
    conn._transport = MagicMock()
    conn._transport.send = AsyncMock()
    conn._call_method = AsyncMock(return_value=call_method_result)
    conn.build_response = MagicMock(return_value=build_response_value)
    conn.build_event = MagicMock(return_value={'type': 'event'})
    conn.build_error = MagicMock(return_value={'type': 'response', 'success': False})
    conn.debug_message = MagicMock()
    return conn


# ---------------------------------------------------------------------------
# on_receive — request dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_receive_dispatches_request_to_on_command():
    """A request message is routed via _call_method('on_<command>', 'on_command')."""
    conn = _make_conn(call_method_result=(True, {'type': 'response', 'body': 'ok'}))

    msg = {'type': 'request', 'command': 'launch', 'seq': 1}
    await conn.on_receive(msg)

    conn._call_method.assert_awaited_once_with(msg, 'on_launch', 'on_command')
    conn._transport.send.assert_awaited_once_with({'type': 'response', 'body': 'ok'})
    # No fallback default response should be built when a handler answered.
    conn.build_response.assert_not_called()


@pytest.mark.asyncio
async def test_on_receive_falls_back_to_default_response_when_no_handler():
    """If _call_method reports no handler, a default response is built and sent."""
    default = {'type': 'response', 'success': True, 'request_seq': 7}
    conn = _make_conn(
        call_method_result=(False, None),
        build_response_value=default,
    )

    msg = {'type': 'request', 'command': 'unknown', 'seq': 7}
    await conn.on_receive(msg)

    conn.build_response.assert_called_once_with(msg)
    conn._transport.send.assert_awaited_once_with(default)
    conn.debug_message.assert_called()  # logged the missing handler


@pytest.mark.asyncio
async def test_on_receive_does_not_send_when_response_is_none():
    """A handler that returns None must not produce a transport send."""
    conn = _make_conn(call_method_result=(True, None))

    await conn.on_receive({'type': 'request', 'command': 'noop'})

    conn._transport.send.assert_not_called()


@pytest.mark.asyncio
async def test_on_receive_handles_none_message_gracefully():
    """Passing message=None coerces to {} and reaches the non-request branch."""
    conn = _make_conn()

    await conn.on_receive(None)

    # Empty dict -> message_type is '' -> 'Unhandled message type' branch.
    conn._call_method.assert_not_called()
    conn._transport.send.assert_not_called()
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_on_receive_logs_unknown_type():
    """Non-request messages (events / responses) hit the debug_message branch."""
    conn = _make_conn()

    await conn.on_receive({'type': 'event', 'event': 'output'})

    conn._call_method.assert_not_called()
    conn._transport.send.assert_not_called()
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# send / send_response / send_event / send_error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_delegates_to_transport():
    """DAPConn.send forwards the message to the underlying transport."""
    conn = _make_conn()
    payload = {'type': 'event', 'event': 'output'}

    await conn.send(payload)

    conn._transport.send.assert_awaited_once_with(payload)


@pytest.mark.asyncio
async def test_send_response_builds_then_sends():
    """send_response calls build_response(command, body=...) and sends the result."""
    built = {'type': 'response', 'request_seq': 1, 'body': {'ok': True}}
    conn = _make_conn(build_response_value=built)

    cmd = {'type': 'request', 'command': 'launch', 'seq': 1}
    await conn.send_response(cmd, body={'ok': True})

    conn.build_response.assert_called_once_with(cmd, body={'ok': True})
    conn._transport.send.assert_awaited_once_with(built)


@pytest.mark.asyncio
async def test_send_response_default_body_is_none():
    """When body is omitted, build_response is called with body=None."""
    conn = _make_conn(build_response_value={'type': 'response'})
    await conn.send_response({'command': 'ping'})
    conn.build_response.assert_called_once_with({'command': 'ping'}, body=None)


@pytest.mark.asyncio
async def test_send_event_builds_then_sends():
    """send_event calls build_event(name, id=..., body=...) and sends the result."""
    built = {'type': 'event', 'event': 'output', 'body': {'category': 'stdout'}}
    conn = _make_conn()
    conn.build_event.return_value = built

    await conn.send_event('output', id='abc', body={'category': 'stdout'})

    conn.build_event.assert_called_once_with('output', id='abc', body={'category': 'stdout'})
    conn._transport.send.assert_awaited_once_with(built)


@pytest.mark.asyncio
async def test_send_event_defaults_id_empty_and_body_none():
    """Default id is '' and default body is None when caller passes no kwargs."""
    conn = _make_conn()
    await conn.send_event('breakpoint')
    conn.build_event.assert_called_once_with('breakpoint', id='', body=None)


@pytest.mark.asyncio
async def test_send_error_builds_sends_and_returns_response():
    """send_error builds a DAP error, sends it, and returns the same dict."""
    built = {'type': 'response', 'success': False, 'message': 'boom'}
    conn = _make_conn()
    conn.build_error.return_value = built

    request = {'type': 'request', 'command': 'launch', 'seq': 5}
    result = await conn.send_error(request, 'boom')

    conn.build_error.assert_called_once_with(request, 'boom')
    conn._transport.send.assert_awaited_once_with(built)
    assert result is built
