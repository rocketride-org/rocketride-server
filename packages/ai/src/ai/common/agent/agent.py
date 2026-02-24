"""
Agent base class (framework-agnostic pipeline boundary) implemented as a shared driver.

This mirrors the `ai.common.store` pattern:
- `run_agent(...)` is the shared wrapper (normalization, tracing, envelope shaping)
- `_run(...)` is the abstract hook implemented by framework drivers (CrewAI, etc.)
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional

from rocketlib import debug, error
from ai.common.schema import Answer, Question

from .types import AgentEnvelope, AgentHost, AgentInput, AgentRunResult
from ._internal.envelope import failed_envelope, to_envelope
from ._internal.host import AgentHostServices
from ._internal.trace import attach_tool_calls_artifact, make_tracing_invoker
from ._internal.utils import (
    extract_continuation,
    extract_prompt,
    extract_tool_names,
    get_field,
    is_agent_run_tool_name,
    now_iso,
    new_run_id,
    safe_str,
    set_field,
    split_namespaced_tool_name,
)


class Agent(ABC):
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
    ) -> AgentEnvelope:
        started_at = now_iso()
        run_id = new_run_id()
        debug(f'agent base run_agent run_id={run_id} framework={self.FRAMEWORK}')

        invoker, tool_calls = make_tracing_invoker(pSelf.instance.invoke)

        try:
            prompt = extract_prompt(question)
            continuation = extract_continuation(getattr(question, 'context', None))
            task_id = self._get_task_id(pSelf)

            agent_input = AgentInput(
                prompt=prompt,
                question=question,
                continuation=continuation,
                run_id=run_id,
                task_id=task_id,
                started_at=started_at,
            )

            host = AgentHostServices(invoker)
            runtime_ctx = {'run_id': run_id, 'task_id': task_id, 'framework': self.FRAMEWORK}

            raw_result = self._run(agent_input=agent_input, host=host, ctx=runtime_ctx)

            envelope = to_envelope(
                framework=self.FRAMEWORK,
                agent_id=self._agent_id(pSelf),
                run_id=run_id,
                task_id=task_id,
                started_at=started_at,
                ended_at=now_iso(),
                continuation=continuation,
                raw_result=raw_result,
            )
            status = envelope.get('status', '')
            debug(f'agent base _run completed run_id={run_id} status={status}')

        except Exception as e:
            error_type = type(e).__name__
            error_message = str(e)
            error(f'agent base _run failed run_id={run_id} type={error_type} message={error_message}')
            envelope = failed_envelope(
                framework=self.FRAMEWORK,
                agent_id=self._agent_id(pSelf),
                run_id=run_id,
                task_id=safe_str(self._get_task_id(pSelf)) or None,
                started_at=started_at,
                ended_at=now_iso(),
                error_type=error_type,
                error_message=error_message,
            )

        attach_tool_calls_artifact(envelope, tool_calls)

        if emit_answers_lane:
            debug(
                'agent base emitting envelope'
                f'run_id={envelope.get("meta", {}).get("run_id")} status={envelope.get("status")}'
            )
            answer = Answer(expectJson=True)
            answer.setAnswer(envelope)
            pSelf.instance.writeAnswers(answer)

        return envelope

    # ---------------------------------------------------------------------
    # Framework-facing host operations (normalization lives here)
    # ---------------------------------------------------------------------
    def _discover_tool_names(self, *, host: AgentHost) -> List[str]:
        """Best-effort connected tool discovery (names only)."""
        try:
            catalog = host.tools.query()
        except Exception as e:
            catalog = {'error': str(e), 'type': type(e).__name__}
        return extract_tool_names(catalog)

    def _invoke_host_tool(
        self,
        *,
        host: AgentHost,
        tool_name: str,
        input: Any = None,  # noqa: A002
        kwargs: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Invoke a host tool after normalizing invocation payload shapes."""
        from ._internal.tool_payload import normalize_invocation_payload

        payload = normalize_invocation_payload(input=input, kwargs=kwargs)
        return host.tools.invoke(tool_name, payload)

    def _call_host_llm_text(
        self,
        *,
        host: AgentHost,
        messages: Any,
        question_role: str,
        stop_words: Any = None,
    ) -> str:
        """Call host LLM and return normalized text (best-effort)."""
        from ._internal.llm_text import extract_text, messages_to_transcript, truncate_at_stop_words
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
        call_llm_text: Callable[..., str],
        ctx: Dict[str, Any],
    ) -> Any:
        raise NotImplementedError

    @abstractmethod
    def _bind_framework_tools(
        self,
        *,
        host: AgentHost,
        tool_names: List[str],
        invoke_tool: Callable[..., Any],
        log_tool_call: Callable[..., None],
        ctx: Dict[str, Any],
    ) -> List[Any]:
        raise NotImplementedError

    # ---------------------------------------------------------------------
    # Tool-provider surface (agent-as-tool)
    # ---------------------------------------------------------------------
    def handle_invoke(self, pSelf: Any, param: Any) -> Any:  # noqa: ANN401
        op = get_field(param, 'op')
        if not isinstance(op, str) or not op:
            raise ValueError('agent tool: missing op')

        match op:
            case 'tool.query':
                tools = [self._agent_tool_descriptor(pSelf)]
                existing = get_field(param, 'tools')
                if isinstance(existing, list):
                    existing.extend(tools)
                    set_field(param, 'tools', existing)
                    return param
                return tools

            case 'tool.validate':
                tool_name = get_field(param, 'tool_name')
                input_obj = get_field(param, 'input')
                server_name, bare_tool = split_namespaced_tool_name(tool_name)
                self._agent_tool_validate(pSelf=pSelf, server_name=server_name, tool_name=bare_tool, input_obj=input_obj)
                return {'valid': True, 'tool_name': tool_name}

            case 'tool.invoke':
                tool_name = get_field(param, 'tool_name')
                input_obj = get_field(param, 'input')
                server_name, bare_tool = split_namespaced_tool_name(tool_name)
                self._agent_tool_validate(pSelf=pSelf, server_name=server_name, tool_name=bare_tool, input_obj=input_obj)

                query, ctx = self._agent_tool_parse_input(input_obj)
                q = Question(role='')
                q.addQuestion(query)
                if ctx is not None:
                    try:
                        q.addContext(json.dumps({'type': 'aparavi.agent.tool_context.v1', 'context': ctx}, default=str))
                    except Exception:
                        pass

                envelope = self.run_agent(pSelf, q, emit_answers_lane=False)

                set_field(param, 'output', envelope)
                return param

            case _:
                raise ValueError(f'agent tool: unknown op {op!r}')

    def _agent_tool_server_name(self, pSelf: Any) -> str:
        try:
            inst = getattr(pSelf, 'instance', None)
            pipe_type = getattr(inst, 'pipeType', None) if inst is not None else None
            pipe_id = None
            if isinstance(pipe_type, dict):
                pipe_id = pipe_type.get('id')
            else:
                pipe_id = getattr(pipe_type, 'id', None)
            if pipe_id:
                return str(pipe_id)

            glb = getattr(pSelf, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self._agent_id(pSelf) or self.FRAMEWORK or 'agent'

    def _agent_tool_full_name(self, pSelf: Any) -> str:
        return f'{self._agent_tool_server_name(pSelf)}.{self._AGENT_TOOL_NAME}'

    def _agent_tool_descriptor(self, pSelf: Any) -> Dict[str, Any]:
        tools_available_all = self._discover_connected_tool_names(pSelf)
        tools_available = [t for t in tools_available_all if not is_agent_run_tool_name(t)]

        desc = 'Invoke this agent as a tool. Input: {query: string, context?: object}. Output: AgentEnvelope.'
        if tools_available:
            tools_list = ', '.join(tools_available)
            desc = f'{desc} Tools available to this agent: {tools_list}.'
        else:
            desc = f'{desc} Tools available to this agent: (none).'

        return {
            'name': self._agent_tool_full_name(pSelf),
            'description': desc,
            'input_schema': {
                'type': 'object',
                'properties': {
                    'query': {'type': 'string', 'description': 'Query string for the agent (required)'},
                    'context': {'type': 'object', 'description': 'Optional caller-provided context'},
                },
                'required': ['query'],
            },
            'output_schema': {
                'type': 'object',
                'description': 'AgentEnvelope',
                'properties': {
                    'status': {'type': 'string'},
                    'error': {'type': ['object', 'null']},
                    'control': {'type': 'object'},
                    'result': {'type': 'object'},
                    'artifacts': {'type': 'array'},
                    'meta': {'type': 'object'},
                },
                'required': ['status', 'result', 'meta'],
            },
            'tools_available': tools_available,
        }

    def _agent_tool_validate(self, *, pSelf: Any, server_name: str, tool_name: str, input_obj: Any) -> None:
        if server_name != self._agent_tool_server_name(pSelf):
            raise ValueError(f'agent tool: unknown server_name {server_name!r}')
        if tool_name != self._AGENT_TOOL_NAME:
            raise ValueError(f'agent tool: unknown tool_name {tool_name!r}')
        query, _ = self._agent_tool_parse_input(input_obj)
        if not isinstance(query, str) or not query.strip():
            raise ValueError('agent tool: input.query must be a non-empty string')

    @staticmethod
    def _agent_tool_parse_input(input_obj: Any) -> tuple[str, Optional[Dict[str, Any]]]:
        from ._internal.tool_payload import normalize_invocation_payload

        payload = normalize_invocation_payload(input=input_obj)
        if not isinstance(payload, dict):
            raise ValueError('agent tool: input must be an object')
        query = payload.get('query')
        if not isinstance(query, str):
            raise ValueError('agent tool: input.query must be a string')
        ctx = payload.get('context')
        if ctx is None:
            return query, None
        if not isinstance(ctx, dict):
            raise ValueError('agent tool: input.context must be an object if provided')
        return query, ctx

    def _discover_connected_tool_names(self, pSelf: Any) -> List[str]:
        try:
            host = AgentHostServices(pSelf.instance.invoke)
            return self._discover_tool_names(host=host)
        except Exception:
            return []

    # ---------------------------------------------------------------------
    # Abstract hook: framework run
    # ---------------------------------------------------------------------
    @abstractmethod
    def _run(self, *, agent_input: AgentInput, host: AgentHost, ctx: Dict[str, Any]) -> AgentRunResult:
        raise NotImplementedError

    # ---------------------------------------------------------------------
    # Engine utilities
    # ---------------------------------------------------------------------
    def _agent_id(self, pSelf: Any) -> str:
        try:
            glb = getattr(pSelf, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self.__class__.__name__

    def _get_task_id(self, pSelf: Any) -> Optional[str]:
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
