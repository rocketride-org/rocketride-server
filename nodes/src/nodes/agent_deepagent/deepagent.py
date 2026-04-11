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

"""DeepAgents driver implementing the shared `ai.common.agent.AgentBase` interface."""

from __future__ import annotations

import json
import uuid
from typing import Any, Callable, Dict, List, Optional

from rocketlib import ToolDescriptor

from ai.common.agent import AgentBase, AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question


# ────────────────────────────────────────────────────────────────────────────────
# FRAMEWORK WRAPPER BUILDERS — DRIVER-PRIVATE MODULE HELPERS
# ────────────────────────────────────────────────────────────────────────────────


def _build_deepagent_llm(agent_base: AgentBase, context: AgentContext) -> Any:
    """Build a LangChain BaseChatModel that delegates to AgentBase.call_llm.

    DeepAgents is built on LangChain/LangGraph and shares the same model
    interface as the langchain driver.  The wrapper converts a LangChain
    message list into a plain-text transcript, prepends the JSON tool-call
    protocol prompt, calls ``agent_base.call_llm``, and parses the response
    envelope back into a ``ChatResult``.  Up to three attempts are made when
    the LLM produces malformed JSON.
    """
    from langchain_core.language_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    class RocketRideToolCallingChatModel(BaseChatModel):
        """LangChain BaseChatModel that routes inference through AgentBase.call_llm."""

        _bound_tools: List[Dict[str, Any]]

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

            raw = ''
            for attempt in range(3):
                raw = _safe_str(
                    agent_base.call_llm(
                        context,
                        prompt,
                        role='You are a helpful assistant.',
                        stop_words=stop,
                    )
                ).strip()
                msg = _parse_tool_call_envelope(raw)
                if msg is not None:
                    return ChatResult(generations=[ChatGeneration(message=msg)])
                if attempt < 2:
                    prompt = prompt + '\n\nsystem: Your last output was invalid. Output ONLY a single JSON object per the schema.'

            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=raw))])

    return RocketRideToolCallingChatModel()


def _build_deepagent_tools(
    agent_base: AgentBase,
    context: AgentContext,
    tool_descriptors: List[ToolDescriptor],
) -> List[Any]:
    """Convert host tool descriptors into LangChain BaseTool instances.

    The inner ``HostTool`` subclass captures `agent_base` and `context` via
    closure on the enclosing function so its `_run` method can call
    `agent_base.call_tool(context, ...)`.
    """
    from langchain_core.tools import BaseTool
    from pydantic import BaseModel, ConfigDict, Field, create_model

    class _ToolInput(BaseModel):
        """Default fallback Pydantic model for tools that lack a typed input schema."""

        input: Any = Field(default=None, description='Tool input payload')
        model_config = ConfigDict(extra='allow')

    def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
        """Build a typed Pydantic BaseModel from a JSON-Schema input_schema dict."""
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
        """LangChain BaseTool that delegates execution to AgentBase.call_tool."""

        name: str
        description: str
        args_schema: type[BaseModel] = _ToolInput

        def _run(self, **framework_args: Any) -> str:  # noqa: ANN401
            tool_name = _safe_str(getattr(self, 'name', ''))

            try:
                out = agent_base.call_tool(context, tool_name, framework_args)
            except Exception as e:
                out = {'error': str(e), 'type': type(e).__name__}

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
        input_schema = td.get('inputSchema')
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


# ────────────────────────────────────────────────────────────────────────────────
# DEEPAGENT DRIVER
# ────────────────────────────────────────────────────────────────────────────────


