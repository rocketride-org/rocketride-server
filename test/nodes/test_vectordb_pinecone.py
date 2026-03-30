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

"""Tests for the Pinecone vector DB pipeline node (pinecone).

Covers IGlobal.validateConfig (collection name validation, mode compatibility),
IGlobal.beginGlobal / endGlobal lifecycle, and IInstance operations.
"""

import sys
import os
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Provider SDK mocks — Pinecone
# ---------------------------------------------------------------------------

_mock_pinecone = types.ModuleType('pinecone')


class _FakePinecone:
    def __init__(self, api_key=None):
        self.api_key = api_key
        self._indexes = []

    def list_indexes(self):
        return self._indexes


_mock_pinecone.Pinecone = _FakePinecone
_mock_pinecone.ServerlessSpec = MagicMock()
_mock_pinecone.PodSpec = MagicMock()

# Mock pinecone.grpc (used by the Store module)
_mock_pinecone_grpc = types.ModuleType('pinecone.grpc')
_mock_pinecone_grpc.PineconeGRPC = _FakePinecone
sys.modules['pinecone.grpc'] = _mock_pinecone_grpc

_mock_pinecone_core = types.ModuleType('pinecone.core')
_mock_pinecone_core_client = types.ModuleType('pinecone.core.client')
_mock_pinecone_core_client_exceptions = types.ModuleType('pinecone.core.client.exceptions')


