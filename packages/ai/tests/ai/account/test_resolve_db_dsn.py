# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Tests for ``AccountBase.resolve_db_dsn`` — the env-gated DB broker call.

The broker contract (locked 2026-07-23, shipped as saas #381):
``POST {ROCKETRIDE_DB_BROKER_URL} {"tenant_id": ...}`` with a Bearer token ->
``{"database", "role", "dsn", "created"}`` (only ``dsn`` is read), idempotent.
A real localhost HTTP server plays the broker so the actual urllib code path
is exercised.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ai.account.base import AccountBase

TEST_DSN = 'postgresql://r_t1_ab:secret@pooler.internal:5432/t_t1_ab?sslmode=require'
TEST_TOKEN = 'broker-token-123'


class _Minimal(AccountBase):
    async def authenticate(self, credential):  # pragma: no cover - unused
        return None


class _FakeBroker(BaseHTTPRequestHandler):
    """Stands in for the data-core provisioner."""

    requests: list = []

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        type(self).requests.append({'auth': self.headers.get('Authorization'), 'body': body})

        tenant = body.get('tenant_id', '')
        if self.headers.get('Authorization') != f'Bearer {TEST_TOKEN}':
            self.send_response(401)
            self.end_headers()
            return
        if tenant == 'unknown-tenant':
            self.send_response(404)
            self.end_headers()
            return
        if tenant == 'no-dsn-tenant':
            payload = {'database': 't_broken', 'role': 't_broken_rw', 'created': False}
        elif tenant == 'no-sslmode-tenant':
            bare = 'postgresql://r_t1_ab:secret@pooler.internal:5432/t_t1_ab'
            payload = {'database': 't_t1_ab', 'role': 't_t1_ab_rw', 'dsn': bare, 'created': False}
        elif tenant == 'bad-scheme-tenant':
            payload = {'database': 't_t1_ab', 'role': 't_t1_ab_rw', 'dsn': 'mysql://u:p@h/db', 'created': False}
        else:
            payload = {'database': 't_t1_ab', 'role': 't_t1_ab_rw', 'dsn': TEST_DSN, 'created': False}
        raw = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):  # silence request logging
        pass


@pytest.fixture()
def broker(monkeypatch):
    _FakeBroker.requests = []
    server = HTTPServer(('127.0.0.1', 0), _FakeBroker)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}/provision'
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', url)
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', TEST_TOKEN)
    yield _FakeBroker
    server.shutdown()
    server.server_close()


def _resolve(client_id: str) -> str:
    return asyncio.run(_Minimal().resolve_db_dsn(client_id))


def test_unconfigured_env_raises_signin_error(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_DB_BROKER_URL', raising=False)
    monkeypatch.delenv('ROCKETRIDE_DB_BROKER_TOKEN', raising=False)
    with pytest.raises(NotImplementedError, match='require signing into RocketRide cloud'):
        _resolve('tenant-1')


def test_partial_env_still_raises(monkeypatch, broker):
    monkeypatch.delenv('ROCKETRIDE_DB_BROKER_TOKEN', raising=False)
    with pytest.raises(NotImplementedError):
        _resolve('tenant-1')


def test_resolves_dsn_via_broker(broker):
    assert _resolve('tenant-1') == TEST_DSN


def test_client_id_passed_verbatim_as_tenant_id_with_bearer(broker):
    _resolve('Client-42 ')
    assert broker.requests == [{'auth': f'Bearer {TEST_TOKEN}', 'body': {'tenant_id': 'Client-42'}}]


def test_idempotent_recall_returns_same_dsn(broker):
    assert _resolve('tenant-1') == _resolve('tenant-1') == TEST_DSN
    assert len(broker.requests) == 2


def test_broker_4xx_raises_runtime_error(broker):
    with pytest.raises(RuntimeError, match='rejected provision.*404'):
        _resolve('unknown-tenant')


def test_bad_token_raises_runtime_error(broker, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', 'wrong')
    with pytest.raises(RuntimeError, match='rejected provision.*401'):
        _resolve('tenant-1')


def test_missing_dsn_in_response_raises(broker):
    with pytest.raises(RuntimeError, match='did not include a DSN'):
        _resolve('no-dsn-tenant')


def test_unreachable_broker_raises(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', 'http://127.0.0.1:9/provision')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', TEST_TOKEN)
    with pytest.raises(RuntimeError, match='unreachable'):
        _resolve('tenant-1')


def test_empty_client_id_rejected(broker):
    with pytest.raises(ValueError, match='non-empty client_id'):
        _resolve('   ')


# ---------------------------------------------------------------------------
# Transport security guards
# ---------------------------------------------------------------------------


def test_http_broker_url_rejected_for_non_localhost(monkeypatch):
    """The broker token can resolve any tenant's DSN — never send it over
    plain http to a remote host (a deployment typo must fail loudly).
    """
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', 'http://broker.internal/provision')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', TEST_TOKEN)
    with pytest.raises(RuntimeError, match='must use https'):
        _resolve('tenant-1')


def test_https_and_localhost_http_broker_urls_accepted():
    # https anywhere; plain http only on the loopback (local rig / this suite).
    AccountBase._check_broker_url('https://api.rocketride.ai/db/provision')
    AccountBase._check_broker_url('http://localhost:8090/provision')
    AccountBase._check_broker_url('http://127.0.0.1:8090/provision')
    with pytest.raises(RuntimeError, match='must use https'):
        AccountBase._check_broker_url('ftp://broker.internal/provision')
    with pytest.raises(RuntimeError, match='must use https'):
        AccountBase._check_broker_url('file:///etc/passwd')


def test_dsn_without_sslmode_gets_require_pinned(broker):
    """A broker regression that drops sslmode must not silently downgrade
    every tenant connection to cleartext.
    """
    dsn = _resolve('no-sslmode-tenant')
    assert dsn == 'postgresql://r_t1_ab:secret@pooler.internal:5432/t_t1_ab?sslmode=require'


def test_dsn_with_existing_sslmode_passes_through_unchanged(broker):
    assert _resolve('tenant-1') == TEST_DSN


def test_non_postgres_dsn_rejected(broker):
    with pytest.raises(RuntimeError, match='non-PostgreSQL DSN'):
        _resolve('bad-scheme-tenant')
