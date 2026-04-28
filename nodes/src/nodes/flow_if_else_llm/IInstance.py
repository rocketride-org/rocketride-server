# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else_llm per-pipeline instance. Routes each chunk via an LLM-evaluated condition.

Same gate scaffolding as ``flow_if_else.IInstance`` (``AutoGatingMixin``
synthesises every content writeXxx; the streaming-aware path buffers
BEGIN/WRITE/END for image/audio/video so the LLM sees the complete
payload). The only divergence is the driver: ``IfElseLLMDriver``
delegates the decision to the LLM wired on the ``llm`` invoke channel
instead of evaluating a Python expression in the sandbox.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Optional

from rocketlib import IInstanceBase

from ..flow_base import AsyncInvoker, AutoGatingMixin, Bounds, Decision, FlowResult
from .IGlobal import IGlobal
from .driver import IfElseLLMDriver

_logger = logging.getLogger('rocketride.flow')


class IInstance(IInstanceBase, AutoGatingMixin):
    IGlobal: IGlobal

    # No writeXxx overrides here: AutoGatingMixin generates a streaming-
    # aware override for every content writeXxx on IInstanceBase. The
    # condition is the SAME LLM call regardless of which lane fires.

    # ------------------------------------------------------------------
    # Core gate — invokes the LLM and routes to a single branch
    # ------------------------------------------------------------------

    def _gate(self, chunk: Any, payload_name: str, forward: Callable[[Any], None], extras: dict = None) -> None:
        """Resolve the LLM target node, run the driver, fan out to the chosen branch."""
        extras = extras or {}
        result = self._run_driver(chunk=chunk, payload_name=payload_name, extras=extras)
        branch = _branch_name(result)
        targets = self.IGlobal.targets_for(branch)

        node_id = getattr(self.instance, 'nodeId', '') or '<unknown>'

        # Nothing connected on the chosen branch — drop the chunk.
        if not targets:
            _logger.info(
                'flow_if_else_llm._gate node=%s lane=%s branch=%s targets=[] outcome=dropped',
                node_id,
                payload_name,
                branch,
            )
            return self.preventDefault()

        _logger.info(
            'flow_if_else_llm._gate node=%s lane=%s branch=%s targets=%r outcome=forwarded',
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
            self.instance.setTargetFilter('')

        self.preventDefault()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_driver(self, *, chunk: Any, payload_name: str, extras: dict = None) -> FlowResult:
        llm_node_id = self._resolve_llm_node_id()
        mime_type = (extras or {}).get('mimeType') or _default_mime_for_lane(payload_name)
        driver = IfElseLLMDriver(
            question=self.IGlobal.question,
            llm_node_id=llm_node_id,
            payload_name=payload_name,
            mime_type=mime_type,
            invoker=AsyncInvoker(self.instance.invoke),
            bounds=Bounds(timeout_s=self.IGlobal.timeout_s),
            node_id=getattr(self.instance, 'nodeId', '') or '',
        )
        return asyncio.run(driver.run(chunk))

    def _resolve_llm_node_id(self) -> str:
        """Resolve the single LLM wired on the ``llm`` invoke channel.

        ``services.json`` declares ``invoke.llm.min = 1`` so the engine
        rejects pipelines without a wired LLM. Defensively raise if more
        than one is wired (the routing question expects a single answer;
        multiple LLMs disagreeing would be ambiguous).
        """
        nodes = self.instance.getControllerNodeIds('llm')
        if not nodes:
            raise RuntimeError('flow_if_else_llm requires an LLM node connected on the "llm" invoke channel — none found.')
        if len(nodes) > 1:
            raise RuntimeError(f'flow_if_else_llm expects exactly one LLM connected; found {len(nodes)}: {nodes}')
        return nodes[0]


def _branch_name(result: FlowResult) -> str:
    return 'then' if result.decision == Decision.THEN else 'else'


def _default_mime_for_lane(payload_name: str) -> Optional[str]:
    """Best-guess MIME type for binary lanes when the engine didn't supply one.

    Used as a fallback so the data URL the driver builds is well-formed
    even if the upstream node forgot to set a mimeType. ``None`` for
    text-like lanes — the driver short-circuits binary handling for
    those and never inspects this value.
    """
    return {
        'image': 'image/png',
        'audio': 'audio/mpeg',
        'video': 'video/mp4',
    }.get(payload_name)
