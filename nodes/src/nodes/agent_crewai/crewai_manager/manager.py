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
CrewAI Manager driver — hierarchical multi-agent Crew.

Fans out `describe` to all connected `crewai` channel nodes (CrewSubagent
nodes), assembles each into a CrewAI Agent + Task, and kicks off a hierarchical
Crew with this node acting as the manager.

Inherits from `CrewBase` (and therefore from `AgentBase`) but deliberately has
no `describe()` method — managers cannot be used as sub-agents under another
Manager. Cross-Manager nesting is supported via `tool.run_agent` (the agent-as-
tool path), not via the `crewai` channel.
"""

from __future__ import annotations

import json
from typing import Any, List

from rocketlib import debug

from ai.common.agent import AgentContext
from ai.common.agent._internal.host import AgentHostServices
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question

from ..crewai_base import CrewBase


def _strip_react_preamble(text: str) -> str:
    """Strip the ReAct Thought/Action/Action Input preamble from a task output.

    In hierarchical mode CrewAI often returns the full agent trajectory rather
    than just the final answer.  This function extracts the clean payload by
    trying (in order):

    1. Everything after the last ``Final Answer:`` marker.
    2. The last top-level JSON block (``\\n{`` … end), which is typically the
       tool's return value when the agent ends on a tool call observation.
    3. ``''`` — if the text looks like a ReAct trace but neither marker is
       found, returns empty so the caller can try the next task output or
       surface a clean error rather than leaking raw trace text.

    Non-ReAct text (no Thought/Action/Observation markers) is returned as-is.
    """
    if not text:
        return text
    # 1. Strip to last "Final Answer:" if present.
    fa_marker = 'Final Answer:'
    if fa_marker in text:
        return text[text.rfind(fa_marker) + len(fa_marker) :].strip()
    # 2. Extract last JSON block — covers the case where the agent ends with a
    #    tool observation (no Final Answer written).  Only apply when the text
    #    looks like a ReAct trace; otherwise clean output (e.g. ```chartjs
    #    fences) would have their prefix incorrectly stripped.
    #
    #    Require the trailing JSON to extend to end-of-text (last non-whitespace
    #    char is `}` or `]`).  Without this guard, an intermediate Observation
    #    containing JSON followed by more Thought/Action lines would match via
    #    rfind('\n{') even though the true final answer is later free text.
    react_markers = ('Thought:', 'Action:', 'Observation:')
    if any(m in text for m in react_markers):
        tail = text.rstrip()
        if tail.endswith('}') or tail.endswith(']'):
            # Collect all positions where { or [ opens at the start of a line,
            # then walk right-to-left: the rightmost slice that round-trips
            # through json.loads is the last complete tool-output block.
            # rfind('\n{') alone would cut into the middle of a pretty-printed
            # nested object whose inner braces also start on their own lines.
            candidates = [i for i, ch in enumerate(text) if ch in ('{', '[') and (i == 0 or text[i - 1] == '\n')]
            for start in reversed(candidates):
                slice_ = text[start:].strip()
                try:
                    json.loads(slice_)
                    return slice_
                except (json.JSONDecodeError, ValueError):
                    continue
        # 3. Inline ReAct trace (no newlines between Thought/Action/Action Input),
        #    or trailing non-JSON free text we can't safely slice.  Return empty
        #    so the caller can fall back to other task outputs or surface a
        #    clean error.
        return ''
    return text


_MGR_ROLE = 'Manager'
_MGR_GOAL = 'Coordinate the team to complete the user request. Delegate to the appropriate agents and synthesize their outputs into a final answer.'
_MGR_BACKSTORY = 'You are a senior manager coordinating a team of specialized agents. Delegate tasks to the right agent and synthesize their outputs into a final answer.'


class CrewManager(CrewBase):
    """Hierarchical multi-agent CrewAI Crew.

    Fans out `describe` to all nodes on the 'crewai' invoke channel,
    assembles each into a CrewAI Agent + Task, and kicks off a hierarchical
    Crew with this node acting as the manager.

    Inherits from `CrewBase` so it gets `_build_crew_llm` / `_build_crew_tools`,
    but deliberately has no `describe()` method — the manager cannot itself be
    used as a sub-agent.
    """

    FRAMEWORK = 'crewai_manager'

    def __init__(self, iGlobal: Any):
        """Initialise the manager driver.

        Stores a reference to iGlobal for accessing expert config fields at
        run time.  No per-call state is held on `self` -- the engine invoker
        and host services flow through `context` in `_run`.
        """
        super().__init__(iGlobal)
        self._iGlobal = iGlobal

    def _run(
        self,
        *,
        context: AgentContext,
        question: Question,
    ) -> AgentRunResult:
        """Fan out describe to all connected sub-agents and run a hierarchical Crew.

        Steps:
          1. Collect descriptors from each sub-agent node via per-node describe invoke.
          2. Build a CrewAI Agent + Task per descriptor, routing LLM/tool calls back through
             each sub-agent's own engine channels.
          3. Build the manager agent using this node's LLM channel and expert config.
          4. Kick off a hierarchical Crew and return the synthesised result.
        """
        from crewai import Agent, Crew, Process, Task
        from rocketlib.types import IInvokeCrew

        pSelf = context.invoker
        prompt = self._safe_str(question.getPrompt())
        debug('agent_crewai_manager _run start run_id={} prompt_len={}'.format(context.run_id, len(prompt)))

        # 1. Discover all connected sub-agents via per-node invoke (mirrors the tool
        #    discovery pattern in AgentHostServices.Tools.__init__).
        #    A no-nodeId invoke stops at the first successful handler, so we iterate
        #    each crewai node individually with nodeId= to reach all of them.
        crewai_node_ids = pSelf.instance.getControllerNodeIds('crewai')
        debug(
            'crewai_manager fan-out: getControllerNodeIds("crewai") returned {} ids: {!r}'.format(
                len(crewai_node_ids or []), crewai_node_ids
            )
        )
        if not crewai_node_ids:
            raise RuntimeError('CrewAI Manager: no sub-agents connected on the crewai channel')

        descriptors = []
        for node_id in crewai_node_ids:
            req = IInvokeCrew.Describe()
            debug(
                'crewai_manager invoking node_id={!r} with req.op={!r} initial req.agents type={} len={}'.format(
                    node_id,
                    req.op,
                    type(req.agents).__name__,
                    len(req.agents or []),
                )
            )
            try:
                pSelf.instance.invoke(req, component_id=node_id)
                debug(
                    'crewai_manager invoke returned for node_id={!r}: req.agents type={} len={}'.format(
                        node_id,
                        type(req.agents).__name__,
                        len(req.agents or []),
                    )
                )
            except Exception as e:
                debug('crewai_manager invoke RAISED for node_id={!r}: {}: {}'.format(node_id, type(e).__name__, e))
            for agent_desc in req.agents:
                if agent_desc is not None:
                    descriptors.append(agent_desc)

        debug('crewai_manager fan-out complete: collected {} descriptors total'.format(len(descriptors)))

        if not descriptors:
            raise RuntimeError('CrewAI Manager: no sub-agents responded to the describe fan-out')

        # 2. Build the manager's LLM (uses this node's own llm channel).
        manager_llm = self._build_crew_llm(context, _MGR_ROLE)

        # 3. Build per-sub-agent Agent + Task.
        # d.invoke is the sub-agent's full pSelf IInstance.
        # Each sub-agent gets its own AgentContext built from a fresh
        # AgentHostServices(d.invoke).  The sub-context inherits run
        # metadata (run_id, pipe_id, framework, started_at) from the
        # parent so all SSE events from sub-agent kickoffs route back to
        # the same logical run.
        sub_agents: List[Any] = []
        sub_tasks: List[Any] = []

        for d in descriptors:
            sub_host = AgentHostServices(d.invoke)
            sub_context = AgentContext(
                invoker=d.invoke,
                llm=sub_host.llm,
                tools=sub_host.tools,
                memory=sub_host.memory,
                run_id=context.run_id,
                pipe_id=context.pipe_id,
                framework=context.framework,
                started_at=context.started_at,
            )

            sub_tool_descs = sub_context.tools.list
            sub_llm = self._build_crew_llm(sub_context, d.role)
            sub_tools = self._build_crew_tools(sub_context, sub_tool_descs)

            sub_backstory = self._merge_instructions(d.backstory or self._DEFAULT_BACKSTORY, d.instructions)

            agent_obj = Agent(
                role=d.role,
                goal=d.goal or self._DEFAULT_GOAL,
                backstory=sub_backstory,
                tools=sub_tools,
                llm=sub_llm,
                verbose=False,
                max_iter=5,
                allow_delegation=False,
            )

            task_text = d.task_description or ''
            if not task_text:
                task_text = prompt or 'Complete the user request.'
            elif prompt:
                task_text = f'{task_text}\n\nUser request: {prompt}'
            task_desc = self._escape_braces(task_text)

            # No implicit inter-task context wiring.  In hierarchical mode the
            # manager agent decides what to pass to each delegate via its
            # delegation message
            task_obj = Task(
                description=task_desc,
                expected_output=d.expected_output or self._DEFAULT_EXPECTED_OUTPUT,
                agent=agent_obj,
                context=[],
            )

            sub_agents.append(agent_obj)
            sub_tasks.append(task_obj)

        # 4. Build manager agent. The user's prompt goes into backstory (background context)
        #    rather than the goal so it doesn't drive active reasoning on every LLM call.
        #    The goal stays generic: delegate once, return the result.
        #    The manager's `instructions` config field is also woven into the backstory
        #    here — otherwise it would be loaded by AgentBase but never reach CrewAI.
        ig = self._iGlobal
        base_backstory = self._merge_instructions(ig.backstory or _MGR_BACKSTORY, self._instructions)
        if prompt:
            escaped_prompt = self._escape_braces(prompt)
            manager_backstory = f'{base_backstory}\n\nBackground context — user request: {escaped_prompt}'
        else:
            manager_backstory = base_backstory

        manager_agent = Agent(
            role=_MGR_ROLE,
            goal=ig.goal or _MGR_GOAL,
            backstory=manager_backstory,
            llm=manager_llm,
            verbose=False,
            allow_delegation=True,
            max_iter=5,
        )

        # 5. Assemble and kick off the hierarchical Crew.
        crew = Crew(
            agents=sub_agents,
            tasks=sub_tasks,
            process=Process.hierarchical,
            manager_agent=manager_agent,
            planning=True,
            planning_llm=manager_llm,
            verbose=False,
        )

        debug(
            'agent_crewai_manager kicking off crew with {} sub-agents run_id={}'.format(len(sub_agents), context.run_id)
        )

        # Submit the kickoff coroutine to the process-wide shared loop -- same
        # pattern as CrewAgent._run.  See crewai_runner.py for why this is the
        # required scope (CrewAI's singletons are process-wide, so the loop
        # serializing access to them must be process-wide too).
        result = self._iGlobal._kickoff_runner.submit(
            context, crew.akickoff(inputs={'user_request': prompt} if prompt else {})
        )

        # Result extraction: prefer the last completed task's output (clean result)
        # over result.raw, which in hierarchical mode contains the full manager
        # ReAct trace (all delegations + observations concatenated).
        tasks_out = getattr(result, 'tasks_output', None) or []
        final_text = ''
        for task_out in reversed(tasks_out):
            candidate = self._safe_str(getattr(task_out, 'raw', None))
            if not candidate:
                continue
            stripped = _strip_react_preamble(candidate)
            if stripped:
                final_text = stripped
                break

        if not final_text:
            # Fall back to result.raw with the same ReAct stripping.
            raw = (
                self._safe_str(getattr(result, 'raw', None))
                or self._safe_str(getattr(getattr(result, 'result', None), 'raw', None))
                or self._safe_str(result)
            )
            final_text = _strip_react_preamble(raw)

        return final_text, result
