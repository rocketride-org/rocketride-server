# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the shared Google Workspace credential/request machinery."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap: importing the nodes package pulls engine runtime
# modules (depends/rocketlib); stub them if absent so this file never depends
# on a sibling test having run first, then drop what we added.
from unittest.mock import MagicMock

_added = []
for _name in ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
    if _name not in sys.modules:
        _stub = MagicMock()
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'rocketlib':
            _stub.IInstanceBase = object
            _stub.IGlobalBase = object
            _stub.tool_function = lambda **kw: lambda f: f
        sys.modules[_name] = _stub
        _added.append(_name)

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_google_workspace import google_client

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)
# Keep a direct reference; tests only touch google_client's pure functions.


@pytest.fixture
def service() -> google_client.GoogleService:
    return google_client.GoogleService(
        product='Test',
        api='sheets',
        version='v4',
        superset_scopes=frozenset({'https://www.googleapis.com/auth/spreadsheets'}),
    )


def test_resolve_token_uri_accepts_google_endpoints_and_rejects_untrusted_values(service):
    assert google_client.resolve_token_uri(service, None) == 'https://oauth2.googleapis.com/token'
    assert google_client.resolve_token_uri(service, 'https://accounts.google.com/o/oauth2/token') == (
        'https://accounts.google.com/o/oauth2/token'
    )

    for value in ('http://oauth2.googleapis.com/token', 'https://attacker.example/token', 123):
        with pytest.raises(ValueError, match='Test token_uri'):
            google_client.resolve_token_uri(service, value)


def test_resolve_refresh_url_accepts_broker_hosts_and_rejects_untrusted_values(service):
    assert google_client.resolve_refresh_url(service, 'https://oauth2.rocketride.ai/refresh') == (
        'https://oauth2.rocketride.ai/refresh'
    )
    assert google_client.resolve_refresh_url(service, 'https://oauth.rocketride.ai/refresh') == (
        'https://oauth.rocketride.ai/refresh'
    )
    assert google_client.resolve_refresh_url(service, None) is None

    for value in ('http://oauth2.rocketride.ai/refresh', 'https://attacker.example/refresh', 123):
        with pytest.raises(ValueError):
            google_client.resolve_refresh_url(service, value)


def test_resolve_refresh_url_accepts_schemeless_env_broker(monkeypatch, service):
    monkeypatch.setenv('RR_OAUTH_BROKER_URL', 'broker.example.com')
    url = 'https://broker.example.com/refresh'
    assert google_client.resolve_refresh_url(service, url) == url


def test_is_rate_limit_403_prefers_structured_error_body():
    rate = types.SimpleNamespace(
        resp=types.SimpleNamespace(status=403),
        reason='Forbidden',
        content=b'{"error": {"errors": [{"reason": "userRateLimitExceeded"}]}}',
    )
    permission = types.SimpleNamespace(
        resp=types.SimpleNamespace(status=403),
        reason='quotaExceeded appears only in fallback text',
        content=b'{"error": {"errors": [{"reason": "insufficientPermissions"}]}}',
    )

    assert google_client._is_rate_limit_403(rate) is True
    assert google_client._is_rate_limit_403(permission) is False


def test_is_rate_limit_403_falls_back_for_unstructured_bodies():
    rate = types.SimpleNamespace(
        resp=types.SimpleNamespace(status=403),
        reason='quotaExceeded',
        content=b'Forbidden',
    )
    permission = types.SimpleNamespace(
        resp=types.SimpleNamespace(status=403),
        reason='insufficientPermissions',
        content=b'Forbidden',
    )
    not_403 = types.SimpleNamespace(
        resp=types.SimpleNamespace(status=429),
        reason='quotaExceeded',
        content=b'',
    )

    assert google_client._is_rate_limit_403(rate) is True
    assert google_client._is_rate_limit_403(permission) is False
    assert google_client._is_rate_limit_403(not_403) is False


def test_is_rate_limit_403_matches_one_platform_screaming_snake_case():
    """One Platform ErrorInfo reasons are SCREAMING_SNAKE_CASE ('RATE_LIMIT_EXCEEDED'),
    not the legacy camelCase ('rateLimitExceeded') the reason set is written in.
    """
    rate = types.SimpleNamespace(
        resp=types.SimpleNamespace(status=403),
        reason='Forbidden',
        content=json.dumps(
            {
                'error': {
                    'status': 'RESOURCE_EXHAUSTED',
                    'details': [
                        {
                            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                            'reason': 'RATE_LIMIT_EXCEEDED',
                        }
                    ],
                }
            }
        ).encode(),
    )
    assert google_client._is_rate_limit_403(rate) is True


