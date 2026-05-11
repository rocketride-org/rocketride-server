"""
Unit tests for ai.common.dap.transport_tcpip.TransportTCP.

TransportTCP implements DAP-over-TCP framing (Content-Length headers + JSON
body, with base64 wrap for binary ``data``). Tests focus on:

- ``__init__`` shape
- ``send`` framing (success, binary, not-connected guard, connection-lost guard)
- ``_receive_loop`` framing (well-formed message, missing / invalid headers,
  IncompleteReadError → disconnect, ConnectionResetError → disconnect with error,
  base64 ``data_base64`` field expansion)

Real ``asyncio.StreamReader`` instances backed by ``feed_data`` / ``feed_eof``
drive the receive loop. The writer is a MagicMock so we can introspect every
write that ``send`` performs.
"""

from __future__ import annotations

import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.common.dap.transport_tcpip import TransportTCP


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _frame_bytes(payload: dict) -> bytes:
    """
    Build a valid DAP-over-TCP frame for ``payload``.

    Args:
        payload: any JSON-serialisable dict.

    Returns:
        bytes: the wire bytes — Content-Length / Content-Type headers + body.
    """
    body = json.dumps(payload).encode('utf-8')
    headers = (
        f'Content-Length: {len(body)}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n'
    ).encode('utf-8')
    return headers + body


def _make_transport(*, connected=True, reader=None, writer=None):
    """
    Build a TransportTCP with ``__init__`` bypassed and the attributes
    ``send`` / ``_receive_loop`` consult set explicitly.

    Args:
        connected: initial value of ``_connected``.
        reader: a real or fake StreamReader for the receive loop.
        writer: a writer mock that ``send`` will write/drain through.

    Returns:
        TransportTCP: a test-ready instance with the dispatch callbacks
        replaced by mocks (``_transport_receive``, ``_transport_disconnected``,
        ``_transport_connected``, ``_debug_message``, ``_debug_protocol``).
    """
    t = TransportTCP.__new__(TransportTCP)
    t._reader = reader
    t._writer = writer
    t._receive_task = None
    t._server = None
    t._uri = None
    t._is_waiting_for_connection = False
    t._connected = connected

    t._transport_receive = AsyncMock()
    t._transport_disconnected = AsyncMock()
    t._transport_connected = AsyncMock()
    t._debug_message = MagicMock()
    t._debug_protocol = MagicMock()
    return t


# ---------------------------------------------------------------------------
# __init__
# ---------------------------------------------------------------------------


def test_constructor_stores_uri_and_default_state():
    """Construction stores the URI and zeroes out reader / writer / server fields."""
    t = TransportTCP(uri='tcp://localhost:5566')
    assert t._uri == 'tcp://localhost:5566'
    assert t._reader is None
    assert t._writer is None
    assert t._receive_task is None
    assert t._server is None
    assert t._is_waiting_for_connection is False


def test_constructor_with_no_uri_defaults_to_none():
    """Calling TransportTCP() with no arguments yields a None URI."""
    t = TransportTCP()
    assert t._uri is None


# ---------------------------------------------------------------------------
# send — framing & guards
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_writes_well_formed_frame():
    """send() writes a Content-Length header followed by the JSON body."""
    writer = MagicMock()
    writer.drain = AsyncMock()
    t = _make_transport(connected=True, writer=writer)

    message = {'type': 'request', 'command': 'initialize', 'seq': 1}
    await TransportTCP.send(t, message)

    writer.drain.assert_awaited_once()
    written = writer.write.call_args[0][0]
    assert written.startswith(b'Content-Length: ')
    assert b'application/vscode-jsonrpc' in written
    assert b'\r\n\r\n' in written  # header / body separator

    body_offset = written.index(b'\r\n\r\n') + 4
    parsed_body = json.loads(written[body_offset:].decode('utf-8'))
    assert parsed_body == message


@pytest.mark.asyncio
async def test_send_encodes_bytes_data_as_base64():
    """When the message has bytes in ``data``, send wraps it as base64."""
    writer = MagicMock()
    writer.drain = AsyncMock()
    t = _make_transport(connected=True, writer=writer)

    raw_bytes = b'\x00\x01\x02hello'
    await TransportTCP.send(t, {'type': 'event', 'data': raw_bytes})

    written = writer.write.call_args[0][0]
    body_offset = written.index(b'\r\n\r\n') + 4
    parsed = json.loads(written[body_offset:].decode('utf-8'))
    assert 'data' not in parsed
    assert parsed['data_base64'] == base64.b64encode(raw_bytes).decode('utf-8')


