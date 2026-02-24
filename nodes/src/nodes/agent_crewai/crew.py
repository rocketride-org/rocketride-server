"""
CrewAI driver implementing the shared `ai.common.agent.AGENT` interface.

This module contains CrewAI-specific logic and is intended to be usable without
engine runtime objects (it receives config via __init__ and host services via calls).
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import debug

from ai.common.agent import Agent
from ai.common.agent.types import AgentInput, AgentRunResult
from ai.common.agent._internal.host import AgentHostServices

from .host_llm import make_host_llm
from .host_tools import extract_tool_names, make_host_tools, query_tool_catalog


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''


class CrewDriver(Agent):
    FRAMEWORK = 'crewai'

    def __init__(self, *, instructions: str = '', process: Any = None):
        """
        Initialize the CrewDriver.
        """
        self._instructions = _safe_str(instructions).strip()
        self._process = process

    def _run(
        self,
        *,
        agent_input: AgentInput,
        host: AgentHostServices,
        ctx: Dict[str, Any],
    ) -> AgentRunResult:
        run_id = ctx.get('run_id', '')
        debug('agent_crewai driver _run start run_id={} prompt_len={}'.format(run_id, len(agent_input.prompt or '')))

        from crewai import Agent, Crew, Task  # type: ignore

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
        if self._instructions:
            desc_parts.extend(['', 'Additional instructions:', self._instructions])
        desc = '\n'.join(desc_parts).strip()

        task_obj = Task(
            description=desc,
            expected_output='A helpful, accurate response.',
            agent=agent_obj,
            markdown=False,
        )

        crew = Crew(agents=[agent_obj], tasks=[task_obj], process=self._process)
        result = crew.kickoff(inputs={'input': agent_input.prompt or ''})

        final_text = ''
        if hasattr(result, 'raw'):
            try:
                final_text = _safe_str(getattr(result, 'raw'))
            except Exception:
                final_text = ''
        if not final_text:
            final_text = _safe_str(result)

        return {'status': 'completed', 'result': {'type': 'agent_output', 'data': final_text}}

