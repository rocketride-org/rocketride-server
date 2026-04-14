# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
DeepAgent Subagent — IInstance for the managed sub-agent node.

Has no questions lane (services.subagent.json declares no ``input.questions``)
so ``writeQuestions`` is unreachable under the happy path — it raises
defensively if anything ever delivers a question here.

Exposes a single ``@invoke_function describe`` handler that the parent
DeepAgent orchestrator fans out to via the ``deepagent`` invoke channel.
Returns an ``IInvokeDeepagent.DescribeResponse`` appended to ``param.agents``.

Does NOT expose ``run_agent`` as a tool — Subagent's services.json classType
is ``["deepagent"]`` only (no ``"tool"``). Subagent is for composition under
an orchestrator, not for being invoked as a tool by other agents.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase, invoke_function
from ai.common.schema import Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        # Defense-in-depth. DeepAgent Subagent has no questions lane — the
        # engine should never reach this method through normal pipeline routing.
        raise RuntimeError('DeepAgent Subagent cannot be invoked directly; wire it into a DeepAgent via the deepagent channel.')

    @invoke_function
    def describe(self, param: Any) -> Any:  # noqa: ANN401
        """Handle the ``describe`` invoke op fanned out by a DeepAgent
        orchestrator on the ``deepagent`` channel.

        Builds an ``IInvokeDeepagent.DescribeResponse`` from the subagent driver
        and appends it to ``param.agents`` so the orchestrator can collect every
        connected sub-agent's descriptor in one fan-out call.
        """
        descriptor = self.IGlobal.agent.describe(self)
        existing = getattr(param, 'agents', None)
        if isinstance(existing, list):
            existing.append(descriptor)
            try:
                param.agents = existing
            except Exception:
                pass
            return param
        return [descriptor]
