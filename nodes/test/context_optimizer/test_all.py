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
import re
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

from ai.common.schema import Doc, Question, QuestionHistory  # noqa: E402

from context_optimizer.IGlobal import IGlobal  # noqa: E402
from context_optimizer.IInstance import (  # noqa: E402
    IInstance,
    blank_budgeted_fields,
    prompt_overhead_tokens,
)
from context_optimizer.optimizer import (  # noqa: E402
    CONSERVATIVE_MODEL_LIMIT_FLOOR,
    DEFAULT_MODEL_NAME,
    ContextOptimizer,
)

import rocketlib  # noqa: E402  -- the engine binding the catalog is read through


# ===========================================================================
# Engine-registry substitutes
# ===========================================================================
#
# The catalog is read through ``rocketlib.getServiceDefinitions()`` (the
# engine's index of registered services) and ``rocketlib.getServiceDefinition``
# (one node's raw services*.json). Outside the engine those are the C++
# binding's stubs, so the tests below install substitutes on the ``rocketlib``
# module and exercise the production ``_engine_model_definitions`` path
# unchanged.


def _load_jsonc(path: Path) -> dict:
    """Tolerant loader for the services*.json files (comments, trailing commas).

    Test-local on purpose: production never parses these files itself any
    more -- the engine does, and hands the node the parsed definition.
    """
    text = path.read_text(encoding='utf-8')
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if text.startswith('//', i):
            i = text.find('\n', i)
            i = n if i < 0 else i
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c)
        i += 1
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', ''.join(out)))


def _source_tree_registry() -> tuple[dict, dict]:
    """(index, definitions) for every node in the source tree.

    Mirrors what the engine registry returns: the index carries each
    logical type's ``classType``; the definitions are the raw files. The
    optimizer decides by content which of them publish a model catalog.
    """
    index: dict[str, dict] = {}
    definitions: dict[str, dict] = {}
    for path in sorted(_NODES_SRC.glob('*/services*.json')):
        try:
            definition = _load_jsonc(path)
        except ValueError:
            continue
        protocol = definition.get('protocol') if isinstance(definition, dict) else None
        logical_type = protocol[:-3] if isinstance(protocol, str) and protocol.endswith('://') else path.parent.name
        index[logical_type] = {'classType': definition.get('classType', []), 'title': definition.get('title', '')}
        definitions[logical_type] = definition
    return index, definitions


def _install_registry(monkeypatch, index, definitions, *, calls=None, envelope=True):
    """Point ``rocketlib`` at a fake engine registry.

    By default the index is served in the engine's real shape -- the
    ``{"services": {...}, "version": N}`` envelope that
    ``IServices::getServiceSchemas`` builds; ``envelope=False`` serves a bare
    index to exercise the tolerance path.
    """

    def get_definitions():
        if calls is not None:
            calls.append(('index',))
        return {'services': index, 'version': 'test'} if envelope else index

    def get_definition(logical_type):
        if calls is not None:
            calls.append(('definition', logical_type))
        return definitions[logical_type]

    monkeypatch.setattr(rocketlib, 'getServiceDefinitions', get_definitions)
    monkeypatch.setattr(rocketlib, 'getServiceDefinition', get_definition)


def _definitions(class_types, **nodes):
    """Build a synthetic (index, definitions) pair: name -> [(model, window), ...]."""
    index, definitions = {}, {}
    for name, profiles in nodes.items():
        index[name] = {'classType': list(class_types)}
        definitions[name] = {
            'classType': list(class_types),
            'preconfig': {
                'profiles': {f'p{i}': {'model': m, 'modelTotalTokens': w} for i, (m, w) in enumerate(profiles)}
            },
        }
    return index, definitions


def _llm_definitions(**nodes):
    """Chat-LLM definitions (``classType: ["llm"]``)."""
    return _definitions(['llm'], **nodes)


@pytest.fixture
def engine_registry(monkeypatch):
    """The real source-tree llm_* catalog, served through the registry seam."""
    index, definitions = _source_tree_registry()
    _install_registry(monkeypatch, index, definitions)
    return index, definitions


