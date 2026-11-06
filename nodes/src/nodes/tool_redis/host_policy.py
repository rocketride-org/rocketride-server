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
        return list(dict.fromkeys(item[4][0] for item in addresses))
    except (socket.gaierror, ValueError):
        raise RedisNodeError('invalid_host', 'Redis host could not be resolved to a public destination.') from None


def public_connection(base):
    """Pin a validated destination and check its peer before TLS or Redis AUTH.

    Resolve again on each new connection. Connect to numeric addresses from
    that resolution, then restore the original hostname for TLS verification.
    Network egress controls remain recommended.
    """

    class PublicConnection(base):
        def _connect(self):
            # Import after load_depends, like create_client. The supported
            # redis-py 7.x SSLConnection exposes _wrap_socket_with_ssl.
            from redis import Connection, SSLConnection

            hostname = self.host
            destinations = validate_public_host(hostname, self.port)
            last_error = None
            for destination in destinations:
                try:
                    self.host = destination
                    # SSLConnection._connect also sends the TLS handshake.
                    # Open only TCP here so the peer check comes first.
                    sock = Connection._connect(self) if isinstance(self, SSLConnection) else super()._connect()
                except OSError as exc:
                    last_error = exc
                    continue
                finally:
                    self.host = hostname
                try:
                    if not public_ip(sock.getpeername()[0]):
                        raise RedisNodeError('invalid_host', 'Redis connected to a non-public destination.')
                    return self._wrap_socket_with_ssl(sock) if isinstance(self, SSLConnection) else sock
                except Exception:
                    sock.close()
                    raise
            raise last_error

    return PublicConnection
