# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Persistent Memory node — global (per-pipe) state.

Creates the ``PersistentMemoryStore`` with the configured backend and
makes it available to all instances via ``self.store``.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config, check_credential_resolved, warn_if_credential_unresolved


class IGlobal(IGlobalBase):
    """Global state for memory_persistent — holds the store and config."""

    store = None
    config = None

    def beginGlobal(self) -> None:
        """Initialize the persistent memory store from node configuration."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        import os
        from depends import depends  # type: ignore

        # Load the requirements
        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        # Load node configuration
        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Build store from config
        from .memory_store import PersistentMemoryStore

        backend = self.config.get('backend', 'memory')
        if backend == 'redis':
            # Sent as is, Redis would answer "invalid password" without naming the missing variable.
            check_credential_resolved(
                self.glb.logicalType, 'redis_password', self.config.get('redis_password'), self.glb.connConfig
            )
        self.store = PersistentMemoryStore(
            backend=backend,
            max_history=int(self.config.get('max_history', 100)),
            auto_summarize=bool(self.config.get('auto_summarize', True)),
            redis_host=self.config.get('redis_host', 'localhost'),
            redis_port=int(self.config.get('redis_port', 6379)),
            redis_password=self.config.get('redis_password') or None,
            session_ttl_hours=float(self.config.get('session_ttl_hours', 0)),
        )

    def validateConfig(self) -> None:
        """Save-time check: warn when the Redis password is an unfilled ${...} placeholder."""
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        if config.get('backend', 'memory') == 'redis':
            warn_if_credential_unresolved(
                self.glb.logicalType, 'redis_password', config.get('redis_password'), self.glb.connConfig
            )

    def endGlobal(self) -> None:
        """Release resources and close backend connections.

        Uses ``try/finally`` to guarantee the backend is released even if
        ``close()`` raises (e.g. transient Redis error during disconnect),
        preventing connection leaks in long-running pipelines.
        """
        try:
            if self.store is not None:
                self.store.backend.close()
        finally:
            self.store = None
            self.config = None