@pytest.fixture
def empty_registry(monkeypatch):
    """An engine with no LLM nodes registered (the catalog is empty)."""
    _install_registry(monkeypatch, {}, {})


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

    def test_fallback_table_never_disagrees_with_catalog(self, engine_registry):
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

    def test_unknown_model_uses_conservative_floor(self, empty_registry):
        """An id nothing knows is budgeted at the smallest known window, never above."""
        config = {'model_name': 'unknown-model-xyz', 'max_context_tokens': 0}
        opt = ContextOptimizer(config)
        assert opt._total_limit == min(ContextOptimizer.MODEL_LIMITS.values())
        assert 'unknown-model-xyz' in opt._warned_unknown_models

    def test_unknown_model_never_exceeds_a_catalogued_window(self, monkeypatch):
        """A small catalogued model drags the unknown-model budget down with it."""
        _install_registry(monkeypatch, *_llm_definitions(llm_tiny=[('tiny-4k', 4096)]))
        opt = ContextOptimizer({'model_name': 'unknown-model-xyz', 'max_context_tokens': 0})
        assert opt._total_limit == 4096
        assert opt.conservative_model_limit() == 4096

    def test_floor_constant_only_when_nothing_is_known(self, empty_registry, monkeypatch):
        monkeypatch.setattr(ContextOptimizer, 'MODEL_LIMITS', {})
        opt = ContextOptimizer({'model_name': 'unknown-model-xyz', 'max_context_tokens': 0})
        assert opt._total_limit == CONSERVATIVE_MODEL_LIMIT_FLOOR

    def test_custom_max_context_override(self):
        config = {'model_name': 'gpt-5', 'max_context_tokens': 50000}
        opt = ContextOptimizer(config)
        assert opt._total_limit == 50000


