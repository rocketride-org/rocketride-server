# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
EaaS answers a task's credit check, ``spend.check`` on the task channel.

The handler asks account.check_spend for the task's own org; a failed ledger
read is refused with a fixed message, and a refused pipe keeps its
OUT_OF_CREDITS code on the way back to the client. The same answer is the
engine-side backstop of the store gate (plan 8.4): a binding whose control
serves a paid listing is refused with SUBSCRIPTION_REQUIRED when the caller's
org holds no subscription, the verdict cached on the control.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.account
from ai.account.base import OutOfCreditsError, SubscriptionRequiredError
from ai.constants import CONST_BILLING_UNAVAILABLE
from ai.modules.task import task_channel
from ai.modules.task.task_channel import ChannelRefused
from ai.modules.task.task_control import DeploymentRef, Listing, TaskControl
from ai.modules.task.task_engine import TaskEngine, _check_spend

REFUSAL = 'Out of credits: add capacity on the Billing page to keep running pipelines'


def _task(org_id='org-1'):
    return TaskEngine(
        server=MagicMock(),
        id='t-1',
        project_id='p-1',
        source='s-1',
        engine_key='enginehash:u-1',
        address='acme.p-1.s-1',
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


@pytest.mark.asyncio
async def test_a_named_caller_is_the_paying_unit_not_the_engine_starter(monkeypatch):
    """The gate names the binding's caller (plan 8.3): their org is asked, whoever started the engine."""
    check = AsyncMock(return_value=None)
    monkeypatch.setattr(ai.account.account, 'check_spend', check)
    reply = await _check_spend(_task('org-starter'), {'caller': {'orgId': 'org-caller', 'userId': 'u'}}, None)
    check.assert_awaited_once_with('org-caller')
    assert reply.body == {'refusal': None}


# ---------------------------------------------------------------------------
# The store gate's engine-side backstop (plan 8.4)
# ---------------------------------------------------------------------------

CORRELATION = 'c' * 32


def _bound(mode='subscription', *, caller_org='org-2', rung='public'):
    """An engine with one binding EaaS admitted for a caller's control on a publication of ``mode``."""
    control = TaskControl(address='acme.docBrain.chat', orgId=caller_org, rung=rung, key='=control/' + 'a' * 32)
    control.deployment = DeploymentRef(org_id='org-1', team_id='@public', project_id='acme.docBrain')
    control.listing = Listing(mode=mode, plan='Pro')
    task = _task('org-1')
    task._server.control_by_key = lambda key: control if key == control.key else None
    task.admit_binding(CORRELATION, control.key)
    return task, control


def _caller(org='org-2'):
    """The arguments of a spend.check for the admitted binding."""
    return {'caller': {'orgId': org, 'userId': 'u-z', 'correlationId': CORRELATION}}


@pytest.fixture
def ledger(monkeypatch):
    """The account: credit always allowed; subscriptions per test."""
    subscribed = AsyncMock(return_value=False)
    check = AsyncMock(return_value=None)
    monkeypatch.setattr(ai.account.account, 'has_subscription', subscribed, raising=False)
    monkeypatch.setattr(ai.account.account, 'check_spend', check)
    return SimpleNamespace(has_subscription=subscribed, check_spend=check)


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['subscription', 'paywall'])
async def test_a_binding_on_a_paid_listing_without_a_subscription_is_refused_with_its_code(ledger, mode):
    """The refusal is named, so the engine's gate raises SubscriptionRequiredError; credit is not asked."""
    task, control = _bound(mode)

    reply = await _check_spend(task, _caller(), None)

    assert reply.body['code'] == SubscriptionRequiredError.code
    assert 'acme.docBrain' in reply.body['refusal'] and "'Pro'" in reply.body['refusal']
    ledger.has_subscription.assert_awaited_once_with('org-2', 'acme.docBrain')
    ledger.check_spend.assert_not_awaited()
    assert control.subscription_allowed_at == 0.0


@pytest.mark.asyncio
async def test_a_subscriber_passes_on_to_the_credit_check_and_the_verdict_is_cached(ledger):
    """An allow stands on the control for the window: the next binding asks no subscription question."""
    task, control = _bound()
    ledger.has_subscription.return_value = True

    for _ in range(3):
        reply = await _check_spend(task, _caller(), None)
        assert reply.body == {'refusal': None}

    assert ledger.has_subscription.await_count == 1
    assert ledger.check_spend.await_count == 3
    assert control.subscription_allowed_at > 0.0


@pytest.mark.asyncio
async def test_the_verdict_is_asked_again_after_the_window_and_a_refusal_never_stands(ledger):
    """A lapsed subscription is found once the window passes; a refusal is asked again every time."""
    task, control = _bound()
    ledger.has_subscription.return_value = True
    await _check_spend(task, _caller(), None)

    # The window lapsed and so did the subscription
    control.subscription_allowed_at -= 3600
    ledger.has_subscription.return_value = False
    for _ in range(2):
        reply = await _check_spend(task, _caller(), None)
        assert reply.body['code'] == SubscriptionRequiredError.code
    assert ledger.has_subscription.await_count == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'mode, caller_org, rung',
    [('free', 'org-2', 'public'), ('subscription', 'org-1', 'public'), ('subscription', 'org-2', 'me')],
    ids=['free', 'publisher-org', 'own-rung'],
)
async def test_a_binding_that_needs_no_subscription_is_never_asked(ledger, mode, caller_org, rung):
    """A free listing, the publisher's own org and the caller's own rungs go straight to the credit check."""
    task, _control = _bound(mode, caller_org=caller_org, rung=rung)

    reply = await _check_spend(task, _caller(caller_org), None)

    assert reply.body == {'refusal': None}
    ledger.has_subscription.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_binding_the_server_never_admitted_is_not_a_controls(ledger):
    """The control is found by the server's record of the binding, never by what the subprocess claims."""
    task, _control = _bound()

    reply = await _check_spend(task, {'caller': {'orgId': 'org-2', 'correlationId': 'f' * 32}}, None)

    assert reply.body == {'refusal': None}
    ledger.has_subscription.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_failed_subscription_read_is_refused_with_the_fixed_message(ledger):
    """No answer, no pipe: a store that cannot say is never read as subscribed."""
    task, _control = _bound()
    ledger.has_subscription.side_effect = RuntimeError('database unavailable')

    with pytest.raises(ChannelRefused) as refused:
        await _check_spend(task, _caller(), None)

    assert str(refused.value) == CONST_BILLING_UNAVAILABLE


@pytest.mark.asyncio
async def test_a_subscription_refusal_keeps_its_code_on_the_way_back():
    """The engine's refusal crosses the data hop as SubscriptionRequiredError."""
    task = _task()
    task._data_token = 'run-token'
    refused = {'type': 'response', 'success': False, 'message': 'needs a subscription', 'code': 'SUBSCRIPTION_REQUIRED'}
    task._data_client = SimpleNamespace(dap_request=AsyncMock(return_value=refused), did_fail=lambda r: True)

    with pytest.raises(SubscriptionRequiredError, match='needs a subscription') as exc_info:
        await task._send_data({'command': 'rrext_process', 'arguments': {'subcommand': 'open'}})
    assert exc_info.value.code == 'SUBSCRIPTION_REQUIRED'