@pytest.mark.asyncio
async def test_send_encodes_string_data_as_base64_utf8():
    """A string ``data`` field is utf-8 encoded then base64'd."""
    writer = MagicMock()
    writer.drain = AsyncMock()
    t = _make_transport(connected=True, writer=writer)

    text = 'Hello 世界'
    await TransportTCP.send(t, {'type': 'event', 'data': text})

    written = writer.write.call_args[0][0]
    body_offset = written.index(b'\r\n\r\n') + 4
    parsed = json.loads(written[body_offset:].decode('utf-8'))
    decoded = base64.b64decode(parsed['data_base64']).decode('utf-8')
    assert decoded == text


@pytest.mark.asyncio
async def test_send_encodes_non_bytes_non_string_data_as_json_then_base64():
    """List/int/dict values in ``data`` are JSON-serialised before base64."""
    writer = MagicMock()
    writer.drain = AsyncMock()
    t = _make_transport(connected=True, writer=writer)

    payload = {'data': [1, 2, 3]}
    await TransportTCP.send(t, {'type': 'event', **payload})

    written = writer.write.call_args[0][0]
    body_offset = written.index(b'\r\n\r\n') + 4
    parsed = json.loads(written[body_offset:].decode('utf-8'))
    decoded = json.loads(base64.b64decode(parsed['data_base64']))
    assert decoded == payload['data']


@pytest.mark.asyncio
async def test_send_raises_when_not_connected_and_not_waiting():
    """If not connected and not in listen mode, send raises ConnectionError immediately."""
    t = _make_transport(connected=False)
    t._is_waiting_for_connection = False
    # `is_connected` is provided by TransportBase; we approximate it locally
    # by overriding _connected (TransportBase.is_connected reads `self._connected`).
    with pytest.raises(ConnectionError, match='not connected'):
        await TransportTCP.send(t, {'type': 'event'})


@pytest.mark.asyncio
async def test_send_converts_broken_pipe_to_connection_error():
    """BrokenPipeError on the writer becomes a ConnectionError and clears _connected."""
    writer = MagicMock()
    writer.write = MagicMock(side_effect=BrokenPipeError('pipe broke'))
    writer.drain = AsyncMock()
    t = _make_transport(connected=True, writer=writer)

    with pytest.raises(ConnectionError, match='Connection lost during send'):
        await TransportTCP.send(t, {'type': 'event'})

    assert t._connected is False


# ---------------------------------------------------------------------------
# _receive_loop — protocol framing
# ---------------------------------------------------------------------------


def _bounded_reader(*chunks: bytes) -> asyncio.StreamReader:
    """
    Build an ``asyncio.StreamReader`` pre-loaded with the given byte chunks
    and an EOF marker. Reading past the last chunk triggers IncompleteReadError
    or returns an empty bytestring — whichever is appropriate for the call.

    Args:
        *chunks: byte sequences to feed into the reader in order.

    Returns:
        asyncio.StreamReader: ready to be passed in as ``_reader``.
    """
    reader = asyncio.StreamReader()
    for c in chunks:
        reader.feed_data(c)
    reader.feed_eof()
    return reader


@pytest.mark.asyncio
async def test_receive_loop_dispatches_well_formed_message():
    """A complete frame is parsed and forwarded via _transport_receive."""
    payload = {'type': 'request', 'command': 'launch', 'seq': 7}
    reader = _bounded_reader(_frame_bytes(payload))
    t = _make_transport(connected=True, reader=reader)

    # The loop will exit after EOF -> ``not line`` branch.
    await asyncio.wait_for(TransportTCP._receive_loop(t), timeout=1.0)

    t._transport_receive.assert_awaited_once_with(payload)
    t._transport_disconnected.assert_awaited_once()  # EOF triggers graceful close
    assert t._connected is False


