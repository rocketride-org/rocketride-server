# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Numpy helpers behind the vector store explorer tools (pure functions).

One similarity definition serves every visual: ``similarity(metric, A, B)`` is a
normalised dot product for ``'cosine'``, the dot product for ``'ip'`` and
``1 / (1 + distance)`` for ``'l2'``; higher is always closer. The ``sample``,
``project`` and ``neighbors`` tools recompute ``sim`` with it from raw vectors,
whatever score the backend reports.

Everything here is deterministic: ties are broken by the lower index and the
only randomness (``stratified_pick``) comes from a seeded ``random.Random``.

See ``docs/development/nodes/vector-tool-contract.md`` section 2.
"""

import math
import random
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

#: The metrics the helpers understand.
METRICS: Tuple[str, ...] = ('cosine', 'l2', 'ip')

_METRIC_ALIASES = {
    'cosine': 'cosine',
    'cos': 'cosine',
    'l2': 'l2',
    'euclid': 'l2',
    'euclidean': 'l2',
    'ip': 'ip',
    'dot': 'ip',
    'dotproduct': 'ip',
    'dot_product': 'ip',
    'inner_product': 'ip',
    'innerproduct': 'ip',
    # pgvector's distance operators, which the pgvector driver keeps as its ``similarity``.
    '<=>': 'cosine',
    '<->': 'l2',
    '<#>': 'ip',
}

Key = Tuple[str, int]


def normalize_metric(name: Optional[str]) -> Optional[str]:
    """Map a backend's similarity name (``'COSINE'``, ``'euclidean'``, ``'dotproduct'``, pgvector's ``'<=>'``...) to a metric.

    Returns None for a name the helpers do not understand (for example ``'manhattan'``).
    """
    if not isinstance(name, str):
        return None
    return _METRIC_ALIASES.get(name.strip().lower())


def _as_matrix(X) -> np.ndarray:
    """Return ``X`` as a 2-D float32 array (a single vector becomes one row)."""
    A = np.asarray(X, dtype=np.float32)
    if A.ndim == 1:
        A = A.reshape(1, -1)
    if A.ndim != 2:
        raise ValueError(f'expected a matrix of vectors, got an array of {A.ndim} dimensions')
    return A


def _unit_rows(A: np.ndarray) -> np.ndarray:
    """Return ``A`` with every row scaled to unit length; zero rows stay zero."""
    norms = np.linalg.norm(A, axis=1, keepdims=True)
    return A / np.where(norms > 0, norms, 1.0)


def similarity(metric: str, A, B, block: int = 512) -> np.ndarray:
    """Return the ``len(A) x len(B)`` similarity matrix (float32; higher is closer).

    ``'cosine'``: dot product of unit vectors (a zero vector scores 0); ``'ip'``: dot
    product; ``'l2'``: ``1 / (1 + euclidean distance)``. Rows of ``A`` are processed
    ``block`` at a time so memory stays bounded.
    """
    if metric not in METRICS:
        raise ValueError(f'unknown metric {metric!r}; expected one of {", ".join(METRICS)}')
    A = _as_matrix(A)
    B = _as_matrix(B)
    if A.shape[0] and B.shape[0] and A.shape[1] != B.shape[1]:
        raise ValueError(f'dimension mismatch: {A.shape[1]} vs {B.shape[1]}')
    block = max(1, int(block))
    out = np.empty((A.shape[0], B.shape[0]), dtype=np.float32)
    if metric == 'cosine':
        A = _unit_rows(A)
        B = _unit_rows(B)
    b2 = np.einsum('ij,ij->i', B, B) if metric == 'l2' else None
    for start in range(0, A.shape[0], block):
        a = A[start : start + block]
        dots = a @ B.T
        if metric == 'l2':
            a2 = np.einsum('ij,ij->i', a, a)
            d2 = np.maximum(a2[:, None] + b2[None, :] - 2.0 * dots, 0.0)
            out[start : start + block] = 1.0 / (1.0 + np.sqrt(d2))
        elif metric == 'cosine':
            out[start : start + block] = np.clip(dots, -1.0, 1.0)
        else:
            out[start : start + block] = dots
    return out


def pca(X, k: int = 3) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Project ``X`` onto its first ``k`` principal components.

    Returns ``(coords, explained_variance_ratio, mean, basis)``: ``coords`` is
    ``n x k``, ``basis`` is ``k x d`` (rows are components) and ``mean`` is the
    centre; components beyond the data's rank are zero. Computed with a float32
    SVD; each component's sign is fixed so that its largest absolute loading is
    positive, which makes the layout reproducible.
    """
    A = _as_matrix(X)
    n, d = A.shape
    k = max(0, int(k))
    mean = A.mean(axis=0).astype(np.float32) if n else np.zeros(d, dtype=np.float32)
    basis = np.zeros((k, d), dtype=np.float32)
    explained = np.zeros(k, dtype=np.float64)
    if n == 0 or d == 0:
        return np.zeros((n, k), dtype=np.float32), explained, mean, basis
    C = A - mean
    _u, s, vt = np.linalg.svd(C, full_matrices=False)
    s = s.astype(np.float64)
    r = min(k, vt.shape[0])
    total = float(np.sum(s**2))
    if total > 0:
        basis[:r] = vt[:r]
        for i in range(r):
            j = int(np.argmax(np.abs(basis[i])))
            if basis[i, j] < 0:
                basis[i] = -basis[i]
        explained[:r] = (s[:r] ** 2) / total
    coords = (C @ basis.T).astype(np.float32)
    return coords, explained, mean, basis


