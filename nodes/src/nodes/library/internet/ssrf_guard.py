"""
SSRF protection utilities.

Validates that outgoing HTTP request URLs do not target private, internal,
or cloud-metadata networks.  Import ``validate_url`` from here in any module
that dispatches HTTP requests on behalf of users.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

# Known cloud metadata endpoints
BLOCKED_HOSTS = frozenset(
    {
        'metadata.google.internal',
        'metadata.goog',
    }
)


def validate_url(url: str) -> None:
    """Validate URL is not targeting internal/private networks (SSRF protection).

    Raises ``ValueError`` when the URL points at a blocked cloud-metadata host
    or resolves to a private / loopback / link-local / reserved IP address.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname

    if not hostname:
        raise ValueError(f'Invalid URL: missing hostname in {url}')

    # Block known cloud metadata hostnames
    if hostname.lower() in BLOCKED_HOSTS:
        raise ValueError(f'Blocked request to internal metadata service: {hostname}')

    # Resolve hostname and check IP
    try:
        addr_info = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ValueError(f'Cannot resolve hostname {hostname!r}: {exc}') from exc

    for _family, _, _, _, sockaddr in addr_info:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError(f'Blocked request to private/internal address: {hostname} resolves to {ip}')
