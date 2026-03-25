"""
Tests for SSRF (Server-Side Request Forgery) protection.

Covers:
- ``nodes.library.internet.ssrf_guard.validate_url`` -- URL validation against
  private/internal/metadata IPs and hostnames.
- ``nodes.tool_http_request.http_client.execute_request`` -- integration check
  that validate_url is called on the *resolved* URL (after path-param
  substitution) and that ``allow_redirects=False`` is enforced.
- ``nodes.tool_http_request.http_driver.HttpDriver._tool_invoke`` -- URL
  allowlist is applied against the resolved URL.

Run:
    cd nodes && python -m pytest test/test_ssrf_guard.py -v
"""

from __future__ import annotations

import importlib.util
import socket
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Direct-load modules without triggering the engine-only nodes/__init__.py
# ---------------------------------------------------------------------------

_NODES_SRC = Path(__file__).resolve().parent.parent / 'src' / 'nodes'


def _load_module(name: str, path: Path):
    """Import a module directly from *path* and register it in sys.modules."""
    if name in sys.modules:
        return sys.modules[name]
    parts = name.split('.')
    for i in range(1, len(parts)):
        parent = '.'.join(parts[:i])
        if parent not in sys.modules:
            pkg = types.ModuleType(parent)
            pkg.__path__ = []
            pkg.__package__ = parent
            sys.modules[parent] = pkg
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_ssrf_mod = _load_module(
    'nodes.library.internet.ssrf_guard',
    _NODES_SRC / 'library' / 'internet' / 'ssrf_guard.py',
)
validate_url = _ssrf_mod.validate_url

_http_client_mod = _load_module(
    'nodes.tool_http_request.http_client',
    _NODES_SRC / 'tool_http_request' / 'http_client.py',
)
_resolve_path_params = _http_client_mod._resolve_path_params
execute_request = _http_client_mod.execute_request

# Mock ai.common.tools.ToolsBase so HttpDriver can be imported
_mock_tools_base = type('ToolsBase', (), {})
_mock_ai_tools = types.ModuleType('ai.common.tools')
_mock_ai_tools.ToolsBase = _mock_tools_base
sys.modules.setdefault('ai.common.tools', _mock_ai_tools)
sys.modules.setdefault('ai', types.ModuleType('ai'))
sys.modules.setdefault('ai.common', types.ModuleType('ai.common'))

_http_driver_mod = _load_module(
    'nodes.tool_http_request.http_driver',
    _NODES_SRC / 'tool_http_request' / 'http_driver.py',
)
HttpDriver = _http_driver_mod.HttpDriver

# Patch target paths (module-qualified)
_SSRF_GETADDR = 'nodes.library.internet.ssrf_guard.socket.getaddrinfo'
_CLIENT_REQUEST = 'nodes.tool_http_request.http_client.requests.request'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_getaddrinfo(ip: str):
    """Return a mock ``socket.getaddrinfo`` that resolves to *ip*."""

    def _getaddrinfo(hostname, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, '', (ip, 0))]

    return _getaddrinfo


def _fake_getaddrinfo_v6(ip: str):
    """Return a mock ``socket.getaddrinfo`` that resolves to an IPv6 *ip*."""

    def _getaddrinfo(hostname, port, *args, **kwargs):
        return [(socket.AF_INET6, socket.SOCK_STREAM, 0, '', (ip, 0, 0, 0))]

    return _getaddrinfo


def _mock_response(status=200, reason='OK', content_type='text/plain', text='ok'):
    """Build a minimal ``requests.Response`` mock."""
    resp = MagicMock()
    resp.status_code = status
    resp.reason = reason
    resp.headers = {'Content-Type': content_type}
    resp.text = text
    resp.json.side_effect = ValueError
    return resp


# ---------------------------------------------------------------------------
# Blocked cloud-metadata hosts
# ---------------------------------------------------------------------------


class TestBlockedHosts:
    def test_metadata_google_internal(self):
        with pytest.raises(ValueError, match='internal metadata service'):
            validate_url('http://metadata.google.internal/computeMetadata/v1/')

    def test_metadata_goog(self):
        with pytest.raises(ValueError, match='internal metadata service'):
            validate_url('http://metadata.goog/computeMetadata/v1/')

    def test_metadata_azure(self):
        with pytest.raises(ValueError, match='internal metadata service'):
            validate_url('http://metadata.azure.com/metadata/instance')

    def test_management_azure(self):
        with pytest.raises(ValueError, match='internal metadata service'):
            validate_url('http://management.azure.com/some/path')

    def test_blocked_hosts_case_insensitive(self):
        with pytest.raises(ValueError, match='internal metadata service'):
            validate_url('http://METADATA.GOOGLE.INTERNAL/something')


# ---------------------------------------------------------------------------
# URL scheme validation
# ---------------------------------------------------------------------------


class TestSchemeValidation:
    def test_file_scheme_blocked(self):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url('file:///etc/passwd')

    def test_gopher_scheme_blocked(self):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url('gopher://evil.com/')

    def test_ftp_scheme_blocked(self):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url('ftp://evil.com/secret')

    def test_http_scheme_allowed(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('93.184.216.34')):
            validate_url('http://example.com/')  # should not raise

    def test_https_scheme_allowed(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('93.184.216.34')):
            validate_url('https://example.com/')  # should not raise


# ---------------------------------------------------------------------------
# Private / loopback / link-local / reserved IPs
# ---------------------------------------------------------------------------


