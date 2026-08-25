# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
HTTP request execution engine.

Accepts a fully-specified request descriptor (URL, method, headers, auth, body,
params) and returns a structured response dict.  Uses the ``requests`` library.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
import sys
import time
from typing import Any, Dict, Optional
from urllib.parse import quote, unquote, urlsplit

import requests
from requests.auth import HTTPBasicAuth
from requests.adapters import HTTPAdapter
from requests.exceptions import ProxyError
from requests.utils import select_proxy
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
from urllib3.poolmanager import SSL_KEYWORDS

DEFAULT_TIMEOUT_SECONDS = 30
MAX_TIMEOUT_SECONDS = 300

ResolvedAddress = tuple[int, int, int, tuple]

_NAT64_WELL_KNOWN_NETWORK = ipaddress.IPv6Network('64:ff9b::/96')
_NAT64_LOCAL_USE_NETWORK = ipaddress.IPv6Network('64:ff9b:1::/48')
_MINIMUM_SAFE_IPADDRESS_PATCH = {
    (3, 10): 14,
    (3, 11): 9,
    (3, 12): 4,
}

if not all(
    hasattr(HTTPAdapter, method)
    for method in ('get_connection_with_tls_context', 'build_connection_pool_key_attributes')
):
    raise RuntimeError('tool_http_request requires requests>=2.32.3 for safe DNS address pinning')

if not (
    HTTPConnectionPool.ConnectionCls is HTTPConnection
    and HTTPSConnectionPool.ConnectionCls is HTTPSConnection
    and hasattr(HTTPConnection, '_new_conn')
    and hasattr(HTTPSConnection, '_new_conn')
):
    raise RuntimeError('tool_http_request requires the supported urllib3 pinned-connection hooks')


def _has_safe_ipaddress_runtime(version_info) -> bool:
    """Return whether CPython contains the patched special-address tables."""
    major, minor, patch = version_info[:3]
    if major != 3 or minor < 10:
        return False
    minimum_patch = _MINIMUM_SAFE_IPADDRESS_PATCH.get((major, minor))
    return minimum_patch is None or patch >= minimum_patch


if not _has_safe_ipaddress_runtime(sys.version_info):
    raise RuntimeError(
        'tool_http_request requires a Python security patch level with corrected IP address classification: '
        'Python >=3.10.14, >=3.11.9, >=3.12.4, or >=3.13'
    )


