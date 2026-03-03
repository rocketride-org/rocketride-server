# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

"""LangChain driver implementing the shared `ai.common.agent.AgentBase` interface."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from ai.common.agent import AgentBase
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from ai.common.tools import ToolsBase


class LangChainDriver(AgentBase):
    FRAMEWORK = 'langchain'

    def __init__(self) -> None:
        """Initialize the LangChain driver."""

    # ------------------------------------------------------------------
    # Bindings
    # ------------------------------------------------------------------
    def _bind_framework_llm(
        self,
        *,
        host: AgentHost,
        call_llm: Callable[..., str],
        ctx: Dict[str, Any],
    ) -> Any:
        from langchain_core.language_models import BaseChatModel
        from langchain_core.messages import AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        class RocketRideToolCallingChatModel(BaseChatModel):
            def __init__(self):
                super().__init__()
                self._bound_tools: List[Dict[str, Any]] = []

            @property
            def _llm_type(self) -> str:
                return 'rocketride-host-llm'

            @property
            def _identifying_params(self) -> Dict[str, Any]:
                return {'framework': 'rocketride', 'adapter': 'tool_calling_json'}

            def bind_tools(self, tools: Any, **kwargs: Any) -> "RocketRideToolCallingChatModel":
                try:
                    self._bound_tools = _normalize_bound_tools(tools)
                except Exception:
                    self._bound_tools = []
                return self

            def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
                transcript = _langchain_messages_to_transcript(messages)
                tool_hint = _tool_call_protocol_prompt(self._bound_tools)
                prompt = (tool_hint + '\n\n' + transcript).strip()

                raw = ''
                for attempt in range(3):
                    raw = _safe_str(call_llm(prompt, stop_words=stop)).strip()
                    msg = _parse_tool_call_envelope(raw)
                    if msg is not None:
                        return ChatResult(generations=[ChatGeneration(message=msg)])
                    if attempt < 2:
                        prompt = prompt + '\n\nsystem: Your last output was invalid. Output ONLY a single JSON object per the schema.'

                return ChatResult(generations=[ChatGeneration(message=AIMessage(content=raw))])

        return RocketRideToolCallingChatModel()

    def _bind_framework_tools(
        self,
        *,
        host: AgentHost,
        tool_descriptors: List[ToolsBase.ToolDescriptor],
        invoke_tool: Callable[..., Any],
        log_tool_call: Callable[..., None],
        ctx: Dict[str, Any],
    ) -> List[Any]:
        from langchain_core.tools import BaseTool
        from pydantic import BaseModel, ConfigDict, Field

        class _ToolInput(BaseModel):
            """
            Accept arbitrary tool args through a stable `input` field.

            LangChain tool execution paths vary across versions; this schema keeps
            invocation robust when arguments are passed either via `input=...` or
            as extra keyword args.
            """

            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        class HostTool(BaseTool):  # type: ignore[misc]
            name: str
            description: str
            args_schema: type[BaseModel] = _ToolInput

            def _run(self, input: Any = None, **kwargs: Any) -> str:  # noqa: ANN401, A002
                tool_name = _safe_str(getattr(self, 'name', ''))

                try:
                    out = invoke_tool(tool_name, input=input, kwargs=kwargs)
                except Exception as e:
                    out = {'error': str(e), 'type': type(e).__name__}

                try:
                    log_tool_call(tool_name=tool_name, input={'input': input, **kwargs}, output=out)
                except Exception:
                    pass

                try:
                    return json.dumps(out, default=str) if isinstance(out, (dict, list)) else _safe_str(out)
                except Exception:
                    return _safe_str(out)

        tools: List[Any] = []
        for td in tool_descriptors:
            if not hasattr(td, 'get'):
                continue
            name = td.get('name')
            if not isinstance(name, str) or not name.strip():
                continue
            desc = td.get('description') if isinstance(td.get('description'), str) else f'Invoke host tool: {name}'
            tool = HostTool(name=name, description=desc)
            try:
                setattr(tool, '_rr_input_schema', td.get('input_schema'))
            except Exception:
                pass
            tools.append(tool)
        return tools

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------
    def _run(self, *, agent_input: AgentInput, host: AgentHost, ctx: Dict[str, Any]) -> AgentRunResult:
        from langchain.agents import create_agent
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        tool_descriptors = self._discover_tools(host=host)

        def _call_llm(messages: Any, stop_words: Any = None) -> str:
            return self._call_host_llm(
                host=host,
                messages=messages,
                question_role='You are a helpful assistant.',
                stop_words=stop_words,
            )

        def _invoke_tool(tool_name: str, input: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:  # noqa: A002
            return self._invoke_host_tool(host=host, tool_name=tool_name, input=input, kwargs=kwargs)

        llm = self._bind_framework_llm(host=host, call_llm=_call_llm, ctx=ctx)
        tools_for_agent = self._bind_framework_tools(
            host=host,
            tool_descriptors=tool_descriptors,
            invoke_tool=_invoke_tool,
            log_tool_call=lambda **_: None,
            ctx=ctx,
        )

        system_parts = [
            'You are an agent node in a tool-invocation hierarchy.',
            'Use the provided tools when needed.',
        ]
        system_message = SystemMessage(content='\n'.join(system_parts).strip())

        stage = 'create_agent'
        try:
            agent = create_agent(model=llm, tools=tools_for_agent, system_prompt=system_message, debug=False)
            stage = 'invoke'
            state = agent.invoke({'messages': [HumanMessage(content=_safe_str(agent_input.prompt or ''))]})
        except Exception as e:
            raise RuntimeError('LangChain agent {} failed: {}: {}'.format(stage, type(e).__name__, _safe_str(e))) from e

        final_text = ''
        try:
            msgs = state.get('messages') if isinstance(state, dict) else None
            if isinstance(msgs, list) and msgs:
                last = msgs[-1]
                if isinstance(last, AIMessage):
                    final_text = _safe_str(getattr(last, 'content', ''))
                else:
                    final_text = _safe_str(getattr(last, 'content', last))
            else:
                final_text = _safe_str(state)
        except Exception:
            final_text = _safe_str(state)

        return _safe_str(final_text), state


# ------------------------------------------------------------------
# Helpers for tool calling with RocketRide LLM
#
# Problem: LangChain agents expect a chat model that returns structured `tool_calls`,
# but RocketRide's LLM seam is text-only (`IInvokeLLM(op="ask")`).
# Solution: we prompt the model to emit a strict JSON envelope describing either a
# tool call or a final answer, then parse it into an `AIMessage` with `tool_calls`.
# ------------------------------------------------------------------
def _tool_call_protocol_prompt(bound_tools: List[Dict[str, Any]]) -> str:
    tools_json = json.dumps(bound_tools, ensure_ascii=False)
    return '\n'.join(
        [
            'system: You MUST respond with exactly one JSON object and nothing else.',
            'system: Allowed schemas:',
            'system: Tool call:',
            'system: {"type":"tool_call","name":"server.tool","args":{...}}',
            'system: Final answer:',
            'system: {"type":"final","content":"..."}',
            'system: Never wrap JSON in markdown. Never include extra keys unless required.',
            f'system: Available tools (name + description + args schema): {tools_json}',
        ]
    ).strip()


def _normalize_bound_tools(tools: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not tools:
        return out
    if not isinstance(tools, list):
        tools = [tools]
    for t in tools:
        name = _safe_str(getattr(t, 'name', ''))
        desc = _safe_str(getattr(t, 'description', ''))
        schema: Any = None
        try:
            schema = getattr(t, 'args_schema', None)
        except Exception:
            schema = None
        out.append({'name': name, 'description': desc, 'args_schema': _safe_str(schema)})
    return out


def _langchain_messages_to_transcript(messages: Any) -> str:
    try:
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    except Exception:
        AIMessage = HumanMessage = SystemMessage = ToolMessage = object  # type: ignore

    if messages is None:
        return ''
    if isinstance(messages, str):
        return messages
    if isinstance(messages, dict):
        return json.dumps(messages, default=str)
    if not isinstance(messages, list):
        try:
            return str(messages)
        except Exception:
            return ''

    lines: List[str] = []
    for m in messages:
        role = 'user'
        content = ''
        try:
            content = _safe_str(getattr(m, 'content', ''))
        except Exception:
            content = _safe_str(m)

        if isinstance(m, SystemMessage):
            role = 'system'
        elif isinstance(m, HumanMessage):
            role = 'user'
        elif isinstance(m, ToolMessage):
            role = 'tool'
            try:
                name = _safe_str(getattr(m, 'name', ''))
                if name:
                    role = f'tool[{name}]'
            except Exception:
                pass
        elif isinstance(m, AIMessage):
            role = 'assistant'

        lines.append(f'{role}: {content}')

    return '\n'.join(lines).strip()


def _parse_tool_call_envelope(raw: str) -> Any:
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None

    msg_type = obj.get('type')
    if msg_type == 'final':
        content = _safe_str(obj.get('content', ''))
        try:
            from langchain_core.messages import AIMessage

            return AIMessage(content=content)
        except Exception:
            return None

    if msg_type == 'tool_call':
        name = _safe_str(obj.get('name', '')).strip()
        if not name:
            return None
        args = obj.get('args')
        if args is None:
            args = {}
        if not isinstance(args, dict):
            args = {'input': args}

        tool_call = {'id': f'call_{_safe_str(id(obj))}', 'type': 'tool_call', 'name': name, 'args': args}

        try:
            from langchain_core.messages import AIMessage

            try:
                return AIMessage(content='', tool_calls=[tool_call])
            except Exception:
                return AIMessage(content='', additional_kwargs={'tool_calls': [tool_call]})
        except Exception:
            return None

    return None


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''

