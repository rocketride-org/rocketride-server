"""A search that matches nothing still dispatches the documents lane.

DocumentStore.dispatchSearch sends an empty list on a miss, and the prompt and
guardrails nodes rely on that to tell "the search found nothing" from "this
pipeline has no search". The two paths this node runs itself (text search in
index mode, and OpenSearch vector search) used to send nothing on a miss, so a
retrieval miss there read as no retrieval at all and grounding was never enforced.
"""

import types
from unittest.mock import MagicMock

from nodes.store_elasticsearch.IInstance import IInstance
from nodes.store_elasticsearch.constants import BACKEND_ELASTICSEARCH, BACKEND_OPENSEARCH, CONTENT_FIELD, MODE_INDEX


def _question(text='What was net income?', embedding=None):
    return types.SimpleNamespace(questions=[types.SimpleNamespace(text=text, embedding=embedding)])


def _node(backend, hits):
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = types.SimpleNamespace(
        backend=backend,
        mode=MODE_INDEX,
        search_match_operator='or',
        search_exact_slop=0,
        search_highlight_enabled=False,
        search_highlight_fragment_size=200,
        collection='idx',
        vector_dim=3,
        score=0.0,
        store=MagicMock(index='idx', client=object(), search_text_all=MagicMock(return_value=hits)),
        client=MagicMock(
            search_text_all=MagicMock(return_value=hits),
            search_vector=MagicMock(return_value={'hits': {'hits': hits}}),
        ),
    )
    inst.instance = MagicMock()
    inst.instance.hasListener = lambda lane: lane == 'documents'
    return inst


def _hit():
    return {'_id': 'doc-1', '_score': 1.0, '_source': {CONTENT_FIELD: 'Net income was $93.7B.'}}


def test_a_text_search_miss_still_dispatches_an_empty_documents_list():
    for backend in (BACKEND_ELASTICSEARCH, BACKEND_OPENSEARCH):
        inst = _node(backend, hits=[])
        inst._handle_text_search(_question())

        inst.instance.writeDocuments.assert_called_once_with([])


def test_a_text_search_hit_still_dispatches_its_documents():
    inst = _node(BACKEND_ELASTICSEARCH, hits=[_hit()])
    inst._handle_text_search(_question())

    (docs,), _ = inst.instance.writeDocuments.call_args
    assert [d.page_content for d in docs] == ['Net income was $93.7B.']


def test_an_opensearch_vector_miss_still_dispatches_an_empty_documents_list():
    inst = _node(BACKEND_OPENSEARCH, hits=[])
    inst._handle_opensearch_vector_search(_question(embedding=[0.1, 0.2, 0.3]))

    inst.instance.writeDocuments.assert_called_once_with([])


def test_no_documents_listener_means_nothing_is_dispatched():
    """The lane is sent only when something listens on it, as dispatchSearch does."""
    inst = _node(BACKEND_ELASTICSEARCH, hits=[])
    inst.instance.hasListener = lambda lane: False
    inst._handle_text_search(_question())

    inst.instance.writeDocuments.assert_not_called()