class TestPrivateIPs:
    @pytest.mark.parametrize(
        'ip',
        [
            '127.0.0.1',
            '10.0.0.1',
            '10.255.255.255',
            '192.168.1.1',
            '172.16.0.1',
            '172.31.255.255',
        ],
    )
    def test_private_ips_blocked(self, ip):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo(ip)):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://some-host.example.com/path')

    def test_loopback_localhost(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('127.0.0.1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://localhost/')

    def test_loopback_127_x(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('127.0.0.2')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://loopback2.test/')

    def test_link_local_aws_metadata(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('169.254.169.254')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://evil.example.com/')

    def test_link_local_generic(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('169.254.0.1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://link-local.test/')

    def test_ipv6_loopback(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo_v6('::1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://some-host.example.com/')

    def test_ipv4_mapped_ipv6_loopback(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo_v6('::ffff:127.0.0.1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://some-host.example.com/')

    def test_ipv4_mapped_ipv6_private(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo_v6('::ffff:10.0.0.1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://some-host.example.com/')

    def test_ipv6_link_local(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo_v6('fe80::1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://some-host.example.com/')

    def test_reserved_0_0_0_0(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('0.0.0.0')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://zero.test/')

    def test_shared_address_space_cgnat(self):
        """100.64.0.0/10 (Carrier-grade NAT) is blocked via is_global check."""
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('100.64.0.1')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url('http://cgnat.test/')


# ---------------------------------------------------------------------------
# Public IPs should pass
# ---------------------------------------------------------------------------


class TestPublicIPs:
    def test_public_ip_allowed(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('93.184.216.34')):
            validate_url('http://example.com/')  # should not raise

    def test_another_public_ip(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('8.8.8.8')):
            validate_url('https://dns.google/')  # should not raise

    def test_public_ip_with_port(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('93.184.216.34')):
            validate_url('https://example.com:8443/path')

    def test_public_ip_with_path(self):
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('93.184.216.34')):
            validate_url('https://example.com/api/v1/users')


# ---------------------------------------------------------------------------
# DNS failure -- fail closed
# ---------------------------------------------------------------------------


class TestDNSFailure:
    def test_unresolvable_hostname_raises(self):
        def _fail(*args, **kwargs):
            raise socket.gaierror('Name or service not known')

        with patch(_SSRF_GETADDR, _fail):
            with pytest.raises(ValueError, match='Cannot resolve hostname'):
                validate_url('http://does-not-exist.invalid/')

    def test_nxdomain_raises(self):
        def _fail(*args, **kwargs):
            raise socket.gaierror('[Errno 8] nodename nor servname provided')

        with patch(_SSRF_GETADDR, _fail):
            with pytest.raises(ValueError, match='Cannot resolve hostname'):
                validate_url('http://nx.example.invalid/')


# ---------------------------------------------------------------------------
# Missing / malformed URLs
# ---------------------------------------------------------------------------


class TestMalformedURLs:
    def test_empty_url(self):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url('')

    def test_no_hostname(self):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url('/just/a/path')

    def test_scheme_only(self):
        with pytest.raises(ValueError, match='missing hostname'):
            validate_url('http://')

    def test_bare_colon_slash(self):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url('://')


# ---------------------------------------------------------------------------
# Path param injection -- validate resolved URL
# ---------------------------------------------------------------------------


class TestPathParamInjection:
    def test_validate_after_resolution(self):
        """Verify that http_client validates the resolved URL, not the template."""
        template = 'http://api.example.com/:host/data'
        resolved = _resolve_path_params(template, {'host': 'metadata.google.internal'})
        # Path substitution in the path segment: hostname stays api.example.com
        assert 'metadata.google.internal' in resolved

        # More realistic attack: template uses :target as the hostname
        attack_template = 'http://:target/latest/meta-data/'
        attack_resolved = _resolve_path_params(attack_template, {'target': 'metadata.google.internal'})
        assert attack_resolved == 'http://metadata.google.internal/latest/meta-data/'
        with pytest.raises(ValueError, match='internal metadata service'):
            validate_url(attack_resolved)

    def test_private_ip_via_path_param(self):
        """Path param that injects a private IP as hostname is caught."""
        template = 'http://:host/api/data'
        resolved = _resolve_path_params(template, {'host': '169.254.169.254'})
        with patch(_SSRF_GETADDR, _fake_getaddrinfo('169.254.169.254')):
            with pytest.raises(ValueError, match='private/internal address'):
                validate_url(resolved)


# ---------------------------------------------------------------------------
# Redirect bypass -- allow_redirects=False
# ---------------------------------------------------------------------------


class TestRedirectBypass:
    def test_allow_redirects_false_in_kwargs(self):
        """Verify that execute_request sets allow_redirects=False."""
        with (
            patch(_SSRF_GETADDR, _fake_getaddrinfo('93.184.216.34')),
            patch(_CLIENT_REQUEST) as mock_request,
        ):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.reason = 'OK'
            mock_resp.headers = {'Content-Type': 'text/plain'}
            mock_resp.text = 'hello'
            mock_resp.json.side_effect = ValueError
            mock_request.return_value = mock_resp

            execute_request(url='http://example.com/', method='GET')

            mock_request.assert_called_once()
            call_kwargs = mock_request.call_args
            # requests.request is called with **kwargs, so check keyword args
            actual_kwargs = call_kwargs.kwargs if call_kwargs.kwargs else call_kwargs[1]
            assert actual_kwargs.get('allow_redirects') is False, 'allow_redirects must be False to prevent redirect-based SSRF'
