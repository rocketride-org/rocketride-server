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

"""Tests for the Qdrant vector DB pipeline node (qdrant).

Covers IGlobal.validateConfig (collection name validation, port validation,
URL construction, error formatting), beginGlobal / endGlobal lifecycle,
IInstance operations, and the module-level _format_error helper.
"""

import sys
import os
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Provider SDK mocks — Qdrant
# ---------------------------------------------------------------------------

_mock_qdrant_client = types.ModuleType('qdrant_client')


class _FakeQdrantClient:
    def __init__(self, url=None, api_key=None, prefer_grpc=False, timeout=10):
        self.url = url
        self.api_key = api_key
        self._collections = []

    def get_collections(self):
        return self._collections

    def close(self):
        pass


_mock_qdrant_client.QdrantClient = _FakeQdrantClient
sys.modules['qdrant_client'] = _mock_qdrant_client

# Mock httpx for _format_error
_mock_httpx = types.ModuleType('httpx')


class _FakeHTTPStatusError(Exception):
    def __init__(self, message='', response=None, request=None):
        super().__init__(message)
        self.response = response
        self.request = request


class _FakeRequestError(Exception):
    pass


_mock_httpx.HTTPStatusError = _FakeHTTPStatusError
_mock_httpx.RequestError = _FakeRequestError
sys.modules['httpx'] = _mock_httpx

# ---------------------------------------------------------------------------
# Import the node under test
# ---------------------------------------------------------------------------

_nodes_src = os.path.join(os.path.dirname(__file__), '..', '..', 'nodes', 'src')
if _nodes_src not in sys.path:
    sys.path.insert(0, os.path.abspath(_nodes_src))

from nodes.qdrant.IGlobal import IGlobal, QDRANT_COLLECTION_RE, _format_error  # noqa: E402
from nodes.qdrant.IInstance import IInstance  # noqa: E402


# ===================================================================
# Collection name regex
# ===================================================================


class TestQdrantCollectionRegex:
    """Test the QDRANT_COLLECTION_RE regex pattern."""

    @pytest.mark.parametrize(
        'name',
        [
            'my-collection',
            'test_collection',
            'col.v2',
            'A',
            'abc123',
            'a' * 255,
        ],
    )
    def test_valid_names(self, name):
        """Valid collection names should match."""
        assert QDRANT_COLLECTION_RE.fullmatch(name) is not None

    @pytest.mark.parametrize(
        'name',
        [
            '',  # empty
            'my collection',  # spaces
            'my/collection',  # slash
            'a' * 256,  # too long
            'café',  # non-ASCII
        ],
    )
    def test_invalid_names(self, name):
        """Invalid collection names should not match."""
        assert QDRANT_COLLECTION_RE.fullmatch(name) is None


# ===================================================================
# IGlobal.validateConfig
# ===================================================================


