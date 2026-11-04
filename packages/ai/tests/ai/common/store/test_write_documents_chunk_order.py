# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""StoreInstanceBase.writeDocuments warns when chunk 0 of an object arrives late (#1986).

A store deletes an object's stored chunks when a batch holds its chunk 0, so a
producer must send chunk 0 first. If it arrives after other batches of the
same object, those batches are deleted; the documents lane now says so
instead of losing them silently. The state is per object: it resets when the
next object opens.
"""

from types import SimpleNamespace

import pytest

import ai.common.store.store_instance_base as sib
from ai.common.schema import Doc, DocMetadata
from ai.common.store.store_instance_base import StoreInstanceBase


class _Instance(StoreInstanceBase):
    """Concrete StoreInstanceBase."""


class _Store:
    """Records each batch handed to ``addChunks``."""

    def __init__(self):
        """No batches yet."""
        self.batches = []

    def addChunks(self, documents):
        """Record a batch.

        Args:
            documents: The batch.
        """
        self.batches.append(documents)


@pytest.fixture
def warnings(monkeypatch):
    """Capture the warnings the documents lane logs."""
    captured = []
    monkeypatch.setattr(sib, 'warning', captured.append)
    return captured


def _instance():
    """Return an instance with a recording store, opened on a first object."""
    inst = _Instance.__new__(_Instance)
    # A filter in the pipe, not its endpoint: IInstanceTransform.open has nothing else to do
    inst.IGlobal = SimpleNamespace(store=_Store(), glb=SimpleNamespace(logicalType='store'))
    inst.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(logicalType='source'))
    inst.open(None)
    return inst


def _box(object_id, chunk_ids):
    """Return one batch of an object's chunks.

    Args:
        object_id: The object.
        chunk_ids: The chunk numbers in the batch.

    Returns:
        The documents.
    """
    return [Doc(page_content='text', metadata=DocMetadata(objectId=object_id, chunkId=i)) for i in chunk_ids]


def test_chunk_zero_first_is_silent(warnings):
    """The order every stock producer uses: chunk 0 in the first batch, no warning."""
    inst = _instance()
    for chunk_ids in (range(0, 64), range(64, 128), range(128, 153)):
        inst.writeDocuments(_box('big', chunk_ids))
    assert warnings == []
    assert len(inst.IGlobal.store.batches) == 3


def test_chunk_zero_after_other_chunks_warns(warnings):
    """Chunk 0 after chunks of the same object: the earlier ones are about to be deleted, so warn."""
    inst = _instance()
    inst.writeDocuments(_box('big', range(128, 153)))
    inst.writeDocuments(_box('big', range(64, 128)))
    assert warnings == []
    inst.writeDocuments(_box('big', range(0, 64)))
    assert len(warnings) == 1
    assert 'Chunk 0 of big arrived after other chunks' in warnings[0]
    # The write still happens, as before
    assert len(inst.IGlobal.store.batches) == 3


def test_another_object_does_not_warn(warnings):
    """Chunk 0 of one object after chunks of a different object is an ordinary start."""
    inst = _instance()
    inst.writeDocuments(_box('a', [3, 4]))
    inst.writeDocuments(_box('b', [0, 1]))
    assert warnings == []


def test_the_state_resets_when_the_next_object_opens(warnings):
    """Re-ingesting an object as a new pipeline object starts clean: its chunk 0 replaces, without a warning."""
    inst = _instance()
    inst.writeDocuments(_box('big', [0, 1]))
    inst.open(None)
    inst.writeDocuments(_box('big', [0, 1]))
    assert warnings == []
