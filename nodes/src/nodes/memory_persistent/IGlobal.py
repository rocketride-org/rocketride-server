# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Persistent Memory node — global (per-control) state.

The backend is the control's: on the ``redis`` branch the IGlobal holds the
connection pool to the owner's Redis; on the ``memory`` branch it holds
nothing, because the sessions live in each binding's ``self.state``, which
the server keeps per owner so any replica serves the next call. The history
cap, the summarization and the session time to live are per-call parameters
the instance reads from its settings.
"""

from __future__ import annotations

import os

from rocketlib import IGlobalBase

from .memory_store import RedisBackend


class IGlobal(IGlobalBase):
    """Global state for memory_persistent: the Redis pool on the redis branch, else nothing."""

    redis = None

    def beginGlobal(self) -> None:
        """Connect to the owner's Redis when the control's backend is ``redis``."""
        config = self.config
        if config.backend != 'redis':
            return

        from depends import depends  # type: ignore

        # Load the requirements (the redis client is imported by the redis backend)
        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        self.redis = RedisBackend(
            host=config.redis_host,
            port=config.redis_port,
            password=config.get('redis_password') or None,
        )

    def endGlobal(self) -> None:
        """Release the Redis pool.

        Uses ``try/finally`` to guarantee the backend is released even if
        ``close()`` raises (e.g. transient Redis error during disconnect),
        preventing connection leaks in long-running pipelines.
        """
        try:
            if self.redis is not None:
                self.redis.close()
        finally:
            self.redis = None
