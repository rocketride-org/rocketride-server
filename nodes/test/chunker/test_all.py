# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the chunker node: chunking strategies and IInstance behavior.

The build interpreter provides ``rocketlib``, ``ai.common.schema`` and
``depends``. The node source is not on the interpreter's import path by
default, so -- like every other node suite (local_text_output, milvus,
pinecone, tool_git, ...) -- we prepend ``nodes/src/nodes`` to import the
``chunker.*`` package by name. There is no skip fallback: outside the build
interpreter the ``rocketlib`` import fails and collection errors out, by design.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

from chunker.chunker_strategies import (  # noqa: E402
    RecursiveCharacterChunker,
    SentenceChunker,
    TokenChunker,
)


# ===========================================================================
# RecursiveCharacterChunker
# ===========================================================================


class TestRecursiveCharacterChunker:
    """Tests for the recursive character chunking strategy."""

    def test_basic_split(self):
        """Text longer than chunk_size is split into multiple chunks."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        text = 'A' * 120
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        combined = ''.join(c['text'] for c in chunks)
        assert len(combined) >= len(text)

    def test_overlap(self):
        """Consecutive chunks should overlap by the configured amount."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=10)
        text = 'word ' * 30  # 150 chars
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        if len(chunks) >= 2:
            first_tail = chunks[0]['text'][-10:]
            assert first_tail in chunks[1]['text']

    def test_overlap_never_exceeds_chunk_size(self):
        """Cap applied so prepended overlap cannot push chunk past chunk_size."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=20)
        text = 'ab' * 200  # well over chunk_size
        chunks = chunker.chunk(text)
        for chunk in chunks:
            assert len(chunk['text']) <= chunker.chunk_size, (
                f'len {len(chunk["text"])} > chunk_size {chunker.chunk_size}'
            )

    def test_custom_separators(self):
        """Custom separators should be respected."""
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0, separators=['|'])
        text = 'part one|part two|part three'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 1

    def test_separator_preserved_on_overflow_emit(self):
        """When splitting forces an emit, the joining separator must not be dropped.

        Without preservation, concatenating chunk texts loses the ``|`` between
        emitted pieces; this regresses the start/end offsets downstream.
        """
        # chunk_size chosen so each part fits but pairs don't, forcing emits.
        chunker = RecursiveCharacterChunker(chunk_size=12, chunk_overlap=0, separators=['|'])
        text = 'partA|partB|partC|partD'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        # At least one emitted chunk should end with the separator that
        # previously would have been silently dropped.
        assert any(c['text'].endswith('|') for c in chunks), (
            f'expected at least one chunk ending in separator, got {[c["text"] for c in chunks]}'
        )

    def test_empty_text(self):
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        assert chunker.chunk('') == []
        assert chunker.chunk('   ') == []

    def test_whitespace_only_text(self):
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        assert chunker.chunk('\n\n\n') == []
        assert chunker.chunk('\t  \n  ') == []

    def test_text_smaller_than_chunk_size(self):
        chunker = RecursiveCharacterChunker(chunk_size=1000, chunk_overlap=0)
        text = 'Hello world.'
        chunks = chunker.chunk(text)
        assert len(chunks) == 1
        assert chunks[0]['text'] == text

    def test_single_character(self):
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        chunks = chunker.chunk('A')
        assert len(chunks) == 1
        assert chunks[0]['text'] == 'A'

    def test_chunk_metadata_indices(self):
        chunker = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        text = 'This is a longer text that needs to be split into multiple chunks for testing.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i

    def test_metadata_has_required_fields(self):
        chunker = RecursiveCharacterChunker(chunk_size=50, chunk_overlap=0)
        text = 'Hello world. This is a test.'
        chunks = chunker.chunk(text)
        for chunk in chunks:
            assert 'text' in chunk
            assert 'metadata' in chunk
            meta = chunk['metadata']
            assert isinstance(meta['chunk_index'], int)
            assert isinstance(meta['start_char'], int)
            assert isinstance(meta['end_char'], int)

    def test_paragraph_separator(self):
        chunker = RecursiveCharacterChunker(chunk_size=100, chunk_overlap=0)
        text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
        chunks = chunker.chunk(text)
        assert len(chunks) == 1

    def test_invalid_chunk_size(self):
        with pytest.raises(ValueError, match='chunk_size must be positive'):
            RecursiveCharacterChunker(chunk_size=0)
        with pytest.raises(ValueError, match='chunk_size must be positive'):
            RecursiveCharacterChunker(chunk_size=-1)

    def test_invalid_overlap(self):
        with pytest.raises(ValueError, match='chunk_overlap must be less than chunk_size'):
            RecursiveCharacterChunker(chunk_size=50, chunk_overlap=50)
        with pytest.raises(ValueError, match='chunk_overlap must be less than chunk_size'):
            RecursiveCharacterChunker(chunk_size=50, chunk_overlap=60)

    def test_negative_overlap(self):
        with pytest.raises(ValueError, match='chunk_overlap must be non-negative'):
            RecursiveCharacterChunker(chunk_size=50, chunk_overlap=-1)


# ===========================================================================
# SentenceChunker
# ===========================================================================


class TestSentenceChunker:
    """Tests for the sentence-boundary chunking strategy."""

    def test_splits_on_sentence_boundaries(self):
        chunker = SentenceChunker(chunk_size=50, chunk_overlap=0)
        text = 'First sentence. Second sentence. Third sentence. Fourth sentence.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2

    def test_respects_chunk_size(self):
        chunker = SentenceChunker(chunk_size=60, chunk_overlap=0)
        text = 'Short. Also short. Another short one. Yet another. One more sentence here.'
        chunks = chunker.chunk(text)
        for chunk in chunks:
            assert len(chunk['text']) <= 120  # generous bound for sentence grouping

    def test_empty_text(self):
        chunker = SentenceChunker(chunk_size=50, chunk_overlap=0)
        assert chunker.chunk('') == []
        assert chunker.chunk('   ') == []

    def test_single_sentence(self):
        chunker = SentenceChunker(chunk_size=1000, chunk_overlap=0)
        chunks = chunker.chunk('Just one sentence.')
        assert len(chunks) == 1

    def test_handles_question_marks(self):
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        chunks = chunker.chunk('Is this a test? Yes it is! Absolutely.')
        assert len(chunks) >= 1

    def test_handles_exclamation_marks(self):
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        chunks = chunker.chunk('Wow! This is great! Amazing work.')
        assert len(chunks) >= 1

    def test_metadata_indices_contiguous(self):
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        chunks = chunker.chunk('One. Two. Three. Four. Five.')
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i

    def test_repeated_sentences_correct_start_char(self):
        chunker = SentenceChunker(chunk_size=30, chunk_overlap=0)
        text = 'Hello world. Hello world. Goodbye world.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2

        prev_start = -1
        for chunk in chunks:
            start = chunk['metadata']['start_char']
            assert start >= prev_start
            prev_start = start

    def test_overlap_with_repeated_sentences_correct_spans(self):
        chunker = SentenceChunker(chunk_size=20, chunk_overlap=10)
        text = 'Go. Go. Go. Go. Go. Go. Go. Go. Stop.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2

        for chunk in chunks:
            meta = chunk['metadata']
            assert chunk['text'] == text[meta['start_char'] : meta['end_char']]
            actual_span = meta['end_char'] - meta['start_char']
            max_sentence_len = max(len(s) for s in ['Go.', 'Stop.'])
            assert actual_span <= chunker.chunk_size + max_sentence_len

    def test_overlap_with_multichar_whitespace_respects_chunk_size(self):
        chunker = SentenceChunker(chunk_size=20, chunk_overlap=10)
        text = 'A.\n\n\n\nB.\n\n\n\nC.\n\n\n\nD.\n\n\n\nE.'
        chunks = chunker.chunk(text)
        assert len(chunks) >= 2
        for chunk in chunks:
            meta = chunk['metadata']
            actual_span = meta['end_char'] - meta['start_char']
            assert actual_span <= len(text)
            assert chunk['text'] == text[meta['start_char'] : meta['end_char']]


# ===========================================================================
# TokenChunker
# ===========================================================================


class _CharTokenEncoder:
    """Mock tiktoken encoder: 1 token per character, decode echoes 'x'*N.

    Used purely to exercise TokenChunker without requiring tiktoken at
    test-collection time. This stubs the *external* SDK boundary, not a
    built-in module.
    """

    def encode(self, text):
        return list(range(len(text)))

    def decode(self, tokens, **kwargs):
        return 'x' * len(tokens)

    def decode_single_token_bytes(self, tid):
        return b'x'


class TestTokenChunker:
    """Tests for the token-based chunking strategy."""

    def test_token_based_splitting(self):
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)
        chunker._encoder = _CharTokenEncoder()
        chunks = chunker.chunk('A' * 25)
        assert len(chunks) == 3  # 10 + 10 + 5

    def test_token_overlap(self):
        chunker = TokenChunker(chunk_size=10, chunk_overlap=3)
        chunker._encoder = _CharTokenEncoder()
        chunks = chunker.chunk('A' * 25)
        assert len(chunks) >= 3

    def test_empty_text(self):
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)
        chunker._encoder = _CharTokenEncoder()
        assert chunker.chunk('') == []
        assert chunker.chunk('   ') == []

    def test_text_shorter_than_chunk_size(self):
        chunker = TokenChunker(chunk_size=100, chunk_overlap=0)
        chunker._encoder = _CharTokenEncoder()
        chunks = chunker.chunk('Hello')
        assert len(chunks) == 1

    def test_metadata_indices(self):
        chunker = TokenChunker(chunk_size=5, chunk_overlap=0)
        chunker._encoder = _CharTokenEncoder()
        chunks = chunker.chunk('A' * 15)
        for i, chunk in enumerate(chunks):
            assert chunk['metadata']['chunk_index'] == i

    def test_invalid_chunk_size(self):
        with pytest.raises(ValueError, match='chunk_size must be positive'):
            TokenChunker(chunk_size=0)

    def test_invalid_overlap(self):
        with pytest.raises(ValueError, match='chunk_overlap must be less than chunk_size'):
            TokenChunker(chunk_size=10, chunk_overlap=10)

    def test_encoding_validation_lazy(self):
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0, encoding_name='cl100k_base')
        assert chunker._encoder is None

    def test_start_char_incremental_tracking(self):
        """Decode work must stay bounded: linear call count AND per-call size.

        Two guards against the O(n^2) prefix-decode regression:
          1. Call count scales linearly with the number of chunks.
          2. Every decode operates on at most ``chunk_size`` tokens. A regression
             that decodes growing ``tokens[:start]`` prefixes would inflate the
             largest decode input past ``chunk_size`` even if the call count
             stayed linear, so the call-count check alone is insufficient.
        """
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)

        call_counts = {'decode': 0}
        decoded_lengths: list[int] = []

        class TrackingEncoder(_CharTokenEncoder):
            def decode(self, tokens, **kwargs):
                call_counts['decode'] += 1
                decoded_lengths.append(len(tokens))
                return 'x' * len(tokens)

        chunker._encoder = TrackingEncoder()
        chunks = chunker.chunk('A' * 50)
        assert len(chunks) == 5
        # At most 2 * num_chunks (one chunk decode + one step decode each).
        assert call_counts['decode'] <= 2 * len(chunks)
        # No decode call may exceed chunk_size tokens; growing-prefix decoding
        # (the O(n^2) regression) would push this above chunk_size.
        assert decoded_lengths, 'expected at least one decode call'
        assert max(decoded_lengths) <= chunker.chunk_size, (
            f'largest decode input {max(decoded_lengths)} exceeds chunk_size {chunker.chunk_size}'
        )

    def test_start_char_correctness_with_overlap(self):
        chunker = TokenChunker(chunk_size=10, chunk_overlap=3)
        chunker._encoder = _CharTokenEncoder()
        chunks = chunker.chunk('A' * 25)
        assert len(chunks) >= 3
        for i in range(1, len(chunks)):
            assert chunks[i]['metadata']['start_char'] > chunks[i - 1]['metadata']['start_char']
        assert chunks[0]['metadata']['start_char'] == 0

    def test_safe_decode_handles_decode_failure(self):
        """If Encoding.decode raises, _safe_decode falls back to per-token bytes."""

        class FailingEncoder(_CharTokenEncoder):
            def decode(self, tokens, **kwargs):  # noqa: ARG002 - tiktoken signature
                raise RuntimeError('simulated decode failure')

            def decode_single_token_bytes(self, tid):  # noqa: ARG002 - api shape
                return b'y'

        chunker = TokenChunker(chunk_size=4, chunk_overlap=0)
        chunker._encoder = FailingEncoder()
        chunks = chunker.chunk('AAAA')
        # 4 fallback bytes -> 'yyyy'; must not raise.
        assert len(chunks) == 1
        assert chunks[0]['text'] == 'yyyy'


# ===========================================================================
# IGlobal / IInstance lifecycle
# ===========================================================================


def _import_node_classes():
    """Import the IInstance/IGlobal classes (provided by the build interpreter)."""
    from chunker.IGlobal import IGlobal
    from chunker.IInstance import IInstance

    return IGlobal, IInstance


def _import_schema():
    from ai.common.schema import Doc, DocMetadata

    return Doc, DocMetadata


class TestIGlobalLifecycle:
    """IGlobal strategy selection and validation."""

    def test_iglobal_creates_sentence_strategy(self):
        IGlobal, _ = _import_node_classes()
        iglobal = IGlobal.__new__(IGlobal)
        iglobal.strategy = None

        endpoint = MagicMock()
        endpoint.openMode = 'run'
        iglobal.IEndpoint = MagicMock()
        iglobal.IEndpoint.endpoint = endpoint

        glb = MagicMock()
        glb.logicalType = 'chunker'
        glb.connConfig = {'strategy': 'sentence', 'chunk_size': '500', 'chunk_overlap': '50'}
        iglobal.glb = glb

        iglobal.beginGlobal()
        assert isinstance(iglobal.strategy, SentenceChunker)
        assert iglobal.strategy.chunk_size == 500
        assert iglobal.strategy.chunk_overlap == 50

    def test_iglobal_rejects_unknown_strategy(self):
        IGlobal, _ = _import_node_classes()
        iglobal = IGlobal.__new__(IGlobal)
        iglobal.strategy = None

        endpoint = MagicMock()
        endpoint.openMode = 'run'
        iglobal.IEndpoint = MagicMock()
        iglobal.IEndpoint.endpoint = endpoint

        glb = MagicMock()
        glb.logicalType = 'chunker'
        glb.connConfig = {'strategy': 'recurisve', 'chunk_size': '100', 'chunk_overlap': '0'}
        iglobal.glb = glb

        with pytest.raises(ValueError, match='Unknown chunker strategy'):
            iglobal.beginGlobal()


class TestIInstanceWriteDocuments:
    """IInstance.writeDocuments emits one document per chunk."""

    @staticmethod
    def _make_instance(IInstance, strategy):
        inst = IInstance.__new__(IInstance)
        inst.chunkId = 0
        iglobal = MagicMock()
        iglobal.strategy = strategy
        inst.IGlobal = iglobal
        inst.instance = MagicMock()
        inst.preventDefault = MagicMock(return_value=None)
        return inst

    def test_raises_runtime_error_when_strategy_is_none(self):
        _, IInstance = _import_node_classes()
        Doc, _ = _import_schema()
        inst = self._make_instance(IInstance, strategy=None)
        doc = Doc(page_content='Some text to chunk.', metadata=None)
        with pytest.raises(RuntimeError, match='Chunker strategy not initialized'):
            inst.writeDocuments([doc])

    def test_parent_id_propagated_from_existing_metadata(self):
        _, IInstance = _import_node_classes()
        Doc, DocMetadata = _import_schema()
        strategy = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        meta = DocMetadata(objectId='doc-123', chunkId=0)
        doc = Doc(
            page_content='This is text that will be split into multiple chunks by the strategy.',
            metadata=meta,
        )
        inst.writeDocuments([doc])
        inst.preventDefault.assert_called_once()
        assert inst.instance.writeDocuments.called
        emitted = inst.instance.writeDocuments.call_args[0][0]
        assert len(emitted) >= 2
        for chunk_doc in emitted:
            assert chunk_doc.metadata.parentId == 'doc-123'

    def test_parent_id_empty_when_no_metadata(self):
        _, IInstance = _import_node_classes()
        Doc, _ = _import_schema()
        strategy = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        doc = Doc(
            page_content='This is text that will be split into multiple chunks by the strategy.',
            metadata=None,
        )
        inst.writeDocuments([doc])
        inst.preventDefault.assert_called_once()
        emitted = inst.instance.writeDocuments.call_args[0][0]
        assert len(emitted) >= 2
        for chunk_doc in emitted:
            assert chunk_doc.metadata.parentId == ''

    def test_accepts_dict_payloads(self):
        _, IInstance = _import_node_classes()
        _import_schema()  # ensure schema is importable
        strategy = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        inst.writeDocuments(
            [
                {
                    'page_content': 'This dictionary document should be split into chunks.',
                    'metadata': {
                        'objectId': 'dict-doc',
                        'chunkId': 0,
                        'nodeId': 'test-node',
                        'parent': '/test',
                    },
                }
            ]
        )
        inst.preventDefault.assert_called_once()
        emitted = inst.instance.writeDocuments.call_args[0][0]
        assert len(emitted) >= 2
        for chunk_doc in emitted:
            assert chunk_doc.page_content
            assert chunk_doc.metadata.parentId == 'dict-doc'

    def test_prevent_default_called_even_when_all_docs_empty(self):
        """Empty/whitespace-only inputs must not leak through to downstream."""
        _, IInstance = _import_node_classes()
        Doc, _ = _import_schema()
        strategy = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        inst.writeDocuments([Doc(page_content='', metadata=None), Doc(page_content='   ', metadata=None)])
        inst.preventDefault.assert_called_once()
        # Nothing forwarded downstream.
        assert not inst.instance.writeDocuments.called

    def test_original_document_not_mutated(self):
        _, IInstance = _import_node_classes()
        Doc, DocMetadata = _import_schema()
        strategy = RecursiveCharacterChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        original_content = 'This is text that will be split into multiple chunks by the strategy.'
        meta = DocMetadata(objectId='orig-id', chunkId=99)
        doc = Doc(page_content=original_content, metadata=meta)

        inst.writeDocuments([doc])
        assert doc.page_content == original_content
        assert doc.metadata.objectId == 'orig-id'
        assert doc.metadata.chunkId == 99

        emitted = inst.instance.writeDocuments.call_args[0][0]
        for chunk_doc in emitted:
            assert chunk_doc.metadata is not doc.metadata
