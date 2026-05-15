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
DeepAgent Subagent driver — managed sub-agent under a DeepAgent orchestrator.

Provides ``describe()`` which the orchestrator fans out to via the
``describe`` invoke channel. The orchestrator uses the returned descriptor
to build a ``deepagents.middleware.subagents.SubAgent`` entry wired to this
sub-agent's own LLM/tool channels.

Cannot be invoked directly via a questions lane (the services.subagent.json
declares no questions lane) and cannot be called as a tool via
``tool.run_agent`` (classType excludes ``"tool"``).
"""

from __future__ import annotations

from typing import Any

from ai.common.agent import AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question

from ..deepagent import DeepAgentDriver


class DeepAgentSubagentDriver(DeepAgentDriver):
    """Managed DeepAgent sub-agent driver."""

    FRAMEWORK = 'deepagent_subagent'

    def describe(self, pSelf: Any) -> Any:
        """Return an ``IInvokeDeepagent.DescribeResponse`` for describe fan-out.

        Called by ``IInstance.describe`` when the orchestrator fans out
        ``describe`` on the ``deepagent`` lane. Stores the full ``pSelf``
        IInstance in ``invoke`` so the orchestrator can later construct
        ``AgentHostServices(d.invoke)`` for per-subagent LLM/tool routing.
        """
        from rocketlib.types import IInvokeDeepagent

        pipe_type = pSelf.instance.pipeType
        node_id = str(pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')) or ''

        return IInvokeDeepagent.DescribeResponse(
            name=node_id or str(self._iGlobal.glb.logicalType),
            description=self._description,
            system_prompt=self._system_prompt,
            instructions=list(self._instructions or []),
            node_id=node_id,
            invoke=pSelf,
        )

    def _run(self, *, context: AgentContext, question: Question) -> AgentRunResult:
        """Defense-in-depth: Subagent has no questions lane and cannot be run
        as a top-level pipeline agent. The services.subagent.json declares no
        ``questions`` lane, so this method is unreachable under the happy path.
        """
        raise NotImplementedError(
            'DeepAgent Subagent cannot be invoked directly; wire it into a DeepAgent via the deepagent channel.'
        )
