# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Manager — IInstance for the hierarchical multi-agent CrewAI node.

Handles the questions lane (delegates to `CrewManager.run_agent`) and exposes
itself as a `run_agent` tool via `@tool_function` so this node can be invoked
by parent agents in the pipeline (cross-framework nesting — e.g. a LangChain
agent can call a CrewAI Manager and get back a hierarchical Crew result as
a single tool response).

Does NOT expose a `describe` handler — Manager cannot itself be a sub-agent
under another Manager.  Cross-Manager composition uses `tool.run_agent`
(this method), not the `crewai` invoke channel.
"""

from __future__ import annotations

import json
from typing import Any

from rocketlib import IInstanceBase, tool_function
from ai.common.agent.types import AGENT_TOOL_INPUT_SCHEMA, AGENT_TOOL_OUTPUT_SCHEMA
from ai.common.schema import Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question):
        self.IGlobal.agent.run_agent(self, question, emit_answers_lane=True)

    @tool_function(
        input_schema=AGENT_TOOL_INPUT_SCHEMA,
        output_schema=AGENT_TOOL_OUTPUT_SCHEMA,
        description=lambda self: (
            f'This agent: {self.IGlobal.agent._agent_description} Invoke this CrewAI Manager as a tool. Input: {{query: string, context?: object}}. Output: {{content, meta, stack}}.'
            if getattr(self.IGlobal.agent, '_agent_description', '')
            else (
                'Invoke this CrewAI Manager as a tool. Input: {query: string, context?: object}. Output: {content, meta, stack}.'
            )
        ),
    )
    def run_agent(self, input_obj: Any) -> Any:  # noqa: ANN401
        """Invoke this manager as a tool from a parent agent."""
        if not isinstance(input_obj, dict):
            raise ValueError('agent tool: input must be an object')

        query = input_obj.get('query')
        if not isinstance(query, str) or not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')

        ctx = input_obj.get('context')
        if ctx is not None and not isinstance(ctx, dict):
            raise ValueError('agent tool: input.context must be an object if provided')

        q = Question(role='')
        q.addQuestion(query)
        if ctx is not None:
            try:
                q.addContext(
                    json.dumps(
                        {'type': 'RocketRide.agent.tool_context.v1', 'context': ctx},
                        default=str,
                    )
                )
            except Exception:
                pass

        return self.IGlobal.agent.run_agent(self, q, emit_answers_lane=False)
