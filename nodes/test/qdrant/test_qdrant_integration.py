# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Integration tests for Qdrant vector store.

These tests validate core operations against a real Qdrant instance:
- Client connectivity
- Collection lifecycle (create, check existence, delete)
- Document upsert (point insertion) and retrieval
- Vector similarity search with filters
- Point deletion

Requirements:
    A Qdrant server running locally (default: http://localhost:6333).
    Start one with:  docker run -p 6333:6333 qdrant/qdrant

Configuration via environment variables:
    QDRANT_HOST  - Qdrant host (default: localhost)
    QDRANT_PORT  - Qdrant port (default: 6333)

Usage:
    pytest nodes/test/qdrant/test_qdrant_integration.py -v
"""

from __future__ import annotations

import os
import uuid

import pytest

# ---------------------------------------------------------------------------
# Availability check — skip the entire module when Qdrant is unreachable
# ---------------------------------------------------------------------------

QDRANT_HOST = os.getenv('QDRANT_HOST', 'localhost')
QDRANT_PORT = int(os.getenv('QDRANT_PORT', '6333'))
QDRANT_URL = f'http://{QDRANT_HOST}:{QDRANT_PORT}'

try:
    from qdrant_client import QdrantClient
    from qdrant_client.http import models

    _client = QdrantClient(url=QDRANT_URL, timeout=5)
    _client.get_collections()
    QDRANT_AVAILABLE = True
except Exception:
    QDRANT_AVAILABLE = False

pytestmark = pytest.mark.skipif(not QDRANT_AVAILABLE, reason=f'Qdrant not available at {QDRANT_URL}')


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VECTOR_DIM = 128


def _random_vector() -> list[float]:
    """Return a deterministic-length random vector for testing."""
    import random

    return [random.uniform(-1.0, 1.0) for _ in range(VECTOR_DIM)]


@pytest.fixture()
def qdrant_client():
    """Provide a connected QdrantClient."""
    client = QdrantClient(url=QDRANT_URL, timeout=30)
    yield client


@pytest.fixture()
def test_collection(qdrant_client):
    """Create a temporary collection and clean it up after the test."""
    name = f'rr_test_{uuid.uuid4().hex[:12]}'
    qdrant_client.create_collection(
        collection_name=name,
        vectors_config=models.VectorParams(size=VECTOR_DIM, distance=models.Distance.COSINE),
    )
    yield name
    qdrant_client.delete_collection(collection_name=name)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestQdrantConnectivity:
    """Verify basic client connectivity."""

    def test_get_collections(self, qdrant_client):
        """Client can reach the server and list collections."""
        result = qdrant_client.get_collections()
        assert hasattr(result, 'collections')

    def test_collection_exists_for_missing_collection(self, qdrant_client):
        """collection_exists returns False for a non-existent collection."""
        assert not qdrant_client.collection_exists(collection_name='nonexistent_rr_test_xyz')


class TestQdrantCollectionLifecycle:
    """Verify collection create / exists / delete."""

    def test_create_collection(self, qdrant_client):
        name = f'rr_lifecycle_{uuid.uuid4().hex[:12]}'
        qdrant_client.create_collection(
            collection_name=name,
            vectors_config=models.VectorParams(size=VECTOR_DIM, distance=models.Distance.COSINE),
        )
        try:
            assert qdrant_client.collection_exists(collection_name=name)
        finally:
            qdrant_client.delete_collection(collection_name=name)

    def test_get_collection_info(self, qdrant_client, test_collection):
        info = qdrant_client.get_collection(collection_name=test_collection)
        assert info.config.params.vectors.size == VECTOR_DIM

    def test_delete_collection(self, qdrant_client):
        name = f'rr_delete_{uuid.uuid4().hex[:12]}'
        qdrant_client.create_collection(
            collection_name=name,
            vectors_config=models.VectorParams(size=VECTOR_DIM, distance=models.Distance.COSINE),
        )
        qdrant_client.delete_collection(collection_name=name)
        assert not qdrant_client.collection_exists(collection_name=name)


class TestQdrantUpsertAndGet:
    """Verify point upsert and retrieval."""

    def test_upsert_single_point(self, qdrant_client, test_collection):
        point_id = str(uuid.uuid4())
        qdrant_client.upsert(
            collection_name=test_collection,
            points=[
                models.PointStruct(
                    id=point_id,
                    vector=_random_vector(),
                    payload={'content': 'Hello world', 'meta': {'objectId': 'obj-1', 'chunkId': 0, 'isDeleted': False}},
                )
            ],
        )
        result = qdrant_client.retrieve(collection_name=test_collection, ids=[point_id], with_payload=True)
        assert len(result) == 1
        assert result[0].payload['content'] == 'Hello world'

    def test_upsert_multiple_points(self, qdrant_client, test_collection):
        points = [
            models.PointStruct(
                id=str(uuid.uuid4()),
                vector=_random_vector(),
                payload={'content': f'Document {i}', 'meta': {'objectId': f'obj-{i}', 'chunkId': 0, 'isDeleted': False}},
            )
            for i in range(5)
        ]
        qdrant_client.upsert(collection_name=test_collection, points=points)
        info = qdrant_client.get_collection(collection_name=test_collection)
        assert info.points_count == 5

    def test_upsert_overwrites_existing(self, qdrant_client, test_collection):
        point_id = str(uuid.uuid4())
        qdrant_client.upsert(
            collection_name=test_collection,
            points=[models.PointStruct(id=point_id, vector=_random_vector(), payload={'content': 'Version 1'})],
        )
        qdrant_client.upsert(
            collection_name=test_collection,
            points=[models.PointStruct(id=point_id, vector=_random_vector(), payload={'content': 'Version 2'})],
        )
        result = qdrant_client.retrieve(collection_name=test_collection, ids=[point_id], with_payload=True)
        assert result[0].payload['content'] == 'Version 2'


class TestQdrantVectorSearch:
    """Verify vector similarity search returns ranked results."""

    def test_search_returns_results(self, qdrant_client, test_collection):
        vectors = [_random_vector() for _ in range(3)]
        points = [models.PointStruct(id=str(uuid.uuid4()), vector=vectors[i], payload={'content': f'doc-{i}'}) for i in range(3)]
        qdrant_client.upsert(collection_name=test_collection, points=points)
        results = qdrant_client.query_points(
            collection_name=test_collection,
            query=vectors[0],
            limit=3,
            with_payload=True,
        ).points
        assert len(results) <= 3
        # The best match for vectors[0] should be points[0]
        assert results[0].payload['content'] == 'doc-0'

    def test_search_respects_limit(self, qdrant_client, test_collection):
        points = [models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'content': f'doc-{i}'}) for i in range(5)]
        qdrant_client.upsert(collection_name=test_collection, points=points)
        results = qdrant_client.query_points(
            collection_name=test_collection,
            query=_random_vector(),
            limit=2,
        ).points
        assert len(results) == 2

    def test_search_with_filter(self, qdrant_client, test_collection):
        points = [
            models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'meta': {'nodeId': 'A'}, 'content': 'a1'}),
            models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'meta': {'nodeId': 'B'}, 'content': 'b1'}),
            models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'meta': {'nodeId': 'A'}, 'content': 'a2'}),
        ]
        qdrant_client.upsert(collection_name=test_collection, points=points)
        results = qdrant_client.query_points(
            collection_name=test_collection,
            query=_random_vector(),
            query_filter=models.Filter(must=[models.FieldCondition(key='meta.nodeId', match=models.MatchValue(value='A'))]),
            limit=10,
            with_payload=True,
        ).points
        assert all(r.payload['meta']['nodeId'] == 'A' for r in results)
        assert len(results) == 2

    def test_scroll_retrieves_all_points(self, qdrant_client, test_collection):
        points = [models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'content': f'doc-{i}'}) for i in range(5)]
        qdrant_client.upsert(collection_name=test_collection, points=points)
        records, _next = qdrant_client.scroll(collection_name=test_collection, limit=10, with_payload=True)
        assert len(records) == 5


class TestQdrantDelete:
    """Verify point deletion."""

    def test_delete_by_ids(self, qdrant_client, test_collection):
        point_id = str(uuid.uuid4())
        qdrant_client.upsert(
            collection_name=test_collection,
            points=[models.PointStruct(id=point_id, vector=_random_vector(), payload={'content': 'delete me'})],
        )
        qdrant_client.delete(
            collection_name=test_collection,
            points_selector=models.PointIdsList(points=[point_id]),
        )
        result = qdrant_client.retrieve(collection_name=test_collection, ids=[point_id])
        assert len(result) == 0

    def test_delete_by_filter(self, qdrant_client, test_collection):
        points = [
            models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'meta': {'objectId': 'del-me'}, 'content': 'd1'}),
            models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'meta': {'objectId': 'keep'}, 'content': 'd2'}),
            models.PointStruct(id=str(uuid.uuid4()), vector=_random_vector(), payload={'meta': {'objectId': 'del-me'}, 'content': 'd3'}),
        ]
        qdrant_client.upsert(collection_name=test_collection, points=points)
        qdrant_client.delete(
            collection_name=test_collection,
            points_selector=models.FilterSelector(filter=models.Filter(must=[models.FieldCondition(key='meta.objectId', match=models.MatchValue(value='del-me'))])),
        )
        records, _ = qdrant_client.scroll(collection_name=test_collection, limit=10, with_payload=True)
        assert len(records) == 1
        assert records[0].payload['meta']['objectId'] == 'keep'

    def test_set_payload_for_soft_delete(self, qdrant_client, test_collection):
        """Validate the soft-delete pattern used by the Qdrant Store node."""
        point_id = str(uuid.uuid4())
        qdrant_client.upsert(
            collection_name=test_collection,
            points=[models.PointStruct(id=point_id, vector=_random_vector(), payload={'meta': {'objectId': 'obj-1', 'isDeleted': False}, 'content': 'data'})],
        )
        qdrant_client.set_payload(
            collection_name=test_collection,
            payload={'meta': {'isDeleted': True}},
            points=models.PointIdsList(points=[point_id]),
        )
        result = qdrant_client.retrieve(collection_name=test_collection, ids=[point_id], with_payload=True)
        assert result[0].payload['meta']['isDeleted'] is True
