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
CrewAI Subagent driver — managed sub-agent under a CrewAI Manager.

Provides only `describe()`, which a CrewAI Manager fans out to via the
`describe` invoke channel. Has no `_run` of its own — the Manager
builds an `Agent + Task` from the descriptor and runs it inside its own
hierarchical Crew, routing LLM/tool calls back through this sub-agent's
own engine channels.

Cannot be invoked directly via the questions lane (the services.json has
no questions lane wired) and cannot be called as a tool via `tool.run_agent`
(classType excludes `"tool"`).
"""

from __future__ import annotations

from typing import Any

from ai.common.agent import AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question

from ..crewai_base import CrewBase


class CrewSubagent(CrewBase):
    """Managed CrewAI sub-agent driver."""

    FRAMEWORK = 'crewai_subagent'

    def __init__(
        self,
        iGlobal: Any,
        *,
        role: str = 'Specialist',
        task_description: str = '',
        goal: str = '',
        backstory: str = '',
        expected_output: str = '',
    ):
        """Initialise the sub-agent driver with per-node config loaded from connConfig.

        No `process` parameter — Subagent never builds its own Crew. The
        Manager that delegates to it builds the Agent + Task using the
        Manager's own Crew assembly.
        """
        super().__init__(iGlobal)
        self._role = role
        self._task_description = task_description
        self._goal = goal
        self._backstory = backstory
        self._expected_output = expected_output

    def describe(self, pSelf: Any) -> Any:
        """Return a DescribeResponse for describe fan-out.

        Called by IInstance.invoke() when the manager fans out describe.
        Stores the full pSelf IInstance in `invoke` so AgentHostServices(d.invoke)
        can call d.invoke.instance.* correctly from the manager's per-sub-agent
        binding loop.
        """
        from rocketlib.types import IInvokeCrew

        pipe_type = pSelf.instance.pipeType
        node_id = str(pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')) or ''
        return IInvokeCrew.DescribeResponse(
            role=self._role,
            task_description=self._task_description,
            goal=self._goal,
            backstory=self._backstory,
            expected_output=self._expected_output,
            instructions=list(self._instructions),
            node_id=node_id,
            invoke=pSelf,
        )

    def _run(
        self,
        *,
        context: AgentContext,
        question: Question,
    ) -> AgentRunResult:
        """Defense-in-depth: CrewSubagent has no questions lane and cannot be
        invoked directly. The crewai_subagent/services.json declares no
        `questions` lane, so this method is unreachable under the happy path.
        If anything ever reaches it, fail loud with an actionable message.
        """
        raise NotImplementedError(
            'CrewSubagent cannot be invoked directly; wire it into a CrewAI Manager via the crewai channel.'
        )
