# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the chunker node: chunking strategies and IInstance behavior.

The build interpreter provides ``rocketlib``, ``ai.common.schema`` and
``depends``. The node source is not on the interpreter's import path by
default, so -- like every other node suite (local_text_output, store_milvus,
store_pinecone, tool_git, ...) -- we prepend ``nodes/src/nodes`` to import the
``chunker.*`` package by name. There is no skip fallback: outside the build
interpreter the ``rocketlib`` import fails and collection errors out, by design.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODES_SRC = str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes')
# Force the node source to the FRONT of sys.path: this test directory is itself
# importable as ``chunker`` (it has an ``__init__.py``), so unless the real node
# package is searched first the test dir shadows it and breaks
# ``from chunker.chunker_strategies import ...``. A plain "if not in sys.path"
# guard is insufficient -- another node suite may already have added the path
# *behind* this test dir, letting the test dir win.
while _NODES_SRC in sys.path:
    sys.path.remove(_NODES_SRC)
sys.path.insert(0, _NODES_SRC)

from chunker.chunker_strategies import (  # noqa: E402
    SentenceChunker,
    TokenChunker,
)


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

    def test_unpunctuated_input_is_emitted_whole(self):
        """Pin the documented cost of making 'sentence' the default strategy.

        A sentence is indivisible here, so chunk_size is a grouping target and
        not a hard cap. Input with no sentence-ending punctuation (log lines,
        CSV rows, OCR dumps) has no boundary to group on and comes back as one
        oversized chunk. The README routes those inputs to the token strategy;
        this test exists so the trade-off is explicit rather than a surprise.
        """
        chunker = SentenceChunker(chunk_size=100, chunk_overlap=0)
        text = 'word ' * 400  # 2000 chars, no '.', '!' or '?'
        chunks = chunker.chunk(text)
        assert len(chunks) == 1
        assert len(chunks[0]['text']) > chunker.chunk_size

        # The token strategy is the documented escape hatch: it caps hard.
        token_chunker = TokenChunker(chunk_size=100, chunk_overlap=0)
        token_chunker._encoder = _CharTokenEncoder()
        token_chunks = token_chunker.chunk(text)
        assert len(token_chunks) > 1
        assert all(len(c['text']) <= 100 for c in token_chunks)

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
    """Mock tiktoken encoder with one UTF-8-safe token per character.

    Used purely to exercise TokenChunker without requiring tiktoken at
    test-collection time. This stubs the *external* SDK boundary, not a
    built-in module.
    """

    def encode(self, text):
        return [ord(character) for character in text]

    def decode(self, tokens, **kwargs):
        return ''.join(chr(token) for token in tokens)

    def decode_single_token_bytes(self, tid):
        return chr(tid).encode('utf-8')


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

    @pytest.mark.parametrize(
        'text',
        [
            ' a' * 511 + '😀 café 中文',
            'a ' * 460 + 'x😀' + ' b' * 100,
        ],
    )
    def test_real_tokenizer_default_window_preserves_unicode_and_offsets(self, text):
        """A default-size token boundary must never split one Unicode scalar."""
        chunker = TokenChunker()

        chunks = chunker.chunk(text)

        assert len(chunks) >= 2
        assert chunks[0]['metadata']['end_char'] < len(text)
        assert chunks[-1]['metadata']['end_char'] == len(text)
        for chunk in chunks:
            metadata = chunk['metadata']
            assert chunk['text'] == text[metadata['start_char'] : metadata['end_char']]
            assert '\ufffd' not in chunk['text']
            assert len(chunker._encoder.encode(chunk['text'])) <= chunker.chunk_size
        for previous, current in zip(chunks, chunks[1:]):
            assert current['metadata']['start_char'] <= previous['metadata']['end_char']

    def test_real_tokenizer_rejects_chunk_size_too_small_for_unicode_scalar(self):
        chunker = TokenChunker(chunk_size=1, chunk_overlap=0)

        with pytest.raises(ValueError, match='complete Unicode character'):
            chunker.chunk('😀')

    @pytest.mark.parametrize(
        ('encoding_name', 'split_character'),
        [
            ('cl100k_base', '😀'),
            ('o200k_base', '🫠'),
            ('p50k_base', '文'),
            ('r50k_base', '文'),
        ],
    )
    def test_real_tokenizer_zero_overlap_reconstructs_all_encodings(self, encoding_name, split_character):
        sizing_chunker = TokenChunker(encoding_name=encoding_name)
        encoder = sizing_chunker._get_encoder()
        chunk_size = len(encoder.encode(split_character))
        chunker = TokenChunker(chunk_size=chunk_size, chunk_overlap=0, encoding_name=encoding_name)
        text = f'{split_character}a{split_character}b{split_character}'

        chunks = chunker.chunk(text)

        assert ''.join(chunk['text'] for chunk in chunks) == text
        assert all(len(encoder.encode(chunk['text'])) <= chunk_size for chunk in chunks)

    @pytest.mark.parametrize(
        ('encoding_name', 'chunk_size', 'text'),
        [
            ('cl100k_base', 2, ' 好'),
            ('o200k_base', 2, ' 騌'),
            ('p50k_base', 3, '羶憄'),
            ('r50k_base', 3, '鄶森'),
        ],
    )
    def test_real_tokenizer_handles_merges_crossing_character_boundaries(self, encoding_name, chunk_size, text):
        chunker = TokenChunker(chunk_size=chunk_size, chunk_overlap=0, encoding_name=encoding_name)

        chunks = chunker.chunk(text)

        assert ''.join(chunk['text'] for chunk in chunks) == text
        assert all(len(chunker._encoder.encode(chunk['text'])) <= chunk_size for chunk in chunks)

    @pytest.mark.parametrize('encoding_name', ['p50k_base', 'r50k_base'])
    def test_real_tokenizer_default_size_handles_long_unsafe_token_span(self, encoding_name):
        chunker = TokenChunker(encoding_name=encoding_name)
        text = '怶' * 600

        chunks = chunker.chunk(text)

        assert chunks[0]['metadata']['start_char'] == 0
        assert chunks[-1]['metadata']['end_char'] == len(text)
        for chunk in chunks:
            metadata = chunk['metadata']
            assert chunk['text'] == text[metadata['start_char'] : metadata['end_char']]
            assert len(chunker._encoder.encode(chunk['text'])) <= chunker.chunk_size
        for previous, current in zip(chunks, chunks[1:]):
            assert current['metadata']['start_char'] <= previous['metadata']['end_char']

    def test_real_tokenizer_preserves_literal_replacement_character(self):
        chunker = TokenChunker(chunk_size=4, chunk_overlap=1)
        text = 'A\ufffdB A\ufffdB A\ufffdB'

        chunks = chunker.chunk(text)

        assert chunks[0]['metadata']['start_char'] == 0
        assert chunks[-1]['metadata']['end_char'] == len(text)
        assert any('\ufffd' in chunk['text'] for chunk in chunks)
        for chunk in chunks:
            metadata = chunk['metadata']
            assert chunk['text'] == text[metadata['start_char'] : metadata['end_char']]

    def test_start_char_incremental_tracking(self):
        """Tokenizer work must stay linear and avoid growing-prefix encoding.

        Source token bytes are read once, then only candidate chunks are encoded
        to enforce the external token cap.
        """
        chunker = TokenChunker(chunk_size=10, chunk_overlap=0)

        call_counts = {'encode': 0, 'token_bytes': 0}
        encoded_lengths: list[int] = []

        class TrackingEncoder(_CharTokenEncoder):
            def encode(self, text):
                call_counts['encode'] += 1
                encoded_lengths.append(len(text))
                return super().encode(text)

            def decode_single_token_bytes(self, tid):
                call_counts['token_bytes'] += 1
                return super().decode_single_token_bytes(tid)

        chunker._encoder = TrackingEncoder()
        chunks = chunker.chunk('A' * 50)
        assert len(chunks) == 5
        assert call_counts['token_bytes'] == 50
        assert call_counts['encode'] == len(chunks) + 1
        assert max(encoded_lengths[1:]) <= chunker.chunk_size

    def test_start_char_correctness_with_overlap(self):
        chunker = TokenChunker(chunk_size=10, chunk_overlap=3)
        chunker._encoder = _CharTokenEncoder()
        chunks = chunker.chunk('A' * 25)
        assert len(chunks) >= 3
        for i in range(1, len(chunks)):
            assert chunks[i]['metadata']['start_char'] > chunks[i - 1]['metadata']['start_char']
        assert chunks[0]['metadata']['start_char'] == 0

    def test_rejects_token_bytes_that_do_not_match_source(self):
        """Never emit invented text when a tokenizer violates its byte contract."""

        class MismatchedEncoder(_CharTokenEncoder):
            def decode_single_token_bytes(self, tid):  # noqa: ARG002 - api shape
                return b'y'

        chunker = TokenChunker(chunk_size=4, chunk_overlap=0)
        chunker._encoder = MismatchedEncoder()
        with pytest.raises(ValueError, match='does not match the source text'):
            chunker.chunk('AAAA')


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

    def test_iglobal_creates_token_strategy(self):
        IGlobal, _ = _import_node_classes()
        iglobal = IGlobal.__new__(IGlobal)
        iglobal.strategy = None

        endpoint = MagicMock()
        endpoint.openMode = 'run'
        iglobal.IEndpoint = MagicMock()
        iglobal.IEndpoint.endpoint = endpoint

        glb = MagicMock()
        glb.logicalType = 'chunker'
        glb.connConfig = {
            'strategy': 'token',
            'chunk_size': '512',
            'chunk_overlap': '50',
            'encoding_name': 'o200k_base',
        }
        iglobal.glb = glb

        iglobal.beginGlobal()
        assert isinstance(iglobal.strategy, TokenChunker)
        assert iglobal.strategy.chunk_size == 512
        assert iglobal.strategy.chunk_overlap == 50
        assert iglobal.strategy.encoding_name == 'o200k_base'

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

    def test_iglobal_points_removed_recursive_strategy_at_preprocessor(self):
        """A stale 'recursive' config names the node that owns that algorithm.

        Recursive character splitting lives in preprocessor_langchain; this node
        no longer reimplements it, so the error has to route the author there
        rather than read as a plain typo.
        """
        IGlobal, _ = _import_node_classes()
        iglobal = IGlobal.__new__(IGlobal)
        iglobal.strategy = None

        endpoint = MagicMock()
        endpoint.openMode = 'run'
        iglobal.IEndpoint = MagicMock()
        iglobal.IEndpoint.endpoint = endpoint

        glb = MagicMock()
        glb.logicalType = 'chunker'
        glb.connConfig = {'strategy': 'recursive', 'chunk_size': '100', 'chunk_overlap': '0'}
        iglobal.glb = glb

        with pytest.raises(ValueError, match='preprocessor_langchain'):
            iglobal.beginGlobal()
        assert iglobal.strategy is None


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
        strategy = SentenceChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        meta = DocMetadata(objectId='doc-123', chunkId=0)
        doc = Doc(
            page_content='First sentence here. Second sentence here. Third sentence here.',
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
        strategy = SentenceChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        doc = Doc(
            page_content='First sentence here. Second sentence here. Third sentence here.',
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
        strategy = SentenceChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        inst.writeDocuments(
            [
                {
                    'page_content': 'First dict sentence. Second dict sentence. Third dict sentence.',
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
        strategy = SentenceChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        inst.writeDocuments([Doc(page_content='', metadata=None), Doc(page_content='   ', metadata=None)])
        inst.preventDefault.assert_called_once()
        # Nothing forwarded downstream.
        assert not inst.instance.writeDocuments.called

    def test_original_document_not_mutated(self):
        _, IInstance = _import_node_classes()
        Doc, DocMetadata = _import_schema()
        strategy = SentenceChunker(chunk_size=20, chunk_overlap=0)
        inst = self._make_instance(IInstance, strategy=strategy)

        original_content = 'First sentence here. Second sentence here. Third sentence here.'
        meta = DocMetadata(objectId='orig-id', chunkId=99)
        doc = Doc(page_content=original_content, metadata=meta)

        inst.writeDocuments([doc])
        assert doc.page_content == original_content
        assert doc.metadata.objectId == 'orig-id'
        assert doc.metadata.chunkId == 99

        emitted = inst.instance.writeDocuments.call_args[0][0]
        for chunk_doc in emitted:
            assert chunk_doc.metadata is not doc.metadata
