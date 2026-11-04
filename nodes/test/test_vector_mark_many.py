# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""markDeleted and markActive move every chunk of a large set of documents, and count exactly what they moved.

A driver that reads the chunks to mark with one query marks only what that query
returns: past the backend's default page (100 rows on the pymilvus mock, 10 objects
on Weaviate) the rest stays where it was, and a repeat call reads the rows it already
marked and moves nothing. Here 153 documents (306 chunks) go to the trash and come
back on every driver the suites can run without a server.
"""

from __future__ import annotations

from typing import Dict

import pytest

from ai.common.store import vx_write_gate

from .test_vector_partly_trashed import KINDS, _node, _states, _store
from .test_vector_write_gate import agent

DOCS = [f'many-{n:03d}' for n in range(153)]


@pytest.fixture
def context(monkeypatch):
    monkeypatch.setattr(vx_write_gate, '_current_tool_call', lambda: agent())


def _trashed(store) -> Dict[bool, int]:
    """How many chunks of DOCS are in the trash (True) and out of it (False)."""
    out = {True: 0, False: 0}
    for oid in DOCS:
        for in_trash in _states(store, oid).values():
            out[in_trash] += 1
    return out


@pytest.mark.parametrize('kind', KINDS)
def test_a_soft_delete_and_a_restore_of_153_documents_move_all_306_chunks(context, kind):
    store, docs, model, logical = _store(kind)
    for start in range(0, len(DOCS), 50):
        store.addChunks([chunk for oid in DOCS[start : start + 50] for chunk in docs(oid, [0, 1])])
    tools = _node(store, logical, model)
    assert _trashed(store) == {True: 0, False: 306}, kind

    moved = tools.soft_delete({'object_ids': DOCS})
    assert moved['success'] and moved['not_found'] == [], moved
    assert moved['moved_chunks'] in (306, None), (kind, moved['moved_chunks'])
    assert moved['matched_chunks'] in (306, None), (kind, moved['matched_chunks'])
    assert _trashed(store) == {True: 306, False: 0}, kind
    again = tools.soft_delete({'object_ids': DOCS})
    # Nothing moves the second time; a store that counts still holds the 306 chunks the ids name, and one that
    # cannot count answers what its driver reported (0 moved).
    assert again['moved_chunks'] in (0, None), (kind, again['moved_chunks'])
    assert again['matched_chunks'] in (0, 306, None), (kind, again['matched_chunks'])

    back = tools.restore({'object_ids': DOCS})
    assert back['moved_chunks'] in (306, None), (kind, back['moved_chunks'])
    assert back['matched_chunks'] in (306, None), (kind, back['matched_chunks'])
    assert _trashed(store) == {True: 0, False: 306}, kind
