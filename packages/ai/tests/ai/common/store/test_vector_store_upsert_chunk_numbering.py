"""upsert on VectorStoreToolMixin: chunk numbering within one call (#2587).

Before this change every document without an explicit chunkId was stored as
chunk 0, so several chunks sent for one object ID all became chunk 0 and get
returned them in no defined order. Now the chunks sent for one object are
numbered in the order given, an explicit chunkId is kept and may not repeat
within the call, and the store's control row cannot be overwritten.
"""

import pytest

from ._vectordb_tool_harness import Tools, make_store


def _doc(object_id, content, chunk_id=None, **metadata):
    doc = {'content': content, 'object_id': object_id, 'embedding': [0.1, 0.2], 'embedding_model': 'test-model'}
    if chunk_id is not None or metadata:
        doc['metadata'] = dict(metadata)
        if chunk_id is not None:
            doc['metadata']['chunkId'] = chunk_id
    return doc


def _written(store):
    (chunks,) = store.addChunks.call_args.args
    return [(doc.metadata.objectId, doc.metadata.chunkId, doc.page_content) for doc in chunks]


def test_chunks_sent_without_numbers_are_numbered_in_order_per_object():
    store = make_store()

    result = Tools(store).upsert({'documents': [_doc('a', 'a0'), _doc('b', 'b0'), _doc('a', 'a1'), _doc('a', 'a2')]})

    assert result == {'success': True, 'count': 4, 'skipped': 0}
    assert _written(store) == [('a', 0, 'a0'), ('b', 0, 'b0'), ('a', 1, 'a1'), ('a', 2, 'a2')]


def test_a_single_document_without_a_number_is_chunk_zero_as_before():
    store = make_store()

    Tools(store).upsert({'documents': [_doc('a', 'only')]})

    assert _written(store) == [('a', 0, 'only')]


def test_explicit_numbers_are_kept_and_the_rest_fill_the_gaps():
    store = make_store()

    Tools(store).upsert(
        {'documents': [_doc('a', 'x', chunk_id=0), _doc('a', 'y'), _doc('a', 'z', chunk_id=1), _doc('a', 'w')]}
    )

    assert _written(store) == [('a', 0, 'x'), ('a', 2, 'y'), ('a', 1, 'z'), ('a', 3, 'w')]


def test_an_integer_string_is_accepted_like_the_paging_arguments():
    store = make_store()

    Tools(store).upsert({'documents': [_doc('a', 'x', chunk_id='3')]})

    assert _written(store) == [('a', 3, 'x')]


def test_other_metadata_is_stored_as_before():
    store = make_store()

    Tools(store).upsert({'documents': [_doc('a', 'x', parent='/reports/a.pdf', nodeId='ingest')]})

    (chunks,) = store.addChunks.call_args.args
    assert (chunks[0].metadata.parent, chunks[0].metadata.nodeId, chunks[0].metadata.chunkId) == (
        '/reports/a.pdf',
        'ingest',
        0,
    )


def test_an_explicit_number_may_not_repeat_within_the_call():
    store = make_store()

    result = Tools(store).upsert(
        {'documents': [_doc('a', 'x', chunk_id=1), _doc('b', 'y'), _doc('a', 'z', chunk_id=1)]}
    )

    assert result == {'success': False, 'error': "upsert: document 'a' lists chunkId 1 more than once"}
    store.addChunks.assert_not_called()


def test_the_same_number_on_different_objects_is_fine():
    store = make_store()

    result = Tools(store).upsert({'documents': [_doc('a', 'x', chunk_id=1), _doc('b', 'y', chunk_id=1)]})

    assert result['success'] is True
    assert _written(store) == [('a', 1, 'x'), ('b', 1, 'y')]


@pytest.mark.parametrize('chunk_id', [-1, True, 1.5, 'three', [1]], ids=['negative', 'bool', 'float', 'text', 'list'])
def test_a_bad_chunk_number_fails_before_any_write(chunk_id):
    store = make_store()

    result = Tools(store).upsert({'documents': [_doc('b', 'fine'), _doc('a', 'x', chunk_id=chunk_id)]})

    assert result['success'] is False
    assert result['error'].startswith('upsert') and "(document 'a')" in result['error']
    store.addChunks.assert_not_called()


def test_metadata_must_be_an_object():
    store = make_store()
    doc = _doc('a', 'x')
    doc['metadata'] = 'parent=/x'

    result = Tools(store).upsert({'documents': [doc]})

    assert result == {'success': False, 'error': "upsert: metadata must be an object (document 'a')"}
    store.addChunks.assert_not_called()


def test_the_control_row_cannot_be_overwritten():
    store = make_store()

    result = Tools(store).upsert({'documents': [_doc('a', 'fine'), _doc('schema', 'x')]})

    assert result['success'] is False and 'reserved' in result['error']
    store.addChunks.assert_not_called()


def test_skipped_documents_take_no_number():
    store = make_store()

    result = Tools(store).upsert(
        {'documents': [_doc('a', 'a0'), {'content': '', 'object_id': 'a'}, 'not a document', _doc('a', 'a1')]}
    )

    assert result == {'success': True, 'count': 2, 'skipped': 2}
    assert _written(store) == [('a', 0, 'a0'), ('a', 1, 'a1')]


def test_a_missing_embedder_is_still_reported_after_numbering():
    store = make_store()
    docs = [{'content': 'x', 'object_id': 'a'}, {'content': 'y', 'object_id': 'a'}]

    result = Tools(store).upsert({'documents': docs})

    assert result['success'] is False and 'embedding' in result['error']
    store.addChunks.assert_not_called()