def test_error_reason_code_parses_legacy_errors_array():
    exc = types.SimpleNamespace(content=b'{"error": {"errors": [{"reason": "accessNotConfigured"}]}}')
    assert google_client._error_reason_code(exc) == 'accessNotConfigured'


def test_error_reason_code_parses_one_platform_error_info_details():
    """Sheets/Docs (One Platform APIs) carry no errors[] array at all — the reason
    lives in a google.rpc.ErrorInfo entry inside error.details[] instead. This is
    the actual body Google returns for a disabled Sheets/Docs API (#1694).
    """
    body = {
        'error': {
            'code': 403,
            'message': 'Google Sheets API has not been used in project 123456789 before or it is disabled.',
            'status': 'PERMISSION_DENIED',
            'details': [
                {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    'reason': 'SERVICE_DISABLED',
                    'domain': 'googleapis.com',
                }
            ],
        }
    }
    exc = types.SimpleNamespace(content=json.dumps(body).encode())
    assert google_client._error_reason_code(exc) == 'SERVICE_DISABLED'


def test_error_reason_code_ignores_non_error_info_details():
    """A details[] entry that isn't a google.rpc.ErrorInfo (e.g. a Help or LocalizedMessage
    detail with no 'reason' field) must not be mistaken for the reason-carrying entry.
    """
    body = {
        'error': {
            'status': 'PERMISSION_DENIED',
            'details': [{'@type': 'type.googleapis.com/google.rpc.Help', 'links': []}],
        }
    }
    exc = types.SimpleNamespace(content=json.dumps(body).encode())
    assert google_client._error_reason_code(exc) == 'PERMISSION_DENIED'  # falls back to error.status


def test_error_reason_code_falls_back_to_grpc_status_without_error_info():
    body = {'error': {'code': 403, 'message': 'Permission denied.', 'status': 'PERMISSION_DENIED'}}
    exc = types.SimpleNamespace(content=json.dumps(body).encode())
    assert google_client._error_reason_code(exc) == 'PERMISSION_DENIED'


def test_error_reason_code_returns_none_for_malformed_or_empty_bodies():
    assert google_client._error_reason_code(types.SimpleNamespace(content=b'')) is None
    assert google_client._error_reason_code(types.SimpleNamespace(content=b'not json')) is None
    assert google_client._error_reason_code(types.SimpleNamespace()) is None


def _broker_credentials(monkeypatch, service, urlopen, *, token_extra=None):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')
    import googleapiclient.discovery
    import urllib.request

    monkeypatch.setattr(urllib.request, 'urlopen', urlopen)
    monkeypatch.setattr(googleapiclient.discovery, 'build', lambda *args, credentials, **kwargs: credentials)
    token = {
        'access_token': 'old-access',
        'refresh_token': 'refresh-token',
        'oauth_server_url': 'https://oauth.rocketride.ai/refresh',
    }
    token.update(token_extra or {})
    return google_client.build_service(
        service,
        'user',
        {'userToken': json.dumps(token)},
        ['https://www.googleapis.com/auth/spreadsheets'],
    )


def test_broker_refresh_wraps_malformed_response(monkeypatch, service):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')
    from google.auth.exceptions import RefreshError

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'not-json'

    creds = _broker_credentials(monkeypatch, service, lambda *_args, **_kwargs: _Response())
    with pytest.raises(RefreshError, match='malformed response'):
        creds.refresh(None)


def test_broker_refresh_http_rejection_reports_status(monkeypatch, service):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')
    import urllib.error
    from google.auth.exceptions import RefreshError

    def _raise(*_args, **_kwargs):
        raise urllib.error.HTTPError('https://oauth.rocketride.ai/refresh', 401, 'Unauthorized', None, None)

    creds = _broker_credentials(monkeypatch, service, _raise)
    with pytest.raises(RefreshError, match=r'rejected by the broker \(HTTP 401\)'):
        creds.refresh(None)


def test_broker_refresh_missing_access_token_raises_refresh_error(monkeypatch, service):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')
    from google.auth.exceptions import RefreshError

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"expiry_date": 1900000000000}'

    creds = _broker_credentials(monkeypatch, service, lambda *_args, **_kwargs: _Response())
    with pytest.raises(RefreshError, match='no access token'):
        creds.refresh(None)
    assert creds.token == 'old-access'


def test_broker_refresh_without_expiry_clears_stale_expiry(monkeypatch, service):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"access_token": "fresh-token"}'

    creds = _broker_credentials(
        monkeypatch,
        service,
        lambda *_args, **_kwargs: _Response(),
        token_extra={'expiry_date': 1000},
    )
    assert creds.expiry is not None
    creds.refresh(None)
    assert creds.token == 'fresh-token'
    assert creds.expiry is None


