"""
Tests for Milvus Store.searchSemantic score filtering.

As on develop, the driver drops hits below the node's ``score`` threshold
(``threshold_search``) for every caller that does not set ``DocFilter.minScore``:
the ``questions`` lane (which applies the same threshold again) and the agent
``search`` tool. A caller that sets ``minScore`` (the Vector Explorer, for its
neighbours view and ``include_below_floor``) gets every hit down to it instead.
"""

import math

import pytest

from ai.common.schema import DocFilter, QuestionText

from .. import vector_other_drivers_harness as h
from ..test_vectordb_tool_mixin import node


@pytest.fixture(scope='module')
def adapter():
    """Milvus driver loaded against the pymilvus mock."""
    return h.MilvusAdapter()


@pytest.fixture
def store(adapter):
    """A store holding four chunks, with the node's default threshold of 0.5."""
    store = adapter.new_store()
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2, 3])
    assert store.threshold_search == 0.5
    return store


def _search(store, doc_filter):
    query = QuestionText(text='q', embedding=h.vector_for('q', 0), embedding_model=h.MODEL)
    return [doc.score for doc in store.searchSemantic(query, doc_filter)]


def test_hits_below_the_threshold_are_dropped(adapter, store):
    """0.1 and 0.3 are under the 0.5 threshold (develop's rule)."""
    adapter.set_scores(store, [0.6, 0.1, 0.8, 0.3])
    assert _search(store, DocFilter()) == pytest.approx([0.6, 0.8])


def test_a_hit_scoring_exactly_the_threshold_is_kept(adapter, store):
    adapter.set_scores(store, [0.5, 0.49])
    assert _search(store, DocFilter()) == pytest.approx([0.5])


def test_the_cut_follows_the_node_threshold(adapter, store):
    """The configured threshold decides, below the 0.2 floor too, as on develop."""
    store.threshold_search = 0.9
    adapter.set_scores(store, [0.6, 0.95])
    assert _search(store, DocFilter()) == pytest.approx([0.95])
    store.threshold_search = 0.1
    adapter.set_scores(store, [0.6, 0.15, 0.05])
    assert _search(store, DocFilter()) == pytest.approx([0.6, 0.15])


def test_min_score_minus_infinity_keeps_every_hit(adapter, store):
    """The explorer's neighbours view asks for every row."""
    adapter.set_scores(store, [0.6, 0.05, 0.0])
    assert _search(store, h.VxFilter(minScore=-math.inf)) == pytest.approx([0.6, 0.05, 0.0])


def test_an_explicit_min_score_replaces_the_threshold(adapter, store):
    adapter.set_scores(store, [0.6, 0.1, 0.8, 0.3])
    assert _search(store, h.VxFilter(minScore=0.2)) == pytest.approx([0.6, 0.8, 0.3])


def test_the_agent_search_tool_returns_only_hits_at_or_above_the_threshold(adapter, store):
    """The tool path: an agent's search on Milvus answers what it answered on develop."""
    inst = node(store, logical_type='milvus', embed_query=lambda text: h.vector_for('q', 0), embed_model_name=h.MODEL)
    adapter.set_scores(store, [0.6, 0.1, 0.8, 0.3])
    answer = inst.search({'query': 'q', 'top_k': 10})
    assert answer['success'] is True, answer
    assert sorted(item['score'] for item in answer['results']) == pytest.approx([0.6, 0.8])
    adapter.set_scores(store, [0.6, 0.1, 0.8, 0.3])
    every = inst.search({'query': 'q', 'top_k': 10, 'include_below_floor': True})
    assert sorted(item['score'] for item in every['results']) == pytest.approx([0.1, 0.3, 0.6, 0.8])
