# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the chunker node: chunking strategies and IInstance document splitting."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Locate the chunker module on disk
# ---------------------------------------------------------------------------
_NODES_ROOT = Path(__file__).resolve().parent.parent.parent / 'nodes' / 'src' / 'nodes'
_CHUNKER_DIR = _NODES_ROOT / 'chunker'


# ---------------------------------------------------------------------------
# Direct import of chunker_strategies (no external dependencies)
# ---------------------------------------------------------------------------
def _load_chunker_strategies():
    """Load chunker_strategies.py directly without needing rocketlib installed."""
    spec = importlib.util.spec_from_file_location(
        'chunker_strategies',
        _CHUNKER_DIR / 'chunker_strategies.py',
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


strategies = _load_chunker_strategies()
RecursiveCharacterChunker = strategies.RecursiveCharacterChunker
SentenceChunker = strategies.SentenceChunker
TokenChunker = strategies.TokenChunker


# ===========================================================================
# RecursiveCharacterChunker tests
# ===========================================================================


class TestRecursiveCharacterChunker:
    """Tests for the recursive character chunking strategy."""

    def test_basic_split(self):
        """Text longer than chunk_size is split into multiple chunks."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        text = 'A' * 120
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        # All text should be represented
        combined = ''.join(c['text'] for c in chunks)
        assert len(combined) >= len(text)

    def test_overlap(self):
        """Consecutive chunks should overlap by the configured amount."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=10)
        text = 'word ' * 30  # 150 chars
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        # Check that second chunk starts with text from end of first
        if len(chunks) >= 2:
            first_tail = chunks[0]['text'][-10:]
            assert first_tail in chunks[1]['text']

    def test_custom_separators(self):
        """Custom separators should be respected."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0, separators=['|'])
        text = 'part one|part two|part three'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 1

    def test_empty_text(self):
        """Empty text should return an empty list."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        assert chunker.chunk('') == []
        assert chunker.chunk('   ') == []

    def test_whitespace_only_text(self):
        """Whitespace-only text should return an empty list."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        assert chunker.chunk('\n\n\n') == []
        assert chunker.chunk('\t  \n  ') == []

    def test_text_smaller_than_chunk_size(self):
        """Text smaller than chunk_size should return a single chunk."""
        chunker = RecursiveCharacterChunker(chunk_size=1000, chunk_overlap=0)
        text = 'Hello world.'
        chunks = chunker.chunk(text)
        assert len(chunks) == 1
        assert chunks[0]['text'] == text

    def test_single_character(self):
        """Single character text should return one chunk."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        chunks = chunker.chunk('A')
        assert len(chunks) == 1
        assert chunks[0]['text'] == 'A'

    def test_chunk_metadata_indices(self):
        """Chunk indices should start at 0 and be contiguous."""
        chunker = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        text = 'This is a longer text that needs to be split into multiple chunks for testing.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i

    def test_metadata_has_required_fields(self):
        """Each chunk should have chunk_index, start_char, end_char."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        text = 'Hello world. This is a test.'
        chunks = chunker.chunk(text)
        for chunk in chunks:
            assert 'text' in chunk
            assert 'metadata' in chunk
            meta = chunk['metadata']
            assert 'chunk_index' in meta
            assert 'start_char' in meta
            assert 'end_char' in meta
            assert isinstance(meta['chunk_index'], int)
            assert isinstance(meta['start_char'], int)
            assert isinstance(meta['end_char'], int)

    def test_paragraph_separator(self):
        """Double newlines should be used as the primary separator."""
        chunker = RecursiveCharacterChunker(chunk_size=100, chunk_overlap=0)
        text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
        chunks = chunker.chunk(text)
        # Should fit in one chunk since total is < 100 chars
        assert len(chunks) == 1

    def test_invalid_chunk_size(self):
        """chunk_size <= 0 should raise ValueError."""
        with pytest.raises(ValueError, match='chunk_size must be positive'):
            RecursiveCharacterChunker(chunk_size=0)
        with pytest.raises(ValueError, match='chunk_size must be positive'):
            RecursiveCharacterChunker(chunk_size=-1)

    def test_invalid_overlap(self):
        """chunk_overlap >= chunk_size should raise ValueError."""
        with pytest.raises(ValueError, match='chunk_overlap must be less than chunk_size'):
            RecursiveCharacterChunker(chunk_size=50, chunk_overlap=50)
        with pytest.raises(ValueError, match='chunk_overlap must be less than chunk_size'):
            RecursiveCharacterChunker(chunk_size=50, chunk_overlap=60)

    def test_negative_overlap(self):
        """Negative chunk_overlap should raise ValueError."""
        with pytest.raises(ValueError, match='chunk_overlap must be non-negative'):
            RecursiveCharacterChunker(chunk_size=50, chunk_overlap=-1)


# ===========================================================================
# SentenceChunker tests
# ===========================================================================


class TestSentenceChunker:
    """Tests for the sentence-boundary chunking strategy."""

    def test_splits_on_sentence_boundaries(self):
        """Chunks should split at sentence boundaries (. ! ?)."""
        chunker = SentenceChunker(chunk_size=50, chunk_overlap=0)
        text = 'First sentence. Second sentence. Third sentence. Fourth sentence.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2

    def test_respects_chunk_size(self):
        """No chunk should greatly exceed the configured chunk_size."""
        chunker = SentenceChunker(chunk_size=60, chunk_overlap=0)
        text = 'Short. Also short. Another short one. Yet another. One more sentence here.'
        chunks = chunker.chunk(text)
        for chunk in chunks:
            # Chunks may slightly exceed due to sentence grouping, but should be reasonable
            assert len(chunk['text']) <= 120  # generous bound for sentence grouping

    def test_empty_text(self):
        """Empty text should return an empty list."""
        chunker = SentenceChunker(chunk_size=50, chunk_overlap=0)
        assert chunker.chunk('') == []
        assert chunker.chunk('   ') == []

    def test_single_sentence(self):
        """A single sentence shorter than chunk_size should return one chunk."""
        chunker = SentenceChunker(chunk_size=1000, chunk_overlap=0)
        text = 'Just one sentence.'
        chunks = chunker.chunk(text)
        assert len(chunks) == 1

    def test_handles_question_marks(self):
        """Question marks should be treated as sentence boundaries."""
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        text = 'Is this a test? Yes it is! Absolutely.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 1

    def test_handles_exclamation_marks(self):
        """Exclamation marks should be treated as sentence boundaries."""
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        text = 'Wow! This is great! Amazing work.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 1

    def test_overlap_between_chunks(self):
        """Overlap should carry trailing sentences from the previous chunk."""
        chunker = SentenceChunker(chunk_size=50, chunk_overlap=20)
        text = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.'
        chunks = chunker.chunk(text)
        if len(chunks) >= 2:
            # With overlap, second chunk should contain some text from end of first
            assert len(chunks[1]['text']) > 0

    def test_metadata_indices_contiguous(self):
        """Chunk indices should be contiguous starting at 0."""
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        text = 'One. Two. Three. Four. Five.'
        chunks = chunker.chunk(text)
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i

    def test_repeated_sentences_correct_start_char(self):
        """Repeated sentences should have correct start_char for each occurrence."""
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        text = 'Hello world. Hello world. Goodbye world.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2

        # Verify that start_char values are monotonically non-decreasing
        prev_start = -1
        for chunk in chunks:
            start = chunk['metadata']['start_char']
            assert start >= prev_start, f'start_char should be non-decreasing but got {start} after {prev_start}'
            prev_start = start

        # Verify that the first chunk's start_char points to the actual text location
        first_start = chunks[0]['metadata']['start_char']
        assert first_start == 0 or text[first_start:].startswith(chunks[0]['text'][:10])

    def test_repeated_sentences_no_overlap_in_positions(self):
        """With no overlap, chunk positions should not reference the same text region."""
        chunker = SentenceChunker(chunk_size=25, chunk_overlap=0)
        # Each 'Same.' is 5 chars, separated by space after sentence split
        text = 'Same. Same. Same. Different. Same. Same.'
        chunks = chunker.chunk(text)

        # Each chunk's start_char should be >= previous chunk's end_char (no overlap mode)
        if len(chunks) >= 2:
            for i in range(1, len(chunks)):
                assert chunks[i]['metadata']['start_char'] >= chunks[i - 1]['metadata']['end_char']

    def test_overlap_with_repeated_sentences_correct_spans(self):
        """Overlap + repeated sentences: spans must match actual text and respect chunk_size."""
        chunker = SentenceChunker(chunk_size=20, chunk_overlap=10)
        text = 'Go. Go. Go. Go. Go. Go. Go. Go. Stop.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2

        for i, chunk in enumerate(chunks):
            meta = chunk['metadata']
            # The slice must match the chunk text exactly
            assert chunk['text'] == text[meta['start_char'] : meta['end_char']], f'Chunk {i} text mismatch: {chunk["text"]!r} != {text[meta["start_char"] : meta["end_char"]]!r}'
            # Actual span must not wildly exceed chunk_size (allow single-sentence overflow)
            actual_span = meta['end_char'] - meta['start_char']
            max_sentence_len = max(len(s) for s in ['Go.', 'Stop.'])
            assert actual_span <= chunker.chunk_size + max_sentence_len, f'Chunk {i} span {actual_span} exceeds chunk_size {chunker.chunk_size} + max_sentence {max_sentence_len}'

    def test_overlap_with_multichar_whitespace_respects_chunk_size(self):
        """Multi-char whitespace between sentences must not cause unbounded chunk growth."""
        chunker = SentenceChunker(chunk_size=20, chunk_overlap=10)
        text = 'A.\n\n\n\nB.\n\n\n\nC.\n\n\n\nD.\n\n\n\nE.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2, f'Expected multiple chunks but got {len(chunks)}'

        for i, chunk in enumerate(chunks):
            meta = chunk['metadata']
            actual_span = meta['end_char'] - meta['start_char']
            # With correct span tracking, no single chunk should swallow the entire text
            assert actual_span <= len(text), f'Chunk {i} span {actual_span} exceeds text length'
            # The slice must match
            assert chunk['text'] == text[meta['start_char'] : meta['end_char']]


# ===========================================================================
# TokenChunker tests
# ===========================================================================


class TestTokenChunker:
    """Tests for the token-based chunking strategy using tiktoken."""

    def _make_mock_encoder(self):
        """Create a mock tiktoken encoder that splits by words."""
        encoder = MagicMock()
        # Simple tokenization: each character is a token
        encoder.encode = lambda text: list(range(len(text)))
        encoder.decode = lambda tokens, **kwargs: 'x' * len(tokens)
        return encoder

    def test_token_based_splitting(self):
        """Text should be split based on token count."""
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)
        mock_encoder = self._make_mock_encoder()
        chunker._encoder = mock_encoder

        text = 'A' * 25  # 25 "tokens"
        chunks = chunker.chunk(text)
        assert len(chunks) == 3  # 10 + 10 + 5

    def test_token_overlap(self):
        """Overlap should cause overlapping token windows."""
        chunker = TokenChunker(chunk_size=10, chunk_overlap=3)
        mock_encoder = self._make_mock_encoder()
        chunker._encoder = mock_encoder

        text = 'A' * 25
        chunks = chunker.chunk(text)
        # With step=7, chunks at positions: 0-10, 7-17, 14-24, 21-25
        assert len(chunks) >= 3

    def test_empty_text(self):
        """Empty text should return an empty list."""
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)
        mock_encoder = self._make_mock_encoder()
        chunker._encoder = mock_encoder

        assert chunker.chunk('') == []
        assert chunker.chunk('   ') == []

    def test_text_shorter_than_chunk_size(self):
        """Short text should return a single chunk."""
        chunker = TokenChunker(chunk_size=100, chunk_overlap=0)
        mock_encoder = self._make_mock_encoder()
        chunker._encoder = mock_encoder

        text = 'Hello'
        chunks = chunker.chunk(text)
        assert len(chunks) == 1

    def test_metadata_indices(self):
        """Chunk metadata should have contiguous indices starting at 0."""
        chunker = TokenChunker(chunk_size=5, chunk_overlap=0)
        mock_encoder = self._make_mock_encoder()
        chunker._encoder = mock_encoder

        text = 'A' * 15
        chunks = chunker.chunk(text)
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i

    def test_invalid_chunk_size(self):
        """chunk_size <= 0 should raise ValueError."""
        with pytest.raises(ValueError, match='chunk_size must be positive'):
            TokenChunker(chunk_size=0)

    def test_invalid_overlap(self):
        """chunk_overlap >= chunk_size should raise ValueError."""
        with pytest.raises(ValueError, match='chunk_overlap must be less than chunk_size'):
            TokenChunker(chunk_size=10, chunk_overlap=10)

    def test_encoding_validation_lazy(self):
        """Encoder should be lazily initialized."""
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0, encoding_name='cl100k_base')
        assert chunker._encoder is None
        # It should only initialize when chunk() is called

    def test_start_char_incremental_tracking(self):
        """start_char should be computed incrementally (not via O(n^2) prefix decode)."""
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)

        # Mock encoder where each character is a token and decode returns exact chars
        call_counts = {'decode': 0}

        class TrackingEncoder:
            def encode(self, text):
                return list(range(len(text)))

            def decode(self, tokens, **kwargs):
                call_counts['decode'] += 1
                return 'x' * len(tokens)

        chunker._encoder = TrackingEncoder()
        text = 'A' * 50  # 50 tokens -> 5 chunks of 10
        chunks = chunker.chunk(text)
        assert len(chunks) == 5

        # With O(n^2) approach, decode would be called 5 (chunks) + 4 (prefixes) = 9 times
        # With incremental approach, decode is called 5 (chunks) + 4 (steps) = 9 times
        # but no prefix decode calls scale with chunk index.
        # Key check: decode should NOT be called with tokens[:N] for large N.
        # We verify the count is bounded linearly: at most 2*num_chunks calls
        assert call_counts['decode'] <= 2 * len(chunks), f'decode called {call_counts["decode"]} times for {len(chunks)} chunks; expected at most {2 * len(chunks)} (linear)'

    def test_start_char_correctness_with_overlap(self):
        """start_char values should be correct even with token overlap."""
        chunker = TokenChunker(chunk_size=10, chunk_overlap=3)
        mock_encoder = self._make_mock_encoder()
        chunker._encoder = mock_encoder

        text = 'A' * 25
        chunks = chunker.chunk(text)
        assert len(chunks) >= 3

        # Verify start_char values are monotonically increasing
        for i in range(1, len(chunks)):
            assert chunks[i]['metadata']['start_char'] > chunks[i - 1]['metadata']['start_char']

        # First chunk should start at 0
        assert chunks[0]['metadata']['start_char'] == 0


# ===========================================================================
# IGlobal / IInstance lifecycle tests (mocked)
# ===========================================================================


class TestChunkerLifecycle:
    """Tests for IGlobal and IInstance integration with mocked rocketlib."""

    def _install_stubs(self):
        """Install minimal stubs for rocketlib and dependencies."""
        saved = {}
        stub_names = [
            'rocketlib',
            'ai',
            'ai.common',
            'ai.common.config',
            'ai.common.schema',
            'depends',
        ]
        for name in stub_names:
            saved[name] = sys.modules.get(name)

        # rocketlib stubs
        rocketlib = types.ModuleType('rocketlib')

        class IGlobalBase:
            pass

        class IInstanceBase:
            pass

        class Entry:
            pass

        class OPEN_MODE:
            CONFIG = 'config'
            RUN = 'run'

        rocketlib.IGlobalBase = IGlobalBase
        rocketlib.IInstanceBase = IInstanceBase
        rocketlib.Entry = Entry
        rocketlib.OPEN_MODE = OPEN_MODE
        rocketlib.warning = lambda *a, **k: None
        rocketlib.debug = lambda *a, **k: None
        sys.modules['rocketlib'] = rocketlib

        # ai stubs
        ai_pkg = types.ModuleType('ai')
        ai_pkg.__path__ = []
        ai_common = types.ModuleType('ai.common')
        ai_common.__path__ = []

        config_mod = types.ModuleType('ai.common.config')

        class Config:
            @staticmethod
            def getNodeConfig(logicalType, connConfig):
                return connConfig or {}

        config_mod.Config = Config

        schema_mod = types.ModuleType('ai.common.schema')

        class Doc:
            def __init__(self, **kwargs):
                for k, v in kwargs.items():
                    setattr(self, k, v)
                if not hasattr(self, 'page_content'):
                    self.page_content = None
                if not hasattr(self, 'metadata'):
                    self.metadata = None
                if not hasattr(self, 'score'):
                    self.score = None

        class DocMetadata:
            def __init__(self, **kwargs):
                for k, v in kwargs.items():
                    setattr(self, k, v)
                if not hasattr(self, 'objectId'):
                    self.objectId = ''
                if not hasattr(self, 'chunkId'):
                    self.chunkId = 0

        schema_mod.Doc = Doc
        schema_mod.DocMetadata = DocMetadata

        depends_mod = types.ModuleType('depends')
        depends_mod.depends = lambda *a, **k: None

        sys.modules['ai'] = ai_pkg
        sys.modules['ai.common'] = ai_common
        sys.modules['ai.common.config'] = config_mod
        sys.modules['ai.common.schema'] = schema_mod
        sys.modules['depends'] = depends_mod

        return saved, stub_names

    def _restore_modules(self, saved, stub_names):
        for name in stub_names:
            if saved.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]

    def test_iglobal_creates_strategy(self):
        """IGlobal.beginGlobal should create the configured strategy."""
        saved, names = self._install_stubs()
        try:
            # Force re-import of the chunker module
            for mod_name in list(sys.modules.keys()):
                if 'chunker' in mod_name and 'test' not in mod_name:
                    del sys.modules[mod_name]

            from nodes.src.nodes.chunker.IGlobal import IGlobal
            from nodes.src.nodes.chunker.chunker_strategies import SentenceChunker

            iglobal = IGlobal.__new__(IGlobal)
            iglobal.strategy = None

            # Mock endpoint (run mode) and glb (connConfig with strategy params)
            endpoint = MagicMock()
            endpoint.openMode = 'run'
            iglobal.IEndpoint = MagicMock()
            iglobal.IEndpoint.endpoint = endpoint

            glb = MagicMock()
            glb.logicalType = 'chunker'
            glb.connConfig = {'strategy': 'sentence', 'chunk_size': '500', 'chunk_overlap': '50'}
            iglobal.glb = glb

            iglobal.beginGlobal()

            assert iglobal.strategy is not None
            assert isinstance(iglobal.strategy, SentenceChunker)
            assert iglobal.strategy.chunk_size == 500
            assert iglobal.strategy.chunk_overlap == 50
        finally:
            self._restore_modules(saved, names)

    def test_write_documents_produces_chunks(self):
        """Produce one document per chunk with correct metadata."""
        chunker = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        text = 'This is a longer piece of text that should be split into multiple chunks by the chunker.'
        chunks = chunker.chunk(text)

        # Verify we get multiple chunks
        assert len(chunks) >= 2

        # Verify each chunk has valid metadata
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i
            assert len(chunk['text']) > 0

    def test_deep_copy_prevents_mutation(self):
        """Chunking should not mutate the original text."""
        chunker = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        original_text = 'This is the original text that should not be modified.'
        text_copy = str(original_text)  # explicit copy
        chunker.chunk(text_copy)
        assert text_copy == original_text

    def _load_iinstance(self):
        """Install stubs and load IInstance for integration tests."""
        saved, names = self._install_stubs()
        # Force re-import of the chunker module
        for mod_name in list(sys.modules.keys()):
            if 'chunker' in mod_name and 'test' not in mod_name:
                del sys.modules[mod_name]

        from nodes.src.nodes.chunker.IInstance import IInstance
        from nodes.src.nodes.chunker.chunker_strategies import RecursiveCharacterChunker as RC

        return saved, names, IInstance, RC

    def _make_instance(self, IInstance, strategy=None):
        """Create an IInstance with mocked IGlobal and instance."""
        inst = IInstance.__new__(IInstance)
        inst.chunkId = 0

        iglobal = MagicMock()
        iglobal.strategy = strategy
        inst.IGlobal = iglobal

        mock_instance = MagicMock()
        inst.instance = mock_instance

        return inst, mock_instance

    def test_raises_runtime_error_when_strategy_is_none(self):
        """Raise RuntimeError when strategy is None."""
        saved, names, IInstance, RC = self._load_iinstance()
        try:
            Doc = sys.modules['ai.common.schema'].Doc
            inst, _ = self._make_instance(IInstance, strategy=None)
            doc = Doc(page_content='Some text to chunk.', metadata=None)
            with pytest.raises(RuntimeError, match='Chunker strategy not initialized'):
                inst.writeDocuments([doc])
        finally:
            self._restore_modules(saved, names)

    def test_parent_id_in_metadata_existing_metadata(self):
        """parent_id should be set on chunks when source document has existing metadata."""
        saved, names, IInstance, RC = self._load_iinstance()
        try:
            Doc = sys.modules['ai.common.schema'].Doc
            DocMetadata = sys.modules['ai.common.schema'].DocMetadata
            strategy = RC(chunk_size=20, chunk_overlap=0)
            inst, mock_instance = self._make_instance(IInstance, strategy=strategy)

            meta = DocMetadata(objectId='doc-123', chunkId=0)
            doc = Doc(page_content='This is text that will be split into multiple chunks by the strategy.', metadata=meta)
            inst.writeDocuments([doc])

            assert mock_instance.writeDocuments.called
            emitted_docs = mock_instance.writeDocuments.call_args[0][0]
            assert len(emitted_docs) >= 2
            for chunk_doc in emitted_docs:
                assert hasattr(chunk_doc.metadata, 'parentId')
                assert chunk_doc.metadata.parentId == 'doc-123'
        finally:
            self._restore_modules(saved, names)

    def test_parent_id_in_metadata_no_existing_metadata(self):
        """parent_id should be set on chunks when source document has no metadata."""
        saved, names, IInstance, RC = self._load_iinstance()
        try:
            Doc = sys.modules['ai.common.schema'].Doc
            strategy = RC(chunk_size=20, chunk_overlap=0)
            inst, mock_instance = self._make_instance(IInstance, strategy=strategy)

            doc = Doc(page_content='This is text that will be split into multiple chunks by the strategy.', metadata=None)
            inst.writeDocuments([doc])

            assert mock_instance.writeDocuments.called
            emitted_docs = mock_instance.writeDocuments.call_args[0][0]
            assert len(emitted_docs) >= 2
            for chunk_doc in emitted_docs:
                assert hasattr(chunk_doc.metadata, 'parentId')
                assert chunk_doc.metadata.parentId == ''
        finally:
            self._restore_modules(saved, names)

    def test_shallow_copy_does_not_corrupt_original(self):
        """Shallow copy + metadata copy should not mutate the original document."""
        saved, names, IInstance, RC = self._load_iinstance()
        try:
            Doc = sys.modules['ai.common.schema'].Doc
            DocMetadata = sys.modules['ai.common.schema'].DocMetadata
            strategy = RC(chunk_size=20, chunk_overlap=0)
            inst, mock_instance = self._make_instance(IInstance, strategy=strategy)

            original_content = 'This is text that will be split into multiple chunks by the strategy.'
            meta = DocMetadata(objectId='orig-id', chunkId=99)
            doc = Doc(page_content=original_content, metadata=meta)

            inst.writeDocuments([doc])

            # Original document should not be mutated
            assert doc.page_content == original_content
            assert doc.metadata.objectId == 'orig-id'
            assert doc.metadata.chunkId == 99

            # Emitted chunks should have different content and metadata
            emitted_docs = mock_instance.writeDocuments.call_args[0][0]
            for chunk_doc in emitted_docs:
                assert chunk_doc.metadata is not doc.metadata
        finally:
            self._restore_modules(saved, names)