class _FakeApiException(Exception):
    def __init__(self, message='', status=None, body=None, reason=None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.reason = reason


_mock_pinecone_core_client_exceptions.ApiException = _FakeApiException

sys.modules['pinecone'] = _mock_pinecone
sys.modules['pinecone.core'] = _mock_pinecone_core
sys.modules['pinecone.core.client'] = _mock_pinecone_core_client
sys.modules['pinecone.core.client.exceptions'] = _mock_pinecone_core_client_exceptions

# ---------------------------------------------------------------------------
# Import the node under test
# ---------------------------------------------------------------------------

_nodes_src = os.path.join(os.path.dirname(__file__), '..', '..', 'nodes', 'src')
if _nodes_src not in sys.path:
    sys.path.insert(0, os.path.abspath(_nodes_src))

from nodes.pinecone.IGlobal import IGlobal  # noqa: E402
from nodes.pinecone.IInstance import IInstance  # noqa: E402


# ===================================================================
# IGlobal.validateConfig — collection name validation
# ===================================================================


class TestPineconeValidateConfigCollectionName:
    """Test collection name validation in validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('pinecone', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'pinecone'
        ig.glb.connConfig = config
        return ig

    def test_valid_collection_name(self, mock_config, warned_messages):
        """A valid collection name should not produce warnings."""
        config = {'apikey': 'test-key', 'collection': 'my-index', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakePinecone()
        fake_client._indexes = []
        with patch('pinecone.Pinecone', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 0

    def test_missing_collection_name_warns(self, mock_config, warned_messages):
        """Missing collection name should produce a warning."""
        config = {'apikey': 'test-key', 'collection': '', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('invalid' in m.lower() or 'missing' in m.lower() for m in warned_messages)

    @pytest.mark.parametrize(
        'name,violation_fragment',
        [
            ('My-Index', 'lowercase'),
            ('my_index!', 'lowercase'),
            ('-my-index', 'start or end'),
            ('my-index-', 'start or end'),
            ('my--index', 'consecutive'),
            ('a' * 46, 'too long'),
        ],
    )
    def test_invalid_collection_names(self, name, violation_fragment, mock_config, warned_messages):
        """Various invalid collection names should produce appropriate warnings."""
        config = {'apikey': 'test-key', 'collection': name, 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert len(warned_messages) >= 1
        assert any(violation_fragment in m.lower() for m in warned_messages)


# ===================================================================
# IGlobal.validateConfig — mode compatibility
# ===================================================================


class TestPineconeValidateConfigModeCompat:
    """Test mode compatibility checks in validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('pinecone', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'pinecone'
        ig.glb.connConfig = config
        return ig

    def test_serverless_mode_with_pod_index_warns(self, mock_config, warned_messages):
        """Selecting serverless mode with a pod-based index should warn."""
        config = {'apikey': 'test-key', 'collection': 'my-index', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakePinecone()
        fake_client._indexes = [{'name': 'my-index', 'spec': {'pod': {}}}]  # pod-based
        with patch('pinecone.Pinecone', return_value=fake_client):
            ig.validateConfig()

        assert any('pod-based' in m.lower() for m in warned_messages)

    def test_pod_mode_with_serverless_index_warns(self, mock_config, warned_messages):
        """Selecting pod mode with a serverless index should warn."""
        config = {'apikey': 'test-key', 'collection': 'my-index', 'mode': 'pod-based'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakePinecone()
        fake_client._indexes = [{'name': 'my-index', 'spec': {'serverless': {}}}]
        with patch('pinecone.Pinecone', return_value=fake_client):
            ig.validateConfig()

        assert any('serverless' in m.lower() for m in warned_messages)

    def test_matching_mode_no_warning(self, mock_config, warned_messages):
        """Matching mode should produce no warnings."""
        config = {'apikey': 'test-key', 'collection': 'my-index', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakePinecone()
        fake_client._indexes = [{'name': 'my-index', 'spec': {'serverless': {}}}]
        with patch('pinecone.Pinecone', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 0

    def test_new_index_no_warning(self, mock_config, warned_messages):
        """A new index (not existing) should not produce mode warnings."""
        config = {'apikey': 'test-key', 'collection': 'new-index', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakePinecone()
        fake_client._indexes = []
        with patch('pinecone.Pinecone', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 0


# ===================================================================
# IGlobal.validateConfig — exception handling
# ===================================================================


class TestPineconeValidateConfigExceptions:
    """Test exception handling in validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('pinecone', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'pinecone'
        ig.glb.connConfig = config
        return ig

    def test_api_exception_with_status(self, mock_config, warned_messages):
        """ApiException with status code should format error properly."""
        config = {'apikey': 'bad-key', 'collection': 'my-index', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)

        err = _FakeApiException('Unauthorized', status=401, body='Invalid API key')
        with patch('pinecone.Pinecone', side_effect=err):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert '401' in warned_messages[0]

    def test_generic_exception_fallback(self, mock_config, warned_messages):
        """Generic exceptions should produce a warning with the error message."""
        config = {'apikey': 'test-key', 'collection': 'my-index', 'mode': 'serverless-dense'}
        ig = self._make_iglobal(config, mock_config)

        with patch('pinecone.Pinecone', side_effect=Exception('Connection refused')):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Connection refused' in warned_messages[0]


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestPineconeBeginEndGlobal:
    """Test suite for Pinecone IGlobal lifecycle."""

    def test_begin_global_config_mode_skips_store(self, mock_endpoint_config):
        """In CONFIG mode, beginGlobal should not create a Store."""
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.IEndpoint = mock_endpoint_config
        ig.getConnConfig = MagicMock(return_value={})

        ig.beginGlobal()
        assert ig.store is None

    def test_end_global_clears_store(self):
        """EndGlobal should set store to None."""
        ig = IGlobal()
        ig.store = MagicMock()
        ig.endGlobal()
        assert ig.store is None


# ===================================================================
# IInstance
# ===================================================================


class TestPineconeIInstance:
    """Test suite for Pinecone IInstance operations."""

    def _make_instance(self):
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

    def test_render_object_no_batch_id_skips(self):
        """RenderObject should return early when no vectorBatchId."""
        inst = self._make_instance()
        entry = MagicMock()
        entry.hasVectorBatchId = False
        entry.vectorBatchId = None

        inst.renderObject(entry)
        inst.IGlobal.store.render.assert_not_called()

    def test_render_object_with_batch_id_renders(self):
        """RenderObject should call store.render when vectorBatchId is set."""
        inst = self._make_instance()
        entry = MagicMock()
        entry.hasVectorBatchId = True
        entry.vectorBatchId = 'batch-1'
        entry.objectId = 'obj-456'

        inst.renderObject(entry)
        inst.IGlobal.store.render.assert_called_once()
        call_kwargs = inst.IGlobal.store.render.call_args
        assert call_kwargs.kwargs['objectId'] == 'obj-456'
