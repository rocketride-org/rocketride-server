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
CrewAI drivers implementing the shared `ai.common.agent.AGENT` interface.

Contains:
  - CrewAgentBase: shared LLM/tool-binding logic
  - CrewDriver:    sub-agent mode / standalone single-agent Crew
  - ManagerDriver: hierarchical multi-agent Crew
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Union

from rocketlib import debug

from ai.common.agent import AgentBase
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from rocketlib import ToolDescriptor


# ── Shared utilities ──────────────────────────────────────────────────────────


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''


def _escape_braces(text: str) -> str:
    """Escape curly braces so CrewAI doesn't treat them as template variables."""
    return text.replace('{', '{{').replace('}', '}}')


_DEFAULT_GOAL = 'Complete the assigned task to the best of your ability.'
_DEFAULT_BACKSTORY = 'You are a specialized agent in a multi-agent pipeline with access to tools. Use your tools and reasoning to complete tasks effectively.'
_DEFAULT_EXPECTED_OUTPUT = 'A clear, direct answer to the assigned task.'


# ── CrewAgentBase ─────────────────────────────────────────────────────────────


class CrewAgentBase(AgentBase):
    """Shared base for CrewDriver and ManagerDriver."""

    def _bind_framework_llm(
        self,
        *,
        host: AgentHost,
        call_llm_text: Callable[..., str],
        ctx: Dict[str, Any],
    ) -> Any:
        """Wrap the host LLM channel as a CrewAI-compatible BaseLLM instance.

        The returned HostInvokeLLM delegates all calls back through
        ``call_llm_text``, which routes to the engine's llm invoke channel.
        """
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
                return call_llm_text(messages, stop_words=stop_words)

        return HostInvokeLLM()

    def _bind_framework_tools(
        self,
        *,
        host: AgentHost,
        tool_descriptors: List[ToolDescriptor],
        invoke_tool: Callable[..., Any],
        ctx: Dict[str, Any],
    ) -> List[Any]:
        """Convert host tool descriptors into CrewAI BaseTool instances.

        Each tool's JSON Schema is embedded in the description so CrewAI can
        pass structured arguments. A dynamic Pydantic args_schema is built per
        tool to preserve real parameter names through CrewAI's argument filter.
        """
        from crewai.tools import BaseTool
        from pydantic import BaseModel, ConfigDict, Field, create_model

        class _ToolInput(BaseModel):
            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
            """
            Build a dynamic Pydantic model from a JSON Schema so that
            CrewAI's argument filter preserves real tool parameters.
            """
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
                    __config__=ConfigDict(extra='ignore'),
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
            input_schema = td.get('inputSchema') if isinstance(td, dict) else None
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


# ── CrewDriver ────────────────────────────────────────────────────────────────


