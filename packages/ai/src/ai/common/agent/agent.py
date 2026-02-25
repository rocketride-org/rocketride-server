"""
Agent base class (framework-agnostic pipeline boundary) implemented as a shared driver.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional

from rocketlib import debug, error
from ai.common.schema import Answer, Question

from .types import AgentEnvelope, AgentHost, AgentInput, AgentRunResult
from ._internal.envelope import failed_envelope, to_envelope
from ._internal.host import AgentHostServices
from ._internal.agent_tool import handle_agent_tool_invoke
from ._internal.trace import attach_tool_calls_artifact, make_tracing_invoker
from ._internal.utils import extract_continuation, extract_prompt, extract_text, extract_tool_names, messages_to_transcript, now_iso, new_run_id, normalize_invocation_payload, safe_str, truncate_at_stop_words

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
    # Abstract hook: framework run
    # ---------------------------------------------------------------------
    @abstractmethod
    def _run(self, *, agent_input: AgentInput, host: AgentHost, ctx: Dict[str, Any]) -> AgentRunResult:
        raise NotImplementedError

    # ---------------------------------------------------------------------
    # Framework-facing host operations
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
        """Call host LLM and return normalized text (best-effort)."""
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
        tool_names: List[str],
        invoke_tool: Callable[..., Any],
        log_tool_call: Callable[..., None],
        ctx: Dict[str, Any],
    ) -> List[Any]:
        raise NotImplementedError

    # ---------------------------------------------------------------------
    # Tool-provider surface (agent-as-tool)
    # ---------------------------------------------------------------------
    def handle_invoke(self, pSelf: Any, param: Any) -> Any:
        return handle_agent_tool_invoke(agent=self, pSelf=pSelf, param=param)

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
