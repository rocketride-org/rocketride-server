# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Context Optimizer pipeline node.

Tests cover token counting, budget allocation, truncation, history
summarization, document ranking, the full optimization pipeline, model
limit lookup, edge cases, and IGlobal / IInstance lifecycle.

The build interpreter provides ``rocketlib``, the ``ai`` package and
``depends`` (plus the native ``engLib``) at runtime, so those are imported
directly -- not stubbed. The node source is not on the interpreter's import
path by default, so -- like every other node suite -- we prepend
``nodes/src/nodes`` to import the ``context_optimizer.*`` package by name.
There is no skip fallback for the framework modules: outside the build
interpreter the ``rocketlib`` import fails and collection errors out, by design.

``tiktoken`` / ``json5`` are node-specific third-party deps installed only at
engine runtime (via ``depends``); they are absent from the unit-test
interpreter, so a deterministic test-local stub is injected below ONLY when the
real lib is missing. They are intentionally NOT placed under
``nodes/test/mocks/`` -- the engine loads that dir engine-wide via
ROCKETRIDE_MOCK, which would shadow the real libs during the dynamic run.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

_NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes'
# Front-of-path insertion with prior entries removed first -- the idiom
# test_sys_modules_guard.py::test_node_packages_resolve_under_src_nodes asserts.
while str(_NODES_SRC) in sys.path:
    sys.path.remove(str(_NODES_SRC))
sys.path.insert(0, str(_NODES_SRC))


def _make_tiktoken_stub() -> types.ModuleType:
    """Build a deterministic whitespace-splitting tiktoken stub.

    Used only when real tiktoken is not installed. ``cl100k_base`` is
    approximated by splitting on whitespace -- enough for the budget /
    truncation assertions the suite makes.
    """
    module = types.ModuleType('tiktoken')

    class Encoding:
        def __init__(self, name: str = 'cl100k_base') -> None:
            self.name = name

        def encode(self, text: str):
            return text.split() if text else []

        def decode(self, tokens) -> str:
            return ' '.join(tokens)

    def get_encoding(name: str = 'cl100k_base') -> Encoding:
        return Encoding(name)

    def encoding_for_model(model_name: str) -> Encoding:
        # Mirror tiktoken's model->encoding mapping closely enough for the
        # optimizer's resolution path: gpt-4o / gpt-5 -> o200k_base, everything
        # else -> cl100k_base. The stub tokenizes by whitespace regardless, so
        # the chosen name only exercises the resolution/caching branches.
        name = 'o200k_base' if model_name.startswith(('gpt-4o', 'gpt-5')) else 'cl100k_base'
        return Encoding(name)

    module.Encoding = Encoding
    module.get_encoding = get_encoding
    module.encoding_for_model = encoding_for_model
    return module


def _make_json5_stub() -> types.ModuleType:
    """Build a stdlib-json based json5 stub.

    Used only when real json5 is not installed. ``ai.common.config`` imports
    json5 at module load; the suite only triggers the import, it does not parse
    JSON5-specific syntax.
    """
    import json

    module = types.ModuleType('json5')

    class JSONError(ValueError):
        """Mirror of ``json5.JSONError`` (a ValueError subclass)."""

    def loads(s: str, **_kwargs):
        try:
            return json.loads(s)
        except json.JSONDecodeError as exc:
            raise JSONError(str(exc)) from exc

    def dumps(obj, **_kwargs) -> str:
        return json.dumps(obj)

    def load(fp, **_kwargs):
        try:
            return json.load(fp)
        except json.JSONDecodeError as exc:
            raise JSONError(str(exc)) from exc

    def dump(obj, fp, **_kwargs) -> None:
        json.dump(obj, fp)

    module.JSONError = JSONError
    module.loads = loads
    module.dumps = dumps
    module.load = load
    module.dump = dump
    return module


# tiktoken / json5 are node-specific deps absent from the unit-test interpreter
# (installed only at engine runtime via depends). Inject a test-local stub when
# the real lib is missing; this only touches THIS process, so the engine's
# separate dynamic-test subprocess still uses the real libraries.
_HAS_REAL_TIKTOKEN = importlib.util.find_spec('tiktoken') is not None
if not _HAS_REAL_TIKTOKEN:
    sys.modules['tiktoken'] = _make_tiktoken_stub()

if importlib.util.find_spec('json5') is None:
    sys.modules['json5'] = _make_json5_stub()

from ai.common.schema import Question  # noqa: E402

from context_optimizer.IGlobal import IGlobal  # noqa: E402
from context_optimizer.IInstance import IInstance  # noqa: E402
from context_optimizer.optimizer import (  # noqa: E402
    DEFAULT_MODEL_LIMIT,
    DEFAULT_MODEL_NAME,
    ContextOptimizer,
)


# ===========================================================================
# Fixtures
# ===========================================================================


@pytest.fixture
def default_config() -> dict[str, Any]:
    """Default optimizer configuration."""
    return {
        'model_name': 'gpt-5',
        'max_context_tokens': 0,
        'system_prompt_budget_pct': 10,
        'query_budget_pct': 15,
        'document_budget_pct': 50,
        'history_budget_pct': 25,
    }


@pytest.fixture
def optimizer(default_config) -> ContextOptimizer:
    """Create optimizer with default config."""
    return ContextOptimizer(default_config)


@pytest.fixture
def small_budget_config() -> dict[str, Any]:
    """Config with a very small context window for easy testing."""
    return {
        'model_name': 'custom',
        'max_context_tokens': 100,
        'system_prompt_budget_pct': 10,
        'query_budget_pct': 15,
        'document_budget_pct': 50,
        'history_budget_pct': 25,
    }


@pytest.fixture
def small_optimizer(small_budget_config) -> ContextOptimizer:
    """Create optimizer with small token budget for edge-case testing."""
    return ContextOptimizer(small_budget_config)


# ===========================================================================
# Token counting tests
# ===========================================================================


class TestTokenCounting:
    """Tests for count_tokens."""

    def test_empty_string_returns_zero(self, optimizer):
        assert optimizer.count_tokens('') == 0

    def test_none_returns_zero(self, optimizer):
        assert optimizer.count_tokens(None) == 0

    def test_simple_text(self, optimizer):
        count = optimizer.count_tokens('Hello world')
        assert count > 0

    def test_longer_text_more_tokens(self, optimizer):
        short = optimizer.count_tokens('Hi')
        long = optimizer.count_tokens('This is a much longer sentence with many more words in it.')
        assert long > short

    def test_unicode_text(self, optimizer):
        """Token counting should handle unicode characters."""
        count = optimizer.count_tokens('Hallo Welt. Bonjour le monde. Hola mundo.')
        assert count > 0

    def test_emoji_text(self, optimizer):
        """Token counting should handle emoji."""
        count = optimizer.count_tokens('Hello world! \U0001f680\U0001f30d\U0001f525')
        assert count > 0

    def test_mixed_unicode_and_ascii(self, optimizer):
        count = optimizer.count_tokens('Hello \u4e16\u754c \U0001f600 world \u00e9\u00e8\u00ea')
        assert count > 0

    def test_whitespace_only(self, optimizer):
        count = optimizer.count_tokens('   ')
        assert count >= 0  # may be 0 or small


# ===========================================================================
# Budget allocation tests
# ===========================================================================


