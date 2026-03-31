# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Integration tests for ChromaDB vector store.

These tests validate core operations against a real ChromaDB instance:
- Client connectivity
- Collection lifecycle (create, check existence, delete)
- Document upsert and retrieval
- Vector similarity search
- Document deletion

Requirements:
    A ChromaDB server running locally (default: http://localhost:8000).
    Start one with:  docker run -p 8000:8000 chromadb/chroma

Configuration via environment variables:
    CHROMA_HOST  - ChromaDB host (default: localhost)
    CHROMA_PORT  - ChromaDB port (default: 8000)

Usage:
    pytest nodes/test/chroma/test_chroma_integration.py -v
"""

from __future__ import annotations

import os
import uuid

import pytest

# ---------------------------------------------------------------------------
# Availability check — skip the entire module when ChromaDB is unreachable
# ---------------------------------------------------------------------------

CHROMA_HOST = os.getenv('CHROMA_HOST', 'localhost')
CHROMA_PORT = int(os.getenv('CHROMA_PORT', '8000'))

try:
    import chromadb

    _client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    _client.heartbeat()
    CHROMA_AVAILABLE = True
except Exception:
    CHROMA_AVAILABLE = False

pytestmark = pytest.mark.skipif(not CHROMA_AVAILABLE, reason=f'ChromaDB not available at {CHROMA_HOST}:{CHROMA_PORT}')


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VECTOR_DIM = 128


def _random_vector() -> list[float]:
    """Return a deterministic-length random vector for testing."""
    import random

    return [random.uniform(-1.0, 1.0) for _ in range(VECTOR_DIM)]


@pytest.fixture()
def chroma_client():
    """Provide a connected ChromaDB HttpClient."""
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    yield client


@pytest.fixture()
def test_collection(chroma_client):
    """Create a temporary collection and clean it up after the test."""
    name = f'rr_test_{uuid.uuid4().hex[:12]}'
    collection = chroma_client.get_or_create_collection(name=name, metadata={'hnsw:space': 'cosine'})
    yield collection
    chroma_client.delete_collection(name=name)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestChromaConnectivity:
    """Verify basic client connectivity."""

    def test_heartbeat(self, chroma_client):
        """Client can reach the server and get a heartbeat response."""
        result = chroma_client.heartbeat()
        assert isinstance(result, (int, float))

    def test_list_collections(self, chroma_client):
        """Client can list collections without error."""
        collections = chroma_client.list_collections()
        assert isinstance(collections, list)


class TestChromaCollectionLifecycle:
    """Verify collection create / exists / delete."""

    def test_create_collection(self, chroma_client):
        name = f'rr_lifecycle_{uuid.uuid4().hex[:12]}'
        collection = chroma_client.get_or_create_collection(name=name)
        try:
            assert collection.name == name
        finally:
            chroma_client.delete_collection(name=name)

    def test_collection_shows_in_listing(self, chroma_client, test_collection):
        names = chroma_client.list_collections()
        assert test_collection.name in names

    def test_delete_collection(self, chroma_client):
        name = f'rr_delete_{uuid.uuid4().hex[:12]}'
        chroma_client.get_or_create_collection(name=name)
        chroma_client.delete_collection(name=name)
        names = chroma_client.list_collections()
        assert name not in names


class TestChromaUpsertAndGet:
    """Verify document upsert and retrieval."""

    def test_upsert_single_document(self, test_collection):
        doc_id = f'doc-{uuid.uuid4().hex[:8]}'
        test_collection.upsert(
            ids=[doc_id],
            embeddings=[_random_vector()],
            metadatas=[{'objectId': 'obj-1', 'chunkId': 0}],
            documents=['Hello world'],
        )
        result = test_collection.get(ids=[doc_id], include=['metadatas', 'documents'])
        assert len(result['ids']) == 1
        assert result['documents'][0] == 'Hello world'

    def test_upsert_multiple_documents(self, test_collection):
        ids = [f'doc-{uuid.uuid4().hex[:8]}' for _ in range(5)]
        test_collection.upsert(
            ids=ids,
            embeddings=[_random_vector() for _ in range(5)],
            metadatas=[{'objectId': f'obj-{i}', 'chunkId': 0} for i in range(5)],
            documents=[f'Document {i}' for i in range(5)],
        )
        result = test_collection.get(include=[])
        assert len(result['ids']) == 5

    def test_upsert_overwrites_existing(self, test_collection):
        doc_id = f'doc-{uuid.uuid4().hex[:8]}'
        test_collection.upsert(
            ids=[doc_id],
            embeddings=[_random_vector()],
            metadatas=[{'objectId': 'obj-1', 'chunkId': 0}],
            documents=['Version 1'],
        )
        test_collection.upsert(
            ids=[doc_id],
            embeddings=[_random_vector()],
            metadatas=[{'objectId': 'obj-1', 'chunkId': 0}],
            documents=['Version 2'],
        )
        result = test_collection.get(ids=[doc_id], include=['documents'])
        assert result['documents'][0] == 'Version 2'


class TestChromaVectorSearch:
    """Verify vector similarity search returns ranked results."""

    def test_query_returns_results(self, test_collection):
        ids = [f'doc-{uuid.uuid4().hex[:8]}' for _ in range(3)]
        embeddings = [_random_vector() for _ in range(3)]
        test_collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=['alpha', 'beta', 'gamma'],
        )
        results = test_collection.query(query_embeddings=[embeddings[0]], n_results=3)
        assert len(results['ids'][0]) <= 3
        # The most similar vector to embeddings[0] should be embeddings[0] itself
        assert ids[0] in results['ids'][0]

    def test_query_respects_n_results(self, test_collection):
        ids = [f'doc-{uuid.uuid4().hex[:8]}' for _ in range(5)]
        test_collection.upsert(
            ids=ids,
            embeddings=[_random_vector() for _ in range(5)],
            documents=[f'doc {i}' for i in range(5)],
        )
        results = test_collection.query(query_embeddings=[_random_vector()], n_results=2)
        assert len(results['ids'][0]) == 2

    def test_query_with_where_filter(self, test_collection):
        ids = [f'doc-{uuid.uuid4().hex[:8]}' for _ in range(4)]
        test_collection.upsert(
            ids=ids,
            embeddings=[_random_vector() for _ in range(4)],
            metadatas=[
                {'nodeId': 'A'},
                {'nodeId': 'B'},
                {'nodeId': 'A'},
                {'nodeId': 'B'},
            ],
            documents=['a1', 'b1', 'a2', 'b2'],
        )
        results = test_collection.query(
            query_embeddings=[_random_vector()],
            n_results=10,
            where={'nodeId': {'$eq': 'A'}},
        )
        returned_ids = set(results['ids'][0])
        # Only documents with nodeId 'A' should be returned
        assert returned_ids <= {ids[0], ids[2]}


class TestChromaDelete:
    """Verify document deletion."""

    def test_delete_by_ids(self, test_collection):
        doc_id = f'doc-{uuid.uuid4().hex[:8]}'
        test_collection.upsert(
            ids=[doc_id],
            embeddings=[_random_vector()],
            documents=['to be deleted'],
        )
        test_collection.delete(ids=[doc_id])
        result = test_collection.get(ids=[doc_id], include=[])
        assert len(result['ids']) == 0

    def test_delete_by_where_filter(self, test_collection):
        ids = [f'doc-{uuid.uuid4().hex[:8]}' for _ in range(3)]
        test_collection.upsert(
            ids=ids,
            embeddings=[_random_vector() for _ in range(3)],
            metadatas=[{'objectId': 'del-me'}, {'objectId': 'keep'}, {'objectId': 'del-me'}],
            documents=['d1', 'd2', 'd3'],
        )
        test_collection.delete(where={'objectId': {'$eq': 'del-me'}})
        result = test_collection.get(include=['metadatas'])
        assert len(result['ids']) == 1
        assert result['metadatas'][0]['objectId'] == 'keep'
