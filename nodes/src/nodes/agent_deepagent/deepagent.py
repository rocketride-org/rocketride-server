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

import asyncio
import json
import uuid
from typing import Any, Callable, Dict, List, Optional

from rocketlib import ToolDescriptor, error

from ai.common.agent import AgentBase, AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question

from ai.common.utils import langchain_messages_to_transcript, normalize_bound_tools
from ai.common.utils import safe_str


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
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.messages.utils import count_tokens_approximately
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
                self._bound_tools = normalize_bound_tools(tools)
            except Exception:
                self._bound_tools = []
            return self

        # deepagents' middleware asks the model to count tokens; BaseChatModel's
        # fallback needs `transformers` (not bundled) and only knows GPT-2 anyway.
        # The host LLM is opaque to us, so approximate counting is both sufficient
        # and dependency-free.
        def get_num_tokens(self, text: str) -> int:
            return count_tokens_approximately([HumanMessage(content=safe_str(text))])

        def get_token_ids(self, text: str) -> List[int]:
            # No real tokenizer; synthesize an id list of the right length so
            # len(get_token_ids(text)) == get_num_tokens(text) still holds.
            return list(range(self.get_num_tokens(text)))

        def get_num_tokens_from_messages(self, messages: Any, tools: Any = None) -> int:
            return count_tokens_approximately(messages)

        def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
            transcript = langchain_messages_to_transcript(messages)
            tool_hint = _tool_call_protocol_prompt(self._bound_tools)
            prompt = (tool_hint + '\n\n' + transcript).strip()

            raw = ''
            for attempt in range(3):
                raw = safe_str(
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
                    prompt = (
                        prompt
                        + '\n\nsystem: Your last output was invalid. Output ONLY a single JSON object per the schema.'
                    )

            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=raw))])

        async def _agenerate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
            # Async hook for LangGraph's async path.  Bridges the blocking engine
            # LLM RPC off the event loop so concurrent subagent LLM calls don't
            # serialize on the orchestrator's loop.  The 3-attempt JSON-envelope
            # retry loop stays inside _generate — LangGraph awaits one _agenerate
            # per LLM call, retries are an implementation detail.
            return await asyncio.to_thread(self._generate, messages, stop, run_manager, **kwargs)

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
            tool_name = safe_str(getattr(self, 'name', ''))

            try:
                out = agent_base.call_tool(context, tool_name, framework_args)
            except Exception as e:
                out = {'error': str(e), 'type': type(e).__name__}

            try:
                return json.dumps(out, default=str) if isinstance(out, (dict, list)) else safe_str(out)
            except Exception:
                return safe_str(out)

        async def _arun(self, **framework_args: Any) -> str:  # noqa: ANN401
            # Async hook for LangGraph's async ToolNode (asyncio.gather fan-out).
            # Bridges the blocking engine RPC off the event loop via to_thread so
            # multiple concurrent tool calls don't serialize on the orchestrator's
            # loop.  Sync _run remains the single source of truth.
            return await asyncio.to_thread(self._run, **framework_args)

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
        """Initialise the DeepAgents driver.

        Reads ``description`` and ``system_prompt`` from node config on top
        of the ``agent_description`` / ``instructions`` already loaded by
        ``AgentBase.__init__``. These four fields together drive the describe
        fan-out when this driver is used as a sub-agent.
        """
        super().__init__(iGlobal)

        # ``_instructions`` / ``_agent_description`` are already loaded by
        # ``AgentBase.__init__`` from the resolved config (which handles both the
        # flat and nested-under-default pipe shapes). Read this driver's two extra
        # fields from the same resolved config.
        self._description: str = (self._config.get('description', '') or '').strip()
        self._system_prompt: str = (self._config.get('system_prompt', '') or '').strip()

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
                input_len = len(safe_str(input_str))
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

        system_prompt = _compose_system_prompt(
            base=self._system_prompt,
            instructions=self._instructions,
            fallback='You are an agent node in a tool-invocation hierarchy.\nUse the provided tools when needed.',
        )

        # Fan out deepagent.describe to any connected DeepAgent Subagent nodes.
        # Empty list → behaves as a standalone single-agent run.
        subagents_list = self._collect_subagents(context)
        if subagents_list:
            _send_sse('thinking', message=f'Collected {len(subagents_list)} sub-agent(s)')

        _send_sse('thinking', message='Starting Deep Agent...')
        stage = 'create_deep_agent'
        try:
            agent = create_deep_agent(
                model=llm,
                tools=tools_for_agent,
                system_prompt=system_prompt,
                subagents=subagents_list if subagents_list else None,
            )
            stage = 'invoke'
            # Drive LangGraph via its async executor so multiple `task` tool_calls
            # in one orchestrator turn fan out concurrently (asyncio.gather inside
            # the async ToolNode).  HostTool._arun and
            # RocketRideToolCallingChatModel._agenerate bridge the blocking engine
            # RPCs off the event loop via asyncio.to_thread.
            #
            # asyncio.run is safe here because the caller chain is sync:
            # AgentBase.run_agent -> IInstance.writeQuestions (plain def, called
            # from the engine's C++ side).  If a future change makes any caller
            # async, this needs to switch to `await agent.ainvoke(...)` and _run
            # itself must become async.
            state = asyncio.run(
                agent.ainvoke(
                    {'messages': [HumanMessage(content=safe_str(question.getPrompt() or ''))]},
                    config={'callbacks': [_SSECallbackHandler(_send_sse)]},
                )
            )
        except Exception as e:
            raise RuntimeError(f'Deep agent {stage} failed: {type(e).__name__}: {safe_str(e)}') from e

        final_text = ''
        try:
            msgs = state.get('messages') if isinstance(state, dict) else None
            if isinstance(msgs, list) and msgs:
                last = msgs[-1]
                if isinstance(last, AIMessage):
                    final_text = safe_str(getattr(last, 'content', ''))
                else:
                    final_text = safe_str(getattr(last, 'content', last))
            else:
                final_text = safe_str(state)
        except Exception:
            final_text = safe_str(state)

        return safe_str(final_text), state

    def _collect_subagents(self, context: AgentContext) -> List[Any]:
        """Fan out ``describe`` to all connected DeepAgent Subagent nodes.

        Discovers sub-agents via ``getControllerNodeIds('deepagent')``, invokes
        each one individually with a fresh ``IInvokeDeepagent.Describe`` so
        every responder appends its descriptor, and builds a ``SubAgent`` dict
        for each descriptor — wiring per-subagent LLM/tools to the sub-agent's
        own engine channels via ``AgentHostServices(d.invoke)``.

        Mirrors the discovery pattern in ``agent_crewai/crewai_manager/manager.py``.

        Args:
            context: The orchestrator's ``AgentContext``; run metadata is
                inherited by each sub-context so SSE events route back to the
                same logical run.

        Returns:
            A (possibly empty) list of ``deepagents.middleware.subagents.SubAgent`` dicts.
        """
        from rocketlib.types import IInvokeDeepagent
        from ai.common.agent._internal.host import AgentHostServices

        pSelf = context.invoker
        try:
            deepagent_node_ids = pSelf.instance.getControllerNodeIds('deepagent')
        except Exception:
            return []

        if not deepagent_node_ids:
            return []

        from deepagents.middleware.subagents import SubAgent as _SubAgent

        subagents: List[Any] = []
        for node_id in deepagent_node_ids:
            req = IInvokeDeepagent.Describe()
            try:
                pSelf.instance.invoke(req, component_id=node_id)
            except Exception as e:
                error(
                    f'deepagent _collect_subagents invoke failed for node={node_id}: {type(e).__name__}: {safe_str(e)}'
                )
                continue

            for d in req.agents:
                if d is None:
                    continue
                try:
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

                    sub_llm = _build_deepagent_llm(self, sub_context)
                    sub_tools = _build_deepagent_tools(self, sub_context, sub_context.tools.list)

                    subagents.append(
                        _SubAgent(
                            name=d.name,
                            description=d.description or d.name,
                            system_prompt=_compose_system_prompt(
                                base=d.system_prompt,
                                instructions=d.instructions,
                                fallback='You are a helpful sub-agent. Use your tools to complete the assigned task.',
                            ),
                            tools=sub_tools,
                            model=sub_llm,
                        )
                    )
                except Exception as e:
                    error(
                        f'deepagent _collect_subagents build failed for node={node_id}: {type(e).__name__}: {safe_str(e)}'
                    )

        return subagents


