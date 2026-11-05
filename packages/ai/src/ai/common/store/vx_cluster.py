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

"""Clusters of a sample's neighbour graph and the words that name them (pure functions).

The ``sample`` tool answers ``clusters`` when a call asks for them
(``cluster: {method: 'knn-components', labels: true}``, contract section 4.4-C).
Everything is computed from what the sample already holds: the kNN graph in
Qdrant's offsets layout, and each point's chunk text and document path.

* **Groups** (:func:`knn_components`): the *mutual* kNN edges (``j`` among ``i``'s
  neighbours and ``i`` among ``j``'s) whose similarity is at least
  ``edge_threshold``, the ``percentile``-th percentile of all the graph's edge
  similarities (60 first, so it adapts to the metric and the model). Groups are
  the connected components of the kept edges, found by union-find (path halving,
  so a long chain is one group however deep it is). While the largest group holds
  half the points or more and ``percentile`` is below 95, the percentile rises by 10
  and the groups are computed again. Groups are numbered by size, largest first
  (ties by their first point); every group of 2 or more points is kept, up to
  ``max_components``; singletons and the groups beyond the cap are noise (``-1``).
  A user's minimum group size is never applied here: the app folds small groups
  itself, without a call.
* **Labels** (:func:`label_components`): for the largest groups of at least
  :data:`LABEL_MIN_SIZE` points (at most :data:`LABELLED_MAX` of them), the top
  :data:`LABEL_TERMS` terms by TF-IDF over the first :data:`LABEL_TEXTS_MAX`
  non-empty texts of each group (by sample order). Terms are lower-cased words of
  at least :data:`TOKEN_MIN_CHARS` characters, not :data:`STOP_WORDS`, not only
  digits and at most :data:`TOKEN_MAX_CHARS` long; ties go to the more frequent
  term, then the alphabet. The texts are the chunk texts (``label_source:
  'text'``), or the document paths when no point has any text (``'paths'``).

Deterministic for a given sample; numpy and the standard library only.
"""

import math
import re
import time
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

#: The one method computed; ``'label-propagation'`` is reserved (``vx_types.CLUSTER_METHODS``).
METHOD = 'knn-components'

#: The first percentile of the edge similarities an edge must reach.
PERCENTILE_START = 60

#: How far the percentile rises each time one group holds half the points.
PERCENTILE_STEP = 10

#: The percentile rises only while it is below this.
PERCENTILE_RAISE_BELOW = 95

#: Share of the points one group may hold before the percentile rises.
GIANT_SHARE = 0.5

#: Fewest points a kept group has (smaller ones are noise).
MIN_GROUP = 2

#: Fewest points a group has to be labelled.
LABEL_MIN_SIZE = 5

#: Most groups labelled (the largest).
LABELLED_MAX = 50

#: Most texts read per labelled group (``labelled_from``).
LABEL_TEXTS_MAX = 50

#: Most characters read from one text (chunks are a few hundred to a few thousand characters).
LABEL_TEXT_CHARS = 4000

#: Terms per label.
LABEL_TERMS = 5

#: Shortest term, in characters.
TOKEN_MIN_CHARS = 3

#: Longest term, in characters (longer runs are identifiers or noise, not words).
TOKEN_MAX_CHARS = 24

