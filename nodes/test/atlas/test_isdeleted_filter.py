# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for Atlas MongoDB vector store _convertFilter and empty-list guards.

These tests validate the filter-building logic without requiring a MongoDB
connection. They mock pymongo to isolate the Store class's filter construction.

Usage:
    python -m pytest nodes/test/test_atlas_isdeleted_filter.py -v
"""

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Mock heavy dependencies BEFORE importing the atlas module
# ---------------------------------------------------------------------------

mock_depends_mod = types.ModuleType('depends')
mock_depends_mod.depends = lambda *a, **kw: None
sys.modules.setdefault('depends', mock_depends_mod)

for mod_name in (
    'pymongo',
    'pymongo.collection',
    'pymongo.database',
    'pymongo.errors',
    'pymongo.operations',
):
    sys.modules.setdefault(mod_name, MagicMock())

sys.modules.setdefault('numpy', MagicMock())


# ---------------------------------------------------------------------------
# Lightweight DocFilter stand-in
# ---------------------------------------------------------------------------


class DocFilter:
    """Minimal DocFilter matching the real schema for filter-building tests."""

    def __init__(self, **kwargs):
        """Build a filter instance from keyword fields."""
        self.nodeId = kwargs.get('nodeId', None)
        self.isTable = kwargs.get('isTable', None)
        self.tableIds = kwargs.get('tableIds', None)
        self.parent = kwargs.get('parent', None)
        self.permissions = kwargs.get('permissions', None)
        self.objectIds = kwargs.get('objectIds', None)
        self.isDeleted = kwargs.get('isDeleted', None)
        self.chunkIds = kwargs.get('chunkIds', None)
        self.minChunkId = kwargs.get('minChunkId', None)
        self.maxChunkId = kwargs.get('maxChunkId', None)
        self.limit = kwargs.get('limit', 25)
        self.offset = kwargs.get('offset', 0)


# ---------------------------------------------------------------------------
# Stub out ai.common.* so atlas.py can import without the full AI package
# ---------------------------------------------------------------------------

mock_ai_schema = types.ModuleType('ai.common.schema')
mock_ai_schema.DocFilter = DocFilter
mock_ai_schema.Doc = MagicMock()
mock_ai_schema.DocMetadata = MagicMock()
mock_ai_schema.QuestionText = MagicMock()

mock_ai_store = types.ModuleType('ai.common.store')


class FakeDocumentStoreBase:
    """Stand-in base class so Store can inherit without real infra."""

    def __init__(self, provider, connConfig, bag):
        """Initialize stub store base (arguments unused)."""
        self.vectorSize = 0
        self.modelName = ''
        self.threshold_search = 0.5

    def doesCollectionExist(self, modelName=None):
        return True


mock_ai_store.DocumentStoreBase = FakeDocumentStoreBase

mock_ai_config = types.ModuleType('ai.common.config')
mock_ai_config.Config = MagicMock()

for mod_name, mod_obj in [
    ('ai', types.ModuleType('ai')),
    ('ai.common', types.ModuleType('ai.common')),
    ('ai.common.schema', mock_ai_schema),
    ('ai.common.store', mock_ai_store),
    ('ai.common.config', mock_ai_config),
]:
    sys.modules.setdefault(mod_name, mod_obj)

# Mock pydantic at module level (atlas.py imports ValidationError)
mock_pydantic = types.ModuleType('pydantic')
mock_pydantic.ValidationError = Exception
sys.modules.setdefault('pydantic', mock_pydantic)

# ---------------------------------------------------------------------------
# Load atlas.py directly by file path (bypasses atlas/__init__.py)
# ---------------------------------------------------------------------------

_atlas_path = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'atlas' / 'atlas.py'
_spec = importlib.util.spec_from_file_location('_atlas_direct', _atlas_path)
atlas_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(atlas_mod)

Store = atlas_mod.Store


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store():
    """Create a Store instance with all MongoDB calls mocked out."""
    mock_config = MagicMock()
    mock_config.get = lambda key, default=None: {
        'database': 'testdb',
        'collection': 'testcol',
        'host': 'mongodb://localhost:27017',
        'vectorIndexName': 'vector_index',
        'textIndexName': 'text_index',
        'similarity': 'cosine',
        'score': 0.5,
        'payloadLimit': 32 * 1024 * 1024,
        'renderChunkSize': 32 * 1024 * 1024,
    }.get(key, default)

    with patch.object(atlas_mod.Config, 'getNodeConfig', return_value=mock_config):
        with patch.object(atlas_mod, 'MongoClient') as MockClient:
            mock_client = MagicMock()
            mock_db = MagicMock()
            mock_collection = MagicMock()
            mock_client.__getitem__ = MagicMock(return_value=mock_db)
            mock_db.__getitem__ = MagicMock(return_value=mock_collection)
            MockClient.return_value = mock_client

            s = Store('atlas', {}, {})
            s.collection = mock_collection
            s.database = mock_db
            yield s


# ============================================================================
# _convertFilter tests
# ============================================================================


class TestConvertFilterIsDeleted:
    """Verify _convertFilter correctly handles the isDeleted field."""

    def test_default_filter_excludes_deleted(self, store):
        """DocFilter() with no args should add meta.isDeleted=False."""
        f = DocFilter()
        result = store._convertFilter(f)
        assert 'meta.isDeleted' in result
        assert result['meta.isDeleted'] is False

    def test_explicit_false_excludes_deleted(self, store):
        """DocFilter(isDeleted=False) should add meta.isDeleted=False."""
        f = DocFilter(isDeleted=False)
        result = store._convertFilter(f)
        assert result['meta.isDeleted'] is False

    def test_explicit_true_includes_all(self, store):
        """DocFilter(isDeleted=True) should NOT add meta.isDeleted filter."""
        f = DocFilter(isDeleted=True)
        result = store._convertFilter(f)
        assert 'meta.isDeleted' not in result

    def test_combined_with_nodeId(self, store):
        """Combining isDeleted=False with nodeId should produce both keys."""
        f = DocFilter(nodeId='node-1', isDeleted=False)
        result = store._convertFilter(f)
        assert result['meta.nodeId'] == 'node-1'
        assert result['meta.isDeleted'] is False

    def test_combined_with_objectIds(self, store):
        """IsDeleted filter should coexist with objectIds."""
        f = DocFilter(objectIds=['obj-a', 'obj-b'])
        result = store._convertFilter(f)
        assert result['meta.objectId'] == {'$in': ['obj-a', 'obj-b']}
        assert result['meta.isDeleted'] is False

    def test_isdeleted_true_with_objectIds(self, store):
        """isDeleted=True + objectIds should only have objectIds filter."""
        f = DocFilter(objectIds=['schema'], isDeleted=True)
        result = store._convertFilter(f)
        assert result['meta.objectId'] == {'$in': ['schema']}
        assert 'meta.isDeleted' not in result


# ============================================================================
# Empty-list guard tests
# ============================================================================


class TestEmptyListGuards:
    """Verify that mutation methods short-circuit on empty objectIds."""

    def test_remove_noop_on_empty_list(self, store):
        """remove([]) should return immediately without calling MongoDB."""
        store.remove([])
        store.collection.delete_many.assert_not_called()

    def test_markDeleted_noop_on_empty_list(self, store):
        """markDeleted([]) should return immediately without calling MongoDB."""
        store.markDeleted([])
        store.collection.update_many.assert_not_called()

    def test_markActive_noop_on_empty_list(self, store):
        """markActive([]) should return immediately without calling MongoDB."""
        store.markActive([])
        store.collection.update_many.assert_not_called()

    def test_remove_calls_mongodb_with_ids(self, store):
        """remove() with IDs should call delete_many."""
        store.remove(['id-1', 'id-2'])
        store.collection.delete_many.assert_called_once_with({'meta.objectId': {'$in': ['id-1', 'id-2']}})

    def test_markDeleted_calls_mongodb_with_ids(self, store):
        """markDeleted() with IDs should call update_many."""
        store.markDeleted(['id-1'])
        store.collection.update_many.assert_called_once_with(
            {'meta.objectId': {'$in': ['id-1']}},
            {'$set': {'meta.isDeleted': True}},
        )

    def test_markActive_calls_mongodb_with_ids(self, store):
        """markActive() with IDs should call update_many."""
        store.markActive(['id-1'])
        store.collection.update_many.assert_called_once_with(
            {'meta.objectId': {'$in': ['id-1']}},
            {'$set': {'meta.isDeleted': False}},
        )
