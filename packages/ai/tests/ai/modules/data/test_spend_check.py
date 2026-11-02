# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
The task asks EaaS for credit right before getPipe().

DataConn.ask_spend sends the question over the data channel EaaS opened and
waits for its answer; require_credit, the engine's pipe gate, turns a refusal
into OutOfCreditsError.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.modules.data.data_server as data_server
from ai.account.base import OutOfCreditsError
from ai.common.dap import DAPConn
from ai.modules.data.data_conn import DataConn

REFUSAL = 'Out of credits'


def _conn():
    conn = DataConn.__new__(DataConn)
    conn._asked = {}
    conn._seq = 0
    conn._server = MagicMock()
    conn.debug_message = MagicMock()
    conn.send = AsyncMock()
    return conn


@pytest.fixture(autouse=True)
def no_allowed_window(monkeypatch):
    """Each test starts with no cached "allowed" answer."""
    monkeypatch.setattr(data_server, '_allowed_until', 0.0)


@pytest.fixture
def eaas(monkeypatch):
    """A running loop in another thread, like the task's web server, with a connection on it."""
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    conn = _conn()
    conn.ask_spend = AsyncMock(return_value=None)
    monkeypatch.setattr(data_server, '_eaas', (conn, loop))
    connected = threading.Event()
    connected.set()
    monkeypatch.setattr(data_server, '_eaas_connected', connected)
    yield conn
    loop.call_soon_threadsafe(loop.stop)
    thread.join(5)


@pytest.mark.asyncio
async def test_ask_spend_returns_the_refusal_eaas_sends():
    conn = _conn()
    asking = asyncio.ensure_future(conn.ask_spend())
    await asyncio.sleep(0)

    request = conn.send.await_args.args[0]
    assert request['command'] == 'rrext_check_spend'
    await conn.on_receive({'type': 'response', 'request_seq': request['seq'], 'body': {'refusal': REFUSAL}})
    assert await asyncio.wait_for(asking, 1) == REFUSAL


def test_require_credit_refuses_when_eaas_refuses(eaas):
    eaas.ask_spend.return_value = REFUSAL
    with pytest.raises(OutOfCreditsError, match=REFUSAL) as exc_info:
        data_server.require_credit()
    assert exc_info.value.code == 'OUT_OF_CREDITS'


def test_require_credit_lets_the_pipe_through_when_eaas_allows(eaas):
    data_server.require_credit()
    eaas.ask_spend.assert_awaited_once()


def test_with_no_eaas_connected_the_gate_waits_then_refuses(monkeypatch):
    monkeypatch.setattr(data_server, '_eaas', None)
    monkeypatch.setattr(data_server, '_eaas_connected', threading.Event())
    monkeypatch.setattr(data_server, 'CONST_SPEND_CHECK_TIMEOUT', 0.05)

    with pytest.raises(RuntimeError, match='EaaS is not connected'):
        data_server.require_credit()


@pytest.mark.parametrize(
    ('flags', 'hosted'),
    [(['--hosted'], True), ([], False), (['--shared-host'], False)],
)
def test_only_a_hosted_task_makes_require_credit_the_pipe_gate(monkeypatch, flags, hosted):
    set_gate = MagicMock()
    monkeypatch.setattr(data_server.engLib, 'setPipeGate', set_gate)
    monkeypatch.setattr(sys, 'argv', ['node.py', *flags])

    data_server.DataServer(server=MagicMock())

    assert set_gate.call_args_list == ([((data_server.require_credit,),)] if hosted else [])


@pytest.mark.asyncio
async def test_the_eaas_connection_answers_credit_checks_while_connected(monkeypatch):
    monkeypatch.setattr(data_server, '_eaas_connected', threading.Event())
    server = data_server.DataServer.__new__(data_server.DataServer)
    server._dapbase_on_connected = AsyncMock()
    server._dapbase_on_disconnected = AsyncMock()
    monkeypatch.setattr(data_server, 'DataConn', lambda **kwargs: _conn())
    seen = {}

    async def accept(websocket):
        seen['while_connected'] = data_server._eaas
        seen['signalled'] = data_server._eaas_connected.is_set()

    monkeypatch.setattr(data_server, 'TransportWebSocket', lambda: MagicMock(accept=accept))
    await server.listen(MagicMock())

    assert seen['while_connected'] is not None and seen['signalled']
    assert data_server._eaas is None and not data_server._eaas_connected.is_set()


@pytest.mark.asyncio
async def test_ask_spend_raises_the_error_eaas_answers():
    conn = _conn()
    asking = asyncio.ensure_future(conn.ask_spend())
    await asyncio.sleep(0)

    request = conn.send.await_args.args[0]
    failed = {'type': 'response', 'request_seq': request['seq'], 'success': False, 'message': 'database unavailable'}
    await conn.on_receive(failed)
    with pytest.raises(RuntimeError, match='database unavailable'):
        await asyncio.wait_for(asking, 1)
    assert conn._asked == {}


def test_a_question_eaas_never_answers_times_out_and_is_dropped(eaas, monkeypatch):
    monkeypatch.setattr(data_server, 'CONST_SPEND_CHECK_TIMEOUT', 0.05)
    dropped = threading.Event()

    async def never_answers():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            dropped.set()
            raise

    eaas.ask_spend = never_answers
    with pytest.raises(TimeoutError, match='EaaS did not answer in time'):
        data_server.require_credit()
    assert dropped.wait(1)


@pytest.mark.asyncio
async def test_a_question_in_flight_fails_at_once_when_eaas_disconnects():
    conn = _conn()
    asking = asyncio.ensure_future(conn.ask_spend())
    await asyncio.sleep(0)

    await conn.on_disconnected('EaaS went away')

    with pytest.raises(ConnectionError, match='EaaS went away'):
        await asyncio.wait_for(asking, 1)
    assert conn._asked == {}


@pytest.mark.asyncio
async def test_a_cancelled_question_leaves_nothing_waiting():
    conn = _conn()
    asking = asyncio.ensure_future(conn.ask_spend())
    await asyncio.sleep(0)

    asking.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asking
    assert conn._asked == {}


def test_an_allowed_answer_stands_for_the_window(eaas):
    data_server.require_credit()
    data_server.require_credit()

    eaas.ask_spend.assert_awaited_once()


def test_an_expired_window_asks_again(eaas, monkeypatch):
    monkeypatch.setattr(data_server, 'CONST_SPEND_ALLOW_SECONDS', 0.0)

    data_server.require_credit()
    data_server.require_credit()

    assert eaas.ask_spend.await_count == 2


def test_a_refusal_is_asked_again_every_time(eaas):
    eaas.ask_spend.return_value = REFUSAL
    for _ in range(2):
        with pytest.raises(OutOfCreditsError):
            data_server.require_credit()

    assert eaas.ask_spend.await_count == 2


@pytest.mark.asyncio
async def test_an_answer_to_a_cancelled_question_takes_the_usual_route(monkeypatch):
    usual = AsyncMock()
    monkeypatch.setattr(DAPConn, 'on_receive', usual)
    conn = _conn()
    cancelled = asyncio.get_running_loop().create_future()
    cancelled.cancel()
    conn._asked[5] = cancelled
    message = {'type': 'response', 'request_seq': 5, 'body': {'refusal': None}}

    await conn.on_receive(message)

    usual.assert_awaited_once_with(message)