class TestBudgetAllocation:
    """Tests for allocate_budget."""

    def test_default_percentages(self, optimizer):
        budget = optimizer.allocate_budget(1000)
        assert budget['system_prompt'] == 100  # 10%
        assert budget['query'] == 150  # 15%
        assert budget['documents'] == 500  # 50%
        assert budget['history'] == 250  # 25%

    def test_budget_sums_to_lte_total(self, optimizer):
        budget = optimizer.allocate_budget(1000)
        total = sum(budget.values())
        assert total <= 1000

    def test_zero_total(self, optimizer):
        budget = optimizer.allocate_budget(0)
        assert all(v == 0 for v in budget.values())

    def test_negative_total(self, optimizer):
        budget = optimizer.allocate_budget(-10)
        assert all(v == 0 for v in budget.values())

    def test_custom_percentages(self, optimizer):
        budget = optimizer.allocate_budget(1000, {'system_prompt': 20, 'query': 20, 'documents': 40, 'history': 20})
        assert budget['system_prompt'] == 200
        assert budget['query'] == 200
        assert budget['documents'] == 400
        assert budget['history'] == 200

    def test_over_100_pct_normalizes(self, optimizer):
        """Percentages > 100 should be normalized so total <= budget."""
        budget = optimizer.allocate_budget(1000, {'system_prompt': 50, 'query': 50, 'documents': 50, 'history': 50})
        total = sum(budget.values())
        assert total <= 1000

    def test_small_total(self, optimizer):
        budget = optimizer.allocate_budget(10)
        total = sum(budget.values())
        assert total <= 10

    def test_all_four_components_present(self, optimizer):
        budget = optimizer.allocate_budget(1000)
        assert set(budget.keys()) == {'system_prompt', 'query', 'documents', 'history'}

    def test_large_total(self, optimizer):
        budget = optimizer.allocate_budget(1000000)
        total = sum(budget.values())
        assert total <= 1000000
        assert budget['documents'] == 500000


# ===========================================================================
# Truncation tests
# ===========================================================================


class TestTruncation:
    """Tests for truncate_to_budget."""

    def test_empty_text(self, optimizer):
        assert optimizer.truncate_to_budget('', 100) == ''

    def test_zero_budget(self, optimizer):
        assert optimizer.truncate_to_budget('Hello world.', 0) == ''

    def test_text_fits(self, optimizer):
        text = 'Hello.'
        result = optimizer.truncate_to_budget(text, 10000)
        assert result == text

    def test_truncation_preserves_sentences(self, optimizer):
        text = 'First sentence. Second sentence. Third sentence. Fourth sentence.'
        # Use a budget that can fit some but not all sentences
        full_tokens = optimizer.count_tokens(text)
        first_tokens = optimizer.count_tokens('First sentence.')
        if full_tokens > first_tokens:
            # Budget that should fit at least first sentence but not all
            result = optimizer.truncate_to_budget(text, first_tokens + 1)
            # Result should end at a sentence boundary
            assert result.endswith(('.', 'sentence'))

    def test_truncation_does_not_cut_mid_word(self, optimizer):
        """Even in fallback mode, result should be decodeable."""
        text = 'Supercalifragilisticexpialidocious is a very long word that takes many tokens.'
        result = optimizer.truncate_to_budget(text, 2)
        # Should return something (not crash), and it should be a string
        assert isinstance(result, str)

    def test_negative_budget(self, optimizer):
        assert optimizer.truncate_to_budget('Hello world.', -5) == ''

    def test_single_sentence_within_budget(self, optimizer):
        text = 'Just one sentence.'
        result = optimizer.truncate_to_budget(text, 10000)
        assert result == text


# ===========================================================================
# History summarization tests
# ===========================================================================


class TestHistorySummarization:
    """Tests for summarize_history."""

    def test_empty_history(self, optimizer):
        assert optimizer.summarize_history([], 100) == []

    def test_single_message(self, optimizer):
        messages = [{'role': 'user', 'content': 'Hello'}]
        result = optimizer.summarize_history(messages, 10000)
        assert len(result) == 1
        assert result[0]['role'] == 'user'

    def test_keeps_first_message(self, optimizer):
        """First message (system context) should always be preserved."""
        messages = [
            {'role': 'system', 'content': 'You are a helpful assistant.'},
            {'role': 'user', 'content': 'Message 2'},
            {'role': 'assistant', 'content': 'Message 3'},
            {'role': 'user', 'content': 'Message 4'},
            {'role': 'assistant', 'content': 'Message 5'},
        ]
        result = optimizer.summarize_history(messages, 10000)
        assert result[0]['role'] == 'system'
        assert result[0]['content'] == 'You are a helpful assistant.'

    def test_keeps_last_messages(self, optimizer):
        """Recent messages should be preserved when summarizing."""
        messages = [
            {'role': 'system', 'content': 'System prompt.'},
            {'role': 'user', 'content': 'Old message 1.'},
            {'role': 'assistant', 'content': 'Old response 1.'},
            {'role': 'user', 'content': 'Recent question.'},
            {'role': 'assistant', 'content': 'Recent answer.'},
        ]
        # Use a small budget that forces summarization
        result = optimizer.summarize_history(messages, 30)
        # First message (system context) should always be preserved
        assert result[0]['content'] == 'System prompt.'

    def test_summarization_inserts_placeholder(self, optimizer):
        """When messages are omitted, a summary placeholder should be inserted."""
        messages = [{'role': 'user', 'content': f'Message {i} with some extra content here.'} for i in range(20)]
        # Very tight budget to force omission
        result = optimizer.summarize_history(messages, 40)
        placeholders = [m for m in result if 'summarized' in m.get('content', '').lower()]
        # Either we have a placeholder, or the budget was enough for everything
        total_original_tokens = sum(optimizer.count_tokens(m['content']) for m in messages)
        if total_original_tokens > 40:
            assert len(placeholders) > 0 or len(result) < len(messages)

    def test_history_fits_no_truncation(self, optimizer):
        messages = [
            {'role': 'user', 'content': 'Hi'},
            {'role': 'assistant', 'content': 'Hello'},
        ]
        result = optimizer.summarize_history(messages, 100000)
        assert len(result) == 2

    def test_budget_below_role_overhead_returns_empty(self, optimizer):
        """Below one message's role overhead, nothing can be returned.

        Every returned message costs ``count_tokens(role) + 4`` before a single
        content token is spent (the accounting ``_message_tokens`` uses). When
        ``max_tokens`` is smaller than that, even an empty-content message
        overshoots, so both the single-message branch and the
        ``budget_for_recent <= 0`` fallback must return ``[]`` rather than a
        message that breaks the documented budget.
        """
        single = [{'role': 'user', 'content': 'hello world from the single message branch'}]
        many = [
            {'role': 'user', 'content': 'hello world from the fallback branch'},
            {'role': 'assistant', 'content': 'a reply that will not fit either'},
            {'role': 'user', 'content': 'and one more turn on top of that'},
        ]
        overhead = optimizer.count_tokens('user') + 4

        for messages in (single, many):
            # Strictly below the overhead: nothing fits, so nothing is returned.
            for budget in range(0, overhead):
                assert optimizer.summarize_history(messages, budget) == []

            # Exactly at the overhead an empty-content message still fits, and
            # it must cost no more than the budget it was given.
            result = optimizer.summarize_history(messages, overhead)
            assert len(result) == 1
            assert result[0]['content'] == ''
            assert optimizer._message_tokens(result[0]) <= overhead

    def test_preserves_first_and_last_with_summary(self, optimizer):
        """With many messages and tight budget, first + placeholder + last should appear."""
        messages = [
            {'role': 'system', 'content': 'Be helpful.'},
        ] + [
            {
                'role': 'user' if i % 2 == 0 else 'assistant',
                'content': f'This is a medium length message number {i} in the conversation.',
            }
            for i in range(10)
        ]
        result = optimizer.summarize_history(messages, 50)
        assert result[0]['content'] == 'Be helpful.'
        # Should have been compressed
        assert len(result) <= len(messages)


# ===========================================================================
# Document ranking tests
# ===========================================================================


