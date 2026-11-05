# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Goldens for the vector store explorer's numpy helpers and sample cache.

``ai.common.store.vx_math`` computes what the ``sample``/``project``/``neighbors``
tools answer (similarities, PCA, the kNN graph, density, outliers, duplicates,
stratified picks and the layout-quality metric). ``ai.common.store.vx_sample_cache``
holds a sample between calls. Both are pure: hand-computed goldens pin the
numbers, and seeded random data is checked against brute-force reference code.
"""

from __future__ import annotations

import hashlib
import threading
from typing import List, Tuple

import numpy as np
import pytest

from ai.common.store import vx_math
from ai.common.store import vx_sample_cache as cache_mod
from ai.common.store.errors import ToolRefusal


def _brute_knn(metric: str, X: np.ndarray, k: int) -> Tuple[List[int], List[int], List[float]]:
    """Reference kNN: every pair, ties broken by the lower index."""
    n = len(X)
    S = vx_math.similarity(metric, X, X)
    offsets, cols, sims = [0], [], []
    for i in range(n):
        row = sorted(((float(S[i, j]), j) for j in range(n) if j != i), key=lambda t: (-t[0], t[1]))
        for sim, j in row[: min(k, n - 1)]:
            cols.append(j)
            sims.append(sim)
        offsets.append(len(cols))
    return offsets, cols, sims


# ---------------------------------------------------------------------------
# similarity
# ---------------------------------------------------------------------------


def test_similarity_cosine_golden():
    S = vx_math.similarity('cosine', [[1, 0], [0, 1]], [[1, 0], [1, 1], [0, -2]])
    assert S.dtype == np.float32
    np.testing.assert_allclose(S, [[1.0, 0.70710677, 0.0], [0.0, 0.70710677, -1.0]], atol=1e-6)


def test_similarity_inner_product_golden():
    S = vx_math.similarity('ip', [[1, 2]], [[3, 4], [-1, 0]])
    np.testing.assert_allclose(S, [[11.0, -1.0]])


def test_similarity_l2_golden_is_one_over_one_plus_distance():
    S = vx_math.similarity('l2', [[0, 0]], [[3, 4], [0, 0]])
    np.testing.assert_allclose(S, [[1.0 / 6.0, 1.0]], atol=1e-6)


def test_similarity_cosine_with_a_zero_vector_is_zero_not_nan():
    S = vx_math.similarity('cosine', [[0, 0]], [[1, 1]])
    assert S[0, 0] == 0.0


def test_similarity_is_independent_of_the_block_size():
    rng = np.random.default_rng(3)
    A, B = rng.normal(size=(17, 5)), rng.normal(size=(11, 5))
    for metric in ('cosine', 'ip', 'l2'):
        np.testing.assert_allclose(
            vx_math.similarity(metric, A, B, block=4), vx_math.similarity(metric, A, B, block=512), rtol=1e-5, atol=1e-6
        )


def test_similarity_accepts_a_single_vector():
    S = vx_math.similarity('cosine', [1, 0], [[1, 0], [0, 1]])
    assert S.shape == (1, 2)


def test_similarity_rejects_an_unknown_metric():
    with pytest.raises(ValueError):
        vx_math.similarity('hamming', [[1]], [[1]])


def test_similarity_rejects_mismatched_dimensions():
    with pytest.raises(ValueError):
        vx_math.similarity('cosine', [[1, 2]], [[1, 2, 3]])


@pytest.mark.parametrize(
    'raw,expected',
    [
        ('cosine', 'cosine'),
        ('COSINE', 'cosine'),
        ('Cosine', 'cosine'),
        ('euclidean', 'l2'),
        ('L2', 'l2'),
        ('dotproduct', 'ip'),
        ('dot_product', 'ip'),
        ('IP', 'ip'),
        ('<=>', 'cosine'),
        ('<->', 'l2'),
        ('<#>', 'ip'),
        ('manhattan', None),
        (None, None),
    ],
)
def test_normalize_metric(raw, expected):
    assert vx_math.normalize_metric(raw) == expected


# ---------------------------------------------------------------------------
# pca
# ---------------------------------------------------------------------------


def test_pca_golden_on_a_line():
    coords, explained, mean, basis = vx_math.pca([[1, 0], [-1, 0], [2, 0], [-2, 0]], k=3)
    assert coords.shape == (4, 3)
    np.testing.assert_allclose(coords[:, 0], [1, -1, 2, -2], atol=1e-6)
    np.testing.assert_allclose(coords[:, 1:], 0, atol=1e-6)
    np.testing.assert_allclose(explained, [1.0, 0.0, 0.0], atol=1e-6)
    np.testing.assert_allclose(mean, [0, 0], atol=1e-7)
    np.testing.assert_allclose(basis[0], [1, 0], atol=1e-6)


def test_pca_sign_makes_the_largest_loading_positive():
    _coords, _explained, _mean, basis = vx_math.pca([[0, 3], [0, -3], [0, 1], [0, -1]], k=1)
    np.testing.assert_allclose(basis[0], [0, 1], atol=1e-6)


def test_pca_sign_rule_holds_on_random_data():
    rng = np.random.default_rng(11)
    _coords, _explained, _mean, basis = vx_math.pca(rng.normal(size=(60, 7)), k=3)
    for row in basis:
        assert row[np.argmax(np.abs(row))] > 0


def test_pca_explained_ratios_are_sorted_and_sum_to_at_most_one():
    rng = np.random.default_rng(5)
    X = rng.normal(size=(80, 6)) * np.array([5, 3, 1, 1, 1, 1])
    _coords, explained, _mean, _basis = vx_math.pca(X, k=3)
    assert list(explained) == sorted(explained, reverse=True)
    assert 0.0 < float(np.sum(explained)) <= 1.0 + 1e-6


def test_pca_coords_match_the_projection_onto_the_basis():
    rng = np.random.default_rng(9)
    X = rng.normal(size=(30, 4)).astype(np.float32)
    coords, _explained, mean, basis = vx_math.pca(X, k=2)
    np.testing.assert_allclose(coords, (X - mean) @ basis.T, atol=1e-4)
    np.testing.assert_allclose(vx_math.pca_project(X, mean, basis), coords, atol=1e-4)


def test_pca_handles_one_point():
    coords, explained, _mean, basis = vx_math.pca([[1.0, 2.0, 3.0]], k=3)
    assert coords.shape == (1, 3)
    np.testing.assert_allclose(coords, 0)
    np.testing.assert_allclose(explained, 0)
    assert basis.shape == (3, 3)


def test_pca_handles_no_points():
    coords, explained, _mean, _basis = vx_math.pca(np.zeros((0, 4)), k=2)
    assert coords.shape == (0, 2)
    assert list(explained) == [0.0, 0.0]


def test_pca_is_float32():
    coords, _explained, mean, basis = vx_math.pca(np.random.default_rng(1).normal(size=(10, 3)), k=2)
    assert coords.dtype == np.float32 and mean.dtype == np.float32 and basis.dtype == np.float32


# ---------------------------------------------------------------------------
# knn
# ---------------------------------------------------------------------------


def test_knn_golden_on_a_line_with_l2():
    offsets, cols, sims = vx_math.knn('l2', [[0], [1], [3], [7]], 2)
    assert list(offsets) == [0, 2, 4, 6, 8]
    assert list(cols) == [1, 2, 0, 2, 1, 0, 2, 1]
    np.testing.assert_allclose(sims, [0.5, 0.25, 0.5, 1 / 3, 1 / 3, 0.25, 0.2, 1 / 7], atol=1e-6)


def test_knn_breaks_ties_by_the_lower_index():
    offsets, cols, _sims = vx_math.knn('cosine', [[1, 0], [1, 0], [1, 0], [0, 1]], 1)
    assert list(offsets) == [0, 1, 2, 3, 4]
    assert list(cols) == [1, 0, 0, 0]


def test_knn_never_lists_the_point_itself():
    X = np.random.default_rng(2).normal(size=(40, 6))
    offsets, cols, _sims = vx_math.knn('cosine', X, 5)
    for i in range(40):
        assert i not in set(cols[offsets[i] : offsets[i + 1]])


def test_knn_clamps_k_to_n_minus_one():
    offsets, cols, _sims = vx_math.knn('cosine', [[1, 0], [0, 1], [1, 1]], 10)
    assert list(offsets) == [0, 2, 4, 6]
    assert len(cols) == 6


def test_knn_of_one_point_is_empty():
    offsets, cols, sims = vx_math.knn('cosine', [[1, 0]], 5)
    assert list(offsets) == [0, 0]
    assert len(cols) == 0 and len(sims) == 0


@pytest.mark.parametrize('metric', ['cosine', 'ip', 'l2'])
def test_knn_matches_brute_force_on_seeded_data(metric):
    X = np.random.default_rng(42).normal(size=(57, 8)).astype(np.float32)
    offsets, cols, sims = vx_math.knn(metric, X, 6, block=16)
    ref_offsets, ref_cols, ref_sims = _brute_knn(metric, X, 6)
    assert list(offsets) == ref_offsets
    assert list(cols) == ref_cols
    np.testing.assert_allclose(sims, ref_sims, rtol=1e-5, atol=1e-6)


def test_knn_with_many_exact_duplicates_is_deterministic_and_exact():
    X = np.vstack([np.tile([1.0, 0.0], (6, 1)), np.random.default_rng(4).normal(size=(10, 2))])
    first = vx_math.knn('cosine', X, 3)
    second = vx_math.knn('cosine', X, 3)
    ref_offsets, ref_cols, _ = _brute_knn('cosine', X, 3)
    assert list(first[1]) == list(second[1]) == ref_cols
    assert list(first[0]) == ref_offsets


# ---------------------------------------------------------------------------
# density / outliers / duplicates
# ---------------------------------------------------------------------------


def test_density_is_the_mean_neighbour_similarity():
    dens = vx_math.density([0, 2, 4], [0.5, 0.25, 1.0, 0.0])
    np.testing.assert_allclose(dens, [0.375, 0.5])


def test_density_of_a_point_without_neighbours_is_zero():
    dens = vx_math.density([0, 0, 1], [0.8])
    np.testing.assert_allclose(dens, [0.0, 0.8])


def test_outliers_golden_lowest_density_first_ties_by_index():
    assert vx_math.outliers([0.9, 0.1, 0.5, 0.1], pct=50) == [1, 3]


def test_outliers_returns_at_least_one_point():
    assert vx_math.outliers([0.9, 0.1, 0.5, 0.2], pct=1.0) == [1]


def test_outliers_rounds_half_up_like_the_app():
    dens = np.linspace(0, 1, 150)
    assert len(vx_math.outliers(dens, pct=1.0)) == 2


def test_outliers_of_nothing_is_empty():
    assert vx_math.outliers([], pct=1.0) == []


def test_duplicates_lists_each_pair_once():
    assert vx_math.duplicates([0, 1, 2, 3], [1, 0, 0], [0.99, 0.99, 0.5], threshold=0.97) == [
        (0, 1, pytest.approx(0.99))
    ]


def test_duplicates_include_one_directional_edges():
    pairs = vx_math.duplicates([0, 1, 2, 3], [1, 0, 0], [0.5, 0.5, 0.98], threshold=0.97)
    assert pairs == [(0, 2, pytest.approx(0.98))]


def test_duplicates_are_sorted_by_similarity_then_index():
    # rows: 0 -> {1: 0.98, 2: 0.99}, 1 -> {0: 0.98}, 2 -> {3: 0.5}, 3 -> {2: 0.995}
    pairs = vx_math.duplicates([0, 2, 3, 4, 5], [1, 2, 0, 3, 2], [0.98, 0.99, 0.98, 0.5, 0.995], threshold=0.97)
    assert [(a, b) for a, b, _s in pairs] == [(2, 3), (0, 2), (0, 1)]


# ---------------------------------------------------------------------------
# stratified_pick
# ---------------------------------------------------------------------------

_ROWS = {
    'a': [('a', 0), ('a', 1), ('a', 2)],
    'b': [('b', 5), ('b', 6)],
    'c': [('c', 1)],
}


def test_stratified_pick_pins_first_then_takes_the_lowest_chunk_of_every_document():
    assert vx_math.stratified_pick(_ROWS, 4, seed=1, pinned=[('b', 6)]) == [('b', 6), ('a', 0), ('b', 5), ('c', 1)]


def test_stratified_pick_fills_round_robin_after_the_first_chunks():
    picked = vx_math.stratified_pick(_ROWS, 6, seed=1, pinned=[])
    assert picked[:3] == [('a', 0), ('b', 5), ('c', 1)]
    assert set(picked) == {key for rows in _ROWS.values() for key in rows}


def test_stratified_pick_is_deterministic_for_a_seed():
    rows = {f'd{i}': [(f'd{i}', c) for c in range(9)] for i in range(7)}
    assert vx_math.stratified_pick(rows, 30, seed=5, pinned=[]) == vx_math.stratified_pick(rows, 30, seed=5, pinned=[])
    assert vx_math.stratified_pick(rows, 30, seed=5, pinned=[]) != vx_math.stratified_pick(rows, 30, seed=6, pinned=[])


def test_stratified_pick_takes_every_document_before_a_second_chunk():
    rows = {f'd{i}': [(f'd{i}', c) for c in range(4)] for i in range(5)}
    picked = vx_math.stratified_pick(rows, 7, seed=3, pinned=[])
    assert {key[0] for key in picked[:5]} == set(rows)
    assert all(key[1] == 0 for key in picked[:5])


def test_stratified_pick_round_robin_spreads_over_documents():
    rows = {f'd{i}': [(f'd{i}', c) for c in range(10)] for i in range(3)}
    picked = vx_math.stratified_pick(rows, 9, seed=8, pinned=[])
    counts = {doc: sum(1 for key in picked if key[0] == doc) for doc in rows}
    assert sorted(counts.values()) == [3, 3, 3]


def test_stratified_pick_with_more_documents_than_points_picks_a_seeded_subset():
    rows = {f'd{i}': [(f'd{i}', 0)] for i in range(10)}
    picked = vx_math.stratified_pick(rows, 4, seed=2, pinned=[])
    assert len(picked) == 4 and len(set(picked)) == 4
    assert picked == vx_math.stratified_pick(rows, 4, seed=2, pinned=[])


def test_stratified_pick_never_exceeds_n_even_with_many_pins():
    assert vx_math.stratified_pick(_ROWS, 1, seed=0, pinned=[('x', 1), ('y', 2)]) == [('x', 1)]


def test_stratified_pick_returns_everything_when_n_is_large():
    assert len(vx_math.stratified_pick(_ROWS, 100, seed=0, pinned=[])) == 6


# ---------------------------------------------------------------------------
# knn_overlap
# ---------------------------------------------------------------------------


def test_knn_overlap_golden_half():
    offsets, cols, _sims = vx_math.knn('l2', [[0], [1], [3], [7]], 1)
    assert list(cols) == [1, 0, 1, 2]
    assert vx_math.knn_overlap(offsets, cols, [[0], [1], [10], [3]], k=1) == pytest.approx(0.5)


def test_knn_overlap_of_the_space_itself_is_one():
    X = np.random.default_rng(6).normal(size=(40, 3))
    offsets, cols, _sims = vx_math.knn('l2', X, 5)
    assert vx_math.knn_overlap(offsets, cols, X, k=5) == pytest.approx(1.0)


def test_knn_overlap_matches_brute_force():
    rng = np.random.default_rng(12)
    X = rng.normal(size=(35, 10))
    offsets, cols, _sims = vx_math.knn('cosine', X, 4)
    pos = rng.normal(size=(35, 2))
    total = 0.0
    for i in range(35):
        near = sorted(((float(np.sum((pos[j] - pos[i]) ** 2)), j) for j in range(35) if j != i))
        layout = {j for _d, j in near[:4]}
        graph = list(cols[offsets[i] : offsets[i] + 4])
        total += len([j for j in graph if j in layout]) / max(1, len(graph))
    assert vx_math.knn_overlap(offsets, cols, pos, k=4) == pytest.approx(total / 35)


def test_knn_overlap_of_nothing_is_zero():
    assert vx_math.knn_overlap([0], [], np.zeros((0, 2)), k=5) == 0.0


# ---------------------------------------------------------------------------
# snippets
# ---------------------------------------------------------------------------


def test_snippet_keeps_short_text():
    assert vx_math.snippet('  a short\n chunk ', 120) == 'a short chunk'


def test_snippet_cuts_at_a_word_boundary_with_an_ellipsis():
    text = 'word ' * 60
    snip = vx_math.snippet(text, 120)
    assert len(snip) <= 120
    assert snip.endswith('…')
    assert not snip[:-1].endswith(' ')
    assert snip[:-1].split(' ')[-1] == 'word'


def test_snippet_of_one_long_word_is_cut_hard():
    snip = vx_math.snippet('x' * 500, 120)
    assert len(snip) == 120 and snip.endswith('…')


# ---------------------------------------------------------------------------
# sample cache
# ---------------------------------------------------------------------------


def _entry(sample_id: str, n: int = 3) -> cache_mod.SampleEntry:
    keys = [('doc', i) for i in range(n)]
    return cache_mod.SampleEntry(
        sample_id=sample_id,
        keys=keys,
        vectors=np.eye(n, 4, dtype=np.float32),
        mean=np.zeros(4, dtype=np.float32),
        basis=np.eye(3, 4, dtype=np.float32),
        metric='cosine',
        dimension=4,
        mode='detailed',
        point_ids=[None] * n,
    )


def test_sample_id_is_seed_plus_eight_hex_of_sha1_of_the_keys():
    keys = [('060f', 0), ('9fa0', 3)]
    digest = hashlib.sha1('060f#0|9fa0#3'.encode('utf-8')).hexdigest()[:8]
    assert cache_mod.make_sample_id(7, keys) == f's-7-{digest}'


def test_cache_returns_what_it_holds_with_an_index_by_key():
    cache = cache_mod.SampleCache()
    cache.put(_entry('s-1-aaaaaaaa'))
    got = cache.get('s-1-aaaaaaaa')
    assert got is not None and got.index[('doc', 2)] == 2
    assert cache.latest() is got


def test_cache_holds_two_samples_and_evicts_the_oldest():
    cache = cache_mod.SampleCache(entries=2)
    cache.put(_entry('s-1-aaaaaaaa'))
    cache.put(_entry('s-2-bbbbbbbb'))
    cache.get('s-1-aaaaaaaa')
    cache.put(_entry('s-3-cccccccc'))
    assert cache.get('s-2-bbbbbbbb') is None
    assert cache.get('s-1-aaaaaaaa') is not None
    assert cache.get('s-3-cccccccc') is not None


def test_cache_entries_expire_after_the_ttl():
    clock = [1000.0]
    cache = cache_mod.SampleCache(ttl_s=600, clock=lambda: clock[0])
    cache.put(_entry('s-1-aaaaaaaa'))
    clock[0] += 599
    assert cache.get('s-1-aaaaaaaa') is not None
    clock[0] += 2
    assert cache.get('s-1-aaaaaaaa') is None


def test_cache_unknown_id_is_none():
    assert cache_mod.SampleCache().get('s-9-deadbeef') is None


def test_cache_exclusive_answers_busy_while_held():
    cache = cache_mod.SampleCache()
    entered = threading.Event()
    release = threading.Event()

    def hold():
        with cache.exclusive():
            entered.set()
            release.wait(5)

    worker = threading.Thread(target=hold)
    worker.start()
    try:
        assert entered.wait(5)
        with pytest.raises(ToolRefusal) as err:
            with cache.exclusive():
                pass
        assert err.value.code == 'BUSY'
    finally:
        release.set()
        worker.join(5)
    with cache.exclusive():
        pass


def test_light_budget_refuses_a_large_sample_of_wide_vectors():
    with pytest.raises(ToolRefusal) as err:
        cache_mod.check_light_budget(n=5000, dimension=4096)
    assert err.value.code == 'LIMIT_EXCEEDED'


def test_light_budget_allows_up_to_two_thousand_points_of_any_width():
    cache_mod.check_light_budget(n=2000, dimension=100_000)


def test_light_budget_allows_five_thousand_vectors_up_to_the_byte_budget():
    widest = int(cache_mod.VECTOR_TOOL_DEFAULTS['sample_light_max_bytes']) // (5000 * 4)
    cache_mod.check_light_budget(n=5000, dimension=384)
    cache_mod.check_light_budget(n=5000, dimension=widest)
    with pytest.raises(ToolRefusal) as err:
        cache_mod.check_light_budget(n=5000, dimension=widest + 1)
    assert err.value.code == 'LIMIT_EXCEEDED'
