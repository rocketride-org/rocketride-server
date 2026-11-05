# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The tool set every vector store node offers, and its trash tools (contract section 4).

Agents and external (DAP) callers both see develop's six tools (``search``, ``upsert``,
``delete``, ``objdir``, ``get``, ``stats``) and #2704's three (``list_documents``,
``soft_delete``, ``restore``). Only DAP callers see the explorer's eight
(``dialect``, ``chunks``, ``vectors``, ``sample``, ``project``, ``neighbors``,
``recommend``, ``similarity_matrix``). ``documents`` became ``list_documents`` and
``remove_document`` is gone: ``delete`` is the only permanent delete.

The three tools #2704 also defines live on ``VectorStoreToolMixin`` itself, the class
#2704 edits. A merge of #2704 then gives a textual conflict or a duplicate method in
one class, which the duplicate scan catches, never a method on one class of the MRO
shadowing another's. The guard below holds every tool to one owner.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from ai.common.store import VectorStoreToolMixin, vx_write_gate
from ai.common.store.vx_defaults import VECTOR_TOOL_LIMITS
from ai.common.store.vx_types import TOOL_CODES

from .test_vector_hooks import CountingStore, ExactListingStore, make_doc
from .test_vector_write_gate import agent, dap
from .test_vectordb_tool_mixin import clustered, node

#: Listed for agents and for DAP callers.
AGENT_TOOLS = {'search', 'upsert', 'delete', 'objdir', 'get', 'stats', 'list_documents', 'soft_delete', 'restore'}

#: Listed for DAP callers only.
DAP_ONLY_TOOLS = {'dialect', 'chunks', 'vectors', 'sample', 'project', 'neighbors', 'recommend', 'similarity_matrix'}


@pytest.fixture
def context(monkeypatch):
    """Set the call context the write gate reads; None until a test sets one."""
    holder: Dict[str, Any] = {'ctx': None}
    monkeypatch.setattr(vx_write_gate, '_current_tool_call', lambda: holder['ctx'])

    def set_context(ctx: Any) -> None:
        holder['ctx'] = ctx

    return set_context


def _tool_owners() -> Dict[str, List[str]]:
    """Every class of the mixin's MRO that defines each tool method itself."""
    owners: Dict[str, List[str]] = {}
    for cls in VectorStoreToolMixin.__mro__:
        for name, value in vars(cls).items():
            if getattr(value, '__tool_meta__', None) is not None:
                owners.setdefault(name, []).append(cls.__qualname__)
    return owners


def _rows(store) -> Dict[tuple, bool]:
    """Every stored chunk (control record excluded) and whether it is in the trash."""
    return {key: bool(doc.metadata.isDeleted) for key, doc in store.rows.items() if key[0] != 'schema'}


# ---------------------------------------------------------------------------
# The tool set
# ---------------------------------------------------------------------------


def test_every_tool_is_defined_in_exactly_one_class_of_the_mixin():
    owners = _tool_owners()
    assert {name: classes for name, classes in owners.items() if len(classes) != 1} == {}
    assert set(owners) == AGENT_TOOLS | DAP_ONLY_TOOLS


def test_the_tools_2704_also_defines_live_on_the_class_it_edits():
    for name in ('list_documents', 'soft_delete', 'restore'):
        assert name in VectorStoreToolMixin.__dict__, name
    owners = _tool_owners()
    assert all(owners[name] == ['VectorStoreToolMixin'] for name in AGENT_TOOLS), owners


def test_agents_see_nine_tools_and_dap_callers_seventeen():
    owners = _tool_owners()
    for name in owners:
        audience = getattr(getattr(VectorStoreToolMixin, name), '__tool_meta__')['audience']
        expected = ('agent', 'dap') if name in AGENT_TOOLS else ('dap',)
        assert tuple(audience) == expected, (name, audience)


def test_documents_and_remove_document_are_gone():
    assert not hasattr(VectorStoreToolMixin, 'documents')
    assert not hasattr(VectorStoreToolMixin, 'remove_document')


def test_the_write_tools_are_hidden_with_allow_write_off():
    assert vx_write_gate.WRITE_TOOLS == ('upsert', 'delete', 'soft_delete', 'restore')
    store = clustered(CountingStore, docs=2, chunks=2)
    offered = set(node(store)._collect_tool_methods())
    assert set(vx_write_gate.WRITE_TOOLS) <= offered and 'list_documents' in offered
    hidden = set(node(store, allow_write=False)._collect_tool_methods())
    assert hidden.isdisjoint(vx_write_gate.WRITE_TOOLS) and 'list_documents' in hidden