class TestModelCatalog:
    """Tests for the live model catalog read through the engine registry."""

    @staticmethod
    def _declared_ids_by_node() -> dict[str, set[str]]:
        """Model ids each source-tree ``llm_*`` node declares, read independently.

        Parsed straight from the services files by the test's own loader
        rather than through :meth:`ContextOptimizer._load_model_catalog`, so
        the assertions below are a real check on the loader and not a
        restatement of it.
        """
        declared: dict[str, set[str]] = {}
        for path in sorted(_NODES_SRC.glob('llm_*/services*.json')):
            service = _load_jsonc(path)
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

    def test_catalog_is_discovered(self, engine_registry):
        """Every source-tree llm_* node's profiles reach the catalog via the registry.

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

    def test_catalog_is_read_through_the_engine_registry(self, monkeypatch):
        """Discovery goes index -> every registered type -> raw definition, by content.

        This is the review's ask: no globbing relative to ``__file__``, so an
        installed or ``--node_path``-materialised node with no sibling
        directories still sees the catalog the engine loaded. Which nodes
        contribute is decided by what their definition publishes, not by a
        name or class convention (the vision nodes register as
        ``image_vision_*`` with ``classType: ["image"]`` and still publish
        ``modelTotalTokens``).
        """
        calls: list = []
        index = {
            'llm_alpha': {'classType': ['llm']},
            'image_vision_gamma': {'classType': ['image']},
            'store_vector': {'classType': ['store']},
        }
        definitions = {
            'llm_alpha': {'preconfig': {'profiles': {'p': {'model': 'alpha-1', 'modelTotalTokens': 32000}}}},
            'image_vision_gamma': {'preconfig': {'profiles': {'p': {'model': 'gamma-1', 'modelTotalTokens': 2048}}}},
            'store_vector': {'preconfig': {'profiles': {'p': {'dimensions': 1536}}}},
        }
        _install_registry(monkeypatch, index, definitions, calls=calls)
        catalog = ContextOptimizer.model_catalog()
        assert catalog == {'alpha-1': 32000, 'gamma-1': 2048}
        assert calls[0] == ('index',)
        fetched = {name for kind, *rest in calls if kind == 'definition' for name in rest}
        assert fetched == set(index), 'every registered type is consulted; content decides'
        assert not hasattr(ContextOptimizer, '_CATALOG_ROOT'), 'no filesystem-relative discovery may remain'

    def test_no_filesystem_access_during_discovery(self, monkeypatch):
        """Even with a registry present, discovery never touches the filesystem."""
        _install_registry(monkeypatch, *_llm_definitions(llm_x=[('x-1', 1000)]))

        def _no_glob(*args, **kwargs):
            raise AssertionError('catalog discovery must not glob the filesystem')

        monkeypatch.setattr(Path, 'glob', _no_glob)
        monkeypatch.setattr(Path, 'rglob', _no_glob)
        assert ContextOptimizer.model_catalog() == {'x-1': 1000}

    @pytest.mark.parametrize(
        'raw',
        [
            None,
            'not-a-dict',
            [],
            42,
            {'services': 'not-a-dict', 'version': 1},
            {'services': None, 'version': 1},
            {'services': [], 'version': 1},
        ],
    )
    def test_unusable_registry_index_yields_empty_catalog(self, monkeypatch, raw):
        monkeypatch.setattr(rocketlib, 'getServiceDefinitions', lambda: raw)
        monkeypatch.setattr(rocketlib, 'getServiceDefinition', lambda lt: pytest.fail('must not be called'))
        assert ContextOptimizer.model_catalog() == {}

    def test_registry_envelope_is_unwrapped(self, monkeypatch):
        """The binding returns {"services": {...}, "version": N}; only the index is walked."""
        calls: list = []
        index, definitions = _llm_definitions(llm_env=[('env-1', 12000)])
        _install_registry(monkeypatch, index, definitions, calls=calls, envelope=True)
        assert ContextOptimizer.model_catalog() == {'env-1': 12000}
        fetched = [rest[0] for kind, *rest in calls if kind == 'definition']
        assert fetched == ['llm_env'], 'the envelope keys ("services", "version") must never be looked up as types'

    def test_bare_index_is_tolerated(self, monkeypatch):
        index, definitions = _llm_definitions(llm_flat=[('flat-1', 9000)])
        _install_registry(monkeypatch, index, definitions, envelope=False)
        assert ContextOptimizer.model_catalog() == {'flat-1': 9000}

    def test_non_llm_windows_are_catalogued_but_never_lower_the_floor(self, monkeypatch):
        """An embedding input limit resolves by id, yet an unknown chat model is not budgeted at it."""
        index, definitions = _definitions(['embedding'], embedding_x=[('text-embed-tiny', 2048)])
        i2, d2 = _llm_definitions(llm_big=[('chat-big', 200000)])
        index.update(i2)
        definitions.update(d2)
        _install_registry(monkeypatch, index, definitions)
        assert ContextOptimizer.model_catalog()['text-embed-tiny'] == 2048
        opt = ContextOptimizer({'model_name': 'unknown-chat', 'max_context_tokens': 0})
        assert opt.conservative_model_limit() == min(ContextOptimizer.MODEL_LIMITS.values())
        assert opt.conservative_model_limit() > 2048

    def test_registry_failures_degrade_to_empty_or_partial(self, monkeypatch):
        """A raising index means no catalog; one raising definition is skipped."""

        def _raise():
            raise RuntimeError('boom')

        monkeypatch.setattr(rocketlib, 'getServiceDefinitions', _raise)
        assert ContextOptimizer.model_catalog() == {}

        index = {'llm_ok': {'classType': ['llm']}, 'llm_broken': {'classType': ['llm']}}

        def get_definition(logical_type):
            if logical_type == 'llm_broken':
                raise RuntimeError('engine says no')
            return {'preconfig': {'profiles': {'p': {'model': 'ok-1', 'modelTotalTokens': 5000}}}}

        monkeypatch.setattr(rocketlib, 'getServiceDefinitions', lambda: index)
        monkeypatch.setattr(rocketlib, 'getServiceDefinition', get_definition)
        assert ContextOptimizer.model_catalog() == {'ok-1': 5000}

    def test_registry_refresh_is_seen_without_a_restart(self, monkeypatch):
        """No class-level cache: a changed registry is visible to the next optimizer."""
        _install_registry(monkeypatch, *_llm_definitions(llm_v1=[('model-r', 16000)]))
        first = ContextOptimizer({'model_name': 'model-r', 'max_context_tokens': 0})
        assert first._total_limit == 16000

        _install_registry(monkeypatch, *_llm_definitions(llm_v1=[('model-r', 64000)]))
        second = ContextOptimizer({'model_name': 'model-r', 'max_context_tokens': 0})
        assert second._total_limit == 64000
        assert first._total_limit == 16000, 'an existing optimizer keeps the snapshot it budgeted with'

    def test_catalog_beats_fallback_table(self, engine_registry):
        """A model only the catalog knows still resolves."""
        catalog = ContextOptimizer.model_catalog()
        model = 'grok-4-0709'
        if model not in catalog:
            pytest.skip(f"{model} not present in this build's llm_* catalog")
        opt = ContextOptimizer({'model_name': model, 'max_context_tokens': 0})
        assert opt._total_limit == catalog[model]
        assert model not in ContextOptimizer.MODEL_LIMITS

    def test_bare_alias_does_not_shadow_unscoped_profile(self, monkeypatch):
        """A gateway's `gw/model-x` must not override the unscoped `model-x`."""
        _install_registry(
            monkeypatch, *_llm_definitions(llm_a_gateway=[('gw/model-x', 128000)], llm_z_native=[('model-x', 400000)])
        )
        catalog = ContextOptimizer.model_catalog()
        assert catalog['model-x'] == 400000
        assert catalog['gw/model-x'] == 128000

    def test_ambiguous_bare_alias_is_dropped(self, monkeypatch):
        """Two gateways disagreeing about a bare name means no alias at all."""
        _install_registry(
            monkeypatch,
            *_llm_definitions(llm_a_gateway=[('a/model-z', 128000)], llm_b_gateway=[('b/model-z', 1048576)]),
        )
        catalog = ContextOptimizer.model_catalog()
        assert 'model-z' not in catalog
        assert catalog['a/model-z'] == 128000
        assert catalog['b/model-z'] == 1048576

    def test_conflicting_limits_keep_the_smaller(self, monkeypatch):
        """The same id in two definitions resolves to the safer window."""
        _install_registry(monkeypatch, *_llm_definitions(llm_one=[('model-y', 262144)], llm_two=[('model-y', 128000)]))
        assert ContextOptimizer.model_catalog()['model-y'] == 128000

    def test_resolve_falls_back_to_table_for_family_alias(self, engine_registry):
        """Abbreviated aliases are not catalogued, so the table answers."""
        catalog = ContextOptimizer.model_catalog()
        assert 'claude-sonnet' not in catalog
        opt = ContextOptimizer({'model_name': 'claude-sonnet', 'max_context_tokens': 0})
        assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['claude-sonnet']

    def test_malformed_definitions_are_ignored(self, monkeypatch):
        """Definitions without usable profiles degrade to the fallback table."""
        index = {
            'llm_broken': {'classType': ['llm']},
            'llm_odd': {'classType': ['llm']},
            'llm_none': {'classType': ['llm']},
        }
        definitions = {
            'llm_broken': 'not a dict',
            'llm_odd': {'preconfig': {'profiles': [1, 2]}},
            'llm_none': {'preconfig': {'profiles': {'p': {'model': 'm', 'modelTotalTokens': True}}}},
        }
        _install_registry(monkeypatch, index, definitions)
        assert ContextOptimizer.model_catalog() == {}
        opt = ContextOptimizer({'model_name': 'gpt-5.4', 'max_context_tokens': 0})
        assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5.4']


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

    The catalog already tries ``openai/gpt-5`` then ``gpt-5``. When the engine
    has no LLM nodes registered the catalog is empty, which is exactly the
    case MODEL_LIMITS exists for -- so that lookup has to try the bare name too,
    or the scoped id silently lands on the conservative fallback.
    """

    def test_scoped_id_resolves_through_the_fallback_table(self, empty_registry):
        assert ContextOptimizer.model_catalog() == {}
        opt = ContextOptimizer({'model_name': 'openai/gpt-5', 'max_context_tokens': 0})
        assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5']
        assert opt._total_limit != opt.conservative_model_limit()
        assert opt._warned_unknown_models == set(), 'a resolvable id must not warn'

    def test_full_id_still_wins_over_the_bare_name(self, empty_registry, monkeypatch):
        monkeypatch.setitem(ContextOptimizer.MODEL_LIMITS, 'vendor/gpt-5', 4096)
        opt = ContextOptimizer({'model_name': 'vendor/gpt-5', 'max_context_tokens': 0})
        assert opt._total_limit == 4096

    def test_unknown_scoped_id_still_warns_and_uses_the_floor(self, empty_registry):
        opt = ContextOptimizer({'model_name': 'vendor/not-a-real-model', 'max_context_tokens': 0})
        assert opt._total_limit == opt.conservative_model_limit()
        assert opt._total_limit == min(ContextOptimizer.MODEL_LIMITS.values())
        assert 'vendor/not-a-real-model' in opt._warned_unknown_models


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

        With no LLM nodes registered the catalog is empty, so the limit is reached through
        the MODEL_LIMITS bare-name fallback -- the exact path that used to pair
        the gpt-5 window with the cl100k_base tokenizer.
        """
        _install_registry(monkeypatch, {}, {})  # an engine with no LLM nodes -> empty catalog
        scoped = ContextOptimizer({'model_name': 'openai/gpt-5', 'max_context_tokens': 0})
        bare = ContextOptimizer({'model_name': 'gpt-5', 'max_context_tokens': 0})
        assert scoped._total_limit == bare._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5']
        assert scoped._resolve_encoding_name() == bare._resolve_encoding_name() == 'o200k_base'

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


