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

"""Tests for the SSRF protection module."""

from __future__ import annotations

import importlib.util
import ipaddress
import os
import socket
import sys
from typing import List, Tuple
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Load ssrf_protection directly from the file to avoid pulling in the
# ``library`` package's __init__.py which depends on heavy runtime modules.
# ---------------------------------------------------------------------------

_MOD_PATH = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'library', 'ssrf_protection.py')

_spec = importlib.util.spec_from_file_location('ssrf_protection', _MOD_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
sys.modules['ssrf_protection'] = _mod

SSRFError = _mod.SSRFError
_build_allowlist = _mod._build_allowlist
_is_blocked = _mod._is_blocked
validate_url = _mod.validate_url


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_getaddrinfo(ip: str):
    """Return a patched getaddrinfo that always resolves to *ip*."""

    def _patched(host, port, **_kw):
        family = socket.AF_INET6 if ':' in ip else socket.AF_INET
        return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, port))]

    return _patched


def _fake_getaddrinfo_multi(ips: List[Tuple[str, int]]):
    """Return a patched getaddrinfo that resolves to multiple addresses."""

    def _patched(host, port, **_kw):
        results = []
        for ip, family in ips:
            results.append((family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, port)))
        return results

    return _patched


# ---------------------------------------------------------------------------
# Tests: blocked IP ranges
# ---------------------------------------------------------------------------


class TestBlockedIPv4:
    """Private / reserved IPv4 addresses must be blocked."""

    @pytest.mark.parametrize(
        'ip',
        [
            '127.0.0.1',  # loopback
            '127.0.0.2',  # loopback range
            '10.0.0.1',  # RFC 1918
            '10.255.255.255',  # RFC 1918 top
            '172.16.0.1',  # RFC 1918
            '172.31.255.255',  # RFC 1918 top
            '192.168.0.1',  # RFC 1918
            '192.168.255.255',  # RFC 1918 top
            '169.254.169.254',  # cloud metadata endpoint
            '169.254.0.1',  # link-local
            '0.0.0.0',  # this host
        ],
    )
    def test_blocked_ipv4(self, ip):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo(ip)):
            with pytest.raises(SSRFError, match='private/reserved range'):
                validate_url(f'http://example.com/{ip}')

    @pytest.mark.parametrize(
        'ip',
        [
            '127.0.0.1',
            '10.0.0.1',
            '172.16.0.1',
            '192.168.0.1',
            '169.254.169.254',
            '0.0.0.0',
        ],
    )
    def test_blocked_ip_literal(self, ip):
        """Direct IP literals in the URL are also blocked."""
        with pytest.raises(SSRFError, match='private/reserved range'):
            validate_url(f'http://{ip}/path')


class TestBlockedIPv6:
    """Private / reserved IPv6 addresses must be blocked."""

    @pytest.mark.parametrize(
        'ip',
        [
            '::1',  # loopback
            'fc00::1',  # unique local
            'fd12:3456::1',  # unique local
            'fe80::1',  # link-local
        ],
    )
    def test_blocked_ipv6(self, ip):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo(ip)):
            with pytest.raises(SSRFError, match='private/reserved range'):
                validate_url('http://example.com/')


# ---------------------------------------------------------------------------
# Tests: allowed public IPs
# ---------------------------------------------------------------------------


class TestAllowedPublic:
    """Public IP addresses must pass validation."""

    @pytest.mark.parametrize(
        'ip',
        [
            '8.8.8.8',  # Google DNS
            '1.1.1.1',  # Cloudflare DNS
            '93.184.216.34',  # example.com
            '151.101.1.140',  # a CDN address
        ],
    )
    def test_public_ip_allowed(self, ip):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo(ip)):
            url, hostname, resolved_ips = validate_url('http://example.com/')
            assert url == 'http://example.com/'
            assert hostname == 'example.com'
            assert ip in resolved_ips


# ---------------------------------------------------------------------------
# Tests: scheme validation
# ---------------------------------------------------------------------------


class TestSchemeValidation:
    """Only http and https schemes are allowed."""

    def test_http_allowed(self):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('8.8.8.8')):
            validate_url('http://example.com/')

    def test_https_allowed(self):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('8.8.8.8')):
            validate_url('https://example.com/')

    @pytest.mark.parametrize(
        'url',
        [
            'ftp://example.com/',
            'file:///etc/passwd',
            'gopher://example.com/',
            'dict://example.com/',
        ],
    )
    def test_disallowed_scheme(self, url):
        with pytest.raises(SSRFError, match='scheme.*is not allowed'):
            validate_url(url)


# ---------------------------------------------------------------------------
# Tests: hostname validation
# ---------------------------------------------------------------------------


class TestHostnameValidation:
    """Blocked hostnames must be rejected."""

    def test_localhost_blocked(self):
        with pytest.raises(SSRFError, match='hostname.*blocked'):
            validate_url('http://localhost/path')

    def test_metadata_google_blocked(self):
        with pytest.raises(SSRFError, match='hostname.*blocked'):
            validate_url('http://metadata.google.internal/computeMetadata/v1/')

    def test_empty_hostname(self):
        with pytest.raises(SSRFError, match='no hostname'):
            validate_url('http:///path')


# ---------------------------------------------------------------------------
# Tests: allowlist
# ---------------------------------------------------------------------------