#: English words that never name a group (300 words; shorter ones are dropped by length anyway).
STOP_WORDS = frozenset(
    (
        'about', 'above', 'across', 'after', 'afterwards', 'again', 'against', 'all', 'almost', 'alone', 'along',
        'already', 'also', 'although', 'always', 'among', 'amongst', 'amount', 'and', 'another', 'any', 'anyhow',
        'anyone', 'anything', 'anyway', 'anywhere', 'are', 'aren', 'around', 'back', 'became', 'because', 'become',
        'becomes', 'becoming', 'been', 'before', 'beforehand', 'behind', 'being', 'below', 'beside', 'besides',
        'between', 'beyond', 'both', 'but', 'can', 'cannot', 'could', 'couldn', 'did', 'didn', 'does', 'doesn', 'doing',
        'don', 'done', 'down', 'due', 'during', 'each', 'eight', 'either', 'eleven', 'else', 'elsewhere', 'enough',
        'etc', 'even', 'ever', 'every', 'everyone', 'everything', 'everywhere', 'except', 'few', 'fifteen', 'fifty',
        'first', 'five', 'for', 'former', 'formerly', 'forty', 'four', 'from', 'further', 'get', 'gets', 'getting',
        'give', 'given', 'gives', 'going', 'got', 'had', 'hadn', 'has', 'hasn', 'have', 'haven', 'having', 'hence',
        'her', 'here', 'hereafter', 'hereby', 'herein', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however',
        'hundred', 'indeed', 'into', 'isn', 'its', 'itself', 'just', 'keep', 'kept', 'last', 'later', 'latter', 'least',
        'less', 'like', 'made', 'make', 'makes', 'many', 'may', 'meanwhile', 'might', 'mine', 'more', 'moreover',
        'most', 'mostly', 'much', 'must', 'mustn', 'myself', 'namely', 'need', 'needs', 'neither', 'never',
        'nevertheless', 'next', 'nine', 'nobody', 'none', 'nor', 'not', 'nothing', 'now', 'nowhere', 'off', 'often',
        'once', 'one', 'only', 'onto', 'other', 'others', 'otherwise', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
        'per', 'perhaps', 'please', 'put', 'quite', 'rather', 'really', 'said', 'same', 'say', 'says', 'second', 'see',
        'seem', 'seemed', 'seeming', 'seems', 'several', 'shall', 'shan', 'she', 'should', 'shouldn', 'show', 'since',
        'six', 'sixty', 'some', 'somehow', 'someone', 'something', 'sometime', 'sometimes', 'somewhere', 'still',
        'such', 'take', 'ten', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'thence',
        'there', 'thereafter', 'thereby', 'therefore', 'therein', 'thereupon', 'these', 'they', 'third', 'this',
        'those', 'though', 'three', 'through', 'throughout', 'thru', 'thus', 'together', 'too', 'took', 'toward',
        'towards', 'twelve', 'twenty', 'two', 'under', 'until', 'upon', 'use', 'used', 'uses', 'using', 'various',
        'very', 'via', 'was', 'wasn', 'way', 'well', 'were', 'weren', 'what', 'whatever', 'when', 'whence', 'whenever',
        'where', 'whereafter', 'whereas', 'whereby', 'wherein', 'whereupon', 'wherever', 'whether', 'which', 'while',
        'whither', 'who', 'whoever', 'whole', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'won',
        'would', 'wouldn', 'yet', 'you', 'your', 'yours', 'yourself', 'yourselves',
    )
)  # fmt: skip

#: A word: letters and digits of any script (an underscore, a dash or punctuation splits words).
_WORD = re.compile(r'[^\W_]+')

#: A file name's extension (the last dot and what follows, when it is short and has no separator).
_EXTENSION = re.compile(r'\.[^./\\\s]{1,8}$')


# =============================================================================
# Groups
# =============================================================================


@dataclass(frozen=True)
class Components:
    """The groups of a sample, as :func:`knn_components` finds them."""

    #: One group number per point; -1 is noise.
    labels: List[int]
    #: Points per group, by group number (largest first).
    sizes: List[int]
    #: Groups kept.
    count: int
    #: Points in no group.
    noise: int
    #: The percentile the kept edges reach (after any rise).
    percentile: int
    #: Its similarity, rounded to 4 places; None when the graph has no edge.
    edge_threshold: Optional[float]


def _edge_arrays(offsets_row: Any, cols: Any, sims: Any) -> Tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    """Return ``(n, rows, cols, sims)`` of the graph's valid directed edges (no self loop, finite similarity)."""
    offsets = np.asarray(offsets_row, dtype=np.int64).reshape(-1)
    n = max(0, int(offsets.size) - 1)
    col = np.asarray(cols, dtype=np.int64).reshape(-1)
    sim = np.asarray(sims, dtype=np.float64).reshape(-1)
    if n == 0 or col.size == 0:
        empty = np.zeros(0, dtype=np.int64)
        return n, empty, empty, np.zeros(0, dtype=np.float64)
    lengths = np.clip(np.diff(offsets), 0, None)
    row = np.repeat(np.arange(n, dtype=np.int64), lengths)[: col.size]
    col, sim = col[: row.size], sim[: row.size]
    valid = (col >= 0) & (col < n) & (col != row) & np.isfinite(sim)
    return n, row[valid], col[valid], sim[valid]


