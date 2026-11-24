# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Bounded Redis string operations and node-specific validation."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

MAX_VALUE_BYTES = 64 * 1024
MAX_RESULT_BYTES = 128 * 1024
MAX_KEY_BYTES = 256
MAX_TTL_SECONDS = 2**31 - 1
MAX_DATABASE_INDEX = 2**31 - 1
_MAX_REDIS_INTEGER = 2**63 - 1


class RedisNodeError(ValueError):
    """An expected failure safe to return to a tool caller."""

    def __init__(self, code: str, message: str, outcome: str = 'not_applied'):
        super().__init__(message)
        self.code = code
        self.outcome = outcome


def integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    """Require an integer, excluding Python booleans."""
    if type(value) is not int or not minimum <= value <= maximum:
        raise RedisNodeError('invalid_input', f'{name} must be an integer from {minimum} to {maximum}.')
    return value


def utf8(value: Any, name: str) -> bytes:
    """Encode a tool string without guessing encodings or serializing objects."""
    if not isinstance(value, str):
        raise RedisNodeError('invalid_input', f'{name} must be a string.')
    try:
        return value.encode('utf-8')
    except UnicodeError:
        raise RedisNodeError('invalid_encoding', f'{name} must be valid UTF-8 text.') from None


@dataclass(frozen=True)
class Settings:
    """Validated per-pipeline connection and operation settings."""

    host: str = 'localhost'
    port: int = 6379
    db: int = 0
    username: str | None = None
    password: str | None = field(default=None, repr=False)
    use_tls: bool = False
    key_prefix: str = 'rr:'
    allow_writes: bool = False
    default_ttl_seconds: int = 3600
    socket_connect_timeout: float = 3.0
    socket_timeout: float = 5.0
    max_connections: int = 10
    max_value_bytes: int = MAX_VALUE_BYTES

    @classmethod
    def from_config(cls, config: dict) -> Settings:
        """Validate UI settings again at runtime; never echo credential values."""
        cfg = {name: config[name] for name in cls.__dataclass_fields__ if name in config}
        for name in ('use_tls', 'allow_writes'):
            if name in cfg and type(cfg[name]) is not bool:
                raise RedisNodeError('invalid_input', f'{name} must be a boolean.')
        host = cfg.get('host', 'localhost')
        if isinstance(host, str) and host.startswith('rediss://'):
            try:
                parsed = urlsplit(host)
                if (
                    not parsed.hostname
                    or parsed.username is not None
                    or parsed.password is not None
                    or parsed.path
                    or parsed.query
                    or parsed.fragment
                ):
                    raise ValueError()
                cfg['host'] = parsed.hostname
                cfg['port'] = parsed.port if parsed.port is not None else cfg.get('port', 6379)
                cfg['use_tls'] = True
            except ValueError:
                raise RedisNodeError(
                    'invalid_input', 'Use rediss://host:port without credentials, path or query.'
                ) from None
        result = cls(**cfg)
        if (
            not isinstance(result.host, str)
            or not result.host.strip()
            or result.host != result.host.strip()
            or '://' in result.host
        ):
            raise RedisNodeError('invalid_input', 'host must be a nonempty hostname or IP address, not a URL.')
        integer(result.port, 'port', 1, 65535)
        integer(result.db, 'db', 0, MAX_DATABASE_INDEX)
        integer(result.default_ttl_seconds, 'default_ttl_seconds', 0, MAX_TTL_SECONDS)
        integer(result.max_connections, 'max_connections', 1, 100)
        integer(result.max_value_bytes, 'max_value_bytes', 1, MAX_VALUE_BYTES)
        for name in ('socket_connect_timeout', 'socket_timeout'):
            value = getattr(result, name)
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 120:
                raise RedisNodeError('invalid_input', f'{name} must be a finite number greater than 0 and at most 120.')
        if not isinstance(result.key_prefix, str) or not re.fullmatch(r'[A-Za-z0-9:_-]{0,127}:', result.key_prefix):
            raise RedisNodeError(
                'invalid_input',
                'key_prefix must be 1 to 128 literal ASCII characters (letters, digits, _, :, -), ending in :.',
            )
        for name in ('username', 'password'):
            value = getattr(result, name)
            if value is not None:
                utf8(value, name)
        return result


