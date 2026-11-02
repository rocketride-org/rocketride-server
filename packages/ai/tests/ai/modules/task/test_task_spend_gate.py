# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
EaaS answers the task's credit check before the task opens a pipe.

The task asks over the data channel EaaS opened to it; EaaS answers with
account.check_spend for the task's own org, and a refused pipe keeps its
OUT_OF_CREDITS code on the way back to the client.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import asyncio

import pytest

import ai.account
from ai.account.base import OutOfCreditsError
from ai.constants import CONST_BILLING_UNAVAILABLE
import ai.modules.task.task_engine as task_engine
from ai.modules.task.task_engine import Task

REFUSAL = 'Out of credits: add capacity on the Billing page to keep running pipelines'


def _task(org_id='org-1'):
    return Task(
        server=MagicMock(),
        id='t-1',
        project_id='p-1',
        source='s-1',
        token='tk',
        public_auth='pk',
        pipeline={},
        org_id=org_id,
    )


def _data_client(task):
    client = Task.TaskData.__new__(Task.TaskData)
    client._parent_task = task
    client._send = AsyncMock()
    client._next_seq = lambda: 1
    return client


ASK = {'type': 'request', 'seq': 9, 'command': 'rrext_check_spend'}


@pytest.mark.asyncio
async def test_eaas_answers_the_check_with_the_refusal_for_the_tasks_own_org(monkeypatch):
    check = AsyncMock(return_value=REFUSAL)
    monkeypatch.setattr(ai.account.account, 'check_spend', check)
    client = _data_client(_task())

    await client.on_receive(dict(ASK))

    check.assert_awaited_once_with('org-1')
    response = client._send.await_args.args[0]
    assert response['request_seq'] == 9 and response['body'] == {'refusal': REFUSAL}


@pytest.mark.asyncio
async def test_a_task_with_no_org_leaves_the_answer_to_the_account(monkeypatch):
    check = AsyncMock(return_value=REFUSAL)
    monkeypatch.setattr(ai.account.account, 'check_spend', check)
    client = _data_client(_task(org_id=''))

    await client.on_receive(dict(ASK))

    check.assert_awaited_once_with('')
    assert client._send.await_args.args[0]['body'] == {'refusal': REFUSAL}


@pytest.mark.asyncio
async def test_a_refused_pipe_keeps_its_code_on_the_way_back():
    task = _task()
    refused = {'type': 'response', 'success': False, 'message': REFUSAL, 'code': 'OUT_OF_CREDITS'}
    task._data_client = SimpleNamespace(dap_request=AsyncMock(return_value=refused), did_fail=lambda r: True)

    with pytest.raises(OutOfCreditsError, match='Out of credits') as exc_info:
        await task._send_data({'command': 'rrext_process', 'arguments': {'subcommand': 'open'}})
    assert exc_info.value.code == 'OUT_OF_CREDITS'


@pytest.mark.asyncio
async def test_a_hosted_task_opens_the_data_channel_after_reporting_it_is_up(monkeypatch):
    monkeypatch.setattr(task_engine, '_is_saas_engine', lambda: True)
    task = _task()
    order = []
    task._send_status_update = AsyncMock(side_effect=lambda: order.append('status'))
    task._keep_data_client = MagicMock(side_effect=lambda: order.append('channel'))

    await task.on_event({'event': 'apaevt_status_state', 'body': {'service': True}})

    assert order == ['status', 'channel']


@pytest.mark.asyncio
async def test_an_oss_task_keeps_the_data_channel_lazy(monkeypatch):
    monkeypatch.setattr(task_engine, '_is_saas_engine', lambda: False)
    task = _task()
    task._send_status_update = AsyncMock()
    task._keep_data_client = MagicMock()

    await task.on_event({'event': 'apaevt_status_state', 'body': {'service': True}})

    task._keep_data_client.assert_not_called()


@pytest.mark.asyncio
async def test_a_failed_ledger_read_is_answered_as_an_error(monkeypatch):
    monkeypatch.setattr(ai.account.account, 'check_spend', AsyncMock(side_effect=RuntimeError('database unavailable')))
    client = _data_client(_task())

    await client.on_receive(dict(ASK))

    response = client._send.await_args.args[0]
    assert response['request_seq'] == 9
    assert response['success'] is False and response['message'] == CONST_BILLING_UNAVAILABLE


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'service_up, terminating, reopens',
    [(True, False, True), (True, True, False), (False, False, False)],
    ids=['running', 'terminating', 'service-down'],
)
async def test_a_hosted_task_reopens_a_dropped_data_channel_only_while_it_runs(
    monkeypatch, service_up, terminating, reopens
):
    monkeypatch.setattr(task_engine, '_is_saas_engine', lambda: True)
    task = _task()
    task._status.serviceUp = service_up
    task._is_terminating = terminating
    task._keep_data_client = MagicMock()
    client = Task.TaskData(parent_task=task, module='DATA-t-1', transport=MagicMock())

    await client.on_disconnected('dropped', True)

    assert task._keep_data_client.called is reopens


@pytest.mark.asyncio
async def test_an_open_in_progress_is_not_started_twice():
    task = _task()
    opening = asyncio.Event()
    task._ensure_data_client = AsyncMock(side_effect=opening.wait)

    task._keep_data_client()
    first = task._data_keeper
    task._keep_data_client()

    assert task._data_keeper is first
    opening.set()
    await first
    task._ensure_data_client.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_data_channel_that_does_not_open_is_logged_not_raised(monkeypatch):
    logged = MagicMock()
    monkeypatch.setattr(task_engine, 'warning', logged)
    task = _task()
    task._ensure_data_client = AsyncMock(side_effect=RuntimeError('Subprocess exited with code 1'))

    task._keep_data_client()
    await task._data_keeper

    assert 'Subprocess exited' in logged.call_args.args[0]
