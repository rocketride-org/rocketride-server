"""URL safety helpers shared across nodes (SSRF guards)."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def validate_public_url(raw_url: str) -> str:
    """Return ``raw_url`` if it points at a public host; raise ``ValueError`` otherwise.

    Rejects non-http(s) URLs and hosts that resolve to any non-global address
    (private, loopback, link-local, reserved, multicast, unspecified, or
    shared/CGNAT 100.64.0.0/10). Use this before following or returning URLs
    supplied by third-party APIs to prevent SSRF.
    """
    parsed = urlparse(raw_url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError(f'Invalid URL: {raw_url}')
    try:
        addrinfo = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise ValueError(f'Unresolved URL host: {parsed.hostname}') from e
    for _, _, _, _, sockaddr in addrinfo:
        ip = ipaddress.ip_address(sockaddr[0])
        # ``is_global`` is False for every reserved range (private, loopback,
        # link-local, reserved, multicast, unspecified) *and* shared/CGNAT
        # space (100.64.0.0/10), which the individual flags miss.
        if not ip.is_global:
            raise ValueError(f'Blocked non-public URL host: {parsed.hostname}')
    return raw_url
