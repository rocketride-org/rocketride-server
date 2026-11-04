# MIT License
# Copyright (c) 2026 Aparavi Software AG
"""Hosted-engine Redis destination checks, before authentication."""

import ipaddress
import socket

from .redis_client import RedisNodeError


def public_ip(address):
    ip = ipaddress.ip_address(address.split('%')[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def validate_public_host(host, port):
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or any(not public_ip(item[4][0]) for item in addresses):
            raise RedisNodeError('invalid_host', 'Hosted Redis must resolve exclusively to public IP addresses.')
    except (socket.gaierror, ValueError):
        raise RedisNodeError('invalid_host', 'Redis host could not be resolved to a public destination.') from None


def public_connection(base):
    """Recheck DNS on each new socket, and its peer before Redis AUTH.

    The original hostname stays on the client for TLS hostname verification.
    The post-connect check closes the DNS check/connect race before credentials
    or any Redis command are sent. Network egress controls remain recommended.
    """

    class PublicConnection(base):
        def _connect(self):
            validate_public_host(self.host, self.port)
            sock = super()._connect()
            try:
                if not public_ip(sock.getpeername()[0]):
                    raise RedisNodeError('invalid_host', 'Redis connected to a non-public destination.')
                return sock
            except Exception:
                sock.close()
                raise

    return PublicConnection
