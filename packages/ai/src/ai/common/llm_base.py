# Copyright (c) 2026 Aparavi Software AG

import time
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
        return self.IGlobal._chat.chat(
            question,
            on_chunk=on_chunk,
            on_finish=on_finish,
            on_reasoning_chunk=on_reasoning_chunk,
        )

    def _streamIdentity(self) -> tuple:
        # (runId, nodeId) per chunk so the client can demux concurrent LLM nodes (#752).
        run_id = getattr(self.instance, 'pipeId', 0) if self.instance else 0
        node_id = ''
        pipe_type = getattr(self.instance, 'pipeType', None) if self.instance else None
        if isinstance(pipe_type, dict):
            node_id = pipe_type.get('id', '') or ''
        return run_id, node_id

    def writeQuestions(self, question: Question):
        # Stream provider tokens as SSE 'chunk'/'reasoning_chunk'; 'chunk_end' carries finishReason (#752).
        run_id, node_id = self._streamIdentity()
        seq = 0
        reasoning_seq = 0
        reasoning_started = False

        def _emit(event: str, **kw) -> None:
            try:
                self.instance.sendSSE(event, runId=run_id, nodeId=node_id, ts=int(time.time() * 1000), **kw)
            except Exception:
                pass

        def on_chunk(text: str) -> None:
            nonlocal seq
            _emit('chunk', text=text, seq=seq)
            seq += 1

        def on_reasoning_chunk(text: str) -> None:
            nonlocal reasoning_seq, reasoning_started
            reasoning_started = True
            _emit('reasoning_chunk', text=text, seq=reasoning_seq)
            reasoning_seq += 1

        finish_holder: dict = {'reason': None}

        def on_finish(reason: Optional[str]) -> None:
            finish_holder['reason'] = reason

        try:
            answer = self._question(
                question,
                on_chunk=on_chunk,
                on_finish=on_finish,
                on_reasoning_chunk=on_reasoning_chunk,
            )
        except Exception as e:
            # Surface the error on the chat-ui lane so it isn't rendered as an empty bubble.
            err_msg = f'**LLM error** — {type(e).__name__}: {e}'
            warning(f'writeQuestions: LLM call failed: {type(e).__name__}: {e}')
            _emit('chunk', text=err_msg, seq=seq)
            seq += 1
            if reasoning_started:
                _emit('reasoning_end', seq=reasoning_seq)
            _emit('chunk_end', finishReason='error', seq=seq)
            answer = Answer()
            answer.setAnswer(err_msg)
            self.instance.writeAnswers(answer)
            return

        if reasoning_started:
            _emit('reasoning_end', seq=reasoning_seq)
        _emit('chunk_end', finishReason=finish_holder['reason'], seq=seq)
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