class TestAllowlist:
    """The allowlist should permit specific private ranges."""

    def test_allowlist_permits_specific_ip(self):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('192.168.1.100')):
            url, hostname, resolved_ips = validate_url(
                'http://internal-api.local/',
                allowed_private=['192.168.1.0/24'],
            )
            assert url == 'http://internal-api.local/'
            assert '192.168.1.100' in resolved_ips

    def test_allowlist_does_not_permit_other_range(self):
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('10.0.0.1')):
            with pytest.raises(SSRFError, match='private/reserved range'):
                validate_url(
                    'http://internal-api.local/',
                    allowed_private=['192.168.1.0/24'],
                )

    def test_env_allowlist(self):
        with patch.dict(os.environ, {'ROCKETRIDE_SSRF_ALLOWLIST': '10.0.0.0/8'}):
            with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('10.0.0.5')):
                url, _hostname, _ips = validate_url('http://internal.corp/')
                assert url == 'http://internal.corp/'

    def test_env_allowlist_multiple(self):
        with patch.dict(os.environ, {'ROCKETRIDE_SSRF_ALLOWLIST': '10.0.0.0/8, 172.16.0.0/12'}):
            with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('172.16.5.1')):
                url, _hostname, _ips = validate_url('http://internal.corp/')
                assert url == 'http://internal.corp/'


# ---------------------------------------------------------------------------
# Tests: DNS rebinding prevention
# ---------------------------------------------------------------------------


class TestDNSRebinding:
    """DNS resolution must happen before connecting."""

    def test_hostname_resolving_to_private_ip_blocked(self):
        """A public-looking hostname that resolves to a private IP is blocked."""
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('169.254.169.254')):
            with pytest.raises(SSRFError, match='private/reserved range'):
                validate_url('http://attacker-dns-rebind.evil.com/')

    def test_unresolvable_hostname(self):
        """Hostnames that fail DNS resolution must raise SSRFError."""
        with patch(
            'ssrf_protection.socket.getaddrinfo',
            side_effect=socket.gaierror('Name or service not known'),
        ):
            with pytest.raises(SSRFError, match='cannot resolve hostname'):
                validate_url('http://nonexistent.invalid/')


# ---------------------------------------------------------------------------
# Tests: internal helpers
# ---------------------------------------------------------------------------


class TestInternalHelpers:
    """Coverage for internal helper functions."""

    def test_is_blocked_public(self):
        assert _is_blocked(ipaddress.ip_address('8.8.8.8')) is False

    def test_is_blocked_private(self):
        assert _is_blocked(ipaddress.ip_address('10.0.0.1')) is True

    def test_build_allowlist_empty(self):
        with patch.dict(os.environ, {}, clear=True):
            nets = _build_allowlist(None)
            assert nets == []

    def test_build_allowlist_malformed_ignored(self):
        nets = _build_allowlist(['not-a-cidr', '10.0.0.0/8'])
        assert len(nets) == 1
        assert str(nets[0]) == '10.0.0.0/8'

    def test_build_allowlist_malformed_logs_warning(self):
        """Malformed CIDR entries should produce a warning log."""
        with patch.dict(os.environ, {'ROCKETRIDE_SSRF_ALLOWLIST': 'bad-cidr, 10.0.0.0/8'}):
            with patch('ssrf_protection.logger') as mock_logger:
                nets = _build_allowlist(None)
                assert len(nets) == 1
                mock_logger.warning.assert_called_once()
                assert 'bad-cidr' in mock_logger.warning.call_args[0][1]

    def test_validate_url_returns_resolved_ips(self):
        """validate_url should return (url, hostname, resolved_ips) tuple."""
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('8.8.8.8')):
            url, hostname, resolved_ips = validate_url('http://example.com/path')
            assert url == 'http://example.com/path'
            assert hostname == 'example.com'
            assert resolved_ips == ['8.8.8.8']


# ---------------------------------------------------------------------------
# Tests: redirect-based SSRF bypass prevention
# ---------------------------------------------------------------------------


class TestRedirectSSRFBypass:
    """Redirect-based SSRF attacks must be blocked.

    An attacker can host a public URL that 302-redirects to a private IP
    (e.g. the cloud metadata endpoint 169.254.169.254).  The HTTP client
    must validate each redirect target before following it.
    """

    def test_redirect_to_private_ip_blocked(self):
        """A redirect from a public IP to a private IP must be rejected."""
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('169.254.169.254')):
            with pytest.raises(SSRFError, match='private/reserved range'):
                validate_url('http://169.254.169.254/latest/meta-data/')

    def test_redirect_to_metadata_ip_blocked(self):
        """Cloud metadata endpoint via redirect must be blocked."""
        with pytest.raises(SSRFError, match='private/reserved range'):
            validate_url('http://169.254.169.254/latest/meta-data/')

    def test_redirect_to_loopback_blocked(self):
        """Redirect to 127.0.0.1 must be blocked."""
        with pytest.raises(SSRFError, match='private/reserved range'):
            validate_url('http://127.0.0.1/admin')

    def test_redirect_to_public_ip_allowed(self):
        """Redirect to a public IP should succeed."""
        with patch('ssrf_protection.socket.getaddrinfo', _fake_getaddrinfo('93.184.216.34')):
            url, hostname, resolved_ips = validate_url('http://safe-redirect.example.com/')
            assert url == 'http://safe-redirect.example.com/'
            assert '93.184.216.34' in resolved_ips