def test_in_trash_is_a_documented_code():
    assert 'IN_TRASH' in TOOL_CODES


# ---------------------------------------------------------------------------
# list_documents
# ---------------------------------------------------------------------------


def test_list_documents_is_the_directory_listing():
    answer = node(clustered(docs=3, chunks=2)).list_documents({})
    assert answer['success'] is True
    assert [item['objectId'] for item in answer['items']] == ['doc00', 'doc01', 'doc02']
    assert {'next_cursor', 'total', 'counts_exact', 'distinct', 'sorted', 'caveats'} <= set(answer)
    assert answer['items'][0]['chunks'] == 2


def test_list_documents_takes_2704_s_boolean_deleted(context):
    context(dap())
    store = clustered(docs=3, chunks=2)
    inst = node(store, allow_writes=True)
    inst.soft_delete({'object_ids': ['doc01']})
    trash = inst.list_documents({'deleted': 'deleted'})
    assert [item['objectId'] for item in trash['items']] == ['doc01']
    assert inst.list_documents({'deleted': True})['items'] == trash['items']
    assert [item['objectId'] for item in inst.list_documents({'deleted': False})['items']] == ['doc00', 'doc02']
    assert len(inst.list_documents({'deleted': 'all'})['items']) == 3


def test_list_documents_filters_by_an_exact_parent():
    store = ExactListingStore().seed(
        [make_doc(f'd{i}', 0, path='/docs/same.md') for i in range(3)]
        + [make_doc('longer', 0, path='/docs/same.md.bak'), make_doc('other', 0, path='/x.md')]
    )
    answer = node(store).list_documents({'parent': '/docs/same.md'})
    assert [item['objectId'] for item in answer['items']] == ['d0', 'd1', 'd2']
    assert answer['total'] is None, 'the page total counts the whole listing, so it is not given'
    assert node(store).list_documents({'parent': '/docs/'})['items'] == []
    refused = node(store).list_documents({'parent': 5})
    assert (refused['success'], refused['code']) == (False, 'INVALID_INPUT')


def test_list_documents_refuses_an_offset_and_names_the_cursor():
    inst = node(clustered(docs=3, chunks=1))
    assert inst.list_documents({'offset': 0})['success'] is True
    refused = inst.list_documents({'offset': 2})
    assert (refused['success'], refused['code']) == (False, 'INVALID_INPUT')
    assert 'cursor' in refused['error']


# ---------------------------------------------------------------------------
# soft_delete and restore
# ---------------------------------------------------------------------------


def test_soft_delete_moves_documents_to_the_trash_and_says_what_it_moved(context):
    context(dap(auth='task'))
    store = clustered(CountingStore, docs=3, chunks=2)
    answer = node(store, allow_writes=True).soft_delete({'object_ids': ['doc01', 'doc01', 'ghost']})
    assert answer['success'] is True, answer
    assert (answer['object_ids'], answer['matched_chunks'], answer['not_found']) == (['doc01', 'ghost'], 2, ['ghost'])
    assert answer['moved_chunks'] == 2
    audit = answer['audit']
    assert (audit['action'], audit['object_ids'], audit['rows']) == ('vector.soft_delete', ['doc01', 'ghost'], 2)
    assert audit['caller'] == {'auth': 'task', 'userId': 'u-0001', 'teamId': 't-0001'}
    rows = _rows(store)
    assert rows[('doc01', 0)] and rows[('doc01', 1)] and not rows[('doc00', 0)]
    assert len(rows) == 6, 'nothing is removed'


def test_restore_takes_documents_out_of_the_trash_and_a_live_one_is_a_no_op(context):
    context(dap())
    store = clustered(CountingStore, docs=3, chunks=2)
    inst = node(store, allow_writes=True)
    inst.soft_delete({'object_ids': ['doc01']})
    answer = inst.restore({'object_ids': ['doc01', 'doc02']})
    assert answer['success'] is True, answer
    # matched_chunks is every chunk the store holds for the ids (doc02 is live already); moved_chunks is what came out.
    assert (answer['object_ids'], answer['matched_chunks'], answer['not_found']) == (['doc01', 'doc02'], 4, [])
    assert answer['moved_chunks'] == 2
    assert answer['audit']['action'] == 'vector.restore'
    assert not any(_rows(store).values())
    again = inst.restore({'object_ids': ['doc00']})
    assert (again['success'], again['matched_chunks'], again['moved_chunks'], again['not_found']) == (True, 2, 0, [])


