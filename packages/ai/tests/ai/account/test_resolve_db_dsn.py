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
import io
import json
import ssl
import threading
import types
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import ai.account.base as base_module
from ai.account.base import AccountBase

TEST_DSN = 'postgresql://r_t1_ab:secret@pooler.internal:5432/t_t1_ab?sslmode=require'
TEST_TOKEN = 'broker-token-123'


class _Minimal(AccountBase):
    async def authenticate(self, credential):  # pragma: no cover - unused
        return None


class _FakeBroker(BaseHTTPRequestHandler):
    """Stands in for the data-core provisioner."""

    requests: list = []
    request_ids: list = []

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        type(self).requests.append({'auth': self.headers.get('Authorization'), 'body': body})
        type(self).request_ids.append(self.headers.get('X-Request-Id'))

        tenant = body.get('tenant_id', '')
        if self.headers.get('Authorization') != f'Bearer {TEST_TOKEN}':
            self.send_response(401)
            self.end_headers()
            return
        if body.get('owner_id') == 'retained-team':
            # The provisioner's answer for a retained tenant (aiohttp HTTPConflict).
            self.send_response(409, 'tenant is retained; POST /restore to bring it back')
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
        elif tenant == 'disable-tenant':
            payload = {'database': 't', 'role': 'r', 'dsn': 'postgresql://r:p@pooler.internal/t?sslmode=disable'}
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


@pytest.fixture(autouse=True)
def _clean_broker_env(monkeypatch):
    for name in (
        'RR_DB_BROKER_URL',
        'RR_DB_BROKER_TOKEN',
        'ROCKETRIDE_DB_BROKER_URL',
        'ROCKETRIDE_DB_BROKER_TOKEN',
        'RR_DB_TLS_ROOT_CERT',
        'RR_DB_ALLOW_INSECURE_DSN',
    ):
        monkeypatch.delenv(name, raising=False)
    # The legacy-name warning fires once per process; each test starts afresh.
    monkeypatch.setattr(base_module, '_LEGACY_BROKER_WARNED', False, raising=False)


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


@pytest.fixture(autouse=True)
def _reset_request_ids():
    _FakeBroker.request_ids = []


def _resolve(client_id: str) -> str:
    return asyncio.run(_Minimal().resolve_db_dsn(client_id))


