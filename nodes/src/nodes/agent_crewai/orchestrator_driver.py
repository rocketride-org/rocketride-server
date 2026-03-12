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
CrewAI Orchestrator driver — builds a hierarchical Crew from connected sub-agent nodes.

Fans out `crewai.describe` to all nodes on the 'crewai' invoke channel, assembles
each into a CrewAI Agent + Task, and kicks off a hierarchical Crew with this node
acting as the manager.

Does NOT implement `describe()` — orchestrators cannot be used as sub-agents.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Union

from rocketlib import debug

from ai.common.agent import AgentBase
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from ai.common.tools import ToolsBase

from .crewai import _safe_str

_MGR_ROLE = 'Orchestrator'
_MGR_GOAL = 'Coordinate specialized sub-agents to fully solve the user request.'
_MGR_BACKSTORY = (
    'You are a senior orchestrator managing a team of specialized agents. '
    'Delegate tasks to the right agent and synthesize their outputs into a final answer.'
)
_DEFAULT_GOAL = 'Complete the assigned task using available tools.'
_DEFAULT_BACKSTORY = (
    'You are a specialized agent in a multi-agent pipeline. '
    'Use the tools available to you and complete your assigned task thoroughly.'
)
_DEFAULT_EXPECTED_OUTPUT = 'A thorough, accurate result for the assigned task.'