class _PinnedConnectionMixin:
    """Open a socket only to addresses that passed SSRF validation."""

    validated_addresses: tuple[ResolvedAddress, ...]

    def __init__(self, *args, validated_addresses: tuple[ResolvedAddress, ...], **kwargs):
        self.validated_addresses = validated_addresses
        super().__init__(*args, **kwargs)

    def _new_conn(self):
        last_error = None
        last_error_was_timeout = False
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
                last_error_was_timeout = isinstance(error, socket.timeout)
                if sock is not None:
                    sock.close()

        if last_error_was_timeout:
            raise ConnectTimeoutError(
                self,
                f'Connection to {self.host} timed out. (connect timeout={self.timeout})',
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


class _PinnedAddressAdapter(HTTPAdapter):
    """Use the original hostname for HTTP/TLS while connecting to validated IPs."""

    def __init__(self, validated_addresses: tuple[ResolvedAddress, ...]):
        self.validated_addresses = validated_addresses
        self._pinned_pools = []
        super().__init__()

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        if select_proxy(request.url, proxies):
            raise ProxyError('Proxies are not supported by the public-network HTTP tool')

        host_params, pool_kwargs = self.build_connection_pool_key_attributes(request, verify, cert)
        scheme = host_params.pop('scheme')
        if scheme != 'https':
            # Requests includes TLS-only pool options even for HTTP. urllib3's
            # PoolManager normally strips them, but this adapter constructs the
            # pinned pool directly and must mirror that behavior.
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


def execute_request(
    *,
    url: str,
    method: str,
    query_params: Optional[Dict[str, str]] = None,
    path_params: Optional[Dict[str, str]] = None,
    headers: Optional[Dict[str, str]] = None,
    auth: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Execute an HTTP request and return a structured response.

    Raises ``requests.RequestException`` on transport-level failures.
    """
    start = time.monotonic()
    resolved_url = _canonicalize_url(_resolve_path_params(url, path_params))
    validated_addresses = _validate_public_url(resolved_url)

    req_headers = dict(headers or {})
    req_auth = None
    extra_params: Dict[str, str] = {}

    _apply_auth(auth, req_headers, extra_params, req_auth_out := [None])
    req_auth = req_auth_out[0]

    if any(name.lower() == 'host' for name in req_headers):
        raise ValueError('The Host header is derived from the validated URL and cannot be overridden')

    merged_params = dict(query_params or {})
    merged_params.update(extra_params)

    req_kwargs: Dict[str, Any] = {
        'method': method.upper(),
        'url': resolved_url,
        'headers': req_headers,
        'params': merged_params or None,
        'auth': req_auth,
        # Redirect targets have not passed the URL whitelist or network-address
        # checks. Return 3xx responses to the caller instead of following them.
        'allow_redirects': False,
    }

    _apply_body(body, req_headers, req_kwargs)

    if timeout is not None and timeout > 0:
        req_kwargs['timeout'] = min(timeout, MAX_TIMEOUT_SECONDS)
    else:
        req_kwargs['timeout'] = DEFAULT_TIMEOUT_SECONDS

    resp = _request_with_validated_addresses(req_kwargs, validated_addresses)
    elapsed_ms = round((time.monotonic() - start) * 1000)

    return _build_response(resp, elapsed_ms)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _request_with_validated_addresses(req_kwargs: Dict[str, Any], addresses: tuple[ResolvedAddress, ...]):
    """Execute one request using only the DNS addresses already validated."""
    scheme = urlsplit(req_kwargs['url']).scheme.lower()
    with requests.Session() as session:
        session.trust_env = False
        # Preserve the established Requests custom-CA behavior without
        # re-enabling environment proxies or implicit .netrc credentials.
        session.verify = os.environ.get('REQUESTS_CA_BUNDLE') or os.environ.get('CURL_CA_BUNDLE') or True
        session.mount(f'{scheme}://', _PinnedAddressAdapter(addresses))
        return session.request(**req_kwargs)


def _validate_public_url(url: str) -> tuple[ResolvedAddress, ...]:
    """Reject malformed URLs and destinations outside the public Internet."""
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {'http', 'https'}:
        raise ValueError('URL scheme must be http or https')
    if not parsed.hostname:
        raise ValueError('URL must include a hostname')

    if _url_has_dot_segments(url):
        raise ValueError('URL path must not contain dot segments')

    try:
        parsed_port = parsed.port
    except ValueError:
        raise ValueError('URL port is invalid') from None
    port = parsed_port if parsed_port is not None else (443 if parsed.scheme.lower() == 'https' else 80)
    if port == 0:
        raise ValueError('URL port is invalid')

    try:
        resolved = socket.getaddrinfo(
            parsed.hostname,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except socket.gaierror:
        raise requests.ConnectionError(f'URL hostname {parsed.hostname!r} could not be resolved') from None

    if not resolved:
        raise requests.ConnectionError(f'URL hostname {parsed.hostname!r} could not be resolved')

    validated = []
    for family, socktype, proto, _canonname, sockaddr in resolved:
        raw_address = sockaddr[0].split('%', 1)[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError:
            raise requests.ConnectionError(
                f'URL hostname {parsed.hostname!r} resolved to an invalid network address'
            ) from None
        if not _is_public_address(address):
            raise ValueError(f'URL hostname {parsed.hostname!r} resolves to a non-public network address')
        validated.append((family, socktype, proto, sockaddr))
    return tuple(validated)


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return whether an address is safe for an Internet-only HTTP client."""
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv4Address):
        return True
    if address.is_site_local or address in ipaddress.IPv6Network('::/96') or address in _NAT64_LOCAL_USE_NETWORK:
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


def _url_has_dot_segments(url: str) -> bool:
    """Detect traversal segments; fail closed on excessive encoding layers."""
    path = urlsplit(url).path
    for _decode_attempt in range(5):
        normalized_separators = path.replace('\\', '/')
        if any(segment in {'.', '..'} for segment in normalized_separators.split('/')):
            return True
        decoded = unquote(path)
        if decoded == path:
            return False
        path = decoded
    return True


def _canonicalize_url(url: str) -> str:
    """Return the stable URL form Requests will put on the wire."""
    # Fragments are client-side only and HTTPAdapter removes them from the
    # request target, so they must not influence whitelist matching.
    prepared_url = urlsplit(url)._replace(fragment='').geturl()
    for _attempt in range(3):
        if _url_has_dot_segments(prepared_url):
            raise ValueError('URL path must not contain dot segments')
        normalized_url = requests.Request('GET', prepared_url).prepare().url
        if normalized_url == prepared_url:
            return normalized_url
        prepared_url = normalized_url
    raise ValueError('URL normalization did not stabilize')


def _resolve_path_params(url: str, path_params: Optional[Dict[str, str]]) -> str:
    """Replace ``:name`` placeholders in the URL path with literal segments."""
    if not path_params:
        return url
    parsed = urlsplit(url)
    resolved_path = parsed.path
    for key, value in path_params.items():
        if str(value) in {'.', '..'}:
            raise ValueError('Path parameter values cannot be dot segments')
        # Encode (safe='') so the value stays one path segment and cannot slip
        # past the final URL allowlist. The function replacement keeps it
        # literal (no re.sub backslash/group-ref interpretation, e.g. '\1' ->
        # re.error). Only the parsed path is eligible for substitution, so a
        # parameter cannot replace the URL's scheme, hostname, port, or query.
        replacement = quote(str(value), safe='')
        resolved_path = re.sub(rf':{re.escape(key)}\b', lambda _m, r=replacement: r, resolved_path)
    return parsed._replace(path=resolved_path).geturl()


def _apply_auth(
    auth: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    extra_params: Dict[str, str],
    req_auth_out: list,
) -> None:
    """Mutate *headers* / *extra_params* / *req_auth_out* based on auth config."""
    if not auth:
        return
    auth_type = (auth.get('type') or 'none').strip().lower()
    if auth_type == 'none':
        return

    if auth_type == 'basic':
        basic = auth.get('basic') or {}
        req_auth_out[0] = HTTPBasicAuth(
            basic.get('username', ''),
            basic.get('password', ''),
        )

    elif auth_type == 'bearer':
        bearer = auth.get('bearer') or {}
        token = bearer.get('token', '')
        headers['Authorization'] = f'Bearer {token}'

    elif auth_type == 'api_key':
        api_key = auth.get('api_key') or {}
        key = api_key.get('key', '')
        value = api_key.get('value', '')
        add_to = (api_key.get('add_to') or 'header').strip().lower()
        if add_to == 'query_param':
            extra_params[key] = value
        else:
            headers[key] = value


def _apply_body(
    body: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    req_kwargs: Dict[str, Any],
) -> None:
    """Populate *req_kwargs* with the appropriate body payload."""
    if not body:
        return
    body_type = (body.get('type') or 'none').strip().lower()
    if body_type == 'none':
        return

    if body_type == 'raw':
        raw = body.get('raw') or {}
        content = raw.get('content', '')
        content_type = raw.get('content_type', 'application/json')
        headers.setdefault('Content-Type', content_type)
        req_kwargs['data'] = content

    elif body_type == 'form_data':
        form_data = body.get('form_data') or {}
        # multipart/form-data: pass each field as a tuple so ``requests``
        # builds the multipart envelope automatically.
        req_kwargs['files'] = {k: (None, v) for k, v in form_data.items()}

    elif body_type == 'x_www_form_urlencoded':
        urlencoded = body.get('urlencoded') or {}
        req_kwargs['data'] = urlencoded


def _build_response(resp: requests.Response, elapsed_ms: int) -> Dict[str, Any]:
    """Convert a ``requests.Response`` into a structured dict for the agent."""
    content_type = resp.headers.get('Content-Type', '')

    parsed_json = None
    if 'json' in content_type or 'javascript' in content_type:
        try:
            parsed_json = resp.json()
        except Exception:
            pass

    return {
        'status_code': resp.status_code,
        'status_text': resp.reason or '',
        'headers': dict(resp.headers),
        'body': resp.text,
        'json': parsed_json,
        'elapsed_ms': elapsed_ms,
        'content_type': content_type,
    }
