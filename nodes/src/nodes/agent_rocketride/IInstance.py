# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave node instance.

IInstance handles per-request lifecycle.  One IInstance is created per
concurrent incoming question.  It lazily initialises an AgentHostServices
facade that wires the engine's tool/memory/LLM subsystems into the interface
the Wave driver expects.
"""

from __future__ import annotations

from typing import Any, Optional

from rocketlib import IInstanceBase
from ai.common.schema import Question
from ai.common.agent._internal.host import AgentHostServices

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Pipeline instance for the RocketRide Wave agent node.

    Receives questions on the ``questions`` lane and runs the wave-planning
    agent loop.  Also handles ``tool.*`` invoke operations so this node can
    be used as an agent-as-tool by other agents in the pipeline.
    """

    IGlobal: IGlobal

    # Lazily created on the first question — avoids constructing the host
    # services facade at startup before the pipeline is fully wired.
    _agent_host: Optional[AgentHostServices] = None

    def writeQuestions(self, question: Question) -> None:
        """Entry point for the ``questions`` lane — runs the agent loop.

        Lazily creates the AgentHostServices facade on the first call.
        The facade wraps the engine's invoke() seam and exposes it as
        structured host.llm / host.tools / host.memory attributes that
        the Wave driver and planner use throughout the planning loop.

        Raises ValueError if no memory node is connected — the Wave agent
        requires memory to store and retrieve tool results across planning
        iterations.
        """
        if self._agent_host is None:
            self._agent_host = AgentHostServices(self)
            if self._agent_host.memory is None:
                raise ValueError('RocketRide Wave requires a memory (internal) node to be connected')
        # run_agent() is the AgentBase entry point — it handles run ID generation,
        # SSE emission, tracing, and calls _run() on the driver.
        self.IGlobal.agent.run_agent(self, question, host=self._agent_host, emit_answers_lane=True)

    def invoke(self, param: Any) -> Any:
        """Handle control-plane invocations.

        Routes ``tool.*`` operations to the agent's tool provider
        (agent-as-tool pattern) and falls back to the base class for
        everything else (e.g. pipeline lifecycle events).

        The agent-as-tool pattern lets other agents in the pipeline invoke
        this Wave agent as a named tool via the standard tool.query /
        tool.validate / tool.invoke protocol, without needing to know that
        the underlying implementation is a planning agent.
        """
        op = param.get('op') if isinstance(param, dict) else getattr(param, 'op', None)
        if isinstance(op, str) and op.startswith('tool.'):
            # Delegate to AgentBase.handle_invoke() which routes to the
            # _AgentAsToolProvider adapter defined in agent_tool.py
            return self.IGlobal.agent.handle_invoke(self, param)
        return super().invoke(param)
