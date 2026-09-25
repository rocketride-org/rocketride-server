# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for the Chroma distance-to-score conversion (issue #2236).

Chroma returns a *distance* for every ``hnsw:space`` (lower is more similar).
The conversion used to increase with distance, so a perfect cosine match scored
0.5, an orthogonal vector 1.0 and the opposite vector 1.5: ordering by score
was reversed and cosine scores escaped the declared ``[0, 1]`` range.

These tests pin the corrected contract:

1. the cosine values measured against chromadb 1.5.9 in the issue;
2. every space is strictly decreasing in distance and stays inside ``[0, 1]``;
3. for unit-norm embeddings the three spaces agree on the score of a pair;
4. ``_convertToDocs`` ranks a perfect match above a weaker one and drops only
   the tail under ``MIN_RELEVANCE_SCORE``, which stays equal to Qdrant's.

Pure-python arithmetic on purpose: other node test files in the shared CI
worker leave a stubbed ``numpy`` in ``sys.modules``, so nothing here imports it.
The final test runs against a real ``chromadb`` package when one is installed,
so the distance semantics the conversion relies on are checked against the
client rather than assumed.
"""

from __future__ import annotations

import importlib.util
import math
import random
import re
import sys
import types
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_NODES_ROOT = Path(__file__).resolve().parent.parent.parent
_CHROMA_PY = _NODES_ROOT / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'
_QDRANT_PY = _NODES_ROOT / 'src' / 'nodes' / 'store_qdrant' / 'qdrant.py'


# --- Lightweight fakes for the leaf types chroma.py binds at import ----------


class _FakeDoc:
    """Minimal stand-in for ai.common.schema.Doc (records score/content/meta)."""

    def __init__(self, score=0.0, page_content='', metadata=None, embedding=None, embedding_model=None):
        self.score = score
        self.page_content = page_content
        self.metadata = metadata


class _FakeDocumentStoreBase:
    """Non-abstract stand-in for ai.common.store.DocumentStoreBase."""


_STUBBED_MODULE_NAMES = (
    'chromadb',
    'chromadb.config',
    'depends',
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
    'chroma_score_under_test',
)


def _install_stubs() -> None:
    chromadb = types.ModuleType('chromadb')

    class _HttpClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb.HttpClient = _HttpClient
    chromadb.Collection = object
    sys.modules['chromadb'] = chromadb

    chromadb_config = types.ModuleType('chromadb.config')

    class Settings:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb_config.Settings = Settings
    sys.modules['chromadb.config'] = chromadb_config

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *_a, **_k: None
    sys.modules['depends'] = depends_mod

    rocketlib_mod = types.ModuleType('rocketlib')
    rocketlib_mod.debug = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib_mod

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    schema_mod = types.ModuleType('ai.common.schema')
    schema_mod.Doc = _FakeDoc
    schema_mod.DocFilter = SimpleNamespace
    schema_mod.DocMetadata = dict
    schema_mod.QuestionText = SimpleNamespace
    sys.modules['ai.common.schema'] = schema_mod

    store_mod = types.ModuleType('ai.common.store')
    store_mod.DocumentStoreBase = _FakeDocumentStoreBase
    sys.modules['ai.common.store'] = store_mod

    config_mod = types.ModuleType('ai.common.config')
    config_mod.Config = MagicMock()
    sys.modules['ai.common.config'] = config_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUBBED_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name in _STUBBED_MODULE_NAMES:
            if original.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original[name]


def _load_chroma_module():
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location('chroma_score_under_test', _CHROMA_PY)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


_CHROMA = _load_chroma_module()
Store = _CHROMA.Store
SPACES = ('cosine', 'l2', 'ip')


def _make_store(similarity: str = 'cosine') -> 'Store':
    store = Store.__new__(Store)
    store.top_k = None
    store.similarity = similarity
    return store


def _query_result(distances):
    """Build a Chroma query() result shape (distances present, so list-of-lists)."""
    n = len(distances)
    return {
        'ids': [[str(uuid.uuid4()) for _ in range(n)]],
        'metadatas': [[{'objectId': f'obj-{i}', 'chunkId': i, 'nodeId': 'n', 'parent': '/p'} for i in range(n)]],
        'distances': [list(distances)],
        'documents': [[f'chunk {i}' for i in range(n)]],
    }


def _close(actual: float, expected: float, tol: float = 1e-6) -> bool:
    # Plain tolerance compare on purpose: pytest.approx probes numpy's bool_ type,
    # which raises TypeError when a sibling test file left a stubbed numpy behind.
    return abs(actual - expected) <= tol


# --- Chroma's distance definitions, used to derive expectations --------------


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cosine_distance(a, b):
    return 1.0 - _dot(a, b) / (math.sqrt(_dot(a, a)) * math.sqrt(_dot(b, b)))


def _ip_distance(a, b):
    return 1.0 - _dot(a, b)


def _l2_distance(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b))


_DISTANCE = {'cosine': _cosine_distance, 'ip': _ip_distance, 'l2': _l2_distance}


def _unit_vector(rng: random.Random, dims: int):
    raw = [rng.gauss(0.0, 1.0) for _ in range(dims)]
    norm = math.sqrt(_dot(raw, raw))
    return [x / norm for x in raw]


# --- 1. The cosine table measured in #2236 ------------------------------------


@pytest.mark.parametrize(
    'distance,expected',
    [
        (0.0, 1.0),  # identical
        (0.292893, 0.853553),  # 45 degrees
        (1.0, 0.5),  # orthogonal
        (1.707107, 0.146447),  # 135 degrees
        (2.0, 0.0),  # opposite
    ],
)
def test_cosine_matches_measured_table(distance, expected):
    assert _close(Store._distanceToScore(distance, 'cosine'), expected)


@pytest.mark.parametrize(
    'distance,expected',
    [
        (-4.0, 1.0),  # dot = 5, the best match in the issue's table; used to score 0.49 and be dropped
        (0.0, 1.0),  # dot = 1, a unit-vector identity
        (1.0, 0.5),  # dot = 0
        (2.0, 0.0),  # dot = -1
        (3.0, 0.0),  # dot = -2, clamped
    ],
)
def test_ip_saturates_instead_of_dropping_strong_matches(distance, expected):
    assert _close(Store._distanceToScore(distance, 'ip'), expected)


@pytest.mark.parametrize(
    'distance,expected',
    [
        (0.0, 1.0),  # identical
        (2.0, 0.5),  # orthogonal unit vectors
        (4.0, 0.0),  # opposite unit vectors
        (41.0, 0.0),  # non-normalized far match from the issue's table, clamped
    ],
)
def test_l2_squared_distance(distance, expected):
    assert _close(Store._distanceToScore(distance, 'l2'), expected)


# --- 2. Monotone, bounded ------------------------------------------------------


@pytest.mark.parametrize('space', SPACES)
def test_score_strictly_decreases_with_distance_inside_range(space):
    top = 2.0 if space in ('cosine', 'ip') else 4.0
    steps = 40
    scores = [Store._distanceToScore(top * i / steps, space) for i in range(steps + 1)]
    assert all(earlier > later for earlier, later in zip(scores, scores[1:]))
    assert _close(scores[0], 1.0)
    assert _close(scores[-1], 0.0)


@pytest.mark.parametrize('space', SPACES)
@pytest.mark.parametrize('distance', [-10.0, -1.0, 0.0, 0.5, 1.0, 2.0, 4.0, 41.0, 1e6])
def test_score_never_leaves_unit_interval(space, distance):
    score = Store._distanceToScore(distance, space)
    assert 0.0 <= score <= 1.0
    assert isinstance(score, float)


@pytest.mark.parametrize('space', SPACES)
def test_score_never_increases_with_distance(space):
    previous = Store._distanceToScore(-10.0, space)
    for distance in (-1.0, 0.0, 0.25, 1.0, 2.0, 4.0, 41.0, 1e6):
        current = Store._distanceToScore(distance, space)
        assert current <= previous
        previous = current


def test_unknown_similarity_is_rejected():
    with pytest.raises(ValueError):
        Store._distanceToScore(0.0, 'Cosine')


def test_class_default_similarity_is_a_supported_space():
    """The class attribute used to read 'Cosine', which the constructor never
    produces and the conversion would reject.
    """
    assert Store.similarity in SPACES


# --- 3. The three spaces agree on unit vectors ---------------------------------


def test_spaces_agree_on_unit_vectors():
    rng = random.Random(2236)
    for _ in range(200):
        a = _unit_vector(rng, 8)
        b = _unit_vector(rng, 8)
        expected = (_dot(a, b) + 1.0) / 2.0  # the Qdrant cosine rescale
        for space in SPACES:
            score = Store._distanceToScore(_DISTANCE[space](a, b), space)
            assert _close(score, expected, tol=1e-9), (space, score, expected)


def test_cosine_ignores_vector_length():
    rng = random.Random(1)
    a = _unit_vector(rng, 6)
    b = _unit_vector(rng, 6)
    scaled = [7.5 * x for x in b]
    plain = Store._distanceToScore(_cosine_distance(a, b), 'cosine')
    stretched = Store._distanceToScore(_cosine_distance(a, scaled), 'cosine')
    assert _close(plain, stretched, tol=1e-9)


# --- 4. _convertToDocs: ranking and the relevance floor -------------------------


def test_convert_to_docs_scores_perfect_match_highest():
    store = _make_store('cosine')

    docs = store._convertToDocs(_query_result([0.0, 1.0, 1.5]))

    assert [d.page_content for d in docs] == ['chunk 0', 'chunk 1', 'chunk 2']
    assert _close(docs[0].score, 1.0)
    assert _close(docs[1].score, 0.5)
    assert _close(docs[2].score, 0.25)
    assert docs[0].score > docs[1].score > docs[2].score


@pytest.mark.parametrize('space', SPACES)
def test_convert_to_docs_uses_the_configured_space(space):
    store = _make_store(space)
    distance = 1.0 if space in ('cosine', 'ip') else 2.0  # an orthogonal unit-vector pair in each space

    docs = store._convertToDocs(_query_result([distance]))

    assert len(docs) == 1
    assert _close(docs[0].score, 0.5)


def test_convert_to_docs_drops_only_the_tail_under_the_floor():
    store = _make_store('cosine')

    # 1.7 -> 0.15 (dropped), 1.5 -> 0.25 (kept), 0.0 -> 1.0 (kept)
    docs = store._convertToDocs(_query_result([0.0, 1.7, 1.5]))

    assert [d.page_content for d in docs] == ['chunk 0', 'chunk 2']
    assert all(d.score >= _CHROMA.MIN_RELEVANCE_SCORE for d in docs)


def test_convert_to_docs_without_distances_keeps_zero_score():
    """A get()/keyword result carries no distances; its documents still pass through with score 0."""
    store = _make_store('cosine')

    docs = store._convertToDocs({'ids': ['a'], 'metadatas': [{'objectId': 'a'}], 'documents': ['text']})

    assert len(docs) == 1
    assert docs[0].score == 0.0


def test_relevance_floor_matches_qdrant():
    """Both stores rescale to the same [0, 1] cosine scale, so they trim the same tail."""
    match = re.search(r'^MIN_RELEVANCE_SCORE\s*=\s*([0-9.]+)', _QDRANT_PY.read_text(encoding='utf-8'), re.M)
    assert match is not None, 'store_qdrant no longer defines MIN_RELEVANCE_SCORE'
    assert _CHROMA.MIN_RELEVANCE_SCORE == float(match.group(1))


# --- 5. Against the real client, when one is installed -------------------------


@pytest.mark.parametrize('space', SPACES)
def test_conversion_against_installed_chromadb(space):
    """Chroma's own distances for identical, orthogonal and opposite unit vectors
    convert to 1.0, 0.5 and 0.0 in every space.

    Skipped when the full ``chromadb`` package (with an in-process client) is not
    installed; the node itself only needs ``chromadb-client``.
    """
    chromadb = pytest.importorskip('chromadb')
    if not hasattr(chromadb, 'EphemeralClient'):
        pytest.skip('chromadb-client has no in-process EphemeralClient')

    collection = chromadb.EphemeralClient().create_collection(
        f'probe_{space}_{uuid.uuid4().hex[:8]}', metadata={'hnsw:space': space}
    )
    collection.add(
        ids=['identical', 'orthogonal', 'opposite'],
        embeddings=[[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]],
    )
    result = collection.query(query_embeddings=[[1.0, 0.0]], n_results=3, include=['distances'])

    measured = dict(zip(result['ids'][0], result['distances'][0]))
    assert _close(Store._distanceToScore(measured['identical'], space), 1.0, tol=1e-5)
    assert _close(Store._distanceToScore(measured['orthogonal'], space), 0.5, tol=1e-5)
    assert _close(Store._distanceToScore(measured['opposite'], space), 0.0, tol=1e-5)
