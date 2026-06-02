"""URL safety helpers shared across nodes (SSRF guards)."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def validate_public_url(raw_url: str) -> str:
    """Return ``raw_url`` if it points at a public host; raise ``ValueError`` otherwise.

    Rejects non-http(s) URLs and hosts that resolve to private, loopback,
    link-local, reserved, multicast, or unspecified addresses. Use this before
    following or returning URLs supplied by third-party APIs to prevent SSRF.
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
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError(f'Blocked non-public URL host: {parsed.hostname}')
    return raw_url
