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

"""DNS-pinned HTTP for public-Internet-only clients (SSRF guard without a rebinding gap).

``validate_public_url`` resolves a host and checks the addresses, but a client
that then hands the URL to ``requests`` resolves it *again* at connect time;
a hostile DNS server can answer the second lookup with a private address.
This module closes that gap:

* :func:`resolve_public_addresses` resolves once and returns the validated
  ``(family, socktype, proto, sockaddr)`` tuples (or raises ``ValueError``);
* :func:`pinned_session` returns a ``requests.Session`` whose connections go
  only to those addresses, while Host / SNI / certificate checks still use
  the URL's hostname. Proxies and environment settings are disabled.

Resolve and open a new pinned session for every hop (including each
redirect target). The pinning approach mirrors ``tool_http_request``.

No engine imports: safe to load standalone in node unit tests.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
from typing import Callable, Optional, Tuple
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from requests.exceptions import ProxyError
from requests.utils import select_proxy
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
from urllib3.poolmanager import SSL_KEYWORDS

ResolvedAddress = Tuple[int, int, int, tuple]

_NAT64_WELL_KNOWN_NETWORK = ipaddress.IPv6Network('64:ff9b::/96')
_NAT64_LOCAL_USE_NETWORK = ipaddress.IPv6Network('64:ff9b:1::/48')
_IPV4_COMPATIBLE_NETWORK = ipaddress.IPv6Network('::/96')
_MINIMUM_SAFE_IPADDRESS_PATCH = {
    (3, 10): 15,
    (3, 11): 10,
    (3, 12): 4,
}


def _check_runtime() -> None:
    """Fail closed when the installed stack lacks the hooks or fixes pinning relies on."""
    if not all(
        hasattr(HTTPAdapter, method)
        for method in ('get_connection_with_tls_context', 'build_connection_pool_key_attributes')
    ):
        raise RuntimeError('DNS-pinned HTTP requires requests>=2.32.3')
    if not (
        HTTPConnectionPool.ConnectionCls is HTTPConnection
        and HTTPSConnectionPool.ConnectionCls is HTTPSConnection
        and hasattr(HTTPConnection, '_new_conn')
        and hasattr(HTTPSConnection, '_new_conn')
    ):
        raise RuntimeError('DNS-pinned HTTP requires the supported urllib3 connection hooks')
    major, minor, patch = sys.version_info[:3]
    minimum_patch = _MINIMUM_SAFE_IPADDRESS_PATCH.get((major, minor))
    if major != 3 or minor < 10 or (minimum_patch is not None and patch < minimum_patch):
        raise RuntimeError(
            'DNS-pinned HTTP requires a Python security patch level with corrected IP address classification: '
            'Python >=3.10.15, >=3.11.10, >=3.12.4, or >=3.13'
        )


def is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return whether an address is safe for an Internet-only HTTP client.

    Besides ``is_global``, IPv6 forms that embed an IPv4 address (mapped,
    6to4, Teredo, NAT64) must embed a public one.
    """
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv4Address):
        return True
    if address.is_site_local or address in _IPV4_COMPATIBLE_NETWORK or address in _NAT64_LOCAL_USE_NETWORK:
        return False

    embedded = []
    if address.ipv4_mapped is not None:
        embedded.append(address.ipv4_mapped)
    if address.sixtofour is not None:
        embedded.append(address.sixtofour)
    if address.teredo is not None:
        embedded.extend(address.teredo)
    if address in _NAT64_WELL_KNOWN_NETWORK:
        embedded.append(ipaddress.IPv4Address(address.packed[-4:]))
    return all(item.is_global and not item.is_multicast for item in embedded)


def resolve_addresses(
    url: str,
    *,
    is_allowed: Callable[[ipaddress.IPv4Address | ipaddress.IPv6Address], bool] = is_public_address,
) -> Tuple[ResolvedAddress, ...]:
    """Resolve ``url``'s host once; every address must pass ``is_allowed``.

    Raises ``ValueError`` for a malformed URL, userinfo in the URL, an
    unresolvable host, or any disallowed address.
    """
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in ('http', 'https'):
        raise ValueError(f'URL scheme must be http or https: {url!r}')
    if not parsed.hostname:
        raise ValueError(f'URL must include a hostname: {url!r}')
    if parsed.username is not None:
        raise ValueError('URL must not include userinfo')
    try:
        port = parsed.port
    except ValueError:
        raise ValueError(f'URL port is invalid: {url!r}') from None
    if port == 0:
        raise ValueError(f'URL port is invalid: {url!r}')
    port = port or (443 if scheme == 'https' else 80)

    try:
        resolved = socket.getaddrinfo(
            parsed.hostname, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
        )
    except socket.gaierror as e:
        raise ValueError(f'Unresolved URL host: {parsed.hostname}') from e
    if not resolved:
        raise ValueError(f'Unresolved URL host: {parsed.hostname}')

    validated = []
    for family, socktype, proto, _canonname, sockaddr in resolved:
        try:
            address = ipaddress.ip_address(sockaddr[0].split('%', 1)[0])
        except ValueError:
            raise ValueError(f'URL host {parsed.hostname!r} resolved to an invalid address') from None
        if not is_allowed(address):
            raise ValueError(f'Blocked non-public URL host: {parsed.hostname}')
        validated.append((family, socktype, proto, sockaddr))
    return tuple(validated)