def test_an_agent_soft_deletes_with_allow_write_alone(context):
    context(agent())
    store = clustered(CountingStore, docs=2, chunks=2)
    answer = node(store, allow_writes=False).soft_delete({'object_ids': ['doc00']})
    assert answer['success'] is True and (answer['matched_chunks'], answer['moved_chunks']) == (2, 2), answer
    assert answer['audit']['caller'] == {'auth': 'agent', 'userId': None, 'teamId': None}


@pytest.mark.parametrize(
    'ctx,switches,code',
    [
        (None, {'allow_writes': True}, 'WRITES_UNKNOWN_CALLER'),
        (dap(), {}, 'WRITES_DISABLED'),
        (dap(source_type='chat'), {'allow_writes': True}, 'WRITES_SOURCE'),
        (dap(auth='public'), {'allow_writes': True}, 'WRITES_PUBLIC'),
        (dap(targeted=False), {'allow_writes': True}, 'WRITES_BROADCAST'),
        (agent(), {'allow_write': False}, None),
    ],
)
@pytest.mark.parametrize('tool', ['soft_delete', 'restore'])
def test_refused_trash_writes_leave_the_data_unchanged(context, ctx, switches, code, tool):
    context(ctx)
    store = clustered(CountingStore, docs=2, chunks=2)
    store.markDeleted(['doc01'])
    before = _rows(store)
    answer = getattr(node(store, **switches), tool)({'object_ids': ['doc00', 'doc01']})
    assert (answer['success'], answer.get('code')) == (False, code), answer
    assert _rows(store) == before


@pytest.mark.parametrize('tool', ['soft_delete', 'restore'])
def test_the_trash_writes_refuse_the_control_record_and_check_the_input_after_the_gate(context, tool):
    inst = node(clustered(CountingStore, docs=1, chunks=1), allow_writes=True)
    context(None)
    assert getattr(inst, tool)({'object_ids': 'doc00'})['code'] == 'WRITES_UNKNOWN_CALLER'
    context(dap())
    assert getattr(inst, tool)({'object_ids': ['schema']})['code'] == 'RESERVED_ID'
    for bad in ({}, {'object_ids': []}, {'object_ids': 'doc00'}, {'object_ids': ['  ']}):
        assert getattr(inst, tool)(bad)['code'] == 'INVALID_INPUT', bad
    too_many = {'object_ids': [f'd{i}' for i in range(VECTOR_TOOL_LIMITS['write_ids_max'] + 1)]}
    assert getattr(inst, tool)(too_many)['code'] == 'INVALID_INPUT'


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------


def test_delete_answers_kept_live_and_removes_trashed_documents_only_when_asked(context):
    context(dap())
    store = clustered(CountingStore, docs=3, chunks=2)
    inst = node(store, allow_writes=True)
    inst.soft_delete({'object_ids': ['doc00', 'doc01']})
    # A later ingest batch adds a live chunk to doc01 after it went to the trash.
    store.addChunks([make_doc('doc01', 2, path=store.rows[('doc01', 0)].metadata.parent, dim=8)])
    answer = inst.delete({'object_ids': ['doc00', 'doc01', 'ghost'], 'deleted_only': True})
    assert answer['success'] is True, answer
    assert (answer['kept_live'], answer['not_found'], answer['removed_chunks']) == (['doc01'], ['ghost'], 2)
    assert answer['audit']['action'] == 'vector.delete'
    assert answer['audit']['object_ids'] == ['doc00', 'doc01', 'ghost'], 'the audit names every id the call named'
    keys = set(_rows(store))
    assert not any(key[0] == 'doc00' for key in keys)
    assert {('doc01', 0), ('doc01', 1), ('doc01', 2)} <= keys, 'a partly trashed document is left whole'
    plain = inst.delete({'object_ids': ['doc02']})
    assert plain['success'] is True and plain['kept_live'] == [] and plain['removed_chunks'] == 2


def test_delete_refuses_a_deleted_only_that_is_not_a_boolean(context):
    context(dap())
    answer = node(clustered(CountingStore, docs=1, chunks=1), allow_writes=True).delete(
        {'object_ids': ['doc00'], 'deleted_only': 'yes'}
    )
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT')


# ---------------------------------------------------------------------------
# What a trash write costs (contract section 4.5)
# ---------------------------------------------------------------------------

