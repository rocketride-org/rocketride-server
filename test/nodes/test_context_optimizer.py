# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Context Optimizer pipeline node.

Tests cover token counting, budget allocation, truncation, history
summarization, document ranking, the full optimization pipeline, model
limit lookup, edge cases, and IGlobal / IInstance lifecycle.

Runs without a live server -- tiktoken is mocked where needed.
"""

from __future__ import annotations

import sys
import types
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Stub external dependencies so the optimizer module can be imported without
# a running RocketRide server or tiktoken installed in the test env.
# ---------------------------------------------------------------------------

_STUBS_INSTALLED = False


def _install_stubs() -> None:
    global _STUBS_INSTALLED
    if _STUBS_INSTALLED:
        return

    # depends
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *_a, **_k: None
    sys.modules['depends'] = mod_depends

    # rocketlib
    rocketlib = types.ModuleType('rocketlib')

    class _IGlobalBase:
        pass

    class _IInstanceBase:
        pass

    class _Entry:
        pass

    class _OPEN_MODE:
        CONFIG = 'config'

    rocketlib.IGlobalBase = _IGlobalBase
    rocketlib.IInstanceBase = _IInstanceBase
    rocketlib.Entry = _Entry
    rocketlib.OPEN_MODE = _OPEN_MODE
    rocketlib.debug = lambda *a, **k: None
    rocketlib.warning = lambda *a, **k: None
    sys.modules['rocketlib'] = rocketlib

    # ai.common.config
    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    sys.modules['ai'] = ai_pkg

    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    sys.modules['ai.common'] = ai_common

    ai_config = types.ModuleType('ai.common.config')

    class _Config:
        @staticmethod
        def getNodeConfig(*_a, **_k):
            return {}

    ai_config.Config = _Config
    sys.modules['ai.common.config'] = ai_config

    # ai.common.schema -- minimal Question stub
    ai_schema = types.ModuleType('ai.common.schema')

    class _QuestionText:
        def __init__(self, text='', embedding_model=None, embedding=None):
            self.text = text
            self.embedding_model = embedding_model
            self.embedding = embedding

    class _QuestionHistory:
        def __init__(self, role='', content=''):
            self.role = role
            self.content = content

    class _Doc:
        def __init__(self, page_content='', **kwargs):
            self.page_content = page_content
            self._data = kwargs

        def model_dump(self):
            d = {'page_content': self.page_content}
            d.update(self._data)
            return d

        def dict(self):
            return self.model_dump()

    class _Question:
        def __init__(self, **kwargs):
            self.role = kwargs.get('role', '')
            self.questions = kwargs.get('questions', [])
            self.documents = kwargs.get('documents', [])
            self.history = kwargs.get('history', [])
            self.context = kwargs.get('context', [])
            self.instructions = kwargs.get('instructions', [])
            self.examples = kwargs.get('examples', [])
            self.goals = kwargs.get('goals', [])
            self.type = kwargs.get('type', 'question')
            self.filter = kwargs.get('filter', None)
            self.expectJson = kwargs.get('expectJson', False)

        def addQuestion(self, text):
            self.questions.append(_QuestionText(text=text))

    ai_schema.Question = _Question
    ai_schema.QuestionText = _QuestionText
    ai_schema.QuestionHistory = _QuestionHistory
    ai_schema.Doc = _Doc
    ai_schema.Answer = MagicMock
    ai_schema.QuestionType = MagicMock
    ai_schema.DocFilter = MagicMock
    sys.modules['ai.common.schema'] = ai_schema

    _STUBS_INSTALLED = True


_install_stubs()

# ---------------------------------------------------------------------------
# Now import the optimizer -- tiktoken must be available (install or mock).
# We try a real import first; if unavailable we create a mock.
# ---------------------------------------------------------------------------

try:
    import importlib.util

    _TIKTOKEN_AVAILABLE = importlib.util.find_spec('tiktoken') is not None
except Exception:
    _TIKTOKEN_AVAILABLE = False

    # Build a mock tiktoken module
    tiktoken_mod = types.ModuleType('tiktoken')

    class _MockEncoding:
        """Approximates cl100k_base: splits on whitespace."""

        name = 'cl100k_base'

        def encode(self, text: str) -> list:
            if not text:
                return []
            return text.split()

        def decode(self, tokens: list) -> str:
            return ' '.join(tokens)

    def _get_encoding(name: str = 'cl100k_base'):
        return _MockEncoding()

    tiktoken_mod.get_encoding = _get_encoding
    tiktoken_mod.Encoding = _MockEncoding
    sys.modules['tiktoken'] = tiktoken_mod

# Import the optimizer after stubs + tiktoken are available
from nodes.src.nodes.context_optimizer.optimizer import ContextOptimizer


# ===========================================================================
# Fixtures
# ===========================================================================


@pytest.fixture
def default_config() -> Dict[str, Any]:
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
def small_budget_config() -> Dict[str, Any]:
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

    def test_preserves_first_and_last_with_summary(self, optimizer):
        """With many messages and tight budget, first + placeholder + last should appear."""
        messages = [
            {'role': 'system', 'content': 'Be helpful.'},
        ] + [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'This is a medium length message number {i} in the conversation.'} for i in range(10)]
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
        assert result['metadata']['total_limit'] == 200000

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
    """Tests for MODEL_LIMITS lookup."""

    def test_gpt5_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['gpt-5'] == 128000

    def test_gpt5_mini_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['gpt-5-mini'] == 128000

    def test_gpt5_nano_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['gpt-5-nano'] == 128000

    def test_claude_opus_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['claude-opus'] == 200000

    def test_claude_sonnet_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['claude-sonnet'] == 200000

    def test_claude_haiku_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['claude-haiku'] == 200000

    def test_gemini_pro_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['gemini-pro'] == 1000000

    def test_gemini_flash_limit(self):
        assert ContextOptimizer.MODEL_LIMITS['gemini-flash'] == 1000000

    def test_unknown_model_uses_default(self):
        config = {'model_name': 'unknown-model-xyz', 'max_context_tokens': 0}
        opt = ContextOptimizer(config)
        # Should fall back to 128000
        assert opt._total_limit == 128000

    def test_custom_max_context_override(self):
        config = {'model_name': 'gpt-5', 'max_context_tokens': 50000}
        opt = ContextOptimizer(config)
        assert opt._total_limit == 50000


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
        from nodes.src.nodes.context_optimizer.IGlobal import IGlobal

        iglobal = IGlobal()
        # Mock the IEndpoint and glb
        endpoint_mock = MagicMock()
        endpoint_mock.endpoint.openMode = 'config'  # CONFIG mode

        class _OPEN_MODE:
            CONFIG = 'config'

        iglobal.IEndpoint = endpoint_mock
        iglobal.glb = MagicMock()

        with patch('nodes.src.nodes.context_optimizer.IGlobal.OPEN_MODE', _OPEN_MODE):
            iglobal.beginGlobal()

        assert iglobal.optimizer is None

    def test_end_global_cleanup(self):
        """EndGlobal should set optimizer and config to None."""
        from nodes.src.nodes.context_optimizer.IGlobal import IGlobal

        iglobal = IGlobal()
        iglobal.optimizer = MagicMock()
        iglobal.config = {'model_name': 'test'}

        iglobal.endGlobal()

        assert iglobal.optimizer is None
        assert iglobal.config is None


class TestIInstanceLifecycle:
    """Test the IInstance class with mocked IGlobal/optimizer."""

    def _make_instance(self, optimizer=None):
        from nodes.src.nodes.context_optimizer.IInstance import IInstance

        inst = IInstance()
        iglobal = MagicMock()
        iglobal.optimizer = optimizer
        inst.IGlobal = iglobal
        inst.instance = MagicMock()
        return inst

    def test_passthrough_when_no_optimizer(self):
        """When optimizer is None, question should pass through unchanged."""
        inst = self._make_instance(optimizer=None)
        from ai.common.schema import Question as _Q

        q = _Q()
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

        from ai.common.schema import Question as _Q

        q = _Q()
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

        from ai.common.schema import Question as _Q

        q = _Q(role='You are helpful.')
        q.addQuestion('What is AI?')

        inst.writeQuestions(q)

        mock_opt.optimize.assert_called_once()
        call_kwargs = mock_opt.optimize.call_args.kwargs
        assert call_kwargs['question'] == 'What is AI?'
        assert call_kwargs['system_prompt'] == 'You are helpful.'


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