# ────────────────────────────────────────────────────────────────────────────────
# DRIVER-PRIVATE HELPERS (shared with the LangChain driver pattern)
# ────────────────────────────────────────────────────────────────────────────────


def _tool_call_protocol_prompt(bound_tools: List[Dict[str, Any]]) -> str:
    """
    Build the system-prompt preamble that instructs the LLM to output a JSON envelope.

    The returned string is prepended to the message transcript before every LLM call so
    that models without native tool-calling support can still drive agentic behaviour via
    the JSON envelope schema below.

    Supports three response shapes:
      - Single tool call: ``{"type":"tool_call","name":"...","args":{...}}``
      - Parallel tool calls: ``{"type":"tool_calls","calls":[{"name":"...","args":{...}}, ...]}``
      - Final answer: ``{"type":"final","content":"..."}``

    The parallel form lets the orchestrator fan out independent steps in one turn — the
    async LangGraph runtime dispatches them concurrently via ``asyncio.gather``.
    """
    tools_json = json.dumps(bound_tools, ensure_ascii=False)
    return '\n'.join(
        [
            'system: You MUST respond with exactly one JSON object and nothing else.',
            'system: Allowed schemas:',
            'system: Single tool call:',
            'system: {"type":"tool_call","name":"server.tool","args":{...}}',
            'system: Parallel tool calls (use when steps are independent — runs concurrently):',
            'system: {"type":"tool_calls","calls":[{"name":"server.tool","args":{...}}, {"name":"server.tool2","args":{...}}]}',
            'system: Final answer:',
            'system: {"type":"final","content":"..."}',
            'system: Prefer "tool_calls" with multiple entries when steps are independent — this dispatches them in parallel and is much faster than issuing them one at a time across turns.',
            'system: Never wrap JSON in markdown. Never include extra keys unless required.',
            f'system: Available tools (name + description + args schema): {tools_json}',
        ]
    ).strip()


