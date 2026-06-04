# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.http_retry.post_with_retry`` — the shared
tenacity-based POST-with-retry helper used by tool nodes.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_http_retry.py -v
"""

from __future__ import annotations

import pytest
import requests

import ai.common.utils.http_retry as hr
from ai.common.utils import post_with_retry


class _FakeResp:
    def __init__(self, status_code: int, payload=None):
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            err = requests.exceptions.HTTPError(f'HTTP {self.status_code}')
            err.response = self
            raise err

    def json(self):
        return self._payload


def _patch_post(monkeypatch, fn):
    monkeypatch.setattr(hr.requests, 'post', fn)


def test_returns_response_on_success(monkeypatch):
    ok = _FakeResp(200, {'ok': True})
    _patch_post(monkeypatch, lambda *a, **k: ok)
    assert post_with_retry('https://api.example.com', base_delay=0) is ok


def test_retries_timeout_then_succeeds(monkeypatch):
    calls = {'n': 0}
    ok = _FakeResp(200, {})

    def fake_post(*a, **k):
        calls['n'] += 1
        if calls['n'] == 1:
            raise requests.exceptions.Timeout()
        return ok

    _patch_post(monkeypatch, fake_post)
    assert post_with_retry('https://api.example.com', base_delay=0) is ok
    assert calls['n'] == 2


def test_retries_429_then_succeeds(monkeypatch):
    calls = {'n': 0}
    ok = _FakeResp(200, {})

    def fake_post(*a, **k):
        calls['n'] += 1
        return _FakeResp(429) if calls['n'] == 1 else ok

    _patch_post(monkeypatch, fake_post)
    assert post_with_retry('https://api.example.com', base_delay=0) is ok
    assert calls['n'] == 2


def test_retries_5xx_then_succeeds(monkeypatch):
    calls = {'n': 0}
    ok = _FakeResp(200, {})

    def fake_post(*a, **k):
        calls['n'] += 1
        return _FakeResp(500) if calls['n'] == 1 else ok

    _patch_post(monkeypatch, fake_post)
    assert post_with_retry('https://api.example.com', base_delay=0) is ok
    assert calls['n'] == 2


def test_does_not_retry_4xx(monkeypatch):
    calls = {'n': 0}

    def fake_post(*a, **k):
        calls['n'] += 1
        return _FakeResp(404)

    _patch_post(monkeypatch, fake_post)
    with pytest.raises(requests.exceptions.HTTPError):
        post_with_retry('https://api.example.com', base_delay=0)
    assert calls['n'] == 1  # no retry on a non-429 4xx


def test_reraises_after_exhausting_attempts(monkeypatch):
    calls = {'n': 0}

    def fake_post(*a, **k):
        calls['n'] += 1
        raise requests.exceptions.ConnectionError('refused')

    _patch_post(monkeypatch, fake_post)
    with pytest.raises(requests.exceptions.ConnectionError):
        post_with_retry('https://api.example.com', max_attempts=3, base_delay=0)
    assert calls['n'] == 3