#: The most object_ids an agent sends soft_delete, restore or delete {deleted_only} in one call.
AGENT_IDS_MAX = 1000


def _count_calls(store, deleted=None):
    """The filtered counts the store was asked for (of one ``deleted`` selection when given)."""
    return [
        call
        for call in store.calls
        if call[0] in ('countChunks', 'countDocumentsWhere') and (deleted is None or call[1].deleted == deleted)
    ]


def test_the_agent_cap_is_a_documented_constant():
    from ai.common.store import vx_defaults

    assert getattr(vx_defaults, 'AGENT_WRITE_IDS_MAX', None) == AGENT_IDS_MAX
    assert 'AGENT_WRITE_IDS_MAX' not in VECTOR_TOOL_LIMITS, 'not a dialect limit: the app writes as a DAP caller'


@pytest.mark.parametrize('tool', ['soft_delete', 'restore', 'empty_trash'])
def test_an_agent_sends_at_most_a_thousand_ids_per_trash_write(context, tool):
    context(agent())
    store = clustered(CountingStore, docs=2, chunks=2)
    store.markDeleted(['doc01'])
    before = _rows(store)
    inst = node(store)
    ids = ['doc00', 'doc01'] + [f'ghost{n:04d}' for n in range(AGENT_IDS_MAX - 1)]
    call = (lambda args: inst.delete({**args, 'deleted_only': True})) if tool == 'empty_trash' else getattr(inst, tool)
    store.calls.clear()
    refused = call({'object_ids': ids})
    assert (refused['success'], refused.get('code')) == (False, 'INVALID_INPUT'), refused
    assert f'1 to {AGENT_IDS_MAX} strings' in refused['error'], refused
    assert _rows(store) == before and _count_calls(store) == [], 'refused before anything is read'
    assert call({'object_ids': ids[:AGENT_IDS_MAX]})['success'] is True


def test_an_agent_s_plain_delete_keeps_develop_s_open_list(context):
    context(agent())
    store = clustered(CountingStore, docs=2, chunks=2)
    ids = ['doc00'] + [f'ghost{n:04d}' for n in range(AGENT_IDS_MAX)]
    answer = node(store).delete({'object_ids': ids})
    assert answer['success'] is True and answer['removed_chunks'] == 2, answer


@pytest.mark.parametrize('tool', ['soft_delete', 'restore'])
def test_a_trash_write_of_stored_documents_counts_them_once(context, tool):
    context(agent())
    store = clustered(CountingStore, docs=300, chunks=2)
    if tool == 'restore':
        store.markDeleted([key[0] for key in _rows(store)])
    ids = sorted({key[0] for key in _rows(store)})
    store.calls.clear()
    answer = getattr(node(store), tool)({'object_ids': ids})
    assert (answer['success'], answer['matched_chunks'], answer['moved_chunks']) == (True, 600, 600), answer
    assert answer['not_found'] == []
    # One count of the documents (not_found) and one of the chunks (matched_chunks): never one per id.
    assert len(_count_calls(store)) == 2, _count_calls(store)


def test_a_trash_write_still_names_the_unknown_ids(context):
    context(agent())
    store = clustered(CountingStore, docs=150, chunks=1)
    ids = sorted({key[0] for key in _rows(store)}) + ['ghost-a', 'ghost-b']
    answer = node(store).soft_delete({'object_ids': ids})
    assert (answer['success'], answer['matched_chunks'], answer['not_found']) == (True, 150, ['ghost-a', 'ghost-b'])
    assert answer['moved_chunks'] == 150


def test_emptying_a_trash_of_wholly_trashed_documents_checks_them_once(context):
    context(dap())
    store = clustered(CountingStore, docs=100, chunks=2)
    ids = sorted({key[0] for key in _rows(store)})
    store.markDeleted(ids)
    store.calls.clear()
    answer = node(store, allow_writes=True).delete({'object_ids': ids, 'deleted_only': True})
    assert (answer['success'], answer['kept_live'], answer['removed_chunks']) == (True, [], 200), answer
    assert len(_count_calls(store, 'active')) == 1, 'one live check for the whole list'
    assert _rows(store) == {}


# ---------------------------------------------------------------------------
# stats, get, chunks and dialect
# ---------------------------------------------------------------------------


