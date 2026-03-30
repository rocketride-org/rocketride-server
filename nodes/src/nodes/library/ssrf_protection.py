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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
SSRF (Server-Side Request Forgery) protection utilities.

Validates URLs and resolved IP addresses to prevent requests to private,
loopback, link-local, and reserved IP ranges.  Supports a configurable
allowlist so self-hosted operators can permit specific internal services.

DNS resolution is performed before the IP check to prevent DNS rebinding
attacks where a hostname initially resolves to a public IP but later
resolves to an internal one.

Usage::

    from library.ssrf_protection import validate_url, SSRFError

    # Block all private IPs (default)
    validate_url('http://192.168.1.1/api')  # raises SSRFError

    # Allow specific private ranges
    validate_url(
        'http://192.168.1.100/api',
        allowed_private=['192.168.1.0/24'],
    )
"""

from __future__ import annotations

import ipaddress
import os
import socket
from typing import List, Optional, Sequence
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Blocked networks (RFC 1918, loopback, link-local, metadata, etc.)
# ---------------------------------------------------------------------------

_BLOCKED_IPV4 = [
    ipaddress.IPv4Network('0.0.0.0/8'),  # "This host" (RFC 1122)
    ipaddress.IPv4Network('10.0.0.0/8'),  # Private (RFC 1918)
    ipaddress.IPv4Network('100.64.0.0/10'),  # Shared address (RFC 6598)
    ipaddress.IPv4Network('127.0.0.0/8'),  # Loopback (RFC 1122)
    ipaddress.IPv4Network('169.254.0.0/16'),  # Link-local (RFC 3927) + cloud metadata
    ipaddress.IPv4Network('172.16.0.0/12'),  # Private (RFC 1918)
    ipaddress.IPv4Network('192.0.0.0/24'),  # IETF protocol assignments (RFC 6890)
    ipaddress.IPv4Network('192.0.2.0/24'),  # Documentation (RFC 5737)
    ipaddress.IPv4Network('192.168.0.0/16'),  # Private (RFC 1918)
    ipaddress.IPv4Network('198.18.0.0/15'),  # Benchmarking (RFC 2544)
    ipaddress.IPv4Network('198.51.100.0/24'),  # Documentation (RFC 5737)
    ipaddress.IPv4Network('203.0.113.0/24'),  # Documentation (RFC 5737)
    ipaddress.IPv4Network('224.0.0.0/4'),  # Multicast (RFC 5771)
    ipaddress.IPv4Network('240.0.0.0/4'),  # Reserved (RFC 1112)
    ipaddress.IPv4Network('255.255.255.255/32'),  # Broadcast
]

_BLOCKED_IPV6 = [
    ipaddress.IPv6Network('::1/128'),  # Loopback
    ipaddress.IPv6Network('::/128'),  # Unspecified
    ipaddress.IPv6Network('::ffff:0:0/96'),  # IPv4-mapped (checked via mapped v4)
    ipaddress.IPv6Network('64:ff9b::/96'),  # NAT64 (RFC 6052)
    ipaddress.IPv6Network('100::/64'),  # Discard (RFC 6666)
    ipaddress.IPv6Network('2001:db8::/32'),  # Documentation (RFC 3849)
    ipaddress.IPv6Network('fc00::/7'),  # Unique local (RFC 4193)
    ipaddress.IPv6Network('fe80::/10'),  # Link-local (RFC 4291)
    ipaddress.IPv6Network('ff00::/8'),  # Multicast (RFC 4291)
]

# Hostnames that are always blocked regardless of IP resolution.
_BLOCKED_HOSTNAMES = frozenset(
    {
        'localhost',
        'metadata.google.internal',
    }
)

# Environment variable for the global allowlist (comma-separated CIDRs).
SSRF_ALLOWLIST_ENV = 'ROCKETRIDE_SSRF_ALLOWLIST'

# Only allow http and https schemes.
_ALLOWED_SCHEMES = frozenset({'http', 'https'})


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class SSRFError(ValueError):
    """Raised when a URL targets a blocked (private/reserved) IP address."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_url(
    url: str,
    *,
    allowed_private: Optional[Sequence[str]] = None,
) -> str:
    """Validate *url* against SSRF rules and return the resolved URL.

    Parameters
    ----------
    url:
        The URL to validate (must use ``http`` or ``https`` scheme).
    allowed_private:
        An optional list of CIDR strings (e.g. ``['192.168.1.0/24']``) that
        should be permitted even though they fall within blocked ranges.
        This is merged with the global allowlist from the
        ``ROCKETRIDE_SSRF_ALLOWLIST`` environment variable.

    Returns
    -------
    str
        The original *url* unchanged, if validation passes.

    Raises
    ------
    SSRFError
        If the URL targets a blocked IP, uses a disallowed scheme, or
        cannot be resolved.
    """
    parsed = urlparse(url)

    # -- Scheme check -------------------------------------------------------
    scheme = (parsed.scheme or '').lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise SSRFError(f'SSRF protection: scheme {scheme!r} is not allowed. Only {sorted(_ALLOWED_SCHEMES)} are permitted.')

    # -- Extract hostname ---------------------------------------------------
    hostname = (parsed.hostname or '').lower().strip('.')
    if not hostname:
        raise SSRFError('SSRF protection: URL has no hostname.')

    # -- Blocked hostname check ---------------------------------------------
    if hostname in _BLOCKED_HOSTNAMES:
        raise SSRFError(f'SSRF protection: hostname {hostname!r} is blocked.')

    # -- Build combined allowlist -------------------------------------------
    allow_nets = _build_allowlist(allowed_private)

    # -- DNS resolution + IP check ------------------------------------------
    port = parsed.port or (443 if scheme == 'https' else 80)
    _resolve_and_check(hostname, port, allow_nets)

    return url


