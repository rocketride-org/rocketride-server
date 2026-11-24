# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""What the editor is told when the node is saved, and the one reader of the node's values.

The engine imports this module alone in CONFIG mode, so it imports no redis:
``redis_client`` imports only the standard library at module scope. The schema
check is the resolver (``self.config``). The semantic check is the node's own,
offline: ``Settings.from_config`` checks every value again (the key prefix
grammar, the timeouts, a ``rediss://`` host), and a hosted engine without TLS
is warned about. It never resolves DNS and never connects.

``redis_settings`` builds those settings for the three readers: ``IGlobal``
builds the connection pool from the control's ``CONNECTION_KEYS``, and
``IInstance`` builds each call's store from the call's settings, which add the
``CALL_KEYS`` parameters.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from hosting import is_hosted, is_shared_host
from rocketlib import IValidatorBase, warning

from .redis_client import RedisNodeError, Settings

#: The leaves the connection pool is built from: the control's configuration.
CONNECTION_KEYS = (
    'host',
    'port',
    'db',
    'username',
    'password',
    'use_tls',
    'socket_connect_timeout',
    'socket_timeout',
    'max_connections',
)

#: The leaves each call reads: parameters of the call ("param": true) that an agent cannot set ("tool": false).
CALL_KEYS = ('key_prefix', 'allow_writes', 'default_ttl_seconds', 'max_value_bytes')

HOSTED_TLS_REQUIRED = 'Hosted Redis requires TLS with certificate and hostname verification.'


def redis_settings(view: Mapping[str, Any], keys: Sequence[str] = CONNECTION_KEYS + CALL_KEYS) -> Settings:
    """
    Validated settings from the node's resolved values.

    Args:
        view: The control's ``config``, one call's ``settings``, or the full resolved view.
        keys: The leaves to read; a leaf the view does not hold keeps its default.

    Returns:
        Settings: the values, checked again; an empty password reads as no password.

    Raises:
        RedisNodeError: A value fails the node's own checks; the message never echoes a credential.
    """
    cfg = {key: view[key] for key in keys if key in view}
    cfg['password'] = cfg.get('password') or None
    return Settings.from_config(cfg)


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the node's offline checks."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config, then warn about a value the node would refuse or a hosted engine without TLS.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        self.config
        if syntaxOnly:
            return
        try:
            # The call's leaves are parameters, which self.config refuses: their stored values are in the full view
            settings = redis_settings(self._resolved())
            if (is_hosted() or is_shared_host()) and not settings.use_tls:
                warning(HOSTED_TLS_REQUIRED)
        except RedisNodeError as exc:
            warning(str(exc))
