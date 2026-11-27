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

import importlib.util
import ipaddress
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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


_TLS_HELPER = Path(__file__).with_name('tls_test_server.py')
_spec = importlib.util.spec_from_file_location('pinned_http_tls_test_server', _TLS_HELPER)
tls_test_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tls_test_server)


def _loopback(url):
    return resolve_addresses(url, is_allowed=lambda address: address.is_loopback)


def _get_until_aborted(session, url, abort_after=0.5):
    """GET ``url`` while ``session.abort()`` fires after ``abort_after`` s; returns the seconds it took.

    Whether the aborted request raises or returns a cut-off response depends
    on the platform (Linux reads EOF, Windows raises); what matters is that
    it ends.
    """
    threading.Timer(abort_after, session.abort).start()
    start = time.monotonic()
    try:
        response = session.get(url, timeout=60)
        response.content  # noqa: B018 - read the body, which a slow-body server holds open
    except (requests.RequestException, OSError):
        pass
    return time.monotonic() - start


@pytest.fixture(scope='module')
def http_trickle():
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), tls_test_server.TrickleHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{httpd.server_address[1]}'
    httpd.shutdown()


@pytest.fixture(scope='module')
def https_trickle(tmp_path_factory):
    cert, key = tls_test_server.make_cert(tmp_path_factory.mktemp('tls'))
    httpd, port = tls_test_server.serve_https(cert, key)
    yield f'https://127.0.0.1:{port}', cert
    httpd.shutdown()


@pytest.mark.parametrize('path', ['/slow-headers', '/slow-body'])
def test_abort_ends_a_slow_http_request(http_trickle, path):
    with pinned_session(_loopback(http_trickle + '/')) as session:
        assert _get_until_aborted(session, http_trickle + path) < 10


@pytest.mark.parametrize('path', ['/slow-headers', '/slow-body'])
def test_abort_ends_a_slow_https_request(https_trickle, path):
    """TLS wrapping detaches the raw socket; abort must reach the live SSLSocket."""
    base, cert = https_trickle
    with pinned_session(_loopback(base + '/')) as session:
        session.verify = cert
        assert _get_until_aborted(session, base + path) < 10


def test_abort_ends_a_slow_tls_handshake():
    """During the handshake neither socket object is reachable; abort must still end it."""
    listener, port = tls_test_server.serve_slow_handshake()
    try:
        with pinned_session(_loopback(f'https://127.0.0.1:{port}/')) as session:
            assert _get_until_aborted(session, f'https://127.0.0.1:{port}/') < 10
    finally:
        listener.close()


def test_a_session_aborted_before_it_connects_never_connects():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    listener.settimeout(0.5)
    port = listener.getsockname()[1]
    try:
        with pinned_session(_loopback(f'http://127.0.0.1:{port}/')) as session:
            session.abort()
            with pytest.raises(requests.ConnectionError, match='aborted before it connected'):
                session.get(f'http://127.0.0.1:{port}/', timeout=2)
        with pytest.raises(socket.timeout):
            listener.accept()  # no connection was attempted
    finally:
        listener.close()


def test_track_socket_reports_an_abort():
    adapter = pinned_http.PinnedAddressAdapter(_ADDRESS)
    connection = Mock(sock=None, pinned_live_sock=None, pinned_connecting=False)
    first, second = socket.socket(), socket.socket()
    try:
        assert adapter._track_socket(connection, first) is False
        adapter.abort()
        assert adapter._track_socket(connection, second) is True
    finally:
        first.close()
        second.close()


class _BigRedirect(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b'x' * (2 * 1024 * 1024)
        self.send_response(302)
        self.send_header('Location', '/elsewhere')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


def test_a_redirect_body_is_not_read_by_requests():
    """Session.send would read a 3xx body to prepare Response.next; a pinned session never does."""
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _BigRedirect)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    try:
        with pinned_session(_loopback(url)) as session:
            response = session.get(url, allow_redirects=False, stream=True, timeout=5)
            assert response.status_code == 302
            assert response._content_consumed is False
            assert response.next is None
            response.close()
    finally:
        httpd.shutdown()


def test_pinned_session_requires_addresses():
    with pytest.raises(ValueError):
        pinned_session(())
