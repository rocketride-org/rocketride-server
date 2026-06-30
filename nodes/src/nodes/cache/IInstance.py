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

"""
Semantic cache node — per-object instance.

On a question the node embeds the prompt and looks it up in the shared cache:
  - HIT  -> emit the cached answer and do NOT forward the question, so the
            downstream LLM never runs (same "question in, answer out" move the
            LLM node itself makes).
  - MISS -> forward the question to the LLM, remember the pending query, and
            store the LLM's answer when it comes back through ``writeAnswers``.

Wire it around an LLM:  ... -> cache -> llm -> cache -> response  (the cache
sits on both the questions and answers lanes, like ``memory_persistent``).
"""

from __future__ import annotations

import time

from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Question, Answer

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Pipeline instance for the cache node."""

    IGlobal: IGlobal

    # The (vector, query_text) of an in-flight cache miss, awaiting the LLM's
    # answer on this same object. Reset per object in open(); read in
    # writeAnswers(). Mirrors memory_persistent's per-object correlation.
    _pending = None

    def open(self, _obj: Entry) -> None:
        """Reset per-object state for the current pipeline item."""
        self._pending = None

    def _question_text(self, question: Question) -> str:
        """Build the cache key text from a question's prompts and context.

        Context is included so that, in a RAG pipeline, a different retrieved
        context produces a different key (and correctly misses) — only an
        identical question *and* context reuse a cached answer.
        """
        parts = []
        if getattr(question, 'questions', None):
            parts.extend(q.text for q in question.questions if getattr(q, 'text', None))
        if getattr(question, 'context', None):
            parts.extend(str(c) for c in question.context)
        return ' '.join(p for p in parts if p).strip()

    def writeQuestions(self, question: Question) -> None:
        """Serve from cache on a hit; otherwise forward to the LLM."""
        cache = self.IGlobal.cache
        embedder = self.IGlobal.embedder

        # Not initialised (e.g. CONFIG mode) — pass through untouched.
        if cache is None or embedder is None:
            self.instance.writeQuestions(question)
            return

        text = self._question_text(question)
        if not text:
            # Nothing to key on — forward without caching.
            self.instance.writeQuestions(question)
            return

        vector = embedder.embed(text)
        cached = cache.lookup(vector, time.time())

        if cached is not None:
            # HIT: answer straight from cache, skip the LLM entirely.
            debug(f'cache hit (hit rate {cache.hit_rate:.0%}, {len(cache)} entries) — skipping LLM')
            answer = Answer()
            answer.setAnswer(cached)
            self.instance.writeAnswers(answer)
            return

        # MISS: remember the query so writeAnswers() can store the response,
        # then forward to the LLM.
        self._pending = (vector, text)
        self.instance.writeQuestions(question)

    def writeAnswers(self, answer: Answer) -> None:
        """Store the LLM's answer for a pending miss, then forward downstream."""
        cache = self.IGlobal.cache

        if cache is not None and self._pending is not None:
            text = answer.getText() if answer is not None else ''
            if text:
                vector, query = self._pending
                cache.add(vector, query, text, time.time())
                debug(f'cache store ({len(cache)} entries)')

        self._pending = None
        self.instance.writeAnswers(answer)

    def close(self) -> None:
        """Reset state on close."""
        self._pending = None
