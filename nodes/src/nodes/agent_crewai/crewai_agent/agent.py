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
CrewAI Agent driver — standalone single-agent CrewAI Crew.

Builds a one-agent, one-task CrewAI Crew using the host's LLM and tool channels
and submits it to the process-wide kickoff runner. Cannot be used as a sub-agent
under a CrewAI Manager — that role is filled by `CrewSubagent`.
"""

from __future__ import annotations

from typing import Any

from rocketlib import debug

from ai.common.agent import AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question

from ..crewai_base import CrewBase


class CrewAgent(CrewBase):
    """Standalone single-agent CrewAI driver."""

    FRAMEWORK = 'crewai'

    def __init__(
        self,
        iGlobal: Any,
        *,
        process: Any = None,
        role: str = 'Assistant',
        task_description: str = '',
        goal: str = '',
        backstory: str = '',
        expected_output: str = '',
    ):
        """Initialise the driver with per-node config loaded from connConfig.

        All string fields default to empty; empty values fall back to the
        module-level ``_DEFAULT_*`` constants at run time.
        """
        super().__init__(iGlobal)
        self._process = process
        self._role = role
        self._task_description = task_description
        self._goal = goal
        self._backstory = backstory
        self._expected_output = expected_output

    def _run(
        self,
        *,
        context: AgentContext,
        question: Question,
    ) -> AgentRunResult:
        """Execute a single-agent CrewAI Crew and return the result text.

        Builds a one-agent, one-task Crew using the host's LLM and tool
        channels. If ``task_description`` is blank the incoming prompt is used
        as the task. All config fields fall back to ``_DEFAULT_*`` constants
        when empty.
        """
        debug('agent_crewai driver _run start run_id={}'.format(context.run_id))

        from crewai import Agent, Crew, Task

        tool_descriptors = context.tools.list
        llm = self._build_crew_llm(context, self._role)
        tools_for_agent = self._build_crew_tools(context, tool_descriptors)

        # Weave the agent's `instructions` config into the backstory.  Without
        # this, instructions loaded by AgentBase never reach CrewAI — Crew
        # only sees Agent(backstory=...) and Task(description=...).
        agent_backstory = self._merge_instructions(self._backstory or self._DEFAULT_BACKSTORY, self._instructions)

        agent_obj = Agent(
            role=self._role,
            goal=self._goal or self._DEFAULT_GOAL,
            backstory=agent_backstory,
            tools=tools_for_agent,
            llm=llm,
            verbose=False,
        )

        # Inject the user's chat prompt into the task description.  Mirrors the
        # pattern CrewManager already uses: if the node has no static
        # _task_description configured, the prompt becomes the task; if it does,
        # the prompt is appended as additional user context.  Without this, the
        # LLM never sees what the user typed and the agent responds with
        # "I haven't been told what the task is."
        prompt = self._safe_str(question.getPrompt())
        task_text = self._task_description or ''
        if not task_text:
            task_text = prompt or 'Complete the user request.'
        elif prompt:
            task_text = f'{task_text}\n\nUser request: {prompt}'

        desc = self._escape_braces(task_text)

        task_obj = Task(
            description=desc,
            expected_output=self._expected_output or self._DEFAULT_EXPECTED_OUTPUT,
            agent=agent_obj,
            markdown=False,
        )

        crew = Crew(agents=[agent_obj], tasks=[task_obj], process=self._process)

        self.sendSSE(context, 'thinking', message='Starting CrewAI agent...')

        # Submit the kickoff coroutine to the process-wide shared loop.  The
        # runner sets crewContext = context inside its wrapper task before
        # awaiting akickoff, which propagates through CrewAI's bus to our
        # persistent CrewListener so that every event from this kickoff routes
        # back to this run's invoker.  See crewai_runner.py for the design.
        result = self._iGlobal._kickoff_runner.submit(context, crew.akickoff())

        # Result extraction handles both CrewOutput (has .raw) and
        # CrewStreamingOutput (final answer at .result.raw).  Verified in
        # CrewAI 1.14.1 source.
        final_text = self._safe_str(getattr(result, 'raw', None)) or self._safe_str(getattr(getattr(result, 'result', None), 'raw', None)) or self._safe_str(result)
        return final_text, result
