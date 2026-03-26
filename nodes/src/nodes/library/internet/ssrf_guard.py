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
        'metadata.azure.com',
        'management.azure.com',
        'instance-data.ec2.internal',
    }
)


def validate_url(url: str) -> None:
    """Validate URL is not targeting internal/private networks (SSRF protection).

    Raises ``ValueError`` when the URL points at a blocked cloud-metadata host
    or resolves to a private / loopback / link-local / reserved IP address.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname

    if parsed.scheme.lower() not in ('http', 'https'):
        raise ValueError(f'Unsupported URL scheme: {parsed.scheme!r}')

    if not hostname:
        raise ValueError(f'Invalid URL: missing hostname in {url}')

    # Block known cloud metadata hostnames
    if hostname.lower() in BLOCKED_HOSTS:
        raise ValueError(f'Blocked request to internal metadata service: {hostname}')

    # TODO(security): DNS rebinding (TOCTOU) — an attacker-controlled DNS server
    # could return a public IP during validation and a private IP during the
    # actual request. Full mitigation requires pinning resolved IPs at the
    # transport layer. Tracked as a known limitation.

    # Resolve hostname and check IP
    try:
        addr_info = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ValueError(f'Cannot resolve hostname {hostname!r}: {exc}') from exc

    if not addr_info:
        raise ValueError(f'DNS resolution returned no addresses for {hostname!r}')

    for _family, _, _, _, sockaddr in addr_info:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_multicast:
            raise ValueError(f'Blocked request to multicast address: {hostname} resolves to {ip}')
        if ip.is_unspecified:
            raise ValueError(f'Blocked request to unspecified address: {hostname} resolves to {ip}')
        if not ip.is_global:
            raise ValueError(f'Blocked request to private/internal address: {hostname} resolves to {ip}')