# ===========================================================================
# Un-budgeted prompt overhead
# ===========================================================================
#
# ``optimize`` used to total only the four budgeted components, but
# ``Question.getPrompt()`` also renders ``instructions`` (the ``prompt`` node
# appends there), ``examples``, ``context`` (retrieval fills it), ``goals``,
# and a skeleton of ``### ...`` headers / ``Document N) Content:`` prefixes /
# CRLF joins. A question whose four fields fit could therefore be waved
# through pass 1 while the rendered prompt was already over the window -- the
# exact failure this node exists to prevent.


def _make_iinstance(optimizer) -> IInstance:
    """An IInstance wired to *optimizer* with a mocked downstream."""
    inst = IInstance.__new__(IInstance)
    iglobal = MagicMock()
    iglobal.optimizer = optimizer
    inst.IGlobal = iglobal
    inst.instance = MagicMock()
    return inst


def _forwarded(inst) -> Question:
    """The Question the instance handed downstream."""
    return inst.instance.writeQuestions.call_args.args[0]


def _mock_optimize_result() -> dict:
    return {
        'system_prompt': 'opt_sys',
        'question': 'opt_q',
        'documents': [],
        'history': [],
        'metadata': {
            'tokens_used': 10,
            'tokens_saved': 0,
            'overhead_tokens': 0,
            'components_truncated': [],
            'model': 'gpt-5',
            'total_limit': 128000,
            'budget': {},
        },
    }


