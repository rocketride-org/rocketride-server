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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from ai.common.utils import pinned_session, resolve_public_addresses
from ai.common.utils.pinned_http import is_public_address, resolve_addresses


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
    with pytest.raises(ValueError, match='Unresolved'):
        resolve_public_addresses('http://nowhere.invalid/')


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


def test_pinned_session_requires_addresses():
    with pytest.raises(ValueError):
        pinned_session(())