class TestDocumentRanking:
    """Tests for rank_documents."""

    def test_empty_documents(self, optimizer):
        assert optimizer.rank_documents([], 'query', 1000) == []

    def test_zero_budget(self, optimizer):
        docs = [{'content': 'Some text'}]
        assert optimizer.rank_documents(docs, 'query', 0) == []

    def test_single_doc_fits(self, optimizer):
        docs = [{'content': 'Hello world'}]
        result = optimizer.rank_documents(docs, 'hello', 10000)
        assert len(result) == 1

    def test_ranking_by_relevance(self, optimizer):
        docs = [
            {'content': 'The weather is sunny today.'},
            {'content': 'Python programming language is great.'},
            {'content': 'Python programming with decorators and generators.'},
        ]
        result = optimizer.rank_documents(docs, 'Python programming', 10000)
        # Python docs should come first
        assert 'Python' in result[0]['content']

    def test_budget_limits_documents(self, small_optimizer):
        docs = [
            {'content': 'Document one with some text. ' * 20},
            {'content': 'Document two with some text. ' * 20},
            {'content': 'Document three with some text. ' * 20},
        ]
        result = small_optimizer.rank_documents(docs, 'text', 10)
        assert len(result) < len(docs)

    def test_empty_query_preserves_order(self, optimizer):
        docs = [
            {'content': 'First'},
            {'content': 'Second'},
            {'content': 'Third'},
        ]
        result = optimizer.rank_documents(docs, '', 10000)
        assert result[0]['content'] == 'First'
        assert result[1]['content'] == 'Second'

    def test_page_content_key(self, optimizer):
        """Should also work with page_content key (RocketRide Doc format)."""
        docs = [{'page_content': 'Some document text here'}]
        result = optimizer.rank_documents(docs, 'document', 10000)
        assert len(result) == 1

    def test_scored_docs_sorted_descending(self, optimizer):
        """Scored docs are reordered by score descending, not left as-is."""
        docs = [
            {'content': 'low relevance', 'score': 0.1},
            {'content': 'high relevance', 'score': 0.9},
            {'content': 'mid relevance', 'score': 0.5},
        ]
        result = optimizer.rank_documents(docs, 'relevance', 10000)
        assert [d['content'] for d in result] == [
            'high relevance',
            'mid relevance',
            'low relevance',
        ]

    def test_scored_budget_picks_top_scoring_subset(self, optimizer):
        """When the budget only fits some docs, the highest-scoring win even if
        they arrive last in the unsorted input.
        """
        # Equal-cost docs (~11 tokens each) so selection is driven purely by
        # score.  A ~25-token budget fits exactly two of the three.  The two
        # highest scorers (mid, high) must be kept; the lowest (low) dropped --
        # even though 'high' arrives last in the unsorted input.
        docs = [
            {'id': 'low', 'content': 'alpha ' * 10, 'score': 0.2},
            {'id': 'mid', 'content': 'alpha ' * 10, 'score': 0.5},
            {'id': 'high', 'content': 'alpha ' * 10, 'score': 0.9},
        ]
        result = optimizer.rank_documents(docs, 'query', 25)
        kept = {d['id'] for d in result}
        assert kept == {'high', 'mid'}

    def test_missing_score_sinks_below_scored(self, optimizer):
        """A doc without a score ranks below every scored doc (missing = -inf)."""
        docs = [
            {'content': 'no score here'},
            {'content': 'scored doc', 'score': 0.3},
        ]
        result = optimizer.rank_documents(docs, 'query', 10000)
        assert result[0]['content'] == 'scored doc'
        assert result[1]['content'] == 'no score here'


# ===========================================================================
# Full optimization pipeline tests
# ===========================================================================


class TestOptimize:
    """Tests for the optimize() method."""

    def test_basic_optimization(self, optimizer):
        result = optimizer.optimize(
            question='What is the capital of France?',
            system_prompt='You are a helpful assistant.',
            documents=[{'content': 'France is a country in Europe.'}],
            history=[{'role': 'user', 'content': 'Hi'}],
        )
        assert 'system_prompt' in result
        assert 'question' in result
        assert 'documents' in result
        assert 'history' in result
        assert 'metadata' in result

    def test_metadata_fields(self, optimizer):
        result = optimizer.optimize(question='Hello')
        meta = result['metadata']
        assert 'tokens_used' in meta
        assert 'tokens_saved' in meta
        assert 'components_truncated' in meta
        assert 'model' in meta
        assert 'total_limit' in meta
        assert 'budget' in meta

    def test_tokens_used_nonnegative(self, optimizer):
        result = optimizer.optimize(question='Test')
        assert result['metadata']['tokens_used'] >= 0

    def test_tokens_saved_nonnegative(self, optimizer):
        result = optimizer.optimize(question='Test')
        assert result['metadata']['tokens_saved'] >= 0

    def test_empty_question(self, optimizer):
        result = optimizer.optimize(question='')
        assert result['question'] == ''

    def test_no_documents(self, optimizer):
        result = optimizer.optimize(question='What?', documents=[])
        assert result['documents'] == []

    def test_no_history(self, optimizer):
        result = optimizer.optimize(question='What?', history=[])
        assert result['history'] == []

    def test_model_override(self, optimizer):
        result = optimizer.optimize(question='Test', model='claude-opus')
        assert result['metadata']['model'] == 'claude-opus'
        assert result['metadata']['total_limit'] == ContextOptimizer.MODEL_LIMITS['claude-opus']

    def test_small_budget_truncates(self, small_optimizer):
        long_text = 'This is a sentence. ' * 100
        result = small_optimizer.optimize(
            question=long_text,
            system_prompt=long_text,
            documents=[{'content': long_text}],
            history=[{'role': 'user', 'content': long_text}],
        )
        # Something should have been truncated
        assert result['metadata']['tokens_saved'] > 0 or result['metadata']['tokens_used'] <= 100


# ===========================================================================
# Model limit lookup tests
# ===========================================================================


class TestModelLimits:
    """Tests for context-window resolution: live catalog, fallback table, default."""

    @pytest.mark.parametrize(
        ('model', 'expected'),
        [
            ('gpt-5', 400000),
            ('gpt-5-mini', 400000),
            ('gpt-5.4', 1050000),
            ('gpt-4', 8191),
            ('claude-opus-4-6', 1000000),
            ('claude-sonnet-4-6', 1000000),
            ('claude-haiku-4-5', 200000),
            ('claude-opus', 1000000),
            ('claude-sonnet', 1000000),
            ('claude-haiku', 200000),
            ('gemini-3.1-pro-preview', 1048576),
            ('gemini-pro', 1048576),
            ('gemini-flash', 1048576),
        ],
    )
    def test_fallback_table_values(self, model, expected):
        """The hand-maintained fallback table carries the refreshed values.

        Exact values, because this table is ours -- unlike the catalog it is
        not regenerated by a tool. Agreement with the catalog is asserted
        separately in :meth:`test_fallback_table_never_disagrees_with_catalog`.
        """
        assert ContextOptimizer.MODEL_LIMITS[model] == expected

    def test_fallback_table_never_disagrees_with_catalog(self):
        """MODEL_LIMITS must not contradict the live llm_* catalog.

        The table is a fallback, so wherever the catalog also publishes an id
        the two have to state the same context window -- otherwise the node
        would report a different budget depending on whether the sibling
        ``llm_*`` nodes happen to be deployed next to it. Ids the catalog does
        not publish (the abbreviated family aliases, and names only available
        under a provider-scoped id) are the table's own business and are not
        checked here.

        If ``tools/sync_models`` moves a window, this test is the signal to
        refresh MODEL_LIMITS (or drop the key and let the catalog answer).
        """
        catalog = ContextOptimizer.model_catalog()
        if not catalog:
            pytest.skip('no llm_* catalog in this build')
        shared = sorted(set(catalog) & set(ContextOptimizer.MODEL_LIMITS))
        assert shared, 'expected MODEL_LIMITS and the catalog to overlap on at least one id'
        disagreements = {
            model: (ContextOptimizer.MODEL_LIMITS[model], catalog[model])
            for model in shared
            if ContextOptimizer.MODEL_LIMITS[model] != catalog[model]
        }
        assert not disagreements, (
            f'MODEL_LIMITS is stale against the llm_* catalog (model: table vs catalog): {disagreements}'
        )

    def test_unknown_model_uses_default(self):
        config = {'model_name': 'unknown-model-xyz', 'max_context_tokens': 0}
        opt = ContextOptimizer(config)
        assert opt._total_limit == DEFAULT_MODEL_LIMIT

    def test_custom_max_context_override(self):
        config = {'model_name': 'gpt-5', 'max_context_tokens': 50000}
        opt = ContextOptimizer(config)
        assert opt._total_limit == 50000


