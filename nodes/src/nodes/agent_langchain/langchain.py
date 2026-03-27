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

"""LangChain driver implementing the shared `ai.common.agent.AgentBase` interface."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from ai.common.agent import AgentBase
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from ai.common.tools import ToolsBase


class LangChainDriver(AgentBase):
    FRAMEWORK = 'langchain'

    def __init__(self, iGlobal: Any) -> None:
        """Initialize the LangChain driver."""
        super().__init__(iGlobal)

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

            def bind_tools(self, tools: Any, **kwargs: Any) -> 'RocketRideToolCallingChatModel':
                try:
                    self._bound_tools = _normalize_bound_tools(tools)
                except Exception:
                    self._bound_tools = []
                return self

            def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
                transcript = _langchain_messages_to_transcript(messages)
                tool_hint = _tool_call_protocol_prompt(self._bound_tools)
                prompt = (tool_hint + '\n\n' + transcript).strip()

                valid_names = {t.get('name', '') for t in self._bound_tools if isinstance(t, dict)}
                raw = ''
                for attempt in range(3):
                    raw = _safe_str(call_llm(prompt, stop_words=stop)).strip()
                    msg = _parse_tool_call_envelope(raw, valid_tool_names=valid_names)
                    if msg is not None:
                        return ChatResult(generations=[ChatGeneration(message=msg)])
                    if attempt < 2:
                        valid_list = ', '.join(sorted(valid_names)) if valid_names else '(none discovered)'
                        prompt = prompt + f'\n\nsystem: Your last output was invalid. You MUST use one of these exact tool names: [{valid_list}]. Output ONLY a single JSON object per the schema.'

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
        from pydantic import BaseModel, ConfigDict, Field, create_model

        class _ToolInput(BaseModel):
            """
            Accept arbitrary tool args through a stable `input` field.

            LangChain tool execution paths vary across versions; this schema keeps
            invocation robust when arguments are passed either via `input=...` or
            as extra keyword args.
            """

            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
            """
            Build a Pydantic model from a JSON Schema object.

            LangChain tool execution can filter kwargs based on `args_schema`. Using
            the real tool schema helps preserve tool parameters end-to-end.
            """
            if not isinstance(input_schema, dict):
                return _ToolInput
            props = input_schema.get('properties', {})
            if not isinstance(props, dict) or not props:
                return _ToolInput
            required_keys = set(input_schema.get('required', []) or [])

            field_defs: Dict[str, Any] = {}
            for key, prop in props.items():
                if not isinstance(key, str) or not key:
                    continue
                if not isinstance(prop, dict):
                    prop = {}
                desc = prop.get('description', '')
                if key in required_keys:
                    field_defs[key] = (Any, Field(..., description=desc))
                else:
                    default = prop.get('default', None)
                    field_defs[key] = (Any, Field(default=default, description=desc))

            if not field_defs:
                return _ToolInput

            try:
                return create_model(
                    '_DynToolInput',
                    __config__=ConfigDict(extra='ignore'),
                    **field_defs,
                )
            except Exception:
                return _ToolInput

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
            input_schema = td.get('input_schema')
            if isinstance(input_schema, dict):
                try:
                    schema_text = json.dumps(input_schema, ensure_ascii=False)
                except Exception:
                    schema_text = ''
                if schema_text:
                    desc = f'{desc}\n\nTool input schema (JSON): {schema_text}'

            schema_cls = _make_args_schema(input_schema if isinstance(input_schema, dict) else None)
            tool = HostTool(name=name, description=desc, args_schema=schema_cls)
            try:
                setattr(tool, '_rr_input_schema', input_schema)
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
        from langchain_core.callbacks import BaseCallbackHandler

        class _SSECallbackHandler(BaseCallbackHandler):
            def __init__(self, send_sse: Callable[..., Any]) -> None:
                super().__init__()
                self._send_sse = send_sse

            def on_tool_start(self, serialized: Any, input_str: Any, **kwargs: Any) -> None:
                tool_name = (serialized or {}).get('name', '') or 'tool'
                self._send_sse('thinking', message=f'Calling {tool_name}...', tool=tool_name, input=input_str)

            def on_tool_end(self, output: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Tool complete')

            def on_tool_error(self, error: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message=f'Tool error: {_safe_str(error)}')

            def on_agent_action(self, action: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Agent thinking...')

            def on_agent_finish(self, finish: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Agent done')

            def on_llm_start(self, serialized: Any, prompts: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='LLM call started')

            def on_chat_model_start(self, serialized: Any, messages: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='LLM call started')

            def on_llm_end(self, response: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='LLM call completed')

            def on_llm_error(self, error: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message=f'LLM error: {_safe_str(error)}')

        all_tool_descriptors = self.discover_tools(host=host)

        # Separate agent tools (direct children) from internal sub-tools.
        # Agent tools end with .run_agent; everything else (python.execute,
        # http.http_request, sub-agent tools) belongs to child agents and
        # should not be directly invoked by this orchestrator.
        _agent_tool_suffix = f'.{self._AGENT_TOOL_NAME}'
        agent_tools = [t for t in all_tool_descriptors if isinstance(t, dict) and str(t.get('name', '')).endswith(_agent_tool_suffix)]

        # Use only agent tools for the orchestrator; child agents handle
        # their own internal tools.
        tool_descriptors = agent_tools if agent_tools else all_tool_descriptors

        def _call_llm(messages: Any, stop_words: Any = None) -> str:
            return self.call_host_llm(
                host=host,
                messages=messages,
                question_role='You are a helpful assistant.',
                stop_words=stop_words,
            )

        def _invoke_tool(tool_name: str, input: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:  # noqa: A002
            return self.invoke_host_tool(host=host, tool_name=tool_name, input=input, kwargs=kwargs)

        llm = self._bind_framework_llm(host=host, call_llm=_call_llm, ctx=ctx)
        tools_for_agent = self._bind_framework_tools(
            host=host,
            tool_descriptors=tool_descriptors,
            invoke_tool=_invoke_tool,
            log_tool_call=lambda **_: None,
            ctx=ctx,
        )

        # Build a tool roster for the system prompt so the LLM knows exactly
        # which tool name maps to which purpose.  Extract sub-tool lists from
        # the description to give context about each agent's capabilities.
        tool_roster_lines = []
        for td in tool_descriptors:
            if not isinstance(td, dict):
                continue
            name = td.get('name', '')
            raw_desc = td.get('description', '')
            desc = raw_desc if isinstance(raw_desc, str) else str(raw_desc or '')
            # Extract the "Tools available to this agent:" section if present
            tools_section = ''
            tools_marker = 'Tools available to this agent:'
            idx = desc.find(tools_marker)
            if idx >= 0:
                tools_section = f' [{desc[idx:].strip()}]'
            # Extract agent summary if present
            summary_marker = 'This agent:'
            sidx = desc.find(summary_marker)
            if sidx >= 0:
                end = desc.find(' Input:', sidx)
                summary = desc[sidx:end].strip() if end > sidx else desc[sidx : sidx + 200].strip()
                tool_roster_lines.append(f'  - {name}: {summary}{tools_section}')
            else:
                # Fallback: use first sentence of description
                dot = desc.find('. ')
                short_desc = desc[: dot + 1] if 0 < dot < 150 else desc[:150]
                tool_roster_lines.append(f'  - {name}: {short_desc}{tools_section}')

        roster = '\n'.join(tool_roster_lines) if tool_roster_lines else '  (no tools)'

        system_parts = [
            'You are an agent node in a tool-invocation hierarchy.',
            'You MUST call tools using their EXACT names as listed below.',
            '',
            'Available tools:',
            roster,
        ]
        if agent_tools:
            system_parts += [
                '',
                'IMPORTANT: Each tool listed above is a DIFFERENT agent with different capabilities.',
                'Match each step of your workflow to the correct tool based on the description above.',
                'Do NOT call the same tool twice for different purposes.',
            ]
        system_message = SystemMessage(content='\n'.join(system_parts).strip())

        tool_names = [td.get('name', '?') for td in tool_descriptors]
        self.sendSSE('thinking', message=f'Starting LangChain agent with tools: {tool_names}')
        stage = 'create_agent'
        try:
            agent = create_agent(model=llm, tools=tools_for_agent, system_prompt=system_message, debug=False)
            stage = 'invoke'
            state = agent.invoke(
                {'messages': [HumanMessage(content=_safe_str(agent_input.question.getPrompt() or ''))]},
                config={'callbacks': [_SSECallbackHandler(self.sendSSE)]},
            )
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
    # Build a concise tool roster with exact names prominently listed
    tool_roster = []
    for t in bound_tools:
        if not isinstance(t, dict):
            continue
        name = t.get('name', '')
        desc = t.get('description', '')
        if name:
            tool_roster.append(f'  - EXACT name: "{name}" — {desc[:200]}')

    roster_text = '\n'.join(tool_roster) if tool_roster else '  (no tools available)'
    tools_json = json.dumps(bound_tools, ensure_ascii=False)

    return '\n'.join(
        [
            'system: You MUST respond with exactly one JSON object and nothing else.',
            'system: Allowed schemas:',
            'system: Tool call:',
            'system: {"type":"tool_call","name":"<exact tool name from list below>","args":{...}}',
            'system: Final answer:',
            'system: {"type":"final","content":"..."}',
            'system: CRITICAL: The "name" field MUST be one of the exact tool names listed below. Do NOT invent or guess tool names.',
            f'system: Available tools:\n{roster_text}',
            'system: Never wrap JSON in markdown. Never include extra keys unless required.',
            f'system: Full tool schemas: {tools_json}',
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
        input_schema: Any = None
        try:
            schema = getattr(t, 'args_schema', None)
        except Exception:
            schema = None
        try:
            input_schema = getattr(t, '_rr_input_schema', None)
        except Exception:
            input_schema = None

        entry: Dict[str, Any] = {'name': name, 'description': desc, 'args_schema': _safe_str(schema)}
        if isinstance(input_schema, dict):
            entry['input_schema'] = input_schema
        out.append(entry)
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


def _parse_tool_call_envelope(raw: str, *, valid_tool_names: set[str] | None = None) -> Any:
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
        # Reject tool names not in the discovered tool list to prevent
        # the LLM from hallucinating calls to unconnected nodes.
        if valid_tool_names and name not in valid_tool_names:
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