def _parse_tool_call_envelope(raw: str) -> Any:
    """Parse a raw LLM response string as a JSON tool-call or final-answer envelope.

    Uses ``_extract_first_json_object`` so the envelope still parses when the
    LLM emits trailing prose, markdown fences, or a second JSON object right
    after the first one closes (a common failure mode — duplicate call or
    hallucinated ``final`` stacked onto a ``tool_call``).
    """
    obj = _extract_first_json_object(raw)
    if not isinstance(obj, dict):
        return None

    try:
        from langchain_core.messages import AIMessage
    except Exception:
        return None

    msg_type = obj.get('type')
    if msg_type == 'final':
        return AIMessage(content=safe_str(obj.get('content', '')))

    if msg_type == 'tool_call':
        name = safe_str(obj.get('name', '')).strip()
        if not name:
            return None
        args = obj.get('args') or {}
        if not isinstance(args, dict):
            args = {'input': args}

        tool_call = {'id': f'call_{uuid.uuid4().hex[:12]}', 'type': 'tool_call', 'name': name, 'args': args}
        return AIMessage(content='', tool_calls=[tool_call])

    if msg_type == 'tool_calls':
        # Plural form — one assistant message with multiple tool_calls.  LangGraph's
        # async ToolNode dispatches the list concurrently via asyncio.gather, so this
        # is the on-the-wire shape that unlocks subagent fan-out.
        raw_calls = obj.get('calls')
        if not isinstance(raw_calls, list) or not raw_calls:
            return None

        tool_calls: List[Dict[str, Any]] = []
        for entry in raw_calls:
            if not isinstance(entry, dict):
                continue
            name = safe_str(entry.get('name', '')).strip()
            if not name:
                continue
            args = entry.get('args') or {}
            if not isinstance(args, dict):
                args = {'input': args}
            tool_calls.append(
                {
                    'id': f'call_{uuid.uuid4().hex[:12]}',
                    'type': 'tool_call',
                    'name': name,
                    'args': args,
                }
            )

        if not tool_calls:
            return None
        return AIMessage(content='', tool_calls=tool_calls)

    return None


def _extract_first_json_object(raw: str) -> Any:
    """Extract the first balanced JSON object from a raw LLM response.

    Handles the common failure modes we've seen from host LLMs producing the
    tool-call envelope — extra prose, markdown fences, or a second JSON object
    appended after the first one closes (e.g. a duplicate tool call or a
    hallucinated final answer). Returns just the first object so the parser
    can build a valid ``AIMessage`` instead of failing the whole envelope.
    """
    if not isinstance(raw, str) or not raw:
        return None

    s = raw.strip()
    if s.startswith('```'):
        s = s.split('\n', 1)[1] if '\n' in s else s[3:]
        if '```' in s:
            s = s.rsplit('```', 1)[0]
        s = s.strip()

    # Fast path: valid JSON as-is
    try:
        return json.loads(s)
    except Exception:
        pass

    # Walk from the first '{' to its matching '}', honouring string escapes
    start = s.find('{')
    if start < 0:
        return None

    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                candidate = s[start : i + 1]
                try:
                    return json.loads(candidate)
                except Exception:
                    return None
    return None


def _compose_system_prompt(*, base: Optional[str], instructions: Optional[List[str]], fallback: str) -> str:
    """Combine a base system prompt with trailing instruction lines.

    * Start with *base* (stripped); fall back to *fallback* when *base* is empty.
    * Append each non-empty instruction on its own line.
    """
    prompt = (base or '').strip() or fallback
    for inst in instructions or []:
        inst = inst.strip()
        if inst:
            prompt = f'{prompt}\n{inst}'
    return prompt