def _overhead_warnings(mock_warning) -> list:
    """Warnings about the un-budgeted sections filling the window."""
    return [c for c in mock_warning.call_args_list if 'does not budget' in str(c)]


class TestUnbudgetedPromptOverhead:
    """The overhead is measured from the real rendering and charged to the window."""

    def test_blanked_copy_keeps_the_markup_and_drops_the_budgeted_content(self):
        q = Question(role='ROLEBODY')
        q.addQuestion('QUESTIONBODY')
        q.addInstruction('Focus', 'INSTRUCTIONBODY')
        q.addExample('EXAMPLEGIVEN', 'EXAMPLERESULT')
        q.addContext('CONTEXTBODY')
        q.addGoal('GOALBODY')
        q.addHistory(QuestionHistory(role='user', content='HISTORYBODY'))
        q.addDocuments(Doc(page_content='DOCUMENTBODY'))

        skeleton = blank_budgeted_fields(q).getPrompt()

        # The four budgeted fields are gone -- the optimizer counts those itself.
        for gone in ('ROLEBODY', 'QUESTIONBODY', 'HISTORYBODY', 'DOCUMENTBODY'):
            assert gone not in skeleton, f'{gone} would be counted twice'
        # Everything the node cannot trim is still there, markup included.
        for kept in (
            'INSTRUCTIONBODY',
            'EXAMPLEGIVEN',
            'EXAMPLERESULT',
            'CONTEXTBODY',
            'GOALBODY',
            '### System Instructions:',
            '### Examples:',
            '### Conversation History:',
            '### Context:',
            '### Documents:',
            '### Ultimate Goal:',
            '### Current Task:',
            'Document 1) Content:',
            'user:',
        ):
            assert kept in skeleton, f'{kept} is part of the rendered prompt and must be counted'

    def test_blanking_leaves_the_source_question_untouched(self):
        q = Question(role='ROLEBODY')
        q.addQuestion('QUESTIONBODY')
        q.addHistory(QuestionHistory(role='user', content='HISTORYBODY'))
        q.addDocuments(Doc(page_content='DOCUMENTBODY'))

        blank_budgeted_fields(q)

        assert q.role == 'ROLEBODY'
        assert q.questions[0].text == 'QUESTIONBODY'
        assert q.history[0].content == 'HISTORYBODY'
        assert q.documents[0].page_content == 'DOCUMENTBODY'

    def test_bare_question_still_pays_for_its_markup(self, optimizer):
        q = Question()
        q.addQuestion('Hi')
        assert prompt_overhead_tokens(optimizer, q) > 0

    def test_expectjson_boilerplate_is_counted(self, optimizer):
        plain = Question()
        plain.addQuestion('Hi')
        jsonish = Question(expectJson=True)
        jsonish.addQuestion('Hi')
        assert prompt_overhead_tokens(optimizer, jsonish) > prompt_overhead_tokens(optimizer, plain)

    def test_question_whose_budgeted_fields_fit_is_no_longer_passed_through(self):
        """The regression: four small fields, a big instructions/context block."""
        q = Question(role='ROLEBODY')
        q.addQuestion('QUESTIONBODY')
        q.addInstruction('Focus', ' '.join(f'instruction-word-{i}' for i in range(200)))
        q.addContext(' '.join(f'context-word-{i}' for i in range(200)))

        probe = ContextOptimizer({'model_name': 'custom', 'max_context_tokens': 1000000})
        budgeted = probe.count_tokens('ROLEBODY') + probe.count_tokens('QUESTIONBODY')
        overhead = prompt_overhead_tokens(probe, q)
        # A window the four budgeted fields fit into, but the rendered prompt does not.
        limit = budgeted + overhead - 1
        assert budgeted <= limit, 'the budgeted fields must fit, or this test proves nothing'

        opt = ContextOptimizer({'model_name': 'custom', 'max_context_tokens': limit})

        # What the old, four-field-only accounting did with the same window.
        untracked = opt.optimize(question='QUESTIONBODY', system_prompt='ROLEBODY')
        assert untracked['metadata']['components_truncated'] == []

        inst = _make_iinstance(opt)
        inst.writeQuestions(q)

        out = _forwarded(inst)
        assert out.questions[0].text != 'QUESTIONBODY'
        assert q.questions[0].text == 'QUESTIONBODY', 'the upstream question must not be mutated'

    def test_iinstance_passes_the_measured_overhead_to_optimize(self):
        mock_opt = MagicMock()
        mock_opt.count_tokens.return_value = 77
        mock_opt.optimize.return_value = _mock_optimize_result()
        inst = _make_iinstance(mock_opt)

        q = Question(role='You are helpful.')
        q.addQuestion('What is AI?')
        inst.writeQuestions(q)

        # 77 measured tokens plus the two-token margin for the role line break
        assert mock_opt.optimize.call_args.kwargs['overhead_tokens'] == 79

    def test_budgets_are_allocated_from_what_the_overhead_leaves(self, small_optimizer):
        base = small_optimizer.optimize(question='a b c')['metadata']
        shrunk = small_optimizer.optimize(question='a b c', overhead_tokens=40)['metadata']

        assert sum(base['budget'].values()) == 100
        assert sum(shrunk['budget'].values()) == 60
        assert shrunk['budget']['documents'] < base['budget']['documents']
        assert base['overhead_tokens'] == 0
        assert shrunk['overhead_tokens'] == 40
        # The window itself is unchanged -- only the part left to budget shrinks.
        assert shrunk['total_limit'] == base['total_limit'] == 100

    def test_overhead_counts_towards_the_pass1_verdict(self, small_optimizer):
        body = ' '.join(f'word{i}' for i in range(20))
        assert small_optimizer.count_tokens(body) < 100, 'the body alone must fit the 100-token window'

        fits = small_optimizer.optimize(question=body)
        assert fits['metadata']['components_truncated'] == []
        assert fits['question'] == body

        over = small_optimizer.optimize(question=body, overhead_tokens=95)
        assert over['metadata']['components_truncated'] == ['question']
        assert over['question'] != body

    def test_overhead_alone_over_the_limit_empties_every_component(self, small_budget_config):
        opt = ContextOptimizer(small_budget_config)
        with patch('context_optimizer.optimizer.warning') as mock_warning:
            result = opt.optimize(
                question='question text',
                system_prompt='system text',
                documents=[{'content': 'doc text'}],
                history=[{'role': 'user', 'content': 'history text'}],
                overhead_tokens=120,
            )

        assert result['metadata']['budget'] == {'system_prompt': 0, 'query': 0, 'documents': 0, 'history': 0}
        assert result['system_prompt'] == ''
        assert result['question'] == ''
        assert result['documents'] == []
        assert result['history'] == []
        # Nothing but the overhead is left in the window.
        assert result['metadata']['tokens_used'] == 120
        assert _overhead_warnings(mock_warning)

    def test_the_overhead_warning_fires_once_per_optimizer(self, small_budget_config):
        opt = ContextOptimizer(small_budget_config)
        with patch('context_optimizer.optimizer.warning') as mock_warning:
            for _ in range(3):
                opt.optimize(question='x y z', overhead_tokens=120)
        assert len(_overhead_warnings(mock_warning)) == 1

    def test_the_overhead_is_never_reported_as_saved(self, small_budget_config):
        opt = ContextOptimizer(small_budget_config)
        body = ' '.join(f'word{i}' for i in range(500))
        result = opt.optimize(question=body, overhead_tokens=20)

        meta = result['metadata']
        assert meta['overhead_tokens'] == 20
        assert meta['tokens_saved'] == opt.count_tokens(body) - opt.count_tokens(result['question'])

    def test_default_overhead_is_zero(self, optimizer):
        assert optimizer.optimize(question='Hello world', system_prompt='Be nice')['metadata']['overhead_tokens'] == 0

    def test_negative_overhead_is_treated_as_zero(self, small_optimizer):
        meta = small_optimizer.optimize(question='x y z', overhead_tokens=-50)['metadata']
        assert meta['overhead_tokens'] == 0
        assert sum(meta['budget'].values()) == 100


