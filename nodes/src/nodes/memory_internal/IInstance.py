# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory (Internal) tool node instance.

Each instance owns its own ``MemoryDriver`` created in ``beginInstance``.
On ``open`` the store is cleared so every client session starts fresh.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase

from .IGlobal import IGlobal
from .memory_driver import MemoryDriver


class IInstance(IInstanceBase):
    """Pipeline instance for the memory_internal tool node."""

    IGlobal: IGlobal
    driver: MemoryDriver = None

    def beginInstance(self) -> None:
        """Create the private MemoryDriver when the pipe is instantiated."""
        self.driver = MemoryDriver()

    def open(self, _obj: Any) -> None:
        """Clear the memory store so each client session starts fresh."""
        self.driver._store.clear()

    def invoke(self, param: Any) -> Any:
        """Delegate tool control-plane operations to the memory driver."""
        return self.driver.handle_invoke(param)
