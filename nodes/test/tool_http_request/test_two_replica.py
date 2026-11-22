# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
The two-replica test of tool_http_request's rate limits (plan 4.3, 5.7, section 12).

A limiter held per process let every replica send the full limit, so the
limit was never the limit. The counters now live in the control's state:
the calls of one control alternate between two replicas, each with its own
import of the node, and the limit refuses the same call it refuses on one
replica. Another owner counts against limits of its own. The clock is frozen
so every call falls in one window.
"""

from __future__ import annotations

import time

import pytest

from test.framework.replicas import NODES_DIR, Call, Owner, run_alternating_and_alone

NODE_DIR = NODES_DIR / 'tool_http_request'
NODE_ID = 'http_1'

ALICE = Owner(orgId='org-a', userId='alice')
BOB = Owner(orgId='org-a', userId='bob')


def _attempt(instance):
    """Take and give back one request's slot; forward what happened on the text lane."""
    limiter = instance._limiter()
    try:
        slot = limiter.acquire()
    except Exception as e:  # noqa: BLE001 - each replica imports its own RateLimitError class
        instance.instance.writeText(type(e).__name__)
        return
    limiter.release(slot)
    instance.instance.writeText('ok')


def _call(owner, **params):
    """One call making one request attempt."""
    return Call(owner=owner, params=params, invoke=_attempt)


def _texts(outputs):
    """The text each call forwarded."""
    return [args[0] for call in outputs for name, args in call if name == 'writeText']


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    """One second for the whole test: every call falls in the same windows."""
    monkeypatch.setattr(time, 'time', lambda: 1_000_020.5)


def test_the_per_second_limit_holds_across_replicas():
    calls = [_call(ALICE, rateLimitPerSecond=2) for _ in range(4)]
    alternating, reference = run_alternating_and_alone(NODE_DIR, 'tool_http_request', NODE_ID, calls)
    assert alternating == reference
    assert _texts(reference) == ['ok', 'ok', 'RateLimitError', 'RateLimitError']


def test_another_owner_counts_against_limits_of_its_own():
    alice = [_call(ALICE, rateLimitPerSecond=1) for _ in range(3)]
    bob = [_call(BOB, rateLimitPerSecond=1) for _ in range(3)]
    interleaved = [call for pair in zip(alice, bob) for call in pair]
    together, _ = run_alternating_and_alone(NODE_DIR, 'tool_http_request', NODE_ID, interleaved)
    assert _texts(together) == ['ok', 'ok'] + ['RateLimitError'] * 4