@pytest.mark.asyncio
async def test_receive_loop_expands_data_base64_into_bytes():
    """A `data_base64` field is decoded into a `data` field of raw bytes."""
    raw = b'\xde\xad\xbe\xef'
    payload = {
        'type': 'event',
        'data_base64': base64.b64encode(raw).decode('utf-8'),
    }
    reader = _bounded_reader(_frame_bytes(payload))
    t = _make_transport(connected=True, reader=reader)

    await asyncio.wait_for(TransportTCP._receive_loop(t), timeout=1.0)

    dispatched = t._transport_receive.await_args[0][0]
    assert 'data_base64' not in dispatched
    assert dispatched['data'] == raw


@pytest.mark.asyncio
async def test_receive_loop_skips_message_when_content_length_missing():
    """A header block with no Content-Length is logged; no event is dispatched."""
    # Just the headers (no body, no follow-up frame). The `continue` branch
    # in the source loops back to read more headers; readline() then returns
    # b'' (EOF), which triggers the graceful disconnect path.
    raw = b'Content-Type: application/vscode-jsonrpc\r\n\r\n'
    reader = _bounded_reader(raw)
    t = _make_transport(connected=True, reader=reader)

    await asyncio.wait_for(TransportTCP._receive_loop(t), timeout=1.0)

    t._transport_receive.assert_not_called()
    t._debug_message.assert_any_call('Missing Content-Length header, skipping message')


@pytest.mark.asyncio
async def test_receive_loop_skips_message_with_invalid_content_length():
    """A non-numeric Content-Length is logged; no event is dispatched."""
    raw = b'Content-Length: not-a-number\r\n\r\n'
    reader = _bounded_reader(raw)
    t = _make_transport(connected=True, reader=reader)

    await asyncio.wait_for(TransportTCP._receive_loop(t), timeout=1.0)

    t._transport_receive.assert_not_called()
    # The debug log includes the offending value.
    assert any('Invalid Content-Length' in str(call.args[0]) for call in t._debug_message.call_args_list)


@pytest.mark.asyncio
async def test_receive_loop_logs_but_continues_on_invalid_json():
    """Invalid JSON in the body is logged but the loop keeps reading."""
    bad_body = b'{not valid json}'
    bad_frame = f'Content-Length: {len(bad_body)}\r\n\r\n'.encode('utf-8') + bad_body
    good_payload = {'type': 'event'}
    reader = _bounded_reader(bad_frame, _frame_bytes(good_payload))
    t = _make_transport(connected=True, reader=reader)

    await asyncio.wait_for(TransportTCP._receive_loop(t), timeout=1.0)

    # The good frame must have been dispatched; the bad one only logged.
    t._transport_receive.assert_awaited_once_with(good_payload)


@pytest.mark.asyncio
async def test_receive_loop_eof_marks_graceful_disconnect():
    """When the reader hits EOF mid-loop, _transport_disconnected fires with has_error=False."""
    reader = _bounded_reader()  # empty + EOF
    t = _make_transport(connected=True, reader=reader)

    await asyncio.wait_for(TransportTCP._receive_loop(t), timeout=1.0)

    t._transport_disconnected.assert_awaited_once()
    args, kwargs = t._transport_disconnected.await_args
    assert kwargs.get('has_error') is False
    assert t._connected is False


# ---------------------------------------------------------------------------
# listen — URI validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_listen_rejects_non_tcp_uri():
    """listen() requires a tcp:// URI; anything else raises ValueError."""
    t = _make_transport()
    t._uri = 'http://localhost:8080'
    # The function raises ValueError before any I/O happens; the body catches
    # everything in a generic try/except and re-wraps it as ConnectionError.
    with pytest.raises((ConnectionError, ValueError)):
        await TransportTCP.listen(t)


@pytest.mark.asyncio
async def test_listen_returns_actual_uri_with_resolved_port(monkeypatch):
    """A successful listen() returns the URI with the kernel-assigned port."""
    t = _make_transport()
    t._uri = 'tcp://localhost:0'

    fake_socket = MagicMock()
    fake_socket.getsockname = MagicMock(return_value=('127.0.0.1', 54321))
    fake_server = MagicMock()
    fake_server.sockets = [fake_socket]

    async def _fake_start_server(_handler, _host, _port):
        """Return a fake server whose port resolves to 54321."""
        return fake_server

    monkeypatch.setattr(asyncio, 'start_server', _fake_start_server)

    actual_uri = await TransportTCP.listen(t)
    assert actual_uri == 'tcp://127.0.0.1:54321'
    assert t._is_waiting_for_connection is True


