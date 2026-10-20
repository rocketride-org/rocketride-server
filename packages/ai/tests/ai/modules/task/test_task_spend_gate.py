# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
EaaS answers a task's credit check, ``spend.check`` on the task channel.

The handler asks account.check_spend for the task's own org; a failed ledger
read is refused with a fixed message, and a refused pipe keeps its
OUT_OF_CREDITS code on the way back to the client.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.account
from ai.account.base import OutOfCreditsError
from ai.constants import CONST_BILLING_UNAVAILABLE
from ai.modules.task import task_channel
from ai.modules.task.task_channel import ChannelRefused
from ai.modules.task.task_engine import Task, _check_spend

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


def test_the_credit_check_is_a_channel_command_for_the_whole_run():
    command = task_channel._commands['spend.check']

    assert command.handler is _check_spend and command.phase == task_channel.PHASE_RUN


@pytest.mark.asyncio
@pytest.mark.parametrize('org_id', ['org-1', ''], ids=['org', 'no-org'])
async def test_eaas_answers_with_what_the_account_says_for_the_tasks_own_org(monkeypatch, org_id):
    check = AsyncMock(return_value=REFUSAL)
    monkeypatch.setattr(ai.account.account, 'check_spend', check)

    reply = await _check_spend(_task(org_id), {}, None)

    check.assert_awaited_once_with(org_id)
    assert reply.body == {'refusal': REFUSAL}


@pytest.mark.asyncio
async def test_a_failed_ledger_read_is_refused_with_a_fixed_message(monkeypatch):
    monkeypatch.setattr(ai.account.account, 'check_spend', AsyncMock(side_effect=RuntimeError('database unavailable')))

    with pytest.raises(ChannelRefused) as refused:
        await _check_spend(_task(), {}, None)

    assert str(refused.value) == CONST_BILLING_UNAVAILABLE


@pytest.mark.asyncio
async def test_a_refused_pipe_keeps_its_code_on_the_way_back():
    task = _task()
    task._data_token = 'run-token'
    refused = {'type': 'response', 'success': False, 'message': REFUSAL, 'code': 'OUT_OF_CREDITS'}
    task._data_client = SimpleNamespace(dap_request=AsyncMock(return_value=refused), did_fail=lambda r: True)

    with pytest.raises(OutOfCreditsError, match='Out of credits') as exc_info:
        await task._send_data({'command': 'rrext_process', 'arguments': {'subcommand': 'open'}})
    assert exc_info.value.code == 'OUT_OF_CREDITS'
