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

# ------------------------------------------------------------------------------
# This class controls the data for each thread of the task
# ------------------------------------------------------------------------------
from rocketlib import IInstanceBase
from ai.common.schema import Question, Answer
from .IGlobal import IGlobal
from .cache_client import CacheClient


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    _pending_cache_key: str | None = None

    def writeQuestions(self, question: Question):
        """Cache-through handler for LLM questions.

        1. Generate a cache key from the question text, model, and temperature.
        2. Check the cache -- if hit, write the cached answer directly and return.
        3. On a miss, store the key for caching the answer later, then pass through.
        """
        cache = self.IGlobal.cache
        if cache is None:
            # No cache available (e.g., Redis connection failed) -- pass through
            self.instance.writeQuestions(question)
            return

        # Extract key components from the question
        query_text = ''
        if question.questions:
            query_text = ' '.join(q.text for q in question.questions if q.text)

        model = ''
        temperature = 0.0
        system_prompt = question.role or ''

        # Generate cache key
        cache_key = CacheClient._generate_key(query_text, model, temperature, system_prompt)

        # Check cache
        cached = cache.get(cache_key)
        if cached is not None:
            # Cache hit -- reconstruct the answer and write it directly
            self.IGlobal.cache_hits += 1

            answer = Answer()
            cached_answer = cached.get('answer', '')
            cached_expect_json = cached.get('expectJson', False)

            if cached_expect_json:
                answer.expectJson = True

            answer.answer = cached_answer
            self.instance.writeAnswers(answer)
            return

        # Cache miss -- store the key so writeAnswers can cache the response
        self.IGlobal.cache_misses += 1
        self._pending_cache_key = cache_key
        self.instance.writeQuestions(question)

    def writeAnswers(self, answer: Answer):
        """Intercept answers from the downstream LLM and cache them before forwarding.

        This method is called when the downstream LLM node produces an answer.
        We cache it using the key stored during writeQuestions and then forward it.
        """
        cache = self.IGlobal.cache

        if cache is not None and self._pending_cache_key is not None:
            # Build the response dict to cache
            response = {
                'answer': answer.answer,
                'expectJson': answer.expectJson,
            }

            cache.set(self._pending_cache_key, response)
            self._pending_cache_key = None

        # Forward the answer downstream
        self.instance.writeAnswers(answer)