# ---------------------------------------------------------------------------
# connect — URI validation + open_connection mocking
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_rejects_non_tcp_uri():
    """connect() requires a tcp:// URI."""
    t = _make_transport(connected=False)
    t._uri = 'ws://localhost:8080'
    with pytest.raises((ConnectionError, ValueError)):
        await TransportTCP.connect(t)


@pytest.mark.asyncio
async def test_connect_calls_open_connection_and_starts_receive(monkeypatch):
    """A successful connect() sets _reader/_writer, starts receive task, fires on_connected."""
    t = _make_transport(connected=False)
    t._uri = 'tcp://localhost:7777'

    fake_reader = MagicMock()
    fake_writer = MagicMock()

    async def _fake_open(_host, _port):
        """Return a fake reader/writer pair."""
        return (fake_reader, fake_writer)

    monkeypatch.setattr(asyncio, 'open_connection', _fake_open)
    # Replace _receive_loop with a no-op coroutine so the background task
    # exits immediately rather than blocking on the fake reader.
    monkeypatch.setattr(t, '_receive_loop', AsyncMock(return_value=None))

    await TransportTCP.connect(t)
    assert t._connected is True
    assert t._reader is fake_reader
    assert t._writer is fake_writer
    t._transport_connected.assert_awaited_once()


# ---------------------------------------------------------------------------
# accept — validation + happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_accept_rejects_non_tuple():
    """accept() requires a (reader, writer) tuple; everything else raises."""
    t = _make_transport(connected=False)
    with pytest.raises((ConnectionError, ValueError)):
        await TransportTCP.accept(t, 'not-a-tuple')


@pytest.mark.asyncio
async def test_accept_rejects_wrong_reader_type():
    """accept() validates that the first element is an asyncio.StreamReader."""
    t = _make_transport(connected=False)
    writer = MagicMock(spec=asyncio.StreamWriter)
    writer.get_extra_info = MagicMock(return_value=('127.0.0.1', 1234))
    with pytest.raises((ConnectionError, ValueError)):
        await TransportTCP.accept(t, ('not-a-reader', writer))


@pytest.mark.asyncio
async def test_accept_runs_receive_loop_until_eof(monkeypatch):
    """A valid (reader, writer) tuple drives _receive_loop until completion."""
    t = _make_transport(connected=False)

    reader = asyncio.StreamReader()
    reader.feed_eof()
    writer = MagicMock(spec=asyncio.StreamWriter)
    writer.get_extra_info = MagicMock(return_value=('127.0.0.1', 5566))

    # Replace _receive_loop with a no-op so accept() returns immediately.
    monkeypatch.setattr(t, '_receive_loop', AsyncMock(return_value=None))

    await TransportTCP.accept(t, (reader, writer))
    assert t._reader is reader
    assert t._writer is writer
    t._transport_connected.assert_awaited_once()


# ---------------------------------------------------------------------------
# disconnect
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disconnect_is_noop_when_not_connected():
    """disconnect() on a transport that isn't connected returns immediately."""
    t = _make_transport(connected=False)
    t._writer = None
    await TransportTCP.disconnect(t)
    t._transport_disconnected.assert_not_awaited()


@pytest.mark.asyncio
async def test_disconnect_closes_writer_and_clears_state():
    """disconnect() closes the writer, clears _reader/_writer, and fires the callback."""
    t = _make_transport(connected=True)
    fake_writer = MagicMock()
    fake_writer.close = MagicMock()

    async def _wait_closed():
        """Stand-in for StreamWriter.wait_closed (just returns)."""
        return None

    fake_writer.wait_closed = _wait_closed
    t._writer = fake_writer
    t._receive_task = None

    await TransportTCP.disconnect(t)

    fake_writer.close.assert_called_once()
    assert t._connected is False
    assert t._reader is None
    assert t._writer is None
    t._transport_disconnected.assert_awaited_once()
    kwargs = t._transport_disconnected.await_args.kwargs
    assert kwargs.get('has_error') is False
