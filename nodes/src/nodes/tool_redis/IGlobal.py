# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Per-control Redis connection pool, built from the control's configuration.

The connection leaves (host, port, database, credentials, TLS, socket timeouts,
pool size) build one client and its pool when the control starts; every call
of the control shares them. The namespace, the write gate and the limits are
parameters of the call: ``IInstance`` reads them from ``self.settings`` and
builds each call's store over this client.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from depends import depends
from hosting import is_hosted, is_shared_host

from rocketlib import IGlobalBase, warning

from .host_policy import public_connection, validate_public_host
from .IValidator import CONNECTION_KEYS, redis_settings
from .redis_client import RedisNodeError, Settings, redis_call

# create_client, host_policy and redis_call import redis where they run, so the
# requirement is installed here, before any of them can. The editor validates
# the node through IValidator alone and never imports this module.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

if TYPE_CHECKING:
    from redis import ConnectionPool, Redis


def create_client(settings: Settings) -> tuple[Redis, ConnectionPool]:
    """Create a bounded Redis client and its owned pool, without connecting.

    Args:
        settings: Validated connection settings.
    Returns:
        The Redis client and the connection pool its caller must close.
    Raises:
        RedisNodeError: If hosted settings lack TLS or resolve privately.
    """
    import redis
    from redis.backoff import NoBackoff
    from redis.retry import Retry

    kwargs = dict(
        host=settings.host,
        port=settings.port,
        db=settings.db,
        username=settings.username or None,
        password=settings.password or None,
        socket_connect_timeout=settings.socket_connect_timeout,
        socket_timeout=settings.socket_timeout,
        max_connections=settings.max_connections,
        decode_responses=False,
        retry=Retry(NoBackoff(), 0),
    )
    if settings.use_tls:
        kwargs.update(connection_class=redis.SSLConnection, ssl_cert_reqs='required', ssl_check_hostname=True)
    if is_hosted() or is_shared_host():
        if not settings.use_tls:
            raise RedisNodeError(
                'invalid_host', 'Hosted Redis requires TLS with certificate and hostname verification.'
            )
        validate_public_host(settings.host, settings.port)
        kwargs['connection_class'] = public_connection(kwargs.get('connection_class', redis.Connection))
    pool = redis.ConnectionPool(**kwargs)
    try:
        return redis.Redis(connection_pool=pool), pool
    except Exception:
        pool.disconnect()
        raise


class IGlobal(IGlobalBase):
    """Own one reusable client and pool for every call of the control."""

    client = None
    pool = None

    def beginGlobal(self) -> None:
        """Build the control's client and pool from its configuration, and check them with PING.

        Returns:
            None after the client is connected.
        Raises:
            RedisNodeError: If configuration, connectivity or authentication fails.
        """
        # The connection leaves only: the namespace, the write gate and the limits are each call's own
        settings = redis_settings(self.config, CONNECTION_KEYS)
        try:
            self.client, self.pool = redis_call(lambda: create_client(settings))
            redis_call(self.client.ping)
        except Exception:
            self.endGlobal()
            raise

    def endGlobal(self) -> None:
        """Attempt both closes, including after partial initialization."""
        client, pool = self.client, self.pool
        self.client = self.pool = None
        try:
            if client is not None:
                client.close()
        except Exception:
            warning('Redis client cleanup failed.')
        finally:
            if pool is not None:
                try:
                    pool.disconnect()
                except Exception:
                    warning('Redis pool cleanup failed.')