def resolve_public_addresses(url: str) -> Tuple[ResolvedAddress, ...]:
    """Resolve ``url``'s host once, rejecting any non-public address (see :func:`resolve_addresses`)."""
    return resolve_addresses(url)


class _PinnedConnectionMixin:
    """Open a socket only to addresses that passed validation."""

    validated_addresses: Tuple[ResolvedAddress, ...]

    def __init__(self, *args, validated_addresses: Tuple[ResolvedAddress, ...], **kwargs):
        self.validated_addresses = validated_addresses
        super().__init__(*args, **kwargs)

    def _new_conn(self):
        last_error: Optional[OSError] = None
        for family, socktype, proto, sockaddr in self.validated_addresses:
            sock = None
            try:
                sock = socket.socket(family, socktype, proto)
                for option in self.socket_options or ():
                    sock.setsockopt(*option)
                if self.timeout is not None:
                    sock.settimeout(self.timeout)
                if self.source_address:
                    sock.bind(self.source_address)
                sock.connect(sockaddr)
                sys.audit('http.client.connect', self, self.host, self.port)
                return sock
            except OSError as error:
                last_error = error
                if sock is not None:
                    sock.close()

        if isinstance(last_error, socket.timeout):
            raise ConnectTimeoutError(
                self, f'Connection to {self.host} timed out. (connect timeout={self.timeout})'
            ) from last_error
        raise NewConnectionError(self, f'Failed to connect to a validated address: {last_error}') from last_error


class _PinnedHTTPConnection(_PinnedConnectionMixin, HTTPConnection):
    pass


class _PinnedHTTPSConnection(_PinnedConnectionMixin, HTTPSConnection):
    pass


class _PinnedHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _PinnedHTTPConnection


class _PinnedHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _PinnedHTTPSConnection


class PinnedAddressAdapter(HTTPAdapter):
    """Use the URL's hostname for HTTP/TLS while connecting only to validated addresses."""

    def __init__(self, validated_addresses: Tuple[ResolvedAddress, ...]):
        self.validated_addresses = validated_addresses
        self._pinned_pools = []
        super().__init__()

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        if select_proxy(request.url, proxies):
            raise ProxyError('Proxies are not supported by DNS-pinned HTTP')

        host_params, pool_kwargs = self.build_connection_pool_key_attributes(request, verify, cert)
        scheme = host_params.pop('scheme')
        if scheme != 'https':
            # Requests passes TLS-only pool options even for HTTP; urllib3's
            # PoolManager strips them, and this adapter builds pools directly.
            for keyword in SSL_KEYWORDS:
                pool_kwargs.pop(keyword, None)
        pool_class = _PinnedHTTPSConnectionPool if scheme == 'https' else _PinnedHTTPConnectionPool
        pool = pool_class(
            **host_params,
            **pool_kwargs,
            maxsize=1,
            block=True,
            validated_addresses=self.validated_addresses,
        )
        self._pinned_pools.append(pool)
        return pool

    def close(self):
        for pool in self._pinned_pools:
            pool.close()
        self._pinned_pools.clear()
        super().close()


def pinned_session(addresses: Tuple[ResolvedAddress, ...]) -> requests.Session:
    """A session that connects only to ``addresses`` (from :func:`resolve_public_addresses`).

    Environment proxies and ``.netrc`` credentials are ignored; a custom CA
    bundle from ``REQUESTS_CA_BUNDLE`` / ``CURL_CA_BUNDLE`` is honored. Use one
    session per validated URL and close it after the response is read.
    """
    _check_runtime()
    if not addresses:
        raise ValueError('pinned_session needs at least one validated address')
    session = requests.Session()
    session.trust_env = False
    session.verify = os.environ.get('REQUESTS_CA_BUNDLE') or os.environ.get('CURL_CA_BUNDLE') or True
    adapter = PinnedAddressAdapter(addresses)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    return session
