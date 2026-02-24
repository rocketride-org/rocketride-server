# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
CrewAI agent framework adapter for Aparavi Engine.

This node bridges CrewAI's multi-agent orchestration onto Aparavi's agent boundary:
- Input: `questions` lane (Question) -> AgentInput.prompt
- Execution: via host seams (host.llm.invoke + host.tools.invoke)
- Output: standardized AgentEnvelope on `answers` lane (handled by base class)
"""

from __future__ import annotations

from typing import Any, Dict

from aparavi import debug

from nodes.agent_base import (
    IInstanceGenericAgent,
    AgentInput,
    AgentHostServices,
    AgentRunResult,
)

from .host_llm import make_host_llm
from .host_tools import extract_tool_names, make_host_tools, query_tool_catalog


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''


class IInstance(IInstanceGenericAgent):
    """CrewAI-backed agent framework node."""

    FRAMEWORK = 'crewai'

    def _run_agent(
        self,
        *,
        agent_input: AgentInput,
        host: AgentHostServices,
        ctx: Dict[str, Any],
    ) -> AgentRunResult:
        run_id = ctx.get('run_id', '')
        debug(f'agent_crewai _run_agent start run_id={run_id} prompt_len={len(agent_input.prompt or "")}')

        instructions = _safe_str(getattr(getattr(self, 'IGlobal', None), 'instructions', '')).strip()

        from crewai import Agent, Crew, Task
        llm = make_host_llm(host=host)

        tool_catalog = query_tool_catalog(host=host)
        tools_to_use = extract_tool_names(tool_catalog)
        tools_for_agent = make_host_tools(
            host=host,
            tool_names=tools_to_use,
            log_tool_call=lambda **_: None,
        )

        agent_obj = Agent(
            role='Assistant',
            goal='Solve the user request using available tools when helpful.',
            backstory=(
                'You are an agent node in a tool-invocation hierarchy. '
                'You may call tools wired to you via the host tools interface. '
                'When a tool is needed, call it; otherwise respond directly. '
                'Follow any additional instructions exactly.'
            ),
            tools=tools_for_agent,
            llm=llm,
            verbose=False,
        )

        desc_parts = [
            'You are executing inside an agent pipeline.',
            'Use tools when needed (and only those available to you).',
            '',
            'User request:',
            _safe_str(agent_input.prompt or ''),
        ]
        if instructions:
            desc_parts.extend(['', 'Additional instructions:', instructions])
        desc = '\n'.join(desc_parts).strip()
        task_obj = Task(
            description=desc,
            expected_output='A helpful, accurate response.',
            agent=agent_obj,
            markdown=False,
        )

        process = getattr(getattr(self, 'IGlobal', None), 'process', None)
        crew = Crew(agents=[agent_obj], tasks=[task_obj], process=process)
        result = crew.kickoff(inputs={'input': agent_input.prompt or ''})

        # Extract final text.
        final_text = ''
        if hasattr(result, 'raw'):
            try:
                final_text = _safe_str(getattr(result, 'raw'))
            except Exception:
                final_text = ''
        if not final_text:
            final_text = _safe_str(result)

        return {
            'status': 'completed',
            'result': {'type': 'agent_output', 'data': final_text},
        }

