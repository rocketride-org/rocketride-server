# Copyright (c) 2026 Aparavi Software AG

from rocketlib import IInstanceBase, invoke_function
from ai.common.schema import Question, Answer


class LLMBase(IInstanceBase):
    """Shared base instance for LLM-style nodes.

    This class is the canonical node-level base for LLM providers and adapters.
    Provider-specific request/retry behavior remains in ai.common.chat.ChatBase.
    """

    def _question(self, question: Question) -> Answer:
        return self.IGlobal._chat.chat(question)

    def writeQuestions(self, question: Question):
        answer = self._question(question)
        metadata = getattr(question, 'metadata', None)
        if isinstance(metadata, dict):
            existing = getattr(answer, 'metadata', None)
            if isinstance(existing, dict):
                existing.update(metadata)
            else:
                answer.metadata = dict(metadata)
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