class TestQdrantValidateConfig:
    """Test suite for IGlobal.validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('qdrant', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'qdrant'
        ig.glb.connConfig = config
        return ig

    def test_valid_config_succeeds(self, mock_config, warned_messages):
        """A valid config should produce no warnings."""
        config = {'host': 'localhost', 'port': 6333, 'apikey': '', 'collection': 'test-col'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeQdrantClient()
        with patch('qdrant_client.QdrantClient', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 0

    def test_invalid_collection_name_warns(self, mock_config, warned_messages):
        """Invalid collection name should produce a warning."""
        config = {'host': 'localhost', 'port': 6333, 'apikey': '', 'collection': 'bad name!'}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('invalid' in m.lower() for m in warned_messages)

    def test_empty_collection_name_warns(self, mock_config, warned_messages):
        """Empty collection name should produce a warning."""
        config = {'host': 'localhost', 'port': 6333, 'apikey': '', 'collection': ''}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('invalid' in m.lower() for m in warned_messages)

    def test_port_zero_warns(self, mock_config, warned_messages):
        """Port 0 should produce a warning."""
        config = {'host': 'localhost', 'port': 0, 'apikey': '', 'collection': 'test-col'}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('Port' in m for m in warned_messages)

    @pytest.mark.parametrize(
        'host,port,expected_scheme',
        [
            ('localhost', 6333, 'http'),
            ('127.0.0.1', 6333, 'http'),
            ('my-cloud.qdrant.io', 443, 'https'),
            ('my-cloud.qdrant.io', 6333, 'https'),
            ('http://localhost', 6333, 'http'),
            ('https://cloud.qdrant.io', 443, 'https'),
        ],
    )
    def test_url_construction(self, host, port, expected_scheme, mock_config, warned_messages):
        """URL construction should choose the right scheme based on host/port."""
        config = {'host': host, 'port': port, 'apikey': '', 'collection': 'test-col'}
        ig = self._make_iglobal(config, mock_config)

        captured_url = None

        def _capture_client(*args, **kwargs):
            nonlocal captured_url
            captured_url = kwargs.get('url', args[0] if args else None)
            return _FakeQdrantClient()

        with patch('qdrant_client.QdrantClient', side_effect=_capture_client):
            ig.validateConfig()

        assert captured_url is not None
        assert captured_url.startswith(expected_scheme + '://') or captured_url.startswith(host)

    def test_connection_failure_warns(self, mock_config, warned_messages):
        """Connection failure should produce a warning."""
        config = {'host': 'localhost', 'port': 6333, 'apikey': '', 'collection': 'test-col'}
        ig = self._make_iglobal(config, mock_config)

        def _failing_client(*args, **kwargs):
            client = _FakeQdrantClient()
            client.get_collections = MagicMock(side_effect=Exception('Connection refused'))
            return client

        with patch('qdrant_client.QdrantClient', side_effect=_failing_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Connection refused' in warned_messages[0]


# ===================================================================
# _format_error (module-level helper)
# ===================================================================


class TestQdrantFormatError:
    """Test suite for the module-level _format_error helper."""

    def test_format_generic_exception(self):
        """Should return str(e) for generic exceptions."""
        result = _format_error(Exception('Something failed'))
        assert result == 'Something failed'

    def test_format_http_status_error_with_json(self):
        """Should parse JSON body from HTTPStatusError."""
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_resp.text = '{"message": "Collection not found"}'
        err = _FakeHTTPStatusError('Not found', response=mock_resp)

        result = _format_error(err)
        assert '404' in result
        assert 'Collection not found' in result

    def test_format_http_status_error_with_plain_text(self):
        """Should use plain text when JSON parsing fails."""
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = 'Internal server error'
        err = _FakeHTTPStatusError('Error', response=mock_resp)

        result = _format_error(err)
        assert '500' in result
        assert 'Internal server error' in result

    def test_format_request_error(self):
        """Should return str(e) for RequestError."""
        result = _format_error(_FakeRequestError('Connection timeout'))
        assert result == 'Connection timeout'


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestQdrantBeginEndGlobal:
    """Test suite for Qdrant IGlobal lifecycle."""

    def test_begin_global_config_mode_skips(self, mock_endpoint_config):
        """In CONFIG mode, beginGlobal should not create a Store."""
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.IEndpoint = mock_endpoint_config
        ig.getConnConfig = MagicMock(return_value={})

        ig.beginGlobal()
        assert not hasattr(ig, 'store') or ig.store is None

    def test_end_global_clears_store(self):
        """EndGlobal should set store to None."""
        ig = IGlobal()
        ig.store = MagicMock()
        ig.endGlobal()
        assert ig.store is None


# ===================================================================
# IInstance
# ===================================================================


class TestQdrantIInstance:
    """Test suite for Qdrant IInstance operations."""

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
        docs = [MagicMock(), MagicMock(), MagicMock()]
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
        """RenderObject should skip when no vectorBatchId."""
        inst = self._make_instance()
        entry = MagicMock()
        entry.hasVectorBatchId = False
        entry.vectorBatchId = None

        inst.renderObject(entry)
        inst.IGlobal.store.render.assert_not_called()
