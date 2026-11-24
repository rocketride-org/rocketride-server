# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for HTTP-tool SSRF protections.

The address rules and the pinned transport live in
``ai.common.utils.pinned_http`` (tested in packages/ai); these tests pin the
node's contract on top of them: URL checks, error types, and that every
request goes through the validated addresses.
"""

from __future__ import annotations

import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

import pytest

pytest.importorskip('requests')

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'))

import http_client  # noqa: E402


def _dns_result(address: str) -> tuple:
    """Build one getaddrinfo result for an IPv4 or IPv6 address."""
    if ':' in address:
        return (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (address, 443, 0, 0))
    return (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (address, 443))


def _mock_dns(monkeypatch: pytest.MonkeyPatch, *addresses: str) -> Mock:
    resolver = Mock(return_value=[_dns_result(address) for address in addresses])
    monkeypatch.setattr(socket, 'getaddrinfo', resolver)
    return resolver


@pytest.mark.parametrize(
    'address',
    [
        '127.0.0.1',
        '10.0.0.1',
        '172.16.0.1',
        '192.168.0.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '240.0.0.1',
        '::1',
        'fc00::1',
        'fe80::1',
        'fec0::1',
        '::',
        '::7f00:1',
        '::ffff:127.0.0.1',
        '2002:7f00:1::',
        '64:ff9b::7f00:1',
        '64:ff9b::a9fe:a9fe',
        '64:ff9b:1::7f00:1',
        '64:ff9b:1::808:808',
        'ff02::1',
    ],
)
def test_validate_public_url_rejects_non_public_addresses(monkeypatch, address):
    """Loopback, private, link-local, shared, unspecified, and multicast addresses are blocked."""
    _mock_dns(monkeypatch, address)

    with pytest.raises(ValueError, match='non-public'):
        http_client._validate_public_url('https://service.example/data')


def test_validate_public_url_rejects_mixed_public_and_private_dns(monkeypatch):
    """One unsafe DNS answer blocks the host even when another answer is public."""
    _mock_dns(monkeypatch, '93.184.216.34', '10.0.0.8')

    with pytest.raises(ValueError, match='non-public'):
        http_client._validate_public_url('https://service.example/data')


@pytest.mark.parametrize(
    'url,error',
    [
        ('http://2130706433/', 'non-public'),
        ('http://0x7f000001/', 'non-public'),
        ('http://public.example@127.0.0.1/', 'userinfo'),
        ('http://[::ffff:127.0.0.1]/', 'non-public'),
    ],
)
def test_validate_public_url_rejects_disguised_loopback_hosts(monkeypatch, url, error):
    """Numeric and user-info URL forms cannot hide a loopback destination."""
    _mock_dns(monkeypatch, '127.0.0.1')

    with pytest.raises(ValueError, match=error):
        http_client._validate_public_url(url)


@pytest.mark.parametrize(
    'address',
    [
        '93.184.216.34',
        '2606:2800:220:1:248:1893:25c8:1946',
        '64:ff9b::808:808',
    ],
)
def test_validate_public_url_allows_public_addresses(monkeypatch, address):
    """Ordinary public IPv4 and IPv6 destinations remain usable."""
    resolver = _mock_dns(monkeypatch, address)

    http_client._validate_public_url('https://service.example:8443/data')

    resolver.assert_called_once_with(
        'service.example',
        8443,
        family=socket.AF_UNSPEC,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )


@pytest.mark.parametrize(
    'url,error',
    [
        ('file:///etc/passwd', 'scheme'),
        ('ftp://service.example/data', 'scheme'),
        ('https:///missing-host', 'hostname'),
        ('https://service.example:invalid/data', 'port'),
        ('https://service.example:0/data', 'port'),
        ('https://service.example/public/../admin', 'dot segments'),
        ('https://service.example/public/%2e%2e/admin', 'dot segments'),
        ('https://service.example/public/%252e%252e/admin', 'dot segments'),
        ('https://service.example/public/%2e%2e%5cadmin', 'dot segments'),
        ('https://service.example/public/%25252525252541/admin', 'dot segments'),
    ],
)
def test_validate_public_url_rejects_malformed_or_unsupported_urls(url, error):
    """Only complete HTTP(S) URLs reach DNS or the network."""
    with pytest.raises(ValueError, match=error):
        http_client._validate_public_url(url)


def test_validate_public_url_rejects_dns_failure(monkeypatch):
    """An unresolved host fails closed instead of reaching requests for a second lookup."""
    resolver = Mock(side_effect=socket.gaierror('not found'))
    monkeypatch.setattr(socket, 'getaddrinfo', resolver)

    with pytest.raises(http_client.requests.ConnectionError, match='Unresolved'):
        http_client._validate_public_url('https://missing.example/data')


def test_validate_public_url_rejects_empty_dns_answer(monkeypatch):
    """A resolver response without usable addresses fails closed."""
    monkeypatch.setattr(socket, 'getaddrinfo', Mock(return_value=[]))

    with pytest.raises(http_client.requests.ConnectionError, match='Unresolved'):
        http_client._validate_public_url('https://missing.example/data')


def test_validate_public_url_rejects_invalid_resolver_address(monkeypatch):
    """Unexpected resolver output cannot bypass address classification."""
    result = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('not-an-address', 443))
    monkeypatch.setattr(socket, 'getaddrinfo', Mock(return_value=[result]))

    with pytest.raises(http_client.requests.ConnectionError, match='invalid address'):
        http_client._validate_public_url('https://service.example/data')


def test_execute_plain_http_request_through_pinned_transport(monkeypatch):
    """A real HTTP exchange uses the pinned address and keeps the URL hostname."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.server.received_host = self.headers['Host']
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'pinned transport works')

        def log_message(self, _format, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    addresses = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ('127.0.0.1', port)),)
    monkeypatch.setattr(http_client, '_validate_public_url', Mock(return_value=addresses))

    try:
        result = http_client.execute_request(
            url=f'http://service.example:{port}/data',
            method='GET',
            timeout=2,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result['status_code'] == 200
    assert result['body'] == 'pinned transport works'
    assert server.received_host == f'service.example:{port}'


def test_execute_request_blocks_private_destination_before_network(monkeypatch):
    """A direct request to an unsafe destination never reaches requests."""
    _mock_dns(monkeypatch, '169.254.169.254')
    request = Mock()
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    with pytest.raises(ValueError, match='non-public'):
        http_client.execute_request(url='http://169.254.169.254/latest/meta-data/', method='GET')

    request.assert_not_called()


@pytest.mark.parametrize(
    'url',
    [
        'https://username@service.example/data',
        'https://username:password@service.example/data',
        'https://@service.example/data',
    ],
)
def test_execute_request_rejects_userinfo_before_dns_or_transport(monkeypatch, url):
    """Credentials in a URL cannot alter the validated request destination."""
    resolver = _mock_dns(monkeypatch, '93.184.216.34')
    request = Mock(return_value=Mock(status_code=200, reason='OK', headers={'Content-Type': 'text/plain'}, text='ok'))
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    with pytest.raises(ValueError, match='userinfo'):
        http_client.execute_request(url=url, method='GET')

    resolver.assert_not_called()
    request.assert_not_called()


@pytest.mark.parametrize(
    'headers,auth',
    [
        ({'Host': 'internal.example'}, None),
        ({'hOsT': 'internal.example'}, None),
        (None, {'type': 'api_key', 'api_key': {'key': 'Host', 'value': 'internal.example'}}),
    ],
)
def test_execute_request_rejects_host_header_override(monkeypatch, headers, auth):
    """Callers cannot route an allowlisted URL to a different virtual host."""
    _mock_dns(monkeypatch, '93.184.216.34')
    request = Mock()
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    with pytest.raises(ValueError, match='Host header'):
        http_client.execute_request(
            url='https://service.example/data',
            method='GET',
            headers=headers,
            auth=auth,
        )

    request.assert_not_called()


@pytest.mark.parametrize('status_code', [301, 302, 303, 307, 308])
def test_execute_request_disables_automatic_redirects(monkeypatch, status_code):
    """A 3xx response is returned to the caller and cannot jump past URL validation."""
    _mock_dns(monkeypatch, '93.184.216.34')
    response = Mock(
        status_code=status_code,
        reason='Found',
        headers={'Location': 'http://127.0.0.1/admin', 'Content-Type': 'text/plain'},
        text='',
    )
    request = Mock(return_value=response)
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    result = http_client.execute_request(url='https://service.example/redirect', method='GET')

    assert result['status_code'] == status_code
    assert request.call_args.args[0]['allow_redirects'] is False


def test_execute_request_validates_path_resolved_url(monkeypatch):
    """URL safety validation runs after path parameters are inserted."""
    _mock_dns(monkeypatch, '93.184.216.34')
    response = Mock(status_code=200, reason='OK', headers={'Content-Type': 'text/plain'}, text='ok')
    request = Mock(return_value=response)
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    http_client.execute_request(
        url='https://service.example/users/:id',
        method='GET',
        path_params={'id': 'team/admin'},
    )

    assert request.call_args.args[0]['url'] == 'https://service.example/users/team%2Fadmin'
    assert request.call_args.args[0]['allow_redirects'] is False


def test_execute_request_rejects_encoded_path_param_traversal(monkeypatch):
    """Encoded separators cannot hide a dot segment until Requests prepares the URL."""
    request = Mock()
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    with pytest.raises(ValueError, match='dot segments'):
        http_client.execute_request(
            url='https://service.example/users/:id/profile',
            method='GET',
            path_params={'id': '../admin'},
        )

    request.assert_not_called()


@pytest.mark.parametrize('query_params', [None, {'page': '2'}])
def test_execute_request_rejects_port_zero_before_requests_drops_it(monkeypatch, query_params):
    """Requests drops an explicit ":0" while preparing; the URL as given is refused instead of reaching port 443."""
    resolver = _mock_dns(monkeypatch, '93.184.216.34')
    request = Mock()
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    with pytest.raises(ValueError, match='port'):
        http_client.execute_request(url='https://service.example:0/data', method='GET', query_params=query_params)

    resolver.assert_not_called()
    request.assert_not_called()


def test_execute_request_query_value_cannot_change_destination(monkeypatch):
    """An internal URL inside a query value is data, not the request destination."""
    resolver = _mock_dns(monkeypatch, '93.184.216.34')
    response = Mock(status_code=200, reason='OK', headers={'Content-Type': 'text/plain'}, text='ok')
    request = Mock(return_value=response)
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    http_client.execute_request(
        url='https://service.example/fetch',
        method='GET',
        query_params={'target': 'http://127.0.0.1/admin'},
    )

    assert resolver.call_args.args[0] == 'service.example'
    assert request.call_args.args[0]['url'] == 'https://service.example/fetch?target=http%3A%2F%2F127.0.0.1%2Fadmin'
    assert request.call_args.args[0]['params'] is None


@pytest.mark.parametrize(
    ('query_params', 'auth', 'expected_url'),
    [
        (
            {'extra': '2'},
            None,
            'https://service.example/path?fixed=1&extra=2',
        ),
        (
            None,
            {
                'type': 'api_key',
                'api_key': {'key': 'api_key', 'value': 'secret', 'add_to': 'query_param'},
            },
            'https://service.example/path?fixed=1&api_key=secret',
        ),
    ],
)
def test_execute_request_passes_final_query_url_to_transport(monkeypatch, query_params, auth, expected_url):
    """The transport receives the one canonical URL that guardrails check."""
    _mock_dns(monkeypatch, '93.184.216.34')
    response = Mock(status_code=200, reason='OK', headers={'Content-Type': 'text/plain'}, text='ok')
    request = Mock(return_value=response)
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    http_client.execute_request(
        url='https://service.example/path?fixed=1',
        method='GET',
        query_params=query_params,
        auth=auth,
    )

    assert request.call_args.args[0]['url'] == expected_url
    assert request.call_args.args[0]['params'] is None


def test_execute_request_redacts_query_api_key_from_transport_error(monkeypatch):
    """Transport failures cannot retain query API-key URL state."""
    _mock_dns(monkeypatch, '93.184.216.34')
    secret = 'supersecret'
    final_url = f'https://service.example/path?api_key={secret}'
    prepared_request = http_client.requests.Request('GET', final_url).prepare()
    response = http_client.requests.Response()
    response.request = prepared_request
    transport_error = http_client.requests.ConnectionError(
        f'Max retries exceeded with url: /path?api_key={secret}',
        request=prepared_request,
        response=response,
    )
    request = Mock(side_effect=transport_error)
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    with pytest.raises(http_client.requests.ConnectionError) as exc_info:
        http_client.execute_request(
            url='https://service.example/path',
            method='GET',
            auth={
                'type': 'api_key',
                'api_key': {'key': 'api_key', 'value': secret, 'add_to': 'query_param'},
            },
        )

    error = exc_info.value
    assert secret not in str(error)
    assert getattr(error, 'request', None) is None
    assert getattr(error, 'response', None) is None
    assert error.__cause__ is None
    assert error.__context__ is None


def test_execute_request_preserves_existing_request_options(monkeypatch):
    """The SSRF guard changes redirect behavior without dropping normal request options."""
    _mock_dns(monkeypatch, '93.184.216.34')
    response = Mock(status_code=200, reason='OK', headers={'Content-Type': 'text/plain'}, text='ok')
    request = Mock(return_value=response)
    monkeypatch.setattr(http_client, '_request_with_validated_addresses', request)

    http_client.execute_request(
        url='https://service.example/data',
        method='POST',
        headers={'X-Test': 'value'},
        auth={'type': 'bearer', 'bearer': {'token': 'secret'}},
        body={'type': 'raw', 'raw': {'content': '{}', 'content_type': 'application/json'}},
        timeout=12,
    )

    kwargs = request.call_args.args[0]
    assert kwargs['method'] == 'POST'
    assert kwargs['headers'] == {
        'X-Test': 'value',
        'Authorization': 'Bearer secret',
        'Content-Type': 'application/json',
    }
    assert kwargs['data'] == '{}'
    assert kwargs['timeout'] == 12
    assert kwargs['allow_redirects'] is False
