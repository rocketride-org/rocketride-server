# Copyright (c) 2026 Aparavi Software AG

from rocketlib import Ec, IInstanceBase, invoke_function
from ai.common.schema import Question, Answer
from ai.common.resilience import CircuitBreakerOpenError, LLMResiliencePolicy
from ai.common.resilience_config import create_resilience_policy


class LLMBase(IInstanceBase):
    """Shared base instance for LLM-style nodes.

    This class is the canonical node-level base for LLM providers and adapters.
    Provider-specific request/retry behavior remains in ai.common.chat.ChatBase.
    """

    _resilience_policy: LLMResiliencePolicy | None = None

    def _get_resilience_policy(self) -> LLMResiliencePolicy:
        """Return the lazily-created resilience policy for this provider."""
        policy = self.__class__._resilience_policy
        if policy is None:
            provider = type(self).__module__.rsplit('.', 1)[0].rsplit('.', 1)[-1]
            if provider.startswith('llm_vision_'):
                provider = provider[len('llm_vision_') :]
            elif provider.startswith('llm_'):
                provider = provider[4:]
            policy = create_resilience_policy(provider)
            self.__class__._resilience_policy = policy
        return policy

    def _mark_current_object_retry(self, exc: CircuitBreakerOpenError) -> None:
        entry = getattr(getattr(self, 'instance', None), 'currentObject', None)
        if entry is None:
            raise exc
        entry.completionCode(Ec.Retry, str(exc))

    def _get_chat(self):
        chat = getattr(self.IGlobal, '_chat', None)
        if chat is None:
            chat = getattr(self.IGlobal, 'chat', None)
        if chat is None:
            raise AttributeError('LLM chat interface is not initialized')
        return chat

    def _question(self, question: Question) -> Answer:
        policy = self._get_resilience_policy()
        return policy.execute(self._get_chat().chat, question)

    def writeQuestions(self, question: Question):
        try:
            answer = self._question(question)
        except CircuitBreakerOpenError as exc:
            self._mark_current_object_retry(exc)
            return
        self.instance.writeAnswers(answer)

    def invoke(self, *args, **kwargs):
        try:
            return super().invoke(*args, **kwargs)
        except CircuitBreakerOpenError as exc:
            self._mark_current_object_retry(exc)
            return None

    @invoke_function
    def getContextLength(self, _param):
        return self._get_chat().getTotalTokens()

    @invoke_function
    def getOutputLength(self, _param):
        return self._get_chat().getOutputTokens()

    @invoke_function
    def getTokenCounter(self, _param):
        return self._get_chat().getTokens

    @invoke_function
    def ask(self, param):
        return self._question(param.question)