def mutual_edges(n: int, rows: np.ndarray, cols: np.ndarray, sims: np.ndarray) -> Tuple[np.ndarray, ...]:
    """Return ``(a, b, sim)`` of the mutual edges, ``a < b``, each once.

    An edge is mutual when ``j`` is among ``i``'s neighbours and ``i`` among ``j``'s;
    its similarity is the lower of the two directions (both must reach a threshold).
    """
    if rows.size == 0:
        empty = np.zeros(0, dtype=np.int64)
        return empty, empty, np.zeros(0, dtype=np.float64)
    forward = rows * n + cols
    order = np.argsort(forward, kind='stable')
    ordered = forward[order]
    backward = cols * n + rows
    at = np.searchsorted(ordered, backward)
    inside = np.minimum(at, ordered.size - 1)
    found = (at < ordered.size) & (ordered[inside] == backward)
    keep = found & (rows < cols)
    a, b = rows[keep], cols[keep]
    sim = np.minimum(sims[keep], sims[order[inside[keep]]])
    pair = a * n + b
    _unique, first = np.unique(pair, return_index=True)
    first.sort()
    return a[first], b[first], sim[first]


def union_find(n: int, a: Sequence[int], b: Sequence[int]) -> List[int]:
    """Return each point's group root: the lowest point of its connected component.

    Union-find with path halving; a union keeps the lower root, so the result does
    not depend on the order of the edges and a component of any depth is found whole.
    """
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for x, y in zip(a, b):
        rx, ry = find(int(x)), find(int(y))
        if rx != ry:
            if rx < ry:
                parent[ry] = rx
            else:
                parent[rx] = ry
    return [find(i) for i in range(n)]


def _number(roots: List[int], max_components: int) -> Tuple[List[int], List[int]]:
    """Number the groups of 2 or more points by size (ties by root); return ``(labels, sizes)``."""
    size = Counter(roots)
    groups = sorted((root for root, count in size.items() if count >= MIN_GROUP), key=lambda r: (-size[r], r))
    groups = groups[: max(0, int(max_components))]
    number = {root: i for i, root in enumerate(groups)}
    return [number.get(root, -1) for root in roots], [size[root] for root in groups]


def knn_components(
    offsets_row: Any,
    cols: Any,
    sims: Any,
    *,
    max_components: int = 200,
    percentile: int = PERCENTILE_START,
    raise_giant: bool = True,
) -> Components:
    """Group a sample by the connected components of its mutual kNN edges (see the module docstring).

    ``raise_giant=False`` keeps the first percentile even when one group holds half the
    points (used by tests to show the rule's effect).
    """
    n, rows, col, sim = _edge_arrays(offsets_row, cols, sims)
    a, b, s = mutual_edges(n, rows, col, sim)
    if sim.size == 0:
        labels, sizes = _number(list(range(n)), max_components)
        return Components(labels, sizes, len(sizes), labels.count(-1), int(percentile), None)
    level = int(percentile)
    while True:
        threshold = float(np.percentile(sim, level))
        kept = s >= threshold
        roots = union_find(n, a[kept].tolist(), b[kept].tolist())
        largest = max(Counter(roots).values())
        if raise_giant and largest >= MIN_GROUP and largest >= GIANT_SHARE * n and level < PERCENTILE_RAISE_BELOW:
            level = min(100, level + PERCENTILE_STEP)
            continue
        break
    labels, sizes = _number(roots, max_components)
    return Components(labels, sizes, len(sizes), labels.count(-1), level, round(threshold, 4))


# =============================================================================
# Labels
# =============================================================================


def tokens(text: Optional[str]) -> List[str]:
    """Return the terms of ``text`` that may name a group, in order (see the module docstring)."""
    out: List[str] = []
    for word in _WORD.findall(str(text or '')[:LABEL_TEXT_CHARS].lower()):
        if TOKEN_MIN_CHARS <= len(word) <= TOKEN_MAX_CHARS and not word.isdigit() and word not in STOP_WORDS:
            out.append(word)
    return out


def path_tokens(path: Optional[str]) -> List[str]:
    """Return the terms of a document path: its folders and file name, without the extension."""
    return tokens(_EXTENSION.sub('', str(path or '').strip()))


def _top_terms(groups: List[List[List[str]]]) -> List[List[str]]:
    """Top :data:`LABEL_TERMS` terms of each group by TF-IDF; ``groups[g]`` is one token list per text.

    The IDF is computed over every text read for any group (smoothed:
    ``ln((1 + N) / (1 + df)) + 1``), so a term every group uses ranks below the terms
    that set one group apart; TF is the term's count in the group.
    """
    documents = [doc for group in groups for doc in group]
    df: Counter = Counter()
    for doc in documents:
        df.update(set(doc))
    total = len(documents)
    idf = {term: math.log((1 + total) / (1 + count)) + 1.0 for term, count in df.items()}
    out: List[List[str]] = []
    for group in groups:
        tf: Counter = Counter()
        for doc in group:
            tf.update(doc)
        ranked = sorted(tf, key=lambda term: (-round(tf[term] * idf[term], 9), -tf[term], term))
        out.append(ranked[:LABEL_TERMS])
    return out