class TestModelCatalog:
    """Tests for the live llm_* model catalog lookup."""

    @staticmethod
    def _declared_ids_by_node() -> dict[str, set[str]]:
        """Model ids each sibling ``llm_*`` node declares, read independently.

        Parsed straight from the services files rather than through
        :meth:`ContextOptimizer._load_model_catalog`, so the assertions below
        are a real check on the loader and not a restatement of it.
        """
        declared: dict[str, set[str]] = {}
        for path in sorted(ContextOptimizer._CATALOG_ROOT.glob(ContextOptimizer._CATALOG_GLOB)):
            service = json.loads(ContextOptimizer._strip_jsonc(path.read_text(encoding='utf-8')))
            profiles = service.get('preconfig', {}).get('profiles', {})
            ids = {
                profile['model']
                for profile in profiles.values()
                if isinstance(profile, dict)
                and isinstance(profile.get('model'), str)
                and profile['model']
                and isinstance(profile.get('modelTotalTokens'), int)
                and not isinstance(profile.get('modelTotalTokens'), bool)
                and profile['modelTotalTokens'] > 0
            }
            if ids:
                declared.setdefault(path.parent.name, set()).update(ids)
        return declared

    def test_catalog_is_discovered(self):
        """The sibling llm_* nodes' services.json files are readable.

        Asserted structurally on purpose: no individual model id is named
        here. The catalog contents are owned by ``tools/sync_models`` and
        move whenever a provider renames or retires a model, so pinning ids
        would make an unrelated model-sync PR red-line this suite. What must
        hold is the shape -- a non-empty mapping of ids to positive integer
        windows -- and that no discovered provider is silently dropped.
        """
        catalog = ContextOptimizer.model_catalog()
        assert isinstance(catalog, dict)
        assert catalog, 'expected at least one llm_* profile with modelTotalTokens'
        for model, limit in catalog.items():
            assert isinstance(model, str) and model, f'non-string catalog key: {model!r}'
            assert isinstance(limit, int) and not isinstance(limit, bool) and limit > 0, (
                f'{model} has a non-positive context window: {limit!r}'
            )

        declared = self._declared_ids_by_node()
        assert declared, 'expected at least one llm_* node to declare a model'
        for node, ids in declared.items():
            assert ids & set(catalog), f'no model id from {node} reached the catalog'

    def test_catalog_beats_fallback_table(self):
        """A model only the catalog knows still resolves."""
        catalog = ContextOptimizer.model_catalog()
        model = 'grok-4-0709'
        if model not in catalog:
            pytest.skip(f"{model} not present in this build's llm_* catalog")
        opt = ContextOptimizer({'model_name': model, 'max_context_tokens': 0})
        assert opt._total_limit == catalog[model]
        assert model not in ContextOptimizer.MODEL_LIMITS

    @staticmethod
    def _write_catalog(root, name, profiles):
        """Write a minimal llm_* services.json into *root*."""
        node = root / name
        node.mkdir()
        body = ',\n'.join(
            f'\t\t\t"p{i}": {{ "model": "{m}", "modelTotalTokens": {t} }}' for i, (m, t) in enumerate(profiles)
        )
        (node / 'services.json').write_text(
            '{\n\t// comment\n\t"preconfig": {\n\t\t"profiles": {\n' + body + '\n\t\t},\n\t},\n}\n',
            encoding='utf-8',
        )

    def test_bare_alias_does_not_shadow_unscoped_profile(self, tmp_path, monkeypatch):
        """A gateway's `gw/model-x` must not override the unscoped `model-x`."""
        self._write_catalog(tmp_path, 'llm_a_gateway', [('gw/model-x', 128000)])
        self._write_catalog(tmp_path, 'llm_z_native', [('model-x', 400000)])
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        catalog = ContextOptimizer.model_catalog()
        assert catalog['model-x'] == 400000
        assert catalog['gw/model-x'] == 128000

    def test_ambiguous_bare_alias_is_dropped(self, tmp_path, monkeypatch):
        """Two gateways disagreeing about a bare name means no alias at all."""
        self._write_catalog(tmp_path, 'llm_a_gateway', [('a/model-z', 128000)])
        self._write_catalog(tmp_path, 'llm_b_gateway', [('b/model-z', 1048576)])
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        catalog = ContextOptimizer.model_catalog()
        assert 'model-z' not in catalog
        assert catalog['a/model-z'] == 128000
        assert catalog['b/model-z'] == 1048576

    def test_conflicting_limits_keep_the_smaller(self, tmp_path, monkeypatch):
        """The same id in two services files resolves to the safer window."""
        self._write_catalog(tmp_path, 'llm_one', [('model-y', 262144)])
        self._write_catalog(tmp_path, 'llm_two', [('model-y', 128000)])
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        assert ContextOptimizer.model_catalog()['model-y'] == 128000

    def test_resolve_falls_back_to_table_for_family_alias(self):
        """Abbreviated aliases are not catalogued, so the table answers."""
        catalog = ContextOptimizer.model_catalog()
        assert 'claude-sonnet' not in catalog
        opt = ContextOptimizer({'model_name': 'claude-sonnet', 'max_context_tokens': 0})
        assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['claude-sonnet']

    def test_malformed_catalog_is_ignored(self, tmp_path, monkeypatch):
        """A broken or missing catalog degrades to the fallback table."""
        bad = tmp_path / 'llm_broken'
        bad.mkdir()
        (bad / 'services.json').write_text('{ not json at all', encoding='utf-8')
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        try:
            assert ContextOptimizer.model_catalog() == {}
            opt = ContextOptimizer({'model_name': 'gpt-5.4', 'max_context_tokens': 0})
            assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5.4']
        finally:
            ContextOptimizer._catalog_cache = None

    def test_strip_jsonc_keeps_comment_markers_inside_strings(self):
        """The JSONC stripper must not cut inside a string literal."""
        raw = '{ /* c */ "url": "https://x/y", // trailing\n "n": 1, }'
        assert json.loads(ContextOptimizer._strip_jsonc(raw)) == {'url': 'https://x/y', 'n': 1}


# ===========================================================================
# Edge cases and graceful degradation
# ===========================================================================


