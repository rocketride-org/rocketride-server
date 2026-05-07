# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import itertools
import threading
from typing import Optional

from rocketlib import IInstanceBase, invoke_function
from ai.common.schema import Question, Answer


class IInstanceGenericLLM(IInstanceBase):
    def _question(self, question: Question) -> Answer:
        chat = self.IGlobal._chat
        if getattr(chat, 'SUPPORTS_STREAMING', False) and not question.expectJson:
            return self._question_stream(question)
        return chat.chat(question)

    def _question_stream(self, question: Question) -> Answer:
        """
        Streaming question path: forwards each LLM text delta to the UI as
        an `llm.chunk` SSE event, then returns the final Answer (same shape
        as `_question`). The output lane consumed by downstream nodes is
        unchanged — chunks are observation-only.

        Emit calls are serialized under a per-call lock so chunks reach the
        SSE transport in source order; the transport preserves order from
        there to the client.
        """
        try:
            nodeId = self.IGlobal.glb.logicalType
        except Exception:
            nodeId = ''

        counter = itertools.count()
        lock = threading.Lock()

        def emit(text: str = '', done: bool = False, error: Optional[str] = None) -> None:
            with lock:
                self.instance.sendSSE(
                    'llm.chunk',
                    nodeId=nodeId,
                    seq=next(counter),
                    text=text,
                    done=done,
                    error=error,
                )

        try:
            answer = self.IGlobal._chat.chat_stream(question, lambda delta: emit(delta))
        except Exception as e:
            # Run the exception through the provider's map_exception before
            # surfacing to the client — raw SDK errors can contain auth
            # tokens, server paths, or echoed prompts.
            mapped = self.IGlobal._chat.map_exception(e)
            emit(done=True, error=str(mapped))
            raise mapped from e

        emit(done=True)
        return answer

    def writeQuestions(self, question: Question):
        answer = self._question(question)
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