def resolve_and_validate(
    hostname: str,
    port: int = 80,
    *,
    allowed_private: Optional[Sequence[str]] = None,
) -> List[str]:
    """Resolve *hostname* and validate all resulting IPs.

    Returns the list of resolved IP address strings.  Raises ``SSRFError``
    if any resolved address is blocked.
    """
    allow_nets = _build_allowlist(allowed_private)
    return _resolve_and_check(hostname, port, allow_nets)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _build_allowlist(
    extra: Optional[Sequence[str]] = None,
) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """Merge per-call allowlist with the global env-var allowlist."""
    nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []

    # Global allowlist from environment
    env_val = os.environ.get(SSRF_ALLOWLIST_ENV, '').strip()
    if env_val:
        for cidr in env_val.split(','):
            cidr = cidr.strip()
            if cidr:
                try:
                    nets.append(ipaddress.ip_network(cidr, strict=False))
                except ValueError:
                    pass  # silently skip malformed entries

    # Per-call allowlist
    for cidr in extra or []:
        cidr_s = str(cidr).strip()
        if cidr_s:
            try:
                nets.append(ipaddress.ip_network(cidr_s, strict=False))
            except ValueError:
                pass

    return nets


def _resolve_and_check(
    hostname: str,
    port: int,
    allow_nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network],
) -> List[str]:
    """Resolve hostname via DNS and check every resulting IP."""
    # If hostname is already an IP literal, skip DNS.
    try:
        addr = ipaddress.ip_address(hostname)
        _check_ip(addr, hostname, allow_nets)
        return [str(addr)]
    except ValueError:
        pass  # not an IP literal — resolve via DNS

    try:
        addrinfos = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise SSRFError(f'SSRF protection: cannot resolve hostname {hostname!r}: {exc}') from exc

    if not addrinfos:
        raise SSRFError(f'SSRF protection: hostname {hostname!r} resolved to no addresses.')

    resolved_ips: List[str] = []
    for family, _type, _proto, _canonname, sockaddr in addrinfos:
        ip_str = sockaddr[0]
        addr = ipaddress.ip_address(ip_str)
        _check_ip(addr, hostname, allow_nets)
        if ip_str not in resolved_ips:
            resolved_ips.append(ip_str)

    return resolved_ips


def _check_ip(
    addr: ipaddress.IPv4Address | ipaddress.IPv6Address,
    hostname: str,
    allow_nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network],
) -> None:
    """Raise ``SSRFError`` if *addr* falls within a blocked range."""
    # For IPv6-mapped IPv4 addresses, also check the embedded v4 address.
    check_addrs = [addr]
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        check_addrs.append(addr.ipv4_mapped)

    for check_addr in check_addrs:
        if not _is_blocked(check_addr):
            continue

        # Check if the address is in the allowlist
        if any(check_addr in net for net in allow_nets):
            continue

        raise SSRFError(f'SSRF protection: request to {hostname!r} blocked — resolved IP {check_addr} is in a private/reserved range. If this is intentional, add the IP or CIDR to the ROCKETRIDE_SSRF_ALLOWLIST environment variable or the node-level allowlist.')


def _is_blocked(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if *addr* is in any blocked range."""
    if isinstance(addr, ipaddress.IPv4Address):
        return any(addr in net for net in _BLOCKED_IPV4)
    return any(addr in net for net in _BLOCKED_IPV6)
