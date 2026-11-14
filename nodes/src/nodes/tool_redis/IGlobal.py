# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Per-pipeline Redis configuration and owned connection pool."""

from hosting import is_hosted, is_shared_host

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .host_policy import public_connection, validate_public_host
from .redis_client import RedisNodeError, RedisStore, Settings, redis_call


def create_client(settings: Settings):
    """Create an explicitly bounded pool with no automatic command retries."""
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
    """Own one reusable client/pool for the pipeline's Redis tool instances."""

    client = None
    pool = None
    store = None

    def _settings(self) -> Settings:
        cfg = dict(Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig))
        cfg['password'] = cfg.get('password') or None
        return Settings.from_config(cfg)

    def validateConfig(self) -> None:
        """Validate offline; never connect while editing the node."""
        try:
            self._settings()
        except RedisNodeError as exc:
            warning(str(exc))

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        from depends import load_depends

        load_depends(__file__)
        settings = self._settings()
        try:
            self.client, self.pool = redis_call(lambda: create_client(settings))
            redis_call(self.client.ping)
            self.store = RedisStore(self.client, settings)
        except Exception:
            self.endGlobal()
            raise

    def endGlobal(self) -> None:
        """Attempt both closes, including after partial initialization."""
        client, pool = self.client, self.pool
        self.store = self.client = self.pool = None
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