class TestEdgeCases:
    """Edge cases: empty inputs, over-budget, single message, etc."""

    def test_all_empty_inputs(self, optimizer):
        result = optimizer.optimize(question='', system_prompt='', documents=[], history=[])
        assert result['question'] == ''
        assert result['documents'] == []
        assert result['history'] == []

    def test_single_history_message(self, optimizer):
        result = optimizer.optimize(question='Hi', history=[{'role': 'user', 'content': 'Hello'}])
        assert len(result['history']) >= 1

    def test_very_long_system_prompt(self, small_optimizer):
        """Extremely long system prompt should be truncated gracefully."""
        long_prompt = 'Be helpful. ' * 500
        result = small_optimizer.optimize(question='Hi', system_prompt=long_prompt)
        assert result['metadata']['tokens_used'] <= small_optimizer._total_limit + 10  # small tolerance

    def test_documents_with_no_content_key(self, optimizer):
        """Documents missing 'content' should not crash."""
        docs = [{'title': 'Some doc'}]
        result = optimizer.optimize(question='test', documents=docs)
        # Should handle gracefully
        assert isinstance(result['documents'], list)

    def test_over_budget_graceful(self, small_optimizer):
        """When everything is over budget, should not crash and should truncate."""
        result = small_optimizer.optimize(
            question='A very long question. ' * 50,
            system_prompt='Long system prompt. ' * 50,
            documents=[{'content': 'Long doc. ' * 50}],
            history=[{'role': 'user', 'content': 'Long msg. ' * 50} for _ in range(10)],
        )
        assert isinstance(result, dict)
        assert result['metadata']['tokens_saved'] >= 0

    def test_components_truncated_list(self, small_optimizer):
        """components_truncated should list which components were cut."""
        result = small_optimizer.optimize(
            question='A very long question. ' * 100,
            system_prompt='Long system prompt. ' * 100,
            documents=[{'content': 'Long doc. ' * 100}],
            history=[{'role': 'user', 'content': 'Long msg. ' * 100}],
        )
        truncated = result['metadata']['components_truncated']
        assert isinstance(truncated, list)
        # At least some components should be truncated with such a small budget
        assert len(truncated) > 0


# ===========================================================================
# IGlobal / IInstance lifecycle tests (mocked)
# ===========================================================================


class TestIGlobalLifecycle:
    """Test the IGlobal class lifecycle with mocks."""

    def test_begin_global_config_mode(self):
        """In CONFIG mode, optimizer should not be created."""
        iglobal = IGlobal.__new__(IGlobal)
        iglobal.optimizer = None
        iglobal.config = None
        # Mock the IEndpoint and glb
        endpoint_mock = MagicMock()
        endpoint_mock.endpoint.openMode = 'config'  # CONFIG mode

        class _OPEN_MODE:
            CONFIG = 'config'

        iglobal.IEndpoint = endpoint_mock
        iglobal.glb = MagicMock()

        with patch('context_optimizer.IGlobal.OPEN_MODE', _OPEN_MODE):
            iglobal.beginGlobal()

        assert iglobal.optimizer is None

    def test_end_global_cleanup(self):
        """EndGlobal should set optimizer and config to None."""
        iglobal = IGlobal.__new__(IGlobal)
        iglobal.optimizer = MagicMock()
        iglobal.config = {'model_name': 'test'}

        iglobal.endGlobal()

        assert iglobal.optimizer is None
        assert iglobal.config is None


class TestIInstanceLifecycle:
    """Test the IInstance class with mocked IGlobal/optimizer."""

    def _make_instance(self, optimizer=None):
        inst = IInstance.__new__(IInstance)
        iglobal = MagicMock()
        iglobal.optimizer = optimizer
        inst.IGlobal = iglobal
        inst.instance = MagicMock()
        return inst

    def test_passthrough_when_no_optimizer(self):
        """When optimizer is None, question should pass through unchanged."""
        inst = self._make_instance(optimizer=None)

        q = Question()
        q.addQuestion('Hello?')

        inst.writeQuestions(q)

        inst.instance.writeQuestions.assert_called_once()

    def test_deep_copy_preserves_original(self):
        """WriteQuestions should deep-copy the question before modifying."""
        inst = self._make_instance(optimizer=MagicMock())

        # Configure the mock optimizer to return a result
        inst.IGlobal.optimizer.optimize.return_value = {
            'system_prompt': 'opt_sys',
            'question': 'opt_q',
            'documents': [],
            'history': [],
            'metadata': {
                'tokens_used': 10,
                'tokens_saved': 5,
                'components_truncated': [],
                'model': 'gpt-5',
                'total_limit': 128000,
                'budget': {},
            },
        }

        q = Question()
        q.addQuestion('Original question')
        original_text = q.questions[0].text

        inst.writeQuestions(q)

        # Original should be unchanged
        assert q.questions[0].text == original_text

    def test_optimizer_called_with_components(self):
        """WriteQuestions should extract components and call optimizer.optimize."""
        mock_opt = MagicMock()
        mock_opt.optimize.return_value = {
            'system_prompt': 'optimized',
            'question': 'optimized question',
            'documents': [],
            'history': [],
            'metadata': {
                'tokens_used': 10,
                'tokens_saved': 0,
                'components_truncated': [],
                'model': 'gpt-5',
                'total_limit': 128000,
                'budget': {},
            },
        }
        inst = self._make_instance(optimizer=mock_opt)

        q = Question(role='You are helpful.')
        q.addQuestion('What is AI?')

        inst.writeQuestions(q)

        mock_opt.optimize.assert_called_once()
        call_kwargs = mock_opt.optimize.call_args.kwargs
        assert call_kwargs['question'] == 'What is AI?'
        assert call_kwargs['system_prompt'] == 'You are helpful.'

    def test_empty_questions_with_optimized_result_logs_debug(self):
        """When question.questions is empty but optimizer returns a question, a debug log should fire."""
        mock_opt = MagicMock()
        mock_opt.optimize.return_value = {
            'system_prompt': 'optimized',
            'question': 'optimized question text',
            'documents': [],
            'history': [],
            'metadata': {
                'tokens_used': 10,
                'tokens_saved': 0,
                'components_truncated': [],
                'model': 'gpt-5',
                'total_limit': 128000,
                'budget': {},
            },
        }
        inst = self._make_instance(optimizer=mock_opt)

        q = Question()
        q.questions = []  # explicitly empty

        with patch('context_optimizer.IInstance.debug') as mock_debug:
            inst.writeQuestions(q)

        # A debug log about discarding the orphaned question text should have
        # fired. Assert on the salient signal -- the word "discarding" plus the
        # forwarded text -- rather than the exact sentence, so harmless wording
        # tweaks in IInstance.debug do not break this test.
        logged = ' '.join(str(call.args[0]) for call in mock_debug.call_args_list if call.args)
        assert 'discarding' in logged
        assert 'optimized question text' in logged
        # Question should still be forwarded
        inst.instance.writeQuestions.assert_called_once()


# ===========================================================================
# Input validation tests (issues #4 and #5)
# ===========================================================================


class TestInputValidation:
    """Tests for non-numeric input handling and budget percentage validation."""

    def test_non_numeric_max_context_tokens(self):
        """Non-numeric max_context_tokens should default to 0 without crashing."""
        config = {'model_name': 'gpt-5', 'max_context_tokens': 'not_a_number'}
        opt = ContextOptimizer(config)
        assert opt.max_context_tokens == 0

    def test_non_numeric_budget_pct(self):
        """Non-numeric budget percentage should default to 0."""
        config = {'model_name': 'gpt-5', 'system_prompt_budget_pct': 'bad'}
        opt = ContextOptimizer(config)
        assert opt.system_prompt_budget_pct == 0.0

    def test_negative_budget_pct_clamped(self):
        """Negative percentages should be clamped to 0."""
        config = {'model_name': 'gpt-5', 'query_budget_pct': -10}
        opt = ContextOptimizer(config)
        assert opt.query_budget_pct == 0.0

    def test_over_100_budget_pct_clamped(self):
        """Percentages over 100 should be clamped to 100."""
        config = {'model_name': 'gpt-5', 'document_budget_pct': 150}
        opt = ContextOptimizer(config)
        assert opt.document_budget_pct == 100.0

    def test_negative_max_context_tokens_clamped(self):
        """Negative max_context_tokens should be clamped to 0."""
        config = {'model_name': 'gpt-5', 'max_context_tokens': -500}
        opt = ContextOptimizer(config)
        assert opt.max_context_tokens == 0

    def test_valid_values_pass_through(self):
        """Valid numeric values should be accepted as-is."""
        config = {
            'model_name': 'gpt-5',
            'max_context_tokens': 1000,
            'system_prompt_budget_pct': 10,
            'query_budget_pct': 15,
            'document_budget_pct': 50,
            'history_budget_pct': 25,
        }
        opt = ContextOptimizer(config)
        assert opt.max_context_tokens == 1000
        assert opt.system_prompt_budget_pct == 10.0
        assert opt.query_budget_pct == 15.0
        assert opt.document_budget_pct == 50.0
        assert opt.history_budget_pct == 25.0


