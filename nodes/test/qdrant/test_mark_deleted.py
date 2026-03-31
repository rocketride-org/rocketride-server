# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for Qdrant store markDeleted / markActive payload path.

Validates that soft-delete flags are written to the nested ``meta.isDeleted``
path (matching the query filter and payload index) instead of a top-level
``isDeleted`` field.

Usage:
    python -m pytest nodes/test/test_qdrant_mark_deleted.py -v
"""

import sys
import threading
import importlib
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Bootstrap mocks so qdrant.py can be imported without real dependencies
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'


# --- ai.common.store: provide a real DocumentStoreBase with stub methods ---
class _FakeDocumentStoreBase:
    """Minimal stand-in for ai.common.store.DocumentStoreBase."""

    def __init__(self, *a, **kw):
        self.vectorSize = 0
        self.modelName = ''
        self.threshold_search = 0.5
        self.collectionLock = threading.Lock()

    def doesCollectionExist(self, *a, **kw):
        return True

    def _doesCollectionExist(self):
        return True

    def _checkCollectionExists(self):
        return True

    def createCollection(self, *a, **kw):
        return True


# Install module-level stubs before any qdrant imports
_mock_store_mod = MagicMock()
_mock_store_mod.DocumentStoreBase = _FakeDocumentStoreBase

_mock_config_mod = MagicMock()
_mock_schema_mod = MagicMock()

for name, mock in {
    'depends': MagicMock(),
    'engLib': MagicMock(),
    'rocketlib': MagicMock(),
    'numpy': MagicMock(),
    'ai': MagicMock(),
    'ai.common': MagicMock(),
    'ai.common.schema': _mock_schema_mod,
    'ai.common.store': _mock_store_mod,
    'ai.common.config': _mock_config_mod,
    'qdrant_client': MagicMock(),
    'qdrant_client.models': MagicMock(),
    'qdrant_client.http': MagicMock(),
    'qdrant_client.http.models': MagicMock(),
    'qdrant_client.conversions': MagicMock(),
    'qdrant_client.conversions.common_types': MagicMock(),
}.items():
    sys.modules.setdefault(name, mock)


# ---------------------------------------------------------------------------
# Import qdrant.py DIRECTLY (bypassing __init__.py which pulls IEndpoint etc.)
# ---------------------------------------------------------------------------

_qdrant_path = NODES_SRC / 'qdrant' / 'qdrant.py'
_spec = importlib.util.spec_from_file_location('_qdrant_store', str(_qdrant_path))
_qdrant_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_qdrant_mod)

Store = _qdrant_mod.Store


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_store() -> Store:
    """Create a Store instance with a mocked QdrantClient (bypasses __init__)."""
    store = object.__new__(Store)
    store.client = MagicMock()
    store.collection = 'test-collection'
    store.vectorSize = 384
    store.modelName = 'test-model'
    store.threshold_search = 0.5
    store.collectionLock = threading.Lock()
    return store


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestQdrantMarkDeleted:
    """Verify markDeleted writes to the correct nested payload path."""

    def test_markDeleted_writes_meta_isDeleted_true(self):
        """MarkDeleted must set meta.isDeleted = True, not top-level isDeleted."""
        store = _make_store()

        store.markDeleted(['obj-1', 'obj-2'])

        store.client.set_payload.assert_called_once()
        _, kwargs = store.client.set_payload.call_args
        assert kwargs['payload'] == {'meta': {'isDeleted': True}}, f'Expected {{"meta": {{"isDeleted": true}}}} but got {kwargs["payload"]}'

    def test_markActive_writes_meta_isDeleted_false(self):
        """MarkActive must set meta.isDeleted = False, not top-level isDeleted."""
        store = _make_store()

        store.markActive(['obj-1'])

        store.client.set_payload.assert_called_once()
        _, kwargs = store.client.set_payload.call_args
        assert kwargs['payload'] == {'meta': {'isDeleted': False}}, f'Expected {{"meta": {{"isDeleted": false}}}} but got {kwargs["payload"]}'

    def test_markDeleted_skips_when_collection_missing(self):
        """MarkDeleted is a no-op when the collection does not exist."""
        store = _make_store()

        with patch.object(type(store), 'doesCollectionExist', return_value=False):
            store.markDeleted(['obj-1'])

        store.client.set_payload.assert_not_called()

    def test_markActive_skips_when_collection_missing(self):
        """MarkActive is a no-op when the collection does not exist."""
        store = _make_store()

        with patch.object(type(store), 'doesCollectionExist', return_value=False):
            store.markActive(['obj-1'])

        store.client.set_payload.assert_not_called()
