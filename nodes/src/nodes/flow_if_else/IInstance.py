# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else per-pipeline instance. Routes each chunk to THEN or ELSE targets.

The class body defines only the gating logic (``_gate``) and the driver
invocation (``_run_driver``). ``AutoGatingMixin`` synthesises one override
per content-bearing ``writeXxx`` method on ``IInstanceBase`` at class-
creation time — no manual override list, no drift when the engine adds a
new content lane.

Target filter is always reset to ``""`` after each branch completes,
including on exception, so no state bleeds into the next chunk or into
unrelated writes through the same binder.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from rocketlib import IInstanceBase

from ..flow_base import AsyncInvoker, AutoGatingMixin, Bounds, Decision, FlowResult
from .IGlobal import IGlobal
from .driver import IfElseDriver

_logger = logging.getLogger('rocketride.flow')


class IInstance(IInstanceBase, AutoGatingMixin):
    IGlobal: IGlobal

    # No writeXxx overrides here: `AutoGatingMixin.__init_subclass__` walks
    # `IInstanceBase` at class-creation time and generates a gated override
    # for every content method it finds. New engine types picked up by
    # rocketlib's `IInstanceBase` get gated automatically.

    # ------------------------------------------------------------------
    # Core gate — evaluates the condition and routes to a single branch
    # ------------------------------------------------------------------

    def _gate(self, chunk: Any, payload_name: str, forward: Callable[[Any], None]) -> None:
        """Evaluate the condition once, then fan out only to the selected branch."""
        result = self._run_driver(chunk=chunk, payload_name=payload_name)
        branch = _branch_name(result)
        targets = self.IGlobal.targets_for(branch)

        node_id = getattr(self.instance, 'nodeId', '') or '<unknown>'

        # Nothing connected on the chosen branch — drop the chunk silently
        # via preventDefault. Lets users leave the ELSE port unwired as a
        # "route truthy chunks, drop the rest" shortcut.
        if not targets:
            # Stephan hit a variant where condition=False but the chunk still
            # reached the THEN-wired downstream. A one-line trace of every
            # decision + outcome turns that class of bug from "why did the
            # chunk arrive?" into a one-grep diagnosis.
            _logger.info(
                'flow_if_else._gate node=%s lane=%s branch=%s targets=[] outcome=dropped',
                node_id,
                payload_name,
                branch,
            )
            return self.preventDefault()

        _logger.info(
            'flow_if_else._gate node=%s lane=%s branch=%s targets=%r outcome=forwarded',
            node_id,
            payload_name,
            branch,
            targets,
        )

        try:
            for target_id in targets:
                self.instance.setTargetFilter(target_id)
                forward(result.payload)
        finally:
            # Always reset — never let the filter leak across chunks.
            self.instance.setTargetFilter('')

        # We've already delivered to the selected targets; block the engine's
        # default broadcast so no other subscriber sees this chunk.
        self.preventDefault()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_driver(self, *, chunk: Any, payload_name: str) -> FlowResult:
        driver = IfElseDriver(
            expression=self.IGlobal.condition,
            payload_name=payload_name,
            invoker=AsyncInvoker(self.instance.invoke),
            bounds=Bounds(timeout_s=self.IGlobal.timeout_s),
            node_id=getattr(self.instance, 'nodeId', '') or '',
        )
        return asyncio.run(driver.run(chunk))


def _branch_name(result: FlowResult) -> str:
    return 'then' if result.decision == Decision.THEN else 'else'
