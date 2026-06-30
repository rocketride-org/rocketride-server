# Copyright (c) 2026 Aparavi Software AG

import inspect
from typing import Callable, Optional

from rocketlib import IInstanceBase, invoke_function, warning
from ai.common.schema import Question, Answer


class LLMBase(IInstanceBase):
    """Shared base instance for LLM-style nodes.

    This class is the canonical node-level base for LLM providers and adapters.
    Provider-specific request/retry behavior remains in ai.common.chat.ChatBase.
    """

    def _question(
        self,
        question: Question,
        on_chunk: Optional[Callable[[str], None]] = None,
        on_finish: Optional[Callable[[Optional[str]], None]] = None,
        on_reasoning_chunk: Optional[Callable[[str], None]] = None,
    ) -> Answer:
        chat = self.IGlobal._chat

        def _on_notice(notice):
            # Route attachment drops / provider errors to the chat UI as an
            # ``attachment_notice`` SSE event (mirrors ``_emit_thinking``).
            try:
                self.instance.sendSSE('attachment_notice', **notice)
            except Exception:
                pass

        # Legacy drivers override chat(self, question) without streaming callbacks.
        try:
            accepts_stream = 'on_chunk' in inspect.signature(chat.chat).parameters
        except (TypeError, ValueError):
            accepts_stream = True
        try:
            accepts_notice = 'on_notice' in inspect.signature(chat.chat).parameters
        except (TypeError, ValueError):
            accepts_notice = False
        if not accepts_stream:
            return chat.chat(question, **({'on_notice': _on_notice} if accepts_notice else {}))
        stream_kwargs = {
            'on_chunk': on_chunk,
            'on_finish': on_finish,
            'on_reasoning_chunk': on_reasoning_chunk,
        }
        if accepts_notice:
            stream_kwargs['on_notice'] = _on_notice
        return chat.chat(question, **stream_kwargs)

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
            self.instance.writeAnswers(answer)
            return

        _flush_reasoning(force=True)  # emit any trailing partial line
        self.instance.writeAnswers(answer)

    @invoke_function
    def getContextLength(self, _param):
        return self.IGlobal._chat.getTotalTokens()

    @invoke_function
    def getOutputLength(self, _param):
        return self.IGlobal._chat.getOutputTokens()

    @invoke_function
    def getTokenCounter(self, _param):
        return self.IGlobal._chat.getTokens

    @invoke_function
    def ask(self, param):
        return self._question(param.question)
