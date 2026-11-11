# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for DocumentStoreBase.objectIdsToReplace (#1986).

A store deletes an object's stored chunks before a write only when the batch
holds that object's chunk 0; a later batch of the same object adds to it.
"""

from ai.common.schema import Doc, DocMetadata
from ai.common.store import DocumentStoreBase


def _chunk(object_id: str, chunk_id: int) -> Doc:
    """Build one chunk of an object.

    Args:
        object_id: The object the chunk belongs to.
        chunk_id: The chunk's number within the object.

    Returns:
        The document.
    """
    return Doc(page_content='text', metadata=DocMetadata(objectId=object_id, chunkId=chunk_id))


def test_an_object_with_chunk_zero_is_replaced():
    """The batch that starts an object replaces what was stored for it."""
    assert DocumentStoreBase.objectIdsToReplace([_chunk('a', 0), _chunk('a', 1)]) == ['a']


def test_an_object_without_chunk_zero_is_kept():
    """A later batch of an object (chunks 64.. of a large one) deletes nothing."""
    assert DocumentStoreBase.objectIdsToReplace([_chunk('a', 64), _chunk('a', 65)]) == []


def test_each_object_is_judged_on_its_own_chunks():
    """One batch can start one object and continue another; the order of first appearance is kept."""
    chunks = [_chunk('b', 0), _chunk('c', 7), _chunk('a', 0), _chunk('b', 1)]
    assert DocumentStoreBase.objectIdsToReplace(chunks) == ['b', 'a']


def test_an_object_with_chunk_zero_twice_is_listed_once():
    """Two chunk 0s of one object in a batch still delete it once."""
    assert DocumentStoreBase.objectIdsToReplace([_chunk('a', 0), _chunk('a', 0), _chunk('a', 1)]) == ['a']


def test_an_empty_batch_replaces_nothing():
    """No chunks, no objects to delete."""
    assert DocumentStoreBase.objectIdsToReplace([]) == []
