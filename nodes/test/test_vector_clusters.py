# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Clusters of a sample's neighbour graph and their labels (contract section 4.4-C).

``vx_cluster`` groups a sample's points by the connected components of its mutual
kNN edges at or above a percentile of the edge similarities, raises the percentile
while one group holds half the points, keeps every group of 2 or more (up to
``max_components``) and labels the largest groups of 5 or more with their top
TF-IDF terms. The ``sample`` tool answers ``clusters`` when asked
(``cluster: {method: 'knn-components', labels}``) and ``points.table`` always.

Covered here: three seeded blobs, determinism, noise, folding beyond
``max_components``, the one-blob rule on a uniform cloud, a long path graph (one
group, whatever its depth), the term rules (stop words, short tokens, numbers,
ties, at most 50 texts per group, the label sources), the answer's shape and
counts, the capability, and the budgets in both modes.
"""

from __future__ import annotations

import json
import os
import random
from typing import Any, Dict, List

import numpy as np
import pytest

from ai.common.store import vx_cluster, vx_math, vx_tools
from ai.common.store.vx_types import CAPABILITY_KEYS, CLUSTER_LABEL_SOURCES, CLUSTER_METHODS

from .test_vector_hooks import ExactListingStore, MemoryStore, NativeStratifiedStore, corpus, make_doc
from .test_vectordb_tool_mixin import clustered, node

CLUSTER_KEYS = {
    'method',
    'edge_threshold',
    'percentile',
    'count',
    'noise',
    'labels',
    'sizes',
    'keywords',
    'labelled',
    'label_source',
    'labelled_from',
    'took_ms',
}

#: Budgets are asserted at their value locally and at three times it on CI runners.
SLACK = 3 if os.environ.get('CI') else 1


def _blobs(sizes: List[int], *, dim: int = 16, spread: float = 0.05, seed: int = 11) -> np.ndarray:
    rng = np.random.default_rng(seed)
    rows = []
    for size in sizes:
        centre = rng.normal(size=dim)
        centre /= np.linalg.norm(centre)
        rows.append(centre + spread * rng.normal(size=(size, dim)))
    return np.vstack(rows).astype(np.float32)


def _groups(X: np.ndarray, k: int = 15, **kw: Any) -> vx_cluster.Components:
    offsets, cols, sims = vx_math.knn('cosine', X, k)
    return vx_cluster.knn_components(offsets, cols, sims, **kw)


def _graph(n: int, edges: Dict[int, List[tuple]]) -> tuple:
    """Offsets layout for ``{row: [(col, sim), ...]}``."""
    offsets, cols, sims = [0], [], []
    for i in range(n):
        for j, s in edges.get(i, []):
            cols.append(j)
            sims.append(s)
        offsets.append(len(cols))
    return np.asarray(offsets), np.asarray(cols), np.asarray(sims, dtype=np.float32)


# ---------------------------------------------------------------------------
# The stop list and the tokens
# ---------------------------------------------------------------------------


def test_the_stop_list_has_three_hundred_lower_case_words_of_three_letters_or_more():
    assert len(vx_cluster.STOP_WORDS) == 300
    assert all(word == word.lower() and len(word) >= 3 for word in vx_cluster.STOP_WORDS)
    assert {'the', 'and', 'which', 'would', 'therefore'} <= vx_cluster.STOP_WORDS


def test_tokens_are_lower_case_words_without_stop_words_short_tokens_or_numbers():
    text = 'The Falcon-Station WATER log: 2026 levels at 11:00, on spring_intake; KX4471 noted, ÉTÉ résumé.'
    assert vx_cluster.tokens(text) == [
        'falcon',
        'station',
        'water',
        'log',
        'levels',
        'spring',
        'intake',
        'kx4471',
        'noted',
        'été',
        'résumé',
    ]


def test_tokens_drop_runs_longer_than_a_word():
    assert vx_cluster.tokens('a' * 40 + ' orchid') == ['orchid']


def test_path_tokens_drop_the_extension_and_the_drive():
    assert vx_cluster.path_tokens('C:/demo/greenhouse/orchid_notes.txt') == ['demo', 'greenhouse', 'orchid', 'notes']
    assert vx_cluster.path_tokens('/srv/data/Kestrel Field Guide.PDF') == ['srv', 'data', 'kestrel', 'field', 'guide']


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------


def test_three_seeded_blobs_give_exactly_three_groups_of_five_or_more():
    found = _groups(_blobs([60, 60, 60]))
    big = [size for size in found.sizes if size >= 5]
    assert len(big) == 3, found.sizes
    assert found.percentile == 60 and found.edge_threshold is not None
    labels = np.asarray(found.labels)
    for start in (0, 60, 120):
        members = labels[start : start + 60]
        kept = members[members >= 0]
        assert len(set(kept.tolist())) == 1, 'one blob is one group'
        assert len(kept) >= 40, 'most of a blob is in its group; its loosest points may be noise'
    assert found.count == len(found.sizes) and found.noise == int((labels == -1).sum())
    assert sum(found.sizes) + found.noise == 180


def test_groups_are_numbered_by_size_and_stable_across_runs():
    X = _blobs([70, 40, 25], seed=3)
    first, second = _groups(X), _groups(X)
    assert first == second
    assert first.sizes == sorted(first.sizes, reverse=True)
    for group, size in enumerate(first.sizes):
        assert first.labels.count(group) == size


def test_singletons_are_noise_and_every_kept_group_has_two_points_or_more():
    X = np.vstack([_blobs([30], seed=5), np.eye(16, dtype=np.float32)[:6] * 3.0])
    found = _groups(X, k=5)
    assert all(size >= 2 for size in found.sizes)
    labels = np.asarray(found.labels)
    for group in range(found.count):
        assert (labels == group).sum() >= 2
    assert found.noise >= 6 - 1


def test_groups_beyond_max_components_are_folded_into_noise():
    # 30 pairs joined by edges of one similarity: every edge reaches the percentile, 30 groups of 2.
    edges = {i: [(i + 1 if i % 2 == 0 else i - 1, 0.9)] for i in range(60)}
    graph = _graph(60, edges)
    every = vx_cluster.knn_components(*graph)
    assert every.count == 30 and every.sizes == [2] * 30 and every.noise == 0
    capped = vx_cluster.knn_components(*graph, max_components=10)
    assert capped.count == 10 and capped.sizes == [2] * 10 and capped.noise == 40
    assert max(capped.labels) == 9
    # Equal sizes are numbered by their first point: the first ten pairs are kept.
    assert capped.labels[:20] == [g for g in range(10) for _ in range(2)] and set(capped.labels[20:]) == {-1}


def test_a_uniform_cloud_raises_the_percentile_until_no_group_holds_half_the_points():
    rng = np.random.default_rng(2026)
    X = rng.normal(size=(1000, 24)).astype(np.float32)
    found = _groups(X, k=15)
    assert found.percentile > 60, 'the first percentile left one group holding half the points'
    assert max(found.sizes, default=0) < 500
    at_start = vx_cluster.knn_components(*vx_math.knn('cosine', X, 15), raise_giant=False)
    assert max(at_start.sizes) >= 500 and at_start.percentile == 60


def test_the_percentile_rises_in_steps_of_ten_and_stops_once_it_reaches_ninety_five():
    # Every point joined by edges of one similarity: one group at every percentile.
    n = 12
    edges = {i: [((i + 1) % n, 0.8), ((i - 1) % n, 0.8)] for i in range(n)}
    found = vx_cluster.knn_components(*_graph(n, edges))
    assert (found.count, found.sizes, found.percentile) == (1, [n], 100)
    assert found.edge_threshold == pytest.approx(0.8)


def test_a_path_of_five_hundred_points_above_the_threshold_is_one_group():
    n = 500
    edges: Dict[int, List[tuple]] = {}
    for i in range(n):
        # Each point's strong neighbours are its two path neighbours; weak edges to i +/- 2 make the
        # 60th percentile fall on the path edges. Rows list the far end first so unions arrive out of order.
        row = [(j, 0.3) for j in (i + 2, i - 2) if 0 <= j < n] + [(j, 0.9) for j in (i + 1, i - 1) if 0 <= j < n]
        edges[n - 1 - i] = [(n - 1 - j, s) for j, s in row]
    found = vx_cluster.knn_components(*_graph(n, edges))
    assert (found.count, found.sizes, found.noise) == (1, [n], 0)
    assert set(found.labels) == {0}


def test_only_mutual_edges_join_points():
    # 0 -> 1 strongly but 1 lists only 2: no mutual edge between 0 and 1.
    edges = {0: [(1, 0.95)], 1: [(2, 0.95)], 2: [(1, 0.95)], 3: [(4, 0.1)], 4: [(3, 0.1)]}
    found = vx_cluster.knn_components(*_graph(5, edges), raise_giant=False)
    assert found.labels[1] == found.labels[2] != -1
    assert found.labels[0] == -1


def test_an_empty_or_edgeless_sample_has_no_groups():
    empty = vx_cluster.knn_components(np.asarray([0]), np.asarray([]), np.asarray([]))
    assert (empty.count, empty.noise, empty.labels, empty.edge_threshold) == (0, 0, [], None)
    one = vx_cluster.knn_components(np.asarray([0, 0]), np.asarray([]), np.asarray([]))
    assert (one.count, one.noise, one.labels) == (0, 1, [-1])


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------


def _labelled(groups: List[int], sizes: List[int], texts: List[str], paths: List[str] = None, **kw: Any):
    return vx_cluster.label_components(groups, sizes, texts, paths if paths is not None else [''] * len(texts), **kw)


def test_labels_are_the_top_five_tf_idf_terms_of_each_group():
    texts = ['orchid greenhouse humidity orchid misting'] * 6 + ['falcon station water spring intake falcon'] * 6
    out = _labelled([0] * 6 + [1] * 6, [6, 6], texts)
    assert out['label_source'] == 'text' and out['labelled'] == 2 and out['labelled_from'] == 50
    # orchid is twice as frequent; the rest tie on score and frequency and follow the alphabet.
    assert out['keywords'][0] == ['orchid', 'greenhouse', 'humidity', 'misting']
    assert out['keywords'][1] == ['falcon', 'intake', 'spring', 'station', 'water']


def test_terms_shared_by_every_group_rank_below_the_ones_that_set_a_group_apart():
    texts = ['station report orchid'] * 5 + ['station report falcon'] * 5
    out = _labelled([0] * 5 + [1] * 5, [5, 5], texts)
    assert out['keywords'][0][0] == 'orchid' and out['keywords'][1][0] == 'falcon'


def test_ties_go_to_the_more_frequent_term_then_the_alphabet():
    texts = ['zebra apple mango', 'zebra apple mango', 'zebra apple', 'kiwi', 'kiwi']
    out = _labelled([0] * 5, [5], texts)
    # zebra and apple tie on everything, then the alphabet; mango and kiwi follow by score.
    assert out['keywords'][0][:2] == ['apple', 'zebra']
    assert len(out['keywords'][0]) == 4


def test_stop_words_short_tokens_and_numbers_never_become_labels():
    texts = ['the and of to in is it 42 2026 an ox the which would orchid'] * 5
    assert _labelled([0] * 5, [5], texts)['keywords'] == [['orchid']]


def test_only_groups_of_five_or_more_are_labelled_largest_first():
    labels = [0] * 7 + [1] * 5 + [2] * 4 + [3] * 2
    texts = ['alpha'] * 7 + ['bravo'] * 5 + ['charlie'] * 4 + ['delta'] * 2
    out = _labelled(labels, [7, 5, 4, 2], texts)
    assert out['labelled'] == 2
    assert out['keywords'] == [['alpha'], ['bravo'], [], []]


def test_at_most_fifty_groups_are_labelled():
    labels, texts, sizes = [], [], []
    for group in range(60):
        labels += [group] * 5
        texts += [f'term{group:02d}x word{group:02d}y'] * 5
        sizes.append(5)
    out = _labelled(labels, sizes, texts)
    assert out['labelled'] == 50
    assert all(out['keywords'][g] for g in range(50)) and all(not out['keywords'][g] for g in range(50, 60))


def test_a_group_is_labelled_from_its_first_fifty_texts_by_sample_order():
    texts = ['common'] * 50 + ['latecomer latecomer latecomer'] * 30
    out = _labelled([0] * 80, [80], texts)
    assert out['keywords'] == [['common']]


def test_empty_texts_are_skipped_when_a_group_picks_its_fifty():
    texts = [''] * 60 + ['orchid'] * 5
    out = _labelled([0] * 65, [65], texts)
    assert out['keywords'] == [['orchid']] and out['label_source'] == 'text'


def test_labels_come_from_the_paths_when_the_store_returns_no_text():
    paths = ['C:/demo/greenhouse/orchid_notes.txt'] * 5 + ['C:/demo/handbooks/falcon_handbook.md'] * 5
    out = _labelled([0] * 5 + [1] * 5, [5, 5], [''] * 10, paths)
    assert out['label_source'] == 'paths'
    assert set(out['keywords'][0]) == {'greenhouse', 'orchid', 'notes', 'demo'}
    assert out['keywords'][0][0] in ('greenhouse', 'orchid', 'notes')


def test_without_text_or_paths_there_is_no_label_source():
    out = _labelled([0] * 5, [5], [''] * 5, [''] * 5)
    assert out == {'keywords': [[]], 'labelled': 0, 'label_source': None, 'labelled_from': 0}


def test_labels_false_computes_no_terms():
    out = _labelled([0] * 5, [5], ['orchid'] * 5, labels=False)
    assert out == {'keywords': [[]], 'labelled': 0, 'label_source': None, 'labelled_from': 0}


def test_a_label_is_never_longer_than_five_terms():
    texts = [' '.join(f'word{i:03d}x' for i in range(40))] * 6
    assert len(_labelled([0] * 6, [6], texts)['keywords'][0]) == 5


# ---------------------------------------------------------------------------
# The sample tool
# ---------------------------------------------------------------------------


def _topic_store(store_cls=ExactListingStore, *, topics: int = 3, docs_per_topic: int = 4, chunks: int = 5, **kw):
    """Documents in ``topics`` tight topics, each with its own words."""
    words = {
        0: 'orchid greenhouse humidity misting',
        1: 'falcon station water intake',
        2: 'telescope mirror dome night',
    }
    rng = np.random.default_rng(77)
    centres = [c / np.linalg.norm(c) for c in rng.normal(size=(topics, 16))]
    store = store_cls(**kw)
    batch = []
    for t in range(topics):
        for d in range(docs_per_topic):
            oid = f't{t}d{d}'
            for c in range(chunks):
                vec = (centres[t] + 0.05 * rng.normal(size=16)).tolist()
                text = f'{words[t % 3]} chunk {c} of the {words[t % 3].split()[0]} notes'
                batch.append(make_doc(oid, c, path=f'C:/demo/topic{t}/{oid}.md', vector=vec, text=text))
    return store.seed(batch)


def _clusters(answer: Dict[str, Any]) -> Dict[str, Any]:
    assert answer['success'] is True, answer
    clusters = answer['clusters']
    assert set(clusters) == CLUSTER_KEYS
    assert clusters['method'] in CLUSTER_METHODS
    assert clusters['label_source'] in CLUSTER_LABEL_SOURCES + (None,)
    assert len(clusters['labels']) == answer['n']
    assert len(clusters['sizes']) == clusters['count'] == len(clusters['keywords'])
    assert sum(clusters['sizes']) + clusters['noise'] == answer['n']
    assert all(-1 <= label < clusters['count'] for label in clusters['labels'])
    assert all(size >= 2 for size in clusters['sizes'])
    assert clusters['sizes'] == sorted(clusters['sizes'], reverse=True)
    assert clusters['labelled'] <= 50 and clusters['labelled_from'] <= 50
    assert all(len(words) <= 5 for words in clusters['keywords'])
    assert set(clusters['took_ms']) == {'clusters', 'labels'}
    return clusters


def test_sample_answers_clusters_only_when_asked():
    inst = node(_topic_store())
    assert 'clusters' not in inst.sample({'n': 60})
    clusters = _clusters(inst.sample({'n': 60, 'cluster': {'method': 'knn-components'}}))
    assert clusters['count'] >= 3 and clusters['label_source'] == 'text'


def test_sample_clusters_follow_the_topics_and_name_them():
    answer = node(_topic_store()).sample({'n': 60, 'seed': 7, 'knn_k': 10, 'cluster': {'method': 'knn-components'}})
    clusters = _clusters(answer)
    big = [g for g, size in enumerate(clusters['sizes']) if size >= 5]
    assert len(big) == 3
    firsts = sorted(clusters['keywords'][g][0] for g in big)
    assert firsts == ['falcon', 'orchid', 'telescope']
    # The answer's other keys are those of a sample without clusters.
    plain = node(_topic_store()).sample({'n': 60, 'seed': 7, 'knn_k': 10})
    assert {k: v for k, v in answer.items() if k not in ('clusters', 'took_ms')} == {
        k: v for k, v in plain.items() if k != 'took_ms'
    }


def test_sample_clusters_are_deterministic_for_a_seed():
    a = node(_topic_store()).sample({'n': 50, 'seed': 7, 'cluster': {'method': 'knn-components'}})
    b = node(_topic_store()).sample({'n': 50, 'seed': 7, 'cluster': {'method': 'knn-components'}})
    drop = lambda c: {k: v for k, v in c.items() if k != 'took_ms'}  # noqa: E731
    assert drop(a['clusters']) == drop(b['clusters'])


def test_sample_without_labels_gives_groups_and_no_terms():
    clusters = _clusters(
        node(_topic_store()).sample({'n': 60, 'cluster': {'method': 'knn-components', 'labels': False}})
    )
    assert clusters['count'] >= 3 and clusters['labelled'] == 0 and clusters['label_source'] is None
    assert all(words == [] for words in clusters['keywords'])


@pytest.mark.parametrize('mode', ['detailed', 'light'])
def test_labels_come_from_the_chunk_text_in_both_modes(mode):
    clusters = _clusters(node(_topic_store()).sample({'n': 60, 'mode': mode, 'cluster': {'method': 'knn-components'}}))
    assert clusters['label_source'] == 'text' and clusters['labelled'] >= 3


def test_a_store_without_text_is_labelled_from_the_paths():
    store = _topic_store()
    for doc in store.rows.values():
        if doc.metadata.objectId != 'schema':
            doc.page_content = ''
    clusters = _clusters(node(store).sample({'n': 60, 'cluster': {'method': 'knn-components'}}))
    assert clusters['label_source'] == 'paths'
    assert {clusters['keywords'][g][0] for g in range(3)} <= {'topic0', 'topic1', 'topic2', 'demo'}


def test_the_native_sampler_answers_clusters_too():
    clusters = _clusters(
        node(_topic_store(NativeStratifiedStore)).sample({'n': 60, 'cluster': {'method': 'knn-components'}})
    )
    assert clusters['count'] >= 3


def test_an_empty_sample_answers_empty_clusters():
    store = ExactListingStore().seed([make_doc('a', 0, dim=8)])
    store.remove(['a'])
    clusters = _clusters(node(store).sample({'n': 5, 'cluster': {'method': 'knn-components'}}))
    assert (clusters['count'], clusters['noise'], clusters['labels'], clusters['edge_threshold']) == (0, 0, [], None)


def test_sample_points_flag_table_chunks():
    store = ExactListingStore().seed(
        [make_doc('a', 0, dim=8), make_doc('a', 1, dim=8, table=True), make_doc('b', 0, dim=8, table=True)]
    )
    answer = node(store).sample({'n': 3})
    keys = [(answer['docs'][d]['objectId'], c) for d, c in zip(answer['points']['doc'], answer['points']['chunk'])]
    assert dict(zip(keys, answer['points']['table'])) == {('a', 0): 0, ('a', 1): 1, ('b', 0): 1}


def test_table_flags_are_in_light_samples_too():
    answer = node(clustered(docs=3, chunks=2)).sample({'n': 6, 'mode': 'light'})
    assert answer['points']['table'] == [0] * 6


def test_the_clusters_capability_follows_sample():
    assert CAPABILITY_KEYS.index('clusters') >= 0
    assert node(clustered()).dialect({})['capabilities']['clusters'] is True
    assert node(MemoryStore().seed(corpus({'a': [0]}))).dialect({})['capabilities']['clusters'] is False


# ---------------------------------------------------------------------------
# Budgets (contract section 4.4-C), both modes
# ---------------------------------------------------------------------------


def _word(seed: int) -> str:
    rng = random.Random(seed)
    return ''.join(rng.choice('abcdefghijklmnopqrstuvwxyz') for _ in range(4 + seed % 6))


_VOCABULARY = [_word(i) for i in range(3000)]


def _budget_store(docs: int, chunks: int, dim: int = 384, chars: int = 1200):
    """``docs`` documents in 40 topics, chunk texts of about ``chars`` characters of varied words."""
    rng = np.random.default_rng(4242)
    words = random.Random(4242)
    centres = rng.normal(size=(40, dim))
    store = ExactListingStore()
    batch = []
    for d in range(docs):
        topic = d % 40
        lexicon = _VOCABULARY[topic * 60 : topic * 60 + 300]
        for c in range(chunks):
            vec = (centres[topic] + 0.8 * rng.normal(size=dim)).tolist()
            text = ''
            while len(text) < chars:
                text += words.choice(lexicon) + ' '
            batch.append(make_doc(f'doc{d:03d}', c, path=f'C:/demo/t{topic:02d}/doc{d:03d}.md', vector=vec, text=text))
    return store.seed(batch)


def _bytes(answer: Dict[str, Any]) -> int:
    return len(json.dumps(answer, separators=(',', ':')))


@pytest.mark.parametrize(
    'mode,n,k,growth_max,clusters_ms,labels_ms,docs',
    [
        ('detailed', 2000, 15, 12 * 1024, 300, 500, 40),
        ('light', 5000, 10, 25 * 1024, 500, 500, 100),
    ],
)
def test_clusters_fit_their_budgets(mode, n, k, growth_max, clusters_ms, labels_ms, docs):
    store = _budget_store(docs, 50)
    inst = node(store)
    plain = inst.sample({'n': n, 'mode': mode, 'knn_k': k, 'seed': 7})
    answer = inst.sample({'n': n, 'mode': mode, 'knn_k': k, 'seed': 7, 'cluster': {'method': 'knn-components'}})
    clusters = _clusters(answer)
    assert answer['n'] == n and answer['knn']['k'] == k
    assert clusters['labelled'] >= 1 and clusters['label_source'] == 'text'
    growth = _bytes(answer) - _bytes(plain)
    assert 0 < growth <= growth_max, f'{growth} bytes'
    assert clusters['took_ms']['clusters'] <= clusters_ms * SLACK, clusters['took_ms']
    assert clusters['took_ms']['labels'] <= labels_ms * SLACK, clusters['took_ms']


def test_cluster_work_happens_inside_the_sample_lock(monkeypatch):
    store = _topic_store()
    inst = node(store)
    seen = []
    real = vx_cluster.cluster_sample

    def spy(*args, **kw):
        cache = vx_tools._vx_state(store).samples()
        seen.append(cache._busy.locked())
        return real(*args, **kw)

    monkeypatch.setattr(vx_cluster, 'cluster_sample', spy)
    _clusters(inst.sample({'n': 30, 'cluster': {'method': 'knn-components'}}))
    assert seen == [True]
