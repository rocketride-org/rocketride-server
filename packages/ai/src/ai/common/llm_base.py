# Copyright (c) 2026 Aparavi Software AG

from rocketlib import IInstanceBase, invoke_function
from ai.common.schema import Question, Answer


class LLMBase(IInstanceBase):
    """Shared base instance for LLM-style nodes.

    This class is the canonical node-level base for LLM providers and adapters.
    Provider-specific request/retry behavior remains in ai.common.chat.ChatBase.
    """

    # Provider block-shape selector for Question.attachments dispatch.
    # Subclasses override; default 'openai' because most providers in the catalog
    # are OpenAI-compatible. Recognized values: 'openai' | 'anthropic' | 'gemini'
    # | 'bedrock'. The non-OpenAI shapes each supply their own translator, and
    # per-provider IInstance subclasses override this value.
    provider_shape: str = 'openai'

    # Concrete node name surfaced in drop-and-warn telemetry. Defaults to a
    # sentinel; per-node subclasses override it.
    provider_name: str = 'unknown'

    def _question(self, question: Question) -> Answer:
        return self.IGlobal._chat.chat(question)

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