def pca_project(V, mean: np.ndarray, basis: np.ndarray) -> np.ndarray:
    """Project vectors onto a basis from :func:`pca` (``(V - mean) @ basis.T``)."""
    return ((_as_matrix(V) - mean) @ basis.T).astype(np.float32)


def _top_k_rows(S: np.ndarray, k: int) -> Tuple[np.ndarray, np.ndarray]:
    """Return ``(cols, vals)`` of the ``k`` largest entries of every row of ``S``.

    Sorted by value descending, ties broken by the lower column. Entries equal to
    ``-inf`` are never preferred over finite ones.
    """
    rows = S.shape[0]
    if k <= 0 or rows == 0:
        return np.zeros((rows, 0), dtype=np.int64), np.zeros((rows, 0), dtype=S.dtype)
    part = np.argpartition(-S, kth=k - 1, axis=1)[:, :k]
    vals = np.take_along_axis(S, part, axis=1)
    # Exact tie handling at the boundary: when more columns equal the k-th value
    # than fit, take the lowest indices among them (rare; only on exact ties).
    thresh = vals.min(axis=1)
    tie_rows = np.nonzero((S >= thresh[:, None]).sum(axis=1) > k)[0]
    for r in tie_rows:
        row = S[r]
        idx = np.flatnonzero(row >= thresh[r])
        order = np.lexsort((idx, -row[idx]))[:k]
        part[r] = idx[order]
        vals[r] = row[part[r]]
    order = np.lexsort((part, -vals), axis=1)
    return np.take_along_axis(part, order, axis=1), np.take_along_axis(vals, order, axis=1)


def knn(metric: str, X, k: int, block: int = 512) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Exact k-nearest-neighbour graph of the rows of ``X`` in Qdrant's offsets layout.

    Returns ``(offsets_row, cols, sims)``: row ``i``'s neighbours are
    ``cols[offsets_row[i]:offsets_row[i + 1]]``, most similar first, ties broken by
    the lower index; a point is never its own neighbour; ``k`` is clamped to
    ``n - 1``.
    """
    A = _as_matrix(X)
    n = A.shape[0]
    k_eff = max(0, min(int(k), n - 1))
    offsets = np.arange(n + 1, dtype=np.int64) * k_eff
    cols = np.zeros(n * k_eff, dtype=np.int64)
    sims = np.zeros(n * k_eff, dtype=np.float32)
    if k_eff == 0:
        return offsets, cols, sims
    block = max(1, int(block))
    for start in range(0, n, block):
        S = similarity(metric, A[start : start + block], A, block=block)
        local = np.arange(S.shape[0])
        S[local, start + local] = -np.inf
        top_cols, top_vals = _top_k_rows(S, k_eff)
        cols[start * k_eff : (start + S.shape[0]) * k_eff] = top_cols.reshape(-1)
        sims[start * k_eff : (start + S.shape[0]) * k_eff] = top_vals.reshape(-1)
    return offsets, cols, sims


def density(offsets_row, sims) -> np.ndarray:
    """Return each point's mean similarity to its neighbours (0 for a point without neighbours)."""
    offsets = np.asarray(offsets_row, dtype=np.int64)
    values = np.asarray(sims, dtype=np.float64)
    if offsets.size <= 1:
        return np.zeros(0, dtype=np.float32)
    csum = np.concatenate([[0.0], np.cumsum(values)])
    lengths = np.diff(offsets)
    totals = csum[offsets[1:]] - csum[offsets[:-1]]
    with np.errstate(invalid='ignore', divide='ignore'):
        dens = np.where(lengths > 0, totals / np.maximum(lengths, 1), 0.0)
    return dens.astype(np.float32)


def outliers(dens, pct: float = 1.0) -> List[int]:
    """Return the indices of the lowest-density ``pct`` percent of points (at least one).

    The count is ``n * pct / 100`` rounded half up; ordered by density ascending,
    ties by index.
    """
    values = np.asarray(dens, dtype=np.float64)
    n = values.size
    if n == 0:
        return []
    count = max(1, int(math.floor(n * float(pct) / 100.0 + 0.5)))
    order = np.lexsort((np.arange(n), values))
    return [int(i) for i in order[: min(count, n)]]