class DeepAgentDriver(AgentBase):
    """
    Framework driver that executes single-agent pipelines via the ``deepagents`` library.

    Built on LangChain/LangGraph, the driver layers strategic planning, persistent state,
    and long-context management on top of the standard LangChain agent loop.  It follows
    the RocketRide ``AgentBase`` contract for tool discovery, host-LLM routing, and SSE
    progress events.
    """

    FRAMEWORK = 'deepagent'

    def __init__(self, iGlobal: Any) -> None:
        """Initialise the DeepAgents driver."""
        super().__init__(iGlobal)

    def _run(self, *, context: AgentContext, question: Question) -> AgentRunResult:
        """Execute the agent using ``deepagents.create_deep_agent``."""

        # Bound SSE forwarder -- captures context so the LangChain callback handler
        # always routes events to the correct invoker, even if the framework
        # invokes the callback from a worker thread.
        def _send_sse(type: str, **data: Any) -> None:
            self.sendSSE(context, type, **data)

        from deepagents import create_deep_agent
        from langchain_core.callbacks import BaseCallbackHandler
        from langchain_core.messages import AIMessage, HumanMessage

        class _SSECallbackHandler(BaseCallbackHandler):
            """LangChain callback handler that forwards agent lifecycle events as SSE messages."""

            def __init__(self, send_sse: Callable[..., Any]) -> None:
                super().__init__()
                self._send_sse = send_sse

            def on_tool_start(self, serialized: Any, input_str: Any, **kwargs: Any) -> None:
                tool_name = (serialized or {}).get('name', '') or 'tool'
                input_len = len(_safe_str(input_str))
                self._send_sse('thinking', message=f'Calling {tool_name}...', tool=tool_name, input_length=input_len)

            def on_tool_end(self, output: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Tool complete')

            def on_tool_error(self, error: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Tool error', error_type=type(error).__name__)

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
                self._send_sse('thinking', message='LLM error', error_type=type(error).__name__)

        tool_descriptors = context.tools.list
        _send_sse('thinking', message=f'Discovered {len(tool_descriptors)} host tool(s)')

        llm = _build_deepagent_llm(self, context)
        tools_for_agent = _build_deepagent_tools(self, context, tool_descriptors)

        system_prompt = 'You are an agent node in a tool-invocation hierarchy.\nUse the provided tools when needed.'

        _send_sse('thinking', message='Starting Deep Agent...')
        stage = 'create_deep_agent'
        try:
            agent = create_deep_agent(model=llm, tools=tools_for_agent, system_prompt=system_prompt)
            stage = 'invoke'
            state = agent.invoke(
                {'messages': [HumanMessage(content=_safe_str(question.getPrompt() or ''))]},
                config={'callbacks': [_SSECallbackHandler(_send_sse)]},
            )
        except Exception as e:
            raise RuntimeError(f'Deep agent {stage} failed: {type(e).__name__}: {_safe_str(e)}') from e

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


# ────────────────────────────────────────────────────────────────────────────────
# DRIVER-PRIVATE HELPERS (shared with the LangChain driver pattern)
# ────────────────────────────────────────────────────────────────────────────────


def _tool_call_protocol_prompt(bound_tools: List[Dict[str, Any]]) -> str:
    """
    Build the system-prompt preamble that instructs the LLM to output a JSON envelope.

    The returned string is prepended to the message transcript before every LLM call so
    that models without native tool-calling support can still drive agentic behaviour via
    the ``{"type":"tool_call",...}`` / ``{"type":"final",...}`` envelope schema.
    """
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
    """Normalise a LangChain tool or list of tools into plain descriptor dicts."""
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
    """Convert a LangChain message list (or plain string/dict) into a plain-text transcript."""
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
            try:
                tool_calls = getattr(m, 'tool_calls', None) or []
                if tool_calls:
                    rendered_calls = [
                        json.dumps(
                            {
                                'type': 'tool_call',
                                'name': _safe_str(tc.get('name', '')),
                                'args': tc.get('args', {}),
                            },
                            ensure_ascii=False,
                            default=str,
                        )
                        for tc in tool_calls
                        if isinstance(tc, dict)
                    ]
                    content = '\n'.join(filter(None, [content, *rendered_calls]))
            except Exception:
                pass

        lines.append(f'{role}: {content}')

    return '\n'.join(lines).strip()


def _parse_tool_call_envelope(raw: str) -> Any:
    """Parse a raw LLM response string as a JSON tool-call or final-answer envelope."""
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

        tool_call = {'id': f'call_{uuid.uuid4().hex[:12]}', 'type': 'tool_call', 'name': name, 'args': args}

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
    """Safely convert any value to a string without raising."""
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''
