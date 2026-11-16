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

"""Tests for ai.common.utils.pinned_http (resolve-once, connect-to-validated-address HTTP)."""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from unittest.mock import Mock

import requests
from urllib3.poolmanager import SSL_KEYWORDS

from ai.common.utils import HostResolutionError, pinned_session, resolve_public_addresses
from ai.common.utils import pinned_http
from ai.common.utils.pinned_http import has_safe_ipaddress_runtime, is_public_address, resolve_addresses


def _stub_resolve(monkeypatch, *ips: str) -> None:
    def fake(host, port, *a, **k):
        return [
            (socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, port))
            for ip in ips
        ]

    monkeypatch.setattr(socket, 'getaddrinfo', fake)


@pytest.mark.parametrize(
    'ip,public',
    [
        ('93.184.216.34', True),
        ('2606:2800:220:1:248:1893:25c8:1946', True),
        ('10.0.0.1', False),
        ('127.0.0.1', False),
        ('169.254.169.254', False),
        ('100.64.0.1', False),
        ('::1', False),
        ('fe80::1', False),
        ('::ffff:10.0.0.1', False),  # IPv4-mapped private
        ('64:ff9b::a00:1', False),  # NAT64 of 10.0.0.1
        ('2002:a00:1::', False),  # 6to4 of 10.0.0.1
    ],
)
def test_is_public_address(ip, public):
    assert is_public_address(ipaddress.ip_address(ip)) is public


def test_resolves_public_host_with_default_port(monkeypatch):
    _stub_resolve(monkeypatch, '93.184.216.34')
    (addr,) = resolve_public_addresses('https://example.com/page')
    assert addr[0] == socket.AF_INET
    assert addr[3] == ('93.184.216.34', 443)


def test_any_private_answer_blocks(monkeypatch):
    _stub_resolve(monkeypatch, '93.184.216.34', '10.0.0.5')
    with pytest.raises(ValueError, match='Blocked'):
        resolve_public_addresses('http://mixed.example/')


@pytest.mark.parametrize(
    'url,match',
    [
        ('ftp://example.com/f', 'scheme'),
        ('http:///nohost', 'hostname'),
        ('http://user:pw@example.com/', 'userinfo'),
        ('http://example.com:0/', 'port'),
    ],
)
def test_malformed_urls_rejected(url, match):
    with pytest.raises(ValueError, match=match):
        resolve_public_addresses(url)


def test_unresolvable_host(monkeypatch):
    def fail(*a, **k):
        raise socket.gaierror('nope')

    monkeypatch.setattr(socket, 'getaddrinfo', fail)
    with pytest.raises(HostResolutionError, match='Unresolved'):
        resolve_public_addresses('http://nowhere.invalid/')


def test_empty_dns_answer_is_a_resolution_error(monkeypatch):
    monkeypatch.setattr(socket, 'getaddrinfo', Mock(return_value=[]))
    with pytest.raises(HostResolutionError, match='Unresolved'):
        resolve_public_addresses('https://missing.example/data')


def test_invalid_resolver_address_is_a_resolution_error(monkeypatch):
    result = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('not-an-address', 443))
    monkeypatch.setattr(socket, 'getaddrinfo', Mock(return_value=[result]))
    with pytest.raises(HostResolutionError, match='invalid address'):
        resolve_public_addresses('https://service.example/data')


def test_blocked_address_is_not_a_resolution_error(monkeypatch):
    _stub_resolve(monkeypatch, '10.0.0.5')
    with pytest.raises(ValueError, match='non-public') as exc_info:
        resolve_public_addresses('https://service.example/data')
    assert not isinstance(exc_info.value, HostResolutionError)


@pytest.mark.parametrize(
    'version_info,expected',
    [
        ((3, 9, 99), False),
        ((3, 10, 14), False),
        ((3, 10, 15), True),
        ((3, 11, 9), False),
        ((3, 11, 10), True),
        ((3, 12, 3), False),
        ((3, 12, 4), True),
        ((3, 13, 0), True),
    ],
)
def test_ipaddress_runtime_security_patch_floor(version_info, expected):
    """Known-vulnerable Python patch levels fail closed before any request."""
    assert has_safe_ipaddress_runtime(version_info) is expected


def test_requests_exposes_the_adapter_hooks_pinning_relies_on():
    pinned_http._check_runtime()


_ADDRESS = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ('93.184.216.34', 443)),)


def test_pinned_connection_connects_to_the_validated_address(monkeypatch):
    """A later DNS answer cannot replace the address that was validated."""
    resolver = Mock(side_effect=AssertionError('the connection must not resolve the host again'))
    monkeypatch.setattr(socket, 'getaddrinfo', resolver)

    class FakeSocket:
        connected_to = None

        def setsockopt(self, *_args):
            pass

        def settimeout(self, _timeout):
            pass

        def bind(self, _source_address):
            pass

        def connect(self, sockaddr):
            self.connected_to = sockaddr

        def close(self):
            pass

    fake_socket = FakeSocket()
    monkeypatch.setattr(socket, 'socket', Mock(return_value=fake_socket))
    connection = pinned_http._PinnedHTTPSConnection('service.example', 443, timeout=1, validated_addresses=_ADDRESS)

    assert connection._new_conn() is fake_socket
    assert fake_socket.connected_to == ('93.184.216.34', 443)
    assert connection.host == 'service.example'
    resolver.assert_not_called()


