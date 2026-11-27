# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the vector index selection in Store._createCollection.

New-generation Weaviate Cloud clusters reject hnsw with 422 and permit only
their hfresh index. The loader retries with hfresh, but that retry is narrow on
purpose:

- hfresh accepts fewer distance metrics than hnsw, so a metric it cannot take
  must not trigger a doomed second call that buries the first error.
- A 422 that was never about the index type fails both calls, and the hnsw error
  is the one that explains why, so it stays the reported error.
"""

from __future__ import annotations

import types

import pytest

from nodes.store_weaviate import weaviate as weaviate_store

# The shared mock, imported as part of this test package. conftest.py points the
# driver's config builders and errors at it for each test.
from ..mocks.weaviate.exceptions import WeaviateConnectionError


class _RecordingCollections:
    """Records each create() call and fails according to a scripted plan."""

    def __init__(self, fail_for):
        self.calls = []
        self._fail_for = fail_for

    def create(self, **kwargs):
        index_type = kwargs['vector_index_config']['type']
        self.calls.append(kwargs)
        error = self._fail_for(index_type)
        if error is not None:
            raise error
        return f'collection:{index_type}'


def _make_store(module, fail_for):
    """Build a Store with only the attributes _createCollection touches."""
    store = module.Store.__new__(module.Store)
    store.collection = 'test-collection'
    store.similarity = module.VectorDistances.COSINE
    collections = _RecordingCollections(fail_for)
    # close() is here because Store.__del__ calls it during collection.
    store.client = types.SimpleNamespace(collections=collections, close=lambda: None)
    return store, collections


def _status_error(module, status_code, message='rejected'):
    return module.UnexpectedStatusCodeError(message, types.SimpleNamespace(status_code=status_code))


def test_hnsw_is_used_when_the_cluster_accepts_it():
    """The default path creates an hnsw index and never calls create twice."""
    module = weaviate_store
    store, collections = _make_store(module, fail_for=lambda index_type: None)

    store._createCollection()

    assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw']
    assert store.collectionObj == 'collection:hnsw'


def test_falls_back_to_hfresh_on_422():
    """A 422 on hnsw retries with hfresh, keeping the distance metric."""
    module = weaviate_store

    def fail_for(index_type):
        return _status_error(module, 422, 'CONFIG_NOT_ALLOWED') if index_type == 'hnsw' else None

    store, collections = _make_store(module, fail_for)

    store._createCollection()

    assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw', 'hfresh']
    assert collections.calls[1]['vector_index_config']['distance_metric'] == module.VectorDistances.COSINE
    # The shared arguments must be identical across both attempts.
    assert collections.calls[0]['name'] == collections.calls[1]['name']
    assert collections.calls[0]['properties'] == collections.calls[1]['properties']
    assert collections.calls[0]['vectorizer_config'] == collections.calls[1]['vectorizer_config']
    assert store.collectionObj == 'collection:hfresh'


def test_non_422_errors_are_not_retried():
    """Only the 422 index-restriction case is worth a second attempt."""
    module = weaviate_store
    error = _status_error(module, 500, 'server exploded')
    store, collections = _make_store(module, fail_for=lambda index_type: error)

    with pytest.raises(module.UnexpectedStatusCodeError) as excinfo:
        store._createCollection()

    assert excinfo.value is error
    assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw']


@pytest.mark.parametrize('metric_name', ['DOT', 'HAMMING', 'MANHATTAN'])
def test_unsupported_metric_skips_the_hfresh_retry(metric_name):
    """The hfresh index cannot take these metrics, so the hnsw error surfaces as-is."""
    module = weaviate_store
    error = _status_error(module, 422, 'CONFIG_NOT_ALLOWED')
    store, collections = _make_store(module, fail_for=lambda index_type: error)
    store.similarity = getattr(module.VectorDistances, metric_name)

    with pytest.raises(module.UnexpectedStatusCodeError) as excinfo:
        store._createCollection()

    assert excinfo.value is error
    # No doomed second call.
    assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw']


def test_supported_metrics_do_attempt_the_retry():
    """The two metrics hfresh accepts are the ones that reach the fallback."""
    module = weaviate_store

    for metric_name in ('COSINE', 'L2_SQUARED'):

        def fail_for(index_type):
            return _status_error(module, 422, 'CONFIG_NOT_ALLOWED') if index_type == 'hnsw' else None

        store, collections = _make_store(module, fail_for)
        store.similarity = getattr(module.VectorDistances, metric_name)

        store._createCollection()

        assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw', 'hfresh'], metric_name


def test_a_422_that_is_not_about_the_index_reports_the_original_error():
    """When both attempts fail, the hnsw error is reported, hfresh is context."""
    module = weaviate_store
    hnsw_error = _status_error(module, 422, 'property "content" is invalid')
    hfresh_error = _status_error(module, 422, 'property "content" is invalid')

    def fail_for(index_type):
        return hnsw_error if index_type == 'hnsw' else hfresh_error

    store, collections = _make_store(module, fail_for)

    with pytest.raises(module.UnexpectedStatusCodeError) as excinfo:
        store._createCollection()

    assert excinfo.value is hnsw_error, 'the actionable error must win'
    assert excinfo.value.__cause__ is hfresh_error, 'the retry failure is kept as context'
    assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw', 'hfresh']


def test_a_network_failure_on_the_retry_still_reports_the_hnsw_error():
    """The retry's own failure must not replace the error that explains the cause.

    A connection or timeout error derives from WeaviateBaseError rather than
    UnexpectedStatusCodeError, so a handler catching only the latter would let it
    propagate and bury the actionable "hnsw is not allowed" 422 under a network
    message that says nothing about why the collection could not be created.
    """
    module = weaviate_store

    hnsw_error = _status_error(module, 422, 'hnsw is not allowed for vector_index_type')

    def fail_for(index_type):
        return hnsw_error if index_type == 'hnsw' else WeaviateConnectionError('connection refused')

    store, collections = _make_store(module, fail_for=fail_for)

    with pytest.raises(module.UnexpectedStatusCodeError) as raised:
        store._createCollection()

    assert raised.value is hnsw_error
    assert isinstance(raised.value.__cause__, WeaviateConnectionError)
    assert [call['vector_index_config']['type'] for call in collections.calls] == ['hnsw', 'hfresh']
