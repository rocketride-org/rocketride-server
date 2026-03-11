# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory (Internal) tool node — global (per-pipe) state.

Creates a ``MemoryDriver`` on pipe open that provides a run-scoped
keyed memory store accessible as agent tools.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, OPEN_MODE

from .memory_driver import MemoryDriver


class IGlobal(IGlobalBase):
    """Global state for memory_internal."""

    driver: MemoryDriver | None = None

    def beginGlobal(self) -> None:
        """Create the :class:`MemoryDriver` unless we are in config-only mode."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        self.driver = MemoryDriver()

    def endGlobal(self) -> None:
        """Release the memory driver when the pipe closes."""
        self.driver = None
