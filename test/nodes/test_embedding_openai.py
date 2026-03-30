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

"""Tests for the OpenAI Embedding pipeline node (embedding_openai).

Covers IGlobal.beginGlobal / endGlobal lifecycle, and IInstance operations
(writeDocuments, writeQuestions, open).
"""

import sys
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Import the node under test (path setup handled by conftest.py)
# ---------------------------------------------------------------------------

from nodes.embedding_openai.IGlobal import IGlobal  # noqa: E402
from nodes.embedding_openai.IInstance import IInstance  # noqa: E402


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestEmbeddingOpenAIIGlobal:
    """Test suite for embedding_openai IGlobal lifecycle."""

    def test_begin_global_config_mode_skips_embedding(self, mock_config, mock_endpoint_config):
        """In CONFIG mode, beginGlobal should not create an embedding wrapper."""
        config = {'apikey': 'sk-test', 'model': 'text-embedding-3-small'}
        mock_config.set_config('embedding_openai', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'embedding_openai'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint_config

        ig.beginGlobal()
        assert ig.embedding is None

    def test_begin_global_write_mode_creates_embedding(self, mock_config, mock_endpoint):
        """In WRITE mode, beginGlobal should create an OpenAIEmbeddingWrapper."""
        config = {'apikey': 'sk-test', 'model': 'text-embedding-3-small'}
        mock_config.set_config('embedding_openai', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'embedding_openai'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint

        mock_wrapper = MagicMock()
        # The import happens inside beginGlobal via `from .OpenAIEmbeddingWrapper import OpenAIEmbeddingWrapper`
        mock_wrapper_mod = MagicMock()
        mock_wrapper_mod.OpenAIEmbeddingWrapper = MagicMock(return_value=mock_wrapper)
        with patch.dict(sys.modules, {'nodes.embedding_openai.OpenAIEmbeddingWrapper': mock_wrapper_mod}):
            ig.beginGlobal()

        assert ig.embedding is mock_wrapper

    def test_end_global_clears_embedding(self):
        """EndGlobal should set embedding to None."""
        ig = IGlobal()
        ig.embedding = MagicMock()
        ig.endGlobal()
        assert ig.embedding is None


# ===================================================================
# IInstance
# ===================================================================


class TestEmbeddingOpenAIIInstance:
    """Test suite for embedding_openai IInstance operations."""

    def _make_instance(self):
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.embedding = MagicMock()
        inst.instance = MagicMock()
        return inst

    def test_open_resets_counters(self):
        """Open should reset chunkId and tableId to 0."""
        inst = self._make_instance()
        inst.chunkId = 5
        inst.tableId = 3

        entry = MagicMock()
        inst.open(entry)

        assert inst.chunkId == 0
        assert inst.tableId == 0

    def test_write_documents_encodes_chunks(self):
        """WriteDocuments should delegate to embedding.encodeChunks."""
        inst = self._make_instance()
        docs = [MagicMock(), MagicMock()]

        inst.writeDocuments(docs)

        inst.IGlobal.embedding.encodeChunks.assert_called_once_with(docs)

    def test_write_documents_multiple_batches(self):
        """Multiple writeDocuments calls should each delegate independently."""
        inst = self._make_instance()

        batch1 = [MagicMock()]
        batch2 = [MagicMock(), MagicMock()]

        inst.writeDocuments(batch1)
        inst.writeDocuments(batch2)

        assert inst.IGlobal.embedding.encodeChunks.call_count == 2

    def test_write_questions_encodes_question(self):
        """WriteQuestions should delegate to embedding.encodeQuestion."""
        inst = self._make_instance()
        question = MagicMock()

        inst.writeQuestions(question)

        inst.IGlobal.embedding.encodeQuestion.assert_called_once_with(question)

    def test_write_questions_multiple(self):
        """Multiple writeQuestions calls should each delegate independently."""
        inst = self._make_instance()

        q1 = MagicMock()
        q2 = MagicMock()

        inst.writeQuestions(q1)
        inst.writeQuestions(q2)

        assert inst.IGlobal.embedding.encodeQuestion.call_count == 2
        inst.IGlobal.embedding.encodeQuestion.assert_any_call(q1)
        inst.IGlobal.embedding.encodeQuestion.assert_any_call(q2)

    def test_instance_has_iglobal_type_hint(self):
        """IInstance should have IGlobal type annotation."""
        assert 'IGlobal' in IInstance.__annotations__