def redis_call(operation: Callable, *, mutation: bool = False):
    """Convert SDK failures to credential-safe errors without retrying commands."""
    from redis.exceptions import (
        AuthenticationError,
        AuthorizationError,
        ConnectionError,
        DataError,
        MaxConnectionsError,
        NoPermissionError,
        RedisError,
        ResponseError,
        TimeoutError,
    )

    try:
        return operation()
    except AuthenticationError:
        raise RedisNodeError('authentication_error', 'Redis authentication failed.') from None
    except (AuthorizationError, NoPermissionError):
        raise RedisNodeError('permission_denied', 'Redis ACL permissions do not allow this operation.') from None
    except MaxConnectionsError:
        raise RedisNodeError('connection_error', 'All Redis connections in the pool are in use.') from None
    except (ConnectionError, TimeoutError):
        message = 'Redis could not complete the request.'
        outcome = 'not_applied'
        if mutation:
            message = 'Redis could not complete the request. A write may have been applied; verify before retrying.'
            outcome = 'unknown'
        raise RedisNodeError('connection_error', message, outcome) from None
    except DataError:
        raise RedisNodeError('invalid_input', 'Redis rejected an argument.') from None
    except ResponseError:
        raise RedisNodeError(
            'invalid_operation', 'Redis rejected the operation; check the key type and server permissions.'
        ) from None
    except RedisError:
        outcome = 'not_applied'
        if mutation:
            outcome = 'unknown'
        raise RedisNodeError('redis_error', 'Redis could not complete the operation.', outcome) from None


