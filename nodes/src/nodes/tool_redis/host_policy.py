# MIT License
# Copyright (c) 2026 Aparavi Software AG
"""Hosted-engine Redis destination checks, before authentication."""

import ipaddress
import socket

from ai.common.utils.url_utils import is_public_address

from .redis_client import RedisNodeError


def public_ip(address: str) -> bool:
    """Check an IP string using the same address policy as the HTTP client.

    Args:
        address: IPv4 or IPv6 text, optionally including a zone suffix.
    Returns:
        Whether the address and any embedded IPv4 addresses are public.
    Raises:
        ValueError: If the address is malformed.
    """
    return is_public_address(ipaddress.ip_address(address.split('%')[0]))


def validate_public_host(host: str, port: int) -> list[str]:
    """Resolve a Redis host to unique public connection destinations.

    Args:
        host: Redis hostname or IP address.
        port: Redis port used for resolution.
    Returns:
        Unique numeric addresses in resolver order.
    Raises:
        RedisNodeError: If resolution fails or any address is non-public.
    """
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or any(not public_ip(item[4][0]) for item in addresses):
            raise RedisNodeError('invalid_host', 'Hosted Redis must resolve exclusively to public IP addresses.')
        return list(dict.fromkeys(item[4][0] for item in addresses))
    except RedisNodeError:
        raise
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
                    if isinstance(self, SSLConnection):
                        # redis-py private connection hooks require the redis<8
                        # pin. Bypass SSLConnection._connect until the TCP peer
                        # is checked; wrap the socket only after that check.
                        sock = Connection._connect(self)
                    else:
                        sock = super()._connect()
                except OSError as exc:
                    last_error = exc
                    continue
                finally:
                    self.host = hostname
                try:
                    if not public_ip(sock.getpeername()[0]):
                        raise RedisNodeError('invalid_host', 'Redis connected to a non-public destination.')
                    if isinstance(self, SSLConnection):
                        return self._wrap_socket_with_ssl(sock)
                    return sock
                except Exception:
                    sock.close()
                    raise
            raise last_error

    return PublicConnection
