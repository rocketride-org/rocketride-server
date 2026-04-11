# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
LangChain agent framework node instance.

Receives questions on the questions lane and runs the LangChain agent loop.
Also exposes itself as a `run_agent` tool via `@tool_function` so this node
can be invoked by parent agents in the pipeline.
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
            f'This agent: {self.IGlobal.agent._agent_description} Invoke this agent as a tool. Input: {{query: string, context?: object}}. Output: {{content, meta, stack}}.'
            if getattr(self.IGlobal.agent, '_agent_description', '')
            else ('Invoke this agent as a tool. Input: {query: string, context?: object}. Output: {content, meta, stack}.')
        ),
    )
    def run_agent(self, input_obj: Any) -> Any:  # noqa: ANN401
        """Invoke this agent as a tool from a parent agent."""
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
