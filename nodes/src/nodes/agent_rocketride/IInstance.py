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
        """
        Process an incoming Question through the agent loop and emit answers to the answers lane.
        
        Parameters:
            question (Question): The incoming question to handle.
        """
        self.IGlobal.agent.run_agent(self, question, emit_answers_lane=True)

    def invoke(self, param: Any) -> Any:
        """
        Route control-plane invocations to the agent's tool provider when applicable.
        
        If the invocation's operation name starts with "tool." it is forwarded to the agent's tool provider; otherwise the base class invocation handler is used.
        
        Parameters:
        	param (Any): Invocation payload; may be a dict with an "op" key or an object with an `op` attribute.
        
        Returns:
        	Any: The result returned by the chosen invocation handler.
        """
        op = param.get('op') if isinstance(param, dict) else getattr(param, 'op', None)
        if isinstance(op, str) and op.startswith('tool.'):
            return self.IGlobal.agent.handle_invoke(self, param)
        return super().invoke(param)