def test_unconfigured_env_raises_no_cloud_db_error(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_DB_BROKER_URL', raising=False)
    monkeypatch.delenv('ROCKETRIDE_DB_BROKER_TOKEN', raising=False)
    with pytest.raises(NotImplementedError, match='no RocketRide cloud database is configured on this server'):
        _resolve('tenant-1')


@pytest.mark.parametrize(
    ('url', 'token', 'missing'),
    [
        ('', TEST_TOKEN, 'ROCKETRIDE_DB_BROKER_URL'),
        ('https://broker.example/provision', '   ', 'ROCKETRIDE_DB_BROKER_TOKEN'),
        (' ', '', 'RR_DB_BROKER_URL, RR_DB_BROKER_TOKEN'),
    ],
)
def test_missing_broker_variables_named_without_values(monkeypatch, url, token, missing):
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', url)
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', token)
    with pytest.raises(NotImplementedError) as excinfo:
        _resolve('tenant-1')
    assert str(excinfo.value) == f'no RocketRide cloud database is configured on this server (missing: {missing})'


def test_resolves_dsn_via_broker(broker):
    assert _resolve('tenant-1') == TEST_DSN


def test_client_id_passed_verbatim_as_tenant_id_with_bearer(broker):
    _resolve('Client-42 ')
    assert broker.requests == [{'auth': f'Bearer {TEST_TOKEN}', 'body': {'tenant_id': 'Client-42'}}]


@pytest.mark.parametrize(
    ('scope', 'owner', 'body'),
    [
        ('team', 'team-7', {'scope': 'team', 'org_id': 'org-1', 'owner_id': 'team-7'}),
        ('user', ' user-9 ', {'scope': 'user', 'org_id': 'org-1', 'owner_id': 'user-9'}),
    ],
)
def test_team_and_user_scope_send_the_scoped_body(broker, scope, owner, body):
    """The provisioner builds the team / user key itself (SDD 4.1)."""
    assert asyncio.run(_Minimal().resolve_db_dsn('org-1', scope=scope, owner_id=owner)) == TEST_DSN
    assert broker.requests == [{'auth': f'Bearer {TEST_TOKEN}', 'body': body}]


@pytest.mark.parametrize(
    ('scope', 'owner', 'message'),
    [
        ('org', 'team-7', 'org database takes no owner_id'),
        ('team', '', 'team database needs an owner_id'),
        ('user', '  ', 'user database needs an owner_id'),
        ('everyone', 'x', 'unknown database scope'),
    ],
)
def test_scope_and_owner_must_agree(broker, scope, owner, message):
    with pytest.raises(ValueError, match=message):
        asyncio.run(_Minimal().resolve_db_dsn('org-1', scope=scope, owner_id=owner))
    assert broker.requests == []


def test_retained_database_is_a_clear_error(broker):
    """409 from /provision: the database was retained (team deleted, user left)."""
    with pytest.raises(RuntimeError, match=r'has been retired and cannot be used \(HTTP 409: tenant is retained'):
        asyncio.run(_Minimal().resolve_db_dsn('org-1', scope='team', owner_id='retained-team'))


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


def test_broker_http_error_response_is_closed(monkeypatch):
    response_body = io.BytesIO(b'broker error')
    error = urllib.error.HTTPError(
        'https://broker.example/provision',
        503,
        'Service Unavailable',
        hdrs=None,
        fp=response_body,
    )

    def raise_http_error(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', raise_http_error)

    with pytest.raises(RuntimeError, match='rejected provision.*503'):
        AccountBase._call_db_broker('https://broker.example/provision', TEST_TOKEN, {'tenant_id': 'tenant-1'})

    assert response_body.closed


def test_missing_dsn_in_response_raises(broker):
    with pytest.raises(RuntimeError, match='did not include a DSN'):
        _resolve('no-dsn-tenant')


@pytest.mark.parametrize(
    'raw',
    [b'<html>not json</html>', b'{"dsn": "postgresql://u:p@h/db"', b'\xff\xfe not utf-8'],
    ids=['html-page', 'truncated-json', 'invalid-utf8'],
)
def test_a_reachable_broker_with_a_non_json_answer_is_a_bad_response_not_unreachable(monkeypatch, raw):
    """The broker was reached and answered 200: an operator must not be sent
    looking for a network fault, and the body (which may carry a DSN) is not repeated.
    """

    class FakeResponse(io.BytesIO):
        status = 200

    def fake_open(self, request, data=None, timeout=None):
        return FakeResponse(raw)

    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', fake_open)
    with pytest.raises(RuntimeError) as excinfo:
        AccountBase._call_db_broker('https://broker.example/provision', TEST_TOKEN, {'tenant_id': 't'})
    assert str(excinfo.value) == 'DB broker answered with a response that is not JSON'
    assert 'postgresql://' not in str(excinfo.value)


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


# ---------------------------------------------------------------------------
# Broker transport: no redirects, no ambient proxy, fixed timeout, safe errors
# ---------------------------------------------------------------------------


class _Hits(BaseHTTPRequestHandler):
    """Records every request it receives (the place a redirect must not reach)."""

    hits: list = []

    def _record(self):
        type(self).hits.append((self.command, self.path, self.headers.get('Authorization')))
        raw = json.dumps({'dsn': TEST_DSN}).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = _record  # noqa: N815 (http.server API)

    def log_message(self, *args):
        pass


class _Redirecting(BaseHTTPRequestHandler):
    code = 302
    location = ''

    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(type(self).code)
        self.send_header('Location', type(self).location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *args):
        pass


def _serve(handler):
    server = HTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture()
def redirect_rig(monkeypatch):
    """A broker that always redirects, and a sink on another origin."""
    _Hits.hits = []
    sink = _serve(_Hits)
    broker = _serve(_Redirecting)
    _Redirecting.location = f'http://localhost:{sink.server_port}/steal'
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', f'http://127.0.0.1:{broker.server_port}/provision')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', TEST_TOKEN)
    yield sink
    for server in (broker, sink):
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize('code', [301, 302, 303, 307, 308])
def test_a_redirect_is_refused_and_its_target_gets_nothing(redirect_rig, code):
    """Plain urllib follows 301/302/303 as a GET with the Authorization header,
    to any host, and accept the redirected body as the broker's answer.
    """
    _Redirecting.code = code
    with pytest.raises(RuntimeError, match=rf'redirect \(HTTP {code}\)'):
        _resolve('tenant-1')
    assert _Hits.hits == []


def test_ambient_proxy_settings_are_ignored(broker, monkeypatch):
    """The broker call carries the Tier-0 token: it never goes through an
    http(s)_proxy picked up from the environment.
    """
    _Hits.hits = []
    sink = _serve(_Hits)
    # urlopen caches its default opener on first use; start from a clean slate
    # so the proxy variables below are read the way a fresh process reads them.
    monkeypatch.setattr(urllib.request, '_opener', None)
    try:
        monkeypatch.setenv('http_proxy', f'http://127.0.0.1:{sink.server_port}')
        monkeypatch.setenv('HTTP_PROXY', f'http://127.0.0.1:{sink.server_port}')
        assert _resolve('tenant-1') == TEST_DSN
    finally:
        sink.shutdown()
        sink.server_close()
    assert _Hits.hits == []
    assert len(broker.requests) == 1


def test_broker_call_times_out_after_sixty_seconds(monkeypatch):
    """A first provision creates a database from a template, which is slow."""
    seen = {}

    def fake_open(self, request, data=None, timeout=None):
        seen['timeout'] = timeout
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', fake_open)
    with pytest.raises(RuntimeError, match='unreachable'):
        AccountBase._call_db_broker('https://broker.example/provision', TEST_TOKEN, {'tenant_id': 't'})
    assert seen['timeout'] == 60


def test_failures_report_a_fixed_phrase_and_the_exception_type_only(monkeypatch):
    """str(e) of a URL or TLS error can carry host names or URL userinfo and
    reaches the task's ROCKETRIDE_DB_RESOLVE_ERROR, so it is not repeated.
    """

    def fake_open(self, request, data=None, timeout=None):
        raise urllib.error.URLError(ssl.SSLCertVerificationError(1, 'hostname mismatch: db.secret-host.internal'))

    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', fake_open)
    with pytest.raises(RuntimeError) as excinfo:
        AccountBase._call_db_broker('https://broker.example/provision', TEST_TOKEN, {'tenant_id': 't'})
    assert str(excinfo.value) == 'DB broker unreachable (SSLCertVerificationError)'


def test_failure_detail_goes_to_the_server_log_without_the_token(monkeypatch):
    logged = []

    def fake_open(self, request, data=None, timeout=None):
        raise urllib.error.URLError(OSError(f'failed after sending {TEST_TOKEN}'))

    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', fake_open)
    monkeypatch.setattr(base_module, '_server_log', lambda message: logged.append(message))
    with pytest.raises(RuntimeError):
        AccountBase._call_db_broker('https://broker.example/provision', TEST_TOKEN, {'tenant_id': 't'})
    assert logged and 'OSError' in logged[0]
    assert TEST_TOKEN not in ' '.join(logged)


# ---------------------------------------------------------------------------
# Broker URL: shape checks everywhere, https only on hosted engines
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'url',
    [
        'https://user:pw@broker.example/provision',
        'https://user@broker.example/provision',
        'http://x@localhost/provision',
        'http://evil.example;@localhost/provision',
        'https://broker.example\\@evil.example/provision',
        'https://broker.example/provision#frag',
        'https://',
        'https:///provision',
        'https://broker.example:notaport/provision',
        'https://[::1/provision',
    ],
)
def test_malformed_or_credential_bearing_broker_urls_are_rejected(url):
    with pytest.raises(RuntimeError) as excinfo:
        AccountBase._check_broker_url(url)
    message = str(excinfo.value)
    assert 'user:pw' not in message and 'broker.example' not in message


@pytest.mark.parametrize('url', ['http://localhost:8090/provision', 'http://127.0.0.1/provision', 'http://[::1]:1/p'])
def test_hosted_engines_refuse_plain_http_even_on_loopback(url):
    AccountBase._check_broker_url(url)  # the local rig default still works
    with pytest.raises(RuntimeError, match='must use https'):
        AccountBase._check_broker_url(url, allow_loopback_http=False)
    AccountBase._check_broker_url('https://broker.example/provision', allow_loopback_http=False)


def test_a_hosted_engine_never_sends_the_token_over_http(broker):
    class _Hosted(_Minimal):
        capabilities = ('saas',)

    with pytest.raises(RuntimeError, match='must use https'):
        asyncio.run(_Hosted().resolve_db_dsn('tenant-1'))
    assert broker.requests == []


def test_a_credential_bearing_url_never_reaches_the_network(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', 'https://svc:HUNTER2-PW@broker.example/provision')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', TEST_TOKEN)
    with pytest.raises(RuntimeError) as excinfo:
        _resolve('tenant-1')
    assert 'HUNTER2' not in str(excinfo.value)


# ---------------------------------------------------------------------------
# Broker configuration tiers: operator-only RR_DB_BROKER_*, legacy fallback
# ---------------------------------------------------------------------------


def _set_broker(monkeypatch, url_name, token_name, server_port, token=TEST_TOKEN):
    monkeypatch.setenv(url_name, f'http://127.0.0.1:{server_port}/provision')
    monkeypatch.setenv(token_name, token)


@pytest.fixture()
def two_brokers():
    """Two fake provisioners on different ports, each recording its requests."""

    class _A(_FakeBroker):
        requests: list = []

    class _B(_FakeBroker):
        requests: list = []

    servers = [HTTPServer(('127.0.0.1', 0), cls) for cls in (_A, _B)]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    yield (_A, servers[0].server_port), (_B, servers[1].server_port)
    for server in servers:
        server.shutdown()
        server.server_close()


def test_the_operator_tier_resolves_without_a_deprecation_warning(two_brokers, monkeypatch):
    (operator, port), _ = two_brokers
    logged = []
    monkeypatch.setattr(base_module, '_server_log', logged.append)
    _set_broker(monkeypatch, 'RR_DB_BROKER_URL', 'RR_DB_BROKER_TOKEN', port)
    assert _resolve('tenant-1') == TEST_DSN
    assert len(operator.requests) == 1
    assert logged == []


def test_the_operator_tier_wins_over_the_legacy_tier(two_brokers, monkeypatch):
    (operator, operator_port), (legacy, legacy_port) = two_brokers
    _set_broker(monkeypatch, 'RR_DB_BROKER_URL', 'RR_DB_BROKER_TOKEN', operator_port)
    _set_broker(monkeypatch, 'ROCKETRIDE_DB_BROKER_URL', 'ROCKETRIDE_DB_BROKER_TOKEN', legacy_port)
    _resolve('tenant-1')
    assert (len(operator.requests), len(legacy.requests)) == (1, 0)


def test_the_legacy_tier_still_works_and_warns_once(two_brokers, monkeypatch):
    (legacy, port), _ = two_brokers
    logged = []
    monkeypatch.setattr(base_module, '_server_log', logged.append)
    _set_broker(monkeypatch, 'ROCKETRIDE_DB_BROKER_URL', 'ROCKETRIDE_DB_BROKER_TOKEN', port)
    assert _resolve('tenant-1') == _resolve('tenant-1') == TEST_DSN
    assert len(legacy.requests) == 2
    assert len(logged) == 1
    assert 'deprecated' in logged[0] and 'RR_DB_BROKER_URL' in logged[0]
    assert TEST_TOKEN not in logged[0]


@pytest.mark.parametrize(
    ('url_var', 'token_var', 'missing'),
    [
        ('RR_DB_BROKER_URL', 'ROCKETRIDE_DB_BROKER_TOKEN', 'RR_DB_BROKER_TOKEN'),
        ('ROCKETRIDE_DB_BROKER_URL', 'RR_DB_BROKER_TOKEN', 'ROCKETRIDE_DB_BROKER_TOKEN'),
    ],
)
def test_the_two_tiers_are_never_mixed(two_brokers, monkeypatch, url_var, token_var, missing):
    """The URL picks the tier and the token must come from that tier: a token
    from the other tier (which a client may have been able to write) is never
    sent to this tier's URL.
    """
    (broker_a, port), _ = two_brokers
    monkeypatch.setenv(url_var, f'http://127.0.0.1:{port}/provision')
    monkeypatch.setenv(token_var, TEST_TOKEN)
    with pytest.raises(NotImplementedError) as excinfo:
        _resolve('tenant-1')
    assert str(excinfo.value).endswith(f'(missing: {missing})')
    assert broker_a.requests == []


# ---------------------------------------------------------------------------
# Tenant database TLS: hosted verify-full against the operator CA, fail closed
# ---------------------------------------------------------------------------

PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUEXAMPLEONLYnotARealCertificate\n-----END CERTIFICATE-----\n'
BROKER_DSN = 'postgresql://role:p%40ss%25w@rocketride-data-pool.ns.svc:5432/t_acme?sslmode=require'


class _Hosted(_Minimal):
    capabilities = ('saas',)


class _FakeResponse:
    def __init__(self, dsn):
        self._raw = json.dumps({'dsn': dsn}).encode('utf-8')

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def hosted_broker(monkeypatch, tmp_path):
    """A hosted engine, https broker URL, operator CA file; the wire is faked."""
    ca = tmp_path / 'db-ca.crt'
    ca.write_text(PEM)
    monkeypatch.setenv('RR_DB_BROKER_URL', 'https://broker.example/provision')
    monkeypatch.setenv('RR_DB_BROKER_TOKEN', TEST_TOKEN)
    monkeypatch.setenv('RR_DB_TLS_ROOT_CERT', str(ca))
    answer = {'dsn': BROKER_DSN}
    calls = []

    def fake_open(self, request, data=None, timeout=None):
        calls.append(request)
        return _FakeResponse(answer['dsn'])

    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', fake_open)
    return types.SimpleNamespace(ca=ca, answer=answer, calls=calls)


def _resolve_hosted():
    return asyncio.run(_Hosted().resolve_db_dsn('org-1'))


def test_hosted_issues_verify_full_against_the_operator_ca(hosted_broker):
    dsn = _resolve_hosted()
    base, _, query = dsn.partition('?')
    assert base == 'postgresql://role:p%40ss%25w@rocketride-data-pool.ns.svc:5432/t_acme'
    # The CA path is percent-encoded in the query (libpq and SQLAlchemy decode
    # it), so compare decoded values: a Windows path has ':' and '\'.
    assert urllib.parse.parse_qs(query, strict_parsing=True) == {
        'sslmode': ['verify-full'],
        'sslrootcert': [str(hosted_broker.ca)],
    }
    assert len(hosted_broker.calls) == 1


def test_hosted_ca_path_round_trips_through_the_dsn_whatever_its_characters():
    """A Windows path, a space, '&' and '%' are encoded so they cannot add or end a parameter."""
    ca = 'C:\\Users\\runner\\db ca&100%.crt'
    dsn = AccountBase._pin_dsn_tls('postgresql://r:p@pool.ns.svc/t?sslmode=require', hosted=True, ca_file=ca)
    query = dsn.partition('?')[2]
    assert urllib.parse.parse_qs(query, strict_parsing=True) == {'sslmode': ['verify-full'], 'sslrootcert': [ca]}
    # libpq percent-decodes but keeps '+' literal, so a space must be %20, never '+'.
    assert query == 'sslmode=verify-full&sslrootcert=C%3A%5CUsers%5Crunner%5Cdb%20ca%26100%25.crt'


@pytest.mark.parametrize(
    'dsn',
    [
        'postgresql://r:p@pool.ns.svc/t?sslmode=disable',
        'postgresql://r:p@pool.ns.svc/t?sslmode=require&sslmode=disable',
        'postgresql://r:p@pool.ns.svc/t?sslmode=require&host=evil.example',
        'postgresql://r:p@pool.ns.svc/t?sslmode=require&sslrootcert=/dev/null',
    ],
)
def test_hosted_refuses_a_broker_dsn_that_weakens_or_overrides(hosted_broker, dsn):
    hosted_broker.answer['dsn'] = dsn
    with pytest.raises(RuntimeError, match='DB broker returned'):
        _resolve_hosted()


def test_hosted_without_a_ca_variable_fails_before_the_broker_is_called(hosted_broker, monkeypatch):
    monkeypatch.delenv('RR_DB_TLS_ROOT_CERT')
    with pytest.raises(RuntimeError) as excinfo:
        _resolve_hosted()
    assert 'RR_DB_TLS_ROOT_CERT' in str(excinfo.value)
    assert hosted_broker.calls == []  # nothing was provisioned for a DSN that could not be delivered


@pytest.mark.parametrize(
    'content', [None, '', 'not a certificate\n', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n']
)
def test_hosted_with_a_missing_or_useless_ca_file_fails_closed(hosted_broker, content):
    if content is None:
        hosted_broker.ca.unlink()
    else:
        hosted_broker.ca.write_text(content)
    with pytest.raises(RuntimeError) as excinfo:
        _resolve_hosted()
    message = str(excinfo.value)
    assert 'RR_DB_TLS_ROOT_CERT' in message
    assert str(hosted_broker.ca) not in message and 'rocketride-data-pool' not in message
    assert hosted_broker.calls == []


def test_a_non_hosted_engine_rejects_a_broker_downgrade_by_default(broker):
    with pytest.raises(RuntimeError, match='RR_DB_ALLOW_INSECURE_DSN'):
        _resolve('disable-tenant')


def test_the_insecure_opt_in_lets_a_non_hosted_engine_accept_it(broker, monkeypatch):
    monkeypatch.setenv('RR_DB_ALLOW_INSECURE_DSN', '1')
    assert _resolve('disable-tenant') == 'postgresql://r:p@pooler.internal/t?sslmode=disable'


def test_the_insecure_opt_in_does_nothing_on_a_hosted_engine(hosted_broker, monkeypatch):
    monkeypatch.setenv('RR_DB_ALLOW_INSECURE_DSN', '1')
    hosted_broker.answer['dsn'] = 'postgresql://r:p@pool.ns.svc/t?sslmode=disable'
    with pytest.raises(RuntimeError, match='DB broker returned'):
        _resolve_hosted()


# ---------------------------------------------------------------------------
# Request id: the task id travels to the broker for its own log line
# ---------------------------------------------------------------------------


def test_the_request_id_is_sent_as_a_header(broker):
    asyncio.run(_Minimal().resolve_db_dsn('tenant-1', request_id='ab12cd34.chat_1'))
    assert broker.request_ids == ['ab12cd34.chat_1']


def test_no_request_id_sends_no_header(broker):
    _resolve('tenant-1')
    assert broker.request_ids == [None]


def test_a_request_id_cannot_inject_a_header(broker):
    asyncio.run(_Minimal().resolve_db_dsn('tenant-1', request_id='x\r\nX-Evil: 1'))
    assert broker.request_ids == ['x__X-Evil:_1']
    assert len(broker.requests) == 1