def test_stats_counts_the_documents_in_the_trash():
    store = clustered(CountingStore, docs=3, chunks=2)
    inst = node(store)
    assert inst.stats({})['deleted_documents'] == 0
    store.markDeleted(['doc01'])
    full = inst.stats({'mode': 'quick'})
    assert (full['documents'], full['deleted_documents']) == (2, 1), 'a trash write drops the cached figures'
    store.rows[('doc02', 1)].metadata.isDeleted = True  # one chunk of doc02 in the trash
    assert inst.stats({'mode': 'full'})['deleted_documents'] == 2
    from .test_vector_hooks import MemoryStore

    assert node(MemoryStore()).stats({})['deleted_documents'] is None


def test_get_and_chunks_tell_a_trashed_document_from_an_unknown_one():
    store = clustered(CountingStore, docs=2, chunks=2)
    store.markDeleted(['doc01'])
    inst = node(store)
    # get keeps #2704's wording (and its not-found failure), chunks the contract's.
    for tool, message in (
        ('get', "get: document 'doc01' is soft-deleted; restore it to read it"),
        ('chunks', "chunks: the document 'doc01' is in the trash; restore it to read it"),
    ):
        answer = getattr(inst, tool)({'object_id': 'doc01'})
        assert answer == {'success': False, 'code': 'IN_TRASH', 'error': message, 'object_id': 'doc01'}
    unknown = inst.get({'object_id': 'ghost'})
    assert unknown == {
        'success': False,
        'code': 'NOT_FOUND',
        'error': "get: no document with object_id 'ghost'",
        'object_id': 'ghost',
    }
    assert inst.chunks({'object_id': 'ghost'})['code'] == 'NOT_FOUND'
    trashed = inst.chunks({'object_id': 'doc01', 'deleted': 'deleted'})
    assert trashed['success'] is True and [item['chunkId'] for item in trashed['items']] == [0, 1]


def test_get_of_a_partly_trashed_document_reads_its_live_chunks():
    store = clustered(CountingStore, docs=1, chunks=3)
    store.rows[('doc00', 1)].metadata.isDeleted = True
    answer = node(store).get({'object_id': 'doc00'})
    assert answer['success'] is True and [chunk['chunkId'] for chunk in answer['chunks']] == [0, 2]


def test_dialect_reports_soft_delete_and_the_four_write_tools():
    answer = node(clustered(docs=1, chunks=1)).dialect({})
    assert answer['capabilities']['soft_delete'] is True
    assert answer['write_tools'] == ['upsert', 'delete', 'soft_delete', 'restore']


# ---------------------------------------------------------------------------
# Retrieval leaves the trash out, and the cached sample does not outlive a trash write
# ---------------------------------------------------------------------------


def test_search_sample_neighbors_and_recommend_leave_trashed_chunks_out():
    store = clustered(docs=4, chunks=3)
    store.markDeleted(['doc01'])
    inst = node(store)
    by_vector = inst.search({'vector': store.rows[('doc01', 0)].embedding, 'top_k': 20, 'include_below_floor': True})
    assert by_vector['success'] is True and by_vector['results']
    assert all(item['metadata']['objectId'] != 'doc01' for item in by_vector['results'])
    sample = inst.sample({'n': 12, 'seed': 3})
    assert sample['success'] is True and 'doc01' not in {doc['objectId'] for doc in sample['docs']}
    near = inst.neighbors({'key': ['doc00', 0], 'm': 20})
    assert near['success'] is True and all(item['key'][0] != 'doc01' for item in near['items'])
    rec = inst.recommend({'positive': [['doc00', 0]], 'k': 20})
    assert rec['success'] is True and all(item['key'][0] != 'doc01' for item in rec['items'])


@pytest.mark.parametrize('write', ['markDeleted', 'markActive', 'remove'])
def test_a_trash_write_or_a_removal_drops_the_cached_sample(write):
    store = clustered(docs=4, chunks=3)
    inst = node(store)
    sample = inst.sample({'n': 8, 'seed': 1})
    assert inst.project({'sample_id': sample['sample_id'], 'keys': [['doc00', 0]]})['success'] is True
    getattr(store, write)(['doc02'])
    expired = inst.project({'sample_id': sample['sample_id'], 'keys': [['doc00', 0]]})
    assert (expired['success'], expired['code']) == (False, 'SAMPLE_EXPIRED')


def test_an_upload_keeps_the_cached_sample():
    store = clustered(docs=4, chunks=3)
    inst = node(store)
    sample = inst.sample({'n': 8, 'seed': 1})
    store.addChunks([make_doc('new', 0, vector=[1.0] + [0.0] * 7)])
    assert inst.project({'sample_id': sample['sample_id'], 'keys': [['doc00', 0]]})['success'] is True
