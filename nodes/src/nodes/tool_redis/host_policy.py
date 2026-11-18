# MIT License
# Copyright (c) 2026 Aparavi Software AG
"""Hosted-engine Redis destination checks, before authentication."""

import ipaddress
import socket

from .redis_client import RedisNodeError

_NAT64_PREFIX = ipaddress.IPv6Network('64:ff9b::/96')
_NAT64_LOCAL_PREFIX = ipaddress.IPv6Network('64:ff9b:1::/48')
_IPV4_COMPATIBLE_PREFIX = ipaddress.IPv6Network('::/96')


def public_ip(address):
    ip = ipaddress.ip_address(address.split('%')[0])
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.is_site_local or ip in _IPV4_COMPATIBLE_PREFIX or ip in _NAT64_LOCAL_PREFIX:
            return False
        embedded = []
        if ip.ipv4_mapped is not None:
            embedded.append(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            embedded.append(ip.sixtofour)
        if ip.teredo is not None:
            embedded.extend(ip.teredo)
        if ip in _NAT64_PREFIX:
            embedded.append(ipaddress.IPv4Address(ip.packed[-4:]))
        if any(not item.is_global or item.is_multicast for item in embedded):
            return False
    return ip.is_global and not ip.is_multicast


def validate_public_host(host, port):
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
