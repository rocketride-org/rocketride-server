# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave node instance.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase
from ai.common.schema import Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Pipeline instance for the RocketRide Wave agent node.

    Receives questions on the ``questions`` lane and runs the wave-planning
    agent loop.  Also handles ``tool.*`` invoke operations so this node can
    be used as an agent-as-tool by other agents.
    """

    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        """Entry point for the ``questions`` lane — runs the agent loop."""
        self.IGlobal.agent.run_agent(self, question, emit_answers_lane=True)

    def invoke(self, param: Any) -> Any:
        """Handle control-plane invocations.

        Routes ``tool.*`` operations to the agent's tool provider
        (agent-as-tool pattern) and falls back to the base class for
        everything else.
        """
        op = param.get('op') if isinstance(param, dict) else getattr(param, 'op', None)
        if isinstance(op, str) and op.startswith('tool.'):
            return self.IGlobal.agent.handle_invoke(self, param)
        return super().invoke(param)
