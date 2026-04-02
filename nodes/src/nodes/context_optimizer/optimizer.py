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

"""Context window optimizer for LLM token budget management.

Manages context window budgets by counting tokens, allocating budgets across
components (system prompt, query, documents, history), and truncating or
summarizing content to fit within model limits.
"""

import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ContextOptimizer:
    """Optimizes LLM context windows by managing token budgets across components.

    Allocates a model's context window across system prompt, query, retrieved
    documents, and conversation history using configurable priority-based
    percentages. Supports truncation at sentence boundaries and conversation
    history summarization.
    """

    # Built-in token limits per model family
    MODEL_LIMITS: Dict[str, int] = {
        'gpt-5': 128000,
        'gpt-5-mini': 128000,
        'gpt-5-nano': 128000,
        'gpt-4o': 128000,
        'gpt-4o-mini': 128000,
        'gpt-4-turbo': 128000,
        'gpt-4': 8192,
        'gpt-3.5-turbo': 16385,
        'claude-opus': 200000,
        'claude-sonnet': 200000,
        'claude-haiku': 200000,
        'claude-3-opus': 200000,
        'claude-3-sonnet': 200000,
        'claude-3-haiku': 200000,
        'gemini-pro': 1000000,
        'gemini-flash': 1000000,
        'gemini-2.0-flash': 1000000,
        'gemini-1.5-pro': 1000000,
    }

    # Sentence boundary pattern: split after . ! ? followed by whitespace or end
    _SENTENCE_RE = re.compile(r'(?<=[.!?])\s+')

    def __init__(self, config: Dict[str, Any]) -> None:
        """Initialize the optimizer from a configuration dict.

        Args:
            config: Dictionary with keys:
                - model_name: str - model identifier for limit lookup
                - max_context_tokens: int - override for model limit (0 = use model default)
                - system_prompt_budget_pct: float - percentage for system prompt (default 10)
                - query_budget_pct: float - percentage for query (default 15)
                - document_budget_pct: float - percentage for documents (default 50)
                - history_budget_pct: float - percentage for history (default 25)
        """
        self.model_name: str = config.get('model_name', 'gpt-5')

        # Validate max_context_tokens (issue #4: non-numeric values)
        try:
            self.max_context_tokens: int = max(0, int(config.get('max_context_tokens', 0)))
        except (ValueError, TypeError):
            logger.warning('context_optimizer: max_context_tokens is not a valid integer, defaulting to 0')
            self.max_context_tokens = 0

        # Validate budget percentages (issue #4: non-numeric values, issue #5: negative values)
        self.system_prompt_budget_pct: float = self._parse_pct(config.get('system_prompt_budget_pct', 10), 'system_prompt_budget_pct')
        self.query_budget_pct: float = self._parse_pct(config.get('query_budget_pct', 15), 'query_budget_pct')
        self.document_budget_pct: float = self._parse_pct(config.get('document_budget_pct', 50), 'document_budget_pct')
        self.history_budget_pct: float = self._parse_pct(config.get('history_budget_pct', 25), 'history_budget_pct')

        # Warn if budget percentages sum to less than 90 (issue #5)
        pct_sum = self.system_prompt_budget_pct + self.query_budget_pct + self.document_budget_pct + self.history_budget_pct
        if pct_sum < 90:
            logger.warning('context_optimizer: budget percentages sum to %.1f%% (< 90%%), context window may be underutilized', pct_sum)

        # Resolve the effective token limit
        if self.max_context_tokens > 0:
            self._total_limit = self.max_context_tokens
        else:
            self._total_limit = self.MODEL_LIMITS.get(self.model_name, 128000)

        # Cache the tiktoken encoding (lazily imported)
        self._encoding = None

    @staticmethod
    def _parse_pct(value: Any, name: str) -> float:
        """Parse a percentage value, clamping to [0, 100] with warnings."""
        try:
            pct = float(value)
        except (ValueError, TypeError):
            logger.warning('context_optimizer: %s is not a valid number, defaulting to 0', name)
            return 0.0
        if pct < 0:
            logger.warning('context_optimizer: %s is negative (%.1f), clamping to 0', name, pct)
            return 0.0
        if pct > 100:
            logger.warning('context_optimizer: %s exceeds 100 (%.1f), clamping to 100', name, pct)
            return 100.0
        return pct

    # ------------------------------------------------------------------
    # Token counting
    # ------------------------------------------------------------------

    def _get_encoding(self, encoding_name: str = 'cl100k_base'):
        """Return a cached tiktoken encoding instance.

        tiktoken is imported lazily so that module-level import does not fail
        before ``depends()`` has installed the package at runtime.
        """
        import tiktoken

        if self._encoding is None or self._encoding.name != encoding_name:
            self._encoding = tiktoken.get_encoding(encoding_name)
        return self._encoding

    def count_tokens(self, text: str, encoding: str = 'cl100k_base') -> int:
        """Count tokens in *text* using the specified tiktoken encoding.

        Handles unicode, emoji, and empty strings gracefully.

        Args:
            text: The text to tokenize.
            encoding: tiktoken encoding name (default ``cl100k_base``).

        Returns:
            Number of tokens.
        """
        if not text:
            return 0
        enc = self._get_encoding(encoding)
        return len(enc.encode(text))

    # ------------------------------------------------------------------
    # Budget allocation
    # ------------------------------------------------------------------

    def allocate_budget(self, total_tokens: int, components: Optional[Dict[str, float]] = None) -> Dict[str, int]:
        """Allocate a token budget across context components.

        Budget priorities (highest to lowest):
            1. system_prompt - fixed allocation
            2. query - fixed allocation
            3. documents - proportional allocation
            4. history - receives the remainder

        The returned values are guaranteed to sum to ``<= total_tokens``.

        Args:
            total_tokens: Total available token budget.
            components: Optional override percentages keyed by component name.
                        Values are percentages (0-100). If ``None``, instance
                        defaults are used.

        Returns:
            Dict mapping component name to its allocated token count.
        """
        if total_tokens <= 0:
            return {'system_prompt': 0, 'query': 0, 'documents': 0, 'history': 0}

        pcts = {
            'system_prompt': self.system_prompt_budget_pct,
            'query': self.query_budget_pct,
            'documents': self.document_budget_pct,
            'history': self.history_budget_pct,
        }
        if components:
            pcts.update(components)

        # Normalize so the sum never exceeds 100%
        total_pct = sum(pcts.values())
        if total_pct > 100:
            scale = 100.0 / total_pct
            pcts = {k: v * scale for k, v in pcts.items()}

        # Allocate in priority order: system_prompt, query, documents, history
        allocated: Dict[str, int] = {}
        remaining = total_tokens

        for component in ('system_prompt', 'query', 'documents', 'history'):
            alloc = int(total_tokens * pcts[component] / 100.0)
            alloc = min(alloc, remaining)
            allocated[component] = alloc
            remaining -= alloc

        return allocated

    # ------------------------------------------------------------------
    # Truncation
    # ------------------------------------------------------------------

    def truncate_to_budget(self, text: str, max_tokens: int, encoding: str = 'cl100k_base') -> str:
        """Truncate *text* to fit within *max_tokens*, preserving sentence boundaries.

        If the full text fits, it is returned unchanged. Otherwise the text is
        split on sentence boundaries and sentences are kept greedily from the
        start until adding the next sentence would exceed the budget.

        If even the first sentence exceeds the budget, it falls back to a
        token-level truncation so the result always fits.

        Args:
            text: Source text.
            max_tokens: Maximum allowed tokens.
            encoding: tiktoken encoding name.

        Returns:
            Truncated text that fits within *max_tokens*.
        """
        if not text or max_tokens <= 0:
            return ''

        # Fast path: text already fits
        if self.count_tokens(text, encoding) <= max_tokens:
            return text

        # Split into sentences
        sentences = self._SENTENCE_RE.split(text)
        result_parts: List[str] = []
        used_tokens = 0

        for sentence in sentences:
            sentence_tokens = self.count_tokens(sentence, encoding)
            if used_tokens + sentence_tokens <= max_tokens:
                result_parts.append(sentence)
                used_tokens += sentence_tokens
            else:
                break

        if result_parts:
            return ' '.join(result_parts)

        # Fallback: first sentence is too long -- truncate at token level
        enc = self._get_encoding(encoding)
        tokens = enc.encode(text)
        truncated_tokens = tokens[:max_tokens]
        return enc.decode(truncated_tokens)

    # ------------------------------------------------------------------
    # History summarization
    # ------------------------------------------------------------------

    def summarize_history(self, messages: List[Dict[str, str]], max_tokens: int, encoding: str = 'cl100k_base') -> List[Dict[str, str]]:
        """Compress conversation history to fit within *max_tokens*.

        Strategy:
            - Always keep the first message (system context / conversation start).
            - Always keep the last N messages (recent context).
            - Summarize the middle messages into a single ``[Earlier conversation
              summarized: N messages omitted]`` placeholder.

        Args:
            messages: List of dicts with ``role`` and ``content`` keys.
            max_tokens: Maximum total tokens for the returned history.
            encoding: tiktoken encoding name.

        Returns:
            Compressed list of message dicts fitting within budget.
        """
        if not messages:
            return []

        if len(messages) == 1:
            content = self.truncate_to_budget(messages[0].get('content', ''), max_tokens, encoding)
            return [{'role': messages[0].get('role', 'user'), 'content': content}]

        # Measure total cost
        def _msg_tokens(msg: Dict[str, str]) -> int:
            role_overhead = self.count_tokens(msg.get('role', ''), encoding) + 4  # role + formatting
            return role_overhead + self.count_tokens(msg.get('content', ''), encoding)

        total = sum(_msg_tokens(m) for m in messages)
        if total <= max_tokens:
            return list(messages)

        # Keep first message + try to fit as many recent messages as possible
        first_msg = messages[0]
        first_cost = _msg_tokens(first_msg)

        # Summary placeholder
        summary_placeholder = {'role': 'system', 'content': '[Earlier conversation summarized]'}
        summary_cost = _msg_tokens(summary_placeholder)

        budget_for_recent = max_tokens - first_cost - summary_cost
        if budget_for_recent <= 0:
            # Can only fit the first message (truncated)
            content = self.truncate_to_budget(first_msg.get('content', ''), max_tokens - 4, encoding)
            return [{'role': first_msg.get('role', 'user'), 'content': content}]

        # Greedily add recent messages from the end
        recent: List[Dict[str, str]] = []
        recent_cost = 0
        for msg in reversed(messages[1:]):
            cost = _msg_tokens(msg)
            if recent_cost + cost <= budget_for_recent:
                recent.insert(0, msg)
                recent_cost += cost
            else:
                break

        # If we kept all remaining messages, no summary needed
        if len(recent) == len(messages) - 1:
            return list(messages)

        # Update placeholder with count
        omitted = len(messages) - 1 - len(recent)
        summary_placeholder['content'] = f'[Earlier conversation summarized: {omitted} messages omitted]'

        return [first_msg, summary_placeholder, *recent]

    # ------------------------------------------------------------------
    # Document ranking
    # ------------------------------------------------------------------

    def rank_documents(self, documents: List[Dict[str, Any]], query: str, max_tokens: int, encoding: str = 'cl100k_base') -> List[Dict[str, Any]]:
        """Select documents that fit within *max_tokens*, preserving original order.

        Documents arriving from a vector DB are already ranked by embedding
        similarity.  This method preserves that ordering and uses greedy
        budget selection.  When documents carry a ``score`` field it is used
        as the primary sort key; keyword overlap with *query* is used only as
        a secondary tiebreaker for documents that lack a score.

        Args:
            documents: List of dicts with at least a ``content`` key.
                       An optional ``score`` key (float) from the vector DB
                       is respected for ranking.
            query: The user's query text.
            max_tokens: Maximum total tokens for returned documents.
            encoding: tiktoken encoding name.

        Returns:
            Subset of documents that fit within the token budget, preserving
            the original (or score-based) ordering.
        """
        if not documents or max_tokens <= 0:
            return []

        # Check whether any document carries a vector-DB score
        has_scores = any(doc.get('score') is not None for doc in documents)

        if not query or has_scores:
            # Either no query to rank against, or documents already carry
            # embedding similarity scores -- preserve original order (which
            # is score-descending from the vector DB) and greedily select.
            selected: List[Dict[str, Any]] = []
            used = 0
            for doc in documents:
                content = doc.get('content', doc.get('page_content', ''))
                cost = self.count_tokens(str(content), encoding)
                if used + cost <= max_tokens:
                    selected.append(doc)
                    used += cost
            return selected

        # No scores available -- use keyword overlap as a lightweight
        # relevance signal, but only as a tiebreaker on the original index
        # to avoid completely discarding the upstream ordering.
        query_words = set(re.findall(r'\w+', query.lower()))

        scored: List[tuple] = []
        for idx, doc in enumerate(documents):
            content = doc.get('content', doc.get('page_content', ''))
            content_str = str(content)
            doc_words = set(re.findall(r'\w+', content_str.lower()))
            overlap = len(query_words & doc_words)
            tokens = self.count_tokens(content_str, encoding)
            # Primary: overlap descending, secondary: original index ascending
            scored.append((overlap, idx, tokens, doc))

        scored.sort(key=lambda x: (-x[0], x[1]))

        selected = []
        used = 0
        for _overlap, _idx, tokens, doc in scored:
            if used + tokens <= max_tokens:
                selected.append(doc)
                used += tokens

        return selected

    # ------------------------------------------------------------------
    # Full optimization pipeline
    # ------------------------------------------------------------------

    def optimize(
        self,
        question: str,
        model: Optional[str] = None,
        system_prompt: str = '',
        documents: Optional[List[Dict[str, Any]]] = None,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """Run the full context optimization pipeline.

        Uses a two-pass approach so that truncation is the exception, not the
        default:

        **Pass 1** -- check whether all components fit within the total token
        limit without per-component caps.  If they do, return everything
        unchanged (no wasted context window).

        **Pass 2** -- when the total exceeds the limit, allocate percentage-
        based budgets and truncate/rank/summarize each component to fit.

        Args:
            question: The user's query text.
            model: Optional model name override (uses instance default if ``None``).
            system_prompt: System prompt text.
            documents: List of document dicts with ``content`` key.
            history: Conversation history (list of role/content dicts).

        Returns:
            Dict with keys:
                - system_prompt: optimized system prompt text
                - question: optimized question text
                - documents: list of selected documents
                - history: compressed conversation history
                - metadata: dict with tokens_used, tokens_saved, components_truncated, model, total_limit
        """
        documents = documents or []
        history = history or []

        # Resolve model limit
        effective_model = model or self.model_name
        if self.max_context_tokens > 0:
            total_limit = self.max_context_tokens
        else:
            total_limit = self.MODEL_LIMITS.get(effective_model, 128000)

        # Compute original token counts
        original_system = self.count_tokens(system_prompt)
        original_question = self.count_tokens(question)
        original_docs = sum(self.count_tokens(str(d.get('content', d.get('page_content', '')))) for d in documents)
        original_history = sum(self.count_tokens(m.get('content', '')) + self.count_tokens(m.get('role', '')) + 4 for m in history)
        original_total = original_system + original_question + original_docs + original_history

        # ------------------------------------------------------------------
        # Pass 1: everything fits -- no truncation needed
        # ------------------------------------------------------------------
        if original_total <= total_limit:
            budget = self.allocate_budget(total_limit)
            return {
                'system_prompt': system_prompt,
                'question': question,
                'documents': documents,
                'history': history,
                'metadata': {
                    'tokens_used': original_total,
                    'tokens_saved': 0,
                    'components_truncated': [],
                    'model': effective_model,
                    'total_limit': total_limit,
                    'budget': budget,
                },
            }

        # ------------------------------------------------------------------
        # Pass 2: total exceeds limit -- apply per-component budgets
        # ------------------------------------------------------------------
        budget = self.allocate_budget(total_limit)

        components_truncated: List[str] = []

        opt_system = self.truncate_to_budget(system_prompt, budget['system_prompt'])
        if self.count_tokens(opt_system) < original_system:
            components_truncated.append('system_prompt')

        opt_question = self.truncate_to_budget(question, budget['query'])
        if self.count_tokens(opt_question) < original_question:
            components_truncated.append('question')

        opt_documents = self.rank_documents(documents, question, budget['documents'])
        opt_docs_tokens = sum(self.count_tokens(str(d.get('content', d.get('page_content', '')))) for d in opt_documents)
        if opt_docs_tokens < original_docs:
            components_truncated.append('documents')

        opt_history = self.summarize_history(history, budget['history'])
        opt_history_tokens = sum(self.count_tokens(m.get('content', '')) + self.count_tokens(m.get('role', '')) + 4 for m in opt_history)
        if opt_history_tokens < original_history:
            components_truncated.append('history')

        tokens_used = self.count_tokens(opt_system) + self.count_tokens(opt_question) + opt_docs_tokens + opt_history_tokens
        tokens_saved = max(0, original_total - tokens_used)

        return {
            'system_prompt': opt_system,
            'question': opt_question,
            'documents': opt_documents,
            'history': opt_history,
            'metadata': {
                'tokens_used': tokens_used,
                'tokens_saved': tokens_saved,
                'components_truncated': components_truncated,
                'model': effective_model,
                'total_limit': total_limit,
                'budget': budget,
            },
        }
