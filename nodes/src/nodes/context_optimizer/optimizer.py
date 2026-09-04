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

Token counting uses ``tiktoken``. Note that tiktoken downloads its BPE
vocabulary from ``openaipublic.blob.core.windows.net`` the first time a given
encoding is requested and caches it on disk; set ``TIKTOKEN_CACHE_DIR`` to a
pre-seeded directory to run fully offline.
"""

import json
import re
from pathlib import Path
from typing import Any, ClassVar, Dict, List, Optional

from rocketlib import warning

#: Limit used when neither the live model catalog nor :attr:`MODEL_LIMITS`
#: knows the configured model id.
DEFAULT_MODEL_LIMIT = 128000

#: Model id assumed when ``model_name`` is absent or is not a non-empty string.
#: Matches the ``model_name`` default declared in ``services.json``.
DEFAULT_MODEL_NAME = 'gpt-5'


class ContextOptimizer:
    """Optimizes LLM context windows by managing token budgets across components.

    Allocates a model's context window across system prompt, query, retrieved
    documents, and conversation history using configurable priority-based
    percentages. Supports truncation at sentence boundaries and conversation
    history summarization.

    Context-window sizes are resolved in three steps (see
    :meth:`resolve_model_limit`):

    1. the live model catalog -- the ``modelTotalTokens`` values carried by the
       ``preconfig.profiles`` of every sibling ``llm_*`` node's
       ``services*.json``, which the ``sync-models`` workflow keeps in step
       with the providers;
    2. :attr:`MODEL_LIMITS`, a small hand-maintained fallback table (also used
       for the abbreviated aliases such as ``claude-sonnet``);
    3. :data:`DEFAULT_MODEL_LIMIT`, with a warning.

    Setting ``max_context_tokens`` explicitly bypasses all three.
    """

    # Built-in fallback token limits.  Refreshed 2026-09-04 against the LLM node
    # catalogue on develop (`modelTotalTokens` in each `llm_*/services*.json`
    # profile, maintained by the sync-models workflow).  This table is only
    # consulted when the live catalog lookup below yields nothing -- it exists
    # so the node keeps working if the sibling LLM nodes are not deployed, and
    # so the abbreviated family aliases (`claude-sonnet`, `gemini-pro`, ...)
    # that no provider actually publishes still resolve.
    MODEL_LIMITS: ClassVar[Dict[str, int]] = {
        # OpenAI
        'gpt-3.5-turbo': 16385,
        'gpt-4': 8191,
        'gpt-4-turbo': 128000,
        'gpt-4.1': 1047576,
        'gpt-4.1-mini': 1047576,
        'gpt-4.1-nano': 1047576,
        'gpt-4o': 128000,
        'gpt-4o-mini': 128000,
        'gpt-5': 400000,
        'gpt-5-mini': 400000,
        'gpt-5-nano': 400000,
        'gpt-5.1': 400000,
        'gpt-5.2': 400000,
        'gpt-5.4': 1050000,
        'gpt-5.4-mini': 400000,
        'gpt-5.4-nano': 400000,
        'gpt-5.4-pro': 1050000,
        'gpt-latest': 1050000,
        'gpt-mini-latest': 400000,
        'o1': 200000,
        'o3': 200000,
        'o3-mini': 200000,
        'o4-mini': 200000,
        # Anthropic
        'claude-3-haiku': 200000,
        'claude-haiku-4-5': 200000,
        'claude-opus-4': 200000,
        'claude-opus-4-5': 200000,
        'claude-opus-4-6': 1000000,
        'claude-sonnet-4': 1000000,
        'claude-sonnet-4-5': 1000000,
        'claude-sonnet-4-6': 1000000,
        'claude-haiku-latest': 200000,
        'claude-opus-latest': 1000000,
        'claude-sonnet-latest': 1000000,
        # Abbreviated family aliases (no provider publishes these ids; they
        # mirror the corresponding `*-latest` catalogue entry).
        'claude-haiku': 200000,
        'claude-opus': 1000000,
        'claude-sonnet': 1000000,
        # Google
        'gemini-3.1-pro-preview': 1048576,
        'gemini-3.1-flash-lite': 1048576,
        'gemini-3.5-flash': 1048576,
        'gemini-3.6-flash': 1048576,
        'gemini-flash-latest': 1048576,
        'gemini-pro-latest': 1048576,
        'gemini-flash': 1048576,
        'gemini-pro': 1048576,
    }

    # Live model catalog: the directory that holds the sibling node packages
    # (`nodes/src/nodes` in the source tree, `dist/server/nodes` once
    # `nodes:sync` has copied them).  Each `llm_*/services*.json` carries
    # `preconfig.profiles.<key>.model` / `.modelTotalTokens`.
    _CATALOG_ROOT: ClassVar[Path] = Path(__file__).resolve().parent.parent
    _CATALOG_GLOB: ClassVar[str] = 'llm_*/services*.json'
    _catalog_cache: ClassVar[Optional[Dict[str, int]]] = None

    # tiktoken encoding overrides for model families tiktoken may not map yet.
    # The gpt-5 / gpt-4o families use ``o200k_base``; matched by prefix so the
    # ``-mini`` / ``-nano`` / ``-turbo`` variants resolve too. Anything not
    # matched here is resolved via ``tiktoken.encoding_for_model()`` at runtime,
    # with ``_DEFAULT_ENCODING`` as the fallback for ids tiktoken does not know
    # (non-OpenAI models like Claude / Gemini, or a bare ``custom``).
    _MODEL_ENCODING_OVERRIDES: ClassVar[Dict[str, str]] = {
        'gpt-5': 'o200k_base',
        'gpt-4o': 'o200k_base',
    }
    _DEFAULT_ENCODING: ClassVar[str] = 'cl100k_base'

    # Sentence boundary pattern: split after . ! ? followed by whitespace or end
    _SENTENCE_RE = re.compile(r'(?<=[.!?])\s+')

    def __init__(self, config: Dict[str, Any]) -> None:
        """Initialize the optimizer from a configuration dict.

        Args:
            config: Dictionary with keys:
                - model_name: str - model identifier for limit lookup (an id published
                  by one of the ``llm_*`` nodes, e.g. ``gpt-5.4``, ``claude-sonnet-4-6``);
                  anything that is not a non-empty string falls back to
                  :data:`DEFAULT_MODEL_NAME` with a warning
                - max_context_tokens: int - override for model limit (0 = use model default)
                - system_prompt_budget_pct: float - percentage for system prompt (default 10)
                - query_budget_pct: float - percentage for query (default 15)
                - document_budget_pct: float - percentage for documents (default 50)
                - history_budget_pct: float - percentage for history (default 25)
        """
        # Validate model_name: the schema declares a string, but nothing between
        # the pipeline JSON and here coerces one, and a null/number would blow up
        # resolve_model_limit's rsplit() during beginGlobal.
        model_name = config.get('model_name', DEFAULT_MODEL_NAME)
        if not isinstance(model_name, str) or not model_name.strip():
            warning(f'context_optimizer: model_name is not a non-empty string, defaulting to {DEFAULT_MODEL_NAME!r}')
            model_name = DEFAULT_MODEL_NAME
        self.model_name: str = model_name.strip()

        # Validate max_context_tokens (issue #4: non-numeric values)
        try:
            self.max_context_tokens: int = max(0, int(config.get('max_context_tokens', 0)))
        except (ValueError, TypeError):
            warning('context_optimizer: max_context_tokens is not a valid integer, defaulting to 0')
            self.max_context_tokens = 0

        # Validate budget percentages (issue #4: non-numeric values, issue #5: negative values)
        self.system_prompt_budget_pct: float = self._parse_pct(
            config.get('system_prompt_budget_pct', 10), 'system_prompt_budget_pct'
        )
        self.query_budget_pct: float = self._parse_pct(config.get('query_budget_pct', 15), 'query_budget_pct')
        self.document_budget_pct: float = self._parse_pct(config.get('document_budget_pct', 50), 'document_budget_pct')
        self.history_budget_pct: float = self._parse_pct(config.get('history_budget_pct', 25), 'history_budget_pct')

        # Warn if budget percentages sum to less than 90 (issue #5)
        pct_sum = (
            self.system_prompt_budget_pct + self.query_budget_pct + self.document_budget_pct + self.history_budget_pct
        )
        if pct_sum < 90:
            warning(
                f'context_optimizer: budget percentages sum to {pct_sum:.1f}% (< 90%), context window may be underutilized'
            )

        # Cache the tiktoken encoding (lazily imported) and its resolved name.
        # The name is derived from ``model_name`` on first use (see
        # ``_resolve_encoding_name``) so gpt-5 / gpt-4o count against o200k_base
        # rather than the old hardcoded cl100k_base.
        self._encoding = None
        self._encoding_name: Optional[str] = None

        # Track which model names we've already warned about, so the unknown-model
        # fallback warning is emitted once rather than on every optimize() call.
        self._warned_unknown_models: set = set()

        # Resolve the effective token limit.  ``resolve_model_limit`` consults
        # the live llm_* catalog first, then MODEL_LIMITS, and warns once when
        # neither knows the id (e.g. a typo, or a model this build predates).
        self._total_limit = self.max_context_tokens or self.resolve_model_limit(self.model_name)

    # ------------------------------------------------------------------
    # Model context-window catalog
    # ------------------------------------------------------------------

    @staticmethod
    def _strip_jsonc(text: str) -> str:
        """Strip ``//`` and ``/* */`` comments and trailing commas from JSONC.

        The engine's ``services*.json`` files are JSONC. This node must not
        depend on ``json5`` just to read them, so a small string-aware stripper
        is used instead -- it skips comment markers that appear inside string
        literals.
        """
        out: List[str] = []
        i = 0
        n = len(text)
        in_string = False
        escaped = False
        while i < n:
            char = text[i]
            if in_string:
                out.append(char)
                if escaped:
                    escaped = False
                elif char == '\\':
                    escaped = True
                elif char == '"':
                    in_string = False
                i += 1
                continue
            if char == '"':
                in_string = True
                out.append(char)
                i += 1
                continue
            if char == '/' and i + 1 < n and text[i + 1] == '/':
                while i < n and text[i] != '\n':
                    i += 1
                continue
            if char == '/' and i + 1 < n and text[i + 1] == '*':
                i += 2
                while i + 1 < n and not (text[i] == '*' and text[i + 1] == '/'):
                    i += 1
                i += 2
                continue
            out.append(char)
            i += 1
        return re.sub(r',(\s*[}\]])', r'\1', ''.join(out))

    @classmethod
    def _load_model_catalog(cls) -> Dict[str, int]:
        """Read every sibling ``llm_*`` node's model context-window catalog.

        Returns a mapping of model id -> ``modelTotalTokens``. Ids are keyed
        exactly as the profiles declare them; where two services files publish
        the same id with different windows the smaller is kept, which is the
        safe budget.

        A provider-scoped id (``models/gemini-3.1-pro-preview``,
        ``openai/gpt-5``) is additionally registered under its bare name, but
        only when that name is unambiguous: an unscoped profile always wins
        (so ``gpt-5`` keeps ``llm_openai``'s window rather than a gateway's
        re-host), and a bare name two gateways disagree about is dropped
        entirely so it falls through to :attr:`MODEL_LIMITS` instead of
        silently picking one.

        Any failure (missing directory, unreadable or malformed file) yields an
        empty mapping -- :attr:`MODEL_LIMITS` then acts as the fallback.
        """
        published: Dict[str, int] = {}  # ids exactly as the profiles declare them
        alias_values: Dict[str, set] = {}  # bare name -> every window seen for it
        try:
            paths = sorted(cls._CATALOG_ROOT.glob(cls._CATALOG_GLOB))
        except OSError:
            return {}

        def _record(table: Dict[str, int], key: str, limit: int) -> None:
            table[key] = min(table[key], limit) if key in table else limit

        for path in paths:
            try:
                service = json.loads(cls._strip_jsonc(path.read_text(encoding='utf-8')))
            except (OSError, ValueError):
                continue
            preconfig = service.get('preconfig') if isinstance(service, dict) else None
            profiles = preconfig.get('profiles') if isinstance(preconfig, dict) else None
            if not isinstance(profiles, dict):
                continue
            for profile in profiles.values():
                if not isinstance(profile, dict):
                    continue
                model = profile.get('model')
                limit = profile.get('modelTotalTokens')
                if not isinstance(model, str) or not model:
                    continue
                if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
                    continue
                _record(published, model, limit)
                bare = model.rsplit('/', 1)[-1]
                if bare and bare != model:
                    alias_values.setdefault(bare, set()).add(limit)

        # A bare alias only fills a gap that no unscoped profile claims, and
        # only when every gateway publishing it agrees on the window.
        catalog = {bare: next(iter(v)) for bare, v in alias_values.items() if len(v) == 1}
        catalog.update(published)
        return catalog

    @classmethod
    def model_catalog(cls) -> Dict[str, int]:
        """Return the cached live model context-window catalog (may be empty)."""
        if cls._catalog_cache is None:
            cls._catalog_cache = cls._load_model_catalog()
        return cls._catalog_cache

    def resolve_model_limit(self, model: str) -> int:
        """Resolve the context-window size for *model*.

        Order: live catalog, then :attr:`MODEL_LIMITS`, then
        :data:`DEFAULT_MODEL_LIMIT` (with a one-time warning per model id).

        Both lookups try the full id first and then, for a provider-scoped id,
        its bare name -- so ``openai/gpt-5`` still resolves through
        :attr:`MODEL_LIMITS` when the sibling ``llm_*`` nodes are not deployed
        and the catalog is therefore empty.
        """
        bare = model.rsplit('/', 1)[-1]
        candidates = (model,) if bare == model else (model, bare)
        catalog = self.model_catalog()
        for key in candidates:
            if key in catalog:
                return catalog[key]
        for key in candidates:
            if key in self.MODEL_LIMITS:
                return self.MODEL_LIMITS[key]
        if model not in self._warned_unknown_models:
            warning(
                f"context_optimizer: model '{model}' is in neither the LLM node catalog nor MODEL_LIMITS, "
                f'falling back to {DEFAULT_MODEL_LIMIT} tokens; use a model id published by an llm_* node '
                f'or set max_context_tokens explicitly'
            )
            self._warned_unknown_models.add(model)
        return DEFAULT_MODEL_LIMIT

    @staticmethod
    def _parse_pct(value: Any, name: str) -> float:
        """Parse a percentage value, clamping to [0, 100] with warnings."""
        try:
            pct = float(value)
        except (ValueError, TypeError):
            warning(f'context_optimizer: {name} is not a valid number, defaulting to 0')
            return 0.0
        if pct != pct:
            # NaN satisfies neither range check below, so it would survive
            # validation and blow up allocate_budget's int() conversion.
            warning(f'context_optimizer: {name} is NaN, defaulting to 0')
            return 0.0
        if pct < 0:
            warning(f'context_optimizer: {name} is negative ({pct:.1f}), clamping to 0')
            return 0.0
        if pct > 100:
            warning(f'context_optimizer: {name} exceeds 100 ({pct:.1f}), clamping to 100')
            return 100.0
        return pct

    # ------------------------------------------------------------------
    # Token counting
    # ------------------------------------------------------------------

    def encoding_name_for_model(self, model: Optional[str]) -> str:
        """Resolve the tiktoken encoding name for an arbitrary model id.

        gpt-5 / gpt-4o map to ``o200k_base`` via ``_MODEL_ENCODING_OVERRIDES``;
        older GPT ids are resolved through ``tiktoken.encoding_for_model()``.
        Non-OpenAI models (Claude, Gemini) and unknown ids fall back to
        ``_DEFAULT_ENCODING`` -- tiktoken is only an approximation for those, but
        it keeps token counts stable and non-crashing.

        Provider-scoped ids are tried full-first and then by their bare name, the
        same order :meth:`resolve_model_limit` uses. Without that, ``openai/gpt-5``
        would resolve the gpt-5 *window* by its bare name while silently counting
        its tokens with ``cl100k_base``.
        """
        model = model or ''
        bare = model.rsplit('/', 1)[-1]
        candidates = (model,) if bare == model else (model, bare)

        for candidate in candidates:
            for prefix, enc_name in self._MODEL_ENCODING_OVERRIDES.items():
                if candidate.startswith(prefix):
                    return enc_name

        import tiktoken

        for candidate in candidates:
            try:
                return tiktoken.encoding_for_model(candidate).name
            except KeyError:
                continue
        return self._DEFAULT_ENCODING

    def _resolve_encoding_name(self) -> str:
        """Resolve (and cache) the tiktoken encoding name for the configured model."""
        if self._encoding_name is None:
            self._encoding_name = self.encoding_name_for_model(self.model_name)
        return self._encoding_name

    def _get_encoding(self, encoding_name: Optional[str] = None):
        """Return a cached tiktoken encoding instance.

        When *encoding_name* is ``None`` the encoding is resolved from the
        configured model (see :meth:`_resolve_encoding_name`). tiktoken is
        imported lazily so that module-level import does not fail before
        ``depends()`` has installed the package at runtime. The cache key is the
        encoding name, so switching models/encodings rebuilds it correctly.
        """
        import tiktoken

        if encoding_name is None:
            encoding_name = self._resolve_encoding_name()

        if self._encoding is None or self._encoding.name != encoding_name:
            self._encoding = tiktoken.get_encoding(encoding_name)
        return self._encoding

    def count_tokens(self, text: Optional[str], encoding: Optional[str] = None) -> int:
        """Count tokens in *text* using the model's tiktoken encoding.

        Handles unicode, emoji, None, and empty strings gracefully.

        Args:
            text: The text to tokenize (None is treated as empty).
            encoding: tiktoken encoding name. ``None`` (default) resolves the
                encoding from the configured model.

        Returns:
            Number of tokens.
        """
        if not text:
            return 0
        enc = self._get_encoding(encoding)
        return len(enc.encode(text))

    def _message_tokens(self, msg: Dict[str, str], encoding: Optional[str] = None) -> int:
        """Return the token cost of a single chat message including role overhead."""
        role_overhead = self.count_tokens(msg.get('role', ''), encoding) + 4
        return role_overhead + self.count_tokens(msg.get('content', ''), encoding)

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

        # Allocate the first three components from their percentages (each
        # capped at what remains), then hand history everything left over.
        # This honors the documented priority order -- history is the lowest
        # priority and absorbs the remainder -- and, because integer flooring
        # of the first three leaves a few tokens unassigned, prevents that
        # slack from being silently discarded.
        allocated: Dict[str, int] = {}
        remaining = total_tokens

        for component in ('system_prompt', 'query', 'documents'):
            alloc = int(total_tokens * pcts[component] / 100.0)
            alloc = min(alloc, remaining)
            allocated[component] = alloc
            remaining -= alloc

        allocated['history'] = remaining
        return allocated

    # ------------------------------------------------------------------
    # Truncation
    # ------------------------------------------------------------------

    def truncate_to_budget(self, text: str, max_tokens: int, encoding: Optional[str] = None) -> str:
        """Truncate *text* to fit within *max_tokens*, preserving sentence boundaries.

        If the full text fits, it is returned unchanged. Otherwise the text is
        split on sentence boundaries and sentences are kept greedily from the
        start until adding the next sentence would exceed the budget.

        The greedy loop measures each sentence in isolation, but the returned
        text is the sentences joined by single spaces and BPE does not always
        merge a joining space into the following token.  The joined result is
        therefore re-measured before it is trusted; when it overshoots, the
        token-level fallback is used instead, so the result always fits.

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
            # Intentional: joining normalizes inter-sentence whitespace to single spaces.
            candidate = ' '.join(result_parts)
            # The per-sentence counts above exclude the joining spaces, which can
            # cost an extra token apiece, so re-measure before trusting the budget.
            if self.count_tokens(candidate, encoding) <= max_tokens:
                return candidate

        # Fallback: nothing fits cleanly -- truncate at token level
        enc = self._get_encoding(encoding)
        tokens = enc.encode(text)
        truncated_tokens = tokens[:max_tokens]
        return enc.decode(truncated_tokens)

    def truncate_each_to_budget(self, texts: List[str], max_tokens: int, encoding: Optional[str] = None) -> List[str]:
        """Truncate every text in *texts* so the collection shares one budget.

        Used when a single logical component arrives as several entries that
        must all survive -- a ``Question`` carrying more than one
        ``QuestionText``, for instance, where downstream embedding and
        document-store nodes read every entry.  Each entry receives a share of
        *max_tokens* proportional to its own token cost (integer remainders go
        to the largest entries first), so no entry is dropped and the entries
        together stay inside the budget.

        Args:
            texts: Source texts, one per entry. Order is preserved.
            max_tokens: Total token budget shared by every entry.
            encoding: tiktoken encoding name.

        Returns:
            One truncated text per input, in the same order.
        """
        if not texts:
            return []
        if max_tokens <= 0:
            return ['' for _ in texts]

        costs = [self.count_tokens(text, encoding) for text in texts]
        total = sum(costs)
        if total <= max_tokens:
            return list(texts)

        shares = [int(max_tokens * cost / total) for cost in costs]
        # Integer flooring leaves fewer than len(texts) tokens unassigned; hand
        # them to the largest entries so the budget is spent, not discarded.
        for idx in sorted(range(len(costs)), key=lambda i: (-costs[i], i))[: max_tokens - sum(shares)]:
            shares[idx] += 1

        return [self.truncate_to_budget(text, share, encoding) for text, share in zip(texts, shares)]

    # ------------------------------------------------------------------
    # History summarization
    # ------------------------------------------------------------------

    def summarize_history(
        self, messages: List[Dict[str, str]], max_tokens: int, encoding: Optional[str] = None
    ) -> List[Dict[str, str]]:
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
            Compressed list of message dicts fitting within budget. Empty when
            *max_tokens* cannot cover even one message's role overhead
            (``count_tokens(role) + 4``), since any message would overshoot.
        """
        if not messages:
            return []

        if len(messages) == 1:
            # Reserve this message's role overhead -- count_tokens(role) + 4, the
            # same accounting _message_tokens uses -- so the single returned
            # message's total cost stays inside max_tokens, as the docstring says.
            only_role = messages[0].get('role', 'user')
            content_budget = max_tokens - (self.count_tokens(only_role, encoding) + 4)
            if content_budget < 0:
                # The role overhead alone already exceeds max_tokens, so even an
                # empty-content message would overshoot. Returning nothing is the
                # only way to honour the documented budget.
                return []
            content = self.truncate_to_budget(messages[0].get('content', ''), content_budget, encoding)
            return [{'role': only_role, 'content': content}]

        # Measure total cost
        total = sum(self._message_tokens(m, encoding) for m in messages)
        if total <= max_tokens:
            return list(messages)

        # Keep first message + try to fit as many recent messages as possible
        first_msg = messages[0]
        first_cost = self._message_tokens(first_msg, encoding)

        # Summary placeholder.  LLM providers (Claude, OpenAI) only accept
        # ``role: system`` at position 0, so use ``role: user`` for a synthetic
        # mid-conversation summary marker that providers will route correctly.
        # Reserve against the widest wording the placeholder can end up with:
        # the omitted count is substituted in only after the budget is fixed
        # (see below), and it tokenizes to more than the bare marker does.
        max_omitted = len(messages) - 1
        summary_placeholder = {
            'role': 'user',
            'content': f'[Earlier conversation summarized: {max_omitted} messages omitted]',
        }
        summary_cost = self._message_tokens(summary_placeholder, encoding)

        budget_for_recent = max_tokens - first_cost - summary_cost
        if budget_for_recent <= 0:
            # Can only fit the first message (truncated). Reserve exactly this
            # message's role overhead -- count_tokens(role) + 4, the same
            # accounting _message_tokens uses -- so the single returned message's
            # total cost cannot exceed max_tokens. The previous fixed ``- 4``
            # ignored the role token(s) and could overshoot the budget.
            first_role = first_msg.get('role', 'user')
            content_budget = max_tokens - (self.count_tokens(first_role, encoding) + 4)
            if content_budget < 0:
                # As above: the role overhead alone is already over budget, so no
                # message can be returned without exceeding max_tokens.
                return []
            content = self.truncate_to_budget(first_msg.get('content', ''), content_budget, encoding)
            return [{'role': first_role, 'content': content}]

        # Greedily add recent messages from the end
        recent: List[Dict[str, str]] = []
        recent_cost = 0
        for msg in reversed(messages[1:]):
            cost = self._message_tokens(msg, encoding)
            if recent_cost + cost <= budget_for_recent:
                recent.append(msg)
                recent_cost += cost
            else:
                break
        recent.reverse()

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

    def rank_documents(
        self, documents: List[Dict[str, Any]], query: str, max_tokens: int, encoding: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Select documents that fit within *max_tokens*, best-scoring first.

        Documents arriving from a vector DB are ranked by embedding
        similarity.  When any document carries a ``score`` field this method
        sorts explicitly by score descending (rather than assuming the vector
        DB pre-sorted them) and then greedily selects to fit the budget.
        Documents without a score sink below every scored doc while keeping
        their incoming relative order (stable sort, missing score = -inf).
        When no document carries a score, keyword overlap with *query* is used
        as a lightweight relevance signal, with the original index as a
        tiebreaker.

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
            if has_scores:
                # Documents already carry embedding similarity scores.  Sort
                # explicitly by score descending rather than trusting the
                # vector DB to pre-sort them (the ordering is an implicit
                # upstream contract that this makes explicit).  The sort is
                # stable, so a missing score is treated as -inf: unscored docs
                # sink below every scored doc while keeping their incoming
                # relative order.
                documents = sorted(
                    documents,
                    key=lambda d: d['score'] if d.get('score') is not None else float('-inf'),
                    reverse=True,
                )
            # No query to rank against (or scores handled above) -- greedily
            # select in the resulting order to fit the token budget.
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
                The override selects both the context-window limit *and* the
                tiktoken encoding used for counting, so the two never disagree.
            system_prompt: System prompt text.
            documents: List of document dicts with ``content`` key.
            history: Conversation history (list of role/content dicts).

        Returns:
            Dict with keys:
                - system_prompt: optimized system prompt text
                - question: optimized question text
                - documents: list of selected documents
                - history: compressed conversation history
                - metadata: dict with tokens_used, tokens_saved, components_truncated,
                  model, total_limit, budget and encoding
        """
        documents = documents or []
        history = history or []

        # Resolve model limit
        effective_model = model or self.model_name
        total_limit = self.max_context_tokens or self.resolve_model_limit(effective_model)

        # Count with the encoding the *effective* model uses, so a ``model``
        # override cannot apply one model's limit to another model's token
        # counts. Without an override this is the cached instance encoding.
        encoding = (
            self._resolve_encoding_name()
            if effective_model == self.model_name
            else self.encoding_name_for_model(effective_model)
        )

        # Compute original token counts
        original_system = self.count_tokens(system_prompt, encoding)
        original_question = self.count_tokens(question, encoding)
        original_docs = sum(
            self.count_tokens(str(d.get('content', d.get('page_content', ''))), encoding) for d in documents
        )
        original_history = sum(self._message_tokens(m, encoding) for m in history)
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
                    'encoding': encoding,
                },
            }

        # ------------------------------------------------------------------
        # Pass 2: total exceeds limit -- apply per-component budgets
        # ------------------------------------------------------------------
        budget = self.allocate_budget(total_limit)

        components_truncated: List[str] = []

        opt_system = self.truncate_to_budget(system_prompt, budget['system_prompt'], encoding)
        if self.count_tokens(opt_system, encoding) < original_system:
            components_truncated.append('system_prompt')

        opt_question = self.truncate_to_budget(question, budget['query'], encoding)
        if self.count_tokens(opt_question, encoding) < original_question:
            components_truncated.append('question')

        opt_documents = self.rank_documents(documents, question, budget['documents'], encoding)
        opt_docs_tokens = sum(
            self.count_tokens(str(d.get('content', d.get('page_content', ''))), encoding) for d in opt_documents
        )
        if opt_docs_tokens < original_docs:
            components_truncated.append('documents')

        opt_history = self.summarize_history(history, budget['history'], encoding)
        opt_history_tokens = sum(self._message_tokens(m, encoding) for m in opt_history)
        if opt_history_tokens < original_history:
            components_truncated.append('history')

        tokens_used = (
            self.count_tokens(opt_system, encoding)
            + self.count_tokens(opt_question, encoding)
            + opt_docs_tokens
            + opt_history_tokens
        )
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
                'encoding': encoding,
            },
        }