# ===========================================================================
# Two-pass optimization tests (issue #6)
# ===========================================================================


class TestTwoPassOptimization:
    """Tests for the two-pass budget redistribution approach."""

    def test_pass1_no_truncation_when_fits(self, optimizer):
        """When all content fits within the total limit, nothing should be truncated."""
        result = optimizer.optimize(
            question='Short question',
            system_prompt='Be helpful.',
            documents=[{'content': 'A small document.'}],
            history=[{'role': 'user', 'content': 'Hi'}],
        )
        assert result['metadata']['tokens_saved'] == 0
        assert result['metadata']['components_truncated'] == []
        assert result['question'] == 'Short question'
        assert result['system_prompt'] == 'Be helpful.'

    def test_pass2_truncates_when_over_budget(self, small_optimizer):
        """When content exceeds the limit, per-component budgets should apply."""
        long_text = 'This is a sentence. ' * 100
        result = small_optimizer.optimize(
            question=long_text,
            system_prompt=long_text,
            documents=[{'content': long_text}],
            history=[{'role': 'user', 'content': long_text}],
        )
        assert result['metadata']['tokens_saved'] > 0
        assert len(result['metadata']['components_truncated']) > 0

    def test_documents_preserved_when_under_budget(self, optimizer):
        """Pass 1 should return all documents unchanged when total fits."""
        docs = [
            {'content': 'Doc 1'},
            {'content': 'Doc 2'},
            {'content': 'Doc 3'},
        ]
        result = optimizer.optimize(question='Test', documents=docs)
        assert len(result['documents']) == 3


# ===========================================================================
# Score-preserving document ranking tests (issue #7)
# ===========================================================================


class TestScorePreservingRanking:
    """Tests for preserving vector DB ordering in document ranking."""

    def test_documents_with_scores_preserve_order(self, optimizer):
        """Documents with score fields should keep their original order."""
        docs = [
            {'content': 'Most relevant from vector DB', 'score': 0.95},
            {'content': 'Second most relevant', 'score': 0.85},
            {'content': 'Third most relevant Python programming', 'score': 0.70},
        ]
        result = optimizer.rank_documents(docs, 'Python programming', 10000)
        assert len(result) == 3
        # Original order should be preserved (score-descending from vector DB)
        assert result[0]['content'] == 'Most relevant from vector DB'
        assert result[1]['content'] == 'Second most relevant'
        assert result[2]['content'] == 'Third most relevant Python programming'

    def test_documents_without_scores_use_keyword_overlap(self, optimizer):
        """Documents without scores should fall back to keyword overlap ranking."""
        docs = [
            {'content': 'The weather is sunny today.'},
            {'content': 'Python programming language is great.'},
        ]
        result = optimizer.rank_documents(docs, 'Python programming', 10000)
        assert 'Python' in result[0]['content']

    def test_mixed_score_and_no_score_preserves_order(self, optimizer):
        """If any doc has a score, original order is preserved for all."""
        docs = [
            {'content': 'First doc', 'score': 0.9},
            {'content': 'Second doc with Python programming'},  # no score
            {'content': 'Third doc', 'score': 0.7},
        ]
        result = optimizer.rank_documents(docs, 'Python programming', 10000)
        assert result[0]['content'] == 'First doc'


# ===========================================================================
# Budget-invariant regression tests (CodeRabbit round 1b)
# ===========================================================================