class CrewDriver(CrewAgentBase):
    """Sub-agent mode / standalone single-agent Crew."""

    FRAMEWORK = 'crewai'

    def __init__(self, iGlobal: Any, *, process: Any = None, role: str = 'Assistant', task_description: str = '', goal: str = '', backstory: str = '', expected_output: str = ''):
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

    def describe(self, pSelf: Any) -> Any:
        """Return a DescribeResponse for crewai.describe fan-out.

        Called by IInstance.invoke() when the manager fans out crewai.describe.
        Stores the full pSelf IInstance in `invoke` so AgentHostServices(d.invoke)
        can call d.invoke.instance.* correctly.
        """
        from rocketlib.types import IInvokeCrew

        pipe_type = pSelf.instance.pipeType
        node_id = str(pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')) or ''
        return IInvokeCrew.DescribeResponse(
            role=self._role,
            task_description=self._task_description,
            node_id=node_id,
            invoke=pSelf,
        )

    def _run(
        self,
        *,
        agent_input: AgentInput,
        host: AgentHost,
        ctx: Dict[str, Any],
    ) -> AgentRunResult:
        """Execute a single-agent CrewAI Crew and return the result text.

        Builds a one-agent, one-task Crew using the host's LLM and tool
        channels. If ``task_description`` is blank the incoming prompt is used
        as the task. All config fields fall back to ``_DEFAULT_*`` constants
        when empty.
        """
        run_id = ctx.get('run_id', '')
        debug('agent_crewai driver _run start run_id={}'.format(run_id))

        from crewai import Agent, Crew, Task

        tool_descriptors = self.discover_tools(host=host)

        def _call_llm_text(messages: Any, stop_words: Any = None) -> str:
            return self.call_host_llm(
                host=host,
                messages=messages,
                question_role=self._role,
                stop_words=stop_words,
            )

        def _invoke_tool(tool_name: str, input: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:  # noqa: A002
            return self.invoke_host_tool(host=host, tool_name=tool_name, input=input, kwargs=kwargs)

        llm = self._bind_framework_llm(host=host, call_llm_text=_call_llm_text, ctx=ctx)
        tools_for_agent = self._bind_framework_tools(
            host=host,
            tool_descriptors=tool_descriptors,
            invoke_tool=_invoke_tool,
            ctx=ctx,
        )

        agent_obj = Agent(
            role=self._role,
            goal=self._goal or _DEFAULT_GOAL,
            backstory=self._backstory or _DEFAULT_BACKSTORY,
            tools=tools_for_agent,
            llm=llm,
            verbose=False,
        )

        task_text = self._task_description or ''

        desc = _escape_braces(task_text)

        task_obj = Task(
            description=desc or 'Complete the user request.',
            expected_output=self._expected_output or _DEFAULT_EXPECTED_OUTPUT,
            agent=agent_obj,
            markdown=False,
        )

        crew = Crew(agents=[agent_obj], tasks=[task_obj], process=self._process)

        from crewai.events.base_events import BaseEvent
        from crewai.events.event_bus import crewai_event_bus
        from crewai.events.types.llm_events import LLMStreamChunkEvent
        from crewai.events.types.logging_events import AgentLogsExecutionEvent, AgentLogsStartedEvent

        _SKIP_EVENT_TYPES = {LLMStreamChunkEvent, AgentLogsStartedEvent, AgentLogsExecutionEvent}

        _EVENT_LABELS: Dict[str, str] = {
            'crew_kickoff_started': 'Crew started',
            'crew_kickoff_completed': 'Crew completed',
            'crew_kickoff_failed': 'Crew failed',
            'task_started': 'Task started',
            'task_completed': 'Task completed',
            'task_failed': 'Task failed',
            'agent_execution_started': 'Agent thinking...',
            'agent_execution_completed': 'Agent done',
            'agent_execution_error': 'Agent error',
            'tool_usage_finished': 'Tool complete',
            'tool_usage_error': 'Tool error',
            'tool_execution_error': 'Tool execution error',
            'tool_selection_error': 'Tool selection error',
            'tool_validate_input_error': 'Tool input error',
            'llm_call_started': 'LLM call started',
            'llm_call_completed': 'LLM call completed',
            'llm_call_failed': 'LLM call failed',
        }

        self.sendSSE('thinking', message='Starting CrewAI agent...')

        def _all_event_types(base):
            result = []
            for cls in base.__subclasses__():
                result.append(cls)
                result.extend(_all_event_types(cls))
            return result

        def _on_any_event(source, event):
            if event.type == 'tool_usage_started':
                tool_name = getattr(event, 'tool_name', '') or 'tool'
                message = f'Calling {tool_name}...'
            else:
                message = _EVENT_LABELS.get(event.type) or event.type.replace('_', ' ').capitalize()
            try:
                data = event.to_json(exclude={'timestamp', 'source_fingerprint', 'fingerprint_metadata', 'source_type'})
            except Exception:
                data = None
            self.sendSSE('thinking', message=message, **(data or {}))

        with crewai_event_bus.scoped_handlers():
            for event_cls in _all_event_types(BaseEvent):
                if event_cls in _SKIP_EVENT_TYPES:
                    continue
                crewai_event_bus.register_handler(event_cls, _on_any_event)

            result = crew.kickoff()

        final_text = _safe_str(getattr(result, 'raw', None)) or _safe_str(result)
        return final_text, result


# ── ManagerDriver ─────────────────────────────────────────────────────────────

_MGR_ROLE = 'Manager'
_MGR_GOAL = 'Coordinate the team to complete the user request. Delegate to the appropriate agents and synthesize their outputs into a final answer.'
_MGR_BACKSTORY = 'You are a senior manager coordinating a team of specialized agents. Delegate tasks to the right agent and synthesize their outputs into a final answer.'


class ManagerDriver(CrewAgentBase):
    """Hierarchical multi-agent Crew.

    Fans out `crewai.describe` to all nodes on the 'crewai' invoke channel,
    assembles each into a CrewAI Agent + Task, and kicks off a hierarchical
    Crew with this node acting as the manager.

    Does NOT implement `describe()` — the manager cannot be used as a sub-agent.
    """

    FRAMEWORK = 'crewai_manager'

    def __init__(self, iGlobal: Any):
        """Initialise the manager driver.

        Stores a reference to iGlobal for accessing expert config fields at
        run time, and initialises the pSelf stash used to capture the engine
        context across the run_agent → _run call boundary.
        """
        super().__init__(iGlobal)
        self._iGlobal = iGlobal
        # Stash for pSelf — needed in _run() to call pSelf.instance.invoke('crewai', ...).
        # Not thread-safe; safe because pipeline runs are sequential per node instance.
        self._current_pSelf: Any = None

    def run_agent(self, pSelf: Any, question: Any, *, emit_answers_lane: bool = True) -> Any:
        """Override to stash pSelf before delegating to AgentBase.run_agent()."""
        self._current_pSelf = pSelf
        try:
            return super().run_agent(pSelf, question, emit_answers_lane=emit_answers_lane)
        finally:
            self._current_pSelf = None

    def _run(
        self,
        *,
        agent_input: AgentInput,
        host: AgentHost,
        ctx: Dict[str, Any],
    ) -> AgentRunResult:
        """Fan out crewai.describe to all connected sub-agents and run a hierarchical Crew.

        Steps:
          1. Collect descriptors from each sub-agent node via per-node crewai.describe invoke.
          2. Build a CrewAI Agent + Task per descriptor, routing LLM/tool calls back through
             each sub-agent's own engine channels.
          3. Build the manager agent using this node's LLM channel and expert config.
          4. Kick off a hierarchical Crew and return the synthesised result.
        """
        from crewai import Agent, Crew, Process, Task
        from rocketlib.types import IInvokeCrew
        from ai.common.agent._internal.host import AgentHostServices

        run_id = ctx.get('run_id', '')
        prompt = _safe_str(agent_input.question.getPrompt() if hasattr(agent_input, 'question') else '')
        debug('agent_crewai_manager _run start run_id={} prompt_len={}'.format(run_id, len(prompt)))

        pSelf = self._current_pSelf

        # 1. Discover all connected sub-agents via per-node invoke (mirrors the tool
        #    discovery pattern in AgentHostServices.Tools.__init__).
        #    A no-nodeId invoke stops at the first successful handler, so we iterate
        #    each crewai node individually with nodeId= to reach all of them.
        crewai_node_ids = pSelf.instance.getControllerNodeIds('crewai')
        if not crewai_node_ids:
            raise RuntimeError('CrewAI Manager: no sub-agents connected on the crewai channel')

        descriptors = []
        for node_id in crewai_node_ids:
            req = IInvokeCrew.Describe()
            try:
                pSelf.instance.invoke('crewai', req, nodeId=node_id)
            except Exception:
                pass
            for agent_desc in req.agents:
                if agent_desc is not None:
                    descriptors.append(agent_desc)

        if not descriptors:
            raise RuntimeError('CrewAI Manager: no sub-agents responded to crewai.describe')

        # 2. Build the manager's LLM (uses this node's own llm channel).
        def _mgr_call_llm_text(messages: Any, stop_words: Any = None, _h: AgentHost = host) -> str:
            return self.call_host_llm(
                host=_h,
                messages=messages,
                question_role=_MGR_ROLE,
                stop_words=stop_words,
            )

        manager_llm = self._bind_framework_llm(host=host, call_llm_text=_mgr_call_llm_text, ctx=ctx)

        # 3. Build per-sub-agent Agent + Task.
        # d.invoke is the sub-agent's full pSelf IInstance.
        # Default-arg capture (_h, _role) prevents closure-in-loop bugs.
        sub_agents: List[Any] = []
        sub_tasks: List[Any] = []

        for d in descriptors:
            sub_host = AgentHostServices(d.invoke)

            def _sub_call_llm_text(
                messages: Any,
                stop_words: Any = None,
                _h: Any = sub_host,
                _role: str = d.role,
            ) -> str:
                return self.call_host_llm(
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
                return self.invoke_host_tool(host=_h, tool_name=tool_name, input=input, kwargs=kwargs)

            sub_tool_descs = self.discover_tools(host=sub_host)
            sub_llm = self._bind_framework_llm(host=sub_host, call_llm_text=_sub_call_llm_text, ctx=ctx)
            sub_tools = self._bind_framework_tools(
                host=sub_host,
                tool_descriptors=sub_tool_descs,
                invoke_tool=_sub_invoke_tool,
                ctx=ctx,
            )

            agent_obj = Agent(
                role=d.role,
                goal=_DEFAULT_GOAL,
                backstory=_DEFAULT_BACKSTORY,
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
            task_desc = task_text.replace('{', '{{').replace('}', '}}')

            task_obj = Task(
                description=task_desc,
                expected_output=_DEFAULT_EXPECTED_OUTPUT,
                agent=agent_obj,
            )

            sub_agents.append(agent_obj)
            sub_tasks.append(task_obj)

        # 4. Build manager agent. The user's prompt goes into backstory (background context)
        #    rather than the goal so it doesn't drive active reasoning on every LLM call.
        #    The goal stays generic: delegate once, return the result.
        ig = self._iGlobal
        base_backstory = ig.backstory or _MGR_BACKSTORY
        if prompt:
            escaped_prompt = _escape_braces(prompt)
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

        debug('agent_crewai_manager kicking off crew with {} sub-agents run_id={}'.format(len(sub_agents), run_id))
        result = crew.kickoff(inputs={'user_request': prompt} if prompt else {})

        final_text = _safe_str(getattr(result, 'raw', None)) or _safe_str(result)
        return final_text, result
