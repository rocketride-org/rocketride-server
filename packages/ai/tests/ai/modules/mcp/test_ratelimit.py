# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the per-account /mcp rate limits (ratelimit.py)."""

import logging

import pytest

from ai.account.models import AccountInfo
from ai.modules.mcp import ratelimit


def test_window_allows_up_to_the_limit_then_refuses_with_the_wait():
    now = [1000.0]
    window = ratelimit.SlidingWindow(3, clock=lambda: now[0])
    for _ in range(3):
        assert window.check('a') is None
        now[0] += 10
    # The oldest counted event was at 1000 and it is now 1030: it leaves in 30 seconds.
    assert window.check('a') == 30
    assert window.check('b') is None
    assert [ratelimit.SlidingWindow(0).check('a') for _ in range(5)] == [None] * 5


def test_window_recovers_as_events_leave_and_does_not_count_refusals():
    now = [1000.0]
    window = ratelimit.SlidingWindow(2, clock=lambda: now[0])
    assert window.check('a') is None
    assert window.check('a') is None
    now[0] += 59.5
    assert window.check('a') == 1
    assert window.check('a') == 1
    now[0] += 0.5
    # Had the two refusals counted, they would still fill the window here.
    assert window.check('a') is None
    assert window.check('a') is None
    assert window.check('a') == 60


def test_window_drops_stale_keys_then_the_least_recently_checked():
    now = [1000.0]
    window = ratelimit.SlidingWindow(5, max_keys=3, clock=lambda: now[0])
    window.check('old')
    now[0] += 61
    for key in ('a', 'b', 'c'):
        window.check(key)
    assert set(window._events) == {'a', 'b', 'c'}
    window.check('a')
    window.check('d')
    assert set(window._events) == {'a', 'c', 'd'}


@pytest.mark.parametrize(
    ('local_engine', 'env', 'expected'),
    [
        (False, {}, (600, 120)),
        (True, {}, (0, 0)),
        (True, {ratelimit.ENV_REQUESTS_PER_MINUTE: '700', ratelimit.ENV_CALLS_PER_MINUTE: ' 5 '}, (700, 5)),
        (False, {ratelimit.ENV_REQUESTS_PER_MINUTE: '0', ratelimit.ENV_CALLS_PER_MINUTE: ''}, (0, 120)),
    ],
)
def test_limits_from_env(monkeypatch, local_engine, env, expected):
    monkeypatch.delenv(ratelimit.ENV_REQUESTS_PER_MINUTE, raising=False)
    monkeypatch.delenv(ratelimit.ENV_CALLS_PER_MINUTE, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert ratelimit.limits_from_env(local_engine) == ratelimit.Limits(*expected)


def test_limits_from_env_bad_value_uses_the_default_and_logs_only_the_name(monkeypatch, caplog):
    monkeypatch.setenv(ratelimit.ENV_REQUESTS_PER_MINUTE, '-5')
    monkeypatch.setenv(ratelimit.ENV_CALLS_PER_MINUTE, 'rr_not_a_number')
    with caplog.at_level(logging.WARNING, logger=ratelimit.__name__):
        limits = ratelimit.limits_from_env(local_engine=False)
    assert limits == ratelimit.Limits(600, 120)
    assert len(caplog.records) == 2
    assert ratelimit.ENV_CALLS_PER_MINUTE in caplog.text
    assert '-5' not in caplog.text and 'rr_not_a_number' not in caplog.text


def test_account_key_is_the_user_id_whatever_credential_signed_in():
    by_key = ratelimit.account_key({'state': {'account': AccountInfo(userId='u1'), 'mcp_credential': 'rr_one'}})
    by_token = ratelimit.account_key({'state': {'account': AccountInfo(userId='u1'), 'mcp_credential': 'eyJ.a.b'}})
    other = ratelimit.account_key({'state': {'account': AccountInfo(userId='u2'), 'mcp_credential': 'rr_one'}})
    assert by_key == by_token == 'user:u1'
    assert other == 'user:u2'


def test_account_key_falls_back_to_a_hash_of_the_credential_then_none():
    empty_user = ratelimit.account_key({'state': {'account': AccountInfo(userId=''), 'mcp_credential': 'rr_one'}})
    no_account = ratelimit.account_key({'state': {'mcp_credential': 'rr_one'}})
    assert empty_user == no_account
    assert empty_user.startswith('credential:')
    assert 'rr_one' not in empty_user
    assert ratelimit.account_key({'state': {'mcp_credential': 'rr_two'}}) != empty_user
    assert ratelimit.account_key({'state': {}}) is None
    assert ratelimit.account_key({}) is None
