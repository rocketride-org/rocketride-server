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

import os

from rocketlib import IGlobalBase

from .memory_store import PersistentMemoryStore


class IGlobal(IGlobalBase):
    """Global state for memory_persistent: holds the store built from the resolved config."""

    store = None

    def beginGlobal(self) -> None:
        """Build the persistent memory store from the node configuration."""
        from depends import depends  # type: ignore

        # Load the requirements (the redis client is imported by the redis backend)
        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        # The resolved config: the backend selector, flattened to the active branch
        config = self.config
        self.store = PersistentMemoryStore(
            backend=config.backend,
            max_history=config.max_history,
            auto_summarize=config.auto_summarize,
            redis_host=config.get('redis_host', 'localhost'),
            redis_port=config.get('redis_port', 6379),
            redis_password=config.get('redis_password') or None,
            session_ttl_hours=float(config.session_ttl_hours),
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
