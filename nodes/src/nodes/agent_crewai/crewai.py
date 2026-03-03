# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, merge, publish, distribute, sublicense, and/or sell
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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
CrewAI driver implementing the shared `ai.common.agent.AGENT` interface.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Union

from rocketlib import debug

from ai.common.agent import AgentBase
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from ai.common.tools import ToolsBase


class CrewDriver(AgentBase):
    FRAMEWORK = 'crewai'

    def __init__(self, *, process: Any = None):
        """
        Initialize the CrewDriver.
        """
        self._process = process

    def _bind_framework_llm(
        self,
        *,
        host: AgentHost,
        call_llm_text: Callable[..., str],
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
                return call_llm_text(messages, stop_words=stop_words)

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
        from pydantic import BaseModel, ConfigDict, Field, create_model  # noqa: E501

        class _ToolInput(BaseModel):
            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
            """Build a dynamic Pydantic model from a JSON Schema so that
            CrewAI's argument filter preserves real tool parameters."""
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
        run_id = ctx.get('run_id', '')
        debug('agent_crewai driver _run start run_id={} prompt_len={}'.format(run_id, len(agent_input.prompt or '')))

        from crewai import Agent, Crew, Task  # type: ignore

        tool_descriptors = self._discover_tools(host=host)

        def _call_llm_text(messages: Any, stop_words: Any = None) -> str:
            return self._call_host_llm(
                host=host,
                messages=messages,
                question_role='You are a helpful assistant.',
                stop_words=stop_words,
            )

        def _invoke_tool(tool_name: str, input: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:  # noqa: A002
            return self._invoke_host_tool(host=host, tool_name=tool_name, input=input, kwargs=kwargs)

        llm = self._bind_framework_llm(host=host, call_llm_text=_call_llm_text, ctx=ctx)
        tools_for_agent = self._bind_framework_tools(
            host=host,
            tool_descriptors=tool_descriptors,
            invoke_tool=_invoke_tool,
            log_tool_call=lambda **_: None,
            ctx=ctx,
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
        desc = '\n'.join(desc_parts).strip()

        desc = desc.replace('{', '{{').replace('}', '}}')

        task_obj = Task(
            description=desc,
            expected_output='A helpful, accurate response.',
            agent=agent_obj,
            markdown=False,
        )

        crew = Crew(agents=[agent_obj], tasks=[task_obj], process=self._process)
        result = crew.kickoff()

        final_text = ''
        if hasattr(result, 'raw'):
            try:
                final_text = _safe_str(getattr(result, 'raw'))
            except Exception:
                final_text = ''
        if not final_text:
            final_text = _safe_str(result)

        return final_text, result


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''