def test_pinned_adapter_keeps_original_https_hostname():
    """The pinned pool keeps the URL's host for Host, SNI and certificate checks."""
    adapter = pinned_http.PinnedAddressAdapter(_ADDRESS)
    request = requests.Request('GET', 'https://service.example/data').prepare()

    pool = adapter.get_connection_with_tls_context(request, verify=True, proxies={})

    assert isinstance(pool, pinned_http._PinnedHTTPSConnectionPool)
    assert pool.host == 'service.example'
    assert pool.conn_kw['validated_addresses'] == _ADDRESS
    adapter.close()


def test_pinned_adapter_builds_plain_http_connection_without_tls_options():
    """TLS-only kwargs never reach urllib3's plain HTTP connection class."""
    addresses = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ('93.184.216.34', 80)),)
    adapter = pinned_http.PinnedAddressAdapter(addresses)
    request = requests.Request('GET', 'http://service.example/data').prepare()

    pool = adapter.get_connection_with_tls_context(request, verify=True, proxies={})
    connection = pool._new_conn()

    assert isinstance(pool, pinned_http._PinnedHTTPConnectionPool)
    assert isinstance(connection, pinned_http._PinnedHTTPConnection)
    assert not set(SSL_KEYWORDS).intersection(pool.conn_kw)
    adapter.close()


def test_pinned_adapter_rejects_explicit_proxy():
    """A proxy cannot take over destination resolution after validation."""
    adapter = pinned_http.PinnedAddressAdapter(_ADDRESS)
    request = requests.Request('GET', 'https://service.example/data').prepare()

    with pytest.raises(requests.exceptions.ProxyError, match='Proxies are not supported'):
        adapter.get_connection_with_tls_context(request, verify=True, proxies={'https': 'http://proxy.example:8080'})
    adapter.close()


@pytest.mark.parametrize(
    'environment,expected',
    [
        ({}, True),
        ({'REQUESTS_CA_BUNDLE': '/custom/requests-ca.pem'}, '/custom/requests-ca.pem'),
        ({'CURL_CA_BUNDLE': '/custom/curl-ca.pem'}, '/custom/curl-ca.pem'),
        (
            {'REQUESTS_CA_BUNDLE': '/custom/requests-ca.pem', 'CURL_CA_BUNDLE': '/custom/curl-ca.pem'},
            '/custom/requests-ca.pem',
        ),
    ],
)
def test_pinned_session_keeps_custom_ca_bundle_without_trusting_env(monkeypatch, environment, expected):
    """Custom CA files stay usable without re-enabling proxies or .netrc."""
    monkeypatch.delenv('REQUESTS_CA_BUNDLE', raising=False)
    monkeypatch.delenv('CURL_CA_BUNDLE', raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    with pinned_session(_ADDRESS) as session:
        assert session.trust_env is False
        assert session.verify == expected


class _Echo(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = self.headers.get('Host', '').encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def local_port():
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Echo)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()


def test_pinned_session_connects_to_validated_address_only(local_port):
    # The hostname is unresolvable: success proves no second DNS lookup happened.
    url = f'http://rebind.invalid:{local_port}/'
    addresses = resolve_addresses(f'http://127.0.0.1:{local_port}/', is_allowed=lambda address: address.is_loopback)
    with pinned_session(addresses) as session:
        resp = session.get(url, timeout=5)
    assert resp.status_code == 200
    assert resp.text == f'rebind.invalid:{local_port}'


def test_pinned_session_ignores_environment_proxies(local_port, monkeypatch):
    monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:9')
    addresses = resolve_addresses(f'http://127.0.0.1:{local_port}/', is_allowed=lambda address: address.is_loopback)
    with pinned_session(addresses) as session:
        assert session.get(f'http://127.0.0.1:{local_port}/', timeout=5).status_code == 200


class _SlowHeaders(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        try:
            self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Pad: ')
            for _ in range(100):
                self.wfile.write(b'a')
                self.wfile.flush()
                time.sleep(0.1)
        except OSError:
            pass
        self.close_connection = True


def test_abort_ends_a_request_blocked_on_slow_headers():
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _SlowHeaders)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        addresses = resolve_addresses(f'http://127.0.0.1:{port}/', is_allowed=lambda address: address.is_loopback)
        with pinned_session(addresses) as session:
            threading.Timer(0.5, session.abort).start()
            start = time.monotonic()
            with pytest.raises((requests.RequestException, OSError)):
                session.get(f'http://127.0.0.1:{port}/', timeout=5)
            assert time.monotonic() - start < 3
    finally:
        httpd.shutdown()


def test_a_socket_opened_after_abort_is_shut_down_at_once():
    adapter = pinned_http.PinnedAddressAdapter(_ADDRESS)
    adapter.abort()
    left, right = socket.socketpair()
    try:
        adapter._track_socket(left)
        right.settimeout(2)
        assert right.recv(1) == b''  # the peer sees the shutdown at once
    finally:
        left.close()
        right.close()


def test_pinned_session_requires_addresses():
    with pytest.raises(ValueError):
        pinned_session(())
