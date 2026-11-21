# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
LLMBase - the shared IInstance of every LLM node.

The chat is the control's; the model, its limits and the tuning leaves are
this call's (plan 4.1 rule 4): each request resolves them from
``self.settings`` and serves them on the chat (``ChatBase.calling``), so one
control answers a call on one model and the next on another without
rebuilding its IGlobal.
"""

import inspect
from typing import Callable, List, Optional

from rocketlib import IInstanceBase, invoke_function, warning
from ai.common.chat import ChatCall
from ai.common.schema import Question, Answer
from ai.common.llm_native_stream import STOP_SEQUENCES_VAR
from ai.common.llm_adapter import turn_usage


class LLMBase(IInstanceBase):
    """Shared base instance for LLM-style nodes.

    This class is the canonical node-level base for LLM providers and adapters.
    Provider-specific request/retry behavior remains in ai.common.chat.ChatBase.

    The chat client is the CONTROL's (plan 4.1 rule 1): the node's IGlobal
    builds ``_chat`` once in ``beginGlobal`` from ``self.config``, the
    control's resolved configuration, and every binding of that control
    reads it through ``self.IGlobal``. The values of a call are this
    binding's: ``_call`` resolves them from ``self.settings``.
    """

    def _call(self) -> ChatCall:
        """Return this call's generation values, resolved from ``self.settings``."""
        return self.IGlobal._chat.resolve_call(self.settings)

    def _question(
        self,
        question: Question,
        on_chunk: Optional[Callable[[str], None]] = None,
        on_finish: Optional[Callable[[Optional[str]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
        stop: Optional[List[str]] = None,
    ) -> Answer:
        chat = self.IGlobal._chat
        # Publish the stop sequences on the per-call contextvar so ChatBase's model sinks
        # forward them to the provider API. A contextvar (not a chat() kwarg) leaves the
        # many chat()/_chat() provider overrides untouched. Reset in finally so a stop from
        # one request never bleeds into the next on a reused chat instance.
        token = STOP_SEQUENCES_VAR.set(stop or None)
        try:
            # Every request the chat sends for this question reads this call's values
            with chat.calling(self._call()):
                # Legacy drivers override chat(self, question) without streaming callbacks.
                try:
                    accepts_stream = 'on_chunk' in inspect.signature(chat.chat).parameters
                except (TypeError, ValueError):
                    accepts_stream = True
                if not accepts_stream:
                    return chat.chat(question)
                return chat.chat(
                    question,
                    on_chunk=on_chunk,
                    on_finish=on_finish,
                    on_reasoning_chunk=on_reasoning_chunk,
                )
        finally:
            STOP_SEQUENCES_VAR.reset(token)

    def writeQuestions(self, question: Question):
        # Stream the model's reasoning live, one line at a time, on the chat-ui
        # 'thinking' lane (same channel as agents). The answer is written normally.
        buf: list = []

        def _noop(_text: str) -> None:
            pass

        def _emit_thinking(message: str) -> None:
            if message:
                try:
                    self.instance.sendSSE('thinking', message=message)
                except Exception:
                    pass

        def _flush_reasoning(force: bool = False) -> None:
            # Emit complete lines; keep the trailing partial in buf so the next
            # delta can continue it — unless forced (long paragraph or stream end).
            lines = ''.join(buf).splitlines(keepends=True)
            remainder = lines.pop() if (lines and not force and not lines[-1].endswith('\n')) else ''
            buf[:] = [remainder] if remainder else []
            for line in lines:
                _emit_thinking(line.strip())

        def on_reasoning_chunk(text: str) -> None:
            if not text:
                return
            buf.append(text)
            # Stream live: emit complete lines, or force a flush once a newline-less
            # paragraph grows enough to show progress.
            if '\n' in text:
                _flush_reasoning()
            elif sum(len(p) for p in buf) >= 120:
                _flush_reasoning(force=True)

        # Scope this turn's model calls so a prior call's usage can't bleed into this
        # answer and the collector stays bounded to one turn.
        with turn_usage() as read_usage:
            try:
                answer = self._question(
                    question,
                    on_chunk=_noop,
                    on_reasoning_chunk=on_reasoning_chunk,
                )
            except Exception as e:
                err_msg = f'**LLM error** — {type(e).__name__}: {e}'
                warning(f'writeQuestions: LLM call failed: {type(e).__name__}: {e}')
                answer = Answer()
                answer.setAnswer(err_msg)
                # A turn that failed after burning tokens still spent them: the adapters
                # report from their own finally, so the scope holds what was billed —
                # hang it on the error answer or the Trace shows nothing for exactly the
                # turn the user opens.
                failed_usage = read_usage()
                if failed_usage:
                    answer.tokens = failed_usage
                self.instance.writeAnswers(answer)
                return

            _flush_reasoning(force=True)  # emit any trailing partial line
            usage = read_usage()  # turn total: summed across every model call this turn
            if usage:
                answer.tokens = usage  # shown in the Trace "Tokens" grid on the answers lane
            self.instance.writeAnswers(answer)

    @invoke_function
    def getContextLength(self, _param):
        """Return the context window of this call's model."""
        chat = self.IGlobal._chat
        with chat.calling(self._call()):
            return chat.getTotalTokens()

    @invoke_function
    def getOutputLength(self, _param):
        """Return the most tokens one reply of this call's model may hold."""
        chat = self.IGlobal._chat
        with chat.calling(self._call()):
            return chat.getOutputTokens()

    @invoke_function
    def getTokenCounter(self, _param):
        """Return a counter of this call's model's tokens; it keeps the call, so it counts the same wherever it runs."""
        chat = self.IGlobal._chat
        call = self._call()

        def count(value: str) -> int:
            with chat.calling(call):
                return chat.getTokens(value)

        return count

    @invoke_function
    def ask(self, param):
        # Each invoke shows its own cost: the scope reads only the calls made while it
        # was open (its own, plus any nested sub-agent calls it drove). When an agent
        # drives this invoke, the agent's outer scope still sees the same calls for the
        # turn total; the outermost scope bounds and clears the collector.
        with turn_usage() as read_usage:
            answer = self._question(param.question, stop=getattr(param, 'stop', None))
            usage = read_usage()
            if usage:
                answer.tokens = usage  # shown in the Trace "Tokens" grid on this invoke's row
        return answer