class RedisStore:
    """Seven namespaced tools; no arbitrary command entry point."""

    def __init__(self, client: Any, settings: Settings):
        self.client = client
        self.settings = settings

    def scope_key(self, key: Any) -> str:
        """Always prepend the namespace, even when the logical key resembles it."""
        encoded = utf8(key, 'key')
        if not encoded or len(encoded) + len(self.settings.key_prefix) > MAX_KEY_BYTES:
            raise RedisNodeError(
                'invalid_input', 'key must be nonempty and at most 256 UTF-8 bytes including the namespace.'
            )
        return self.settings.key_prefix + key

    def get(self, key: Any) -> dict:
        """Fetch at most the configured byte limit plus one; never truncate a value."""
        scoped = self.scope_key(key)

        def read():
            # GETRANGE keeps foreign oversized values out of the process. TTL
            # distinguishes a missing key from an existing empty string.
            with self.client.pipeline(transaction=True) as pipe:
                pipe.getrange(scoped, 0, self.settings.max_value_bytes)
                pipe.ttl(scoped)
                return pipe.execute()

        value, ttl = redis_call(read)
        if ttl == -2:
            return {'key': key, 'found': False, 'value': None, 'ttl_seconds': -2}
        if len(value) > self.settings.max_value_bytes:
            raise RedisNodeError('value_too_large', 'The stored value exceeds the configured byte limit.')
        try:
            text = value.decode('utf-8')
        except UnicodeError:
            raise RedisNodeError('invalid_encoding', 'The stored value is not UTF-8 text.') from None
        return _found_value(key, text, ttl)

    def set(self, key: Any, value: Any, ttl_seconds: Any = None, condition: Any = None) -> dict:
        """Store a UTF-8 string with atomic SET expiry and optional NX/XX."""
        self.require_writes()
        scoped = self.scope_key(key)
        encoded = utf8(value, 'value')
        if len(encoded) > self.settings.max_value_bytes:
            raise RedisNodeError('value_too_large', 'value exceeds the configured UTF-8 byte limit.')
        if ttl_seconds is None:
            ttl = self.settings.default_ttl_seconds
        else:
            ttl = integer(ttl_seconds, 'ttl_seconds', 0, MAX_TTL_SECONDS)
        if condition is not None and condition not in ('NX', 'XX'):
            raise RedisNodeError('invalid_input', 'condition must be NX or XX when supplied.')
        # Leave enough room to read the value back even if its expiry changes.
        bounded_result(
            {'success': True, **_found_value(key, value, _MAX_REDIS_INTEGER)},
            error_message='value would be too large to read back within the 128 KiB result limit.',
        )
        stored = redis_call(
            lambda: self.client.set(scoped, encoded, ex=ttl or None, nx=condition == 'NX', xx=condition == 'XX'),
            mutation=True,
        )
        return {'key': key, 'stored': bool(stored), 'requested_ttl_seconds': ttl}

    def ttl(self, key: Any) -> dict:
        """Return Redis's missing/persistent/expiring TTL states."""
        ttl = redis_call(lambda: self.client.ttl(self.scope_key(key)))
        return {'key': key, 'exists': ttl != -2, 'has_expiry': ttl >= 0, 'ttl_seconds': ttl}

    def require_writes(self) -> None:
        """Require the pipeline's write permission before any mutation.

        Returns:
            None when writes are enabled.
        Raises:
            RedisNodeError: If the node is read-only.
        """
        if not self.settings.allow_writes:
            raise RedisNodeError('permission_denied', 'Redis node is read-only. Enable allow_writes to mutate keys.')

    def expire(self, key: Any, ttl_seconds: Any) -> dict:
        """Set a positive expiry on one logical key.

        Args:
            key: Logical key within this store's namespace.
            ttl_seconds: Integer expiry from 1 through MAX_TTL_SECONDS.
        Returns:
            The key, whether it existed, and the requested expiry.
        Raises:
            RedisNodeError: If writes are disabled, input is invalid or Redis fails.
        """
        self.require_writes()
        scoped = self.scope_key(key)
        ttl = integer(ttl_seconds, 'ttl_seconds', 1, MAX_TTL_SECONDS)
        updated = redis_call(lambda: self.client.expire(scoped, ttl), mutation=True)
        return {'key': key, 'updated': bool(updated), 'requested_ttl_seconds': ttl}

    def incr(self, key: Any, amount: Any = '1') -> dict:
        """Increment a counter once without retrying a failed command.

        Args:
            key: Logical counter key.
            amount: Signed 64-bit decimal string, defaulting to one.
        Returns:
            The key and its exact new value as a decimal string.
        Raises:
            RedisNodeError: If writes are disabled, input is invalid or Redis fails.
        """
        self.require_writes()
        scoped = self.scope_key(key)
        # Decimal strings preserve the full signed 64-bit range through JS.
        if not isinstance(amount, str) or not re.fullmatch(r'-?(0|[1-9][0-9]{0,18})', amount):
            raise RedisNodeError('invalid_input', 'amount must be a signed 64-bit decimal string.')
        delta = int(amount)
        if not -_MAX_REDIS_INTEGER - 1 <= delta <= _MAX_REDIS_INTEGER:
            raise RedisNodeError('invalid_input', 'amount is outside the signed 64-bit range.')
        value = redis_call(lambda: self.client.incrby(scoped, delta), mutation=True)
        return {'key': key, 'value_decimal': str(value)}

    def scan(self, cursor: Any = '0', count: Any = 100) -> dict:
        """Read one namespace page, skipping invalid keys without losing its cursor.

        Args:
            cursor: Unsigned 64-bit decimal cursor; zero starts an iteration.
            count: Integer work hint between 1 and 500.
        Returns:
            Logical keys, next cursor, completion flag and skipped-key count.
        Raises:
            RedisNodeError: If input or the result is oversized/invalid, or Redis fails.
        """
        if not isinstance(cursor, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', cursor) or int(cursor) > 2**64 - 1:
            raise RedisNodeError('invalid_input', 'cursor must be an unsigned 64-bit decimal string.')
        integer(count, 'count', 1, 500)
        next_cursor, raw_keys = redis_call(
            lambda: self.client.scan(cursor=int(cursor), match=self.settings.key_prefix + '*', count=count)
        )
        prefix = self.settings.key_prefix.encode('ascii')
        keys = []
        skipped = 0
        for raw in raw_keys:
            if not raw.startswith(prefix) or not len(prefix) < len(raw) <= MAX_KEY_BYTES:
                skipped += 1
                continue
            try:
                key = raw[len(prefix) :].decode('utf-8')
            except UnicodeError:
                skipped += 1
                continue
            keys.append(key)
        return bounded_result({'cursor': str(next_cursor), 'keys': keys, 'done': next_cursor == 0, 'skipped': skipped})

    def delete(self, keys: Any) -> dict:
        """Delete an explicit list of namespaced keys, treating glob characters literally.

        Args:
            keys: List of 1 to 100 logical keys.
        Returns:
            The number of keys deleted, excluding missing keys and duplicates.
        Raises:
            RedisNodeError: If writes are disabled, input is invalid or Redis fails.
        """
        self.require_writes()
        if not isinstance(keys, list) or not 1 <= len(keys) <= 100:
            raise RedisNodeError('invalid_input', 'keys must be an array of 1–100 explicit logical keys.')
        # Validate every key before sending a single DEL with literal arguments.
        scoped = [self.scope_key(key) for key in keys]
        deleted = redis_call(lambda: self.client.delete(*scoped), mutation=True)
        return {'deleted_count': deleted}


def _found_value(key: str, value: str, ttl: int) -> dict:
    return {'key': key, 'found': True, 'value': value, 'ttl_seconds': ttl}


def bounded_result(
    result: dict,
    *,
    error_message: str = 'Serialized result exceeds 128 KiB; narrow the data or reduce the SCAN count hint.',
) -> dict:
    """Return a result only when its serialized envelope fits the transport limit.

    Args:
        result: JSON-compatible result dictionary.
        error_message: Safe operation-specific advice for an oversized result.
    Returns:
        The unchanged result dictionary.
    Raises:
        RedisNodeError: If ASCII-escaped JSON exceeds MAX_RESULT_BYTES.
    """
    # Use ASCII escaping: the cap also covers JSON transports that escape every
    # non-ASCII character, including UTF-16 surrogate pairs.
    if len(json.dumps(result, ensure_ascii=True).encode('utf-8')) > MAX_RESULT_BYTES:
        raise RedisNodeError('result_too_large', error_message)
    return result
