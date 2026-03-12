# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory (Internal) tool node instance.

Delegates tool invocation to the ``MemoryDriver`` created by ``IGlobal``.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Pipeline instance for the memory_internal tool node.

    Purely invoke-based — no lane processing.  All ``tool.*`` operations
    are delegated to the :class:`MemoryDriver` created by :class:`IGlobal`.
    """

    IGlobal: IGlobal

    def invoke(self, param: Any) -> Any:
        """
        Delegate control-plane invocations to the memory driver.
        
        Parameters:
            param (Any): Control-plane request payload to forward to the memory driver.
        
        Returns:
            Any: Response returned by the memory driver.
        """
        driver = getattr(self.IGlobal, 'driver', None)
        if driver is None:
            raise RuntimeError('memory_internal: driver not initialized')
        return driver.handle_invoke(param)