class OrchestratorDriver(AgentBase):
    FRAMEWORK = 'crewai_orchestrator'

    def __init__(self, iGlobal: Any):
        """
        Initialize the OrchestratorDriver.

        iGlobal is passed to AgentBase so it can load config/instructions.
        """
        super().__init__(iGlobal)
        # Stash for pSelf — needed in _run() to call pSelf.instance.invoke('crewai', ...).
        # Not thread-safe; safe because pipeline runs are sequential per node instance.
        self._current_pSelf: Any = None

    def run_agent(self, pSelf: Any, question: Any, *, emit_answers_lane: bool = True) -> Any:
        """
        Override to stash pSelf before delegating to AgentBase.run_agent().

        pSelf is needed inside _run() to fan out crewai.describe.
        """
        self._current_pSelf = pSelf
        try:
            return super().run_agent(pSelf, question, emit_answers_lane=emit_answers_lane)
        finally:
            self._current_pSelf = None

    def _bind_framework_llm(
        self,
        *,
        host: AgentHost,
        call_llm: Callable[..., str],
        ctx: Dict[str, Any],
    ) -> Any:

        from crewai import BaseLLM

        class HostInvokeLLM(BaseLLM):
            def __init__(self):
                super().__init__(model='RocketRide-host-llm', temperature=None)

            def call(
                self,
                messages: Union[str, List[Dict[str, str]]],
                tools: Optional[List[dict]] = None,
                callbacks: Optional[List[Any]] = None,
                available_functions: Optional[Dict[str, Any]] = None,
                **kwargs: Any,
            ) -> Union[str, Any]:
                stop_words = getattr(self, 'stop', None)
                return call_llm(messages, stop_words=stop_words)

        return HostInvokeLLM()

    def _bind_framework_tools(
        self,
        *,
        host: AgentHost,
        tool_descriptors: List[ToolsBase.ToolDescriptor],
        invoke_tool: Callable[..., Any],
        log_tool_call: Callable[..., None],
        ctx: Dict[str, Any],
    ) -> List[Any]:

        from crewai.tools import BaseTool
        from pydantic import BaseModel, ConfigDict, Field, create_model

        class _ToolInput(BaseModel):
            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
            if not isinstance(input_schema, dict):
                return _ToolInput
            props = input_schema.get('properties', {})
            if not props:
                return _ToolInput
            required_keys = set(input_schema.get('required', []))
            field_defs: Dict[str, Any] = {}
            for key, prop in props.items():
                desc = prop.get('description', '')
                if key in required_keys:
                    field_defs[key] = (Any, Field(..., description=desc))
                else:
                    default = prop.get('default', None)
                    field_defs[key] = (Any, Field(default=default, description=desc))
            try:
                return create_model(
                    '_DynToolInput',
                    __config__=ConfigDict(extra='allow'),
                    **field_defs,
                )
            except Exception:
                return _ToolInput

        class HostTool(BaseTool):
            name: str
            description: str
            args_schema: type[BaseModel] = _ToolInput

            def _run(self, input: Any = None, **kwargs: Any) -> str:
                try:
                    out = invoke_tool(self.name, input=input, kwargs=kwargs)
                except Exception as e:
                    out = {'error': str(e), 'type': type(e).__name__}

                try:
                    log_tool_call(tool_name=self.name, input={'input': input, **kwargs}, output=out)
                except Exception:
                    pass

                try:
                    return json.dumps(out, default=str) if isinstance(out, (dict, list)) else _safe_str(out)
                except Exception:
                    return _safe_str(out)

        tools = []
        for td in tool_descriptors:
            name = td.get('name', '') if isinstance(td, dict) else getattr(td, 'name', '')
            desc = td.get('description', '') if isinstance(td, dict) else getattr(td, 'description', '')
            if not name:
                continue
            if not desc:
                desc = f'Invoke host tool: {name}'
            input_schema = td.get('input_schema') if isinstance(td, dict) else None
            if isinstance(input_schema, dict):
                try:
                    schema_text = json.dumps(input_schema, ensure_ascii=False)
                except Exception:
                    schema_text = ''
                if schema_text:
                    desc = f'{desc}\n\nTool input schema (JSON): {schema_text}'

            schema_cls = _make_args_schema(input_schema)
            tools.append(HostTool(name=name, description=desc, args_schema=schema_cls))
        return tools

    def _run(
        self,
        *,
        agent_input: AgentInput,
        host: AgentHost,
        ctx: Dict[str, Any],
    ) -> AgentRunResult:
        from crewai import Agent, Crew, Process, Task
        from rocketlib.types import IInvokeCrew
        from ai.common.agent._internal.host import AgentHostServices
        from ai.common.agent._internal.utils import extract_prompt

        run_id = ctx.get('run_id', '')
        debug('agent_crewai_orchestrator _run start run_id={}'.format(run_id))

        pSelf = self._current_pSelf

        # 1. Fan-out crewai.describe to all connected sub-agents.
        req = IInvokeCrew.Describe()
        try:
            result = pSelf.instance.invoke('crewai', req)
        except Exception:
            result = req

        # Normalize: engine may return the mutated Describe object or a plain list.
        if hasattr(result, 'agents'):
            descriptors = result.agents or []
        elif isinstance(result, list):
            descriptors = result
        else:
            descriptors = []
        descriptors = [d for d in descriptors if d is not None]

        if not descriptors:
            raise RuntimeError('CrewAI Orchestrator: no sub-agents connected on the crewai channel')

        # 2. Build the manager's LLM (uses this orchestrator's own llm channel).
        def _mgr_call_llm(messages: Any, stop_words: Any = None, _h: AgentHost = host) -> str:
            return self._call_host_llm(
                host=_h,
                messages=messages,
                question_role=_MGR_ROLE,
                stop_words=stop_words,
            )

        manager_llm = self._bind_framework_llm(host=host, call_llm=_mgr_call_llm, ctx=ctx)

        # 3. Build per-sub-agent Agent + Task.
        # d.invoke is the sub-agent's full pSelf IInstance — AgentHostServices requires invoker.instance.*
        # Default-arg capture (_h, _d) prevents closure-in-loop bugs.
        prompt = extract_prompt(agent_input.question) if hasattr(agent_input, 'question') else ''

        sub_agents: List[Any] = []
        sub_tasks: List[Any] = []

        for d in descriptors:
            sub_host = AgentHostServices(d.invoke)

            def _sub_call_llm(
                messages: Any,
                stop_words: Any = None,
                _h: Any = sub_host,
                _role: str = d.role,
            ) -> str:
                return self._call_host_llm(
                    host=_h,
                    messages=messages,
                    question_role=_role,
                    stop_words=stop_words,
                )

            def _sub_invoke_tool(
                tool_name: str,
                input: Any = None,  # noqa: A002
                kwargs: Optional[Dict[str, Any]] = None,
                _h: Any = sub_host,
            ) -> Any:
                return self._invoke_host_tool(host=_h, tool_name=tool_name, input=input, kwargs=kwargs)

            sub_tool_descs = self._discover_tools(host=sub_host)
            sub_llm = self._bind_framework_llm(host=sub_host, call_llm=_sub_call_llm, ctx=ctx)
            sub_tools = self._bind_framework_tools(
                host=sub_host,
                tool_descriptors=sub_tool_descs,
                invoke_tool=_sub_invoke_tool,
                log_tool_call=lambda **_: None,
                ctx=ctx,
            )

            agent_obj = Agent(
                role=d.role,
                goal=_DEFAULT_GOAL,
                backstory=_DEFAULT_BACKSTORY,
                tools=sub_tools,
                llm=sub_llm,
                verbose=False,
            )

            task_text = d.task_description or prompt or ''
            task_desc = task_text.replace('{', '{{').replace('}', '}}')

            task_obj = Task(
                description=task_desc or 'Complete the user request.',
                expected_output=_DEFAULT_EXPECTED_OUTPUT,
                agent=agent_obj,
                async_execution=True,
            )

            sub_agents.append(agent_obj)
            sub_tasks.append(task_obj)

        # 4. Build manager agent tools — exclude any tool whose name starts with a sub-agent's
        #    node_id prefix (defensive filter: prevents sub-agents accidentally wired to both
        #    'crewai' and 'tool' channels from appearing as callable tools for the manager).
        sub_agent_prefixes = {f'{d.node_id}.' for d in descriptors if d.node_id}
        all_mgr_tool_descs = self._discover_tools(host=host)

        def _is_sub_agent_tool(td: Any) -> bool:
            name = td.get('name', '') if isinstance(td, dict) else getattr(td, 'name', '')
            return any(name.startswith(p) for p in sub_agent_prefixes)

        mgr_tool_descs = [t for t in all_mgr_tool_descs if not _is_sub_agent_tool(t)]

        def _mgr_invoke_tool(
            tool_name: str,
            input: Any = None,  # noqa: A002
            kwargs: Optional[Dict[str, Any]] = None,
        ) -> Any:
            return self._invoke_host_tool(host=host, tool_name=tool_name, input=input, kwargs=kwargs)

        mgr_tools = self._bind_framework_tools(
            host=host,
            tool_descriptors=mgr_tool_descs,
            invoke_tool=_mgr_invoke_tool,
            log_tool_call=lambda **_: None,
            ctx=ctx,
        )

        manager_agent = Agent(
            role=_MGR_ROLE,
            goal=_MGR_GOAL,
            backstory=_MGR_BACKSTORY,
            tools=mgr_tools,
            llm=manager_llm,
            verbose=False,
            allow_delegation=True,
        )

        # 5. Assemble and kick off the hierarchical Crew.
        crew = Crew(
            agents=[manager_agent] + sub_agents,
            tasks=sub_tasks,
            process=Process.hierarchical,
            manager_agent=manager_agent,
            verbose=False,
        )

        debug('agent_crewai_orchestrator kicking off crew with {} sub-agents run_id={}'.format(len(sub_agents), run_id))
        result = crew.kickoff()

        final_text = _safe_str(getattr(result, 'raw', None)) or _safe_str(result)
        return final_text, result
