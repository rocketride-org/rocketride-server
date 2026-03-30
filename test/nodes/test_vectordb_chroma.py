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

"""Tests for the Chroma vector DB pipeline node (chroma).

Covers IGlobal.beginGlobal / endGlobal lifecycle (CONFIG vs WRITE mode),
and IInstance operations (writeQuestions, writeDocuments, renderObject).
"""

import sys
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Import the node under test (path setup handled by conftest.py)
# ---------------------------------------------------------------------------

from nodes.chroma.IGlobal import IGlobal  # noqa: E402
from nodes.chroma.IInstance import IInstance  # noqa: E402


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestChromaIGlobal:
    """Test suite for Chroma IGlobal lifecycle."""

    def test_begin_global_config_mode_skips_store(self, mock_endpoint_config):
        """In CONFIG mode, beginGlobal should not create a Store."""
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.IEndpoint = mock_endpoint_config
        ig.getConnConfig = MagicMock(return_value={})

        ig.beginGlobal()
        assert getattr(ig, 'store', None) is None

    def test_begin_global_write_mode_creates_store(self, mock_endpoint):
        """In WRITE mode, beginGlobal should create a Store and set subKey."""
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.IEndpoint = mock_endpoint
        ig.getConnConfig = MagicMock(return_value={'host': 'localhost', 'port': 8000, 'collection': 'test-col'})

        mock_store = MagicMock()
        mock_store.collection = 'test-col'
        mock_store.host = 'localhost'
        mock_store.port = 8000

        # The Store import happens inside beginGlobal via `from .chroma import Store`
        # We mock the chroma submodule that gets resolved during import
        mock_chroma_mod = MagicMock()
        mock_chroma_mod.Store = MagicMock(return_value=mock_store)
        with patch.dict(sys.modules, {'nodes.chroma.chroma': mock_chroma_mod}):
            ig.beginGlobal()

        assert ig.store is mock_store

    def test_end_global_clears_store(self):
        """EndGlobal should set store to None."""
        ig = IGlobal()
        ig.store = MagicMock()
        ig.endGlobal()
        assert ig.store is None


# ===================================================================
# IInstance
# ===================================================================


class TestChromaIInstance:
    """Test suite for Chroma IInstance operations."""

    def _make_instance(self):
        """Create an IInstance with mock IGlobal.store."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.store = MagicMock()
        inst.instance = MagicMock()
        return inst

    def test_write_questions_dispatches_search(self):
        """WriteQuestions should delegate to store.dispatchSearch."""
        inst = self._make_instance()
        question = MagicMock()

        inst.writeQuestions(question)

        inst.IGlobal.store.dispatchSearch.assert_called_once_with(inst, question)

    def test_write_documents_adds_chunks(self):
        """WriteDocuments should delegate to store.addChunks."""
        inst = self._make_instance()
        docs = [MagicMock(), MagicMock()]

        inst.writeDocuments(docs)

        inst.IGlobal.store.addChunks.assert_called_once_with(docs)

    def test_render_object_no_store_raises(self):
        """RenderObject should raise when store is None."""
        inst = self._make_instance()
        inst.IGlobal.store = None

        entry = MagicMock()
        entry.hasVectorBatchId = True
        entry.vectorBatchId = 'batch-1'

        with pytest.raises(Exception, match='No document store'):
            inst.renderObject(entry)

    def test_render_object_no_vector_batch_id_returns(self):
        """RenderObject should return early when no vectorBatchId."""
        inst = self._make_instance()
        entry = MagicMock()
        entry.hasVectorBatchId = False
        entry.vectorBatchId = None

        # Should not raise or call store.render
        inst.renderObject(entry)
        inst.IGlobal.store.render.assert_not_called()

    def test_render_object_with_vector_batch_calls_render(self):
        """RenderObject should call store.render when vectorBatchId is set."""
        inst = self._make_instance()
        entry = MagicMock()
        entry.hasVectorBatchId = True
        entry.vectorBatchId = 'batch-1'
        entry.objectId = 'obj-123'

        inst.renderObject(entry)

        inst.IGlobal.store.render.assert_called_once()
        call_kwargs = inst.IGlobal.store.render.call_args
        assert call_kwargs.kwargs['objectId'] == 'obj-123'
