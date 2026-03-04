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

from .types import AgentHost, AgentInput
from ._internal.host import AgentHostServices
from ._internal.agent_tool import handle_agent_tool_invoke
from ._internal.trace import make_tracing_invoker
from ._internal.utils import (
    apply_node_instructions,
    extract_prompt,
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

    # ---------------------------------------------------------------------
    # Pipeline-facing entrypoint
    # ---------------------------------------------------------------------
    def run_agent(
        self,
        pSelf: Any,
        question: Question,
        *,
        emit_answers_lane: bool = True,
    ) -> Any:
        """
        Execute a single agent run for a pipeline `Question`.

        This method builds an `AgentInput`, delegates execution to `_run(...)`, and
        writes a single JSON payload to the answers lane (`Answer(expectJson=True)`).

        Args:
            pSelf: Node instance (`IInstance`) provided by the engine.
            question: Incoming question object from the questions lane.
            emit_answers_lane: If True, write the answer JSON to the answers lane.

        Returns:
            The answer JSON payload (same object written to the answers lane).
        """
        started_at = now_iso()
        run_id = new_run_id()
        debug(f'agent base run_agent run_id={run_id} framework={self.FRAMEWORK}')

        invoker, tool_calls = make_tracing_invoker(pSelf.instance.invoke)

        def _json_safe(value: Any) -> Any:
            """
            Convert `value` into JSON-safe primitives (best-effort).
            """
            try:
                return json.loads(json.dumps(value, default=str))
            except Exception:
                return safe_str(value)

        try:
            apply_node_instructions(question, pSelf)
            prompt = extract_prompt(question)
            task_id = self._get_task_id(pSelf)

            agent_input = AgentInput(
                prompt=prompt,
                question=question,
                run_id=run_id,
                task_id=task_id,
                started_at=started_at,
            )

            host = AgentHostServices(invoker)
            runtime_ctx = {'run_id': run_id, 'task_id': task_id, 'framework': self.FRAMEWORK}

            content, raw = self._run(agent_input=agent_input, host=host, ctx=runtime_ctx)
            if not isinstance(content, str):
                content = safe_str(content)

            ended_at = now_iso()
            answer_payload: Dict[str, Any] = {
                'content': content,
                'meta': {
                    'framework': self.FRAMEWORK,
                    'agent_id': self._agent_id(pSelf),
                    'run_id': run_id,
                    'started_at': started_at,
                    'ended_at': ended_at,
                },
                'stack': [],
            }
            if task_id:
                answer_payload['meta']['task_id'] = task_id

            stack: List[Dict[str, Any]] = []
            if tool_calls:
                stack.append(
                    {
                        'kind': 'RocketRide.agent.tool_calls.v1',
                        'name': 'host.tools',
                        'payload': _json_safe(tool_calls),
                    }
                )
            stack.append({'kind': 'RocketRide.agent.raw.v1', 'name': 'framework.output', 'payload': _json_safe(raw)})
            answer_payload['stack'] = stack

            debug(f'agent base _run completed run_id={run_id} content_len={len(content or "")}')

        except Exception as e:
            error_type = type(e).__name__
            error_message = str(e)
            error(f'agent base _run failed run_id={run_id} type={error_type} message={error_message}')
            ended_at = now_iso()
            task_id = safe_str(self._get_task_id(pSelf)) or None
            answer_payload = {
                'content': error_message or f'{error_type} (no message)',
                'meta': {
                    'framework': self.FRAMEWORK,
                    'agent_id': self._agent_id(pSelf),
                    'run_id': run_id,
                    'started_at': started_at,
                    'ended_at': ended_at,
                    **({'task_id': task_id} if task_id else {}),
                },
                'stack': [],
            }
            stack = []
            if tool_calls:
                stack.append(
                    {'kind': 'RocketRide.agent.tool_calls.v1', 'name': 'host.tools', 'payload': _json_safe(tool_calls)}
                )
            stack.append(
                {'kind': 'RocketRide.agent.error.v1', 'name': 'exception', 'payload': {'type': error_type, 'message': error_message}}
            )
            answer_payload['stack'] = stack

        if emit_answers_lane:
            debug(
                'agent base emitting answer'
                f' run_id={answer_payload.get("meta", {}).get("run_id")} framework={answer_payload.get("meta", {}).get("framework")}'
            )
            answer = Answer(expectJson=False)
            answer.setAnswer(answer_payload.get('content', ''))
            pSelf.instance.writeAnswers(answer)

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
    def _agent_id(self, pSelf: Any) -> str:
        """Return the logical agent identifier used in answer metadata."""
        try:
            glb = getattr(pSelf, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self.__class__.__name__

    def _get_task_id(self, pSelf: Any) -> Optional[str]:
        """Return the engine taskId if present in job configuration."""
        try:
            endpoint = getattr(pSelf, 'IEndpoint', None)
            eng = getattr(endpoint, 'endpoint', None)
            job_cfg = getattr(eng, 'jobConfig', None)
            if isinstance(job_cfg, dict):
                task_id = job_cfg.get('taskId')
                return str(task_id) if task_id else None
        except Exception:
            return None
        return None
