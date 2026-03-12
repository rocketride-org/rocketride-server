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

from rocketlib import debug, error, monitorSSE
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
from ai.common.tools import ToolsBase


class AgentBase(ABC):
    """
    Base class for all agent framework drivers.

    Drivers implement `_run(...)` to execute their framework internals.
    """

    FRAMEWORK: str = 'unknown'
    _AGENT_TOOL_NAME: str = 'run_agent'

    _host: Optional[AgentHostServices] = None
    _pipe_id: int = 0

    def __init__(
        self,
        iGlobal: Any,
    ):
        """
        Initialize the agent with the global runtime/context and load node-specific configuration.
        
        This sets up internal state used by the agent driver:
        - stores the provided global context on `self._iGlobal`
        - derives the node identifier from `iGlobal.glb.logicalType` and stores it on `self._node_id`
        - loads the node configuration via `Config.getNodeConfig(logicalType, connConfig)`
        - extracts and stores any per-node `instructions` (defaults to an empty list) on `self._instructions`
        
        Parameters:
            iGlobal (Any): Global runtime/context object exposing `glb.logicalType` and `glb.connConfig`.
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

    # ---------------------------------------------------------------------
    # Pipeline-facing entrypoint
    # ---------------------------------------------------------------------
    def run_agent(
        self,
        iInstance,
        question: Question,
        *,
        emit_answers_lane: bool = True,
    ) -> Any:
        """
        Run the agent for a single Question and produce a structured answer payload.
        
        Builds an AgentInput containing run metadata and any configured node instructions, delegates execution to the framework-specific _run(...) hook, and assembles a payload with `content`, `meta` (including framework, agent_id, run_id, timestamps, and optional task_id), and a `stack` entry with the raw framework output. If `emit_answers_lane` is True, the payload's content is written to the instance's answers lane.
        
        Parameters:
            iInstance: Engine-provided node instance (IInstance) used for host context, endpoint/job metadata, and writing answers.
            question (Question): Incoming question from the questions lane; node-level instructions from config are appended to it before execution.
            emit_answers_lane (bool): If True, write the answer content to the answers lane via iInstance.instance.writeAnswers.
        
        Returns:
            dict: The assembled answer payload containing `content`, `meta`, and `stack`.
        """
        started_at = now_iso()
        run_id = new_run_id()
        debug(f'agent base run_agent run_id={run_id} framework={self.FRAMEWORK}')

        # If we have not created the host info yet, do so now. It is the same
        # for all instances of the pipe
        if not self._host:
            self._host = AgentHostServices(iInstance)

        def _json_safe(value: Any) -> Any:
            """
            Produce a JSON-serializable representation of `value` by converting non-serializable parts to strings.
            
            Parameters:
                value (Any): The object to convert to JSON-safe primitives.
            
            Returns:
                Any: A JSON-serializable equivalent of `value`; if serialization fails, a string representation of `value`.
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

            # Capture pipe_id from the instance so sendSSE() can use it
            try:
                self._pipe_id = iInstance.instance.pipeId
            except Exception:
                self._pipe_id = 0

            # Build up the context so we know what we are doing
            runtime_ctx = {'run_id': run_id, 'task_id': task_id, 'framework': self.FRAMEWORK, 'pipe_id': self._pipe_id}

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
    def _discover_tools(self, *, host: AgentHost) -> List[ToolsBase.ToolDescriptor]:
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

    def _invoke_host_tool(
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

    def _call_host_llm(
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
        tool_descriptors: List[ToolsBase.ToolDescriptor],
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
    def sendSSE(self, type: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
        """
        Send a real-time SSE status update to the UI for this agent's pipe.

        Wraps ``monitorSSE`` using the ``pipe_id`` captured at the start of
        the current ``run_agent`` invocation.  Safe to call from ``_run`` or
        any helper it delegates to.

        Args:
            type:    Event type ('thinking', 'acting', 'confirm').
            message: Human-readable status string shown in the chat UI.
            data:    Optional structured payload included in the event body.
        """
        monitorSSE(self._pipe_id, type, message, data)

    def _agent_id(self, pSelf: Any) -> str:
        """
        Get the logical agent identifier for answer metadata.
        
        Attempts to read `pSelf.IGlobal.glb.logicalType` and returns it as a string; if that value is missing or an error occurs, returns the class name of `self`.
        
        Parameters:
            pSelf (Any): The agent instance or wrapper from which to derive the logical type.
        
        Returns:
            str: The agent identifier to include in answer metadata.
        """
        try:
            glb = getattr(pSelf, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self.__class__.__name__
