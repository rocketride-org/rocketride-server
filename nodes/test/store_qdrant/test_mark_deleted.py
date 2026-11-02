# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for Qdrant store markDeleted / markActive payload path.

Validates that soft-delete flags are written to the nested ``meta.isDeleted``
path (matching the query filter and payload index), preserving the other
metadata fields so a soft-deleted document can still be found and restored.

Usage:
    python -m pytest nodes/test/store_qdrant/test_mark_deleted.py -v
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

# Prefer the installed client's local backend for the round-trip regression.
# Keep the existing lightweight unit tests runnable without that dependency.
try:
    importlib.import_module('qdrant_client')
except ImportError:
    pass

for name, mock in {
    'numpy': MagicMock(),
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

_qdrant_path = NODES_SRC / 'store_qdrant' / 'qdrant.py'
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
    store._checkCollectionExists = lambda: True
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
        assert kwargs['payload'] == {'isDeleted': True}
        assert kwargs['key'] == 'meta'

    def test_markActive_writes_meta_isDeleted_false(self):
        """MarkActive must set meta.isDeleted = False, not top-level isDeleted."""
        store = _make_store()

        store.markActive(['obj-1'])

        store.client.set_payload.assert_called_once()
        _, kwargs = store.client.set_payload.call_args
        assert kwargs['payload'] == {'isDeleted': False}
        assert kwargs['key'] == 'meta'

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


def test_trash_round_trip_preserves_metadata_with_real_qdrant():
    """The real client's local backend must preserve siblings under meta."""
    from copy import deepcopy
    from types import SimpleNamespace

    import pytest
    from qdrant_client import QdrantClient, models
    from ai.common.store.document_store import VectorStoreToolMixin

    if QdrantClient.__module__ != 'qdrant_client.qdrant_client':
        pytest.skip('requires the real qdrant-client, not the protocol mock')
    client = QdrantClient(':memory:')
    try:
        client.create_collection(
            'test-collection', vectors_config=models.VectorParams(size=2, distance=models.Distance.COSINE)
        )
        original = {
            1: {'content': 'first', 'meta': {'objectId': 'a', 'chunkId': 0, 'parent': '/a', 'isDeleted': False}},
            2: {'content': 'second', 'meta': {'objectId': 'a', 'chunkId': 1, 'parent': '/a', 'isDeleted': False}},
            3: {'content': 'other', 'meta': {'objectId': 'b', 'chunkId': 0, 'parent': '/b', 'isDeleted': False}},
        }
        client.upsert(
            'test-collection',
            points=[
                models.PointStruct(id=i, vector=[1.0, 0.0], payload=deepcopy(payload))
                for i, payload in original.items()
            ],
        )
        store = _make_store()
        store.client = client
        tools = VectorStoreToolMixin()
        tools.IGlobal = SimpleNamespace(store=store, expose_tools=True, allow_write=True)

        assert tools.soft_delete({'object_ids': ['a']})['success'] is True
        expected = deepcopy(original)
        for i in (1, 2):
            expected[i]['meta']['isDeleted'] = True
        assert {p.id: p.payload for p in client.retrieve(store.collection, ids=list(original))} == expected
        assert tools.objdir({})['paths'] == {'/b': 'b'}
        assert 'soft-deleted' in tools.get({'object_id': 'a'})['error']

        assert tools.restore({'object_ids': ['a']})['success'] is True
        assert {p.id: p.payload for p in client.retrieve(store.collection, ids=list(original))} == original
        assert tools.objdir({})['paths'] == {'/a': 'a', '/b': 'b'}
        assert [c['content'] for c in tools.get({'object_id': 'a'})['chunks']] == ['first', 'second']
    finally:
        client.close()


def _point_id(object_id: str, chunk_id: int = 0) -> str:
    """A UUID point ID; the driver writes random ones, the tests need them stable."""
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'{object_id}/{chunk_id}'))


def _chunk(object_id: str, chunk_id: int = 0, parent: str | None = None, **flag) -> dict:
    """A point payload shaped like the driver's; ``flag`` holds ``isDeleted`` when it is set."""
    return {
        'content': f'{object_id} {chunk_id}',
        'meta': {'objectId': object_id, 'chunkId': chunk_id, 'parent': parent or f'/{object_id}', **flag},
    }


