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

from rocketlib import IInstanceBase, invoke_function
from ai.common.schema import Question, Answer

from .resilience import CircuitBreakerOpenError, LLMResiliencePolicy
from .resilience_config import create_resilience_policy


class IInstanceGenericLLM(IInstanceBase):
    # Lazily-initialized resilience policy (one per provider, shared across instances).
    _resilience_policy: LLMResiliencePolicy | None = None

    def _get_resilience_policy(self) -> LLMResiliencePolicy:
        """Return (and lazily create) the resilience policy for this provider."""
        if self._resilience_policy is None:
            # Derive the provider name from the module path, e.g.
            # ``nodes.src.nodes.llm_openai.IInstance`` -> ``openai``.
            provider = type(self).__module__.rsplit('.', 1)[0].rsplit('.', 1)[-1]
            if provider.startswith('llm_vision_'):
                provider = provider[len('llm_vision_'):]
            elif provider.startswith('llm_'):
                provider = provider[4:]
            self.__class__._resilience_policy = create_resilience_policy(provider)
        return self._resilience_policy

    def _question(self, question: Question) -> Answer:
        # Execute the LLM call through the resilience policy (circuit breaker + retry).
        policy = self._get_resilience_policy()
        try:
            answer = policy.execute(self.IGlobal._chat.chat, question)
        except CircuitBreakerOpenError:
            raise
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