class TestBudgetInvariants:
    """Every component helper must keep its result inside the budget it is given.

    ``optimize()`` allocates a per-component budget and then trusts each helper
    to honour it, so an overshoot here silently blows the model's context
    window. The sweeps below walk every budget from 0 up to the input's full
    cost, which is what makes them meaningful under either tokenizer (the real
    ``tiktoken`` BPE or this suite's whitespace stub).
    """

    # A text whose sentences cost more together than apart under BPE: joining
    # on a single space does not always merge into the following token, so the
    # greedy per-sentence tally in truncate_to_budget can undercount.
    JOIN_SENSITIVE = (
        'Alpha beta gamma. 12345 67890. Delta epsilon. Extra sentence here to force truncation of the tail.'
    )

    def test_truncate_to_budget_never_exceeds_budget(self, optimizer):
        text = self.JOIN_SENSITIVE
        full = optimizer.count_tokens(text)
        assert full > 4, 'sweep needs a multi-token text'
        for max_tokens in range(full + 2):
            result = optimizer.truncate_to_budget(text, max_tokens)
            assert optimizer.count_tokens(result) <= max_tokens, (
                f'truncate_to_budget returned {optimizer.count_tokens(result)} tokens for a '
                f'{max_tokens}-token budget: {result!r}'
            )

    def test_truncate_to_budget_still_prefers_sentence_boundaries(self, optimizer):
        """The re-measure guard must not turn every call into a token-level cut."""
        text = 'First sentence. Second sentence. Third sentence.'
        two = optimizer.count_tokens('First sentence. Second sentence.')
        result = optimizer.truncate_to_budget(text, two)
        assert result == 'First sentence. Second sentence.'

    def test_summarize_history_never_exceeds_budget(self, optimizer):
        """The summary placeholder gains tokens when the omitted count is filled in."""
        messages = [{'role': 'user', 'content': f'message number {i} with some filler words here'} for i in range(12)]
        total = sum(optimizer._message_tokens(m) for m in messages)
        # A message costs its role plus 4 tokens of framing even when empty, so
        # budgets below that floor cannot be met by any non-empty return value.
        floor = optimizer.count_tokens('user') + 4
        for max_tokens in range(floor, total + 2):
            result = optimizer.summarize_history(messages, max_tokens)
            used = sum(optimizer._message_tokens(m) for m in result)
            assert used <= max_tokens, (
                f'summarize_history returned {used} tokens for a {max_tokens}-token budget: {result!r}'
            )

    def test_summarize_history_still_summarizes_the_middle(self, optimizer):
        """The wider reservation must not stop the placeholder being emitted."""
        messages = [{'role': 'user', 'content': f'message number {i} with some filler words here'} for i in range(12)]
        total = sum(optimizer._message_tokens(m) for m in messages)
        result = optimizer.summarize_history(messages, total // 2)
        assert result[0] == messages[0]
        assert result[1]['role'] == 'user'
        assert result[1]['content'].startswith('[Earlier conversation summarized: ')
        assert result[1]['content'].endswith(' messages omitted]')

    def test_single_message_history_reserves_role_overhead(self, optimizer):
        """A one-message history is budgeted the same way as a summarized one."""
        messages = [{'role': 'assistant', 'content': 'alpha beta gamma delta epsilon zeta eta theta'}]
        total = optimizer._message_tokens(messages[0])
        floor = optimizer.count_tokens('assistant') + 4
        for max_tokens in range(floor, total + 2):
            result = optimizer.summarize_history(messages, max_tokens)
            assert sum(optimizer._message_tokens(m) for m in result) <= max_tokens


class TestSharedQueryBudget:
    """Tests for truncate_each_to_budget, which keeps one entry per input."""

    def test_empty_input(self, optimizer):
        assert optimizer.truncate_each_to_budget([], 100) == []

    def test_everything_fits_is_returned_unchanged(self, optimizer):
        texts = ['alpha beta.', 'gamma delta.', 'epsilon.']
        assert optimizer.truncate_each_to_budget(texts, 10000) == texts

    def test_zero_budget_empties_every_entry_but_keeps_the_count(self, optimizer):
        texts = ['alpha beta.', 'gamma delta.']
        assert optimizer.truncate_each_to_budget(texts, 0) == ['', '']

    def test_entry_count_and_order_are_preserved_under_pressure(self, optimizer):
        texts = ['alpha ' * 30, 'beta ' * 10, 'gamma ' * 20]
        result = optimizer.truncate_each_to_budget(texts, 12)
        assert len(result) == 3
        assert all(t.startswith(src.split()[0]) or t == '' for t, src in zip(result, texts))

    def test_shared_budget_is_respected(self, optimizer):
        texts = ['alpha ' * 30, 'beta ' * 10, 'gamma ' * 20]
        total = sum(optimizer.count_tokens(t) for t in texts)
        for max_tokens in range(total + 2):
            result = optimizer.truncate_each_to_budget(texts, max_tokens)
            assert len(result) == len(texts)
            used = sum(optimizer.count_tokens(t) for t in result)
            assert used <= max_tokens, f'{used} tokens spent against a {max_tokens}-token budget'

    def test_larger_entries_receive_larger_shares(self, optimizer):
        texts = ['alpha ' * 40, 'beta ' * 4]
        result = optimizer.truncate_each_to_budget(texts, 20)
        assert optimizer.count_tokens(result[0]) > optimizer.count_tokens(result[1])


class TestEffectiveModelEncoding:
    """A ``model`` override must select the tokenizer as well as the limit."""

    def test_override_selects_the_overridden_model_encoding(self, default_config):
        config = {**default_config, 'model_name': 'gpt-4'}
        opt = ContextOptimizer(config)
        assert opt.optimize(question='Test', model='gpt-5')['metadata']['encoding'] == 'o200k_base'

    def test_no_override_uses_the_configured_model_encoding(self, default_config):
        opt = ContextOptimizer({**default_config, 'model_name': 'gpt-4'})
        result = opt.optimize(question='Test')
        assert result['metadata']['encoding'] == opt._resolve_encoding_name() == 'cl100k_base'

    def test_encoding_name_for_model_does_not_poison_the_instance_cache(self, default_config):
        opt = ContextOptimizer({**default_config, 'model_name': 'gpt-4'})
        assert opt.encoding_name_for_model('gpt-5') == 'o200k_base'
        assert opt._resolve_encoding_name() == 'cl100k_base'


class TestScopedIdFallback:
    """A provider-scoped id must reach the fallback table by its bare name.

    The catalog already tries ``openai/gpt-5`` then ``gpt-5``. When the sibling
    ``llm_*`` nodes are not deployed the catalog is empty, which is exactly the
    case MODEL_LIMITS exists for -- so that lookup has to try the bare name too,
    or the scoped id silently lands on DEFAULT_MODEL_LIMIT.
    """

    def test_scoped_id_resolves_through_the_fallback_table(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)  # no llm_* dirs -> empty catalog
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        try:
            assert ContextOptimizer.model_catalog() == {}
            opt = ContextOptimizer({'model_name': 'openai/gpt-5', 'max_context_tokens': 0})
            assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5']
            assert opt._total_limit != DEFAULT_MODEL_LIMIT
            assert opt._warned_unknown_models == set(), 'a resolvable id must not warn'
        finally:
            ContextOptimizer._catalog_cache = None

    def test_full_id_still_wins_over_the_bare_name(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        monkeypatch.setitem(ContextOptimizer.MODEL_LIMITS, 'vendor/gpt-5', 4096)
        try:
            opt = ContextOptimizer({'model_name': 'vendor/gpt-5', 'max_context_tokens': 0})
            assert opt._total_limit == 4096
        finally:
            ContextOptimizer._catalog_cache = None

    def test_unknown_scoped_id_still_warns_and_defaults(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        try:
            opt = ContextOptimizer({'model_name': 'vendor/not-a-real-model', 'max_context_tokens': 0})
            assert opt._total_limit == DEFAULT_MODEL_LIMIT
            assert 'vendor/not-a-real-model' in opt._warned_unknown_models
        finally:
            ContextOptimizer._catalog_cache = None


class TestNaNBudgetPercentage:
    """NaN satisfies neither ``< 0`` nor ``> 100``, so it needs its own guard."""

    @pytest.mark.parametrize('value', [float('nan'), 'nan', 'NaN'])
    def test_nan_percentage_is_rejected(self, default_config, value):
        opt = ContextOptimizer({**default_config, 'document_budget_pct': value})
        assert opt.document_budget_pct == 0.0

    def test_nan_percentage_does_not_break_allocation(self, default_config):
        """Left unguarded this raises ValueError inside allocate_budget's int()."""
        opt = ContextOptimizer({**default_config, 'document_budget_pct': float('nan')})
        budget = opt.allocate_budget(1000)
        assert budget['documents'] == 0
        assert sum(budget.values()) <= 1000

    def test_infinity_is_still_clamped(self, default_config):
        opt = ContextOptimizer({**default_config, 'document_budget_pct': float('inf')})
        assert opt.document_budget_pct == 100.0
        opt = ContextOptimizer({**default_config, 'document_budget_pct': float('-inf')})
        assert opt.document_budget_pct == 0.0


class TestMultiEntryQuestions:
    """Every QuestionText entry must survive the node.

    Downstream embedding nodes embed each entry (see
    ``embedding_transformer/sentenceTransformer.py``) and the document stores
    read per-entry embedding metadata, so dropping entries here loses both.
    """

    @staticmethod
    def _instance(optimizer):
        inst = IInstance.__new__(IInstance)
        iglobal = MagicMock()
        iglobal.optimizer = optimizer
        inst.IGlobal = iglobal
        inst.instance = MagicMock()
        return inst

    @staticmethod
    def _question(*texts):
        q = Question()
        for text in texts:
            q.addQuestion(text)
        for idx, entry in enumerate(q.questions):
            entry.embedding_model = f'model-{idx}'
            entry.embedding = [float(idx)]
        return q

    def test_all_entries_survive_when_nothing_is_truncated(self, optimizer):
        inst = self._instance(optimizer)
        inst.writeQuestions(self._question('First question?', 'Second question?', 'Third question?'))

        forwarded = inst.instance.writeQuestions.call_args.args[0]
        assert [e.text for e in forwarded.questions] == ['First question?', 'Second question?', 'Third question?']
        assert [e.embedding_model for e in forwarded.questions] == ['model-0', 'model-1', 'model-2']
        assert [e.embedding for e in forwarded.questions] == [[0.0], [1.0], [2.0]]

    def test_all_entries_survive_when_the_query_is_truncated(self, small_budget_config):
        opt = ContextOptimizer({**small_budget_config, 'max_context_tokens': 40})
        inst = self._instance(opt)
        texts = ('alpha ' * 200, 'beta ' * 200, 'gamma ' * 200)
        inst.writeQuestions(self._question(*texts))

        forwarded = inst.instance.writeQuestions.call_args.args[0]
        assert len(forwarded.questions) == 3, 'no entry may be dropped'
        # Embedding metadata rides along with each surviving entry.
        assert [e.embedding_model for e in forwarded.questions] == ['model-0', 'model-1', 'model-2']
        # The entries together stay inside the shared query budget.
        query_budget = opt.allocate_budget(40)['query']
        used = sum(opt.count_tokens(e.text) for e in forwarded.questions)
        assert used <= query_budget, f'{used} tokens spent against a {query_budget}-token query budget'
        # Something was actually trimmed -- otherwise this asserts nothing.
        assert used < sum(opt.count_tokens(t) for t in texts)

    def test_single_entry_takes_the_optimized_text_directly(self, small_budget_config):
        opt = ContextOptimizer({**small_budget_config, 'max_context_tokens': 40})
        inst = self._instance(opt)
        text = 'alpha ' * 200
        inst.writeQuestions(self._question(text))

        forwarded = inst.instance.writeQuestions.call_args.args[0]
        assert len(forwarded.questions) == 1
        assert forwarded.questions[0].text.startswith('alpha')
        assert opt.count_tokens(text) > 40, 'input must exceed the window for this to assert anything'
        assert opt.count_tokens(forwarded.questions[0].text) <= opt.allocate_budget(40)['query']

    def test_multi_entry_input_is_no_longer_warned_about(self, optimizer):
        inst = self._instance(optimizer)
        with patch('context_optimizer.IInstance.warning') as mock_warning:
            inst.writeQuestions(self._question('One?', 'Two?'))
        assert mock_warning.call_args_list == []


class TestScopedIdEncoding:
    """A provider-scoped id must pick the tokenizer its bare name would pick.

    ``resolve_model_limit`` already falls back to the bare name, so
    ``openai/gpt-5`` resolves the 400k gpt-5 window. Before this fix
    ``encoding_name_for_model`` did not strip the provider prefix, so the
    override table missed, ``tiktoken.encoding_for_model`` raised KeyError and
    the count silently fell back to cl100k_base -- the gpt-5 window measured
    with the wrong ruler.
    """

    @pytest.mark.parametrize(
        ('scoped', 'bare', 'expected'),
        [
            ('openai/gpt-5', 'gpt-5', 'o200k_base'),
            ('openai/gpt-4o', 'gpt-4o', 'o200k_base'),
            ('azure/gpt-4o', 'gpt-4o', 'o200k_base'),
            ('openai/gpt-4-turbo', 'gpt-4-turbo', 'cl100k_base'),
        ],
    )
    def test_scoped_id_matches_its_bare_name(self, default_config, scoped, bare, expected):
        opt = ContextOptimizer(default_config)
        assert opt.encoding_name_for_model(scoped) == opt.encoding_name_for_model(bare) == expected

    @pytest.mark.parametrize(
        ('model', 'expected'),
        [
            ('gpt-5', 'o200k_base'),
            ('gpt-4o', 'o200k_base'),
            ('gpt-4', 'cl100k_base'),
            ('gpt-4-turbo', 'cl100k_base'),
            ('claude-sonnet-4-6', 'cl100k_base'),
            ('custom', 'cl100k_base'),
            ('', 'cl100k_base'),
        ],
    )
    def test_unscoped_ids_are_unchanged(self, default_config, model, expected):
        """The normalization must not move any id that has no provider prefix."""
        assert ContextOptimizer(default_config).encoding_name_for_model(model) == expected

    def test_unknown_scoped_id_still_falls_back(self, default_config):
        opt = ContextOptimizer(default_config)
        assert opt.encoding_name_for_model('vendor/not-a-real-model') == 'cl100k_base'

    def test_scoped_id_limit_and_encoding_agree(self, tmp_path, monkeypatch):
        """The window and the tokenizer must come from the same model.

        With no llm_* dirs the catalog is empty, so the limit is reached through
        the MODEL_LIMITS bare-name fallback -- the exact path that used to pair
        the gpt-5 window with the cl100k_base tokenizer.
        """
        monkeypatch.setattr(ContextOptimizer, '_CATALOG_ROOT', tmp_path)
        monkeypatch.setattr(ContextOptimizer, '_catalog_cache', None)
        try:
            scoped = ContextOptimizer({'model_name': 'openai/gpt-5', 'max_context_tokens': 0})
            bare = ContextOptimizer({'model_name': 'gpt-5', 'max_context_tokens': 0})
            assert scoped._total_limit == bare._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5']
            assert scoped._resolve_encoding_name() == bare._resolve_encoding_name() == 'o200k_base'
        finally:
            ContextOptimizer._catalog_cache = None

    @pytest.mark.skipif(
        not _HAS_REAL_TIKTOKEN,
        reason='the tiktoken stub splits on whitespace, so no two encodings can disagree',
    )
    def test_scoped_id_token_counts_match_the_bare_id(self, default_config):
        """cl100k_base and o200k_base disagree most on non-ASCII text."""
        text = (
            '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8\u3092\u305f\u304f\u3055\u3093\u66f8\u304d\u307e\u3059\u3002'
            * 30
        )
        scoped = ContextOptimizer({**default_config, 'model_name': 'openai/gpt-5'})
        bare = ContextOptimizer({**default_config, 'model_name': 'gpt-5'})
        wrong = ContextOptimizer({**default_config, 'model_name': 'gpt-4'})
        assert scoped.count_tokens(text) == bare.count_tokens(text)
        # Guard against a vacuous pass: the two encodings really do differ here.
        assert wrong.count_tokens(text) != bare.count_tokens(text)

    def test_optimize_override_accepts_a_scoped_id(self, default_config):
        opt = ContextOptimizer({**default_config, 'model_name': 'gpt-4'})
        assert opt.optimize(question='Test', model='openai/gpt-5')['metadata']['encoding'] == 'o200k_base'


def _model_name_warnings(mock_warning) -> list:
    """Warnings about model_name validation, ignoring the unknown-model one."""
    return [c for c in mock_warning.call_args_list if 'model_name is not' in str(c)]


class TestModelNameValidation:
    """``model_name`` is declared a string but nothing coerces one on the way in.

    ``Config.getNodeConfig`` merges the profile defaults into the raw pipeline
    config without type-checking, so a hand-written ``"model_name": null``
    reached ``resolve_model_limit`` and raised
    ``AttributeError: 'NoneType' object has no attribute 'rsplit'`` inside
    ``beginGlobal``, taking the whole node down.
    """

    @pytest.mark.parametrize('value', [None, 123, 4.5, True, ['gpt-5'], {'a': 1}, '', '   '])
    def test_invalid_model_name_falls_back_to_the_default(self, default_config, value):
        with patch('context_optimizer.optimizer.warning') as mock_warning:
            opt = ContextOptimizer({**default_config, 'model_name': value})
        assert opt.model_name == DEFAULT_MODEL_NAME
        assert opt._total_limit == ContextOptimizer.MODEL_LIMITS[DEFAULT_MODEL_NAME]
        assert _model_name_warnings(mock_warning)

    @pytest.mark.parametrize('value', [None, 123, ''])
    def test_invalid_model_name_does_not_raise_without_an_override(self, value):
        """max_context_tokens=0 is what forces the resolve_model_limit call."""
        opt = ContextOptimizer({'model_name': value, 'max_context_tokens': 0})
        assert opt.model_name == DEFAULT_MODEL_NAME
        assert opt.optimize(question='Test')['metadata']['model'] == DEFAULT_MODEL_NAME

    def test_missing_model_name_uses_the_documented_default(self, default_config):
        config = {k: v for k, v in default_config.items() if k != 'model_name'}
        with patch('context_optimizer.optimizer.warning') as mock_warning:
            opt = ContextOptimizer(config)
        assert opt.model_name == DEFAULT_MODEL_NAME
        assert not _model_name_warnings(mock_warning), 'an absent key is not a misconfiguration'

    @pytest.mark.parametrize('value', ['gpt-4', 'openai/gpt-5', 'claude-sonnet-4-6', 'custom'])
    def test_valid_model_names_pass_through_untouched(self, default_config, value):
        with patch('context_optimizer.optimizer.warning') as mock_warning:
            opt = ContextOptimizer({**default_config, 'model_name': value})
        assert opt.model_name == value
        # ``custom`` legitimately trips the unrelated unknown-model warning.
        assert not _model_name_warnings(mock_warning)

    def test_surrounding_whitespace_is_stripped(self, default_config):
        assert ContextOptimizer({**default_config, 'model_name': '  gpt-5  '}).model_name == 'gpt-5'
