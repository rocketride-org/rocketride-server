"""
The spend gate sits where a task is asked for a pipe to carry new data:
Task._send_data on a data-channel ``open`` or ``tool``. An org out of credit
is refused there; ``write`` and ``close`` on a pipe already granted go
through; a run with no org (OSS) never asks.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import ai.modules.task.task_server as server_mod
from ai.account.base import OutOfCreditsError
from ai.modules.task.task_engine import Task

from .test_task_reuse import _make_server

REFUSAL = 'Out of credits: add capacity on the Billing page to keep running pipelines'


@pytest.fixture(autouse=True)
def _fresh_answers():
    server_mod.TaskServer._spend_answers.clear()
    yield
    server_mod.TaskServer._spend_answers.clear()


def _task(refusal, org_id='org-1'):
    ts = _make_server()
    ts._server.account.check_spend = AsyncMock(return_value=refusal)
    task = Task(
        server=ts, id='t-1', project_id='p-1', source='s-1', token='tk', public_auth='pk', pipeline={}, org_id=org_id
    )
    task._data_client = SimpleNamespace(dap_request=AsyncMock(return_value={'success': True}), did_fail=lambda r: False)
    return task, ts


def _data(subcommand):
    return {'command': 'rrext_process', 'arguments': {'subcommand': subcommand, 'object': {}, 'mimeType': 'text/plain'}}


@pytest.mark.asyncio
async def test_a_pipe_open_is_refused_for_an_org_out_of_credit():
    task, ts = _task(REFUSAL)
    with pytest.raises(OutOfCreditsError, match='Out of credits') as exc_info:
        await task._send_data(_data('open'))
    assert exc_info.value.code == 'OUT_OF_CREDITS'
    task._data_client.dap_request.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_tool_call_asks_for_a_pipe_and_is_refused_too():
    task, ts = _task(REFUSAL)
    with pytest.raises(OutOfCreditsError):
        await task._send_data(_data('tool'))
    task._data_client.dap_request.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('subcommand', ['write', 'close'])
async def test_a_pipe_already_granted_is_not_checked(subcommand):
    task, ts = _task(REFUSAL)
    await task._send_data(_data(subcommand))
    ts._server.account.check_spend.assert_not_awaited()
    task._data_client.dap_request.assert_awaited_once()


@pytest.mark.asyncio
async def test_an_org_with_credit_gets_its_pipe():
    task, ts = _task(None)
    await task._send_data(_data('open'))
    ts._server.account.check_spend.assert_awaited_once_with('org-1')
    task._data_client.dap_request.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_run_with_no_org_never_asks():
    task, ts = _task(REFUSAL, org_id='')
    await task._send_data(_data('open'))
    ts._server.account.check_spend.assert_not_awaited()


@pytest.mark.asyncio
async def test_the_gate_can_be_switched_off(monkeypatch):
    task, ts = _task(REFUSAL)
    monkeypatch.setattr(server_mod, 'CONST_SPEND_GATE_ENABLED', False)
    await task._send_data(_data('open'))
    ts._server.account.check_spend.assert_not_awaited()


@pytest.mark.asyncio
async def test_one_ledger_answer_per_org_per_billing_interval():
    task, ts = _task(None)
    other, _ = _task(None, org_id='org-2')
    other._server = ts
    await task._send_data(_data('open'))
    await task._send_data(_data('open'))
    await other._send_data(_data('open'))
    assert [c.args[0] for c in ts._server.account.check_spend.await_args_list] == ['org-1', 'org-2']
