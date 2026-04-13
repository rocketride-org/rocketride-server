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
from typing import Any, Callable

from ai.common.agent import AgentBase
from ai.common.agent.types import AgentHost, AgentInput, AgentRunResult
from rocketlib import ToolDescriptor, debug, error


class DeepAgentDriver(AgentBase):
    """
    Framework driver that executes single-agent pipelines via the ``deepagents`` library.

    Built on LangChain/LangGraph, the driver layers strategic planning, persistent state,
    and long-context management on top of the standard LangChain agent loop.  It follows
    the RocketRide ``AgentBase`` contract for tool discovery, host-LLM routing, SSE
    progress events, and hierarchical agent-as-tool invocation.

    Class attributes:
        FRAMEWORK: Identifier string used in metadata and logging (``'deepagent'``).
    """

    FRAMEWORK = 'deepagent'

    def __init__(self, iGlobal: Any) -> None:
        """
        Initialise the DeepAgents driver.

        Args:
            iGlobal: The node's ``IGlobal`` instance, forwarded unchanged to ``AgentBase``.

        Returns:
            None
        """
        super().__init__(iGlobal)
        # Read system_prompt at init time alongside agent_description/_instructions
        # (resolved by AgentBase.__init__ via Config.getNodeConfig)
        from ai.common.config import Config

        _config = Config.getNodeConfig(self._iGlobal.glb.logicalType, self._iGlobal.glb.connConfig)
        self._system_prompt: str = (_config.get('system_prompt', '') or '').strip()
        self._description: str = (_config.get('description', '') or '').strip()

    # ------------------------------------------------------------------
    # Bindings — identical to the LangChain driver since deepagents is
    # built on LangChain/LangGraph and shares the same model interface.
    # ------------------------------------------------------------------
    def _bind_framework_llm(
        self,
        *,
        host: AgentHost,
        call_llm: Callable[..., str],
        ctx: dict[str, Any],
    ) -> Any:
        """
        Wrap the RocketRide host LLM in a LangChain ``BaseChatModel``.

        The returned model converts a LangChain message list into a plain-text transcript,
        prepends the JSON tool-call protocol prompt, calls ``call_llm``, and parses the
        response envelope back into a ``ChatResult``.  Up to three attempts are made when
        the LLM produces malformed JSON.

        Args:
            host: The ``AgentHost`` context for the current run (unused here; present for
                interface compatibility).
            call_llm: Callable that accepts a prompt string and optional ``stop_words``
                keyword argument and returns the raw LLM response string.
            ctx: Arbitrary run-context dictionary (unused here; present for interface
                compatibility).

        Returns:
            An instance of the locally-defined ``RocketRideToolCallingChatModel``.
        """
        from langchain_core.language_models import BaseChatModel
        from langchain_core.messages import AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        class RocketRideToolCallingChatModel(BaseChatModel):
            """
            LangChain ``BaseChatModel`` that routes inference through the RocketRide host LLM.

            Tool-calling is implemented via a JSON envelope protocol injected as a system
            prompt, allowing any host LLM (including those without native function-calling
            support) to drive agentic behaviour.
            """

            _bound_tools: list[dict[str, Any]]

            def __init__(self):
                """Initialise the model."""
                super().__init__()
                self._bound_tools: list[dict[str, Any]] = []

            @property
            def _llm_type(self) -> str:
                """Return the LLM type identifier string used by LangChain internals."""
                return 'rocketride-host-llm'

            @property
            def _identifying_params(self) -> dict[str, Any]:
                """Return a dict of identifying parameters for this model instance."""
                return {'framework': 'rocketride', 'adapter': 'tool_calling_json'}

            def bind_tools(self, tools: Any, **kwargs: Any) -> RocketRideToolCallingChatModel:
                """
                Register tools for use with the JSON envelope protocol.

                Args:
                    tools: A single tool or list of tools with ``name``, ``description``,
                        and optional ``args_schema`` / ``_rr_input_schema`` attributes.
                    **kwargs: Ignored; present for LangChain interface compatibility.

                Returns:
                    ``self`` to allow method chaining.
                """
                try:
                    self._bound_tools = _normalize_bound_tools(tools)
                except Exception:
                    self._bound_tools = []
                return self

            def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
                """
                Generate a response for *messages* via the host LLM.

                Converts *messages* to a plain-text transcript, builds the tool-call
                protocol system prompt, and calls the host LLM.  The raw response is
                parsed as a JSON envelope; on failure the raw string is wrapped in an
                ``AIMessage`` fallback.  Up to three retries are attempted with an
                error-correction prompt suffix.

                Args:
                    messages: LangChain message list or any value accepted by
                        ``_langchain_messages_to_transcript``.
                    stop: Optional list of stop-word strings forwarded to the host LLM.
                    run_manager: Ignored; present for LangChain callback compatibility.
                    **kwargs: Ignored extra keyword arguments.

                Returns:
                    A ``ChatResult`` wrapping either a tool-call ``AIMessage`` or a plain
                    ``AIMessage`` with the raw LLM text as its content.
                """
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

                debug('deepagent _generate parse failed after 3 attempts; falling back to plain text')
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content=raw))])

        return RocketRideToolCallingChatModel()

    def _bind_framework_tools(
        self,
        *,
        host: AgentHost,
        tool_descriptors: list[ToolDescriptor],
        invoke_tool: Callable[..., Any],
        log_tool_call: Callable[..., None],
        ctx: dict[str, Any],
    ) -> list[Any]:
        """
        Convert RocketRide tool descriptors into LangChain ``BaseTool`` instances.

        Each descriptor is wrapped in a ``HostTool`` whose ``_run`` method forwards calls
        through ``invoke_tool`` and serialises the result to JSON.  Pydantic argument
        schemas are dynamically generated from the descriptor's ``input_schema`` field
        when available.

        Args:
            host: The ``AgentHost`` context for the current run (unused here; present for
                interface compatibility).
            tool_descriptors: List of ``ToolDescriptor`` dicts describing the
                tools available to the agent.
            invoke_tool: Callable that executes a named host tool and returns its output.
            log_tool_call: Callable invoked after each tool execution for audit logging;
                errors are silently ignored.
            ctx: Arbitrary run-context dictionary (unused here; present for interface
                compatibility).

        Returns:
            A list of LangChain ``BaseTool`` instances ready to be passed to the agent.
        """
        from langchain_core.tools import BaseTool
        from pydantic import BaseModel, ConfigDict, Field, create_model

        class _ToolInput(BaseModel):
            """Default fallback Pydantic model for tools that lack a typed input schema."""

            input: Any = Field(default=None, description='Tool input payload')
            model_config = ConfigDict(extra='allow')

        def _make_args_schema(input_schema: dict[str, Any] | None) -> type[BaseModel]:
            """
            Build a typed Pydantic ``BaseModel`` from a JSON-Schema *input_schema* dict.

            Falls back to ``_ToolInput`` when *input_schema* is ``None``, empty, or
            cannot be parsed.

            Args:
                input_schema: A JSON-Schema dict with optional ``properties`` and
                    ``required`` keys, or ``None``.

            Returns:
                A ``BaseModel`` subclass whose fields mirror *input_schema*, or
                ``_ToolInput`` on any error.
            """
            if not isinstance(input_schema, dict):
                return _ToolInput
            props = input_schema.get('properties', {})
            if not isinstance(props, dict) or not props:
                return _ToolInput
            required_keys = set(input_schema.get('required', []) or [])

            field_defs: dict[str, Any] = {}
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
            """
            LangChain ``BaseTool`` that delegates execution to a RocketRide host tool.

            The ``_run`` method serialises its output to a JSON string so LangChain can
            incorporate it into the agent message history.
            """

            name: str
            description: str
            args_schema: type[BaseModel] = _ToolInput

            def _run(self, input: Any = None, **kwargs: Any) -> str:  # noqa: ANN401, A002
                """
                Execute the host tool and return its result as a JSON string.

                Args:
                    input: Primary positional input payload forwarded to the host tool.
                    **kwargs: Additional keyword arguments forwarded to the host tool.

                Returns:
                    A JSON-encoded string of the tool output, or the raw string
                    representation when JSON serialisation fails.
                """
                tool_name = _safe_str(getattr(self, 'name', ''))

                try:
                    out = invoke_tool(tool_name, input=input, kwargs=kwargs)
                except Exception as e:
                    out = {'error': str(e), 'type': type(e).__name__}

                try:
                    if log_tool_call:
                        log_tool_call(tool_name=tool_name, input={'input': input, **kwargs}, output=out)
                except Exception:
                    pass

                try:
                    return json.dumps(out, default=str) if isinstance(out, (dict, list)) else _safe_str(out)
                except Exception:
                    return _safe_str(out)

        tools: list[Any] = []
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

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------
    def _run(self, *, agent_input: AgentInput, host: AgentHost, ctx: dict[str, Any]) -> AgentRunResult:
        """
        Execute the agent using ``deepagents.create_deep_agent``.

        Discovers host tools, binds the host LLM and tools into LangChain-compatible
        objects, constructs the deep agent, and invokes it with the user's question.
        SSE ``thinking`` events are emitted throughout via ``_SSECallbackHandler``.

        Args:
            agent_input: Encapsulates the user question and run metadata.
            host: Provides access to host LLM and tool invocation services.
            ctx: Arbitrary run-context dictionary forwarded from ``AgentBase.run_agent``.

        Returns:
            A tuple of ``(answer_text, raw_state)`` where *answer_text* is the final
            agent response string and *raw_state* is the raw LangGraph state dict.

        Raises:
            RuntimeError: If ``create_deep_agent`` or ``agent.invoke`` raises, wrapping
                the original error with stage information.
        """
        from deepagents import create_deep_agent
        from langchain_core.callbacks import BaseCallbackHandler
        from langchain_core.messages import AIMessage, HumanMessage

        class _SSECallbackHandler(BaseCallbackHandler):
            """
            LangChain callback handler that forwards agent lifecycle events as SSE messages.

            Each LangChain hook (LLM start/end, tool start/end, agent action/finish)
            emits a ``thinking`` SSE event to the RocketRide UI via the provided
            ``send_sse`` callable.
            """

            def __init__(self, send_sse: Callable[..., Any]) -> None:
                """
                Initialise the handler with an SSE emitter.

                Args:
                    send_sse: Callable matching ``AgentBase.sendSSE(type, **data)``
                        used to push progress events to the UI.

                Returns:
                    None
                """
                super().__init__()
                self._send_sse = send_sse

            def on_tool_start(self, serialized: Any, input_str: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when a tool begins execution.

                Args:
                    serialized: LangChain serialised tool descriptor dict (may be ``None``).
                    input_str: Raw input string passed to the tool.
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                tool_name = (serialized or {}).get('name', '') or 'tool'
                input_len = len(_safe_str(input_str))
                self._send_sse('thinking', message=f'Calling {tool_name}...', tool=tool_name, input_length=input_len)

            def on_tool_end(self, output: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when a tool finishes successfully.

                Args:
                    output: Tool output value (ignored; event carries a fixed message).
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='Tool complete')

            def on_tool_error(self, error: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when a tool raises an error.

                Args:
                    error: The exception or error value raised by the tool.
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='Tool error', error_type=type(error).__name__)

            def on_agent_action(self, action: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when the agent selects an action.

                Args:
                    action: The ``AgentAction`` chosen by the agent (ignored).
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='Agent thinking...')

            def on_agent_finish(self, finish: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when the agent produces its final answer.

                Args:
                    finish: The ``AgentFinish`` value (ignored).
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='Agent done')

            def on_llm_start(self, serialized: Any, prompts: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when a non-chat LLM call begins.

                Args:
                    serialized: LangChain serialised LLM descriptor (ignored).
                    prompts: List of prompt strings sent to the LLM (ignored).
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='LLM call started')

            def on_chat_model_start(self, serialized: Any, messages: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when a chat-model LLM call begins.

                Args:
                    serialized: LangChain serialised chat-model descriptor (ignored).
                    messages: Nested list of ``BaseMessage`` objects sent to the model
                        (ignored).
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='LLM call started')

            def on_llm_end(self, response: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when an LLM call completes.

                Args:
                    response: ``LLMResult`` returned by the model (ignored).
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='LLM call completed')

            def on_llm_error(self, error: Any, **kwargs: Any) -> None:
                """
                Emit an SSE event when an LLM call raises an error.

                Args:
                    error: The exception or error value raised by the LLM.
                    **kwargs: Additional LangChain callback keyword arguments (ignored).

                Returns:
                    None
                """
                self._send_sse('thinking', message='LLM error', error_type=type(error).__name__)

        tool_descriptors = self.discover_tools(host=host)
        self.sendSSE('thinking', message=f'Discovered {len(tool_descriptors)} host tool(s)')
        from rocketlib import debug as _debug

        _debug(f'deepagent _run discovered {len(tool_descriptors)} tools: {[td.get("name") if hasattr(td, "get") else str(td) for td in tool_descriptors]}')

        def _call_llm(messages: Any, stop_words: Any = None) -> str:
            """
            Forward a prompt to the host LLM via ``AgentBase.call_host_llm``.

            Args:
                messages: Prompt string or message list to send to the host LLM.
                stop_words: Optional stop-word list forwarded verbatim.

            Returns:
                The raw response string from the host LLM.
            """
            return self.call_host_llm(
                host=host,
                messages=messages,
                question_role='You are a helpful assistant.',
                stop_words=stop_words,
            )

        def _invoke_tool(tool_name: str, input: Any = None, kwargs: dict[str, Any] | None = None) -> Any:  # noqa: A002
            """
            Forward a tool invocation request to the host via ``AgentBase.invoke_host_tool``.

            Args:
                tool_name: The fully-qualified name of the tool to invoke.
                input: Primary positional input forwarded to the tool.
                kwargs: Additional keyword arguments forwarded to the tool.

            Returns:
                The raw output returned by the host tool.
            """
            return self.invoke_host_tool(host=host, tool_name=tool_name, input=input, kwargs=kwargs)

        def _log_tool_call(tool_name: str, input: Any = None, output: Any = None) -> None:  # noqa: A002
            """Log a tool invocation at debug level for audit and tracing.

            Args:
                tool_name: The fully-qualified name of the tool that was invoked.
                input: The input payload passed to the tool.
                output: The output returned by the tool.

            Returns:
                None
            """
            debug(f'deep agent tool call tool={tool_name} input_len={len(_safe_str(input))} output_len={len(_safe_str(output))}')

        llm = self._bind_framework_llm(host=host, call_llm=_call_llm, ctx=ctx)
        tools_for_agent = self._bind_framework_tools(
            host=host,
            tool_descriptors=tool_descriptors,
            invoke_tool=_invoke_tool,
            log_tool_call=_log_tool_call,
            ctx=ctx,
        )

        system_prompt = _compose_system_prompt(
            base=self._system_prompt,
            instructions=self._instructions,
            fallback='You are an agent node in a tool-invocation hierarchy.\nUse the provided tools when needed.',
        )

        # Fan out deepagent.describe to any connected sub-agent nodes
        subagents_list = self._collect_subagents(host=host, ctx=ctx, log_tool_call=_log_tool_call)
        if subagents_list:
            self.sendSSE('thinking', message=f'Collected {len(subagents_list)} sub-agent(s)')

        debug(f'deep agent create system_prompt_len={len(system_prompt)} tools={len(tools_for_agent)} subagents={len(subagents_list)}')

        self.sendSSE('thinking', message='Starting Deep Agent...')
        stage = 'create_deep_agent'
        try:
            agent = create_deep_agent(
                model=llm,
                tools=tools_for_agent,
                system_prompt=system_prompt,
                subagents=subagents_list if subagents_list else None,
            )
            stage = 'invoke'
            state = agent.invoke(
                {'messages': [HumanMessage(content=_safe_str(agent_input.question.getPrompt() or ''))]},
                config={'callbacks': [_SSECallbackHandler(self.sendSSE)]},
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

    def _collect_subagents(
        self,
        *,
        host: AgentHost,
        ctx: dict[str, Any],
        log_tool_call: Any,
    ) -> list[Any]:
        """
        Fan out ``deepagent.describe`` to all nodes on the ``deepagent`` invoke channel
        and return a list of ``SubAgent`` TypedDicts ready for ``create_deep_agent``.

        For each responding sub-agent, an ``AgentHostServices`` is created from the
        sub-agent's own ``pSelf`` so its LLM and tools are routed through its own
        engine channels independently of the orchestrator's.

        Args:
            host: The orchestrator's host services (unused here but kept for consistency).
            ctx: Run-context dict forwarded from ``_run``.
            log_tool_call: Debug logging callable forwarded to ``_bind_framework_tools``.

        Returns:
            A (possibly empty) list of ``deepagents.middleware.subagents.SubAgent`` dicts.
        """
        from rocketlib.types import IInvokeDeepagent
        from ai.common.agent._internal.host import AgentHostServices

        if not self._invoker:
            return []

        try:
            deepagent_node_ids = self._invoker.instance.getControllerNodeIds('deepagent')
        except Exception:
            return []

        if not deepagent_node_ids:
            return []

        from deepagents.middleware.subagents import SubAgent as _SubAgent  # noqa: PLC0415

        subagents: list[Any] = []
        for node_id in deepagent_node_ids:
            req = IInvokeDeepagent.Describe()
            try:
                self._invoker.instance.invoke('deepagent', req, nodeId=node_id)
            except Exception:
                pass

            for d in req.agents:
                if d is None:
                    continue
                try:
                    sa_host = AgentHostServices(d.invoke)

                    def _sa_call_llm(messages: Any, stop_words: Any = None, _h: Any = sa_host) -> str:
                        return self.call_host_llm(
                            host=_h,
                            messages=messages,
                            question_role='You are a helpful assistant.',
                            stop_words=stop_words,
                        )

                    sa_llm = self._bind_framework_llm(host=sa_host, call_llm=_sa_call_llm, ctx=ctx)
                    sa_tool_descriptors = sa_host.tools.query()

                    def _sa_invoke_tool(tool_name: str, input: Any = None, kwargs: Any = None, _h: Any = sa_host) -> Any:  # noqa: A002
                        return self.invoke_host_tool(host=_h, tool_name=tool_name, input=input, kwargs=kwargs)

                    sa_tools = self._bind_framework_tools(
                        host=sa_host,
                        tool_descriptors=sa_tool_descriptors,
                        invoke_tool=_sa_invoke_tool,
                        log_tool_call=log_tool_call,
                        ctx=ctx,
                    )

                    subagents.append(
                        _SubAgent(
                            name=d.name,
                            description=d.description or d.name,
                            system_prompt=_compose_system_prompt(
                                base=d.system_prompt,
                                instructions=d.instructions,
                                fallback='You are a helpful sub-agent. Use your tools to complete the assigned task.',
                            ),
                            tools=sa_tools,
                            model=sa_llm,
                        )
                    )
                except Exception as e:
                    error(f'deep agent collect_subagents failed for node={node_id}: {type(e).__name__}: {_safe_str(e)}')

        return subagents


class DeepAgentSubagentDriver(DeepAgentDriver):
    """
    Sub-agent node driver for ``agent_deepagent_subagent``.

    Behaviorally identical to ``DeepAgentDriver`` — runs a single ``create_deep_agent``
    invocation with its own LLM and tools.  Registered under the
    ``agent_deepagent_subagent`` logical type so it can be wired on an orchestrator's
    ``deepagent`` invoke channel.

    Does not fan out on a ``deepagent`` channel (no such channel on this node type).
    """

    FRAMEWORK = 'deepagent_subagent'


# ------------------------------------------------------------------
# Helpers (shared with LangChain driver pattern)
# ------------------------------------------------------------------
def _tool_call_protocol_prompt(bound_tools: list[dict[str, Any]]) -> str:
    """
    Build the system-prompt preamble that instructs the LLM to output a JSON envelope.

    The returned string is prepended to the message transcript before every LLM call so
    that models without native tool-calling support can still drive agentic behaviour via
    the ``{"type":"tool_call",...}`` / ``{"type":"final",...}`` envelope schema.

    Args:
        bound_tools: List of tool descriptor dicts (``name``, ``description``,
            ``args_schema``, optional ``input_schema``) to advertise to the LLM.

    Returns:
        A newline-joined string of ``system:`` directives ready to prepend to the
        conversation transcript.
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


def _normalize_bound_tools(tools: Any) -> list[dict[str, Any]]:
    """
    Normalise a LangChain tool or list of tools into plain descriptor dicts.

    Each dict contains ``name``, ``description``, ``args_schema`` (string repr), and
    optionally ``input_schema`` (the original JSON-Schema dict stored on the tool as
    ``_rr_input_schema``).

    Args:
        tools: A single LangChain tool object or a list of them.  Any falsy value
            returns an empty list.

    Returns:
        A list of ``dict`` objects suitable for use with ``_tool_call_protocol_prompt``.
    """
    if not tools:
        return []
    if not isinstance(tools, list):
        tools = [tools]

    out: list[dict[str, Any]] = []
    for t in tools:
        schema = getattr(t, 'args_schema', None)
        input_schema = getattr(t, '_rr_input_schema', None)

        entry: dict[str, Any] = {
            'name': _safe_str(getattr(t, 'name', '')),
            'description': _safe_str(getattr(t, 'description', '')),
            'args_schema': _tool_args_schema(schema),
        }
        if isinstance(input_schema, dict):
            entry['input_schema'] = input_schema
        out.append(entry)
    return out


def _tool_args_schema(schema: Any) -> Any:
    """
    Return a JSON-Schema dict for a tool's ``args_schema``, or a string fallback.

    Pydantic v2 models expose ``model_json_schema()``; older models expose ``schema()``.
    When neither works, falls back to ``str(schema)`` so the LLM still sees *something*
    identifying the expected shape.

    Args:
        schema: The ``args_schema`` attribute from a LangChain tool — typically a
            pydantic model class, or ``None``.

    Returns:
        A JSON-Schema ``dict`` when extractable, otherwise the string representation.
    """
    if schema is None:
        return ''
    for attr in ('model_json_schema', 'schema'):
        fn = getattr(schema, attr, None)
        if callable(fn):
            try:
                result = fn()
                if isinstance(result, dict):
                    return result
            except Exception:
                continue
    return _safe_str(schema)


def _langchain_messages_to_transcript(messages: Any) -> str:
    """
    Convert a LangChain message list (or plain string/dict) into a plain-text transcript.

    Each message is rendered as ``"<role>: <content>"`` on its own line.  Unknown message
    types fall back to the ``user`` role.  Non-list inputs are handled gracefully:
    ``None`` → ``''``, ``str`` → as-is, ``dict`` → JSON string.

    Args:
        messages: A LangChain message list, a plain string, a dict, or ``None``.

    Returns:
        A single newline-joined string representing the conversation transcript, or an
        empty string when conversion fails entirely.
    """
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

    lines: list[str] = []
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
    """
    Parse a raw LLM response string as a JSON tool-call or final-answer envelope.

    Understands two envelope shapes:

    * ``{"type": "tool_call", "name": "...", "args": {...}}`` — converted to a
      LangChain ``AIMessage`` with ``tool_calls``.
    * ``{"type": "final", "content": "..."}`` — converted to a plain ``AIMessage``.

    Args:
        raw: The raw string returned by the LLM; expected to be a single JSON object.

    Returns:
        A LangChain ``AIMessage`` on success, or ``None`` when *raw* is not valid JSON,
        has an unrecognised ``type`` value, or the required fields are absent.
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
        return AIMessage(content=_safe_str(obj.get('content', '')))

    if msg_type == 'tool_call':
        name = _safe_str(obj.get('name', '')).strip()
        if not name:
            return None
        args = obj.get('args') or {}
        if not isinstance(args, dict):
            args = {'input': args}

        tool_call = {'id': f'call_{uuid.uuid4().hex[:12]}', 'type': 'tool_call', 'name': name, 'args': args}
        return AIMessage(content='', tool_calls=[tool_call])

    return None


def _compose_system_prompt(*, base: str | None, instructions: list[str] | None, fallback: str) -> str:
    """
    Combine a base system prompt with trailing instruction lines.

    Used by both the manager (``DeepAgentDriver._run``) and the sub-agent collector
    (``_collect_subagents``) so the two paths produce prompts in an identical shape:

    * Start with *base* (stripped); fall back to *fallback* when *base* is empty.
    * Append each non-empty instruction on its own line.

    Args:
        base: The primary system prompt string, or ``None``/empty for the fallback.
        instructions: Optional list of instruction lines to append.
        fallback: Default prompt text used when *base* is empty after stripping.

    Returns:
        A single system-prompt string ready to hand to ``create_deep_agent``.
    """
    prompt = (base or '').strip() or fallback
    for inst in instructions or []:
        inst = inst.strip()
        if inst:
            prompt = f'{prompt}\n{inst}'
    return prompt


def _extract_first_json_object(raw: str) -> Any:
    """
    Extract the first balanced JSON object from a raw LLM response.

    Handles the common failure modes we've seen from host LLMs producing the
    tool-call envelope — extra prose, markdown fences, or a second JSON object
    appended after the first one closes (e.g. a duplicate tool call or a
    hallucinated final answer). Returns just the first object so the parser
    can build a valid ``AIMessage`` instead of failing the whole envelope.

    Tolerates:
      * Leading/trailing whitespace or prose
      * Markdown code fences (```json ... ```)
      * Trailing content after the first closing brace
      * Multiple concatenated JSON objects (returns only the first)

    Args:
        raw: The raw string returned by the LLM.

    Returns:
        The decoded first JSON object, or ``None`` if none can be parsed.
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


def _safe_str(v: Any) -> str:
    """
    Safely convert any value to a string without raising.

    Args:
        v: Any value, including ``None``.

    Returns:
        The string representation of *v*, or ``''`` if *v* is ``None`` or if
        ``str(v)`` raises an exception.
    """
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''