# ===========================================================================
# max_context_tokens parsing
# ===========================================================================


class TestMaxContextTokensParsing:
    """``max_context_tokens`` is read with the shared ``ai.common.utils.config_int``.

    It replaces a node-local try/except that duplicated the same semantics:
    missing / null / non-numeric falls back to the default, and ``<= 0`` means
    "unspecified", which is what 0 means for this field (use the model's own
    window). The local parser additionally warned on a non-numeric value; that
    warning is deliberately dropped rather than pushed into ``config_int``,
    which the other adopters (``graph_falkordb``, ``tool_guild``,
    ``tool_http_request``) rely on being silent.
    """

    @pytest.mark.parametrize(
        'raw,expected',
        [
            ({}, 0),
            ({'max_context_tokens': None}, 0),
            ({'max_context_tokens': 'not_a_number'}, 0),
            ({'max_context_tokens': ''}, 0),
            ({'max_context_tokens': -500}, 0),
            ({'max_context_tokens': 0}, 0),
            ({'max_context_tokens': 1000}, 1000),
            ({'max_context_tokens': '1000'}, 1000),
            ({'max_context_tokens': 1000.9}, 1000),
        ],
    )
    def test_parsing_matches_the_documented_semantics(self, raw, expected):
        assert ContextOptimizer({'model_name': 'gpt-5', **raw}).max_context_tokens == expected

    def test_an_unparseable_value_falls_back_to_the_model_window(self):
        opt = ContextOptimizer({'model_name': 'gpt-5', 'max_context_tokens': [1, 2]})
        assert opt.max_context_tokens == 0
        assert opt._total_limit == ContextOptimizer.MODEL_LIMITS['gpt-5']
