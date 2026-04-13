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

"""Deep Agent node instance — bridges the RocketRide engine to ``DeepAgentDriver``."""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase
from ai.common.schema import Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Per-instance handler for the Deep Agent node.

    Receives pipeline questions via ``writeQuestions`` and forwards them to
    ``DeepAgentDriver.run_agent``.  Also handles hierarchical ``tool.*`` invoke
    operations so this node can be used as a tool inside another agent.
    """

    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        """
        Process an incoming pipeline question by running the deep agent.

        Delegates execution to ``DeepAgentDriver.run_agent``, which writes a single
        JSON answer to the ``answers`` lane on completion.

        Args:
            question: The ``Question`` object from the pipeline lane.

        Returns:
            None
        """
        self.IGlobal.agent.run_agent(self, question, emit_answers_lane=True)

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        """
        Handle a control-plane invocation on this node instance.

        Intercepts ``tool.*`` operations so the node can be composed as a tool inside
        a parent agent.  Intercepts ``deepagent.describe`` so this node can register
        itself as a sub-agent with a DeepAgent orchestrator.  All other operations are
        forwarded to the base-class handler.

        Args:
            param: Invocation parameter dict (with an ``op`` key) or an object with
                an ``op`` attribute.

        Returns:
            The result of ``DeepAgentDriver.handle_invoke`` for ``tool.*`` ops, or the
            base-class ``invoke`` result otherwise.
        """
        op = param.get('op') if isinstance(param, dict) else getattr(param, 'op', None)
        if isinstance(op, str) and op.startswith('tool.'):
            return self.IGlobal.agent.handle_invoke(self, param)
        if isinstance(op, str) and op == 'deepagent.describe':
            self._handle_deepagent_describe(param)
            return
        return super().invoke(param)

    def _handle_deepagent_describe(self, param: Any) -> None:
        """
        Respond to a ``deepagent.describe`` fan-out from an orchestrator.

        Reads resolved config from the driver (set at init time) and appends a
        ``DescribeResponse`` to ``param.agents`` so the orchestrator can build a
        ``SubAgent`` entry.

        Args:
            param: An ``IInvokeDeepagent.Describe`` instance whose ``agents`` list
                is populated in-place.

        Returns:
            None
        """
        from rocketlib.types import IInvokeDeepagent

        driver = self.IGlobal.agent

        pipe_type = self.instance.pipeType
        node_id = str(pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')) or ''

        # Use driver attributes resolved at init time
        name = node_id or str(self.IGlobal.glb.logicalType)
        description = getattr(driver, '_description', '') or ''
        system_prompt = getattr(driver, '_system_prompt', '') or ''
        instructions = list(getattr(driver, '_instructions', []) or [])

        param.agents.append(
            IInvokeDeepagent.DescribeResponse(
                name=name,
                description=description,
                system_prompt=system_prompt,
                instructions=instructions,
                node_id=node_id,
                invoke=self,
            )
        )