def test_broker_refresh_read_timeout_raises_refresh_error(monkeypatch, service):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')
    import socket
    from google.auth.exceptions import RefreshError

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            raise socket.timeout('read timed out')

    creds = _broker_credentials(monkeypatch, service, lambda *_args, **_kwargs: _Response())
    with pytest.raises(RefreshError, match='connection error'):
        creds.refresh(None)


def test_broker_refresh_invalid_expiry_raises_and_keeps_credentials_unchanged(service, monkeypatch):
    pytest.importorskip('googleapiclient.discovery')
    pytest.importorskip('google.oauth2.credentials')
    pytest.importorskip('google.auth.exceptions')
    from google.auth.exceptions import RefreshError

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b'{"access_token": "fresh", "expiry_date": "not-a-number"}'

    monkeypatch.setattr('urllib.request.urlopen', lambda *a, **k: _Response())
    monkeypatch.setattr('googleapiclient.discovery.build', lambda *a, **kw: kw['credentials'])
    creds = google_client.build_service(
        service,
        'user',
        {
            'userToken': json.dumps(
                {
                    'access_token': 'stale',
                    'refresh_token': 'refresh',
                    'oauth_server_url': 'https://oauth.rocketride.ai/token',
                }
            )
        },
        ['https://www.googleapis.com/auth/spreadsheets'],
    )
    with pytest.raises(RefreshError, match='invalid expiry_date'):
        creds.refresh(None)
    # the half-update is the bug: neither token nor expiry may have changed
    assert creds.token == 'stale'


def _scripted_request(method, outcomes):
    """Request double whose execute() pops scripted outcomes in order."""
    calls = {'count': 0, 'http_seen': []}

    def execute(http=None):
        calls['http_seen'].append(http)
        index = min(calls['count'], len(outcomes) - 1)
        calls['count'] += 1
        outcome = outcomes[index]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    request = types.SimpleNamespace(method=method, http=None, execute=execute)
    return request, calls


def test_execute_retries_transport_faults_for_get(monkeypatch, service):
    monkeypatch.setattr(google_client._time, 'sleep', lambda seconds: None)
    fault = OSError('[SSL] record layer failure (_ssl.c:2580)')
    request, calls = _scripted_request('GET', [fault, fault, {'ok': True}])

    assert google_client.execute(service, request) == {'ok': True}
    assert calls['count'] == 3


def test_execute_gives_up_on_get_after_four_transport_attempts(monkeypatch, service):
    monkeypatch.setattr(google_client._time, 'sleep', lambda seconds: None)
    fault = OSError('connection reset by peer')
    request, calls = _scripted_request('GET', [fault])

    with pytest.raises(ValueError, match='request failed'):
        google_client.execute(service, request)
    assert calls['count'] == 4


def test_execute_does_not_retry_transport_faults_for_mutations(monkeypatch, service):
    monkeypatch.setattr(google_client._time, 'sleep', lambda seconds: None)
    request, calls = _scripted_request('POST', [OSError('connection reset by peer')])

    with pytest.raises(ValueError, match='request failed'):
        google_client.execute(service, request)
    assert calls['count'] == 1


def test_execute_uses_a_distinct_transport_per_thread(monkeypatch, service):
    import threading

    class FakeAuthorizedHttp:
        def __init__(self, credentials, http=None):
            self.credentials = credentials
            self.http = http

    fake_google_auth = types.SimpleNamespace(AuthorizedHttp=FakeAuthorizedHttp)
    fake_httplib2 = types.SimpleNamespace(Http=lambda: object())
    monkeypatch.setitem(sys.modules, 'google_auth_httplib2', fake_google_auth)
    monkeypatch.setitem(sys.modules, 'httplib2', fake_httplib2)
    monkeypatch.setattr(google_client, '_thread_transport', threading.local())

    credentials = object()
    per_thread = {}

    def run(name):
        seen = []
        for _ in range(2):
            request = types.SimpleNamespace(
                method='GET',
                http=types.SimpleNamespace(credentials=credentials),
                execute=lambda http=None: seen.append(http) or {},
            )
            google_client.execute(service, request)
        per_thread[name] = seen

    threads = [threading.Thread(target=run, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    first, second = per_thread[0], per_thread[1]
    assert first[0] is first[1], 'a thread must reuse its own transport'
    assert second[0] is second[1], 'a thread must reuse its own transport'
    assert first[0] is not second[0], 'threads must not share a transport'
    assert isinstance(first[0], FakeAuthorizedHttp)
