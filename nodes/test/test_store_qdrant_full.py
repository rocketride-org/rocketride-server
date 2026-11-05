# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Qdrant driver's explorer hooks against a real Qdrant (no mocks).

Runs the shared driver contract (``vector_store_contract.py``) on a new
collection, on a collection written the way the previous driver wrote it
(random point ids), on one created without the driver's payload indexes, and
read-only on the seeded ``vx_legacy_docs``; then the driver repairs and
Qdrant's own neighbour graph (``search_matrix_offsets``, ``knn_source:
'native'``), which must agree with the exact graph on at least 95 % of edges.
A 1,503-document collection checks the counts, the orphan sweep and the
neighbour graph past the driver's caps, with the server's memory read from
its ``/metrics`` around each graph.

Needs a disposable local Qdrant, e.g. the ``vx-qdrant`` container that
``scripts/acceptance/vector-explorer/containers/start.sh`` starts
(qdrant/qdrant:v1.17.1 on 127.0.0.1:56333). The suite creates and drops its
own ``vx_contract_*`` collections and never writes to the seeded one.

Configuration:
    RR_TEST_QDRANT_URL   - REST address (default http://127.0.0.1:56333)
    RR_REQUIRE_DB_TESTS  - set by the database lane: an unreachable server fails
                           the run instead of skipping it with "NOT RUN:".

Must run without ``ROCKETRIDE_MOCK`` (``nodes/test/mocks`` shadows qdrant_client).
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys
import time
import types
import urllib.request
import uuid
from pathlib import Path

import numpy as np
import pytest

from . import vector_store_contract as contract

QDRANT_URL = os.environ.get('RR_TEST_QDRANT_URL', 'http://127.0.0.1:56333').rstrip('/')
_DRIVER = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'store_qdrant' / 'qdrant.py'
_MOCKS = str(Path(__file__).resolve().parent / 'mocks')
_RUN = uuid.uuid4().hex[:8]


def _reachable() -> bool:
    try:
        with urllib.request.urlopen(QDRANT_URL + '/', timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


if not _reachable():
    if contract.required():
        pytest.fail(f'RR_REQUIRE_DB_TESTS is set but Qdrant is not reachable at {QDRANT_URL}', pytrace=False)
    pytest.skip(f'NOT RUN: Qdrant not reachable at {QDRANT_URL}', allow_module_level=True)

# A unit-test module may have left a stub or the mock client in sys.modules.
for _name in [n for n in sys.modules if n == 'qdrant_client' or n.startswith('qdrant_client.')]:
    _file = getattr(sys.modules[_name], '__file__', None) or ''
    if not _file or _file.startswith(_MOCKS):
        del sys.modules[_name]

from qdrant_client import QdrantClient, models  # noqa: E402

from ai.common.schema import DocFilter, QuestionText  # noqa: E402


def _load_driver():
    """Execute the driver as the engine does (its requirements are installed: depends() only checks)."""
    spec = importlib.util.spec_from_file_location('_vx_qdrant_driver_live', _DRIVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # Resolve the node configuration from the dict the suite passes (no services registry here).
    module.Config = types.SimpleNamespace(getNodeConfig=lambda _provider, conn: dict(conn))
    return module


drv = _load_driver()
assert drv.QdrantClient is QdrantClient, 'the live suite must use the real qdrant_client'

RAW = QdrantClient(url=QDRANT_URL, prefer_grpc=False, timeout=60)
_CREATED = []


def _store(collection: str):
    host, port = QDRANT_URL.rsplit(':', 1)
    conn = {'collection': collection, 'host': host, 'port': int(port), 'similarity': 'Cosine', 'score': 0.3}
    return drv.Store('qdrant', conn, {})


def _vx_filter(**kwargs):
    fields = getattr(DocFilter, 'model_fields', {})
    if 'deleted' in fields and 'minScore' in fields:
        return DocFilter(**kwargs)

    class _VxDocFilter(DocFilter):
        deleted: str | None = None
        minScore: float | None = None

    return _VxDocFilter(**kwargs)


def _new_collection(kind: str) -> str:
    name = f'vx_contract_{kind}_{_RUN}'
    _CREATED.append(name)
    return name


def _plant_orphan_and_soft_delete(store) -> None:
    RAW.delete(
        store.collection,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[
                    models.FieldCondition(key='meta.objectId', match=models.MatchValue(value=contract.ORPHAN)),
                    models.FieldCondition(key='meta.chunkId', match=models.MatchValue(value=0)),
                ]
            )
        ),
        wait=True,
    )
    store.markDeleted([contract.SOFT_DELETED])


def _server_memory_mib():
    """Qdrant's allocated memory in MiB (its /metrics), or None when the server does not report it."""
    try:
        with urllib.request.urlopen(QDRANT_URL + '/metrics', timeout=5) as response:
            text = response.read().decode()
    except Exception:
        return None
    for line in text.splitlines():
        if line.startswith('memory_allocated_bytes '):
            return float(line.split()[1]) / 2**20
    return None


def _write_like_the_previous_driver(store, docs) -> None:
    """Create the collection and write rows as the previous driver did: random ids, same payload."""
    store._createCollection(contract.DIM)
    points = [
        models.PointStruct(
            id=str(uuid.uuid4()), vector=d.embedding, payload={'content': d.page_content, 'meta': d.metadata}
        )
        for d in [contract.control_doc()] + docs
    ]
    RAW.upsert(store.collection, points=points, wait=True)


def _raw_rows(collection: str):
    offset = None
    while True:
        records, offset = RAW.scroll(collection, limit=256, offset=offset, with_payload=['meta'], with_vectors=True)
        for record in records:
            yield record.payload.get('meta') or {}, record.vector
        if offset is None:
            return


@pytest.fixture(scope='module', autouse=True)
def _cleanup():
    yield
    contract.drop_collections(_CREATED, lambda name: RAW.delete_collection(name))


@pytest.fixture(scope='module')
def new_store():
    store = _store(_new_collection('new'))
    store.addChunks(contract.corpus_docs())
    _plant_orphan_and_soft_delete(store)
    return store, contract.corpus_expectations()


@pytest.fixture(scope='module')
def legacy_shape_store():
    store = _store(_new_collection('legacy'))
    _write_like_the_previous_driver(store, contract.corpus_docs())
    _plant_orphan_and_soft_delete(store)
    return store, contract.corpus_expectations()


@pytest.fixture(scope='module')
def unindexed_store():
    """The corpus in a collection created outside the driver: no payload index at all."""
    store = _store(_new_collection('unindexed'))
    RAW.create_collection(store.collection, vectors_config=models.VectorParams(size=contract.DIM, distance='Cosine'))
    docs = [contract.control_doc()] + contract.corpus_docs()
    points = [
        models.PointStruct(
            id=drv.point_id_for(d.metadata.objectId, d.metadata.chunkId),
            vector=d.embedding,
            payload={'content': d.page_content, 'meta': d.metadata},
        )
        for d in docs
    ]
    RAW.upsert(store.collection, points=points, wait=True)
    assert not RAW.get_collection(store.collection).payload_schema
    _plant_orphan_and_soft_delete(store)
    return store, contract.corpus_expectations()


@pytest.fixture(scope='module')
def scale_store():
    store = _store(_new_collection('scale'))
    store.addChunks(contract.scale_docs())
    return store


@pytest.fixture(scope='module')
def seeded_legacy_store():
    name = contract.SEEDED_LEGACY_COLLECTION
    if not RAW.collection_exists(name):
        pytest.skip(f'NOT RUN: the legacy collection {name} is not seeded on this Qdrant')
    store = _store(name)
    assert store.doesCollectionExist(), 'the seeded legacy collection has no control record'
    expect = contract.expectations_from_rows(_raw_rows(name), store.vectorSize, store.modelName)
    return store, expect


@pytest.fixture(params=['new', 'legacy_shape', 'unindexed', 'seeded_legacy'])
def collection(request):
    return request.getfixturevalue(f'{request.param}_store')


# --- the shared contract ----------------------------------------------------------------


def test_describe(collection):
    store, expect = collection
    info = store.describe()
    contract.assert_no_connection_details(info)
    assert info.backend == 'qdrant'
    assert info.backend_version and info.backend_version[0].isdigit()
    assert info.collection == store.collection
    assert info.collection_exists is True and info.control_record is True
    assert info.metric == 'cosine'
    assert info.dimension == expect.dimension and info.model == expect.model
    assert info.index['type'] == 'hnsw' and info.index['params']['m'] > 0
    assert info.index['params']['ef_construction'] > 0
    assert 'brute_force_search' in info.caveats


def test_counts(collection):
    store, expect = collection
    assert store.countChunks(_vx_filter()) == expect.chunks
    assert store.countChunks(_vx_filter(chunkIds=[0])) == len(expect.documents) - len(expect.orphans)
    assert store.countDocumentsWhere(_vx_filter()) == len(expect.documents)
    assert store.count_documents() >= expect.chunks + 1


def test_listing_lists_every_document_once_and_the_orphan_last(collection):
    store, expect = collection
    contract.check_listing(store, expect, limit=7)


def test_chunks_page_in_chunk_order(collection):
    store, expect = collection
    largest = max(expect.documents, key=lambda oid: (expect.documents[oid], oid))
    contract.check_scroll_chunks(store, expect, largest, page=max(2, expect.documents[largest] // 3))
    orphan = sorted(expect.orphans)[0]
    contract.check_scroll_chunks(store, expect, orphan, page=50)


def test_vectors_by_key(collection):
    store, expect = collection
    keys = sorted(expect.vectors)[:: max(1, len(expect.vectors) // 12)][:12]
    contract.check_get_vectors(store, expect, keys)


def test_random_sample(collection):
    store, expect = collection
    n = min(20, expect.chunks)
    docs, used = store.sampleChunks(n=n, seed=3, strategy='random', docFilter=_vx_filter(), include_keys=[])
    assert used == 'random' and len(docs) == n
    for d in docs:
        key = (d.metadata.objectId, d.metadata.chunkId)
        assert key in expect.vectors
        assert np.allclose(d.embedding, expect.vectors[key], atol=1e-5)


def test_neighbour_graph_is_computed_by_qdrant(collection):
    store, expect = collection
    keys = sorted(expect.vectors)[:200]
    docs = store.getVectors(keys)
    assert [(d.metadata.objectId, d.metadata.chunkId) for d in docs] == keys
    X = np.asarray([d.embedding for d in docs], dtype=np.float32)
    k = min(10, len(keys) - 1)
    graph = store.knnGraph(keys, X, 'cosine', k)
    assert graph.source == 'native'
    contract.check_knn_rows(graph, X, k)
    assert contract.knn_agreement(graph, contract.exact_knn_sets(X.astype(np.float64), k), k) >= 0.95


def test_neighbour_graph_agrees_with_vx_math(collection):
    from ai.common.store import vx_math

    store, expect = collection
    keys = sorted(expect.vectors)[:200]
    X = np.asarray([d.embedding for d in store.getVectors(keys)], dtype=np.float32)
    k = min(15, len(keys) - 1)
    graph = store.knnGraph(keys, X, 'cosine', k)
    offsets, cols, _ = vx_math.knn('cosine', X, k)
    exact = [set(cols[offsets[i] : offsets[i + 1]].tolist()) for i in range(len(keys))]
    assert graph.source == 'native'
    assert contract.knn_agreement(graph, exact, k) >= 0.95


def test_documents_tool_lists_the_orphan_unsorted(collection):
    from ai.common.store import VectorStoreToolMixin

    store, expect = collection
    node = VectorStoreToolMixin()
    node.IGlobal = types.SimpleNamespace(store=store)
    answer = node.list_documents({'limit': 500, 'deleted': 'active'})
    assert answer['success'] is True and answer['sorted'] is False
    orphans = {i['objectId'] for i in answer['items'] if not i['has_first_chunk']}
    assert orphans == expect.orphans


# --- repairs and writes (collections this suite owns) -------------------------------------


def test_new_rows_have_deterministic_ids(new_store):
    store, _ = new_store
    pid = drv.point_id_for('doc-00', 2)
    assert pid == str(uuid.uuid5(uuid.NAMESPACE_URL, 'doc-00#2'))
    record = RAW.retrieve(store.collection, ids=[pid], with_payload=True)[0]
    assert record.payload['meta']['objectId'] == 'doc-00' and record.payload['meta']['chunkId'] == 2


def test_numeric_offset_pages_without_repeating(new_store):
    store, expect = new_store
    first = [(d.metadata.objectId, d.metadata.chunkId) for d in store.get(DocFilter(limit=5, offset=0))]
    second = [(d.metadata.objectId, d.metadata.chunkId) for d in store.get(DocFilter(limit=5, offset=5))]
    assert len(first) == 5 and len(second) == 5 and not set(first) & set(second)


def test_parent_filter_is_the_exact_path():
    # A second path that contains the first one, and a token of both: a text
    # match on meta.parent would select both documents for either.
    store = _store(_new_collection('paths'))
    path = contract.path_of('doc-01')
    docs = [d for d in contract.corpus_docs() if d.metadata.objectId in ('doc-01', 'doc-03')]
    for d in docs:
        if d.metadata.objectId == 'doc-03':
            d.metadata.parent = path + '.bak'
    store.addChunks(docs)

    got = store.get(DocFilter(parent=path, limit=50))
    assert {d.metadata.objectId for d in got} == {'doc-01'}
    assert store.getPaths(parent=path) == {path: 'doc-01'}
    assert store.getPaths(parent='doc-01') == {}
    assert store.getPaths() == {path: 'doc-01', path + '.bak': 'doc-03'}


def test_a_cursor_with_a_malformed_point_id_is_refused(new_store):
    import base64
    import json

    from ai.common.store.errors import ToolRefusal

    store, expect = new_store

    def cursor(point):
        return base64.urlsafe_b64encode(json.dumps({'ph': 'c', 'p': point}).encode()).decode()

    for point in ('zzz', -1):
        with pytest.raises(ToolRefusal) as err:
            store.listDocumentPage(cursor=cursor(point), limit=5, object_ids=None, deleted='active', sort='path')
        assert err.value.code == 'INVALID_INPUT'
    # A well-formed id is a position: Qdrant starts at the first point at or after it.
    page = store.listDocumentPage(
        cursor=cursor('00000000-0000-0000-0000-000000000000'), limit=50, object_ids=None, deleted='active', sort='path'
    )
    assert {i.objectId for i in page.items} == set(expect.documents)


def test_dot_scores_spread_over_the_whole_range():
    host, port = QDRANT_URL.rsplit(':', 1)
    conn = {'collection': _new_collection('dot'), 'host': host, 'port': int(port), 'similarity': 'Dot', 'score': 0.3}
    store = drv.Store('qdrant', conn, {})
    store.addChunks(contract.corpus_docs())
    vectors = contract.corpus_vectors()
    key = sorted(vectors)[0]
    query = QuestionText(text='q')
    query.embedding_model = contract.MODEL
    query.embedding = list(vectors[key])
    best = store.searchSemantic(query, _vx_filter(limit=100, minScore=-math.inf))
    assert (best[0].metadata.objectId, best[0].metadata.chunkId) == key
    assert best[0].score == pytest.approx(1.0, abs=1e-4)
    query.embedding = [-x for x in vectors[key]]
    worst = store.searchSemantic(query, _vx_filter(limit=100, minScore=-math.inf))
    assert min(d.score for d in worst) == pytest.approx(0.0, abs=1e-4)
    assert store.scoreInfo()['formula'] == '(1 + dot) / 2' and store.scoreInfo()['range'] is None


def test_floor_and_min_score(new_store):
    store, expect = new_store
    key = sorted(expect.vectors)[0]
    query = QuestionText(text='q')
    query.embedding = [-x for x in expect.vectors[key]]  # the opposite of a stored chunk
    query.embedding_model = contract.MODEL
    floored = store.searchSemantic(query, DocFilter(limit=100))
    everything = store.searchSemantic(query, _vx_filter(limit=100, minScore=-math.inf))
    assert len(everything) == expect.chunks
    assert all(d.score >= 0.2 for d in floored) and len(floored) < len(everything)
    assert min(d.score for d in everything) == pytest.approx(0.0, abs=1e-4)


def test_soft_delete_keeps_the_payload(new_store):
    store, _ = new_store
    records, _ = RAW.scroll(
        store.collection,
        scroll_filter=models.Filter(
            must=[models.FieldCondition(key='meta.objectId', match=models.MatchValue(value=contract.SOFT_DELETED))]
        ),
        limit=50,
        with_payload=True,
    )
    assert len(records) == contract.DOCS[contract.SOFT_DELETED]
    for record in records:
        meta = record.payload['meta']
        assert meta['isDeleted'] is True and meta['parent'] == contract.path_of(contract.SOFT_DELETED)


# --- past the caps (1,503 documents) --------------------------------------------------------


def test_scale_counts(scale_store):
    total = contract.SCALE_DOCS + len(contract.SCALE_ORPHANS)
    assert scale_store.countDocumentsWhere(_vx_filter()) == total
    assert scale_store.countChunks(_vx_filter(chunkIds=[0])) == contract.SCALE_DOCS
    assert scale_store.countChunks(_vx_filter()) == 2 * contract.SCALE_DOCS + len(contract.SCALE_ORPHANS)


def test_scale_listing_finds_every_low_count_orphan(scale_store):
    contract.check_scale_listing(scale_store)


def test_scale_orphan_pages_reuse_the_listing_sweep(scale_store, monkeypatch):
    # One document per page over a chunk-0 document and the three without chunk 0:
    # the page where the chunk-0 rows run out sweeps; the later pages only read rows.
    scope = [contract.scale_object_id(0), *contract.SCALE_ORPHANS]
    calls = []
    facet = scale_store.client.facet

    def spy(*args, **kwargs):
        calls.append(kwargs.get('limit'))
        return facet(*args, **kwargs)

    monkeypatch.setattr(scale_store.client, 'facet', spy)
    pages, cursor = [], None
    for _ in range(10):
        calls.clear()
        page = scale_store.listDocumentPage(cursor=cursor, limit=1, object_ids=scope, deleted='active', sort='path')
        pages.append((page, list(calls)))
        cursor = page.next_cursor
        if cursor is None:
            break
    orphan_pages = [(page, facets) for page, facets in pages if page.items and not page.items[0].has_first_chunk]
    assert [page.items[0].objectId for page, _ in orphan_pages] == sorted(contract.SCALE_ORPHANS)
    assert all(facets == [] for _, facets in orphan_pages[1:]), [facets for _, facets in orphan_pages]
    assert {page.total for page, _ in pages} == {len(scope)}


def _scale_keys(n):
    keys = [(contract.scale_object_id(d), c) for c in range(2) for d in range(contract.SCALE_DOCS)]
    return keys[:n]


def test_scale_native_neighbour_graph_at_the_cap_keeps_the_server_up(scale_store):
    n = drv.Store.NATIVE_KNN_MAX
    keys = _scale_keys(n)
    X = np.asarray([d.embedding for d in scale_store.getVectors(keys)], dtype=np.float32)
    assert len(X) == n
    before = _server_memory_mib()
    graph = scale_store.knnGraph(keys, X, 'cosine', 15)
    after = _server_memory_mib()
    assert graph.source == 'native'
    assert contract.knn_agreement(graph, contract.exact_knn_sets(X.astype(np.float64), 15), 15) >= 0.95
    assert RAW.collection_exists(scale_store.collection)  # the server still answers
    if before is not None and after is not None:
        assert after - before < 64, (before, after)


def test_scale_default_sample_graph_is_computed_on_the_node(scale_store, monkeypatch):
    # The explorer's default sample is above the native cap (its server memory, see the driver).
    from ai.common.store.vx_defaults import VECTOR_TOOL_LIMITS

    n = VECTOR_TOOL_LIMITS['sample_default']
    assert n > drv.Store.NATIVE_KNN_MAX
    keys = _scale_keys(n)
    X = np.asarray([d.embedding for d in scale_store.getVectors(keys)], dtype=np.float32)
    calls = []
    monkeypatch.setattr(scale_store.client, 'search_matrix_offsets', lambda *a, **k: calls.append(k))
    before = _server_memory_mib()
    graph = scale_store.knnGraph(keys, X, 'cosine', 15)
    after = _server_memory_mib()
    assert calls == [] and graph.source == 'node'
    assert contract.knn_agreement(graph, contract.exact_knn_sets(X.astype(np.float64), 15), 15) >= 0.999
    assert RAW.collection_exists(scale_store.collection)
    if before is not None and after is not None:
        assert after - before < 64, (before, after)


# --- past the document cap (COUNT_DOCUMENTS_CAP + 503 documents) ----------------------------


@pytest.fixture(scope='module')
def capped_store():
    """One-row documents 500 past the driver's document cap, plus three whose only row is chunk 1."""
    from ai.common.schema import Doc, DocMetadata

    store = _store(_new_collection('capped'))
    rng = np.random.default_rng(31)
    rows = [(f'cap-{d:05d}', 0) for d in range(drv.Store.COUNT_DOCUMENTS_CAP + 500)]
    rows += [(oid, 1) for oid in contract.SCALE_ORPHANS]
    docs = []
    for oid, chunk in rows:
        v = rng.normal(size=8)
        metadata = DocMetadata(
            objectId=oid,
            chunkId=chunk,
            nodeId='chunk_1',
            parent=f'/srv/vx-capped/{oid}.txt',
            permissionId=0,
            isDeleted=False,
            isTable=False,
            tableId=0,
        )
        doc = Doc(page_content=f'{oid} chunk {chunk}', metadata=metadata)
        doc.embedding = (v / np.linalg.norm(v)).tolist()
        doc.embedding_model = contract.MODEL
        docs.append(doc)
    store.addChunks(docs)
    return store, len(rows)


def test_capped_listing_has_no_slow_page_and_never_facets_over_the_counted_ids(capped_store, monkeypatch):
    # On qdrant 1.17.1 an exact facet over a MatchAny of the 10,000 counted ids took 17-35 s
    # (500 ids: 0.05 s), which made the page where the chunk-0 rows run out stall the listing.
    store, documents = capped_store
    calls = []
    facet = store.client.facet

    def spy(*args, **kwargs):
        conditions = getattr(kwargs.get('facet_filter'), 'must', None) or []
        lists = [c.match.any for c in conditions if getattr(getattr(c, 'match', None), 'any', None) is not None]
        calls.append(max((len(values) for values in lists), default=0))
        return facet(*args, **kwargs)

    monkeypatch.setattr(store.client, 'facet', spy)
    seen, orphans, slowest, cursor = [], [], 0.0, None
    for _ in range(documents // 500 + 5):
        started = time.monotonic()
        page = store.listDocumentPage(cursor=cursor, limit=500, object_ids=None, deleted='active', sort='path')
        slowest = max(slowest, time.monotonic() - started)
        assert 'document_count_capped' in page.caveats and page.total is None
        seen += [i.objectId for i in page.items]
        orphans += [i.objectId for i in page.items if not i.has_first_chunk]
        cursor = page.next_cursor
        if cursor is None:
            break
    assert cursor is None, 'the listing never ended'
    assert len(seen) == len(set(seen))
    assert set(seen) >= {f'cap-{d:05d}' for d in range(drv.Store.COUNT_DOCUMENTS_CAP + 500)}
    assert set(orphans) <= set(contract.SCALE_ORPHANS)  # capped may miss one, never invents one
    assert max(calls) <= 500, max(calls)  # no facet over more objectIds than one page holds
    assert slowest < 5, f'slowest page {slowest:.1f}s'


@pytest.mark.parametrize('shape', ['new', 'legacy'])
def test_remove_counted_reports_rows_and_spares_the_control_record(shape):
    store = _store(_new_collection(f'remove_{shape}'))
    if shape == 'new':
        store.addChunks(contract.corpus_docs())
    else:
        _write_like_the_previous_driver(store, contract.corpus_docs())
    store.markDeleted(['doc-04'])
    removed = store.removeCounted(['doc-03', 'doc-04', 'schema', 'no-such-document'])
    assert removed == contract.DOCS['doc-03'] + contract.DOCS['doc-04']
    assert store.countChunks(_vx_filter(objectIds=['doc-03', 'doc-04'], deleted='all')) == 0
    assert store.describe().control_record is True
    assert store.removeCounted(['doc-03']) == 0


def test_a_missing_collection_answers_without_raising():
    store = _store(f'vx_contract_absent_{_RUN}')
    info = store.describe()
    assert info.collection_exists is False and info.control_record is None
    assert store.countChunks(_vx_filter()) == 0
    assert store.listDocumentPage(cursor=None, limit=5, object_ids=None, deleted='active', sort='path').items == []
