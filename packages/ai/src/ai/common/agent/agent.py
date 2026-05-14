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

    # Engine-built-in tool registry.  Built-ins are surfaced to the LLM
    # via `host.tools.list` but their invocation is intercepted in
    # `call_tool` and routed to the corresponding `_method` below.
    _RECALL_HISTORY_TOOL_NAME: str = 'recall_history'
    _RECALL_HISTORY_DEFAULT_LIMIT: int = 10
    _RECALL_HISTORY_MAX_LIMIT: int = 50
    _HISTORY_SCHEMA_VERSION: int = 1

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
        # question, not on every question.  Engine built-in tools (e.g.
        # `recall_history`) are computed per-agent and folded into the
        # Tools channel so frameworks surface them to the LLM.
        if getattr(iInstance, '_agent_host', None) is None:
            host = AgentHostServices(iInstance, builtin_tools=self._builtin_tools())
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
            # cached host; metadata is stamped fresh per call.  chat_id
            # is pulled directly from the inbound Question so concurrent
            # questions on the same IInstance route to their own chat
            # files (covered by the chat-id-routing contract test).
            context = AgentContext(
                invoker=iInstance,
                llm=host.llm,
                tools=host.tools,
                memory=host.memory,
                run_id=run_id,
                pipe_id=iInstance.instance.pipeId if iInstance.instance else 0,
                framework=self.FRAMEWORK,
                started_at=started_at,
                chat_id=getattr(question, 'chat_id', None),
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

        Engine built-in tools (e.g. ``recall_history``) are intercepted
        here and dispatched to the corresponding ``AgentBase`` method,
        threading ``context.chat_id`` so the LLM never types a path and
        cannot reach another chat or another user's data.

        Args:
            context: The current agent run context.
            tool_name: Tool name as published by `context.tools.list`.
            args: Clean dict of tool arguments.

        Returns:
            The raw tool output (whatever the tool returned).
        """
        if tool_name == self._RECALL_HISTORY_TOOL_NAME:
            safe_args = dict(args or {})
            self._recall_history_metric(
                context.pipe_id,
                'invoked' if context.chat_id else 'invoked_no_chat',
            )
            return self._recall_history(chat_id=context.chat_id, **safe_args)
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

    # =========================================================================
    # ENGINE BUILT-IN TOOLS
    # =========================================================================
    def _builtin_tools(self) -> List[Dict[str, Any]]:
        """Engine-built-in tool descriptors prepended to ``host.tools.list``.

        Built-ins are dispatched in ``call_tool`` before ever reaching
        ``Tools.invoke``.  They never take a path argument — the LLM
        cannot type a chat id; it is threaded from the inbound Question
        via ``AgentContext.chat_id``.
        """
        return [
            {
                'name': self._RECALL_HISTORY_TOOL_NAME,
                'description': ('Read older turns from this chat session beyond the eager last-3 context already in the prompt. Returns turn records (each with the full Question/Answer that produced it) in most-recent-first order.'),
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'before_seq': {
                            'type': 'integer',
                            'description': 'Only return turns with seq < before_seq. Omit for the most recent turns.',
                            'minimum': 1,
                        },
                        'limit': {
                            'type': 'integer',
                            'description': (f'Maximum turns to return (default {self._RECALL_HISTORY_DEFAULT_LIMIT}, max {self._RECALL_HISTORY_MAX_LIMIT}).'),
                            'minimum': 1,
                            'maximum': self._RECALL_HISTORY_MAX_LIMIT,
                        },
                    },
                },
            }
        ]

    def _recall_history_metric(self, pipe_id: int, tag: str) -> None:
        """Fire a single counter on the MetricsManager seam (TDD §11.1 'recall_history reads').

        Best-effort: silently swallow import/init failures so test contexts
        without the metrics module still work. The signal is bookkeeping; the
        chat history read itself does not depend on it.
        """
        try:
            from ai.web.metrics.metrics import metrics as _metrics  # local to avoid mock-time cycles

            _metrics.counter(int(pipe_id or 0), f'recall_history.{tag}', 1)
        except Exception:
            pass

    def _recall_history(
        self,
        chat_id: Optional[str],
        before_seq: Optional[int] = None,
        limit: int = _RECALL_HISTORY_DEFAULT_LIMIT,
    ) -> Dict[str, Any]:
        """Read turn lines from ``.chats/<chat_id>/chat.jsonl``.

        Returns ``{turns: [], note: 'persistence not enabled'}`` when
        ``chat_id`` is None (no chat session on this Question).  Otherwise
        streams the chat file via the per-account ``FileStore`` (same
        ``client_id`` pattern as ``tool_filesystem`` — see
        ``nodes/src/nodes/tool_filesystem/IGlobal.py:75-87``), filters by
        ``seq < before_seq`` when supplied, and returns the most-recent
        ``limit`` matching turns.

        Lines with a higher per-line ``schema_version`` than this reader
        understands are returned with a ``schema_version_warning`` flag
        instead of being skipped — that lets the LLM be told to treat
        them as opaque rather than dropping them silently.
        """
        if not chat_id:
            return {'turns': [], 'note': 'persistence not enabled'}

        try:
            limit = max(1, min(int(limit), self._RECALL_HISTORY_MAX_LIMIT))
        except (TypeError, ValueError):
            limit = self._RECALL_HISTORY_DEFAULT_LIMIT

        before_int: Optional[int] = None
        if before_seq is not None:
            try:
                before_int = int(before_seq)
            except (TypeError, ValueError):
                before_int = None

        try:
            raw = self._read_chat_jsonl_bytes(chat_id)
        except FileNotFoundError:
            return {'turns': [], 'note': 'chat file not found', 'chat_id': chat_id}
        except Exception as e:
            error(f'_recall_history read failed chat_id={chat_id} type={type(e).__name__} message={e}')
            return {'turns': [], 'note': f'read error: {type(e).__name__}', 'chat_id': chat_id}

        turns: List[Dict[str, Any]] = []
        warnings: List[str] = []
        for raw_line in raw.splitlines():
            if not raw_line.strip():
                continue
            try:
                rec = json.loads(raw_line)
            except json.JSONDecodeError as e:
                warnings.append(f'line skipped: {e.msg}')
                continue
            if rec.get('type') != 'turn':
                continue
            line_ver = rec.get('schema_version', 1)
            if isinstance(line_ver, int) and line_ver > self._HISTORY_SCHEMA_VERSION:
                rec = dict(rec)
                rec['schema_version_warning'] = f'line schema_version={line_ver} > reader={self._HISTORY_SCHEMA_VERSION}; treat as opaque'
            if before_int is not None:
                try:
                    if int(rec.get('seq', 0)) >= before_int:
                        continue
                except (TypeError, ValueError):
                    continue
            turns.append(rec)

        # Newest-first, clipped to limit.
        turns.sort(key=lambda r: int(r.get('seq', 0)) if isinstance(r.get('seq', 0), int) else 0, reverse=True)
        out: Dict[str, Any] = {'turns': turns[:limit], 'chat_id': chat_id}
        if warnings:
            out['warnings'] = warnings
        return out

    def _read_chat_jsonl_bytes(self, chat_id: str) -> bytes:
        """Open the per-account ``FileStore`` and read the chat JSONL bytes.

        Mirrors the env-driven client-id resolution used by
        ``tool_filesystem`` (``IGlobal.beginGlobal``) so the engine
        respects the same multi-tenant boundary.  Async ``FileStore.read``
        is driven from this sync context via ``asyncio.run`` exactly as
        ``tool_filesystem`` does in ``IInstance._run_async``.
        """
        import asyncio
        import os

        from ai.account.store import Store

        client_id = os.environ.get('ROCKETRIDE_CLIENT_ID', '').strip()
        if not client_id:
            raise RuntimeError('ROCKETRIDE_CLIENT_ID env var is missing; cannot resolve chat history store')
        store = Store.create()
        file_store = store.get_file_store(client_id)
        path = f'.chats/{chat_id}/chat.jsonl'

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(file_store.read(path))
        else:
            raise RuntimeError('_recall_history cannot run inside an active event loop; AgentBase.call_tool is invoked synchronously by drivers.')