def _in_process_store(payloads: dict):
    """A store over the real client's in-process backend holding ``payloads`` (point ID to payload)."""
    import pytest
    from qdrant_client import QdrantClient, models

    if QdrantClient.__module__ != 'qdrant_client.qdrant_client':
        pytest.skip('requires the real qdrant-client, not the protocol mock')
    client = QdrantClient(':memory:')
    client.create_collection(
        'test-collection', vectors_config=models.VectorParams(size=2, distance=models.Distance.COSINE)
    )
    client.upsert(
        'test-collection',
        points=[models.PointStruct(id=pid, vector=[1.0, 0.0], payload=payload) for pid, payload in payloads.items()],
    )
    store = _make_store()
    store.client = client
    return store, client


def test_paths_list_records_without_a_deleted_flag_and_hide_trashed_ones():
    """Paths use get's trash test: a chunk-0 point whose flag is missing or null is listed, a trashed one is not."""
    from ai.common.schema import DocFilter

    store, client = _in_process_store(
        {
            _point_id('missing'): _chunk('missing'),
            _point_id('null'): _chunk('null', isDeleted=None),
            _point_id('active'): _chunk('active', isDeleted=False),
            _point_id('trashed'): _chunk('trashed', isDeleted=True),
            _point_id('schema'): _chunk('schema', parent='/', isDeleted=True),
        }
    )
    try:
        for object_id in ('missing', 'active'):
            assert store.get(DocFilter(objectIds=[object_id], offset=0, limit=10, isDeleted=False))
        assert store.getPaths() == {'/missing': 'missing', '/null': 'null', '/active': 'active'}
        assert store.getPaths(parent='/missing') == {'/missing': 'missing'}

        store.markDeleted(['missing'])
        assert store.getPaths() == {'/null': 'null', '/active': 'active'}
        assert store.getPaths(parent='/missing') == {}
        store.markActive(['missing'])
        assert store.getPaths(parent='/missing') == {'/missing': 'missing'}
    finally:
        client.close()


def test_paths_read_offset_pages_in_bounded_scroll_requests(monkeypatch):
    """A page past the first scroll request is read in requests no larger than the page size, never in one."""
    payloads = {}
    for index in range(5):
        object_id = f'doc-{index}'
        payloads[_point_id(object_id, 0)] = _chunk(object_id, 0, parent=f'/p{index}', isDeleted=False)
    store, client = _in_process_store(payloads)
    try:
        # The driver module is loaded from its file under a private name, so reach
        # its globals through the method rather than through sys.modules.
        monkeypatch.setitem(type(store).getPaths.__globals__, '_OBJDIR_SCROLL_PAGE', 2)
        limits = []
        real_scroll = client.scroll

        def scroll(*args, **kwargs):
            limits.append(kwargs['limit'])
            return real_scroll(*args, **kwargs)

        monkeypatch.setattr(client, 'scroll', scroll)

        everything = store.getPaths()
        assert everything == {f'/p{index}': f'doc-{index}' for index in range(5)}
        # Five points, default limit 1000: three requests of two; the third gets the
        # last point and no next_page_offset, which ends the read.
        assert limits == [2, 2, 2]

        limits.clear()
        page = store.getPaths(offset=3, limit=2)
        assert len(page) == 2 and set(page.items()) <= set(everything.items())
        assert limits == [2, 2, 1]  # offset + limit = 5 points: two, two, and the one still wanted

        limits.clear()
        assert store.getPaths(offset=5, limit=2) == {}
        assert max(limits) <= 2
    finally:
        client.close()


def test_paths_page_by_offset_on_uuid_point_ids():
    """Each offset starts a different page: scroll's own offset is a point-ID cursor, not a count."""
    payloads = {}
    for index in range(5):
        object_id = f'doc-{index}'
        payloads[_point_id(object_id, 0)] = _chunk(object_id, 0, parent=f'/p{index}', isDeleted=False)
        payloads[_point_id(object_id, 1)] = _chunk(object_id, 1, parent=f'/p{index}', isDeleted=False)
    payloads[_point_id('gone')] = _chunk('gone', isDeleted=True)
    store, client = _in_process_store(payloads)
    try:
        everything = store.getPaths()
        assert everything == {f'/p{index}': f'doc-{index}' for index in range(5)}

        singles = [store.getPaths(offset=offset, limit=1) for offset in range(5)]
        assert all(len(page) == 1 for page in singles)
        assert {path: oid for page in singles for path, oid in page.items()} == everything

        pages = [store.getPaths(offset=offset, limit=2) for offset in (0, 2, 4)]
        assert [len(page) for page in pages] == [2, 2, 1]
        assert {path: oid for page in pages for path, oid in page.items()} == everything
        assert store.getPaths(offset=5, limit=2) == {}
    finally:
        client.close()
