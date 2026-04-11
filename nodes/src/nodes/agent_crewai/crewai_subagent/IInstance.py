# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Subagent — IInstance for the managed sub-agent CrewAI node.

Has no questions lane (the services.json declares no `input.questions`)
so `writeQuestions` is unreachable under the happy path — it raises
defensively if anything ever delivers a question here.

Exposes a single `@invoke_function describe` handler that the parent
CrewAI Manager fans out to via the `crewai` invoke channel.  Returns a
`IInvokeCrew.DescribeResponse` and appends to `param.agents`.

Does NOT expose `run_agent` as a tool — Subagent's services.json
classType is `["crewai"]` only (no `"tool"`).  Subagent is for
composition under a Manager, not for being invoked as a tool by other
agents.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase, debug, invoke_function
from ai.common.schema import Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question):
        # Defense-in-depth.  CrewSubagent has no questions lane — the engine
        # should never reach this method through normal pipeline routing.
        raise RuntimeError('CrewAI Subagent cannot be invoked directly; wire it into a CrewAI Manager via the crewai channel.')

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        """DEBUG: log every invoke that reaches the Subagent IInstance, then
        delegate to the base class @invoke_function dispatch.
        """
        op = getattr(param, 'op', None) if param is not None else None
        debug('crewai_subagent IInstance.invoke called: param_type={} op={!r}'.format(type(param).__name__, op))
        try:
            result = super().invoke(param)
            debug('crewai_subagent IInstance.invoke completed: op={!r} result_type={}'.format(op, type(result).__name__))
            return result
        except Exception as e:
            debug('crewai_subagent IInstance.invoke raised: op={!r} exc_type={} msg={}'.format(op, type(e).__name__, str(e)))
            raise

    @invoke_function
    def describe(self, param: Any) -> Any:  # noqa: ANN401
        """
        Handle the `describe` invoke op fanned out by a CrewAI Manager
        on the `crewai` channel.

        Builds an `IInvokeCrew.DescribeResponse` from the `CrewSubagent`
        driver and appends it to `param.agents` so the Manager can collect
        every connected sub-agent's descriptor in one fan-out call.
        """
        debug(
            'crewai_subagent describe() ENTRY: param_type={} param.agents type={} initial_len={}'.format(
                type(param).__name__,
                type(getattr(param, 'agents', None)).__name__,
                len(getattr(param, 'agents', []) or []),
            )
        )
        descriptor = self.IGlobal.agent.describe(self)
        debug(
            'crewai_subagent describe() built descriptor: type={} role={!r}'.format(
                type(descriptor).__name__,
                getattr(descriptor, 'role', None),
            )
        )
        existing = getattr(param, 'agents', None)
        if isinstance(existing, list):
            existing.append(descriptor)
            try:
                param.agents = existing
            except Exception as e:
                debug('crewai_subagent describe() setattr param.agents failed: {}'.format(e))
            debug('crewai_subagent describe() EXIT (mutated): param.agents now has {} entries, returning param'.format(len(existing)))
            return param
        debug('crewai_subagent describe() EXIT (fallback): param.agents was {}, returning [descriptor]'.format(type(existing).__name__))
        return [descriptor]
