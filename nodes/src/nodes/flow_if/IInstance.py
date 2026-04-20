# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if per-pipeline instance. Bridges sync engine writes to async driver."""

from __future__ import annotations

import asyncio
from typing import Any

from rocketlib import IInstanceBase

from ..flow_base import AsyncInvoker, Bounds, FlowAction
from .IGlobal import IGlobal
from .driver import IfDriver


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeText(self, text: str) -> None:
        """Gate a `text` chunk through the configured condition."""
        result = self._run_driver(chunk=text, payload_name='text')
        if result.action == FlowAction.SKIP:
            return self.preventDefault()
        self.instance.writeText(result.payload)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_driver(self, *, chunk: Any, payload_name: str):
        driver = IfDriver(
            expression=self.IGlobal.condition,
            payload_name=payload_name,
            invoker=AsyncInvoker(self.instance.invoke),
            bounds=Bounds(timeout_s=self.IGlobal.timeout_s),
            node_id=getattr(self.instance, 'nodeId', '') or '',
        )
        return asyncio.run(driver.run(chunk))
