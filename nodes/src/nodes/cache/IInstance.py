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

import json
import time

from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Question, Answer

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Pipeline instance for the cache node."""

    IGlobal: IGlobal

    # The (vector, query_text, scope, expect_json) of an in-flight cache miss,
    # awaiting the LLM's answer on this same object. Reset per object in open();
    # read in writeAnswers(). Mirrors memory_persistent's per-object correlation.
    _pending = None

    def open(self, _obj: Entry) -> None:
        """Reset per-object state for the current pipeline item."""
        self._pending = None

    def _forward_question(self, question: Question) -> None:
        """Forward a question downstream exactly once.

        `preventDefault()` raises APERR(Ec.PreventDefault) immediately, so it
        must come AFTER the explicit forward call. The engine always default-forwards
        the incoming payload after a Python override returns normally unless
        preventDefault() was raised, so calling it here is required to avoid
        duplicate delivery.
        """
        self.instance.writeQuestions(question)
        self.preventDefault()

    def _forward_answer(self, answer: Answer) -> None:
        """Forward an answer downstream exactly once and suppress engine default forward."""
        self.instance.writeAnswers(answer)
        self.preventDefault()

    def _extract_scope(self, question: Question) -> str:
        """Extract a stable tenant/session scope string for cache isolation."""
        parts = []
        pipe_scope = getattr(self.IGlobal, 'scope', '')
        if pipe_scope:
            parts.append(f'pipe:{pipe_scope}')

        meta = getattr(question, 'metadata', None)
        meta_dict = meta if isinstance(meta, dict) else {}

        tenant = (
            meta_dict.get('tenant_id')
            or meta_dict.get('tenant')
            or meta_dict.get('account_id')
            or getattr(question, 'tenant_id', None)
        )
        if tenant:
            parts.append(f'tenant:{tenant}')

        session = meta_dict.get('session_id') or meta_dict.get('sessionId') or getattr(question, 'session_id', None)
        if session:
            parts.append(f'session:{session}')

        user = (
            meta_dict.get('user_id')
            or meta_dict.get('userId')
            or meta_dict.get('identity')
            or getattr(question, 'user_id', None)
        )
        if user:
            parts.append(f'user:{user}')

        return ';'.join(parts)

    def _question_text(self, question: Question, scope: str = '') -> str:
        """Build a stable field-delimited cache key identity from a question.

        Incorporates all response-shaping fields (role, instructions, history,
        examples, goals, documents, filters, expectJson, questions, context, scope).
        Context and prompt instructions contribute to the semantic match, but
        semantic matching operates on embedding similarity rather than complete
        isolation: a changed yet sufficiently similar context may reuse a cached
        answer and bypass the LLM. Tenant and session identity are strictly
        partitioned.
        """
        questions = []
        raw_questions = getattr(question, 'questions', None)
        if raw_questions:
            for q in raw_questions:
                txt = getattr(q, 'text', None) if not isinstance(q, str) else q
                if txt:
                    questions.append(str(txt).strip())

        if not questions:
            return ''

        context = []
        raw_context = getattr(question, 'context', None)
        if raw_context:
            for c in raw_context:
                if c is not None:
                    context.append(str(c).strip())

        role = str(getattr(question, 'role', '') or '').strip()

        instructions = []
        raw_instructions = getattr(question, 'instructions', None)
        if raw_instructions:
            for inst in raw_instructions:
                if isinstance(inst, dict):
                    instructions.append(
                        {
                            'subtitle': str(inst.get('subtitle', '')).strip(),
                            'instructions': str(inst.get('instructions', '')).strip(),
                        }
                    )
                else:
                    instructions.append(
                        {
                            'subtitle': str(getattr(inst, 'subtitle', '')).strip(),
                            'instructions': str(getattr(inst, 'instructions', '')).strip(),
                        }
                    )

        history = []
        raw_history = getattr(question, 'history', None)
        if raw_history:
            for h in raw_history:
                if isinstance(h, dict):
                    history.append(
                        {
                            'role': str(h.get('role', '')).strip(),
                            'content': str(h.get('content', '')).strip(),
                        }
                    )
                else:
                    history.append(
                        {
                            'role': str(getattr(h, 'role', '')).strip(),
                            'content': str(getattr(h, 'content', '')).strip(),
                        }
                    )

        examples = []
        raw_examples = getattr(question, 'examples', None)
        if raw_examples:
            for ex in raw_examples:
                if isinstance(ex, dict):
                    examples.append(
                        {
                            'given': str(ex.get('given', '')).strip(),
                            'result': str(ex.get('result', '')).strip(),
                        }
                    )
                else:
                    examples.append(
                        {
                            'given': str(getattr(ex, 'given', '')).strip(),
                            'result': str(getattr(ex, 'result', '')).strip(),
                        }
                    )

        goals = []
        raw_goals = getattr(question, 'goals', None)
        if raw_goals:
            for g in raw_goals:
                if g:
                    goals.append(str(g).strip())

        documents = []
        raw_docs = getattr(question, 'documents', None)
        if raw_docs:
            for doc in raw_docs:
                if hasattr(doc, 'model_dump'):
                    d = doc.model_dump()
                    documents.append(
                        {
                            'content': str(d.get('page_content', '')).strip(),
                            'metadata': d.get('metadata'),
                        }
                    )
                elif hasattr(doc, 'toDict'):
                    d = doc.toDict()
                    documents.append(
                        {
                            'content': str(d.get('page_content', '')).strip(),
                            'metadata': d.get('metadata'),
                        }
                    )
                elif isinstance(doc, dict):
                    documents.append(
                        {
                            'content': str(doc.get('page_content', '')).strip(),
                            'metadata': doc.get('metadata'),
                        }
                    )
                else:
                    documents.append(
                        {
                            'content': str(getattr(doc, 'page_content', doc)).strip(),
                            'metadata': getattr(doc, 'metadata', None),
                        }
                    )

        doc_filter = None
        raw_filter = getattr(question, 'filter', None)
        if raw_filter is not None:
            if hasattr(raw_filter, 'model_dump'):
                doc_filter = raw_filter.model_dump()
            elif hasattr(raw_filter, '__dict__'):
                doc_filter = dict(raw_filter.__dict__)
            elif isinstance(raw_filter, dict):
                doc_filter = raw_filter
            else:
                doc_filter = str(raw_filter)

        expect_json = bool(getattr(question, 'expectJson', False))

        identity = {
            'context': context,
            'documents': documents,
            'examples': examples,
            'expectJson': expect_json,
            'filter': doc_filter,
            'goals': goals,
            'history': history,
            'instructions': instructions,
            'questions': questions,
            'role': role,
            'scope': scope,
        }

        return json.dumps(identity, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

    def writeQuestions(self, question: Question) -> None:
        """Serve from cache on a hit; otherwise forward to the LLM."""
        cache = self.IGlobal.cache
        embedder = self.IGlobal.embedder

        # Not initialised or failed initialisation — pass through untouched.
        if cache is None or embedder is None:
            self._forward_question(question)
            return

        scope = self._extract_scope(question)
        text = self._question_text(question, scope=scope)
        if not text:
            # Nothing to key on — forward without caching.
            self._forward_question(question)
            return

        try:
            vector = embedder.embed(text)
        except Exception as e:
            debug(f'cache embedder failed: {e} — falling back to LLM')
            self._forward_question(question)
            return

        expect_json = bool(getattr(question, 'expectJson', False))
        cached = cache.lookup(vector, time.time(), scope=scope)

        if cached is not None:
            # Type and expectation parity: ensure hit preserves structured payload
            cached_payload = cached
            cached_expect_json = expect_json
            if isinstance(cached, dict) and 'payload' in cached:
                cached_expect_json = bool(cached.get('expectJson', False))
                cached_payload = cached['payload']

            if cached_expect_json == expect_json:
                # HIT: answer straight from cache, skip the LLM entirely.
                debug(f'cache hit (hit rate {cache.hit_rate:.0%}, {len(cache)} entries) — skipping LLM')
                answer = Answer(expectJson=expect_json)
                answer.setAnswer(cached_payload)
                self._forward_answer(answer)
                return

        # MISS: remember the query and scope so writeAnswers() can store the response,
        # then forward to the LLM.
        self._pending = (vector, text, scope, expect_json)
        self._forward_question(question)

    def writeAnswers(self, answer: Answer) -> None:
        """Store the LLM's answer for a pending miss, then forward downstream."""
        cache = self.IGlobal.cache

        if cache is not None and self._pending is not None:
            vector, query, scope, expect_json = self._pending
            payload = getattr(answer, 'answer', None)
            if payload is None and hasattr(answer, 'getText'):
                payload = answer.getText()

            if payload is not None and (payload != '' or expect_json):
                ans_expect_json = getattr(answer, 'expectJson', expect_json)
                cache.add(
                    vector,
                    query,
                    {'payload': payload, 'expectJson': bool(ans_expect_json)},
                    time.time(),
                    scope=scope,
                )
                debug(f'cache store ({len(cache)} entries)')

        self._pending = None
        self._forward_answer(answer)

    def close(self) -> None:
        """Reset state on close."""
        self._pending = None