def duplicates(offsets_row, cols, sims, threshold: float = 0.97) -> List[Tuple[int, int, float]]:
    """Return near-duplicate pairs ``(a, b, sim)`` with ``a < b`` among the kNN edges.

    An edge in either direction with ``sim >= threshold`` makes a pair; each pair is
    listed once with its highest similarity, most similar first, then by index.
    """
    offsets = np.asarray(offsets_row, dtype=np.int64)
    col_arr = np.asarray(cols, dtype=np.int64)
    sim_arr = np.asarray(sims, dtype=np.float64)
    best: Dict[Tuple[int, int], float] = {}
    for i in range(max(0, offsets.size - 1)):
        for e in range(int(offsets[i]), int(offsets[i + 1])):
            j = int(col_arr[e])
            s = float(sim_arr[e])
            if j == i or not s >= threshold:
                continue
            pair = (i, j) if i < j else (j, i)
            if s > best.get(pair, -math.inf):
                best[pair] = s
    return [(a, b, s) for (a, b), s in sorted(best.items(), key=lambda item: (-item[1], item[0][0], item[0][1]))]


def stratified_pick(rows_by_doc: Dict[str, List[Key]], n: int, seed: int, pinned: Sequence[Key]) -> List[Key]:
    """Pick up to ``n`` keys spread over documents.

    Order: the ``pinned`` keys; then the lowest chunk of every document (a seeded
    subset of documents when there are more documents than room); then one more
    chunk per document in a seeded round robin until ``n`` keys are picked or every
    key is taken. Deterministic for a given ``seed``.
    """
    n = max(0, int(n))
    rng = random.Random(seed)
    chosen: List[Key] = []
    seen = set()

    def take(key) -> None:
        key = (str(key[0]), int(key[1]))
        if key not in seen and len(chosen) < n:
            seen.add(key)
            chosen.append(key)

    for key in pinned:
        take(key)

    docs = sorted(doc for doc, rows in rows_by_doc.items() if rows)
    firsts = [min(rows_by_doc[doc], key=lambda key: int(key[1])) for doc in docs]
    firsts = [key for key in firsts if (str(key[0]), int(key[1])) not in seen]
    if len(firsts) > n - len(chosen):
        rng.shuffle(firsts)
    for key in firsts:
        take(key)

    remaining: Dict[str, List[Key]] = {}
    for doc in docs:
        rest = [
            key
            for key in sorted(rows_by_doc[doc], key=lambda key: int(key[1]))
            if (str(key[0]), int(key[1])) not in seen
        ]
        rng.shuffle(rest)
        remaining[doc] = rest
    order = list(docs)
    rng.shuffle(order)
    while len(chosen) < n and any(remaining[doc] for doc in order):
        for doc in order:
            if remaining[doc] and len(chosen) < n:
                take(remaining[doc].pop())
    return chosen


def knn_overlap(offsets_row, cols, positions, k: int = 15, block: int = 512) -> float:
    """Layout quality: the mean share of each point's first ``k`` graph neighbours
    that are also among its ``k`` nearest points in ``positions`` (Euclidean).
    """
    P = np.asarray(positions, dtype=np.float64)
    if P.ndim == 1:
        P = P.reshape(-1, 1)
    n = P.shape[0]
    if n == 0:
        return 0.0
    offsets = np.asarray(offsets_row, dtype=np.int64)
    col_arr = np.asarray(cols, dtype=np.int64)
    k_eff = max(0, min(int(k), n - 1))
    sq = np.einsum('ij,ij->i', P, P)
    total = 0.0
    for start in range(0, n, max(1, int(block))):
        p = P[start : start + block]
        d2 = np.maximum(np.einsum('ij,ij->i', p, p)[:, None] + sq[None, :] - 2.0 * (p @ P.T), 0.0)
        local = np.arange(p.shape[0])
        neg = -d2
        neg[local, start + local] = -np.inf
        near, _vals = _top_k_rows(neg, k_eff)
        for r in range(p.shape[0]):
            i = start + r
            lo = int(offsets[i])
            hi = min(int(offsets[i + 1]), lo + int(k))
            graph = col_arr[lo:hi]
            if graph.size == 0:
                continue
            total += np.isin(graph, near[r]).sum() / graph.size
    return float(total / n)


def snippet(text: Optional[str], limit: int = 120) -> str:
    """Return ``text`` with whitespace collapsed, cut to at most ``limit`` characters.

    A longer text is cut at the last word boundary that keeps it within the limit
    (hard cut when there is none in the second half) and ends with an ellipsis.
    """
    flat = ' '.join(str(text or '').split())
    limit = max(1, int(limit))
    if len(flat) <= limit:
        return flat
    cut = flat[: limit - 1]
    space = cut.rfind(' ')
    if space >= limit // 2:
        cut = cut[:space]
    return cut.rstrip() + '…'


__all__ = [
    'METRICS',
    'density',
    'duplicates',
    'knn',
    'knn_overlap',
    'normalize_metric',
    'outliers',
    'pca',
    'pca_project',
    'similarity',
    'snippet',
    'stratified_pick',
]
