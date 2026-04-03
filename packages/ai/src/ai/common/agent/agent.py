"""
Agent base class (framework-agnostic pipeline boundary) implemented as a shared driver.

Implements the agent pipeline entrypoint (`run_agent`) and exposes framework drivers
to host services via two control-plane seams:
- `invoke("llm", IInvokeLLM(op="ask", ...))`
- `invoke("tool", IInvokeTool.*)`

Framework nodes subclass `AgentBase` and implement `_run(...)` plus binding hooks for
their specific tool/LLM integration.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional

from rocketlib import debug, error
from ai.common.schema import Answer, Question
from ai.common.config import Config

from .types import AgentHost, AgentInput
from ._internal.host import AgentHostServices
from ._internal.agent_tool import handle_agent_tool_invoke
from ._internal.utils import (
    extract_text,
    messages_to_transcript,
    now_iso,
    new_run_id,
    normalize_invocation_payload,
    safe_str,
    truncate_at_stop_words,
)
from rocketlib import ToolDescriptor


class AgentBase(ABC):
    """
    Base class for all agent framework drivers.

    Drivers implement `_run(...)` to execute their framework internals.
    """

    FRAMEWORK: str = 'unknown'
    _AGENT_TOOL_NAME: str = 'run_agent'

    _host: Optional[AgentHostServices] = None
    _invoker: Any = None

    def __init__(
        self,
        iGlobal: Any,
    ):
        """
        Initialize be saving containing IInstance, and gathering tools
        """
        # Save the containing IInstance
        self._iGlobal = iGlobal

        # Get the logical type (nodeId) of our invoker
        self._node_id = self._iGlobal.glb.logicalType

        # Retrieve node-specific configuration by using the logical type and
        # the connection configuration from the global context.
        # Config.getNodeConfig likely returns structured config data tailored
        # for this node instance.
        config = Config.getNodeConfig(self._iGlobal.glb.logicalType, self._iGlobal.glb.connConfig)

        # And save any specific instructions
        self._instructions = config.get('instructions', [])
        self._agent_description = config.get('agent_description', '') or ''

    # ---------------------------------------------------------------------
    # Pipeline-facing entrypoint
    # ---------------------------------------------------------------------
    def run_agent(
        self,
        iInstance,
        question: Question,
        *,
        host: Optional[AgentHostServices] = None,
        emit_answers_lane: bool = True,
    ) -> Any:
        """
        Execute a single agent run for a pipeline `Question`.

        This method builds an `AgentInput`, delegates execution to `_run(...)`, and
        writes a single JSON payload to the answers lane (`Answer(expectJson=True)`).

        Args:
            iInstance: Node instance (`IInstance`) provided by the engine.
            question: Incoming question object from the questions lane.
            emit_answers_lane: If True, write the answer JSON to the answers lane.

        Returns:
            The answer JSON payload (same object written to the answers lane).
        """
        started_at = now_iso()
        run_id = new_run_id()
        debug(f'agent base run_agent run_id={run_id} framework={self.FRAMEWORK}')

        # Use provided host (per-instance, e.g. from IInstance.beginInstance),
        # or create one lazily if not provided.
        if host is not None:
            self._host = host
        elif not self._host:
            self._host = AgentHostServices(iInstance)

        def _json_safe(value: Any) -> Any:
            """
            Convert `value` into JSON-safe primitives (best-effort).
            """
            try:
                return json.loads(json.dumps(value, default=str))
            except Exception:
                return safe_str(value)

        task_id = None
        try:
            # Add any global instructions from the config
            for inst in self._instructions:
                question.addInstruction('Additional Instruction', inst.strip())

            # Get the jobs taskId
            task_id = iInstance.IEndpoint.endpoint.jobConfig['taskId']

            # Create the input we will send to the agent
            agent_input = AgentInput(
                question=question,
                run_id=run_id,
                task_id=task_id,
                started_at=started_at,
            )

            # Save the invoker so sendSSE() can delegate to self.instance.sendSSE()
            self._invoker = iInstance

            # Build up the context so we know what we are doing
            pipe_id = iInstance.instance.pipeId if iInstance and iInstance.instance else 0
            runtime_ctx = {'run_id': run_id, 'task_id': task_id, 'framework': self.FRAMEWORK, 'pipe_id': pipe_id}

            # And execute
            content, raw = self._run(
                agent_input=agent_input,
                host=self._host,
                ctx=runtime_ctx,
            )

            if not isinstance(content, str):
                content = safe_str(content)

            ended_at = now_iso()

            answer_payload: Dict[str, Any] = {
                'content': content,
                'meta': {
                    'framework': self.FRAMEWORK,
                    'agent_id': self._agent_id(iInstance),
                    'run_id': run_id,
                    'started_at': started_at,
                    'ended_at': ended_at,
                },
                'stack': [],
            }
            if task_id:
                answer_payload['meta']['task_id'] = task_id

            stack: List[Dict[str, Any]] = []
            stack.append({'kind': 'RocketRide.agent.raw.v1', 'name': 'framework.output', 'payload': _json_safe(raw)})
            answer_payload['stack'] = stack

            debug(f'agent base _run completed run_id={run_id} content_len={len(content or "")}')

        except Exception as e:
            error_type = type(e).__name__
            error_message = str(e)
            error(f'agent base _run failed run_id={run_id} type={error_type} message={error_message}')
            ended_at = now_iso()
            answer_payload = {
                'content': error_message or f'{error_type} (no message)',
                'meta': {
                    'framework': self.FRAMEWORK,
                    'agent_id': self._agent_id(iInstance),
                    'run_id': run_id,
                    'started_at': started_at,
                    'ended_at': ended_at,
                    **({'task_id': task_id} if task_id else {}),
                },
                'stack': [],
            }
            stack = []
            stack.append({'kind': 'RocketRide.agent.error.v1', 'name': 'exception', 'payload': {'type': error_type, 'message': error_message}})
            answer_payload['stack'] = stack

        if emit_answers_lane:
            debug(f'agent base emitting answer run_id={answer_payload.get("meta", {}).get("run_id")} framework={answer_payload.get("meta", {}).get("framework")}')
            answer = Answer(expectJson=False)
            answer.setAnswer(answer_payload.get('content', ''))
            iInstance.instance.writeAnswers(answer)

        return answer_payload

    # ---------------------------------------------------------------------
    # Abstract hook: framework run
    # ---------------------------------------------------------------------
    @abstractmethod
    def _run(self, *, agent_input: AgentInput, host: AgentHost, ctx: Dict[str, Any]) -> tuple[str, Any]:
        """
        Run the framework-specific agent execution.

        Drivers return a tuple of:
        - content: final user-facing text
        - raw: framework-native output object/state for trace/debugging
        """
        raise NotImplementedError

    # ---------------------------------------------------------------------
    # Framework-facing host operations
    # ---------------------------------------------------------------------
    def discover_tools(self, *, host: AgentHost) -> List[ToolDescriptor]:
        """
        Discover available tools for framework drivers to expose.

        Returns:
            A list of tool descriptors as returned by the tool query seam.
        """
        try:
            catalog = host.tools.query()
        except Exception as e:
            catalog = {'error': str(e), 'type': type(e).__name__}
        tools_attr = getattr(catalog, 'tools', None)
        if isinstance(tools_attr, list):
            return tools_attr
        if isinstance(catalog, dict) and isinstance(catalog.get('tools'), list):
            return catalog.get('tools')
        if isinstance(catalog, list):
            return catalog
        return []

    def invoke_host_tool(
        self,
        *,
        host: AgentHost,
        tool_name: str,
        input: Any = None,  # noqa: A002
        kwargs: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """
        Invoke a host tool after normalizing invocation payload shapes.

        Args:
            host: Host tools interface.
            tool_name: Tool name as published by discovery.
            input: Positional tool input payload (framework-dependent).
            kwargs: Extra keyword arguments captured by a framework tool wrapper.

        Returns:
            Tool output object returned by the underlying tool provider.
        """
        payload = normalize_invocation_payload(input=input, kwargs=kwargs)
        return host.tools.invoke(tool_name, payload)

    def call_host_llm(
        self,
        *,
        host: AgentHost,
        messages: Any,
        question_role: str,
        stop_words: Any = None,
    ) -> str:
        """
        Call the host LLM and return extracted text.

        Args:
            host: Host LLM interface.
            messages: Framework-provided message(s) used to build a transcript.
            question_role: Role/persona string passed into the `Question`.
            stop_words: Optional stop word list used to truncate returned text.

        Returns:
            Extracted model text, optionally truncated by stop words.
        """
        from rocketlib.types import IInvokeLLM

        transcript = messages_to_transcript(messages)
        q = Question(role=question_role)
        q.addQuestion(transcript)
        result = host.llm.invoke(IInvokeLLM(op='ask', question=q))
        text = extract_text(result)
        return truncate_at_stop_words(text, stop_words)

    # ---------------------------------------------------------------------
    # Framework binding hooks (framework drivers implement these)
    # ---------------------------------------------------------------------
    @abstractmethod
    def _bind_framework_llm(
        self,
        *,
        host: AgentHost,
        call_llm: Callable[..., str],
        ctx: Dict[str, Any],
    ) -> Any:
        raise NotImplementedError

    @abstractmethod
    def _bind_framework_tools(
        self,
        *,
        host: AgentHost,
        tool_descriptors: List[ToolDescriptor],
        invoke_tool: Callable[..., Any],
        log_tool_call: Callable[..., None],
        ctx: Dict[str, Any],
    ) -> List[Any]:
        raise NotImplementedError

    # ---------------------------------------------------------------------
    # Tool-provider surface (agent-as-tool)
    # ---------------------------------------------------------------------
    def handle_invoke(self, pSelf: Any, param: Any) -> Any:
        """
        Handle tool control-plane operations when this agent is exposed as a tool.

        This is the node-facing entrypoint for `tool.query`/`tool.validate`/`tool.invoke`
        for the agent-as-tool adapter.
        """
        return handle_agent_tool_invoke(agent=self, pSelf=pSelf, param=param)

    # ---------------------------------------------------------------------
    # Engine utilities
    # ---------------------------------------------------------------------
    def sendSSE(self, type: str, **data) -> None:
        """
        Send a real-time SSE status update to the UI for this agent's pipe.

        Delegates to ``self._invoker.instance.sendSSE()`` using the invoker
        captured at the start of the current ``run_agent`` invocation.
        Safe to call from ``_run`` or any helper it delegates to.

        Args:
            type:    Event type string (e.g. 'thinking', 'acting', 'confirm').
            **data:  Keyword arguments included as the event data payload.
        """
        if self._invoker and self._invoker.instance:
            self._invoker.instance.sendSSE(type, **data)

    def _agent_id(self, pSelf: Any) -> str:
        """Return the logical agent identifier used in answer metadata."""
        try:
            glb = getattr(pSelf, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self.__class__.__name__