def label_components(
    groups: Sequence[int],
    sizes: Sequence[int],
    texts: Sequence[Optional[str]],
    paths: Sequence[Optional[str]],
    *,
    labels: bool = True,
) -> Dict[str, Any]:
    """Name the largest groups; return ``{keywords, labelled, label_source, labelled_from}``.

    ``groups`` (one group number per point, -1 for noise) and ``sizes`` are a
    :class:`Components`' ``labels`` and ``sizes``; ``texts`` and ``paths`` hold one entry
    per point, in sample order. ``keywords`` has one list per group: ``labelled`` groups,
    largest first, were labelled (those of at least :data:`LABEL_MIN_SIZE` points, at most
    :data:`LABELLED_MAX`), and a labelled group whose texts hold no term gets ``[]`` like
    the others. ``label_source`` is ``'text'`` when any point has text, ``'paths'`` when
    none has but some has a path, else None (nothing labelled). ``labelled_from`` is the
    most texts read per group (0 when nothing was labelled). ``labels=False`` labels nothing.
    """
    count = len(sizes)
    nothing = {'keywords': [[] for _ in range(count)], 'labelled': 0, 'label_source': None, 'labelled_from': 0}
    if not labels:
        return nothing
    if any(text for text in texts):
        source, values, split = 'text', texts, tokens
    elif any(path for path in paths):
        source, values, split = 'paths', paths, path_tokens
    else:
        return nothing
    labelled = 0
    while labelled < min(count, LABELLED_MAX) and sizes[labelled] >= LABEL_MIN_SIZE:
        labelled += 1
    if labelled == 0:
        return {**nothing, 'label_source': source}
    read: List[List[List[str]]] = [[] for _ in range(labelled)]
    for point, group in enumerate(groups):
        if 0 <= group < labelled and len(read[group]) < LABEL_TEXTS_MAX:
            value = values[point] if point < len(values) else None
            if value:
                read[group].append(split(value))
    keywords: List[List[str]] = _top_terms(read) + [[] for _ in range(count - labelled)]
    return {'keywords': keywords, 'labelled': labelled, 'label_source': source, 'labelled_from': LABEL_TEXTS_MAX}


# =============================================================================
# The sample's clusters
# =============================================================================


def cluster_sample(
    offsets_row: Any,
    cols: Any,
    sims: Any,
    texts: Sequence[Optional[str]],
    paths: Sequence[Optional[str]],
    *,
    labels: bool = True,
    max_components: int = 200,
    clock: Callable[[], float] = time.monotonic,
) -> Dict[str, Any]:
    """Return a ``sample`` answer's ``clusters`` object (contract section 4.4-C).

    ``offsets_row``/``cols``/``sims`` are the sample's kNN graph; ``texts`` and ``paths``
    one chunk text and one document path per point, in sample order. ``took_ms`` times
    the groups and the labels separately.
    """
    started = clock()
    found = knn_components(offsets_row, cols, sims, max_components=max_components)
    grouped = clock()
    named = label_components(found.labels, found.sizes, texts, paths, labels=labels)
    done = clock()
    return {
        'method': METHOD,
        'edge_threshold': found.edge_threshold,
        'percentile': found.percentile,
        'count': found.count,
        'noise': found.noise,
        'labels': found.labels,
        'sizes': found.sizes,
        'keywords': named['keywords'],
        'labelled': named['labelled'],
        'label_source': named['label_source'],
        'labelled_from': named['labelled_from'],
        'took_ms': {'clusters': int((grouped - started) * 1000), 'labels': int((done - grouped) * 1000)},
    }


__all__ = [
    'Components',
    'LABELLED_MAX',
    'LABEL_MIN_SIZE',
    'LABEL_TERMS',
    'LABEL_TEXTS_MAX',
    'METHOD',
    'STOP_WORDS',
    'cluster_sample',
    'knn_components',
    'label_components',
    'mutual_edges',
    'path_tokens',
    'tokens',
    'union_find',
]
