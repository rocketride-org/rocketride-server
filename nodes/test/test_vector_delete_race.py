# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""``delete {deleted_only}`` never removes a chunk a concurrent restore made live (D6-VX-1).

The permanent delete used to check which ids still have a live chunk, then delete by id in every state:
a restore between the two steps lost its document for good. The delete is now conditional on the trashed
state inside the store operation (``removeTrashed``). The interleaving is forced here: the live check runs,
a restore of the same id runs through a second node instance, then the delete continues.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from ai.common.store import vx_write_gate
from ai.common.store.document_store import DocumentStoreBase

from .test_vector_partly_trashed import KINDS, _node, _states, _store
from .test_vector_write_gate import agent

DOC = 'raced-doc'
OTHER = 'plain-doc'


@pytest.fixture
def context(monkeypatch):
    monkeypatch.setattr(vx_write_gate, '_current_tool_call', lambda: agent())


def _race(kind: str, restore: bool = True) -> Dict[str, Any]:
    store, docs, model, logical = _store(kind)
    store.addChunks(docs(DOC, [0, 1]) + docs(OTHER, [0, 1]))
    writer = _node(store, logical, model)  # the instance serving "Empty trash"
    other = _node(store, logical, model)  # another pooled instance serving a Restore
    assert writer.soft_delete({'object_ids': [DOC, OTHER]})['success']
    assert set(_states(store, DOC).values()) == {True}

    original = writer._vx_with_live_chunk

    def check_then_restore(st, ids):
        kept = original(st, ids)
        if restore:
            assert other.restore({'object_ids': [DOC]})['success']
        return kept

    writer._vx_with_live_chunk = check_then_restore
    answer = writer.delete({'object_ids': [DOC, OTHER], 'deleted_only': True})
    return {'answer': answer, 'doc': _states(store, DOC), 'other': _states(store, OTHER)}


@pytest.mark.parametrize('kind', KINDS)
def test_a_restore_between_the_live_check_and_the_delete_keeps_its_document(context, kind):
    out = _race(kind)
    answer = out['answer']
    assert answer['success'] is True, answer
    # The restored document survives, whole and live, and the answer says it was kept.
    assert out['doc'] == {0: False, 1: False}, (kind, out)
    assert answer['kept_live'] == [DOC], (kind, answer)
    # The other, still-trashed document is deleted for good.
    assert out['other'] == {}, (kind, out)
    # removed_chunks is what the store actually deleted (null on a store that does not count).
    assert answer['removed_chunks'] in (2, None), (kind, answer)


@pytest.mark.parametrize('kind', KINDS)
def test_without_a_race_the_trashed_documents_are_deleted_and_nothing_is_kept(context, kind):
    out = _race(kind, restore=False)
    answer = out['answer']
    assert (out['doc'], out['other']) == ({}, {}), (kind, out)
    assert answer['kept_live'] == [] and answer['removed_chunks'] in (4, None), (kind, answer)


def test_a_store_without_a_conditional_delete_refuses_deleted_only(context):
    """The base has no unsafe default (a delete by id would remove live chunks): the tool answers UNSUPPORTED."""
    from .test_vector_hooks import MemoryStore

    class NoConditionalDelete(MemoryStore):
        removeTrashed = DocumentStoreBase.removeTrashed

    store = NoConditionalDelete()
    store.addChunks([_doc(DOC, 0)])
    node = _node(store, 'postgres', 'test-model')
    assert node.soft_delete({'object_ids': [DOC]})['success']
    answer = node.delete({'object_ids': [DOC], 'deleted_only': True})
    assert (answer['success'], answer['code']) == (False, 'UNSUPPORTED'), answer
    assert set(_states(store, DOC).values()) == {True}, 'the trashed document is left alone'
    # A plain permanent delete (no deleted_only) is unchanged.
    assert node.delete({'object_ids': [DOC]})['success'] is True


def _doc(object_id, chunk_id):
    from . import test_vector_hooks as hooks

    return hooks.make_doc(object_id, chunk_id)
