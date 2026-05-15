"""
Agent base class (framework-agnostic pipeline boundary) implemented as a shared driver.

Implements the agent pipeline entrypoint (`run_agent`) and exposes two host
adapters that drivers route every LLM/tool call through:
- `call_llm(context, prompt, *, role, stop_words)` — invoke the host LLM
- `call_tool(context, tool_name, args)` — invoke a host tool

Framework drivers subclass `AgentBase` and implement `_run(*, context, question)`.
The two host adapters above are the *only* code in the agent package that
builds engine envelopes (`Question`, `IInvokeLLM.Ask`).  Drivers never touch
`IInvokeLLM` directly.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Union

from rocketlib import debug, error
from ai.common.schema import Answer, Question
from ai.common.config import Config

from ._internal.host import AgentContext, AgentHostServices
from ._internal.utils import (
    extract_text,
    messages_to_transcript,
    now_iso,
    new_run_id,
    safe_str,
    truncate_at_stop_words,
)


class AgentBase(ABC):
    """
    Base class for all agent framework drivers.

    Drivers implement `_run(*, context, question)` to execute their framework
    internals.  Per-driver concrete `_build_llm` / `_build_tools` methods (not
    abstract on this base class) construct the framework wrapper subclasses
    that CrewAI / LangChain / deepagents demand.

    All host calls go through the two adapters on this base:
      - `self.call_llm(context, prompt, *, role, stop_words)`
      - `self.call_tool(context, tool_name, args)`

    Subclasses set `REQUIRES_MEMORY = True` if their `_run` requires a memory
    node to be connected.  `run_agent` enforces the requirement at first
    question (during the lazy `AgentHostServices` construction).
    """

    FRAMEWORK: str = 'unknown'
    _AGENT_TOOL_NAME: str = 'run_agent'
    REQUIRES_MEMORY: bool = False

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

    # =========================================================================
    # PIPELINE-FACING ENTRYPOINT
    # =========================================================================
    def run_agent(
        self,
        iInstance,
        question: Question,
        *,
        emit_answers_lane: bool = True,
    ) -> Any:
        """
        Execute a single agent run for a pipeline `Question`.

        This method:
          1. Lazy-builds and caches `AgentHostServices` on the IInstance
             (via `iInstance._agent_host`) so tool discovery happens once
             per IInstance, not once per question.
          2. Enforces `REQUIRES_MEMORY` at first question for drivers that
             need a memory node.
          3. Builds the per-call `AgentContext` inline (no factory method)
             with fresh metadata.
          4. Delegates execution to the driver's `_run(*, context, question)`.
          5. Writes the answer JSON payload to the answers lane.

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

        # Lazy host construction.  Built once per IInstance, cached on
        # the invoker via attribute assignment.  Tool discovery (one
        # engine invoke per connected tool node) happens at first
        # question, not on every question.
        if getattr(iInstance, '_agent_host', None) is None:
            host = AgentHostServices(iInstance)
            if self.REQUIRES_MEMORY and host.memory is None:
                raise ValueError(f'{self.FRAMEWORK} agent requires a memory node to be connected')
            iInstance._agent_host = host
        host = iInstance._agent_host

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

            # Get the jobs taskId — kept as a local variable inside the
            # try/except so a missing/inaccessible jobConfig produces a
            # graceful error answer instead of an unhandled AttributeError.
            # Not on AgentContext: task_id is the same for every IInstance
            # of a pipeline, so it serves no purpose as run scaffolding.
            try:
                task_id = iInstance.IEndpoint.endpoint.jobConfig.get('taskId')
            except Exception:
                task_id = None

            # Build the per-call context inline.  Channels come from the
            # cached host; metadata is stamped fresh per call.
            context = AgentContext(
                invoker=iInstance,
                llm=host.llm,
                tools=host.tools,
                memory=host.memory,
                run_id=run_id,
                pipe_id=iInstance.instance.pipeId if iInstance.instance else 0,
                framework=self.FRAMEWORK,
                started_at=started_at,
            )

            # And execute
            content, raw = self._run(
                context=context,
                question=question,
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
            stack.append(
                {
                    'kind': 'RocketRide.agent.error.v1',
                    'name': 'exception',
                    'payload': {'type': error_type, 'message': error_message},
                }
            )
            answer_payload['stack'] = stack

        if emit_answers_lane:
            debug(
                f'agent base emitting answer run_id={answer_payload.get("meta", {}).get("run_id")} framework={answer_payload.get("meta", {}).get("framework")}'
            )
            answer = Answer(expectJson=False)
            answer.setAnswer(answer_payload.get('content', ''))
            iInstance.instance.writeAnswers(answer)

        return answer_payload

    # =========================================================================
    # ABSTRACT HOOK: FRAMEWORK RUN
    # =========================================================================
    @abstractmethod
    def _run(
        self,
        *,
        context: AgentContext,
        question: Question,
    ) -> tuple[str, Any]:
        """
        Run the framework-specific agent execution.

        Both `context` and `question` are required keyword-only parameters.
        Drivers receive run scaffolding via `context` (invoker, llm/tools/memory
        channels, run_id, pipe_id, framework, started_at) and the entry-point
        pipeline question via `question`.  All host calls go through
        `self.call_llm(context, ...)` and `self.call_tool(context, ...)`.

        Drivers return a tuple of:
        - content: final user-facing text
        - raw: framework-native output object/state for trace/debugging
        """
        raise NotImplementedError

    # =========================================================================
    # HOST ADAPTERS — THE ONLY PLACE ENGINE ENVELOPES GET BUILT
    # =========================================================================
    def call_llm(
        self,
        context: AgentContext,
        prompt: Union[Question, Any],
        *,
        role: Optional[str] = None,
        stop_words: Optional[List[str]] = None,
    ) -> str:
        """
        Invoke the host LLM and return extracted, truncated text.

        `prompt` may be either:
          - a pre-built `Question` (used by drivers like rocketride that
            want explicit prompt structure: multiple questions, structured
            context, instructions, etc.); OR
          - any framework-native message list / string that
            `messages_to_transcript` knows how to flatten into a single
            transcript string.

        When `prompt` is a `Question`, `role` is ignored — the Question
        carries its own role.  When `prompt` is messages, `role` is used to
        stamp the synthesized Question (defaults to ``''`` if not given).

        This is the ONLY place in the agent package that builds engine
        envelopes.  Drivers never touch `IInvokeLLM` or construct
        `IInvokeLLM.Ask` directly.

        Args:
            context: The current agent run context.
            prompt: A pre-built Question or framework messages to flatten.
            role: Role/persona string used when synthesizing a Question
                from `messages`.  Ignored when `prompt` is already a Question.
            stop_words: Optional stop word list used to truncate returned text.

        Returns:
            Extracted model text, optionally truncated by stop words.
        """
        from rocketlib.types import IInvokeLLM

        if isinstance(prompt, Question):
            q = prompt
        else:
            transcript = messages_to_transcript(prompt)
            q = Question(role=role or '')
            q.addQuestion(transcript)

        result = context.llm.invoke(IInvokeLLM.Ask(question=q))
        return truncate_at_stop_words(extract_text(result), stop_words)

    def call_llm_json(
        self,
        context: AgentContext,
        prompt: Union[Question, Any],
        *,
        role: Optional[str] = None,
    ) -> Any:
        """
        Invoke the host LLM and return the parsed JSON response.

        Same `prompt` polymorphism as `call_llm`: accepts a pre-built
        `Question` (typical) or framework messages.  The Question must
        have ``expectJson = True`` set so the schema layer parses the
        response as JSON.

        Used by drivers like rocketride whose planner expects structured
        JSON output (tool calls, done flags, scratch notes) rather than
        flat text.  Like `call_llm`, this is one of the only two places
        in the agent package that builds engine envelopes.

        Args:
            context: The current agent run context.
            prompt: A pre-built Question (typically with expectJson=True)
                or framework messages to flatten.
            role: Role/persona string used when synthesizing a Question
                from `messages`.  Ignored when `prompt` is already a Question.

        Returns:
            The parsed JSON object returned by the LLM (typically a dict).
        """
        from rocketlib.types import IInvokeLLM

        if isinstance(prompt, Question):
            q = prompt
        else:
            transcript = messages_to_transcript(prompt)
            q = Question(role=role or '')
            q.addQuestion(transcript)

        result = context.llm.invoke(IInvokeLLM.Ask(question=q))
        return result.getJson()

    def call_tool(
        self,
        context: AgentContext,
        tool_name: str,
        args: Dict[str, Any],
    ) -> Any:
        """
        Invoke a host tool by name with a clean args dict.

        Driver wrappers convert framework arg shapes to a clean dict before
        calling this — there is no normalization layer here.

        Args:
            context: The current agent run context.
            tool_name: Tool name as published by `context.tools.list`.
            args: Clean dict of tool arguments.

        Returns:
            The raw tool output (whatever the tool returned).
        """
        return context.tools.invoke(tool_name, args)

    # =========================================================================
    # ENGINE UTILITIES
    # =========================================================================
    def sendSSE(self, context: AgentContext, type: str, **data) -> None:
        """
        Send a real-time SSE status update to the UI for the given run's pipe.

        The invoker is read from the explicit `context` (per-call), not from
        `self`, so concurrent pipes never cross-route SSE events.

        Args:
            context: The current run context (carries the per-pipe invoker).
            type:    Event type string (e.g. 'thinking', 'acting', 'confirm').
            **data:  Keyword arguments included as the event data payload.
        """
        if context and context.invoker and context.invoker.instance:
            context.invoker.instance.sendSSE(type, **data)

    def _agent_id(self, pSelf: Any) -> str:
        """Return the logical agent identifier used in answer metadata."""
        try:
            glb = getattr(pSelf, 'IGlobal', None)
            if glb and getattr(glb, 'glb', None) and getattr(glb.glb, 'logicalType', None):
                return str(glb.glb.logicalType)
        except Exception:
            pass
        return self.__class__.__name__
