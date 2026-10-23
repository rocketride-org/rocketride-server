# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
require_credit is the engine's pipe gate on a hosted task.

It asks EaaS ``spend.check`` over the task channel and turns a refusal into
OutOfCreditsError; an allowed answer stands for CONST_SPEND_ALLOW_SECONDS.
"""

from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

import pytest

import ai.modules.data.data_server as data_server
from ai.account.base import OutOfCreditsError
from ai.constants import CONST_BILLING_UNAVAILABLE
from ai.modules.data.channel import ChannelError, ChannelReply, ChannelUnavailable

REFUSAL = 'Out of credits'


class _Channel:
    """Answers spend.check with ``refusal``, or raises ``error``."""

    def __init__(self):
        self.refusal = None
        self.error = None
        self.asked = []

    def request_sync(self, command, arguments=None, *, timeout):
        self.asked.append(command)
        if self.error:
            raise self.error
        return ChannelReply(body={'refusal': self.refusal})


@pytest.fixture
def channel(monkeypatch):
    """A channel to EaaS, and no cached "allowed" answer."""
    fake = _Channel()
    monkeypatch.setattr(data_server, 'task_channel', fake)
    monkeypatch.setattr(data_server, '_allowed_until', 0.0)
    return fake


def test_a_refusal_from_eaas_refuses_the_pipe(channel):
    channel.refusal = REFUSAL

    with pytest.raises(OutOfCreditsError, match=REFUSAL) as refused:
        data_server.require_credit()

    assert refused.value.code == 'OUT_OF_CREDITS'
    assert channel.asked == ['spend.check']


def test_no_refusal_lets_the_pipe_through(channel):
    data_server.require_credit()

    assert channel.asked == ['spend.check']


@pytest.mark.parametrize(
    'error, reason',
    [
        (ChannelUnavailable('the engine has not connected'), 'the engine has not connected'),
        (ChannelError('spend.check', 'timeout'), 'timeout'),
        (ChannelError('spend.check', CONST_BILLING_UNAVAILABLE), CONST_BILLING_UNAVAILABLE),
    ],
    ids=['not-connected', 'timeout', 'billing-unavailable'],
)
def test_no_answer_refuses_the_pipe_with_the_reason(channel, error, reason):
    channel.error = error

    with pytest.raises(RuntimeError) as refused:
        data_server.require_credit()

    assert str(refused.value) == f'No credit check answered: {reason}'


@pytest.mark.parametrize('hosted', [True, False])
def test_only_a_hosted_task_makes_require_credit_the_pipe_gate(monkeypatch, hosted):
    set_gate = MagicMock()
    monkeypatch.setattr(data_server.engLib, 'setPipeGate', set_gate)
    monkeypatch.setattr(data_server.sys, 'argv', ['node.py', '--hosted'] if hosted else ['node.py'])

    data_server.DataServer(server=MagicMock())

    assert set_gate.call_args_list == ([((data_server.require_credit,),)] if hosted else [])


def test_an_allowed_answer_stands_for_the_window(channel):
    data_server.require_credit()
    data_server.require_credit()

    assert len(channel.asked) == 1


def test_an_expired_window_asks_again(channel, monkeypatch):
    monkeypatch.setattr(data_server, 'CONST_SPEND_ALLOW_SECONDS', 0.0)

    data_server.require_credit()
    data_server.require_credit()

    assert len(channel.asked) == 2


def test_a_refusal_is_asked_again_every_time(channel):
    channel.refusal = REFUSAL
    for _ in range(2):
        with pytest.raises(OutOfCreditsError):
            data_server.require_credit()

    assert len(channel.asked) == 2


def test_pipes_opened_together_ask_once_and_all_wait_for_the_answer(channel):
    answered = threading.Event()
    real = channel.request_sync

    def slow(command, arguments=None, *, timeout):
        time.sleep(0.05)
        reply = real(command, arguments, timeout=timeout)
        answered.set()
        return reply

    channel.request_sync = slow
    errors = []

    def check():
        try:
            data_server.require_credit()
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=check) for _ in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)

    assert not any(thread.is_alive() for thread in threads) and errors == []
    assert answered.is_set() and len(channel.asked) == 1
