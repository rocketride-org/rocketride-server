# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.url_utils.validate_public_url`` — the SSRF
guard shared by tool nodes that follow URLs returned by third-party APIs.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_url_utils.py -v
"""

from __future__ import annotations

import socket

import pytest

from ai.common.utils import validate_public_url


def _stub_resolve(monkeypatch, ip: str) -> None:
    monkeypatch.setattr(
        socket,
        'getaddrinfo',
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 0, '', (ip, 0))],
    )


def test_allows_public_https(monkeypatch):
    _stub_resolve(monkeypatch, '93.184.216.34')
    assert validate_public_url('https://example.com/page') == 'https://example.com/page'


def test_rejects_non_http_scheme():
    with pytest.raises(ValueError):
        validate_public_url('ftp://example.com/file')


def test_rejects_loopback_literal():
    with pytest.raises(ValueError):
        validate_public_url('http://127.0.0.1/secret')


def test_rejects_private_resolved_host(monkeypatch):
    _stub_resolve(monkeypatch, '10.0.0.5')
    with pytest.raises(ValueError):
        validate_public_url('https://internal.example.com/admin')


def test_rejects_cgnat_resolved_host(monkeypatch):
    # 100.64.0.0/10 is shared/CGNAT space: is_private is False but is_global is
    # also False, so the old per-flag check let it through. is_global blocks it.
    _stub_resolve(monkeypatch, '100.64.0.1')
    with pytest.raises(ValueError):
        validate_public_url('https://carrier-nat.example.com/internal')


def test_rejects_unresolvable_host(monkeypatch):
    def _boom(*a, **k):
        raise socket.gaierror('name resolution failed')

    monkeypatch.setattr(socket, 'getaddrinfo', _boom)
    with pytest.raises(ValueError):
        validate_public_url('https://does-not-resolve.invalid/')
