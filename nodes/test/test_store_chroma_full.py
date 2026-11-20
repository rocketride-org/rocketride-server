# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Chroma driver's explorer hooks against a real Chroma (no mocks).

Runs the shared driver contract (``vector_store_contract.py``) on a new
collection, on a collection written the way the previous driver wrote it
(random ids), and read-only on the seeded ``vx_legacy_docs``; then the driver
repairs: scores that rise with similarity, the floor, soft delete, paths and
render, empty id lists, and that the store's quick figures never read every
id. A 1,503-document collection checks the orphan sweep and the counts at
scale.

Needs a disposable local Chroma, e.g. the ``vx-chroma`` container that
``scripts/acceptance/vector-explorer/containers/start.sh`` starts
(chromadb/chroma:1.5.9 on 127.0.0.1:58000). The suite creates and drops its
own ``vx_contract_*`` collections and never writes to the seeded one.

Configuration:
    RR_TEST_CHROMA_HOST, RR_TEST_CHROMA_PORT - server address (default 127.0.0.1:58000)
    RR_REQUIRE_DB_TESTS - set by the database lane: an unreachable server fails
                          the run instead of skipping it with "NOT RUN:".

Must run without ``ROCKETRIDE_MOCK`` (``nodes/test/mocks`` shadows chromadb).
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys
import types
import urllib.request
import uuid
from pathlib import Path

import numpy as np
import pytest

from . import vector_store_contract as contract

CHROMA_HOST = os.environ.get('RR_TEST_CHROMA_HOST', '127.0.0.1')
CHROMA_PORT = int(os.environ.get('RR_TEST_CHROMA_PORT', '58000'))
_DRIVER = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'
_MOCKS = str(Path(__file__).resolve().parent / 'mocks')
_RUN = uuid.uuid4().hex[:8]


def _reachable() -> bool:
    try:
        url = f'http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/heartbeat'
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


if not _reachable():
    if contract.required():
        pytest.fail(
            f'RR_REQUIRE_DB_TESTS is set but Chroma is not reachable at {CHROMA_HOST}:{CHROMA_PORT}', pytrace=False
        )
    pytest.skip(f'NOT RUN: Chroma not reachable at {CHROMA_HOST}:{CHROMA_PORT}', allow_module_level=True)

# A unit-test module may have left a stub or the mock client in sys.modules.
for _name in [n for n in sys.modules if n == 'chromadb' or n.startswith('chromadb.')]:
    _file = getattr(sys.modules[_name], '__file__', None) or ''
    if not _file or _file.startswith(_MOCKS):
        del sys.modules[_name]

import chromadb  # noqa: E402

from ai.common.schema import DocFilter, QuestionText  # noqa: E402


def _load_driver():
    """Execute the driver as the engine does (its requirements are installed: depends() only checks)."""
    spec = importlib.util.spec_from_file_location('_vx_chroma_driver_live', _DRIVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # Resolve the node configuration from the dict the suite passes (no services registry here).
    module.Config = types.SimpleNamespace(getNodeConfig=lambda _provider, conn: dict(conn))
    return module


drv = _load_driver()
assert drv.chromadb is chromadb, 'the live suite must use the real chromadb client'

RAW = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
_CREATED = []


def _store(collection: str, similarity: str = 'cosine'):
    conn = {
        'collection': collection,
        'host': CHROMA_HOST,
        'port': CHROMA_PORT,
        'similarity': similarity,
        'score': 0.3,
        'mode': 'local',
    }
    return drv.Store('chroma', conn, {})


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
    store.collectionObj.delete(where={'$and': [{'objectId': contract.ORPHAN}, {'chunkId': 0}]})
    store.markDeleted([contract.SOFT_DELETED])


def _write_like_the_previous_driver(store, docs) -> None:
    """Create the collection and write rows as the previous driver did: random ids, same metadata."""
    store._createCollection(contract.DIM)
    rows = [contract.control_doc()] + docs
    store.collectionObj.upsert(
        ids=[str(uuid.uuid4()) for _ in rows],
        embeddings=[d.embedding for d in rows],
        metadatas=[{k: v for k, v in d.metadata.toDict().items() if v is not None} for d in rows],
        documents=[d.page_content for d in rows],
    )


def _raw_rows(collection: str):
    col = RAW.get_collection(collection)
    offset = 0
    while True:
        page = col.get(include=['metadatas', 'embeddings'], limit=1000, offset=offset)
        for meta, vector in zip(page['metadatas'], page['embeddings']):
            yield meta or {}, None if vector is None else list(vector)
        if len(page['ids']) < 1000:
            return
        offset += 1000


class _GetSpy:
    """Wraps a collection's get() to record the include list of every read."""

    def __init__(self, collection):
        self.includes = []
        self._get = collection.get

    def __call__(self, *args, **kwargs):
        self.includes.append(list(kwargs.get('include', ['metadatas', 'documents'])))
        return self._get(*args, **kwargs)


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
def scale_store():
    store = _store(_new_collection('scale'))
    store.addChunks(contract.scale_docs())
    return store


@pytest.fixture(scope='module')
def seeded_legacy_store():
    name = contract.SEEDED_LEGACY_COLLECTION
    names = [c if isinstance(c, str) else c.name for c in RAW.list_collections()]
    if name not in names:
        pytest.skip(f'NOT RUN: the legacy collection {name} is not seeded on this Chroma')
    store = _store(name)
    assert store.doesCollectionExist(), 'the seeded legacy collection has no control record'
    expect = contract.expectations_from_rows(_raw_rows(name), store.vectorSize, store.modelName)
    return store, expect


@pytest.fixture(params=['new', 'legacy_shape', 'seeded_legacy'])
def collection(request):
    return request.getfixturevalue(f'{request.param}_store')


# --- the shared contract ----------------------------------------------------------------


def test_describe_without_reading_every_id(collection):
    store, expect = collection
    spy = _GetSpy(store.collectionObj) if store.collectionObj is not None else None
    if spy is not None:
        store.collectionObj.get = spy
    try:
        info = store.describe()
    finally:
        if spy is not None:
            del store.collectionObj.get
    contract.assert_no_connection_details(info)
    assert info.backend == 'chroma'
    assert info.backend_version and info.backend_version[0].isdigit()
    assert info.collection == store.collection
    assert info.collection_exists is True and info.control_record is True
    assert info.metric == 'cosine'
    assert info.dimension == expect.dimension and info.model == expect.model
    assert info.index['type'] == 'hnsw' and info.index['params']['space'] == 'cosine'
    assert info.index['params']['m'] > 0 and info.index['params']['ef_construction'] > 0
    assert 'score_scale_inverted_fixed' in info.caveats
    if spy is not None:
        assert spy.includes, 'the spy saw no read (the control record is read through get)'
        assert [] not in spy.includes


def test_counts(collection):
    store, expect = collection
    assert store.countChunks(_vx_filter()) == expect.chunks
    assert store.countChunks(_vx_filter(chunkIds=[0])) == len(expect.documents) - len(expect.orphans)
    assert store.countDocumentsWhere(_vx_filter()) is None  # no distinct count on Chroma: the tools count first chunks
    spy = _GetSpy(store.collectionObj)
    store.collectionObj.get = spy
    try:
        assert store.count_documents() >= expect.chunks + 1
    finally:
        del store.collectionObj.get
    assert spy.includes, 'the spy saw no read (the control record is read through get)'
    assert [] not in spy.includes, 'the raw count read every id'


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


def test_sample_window(collection):
    store, expect = collection
    n = min(20, expect.chunks)
    docs, used = store.sampleChunks(n=n, seed=3, strategy='random', docFilter=_vx_filter(), include_keys=[])
    again, _ = store.sampleChunks(n=n, seed=3, strategy='random', docFilter=_vx_filter(), include_keys=[])
    assert used == 'first' and len(docs) == n
    assert [(d.metadata.objectId, d.metadata.chunkId) for d in docs] == [
        (d.metadata.objectId, d.metadata.chunkId) for d in again
    ]
    for d in docs:
        key = (d.metadata.objectId, d.metadata.chunkId)
        assert np.allclose(d.embedding, expect.vectors[key], atol=1e-5)


def test_no_native_neighbour_graph(collection):
    store, _ = collection
    assert 'knn_native' not in store.capabilities()
    assert 'knnGraph' not in store.capabilities()


def test_quick_stats_never_reads_every_id(collection):
    from ai.common.store import VectorStoreToolMixin

    store, _ = collection
    node = VectorStoreToolMixin()
    node.IGlobal = types.SimpleNamespace(store=store)
    assert node.stats({'mode': 'full'})['success'] is True
    spy = _GetSpy(store.collectionObj)
    store.collectionObj.get = spy
    try:
        answer = node.stats({'mode': 'quick'})
    finally:
        del store.collectionObj.get
    assert answer['success'] is True and answer['counts_as_of']
    assert [] not in spy.includes


def test_documents_tool_lists_the_orphan_unsorted(collection):
    from ai.common.store import VectorStoreToolMixin

    store, expect = collection
    node = VectorStoreToolMixin()
    node.IGlobal = types.SimpleNamespace(store=store)
    answer = node.list_documents({'limit': 500, 'deleted': 'active'})
    assert answer['success'] is True and answer['sorted'] is False
    orphans = {i['objectId'] for i in answer['items'] if not i['has_first_chunk']}
    assert orphans == expect.orphans


# --- the documents filter (contract section 4.4-A) ----------------------------------------
#
# Chroma's listing reads the chunk-0 records first and finds the documents without one in a
# sweep afterwards, so it applies has_first_chunk by reading only the phase that holds the
# answer. Every other key is named in filter_ignored and applied by the app.


def _filtered(store, flt, *, limit: int = 3, deleted: str = 'active'):
    items, pages, cursor = [], [], None
    for _ in range(10000):
        page = store.listDocumentPage(
            cursor=cursor, limit=limit, object_ids=None, deleted=deleted, sort='path', filter=flt
        )
        contract.assert_no_connection_details(page)
        pages.append(page)
        items.extend(page.items)
        cursor = page.next_cursor
        if cursor is None:
            return items, pages
    raise AssertionError('listDocumentPage did not end')


def test_chroma_declares_the_documents_filter():
    from ai.common.store.vx_types import DocListFilter  # noqa: F401 - the hook's annotation

    assert 'documents_filter' in drv.Store.VX_DRIVER_CAPABILITIES
    import inspect

    parameter = inspect.signature(drv.Store.listDocumentPage).parameters['filter']
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY and parameter.default is None


def test_documents_filter_on_the_first_chunk_is_applied_by_the_store(collection):
    from ai.common.store.vx_types import DocListFilter

    store, expect = collection
    orphans, pages = _filtered(store, DocListFilter(has_first_chunk=False), limit=2)
    assert {r.objectId for r in orphans} == expect.orphans and len(orphans) == len(expect.orphans)
    assert all(not r.has_first_chunk and r.chunks == expect.documents[r.objectId] for r in orphans)
    assert all(p.filter_ignored == () for p in pages)
    assert {p.total for p in pages} == {len(expect.orphans)}
    with_first = set(expect.documents) - expect.orphans
    # Page sizes that end the chunk-0 records mid-page, exactly on a page boundary, and in one page.
    for limit in (2, 3, len(with_first), 50):
        whole, pages = _filtered(store, DocListFilter(has_first_chunk=True), limit=limit)
        assert {r.objectId for r in whole} == with_first and len(whole) == len(with_first), limit
        assert all(r.has_first_chunk and r.chunks == expect.documents[r.objectId] for r in whole)
        assert all(p.filter_ignored == () for p in pages)
        # The listing's last page says how many documents matched; earlier pages may not know yet.
        assert pages[-1].total == len(whole), (limit, [p.total for p in pages])
        assert all(p.total in (None, len(whole)) for p in pages), limit
    for deleted in ('deleted', 'all'):
        every = {r.objectId for r in contract.list_all(store, limit=50, deleted=deleted)[0]}
        listed, pages = _filtered(store, DocListFilter(has_first_chunk=True), deleted=deleted)
        assert pages[-1].total == len(listed), (deleted, [p.total for p in pages])
        with_first = {r.objectId for r in listed}
        without = {r.objectId for r in _filtered(store, DocListFilter(has_first_chunk=False), deleted=deleted)[0]}
        assert with_first | without == every and not with_first & without, deleted


def test_documents_filter_names_the_keys_chroma_cannot_apply(collection):
    from ai.common.store.vx_types import DocListFilter

    store, expect = collection
    items, pages = _filtered(store, DocListFilter(has_first_chunk=False, path_prefix='nowhere/', min_chunks=1))
    assert {r.objectId for r in items} == expect.orphans
    assert all(p.filter_ignored == ('path_prefix', 'min_chunks') for p in pages)
    items, pages = _filtered(store, DocListFilter(path_prefix='nowhere/'), limit=50)
    assert {r.objectId for r in items} == set(expect.documents)
    assert all(p.filter_ignored == ('path_prefix',) for p in pages)


def test_a_documents_cursor_is_bound_to_its_first_chunk_filter(collection):
    from ai.common.store.errors import ToolRefusal
    from ai.common.store.vx_types import DocListFilter

    store, expect = collection
    if len(expect.documents) - len(expect.orphans) < 2:
        pytest.skip('the collection has fewer than two documents with a first chunk')
    first = store.listDocumentPage(
        cursor=None, limit=1, object_ids=None, deleted='active', sort='path', filter=DocListFilter(has_first_chunk=True)
    )
    plain = store.listDocumentPage(cursor=None, limit=1, object_ids=None, deleted='active', sort='path')
    for cursor, flt in (
        (first.next_cursor, None),
        (first.next_cursor, DocListFilter(has_first_chunk=False)),
        (plain.next_cursor, DocListFilter(has_first_chunk=True)),
    ):
        with pytest.raises(ToolRefusal) as err:
            store.listDocumentPage(cursor=cursor, limit=1, object_ids=None, deleted='active', sort='path', filter=flt)
        assert err.value.code == 'INVALID_INPUT'


def test_documents_tool_answers_partial_and_none_on_chroma(new_store):
    from .test_vectordb_tool_mixin import node

    store, expect = new_store
    answer = node(store, logical_type='chroma').list_documents(
        {'filter': {'has_first_chunk': False, 'path_contains': 'doc'}}
    )
    assert answer['success'] is True
    assert (answer['filter_applied'], answer['filter_ignored']) == ('partial', ['path_contains'])
    assert 'documents_filter_partial' in answer['caveats']
    assert {item['objectId'] for item in answer['items']} == expect.orphans
    answer = node(store, logical_type='chroma').list_documents({'filter': {'path_prefix': 'nowhere/'}})
    assert (answer['filter_applied'], answer['filter_ignored']) == ('none', ['path_prefix'])
    assert 'documents_filter_client' in answer['caveats']
    answer = node(store, logical_type='chroma').list_documents({'filter': {'has_first_chunk': True}})
    assert (answer['filter_applied'], answer['filter_ignored']) == ('server', [])
    assert expect.orphans.isdisjoint(item['objectId'] for item in answer['items'])
    # A 'server' answer carries the count the app shows ("N documents match").
    assert answer['next_cursor'] is None
    assert answer['total'] == len(answer['items']) == len(set(expect.documents) - expect.orphans)


# --- repairs and writes (collections this suite owns) -------------------------------------


def test_new_rows_have_deterministic_ids(new_store):
    store, _ = new_store
    pid = drv.point_id_for('doc-00', 2)
    assert pid == str(uuid.uuid5(uuid.NAMESPACE_URL, 'doc-00#2'))
    got = store.collectionObj.get(ids=[pid], include=['metadatas'])
    assert got['metadatas'][0]['objectId'] == 'doc-00' and got['metadatas'][0]['chunkId'] == 2


def test_scores_rise_with_similarity_and_min_score_keeps_everything(new_store):
    store, expect = new_store
    key = sorted(expect.vectors)[0]
    query = QuestionText(text='q')
    query.embedding = list(expect.vectors[key])
    query.embedding_model = contract.MODEL
    floored = store.searchSemantic(query, DocFilter(limit=100))
    assert (floored[0].metadata.objectId, floored[0].metadata.chunkId) == key
    assert floored[0].score == pytest.approx(1.0, abs=1e-4)
    assert [d.score for d in floored] == sorted((d.score for d in floored), reverse=True)

    query.embedding = [-x for x in expect.vectors[key]]
    floored = store.searchSemantic(query, DocFilter(limit=100))
    everything = store.searchSemantic(query, _vx_filter(limit=100, minScore=-math.inf))
    assert len(everything) == expect.chunks
    assert all(d.score >= 0.2 for d in floored) and len(floored) < len(everything)
    assert min(d.score for d in everything) == pytest.approx(0.0, abs=1e-4)


def test_get_paths_and_render(new_store):
    store, expect = new_store
    paths = store.getPaths(limit=100)
    first_chunk_docs = set(expect.documents) - expect.orphans
    assert paths == {contract.path_of(oid): oid for oid in first_chunk_docs}
    out = []
    store.render('doc-04', out.append)
    assert ''.join(out) == ''.join(f'doc-04 chunk {c} text' for c in range(contract.DOCS['doc-04']))


def test_soft_delete_keeps_the_metadata(new_store):
    store, _ = new_store
    got = store.collectionObj.get(where={'objectId': contract.SOFT_DELETED}, include=['metadatas'])
    assert len(got['ids']) == contract.DOCS[contract.SOFT_DELETED]
    for meta in got['metadatas']:
        assert meta['isDeleted'] is True and meta['parent'] == contract.path_of(contract.SOFT_DELETED)


def test_keyword_search_matches_text_fragments(new_store):
    """dialect.keyword_match 'substring': ``$contains`` matches a fragment that spans words (Chroma compares case)."""
    store, _ = new_store
    assert type(store).VX_KEYWORD_MATCH == 'substring'
    found = store.searchKeyword(QuestionText(text='c-04 chu'), DocFilter(limit=100))
    assert {d.metadata.objectId for d in found} == {'doc-04'}
    assert len(found) == contract.DOCS['doc-04']
    assert store.searchKeyword(QuestionText(text='C-04 CHU'), DocFilter(limit=100)) == []


def test_empty_id_lists_select_nothing(new_store):
    # The server refuses `$in: []`; the driver answers an empty result instead.
    store, _ = new_store
    for object_ids in (['schema'], []):
        page = store.listDocumentPage(cursor=None, limit=5, object_ids=object_ids, deleted='all', sort='path')
        assert page.items == [] and page.total == 0 and page.next_cursor is None
    assert store.countChunks(_vx_filter(objectIds=[])) == 0
    assert store.countChunks(_vx_filter(chunkIds=[])) == 0
    assert store.get(_vx_filter(objectIds=[], limit=10)) == []


def test_score_info_on_a_fresh_instance_reads_the_collection_space():
    # A node configured for cosine on a collection an earlier configuration created with l2.
    name = _new_collection('space')
    _store(name, similarity='l2').addChunks(contract.corpus_docs()[:3])
    fresh = _store(name, similarity='cosine')
    assert fresh.scoreInfo()['formula'] == '1 / (1 + euclidean_distance)'
    assert fresh.describe().metric == 'l2'


def test_deletes_of_many_documents_are_accepted():
    # The server refuses an $in list of about 32,760 values ("too many SQL variables").
    store = _store(_new_collection('many_ids'))
    store.addChunks(contract.corpus_docs())
    many = [f'gone-{i:05d}' for i in range(33000)]
    store.markDeleted(many + ['doc-01'])
    assert store.countChunks(_vx_filter(deleted='deleted')) == contract.DOCS['doc-01']
    store.markActive(many + ['doc-01'])
    assert store.countChunks(_vx_filter(deleted='deleted')) == 0
    assert store.removeCounted(many + ['doc-02']) == contract.DOCS['doc-02']
    store.remove(many + ['doc-03'])
    assert store.countChunks(_vx_filter(objectIds=['doc-02', 'doc-03'], deleted='all')) == 0
    assert store.countChunks(_vx_filter(objectIds=['doc-01'])) == contract.DOCS['doc-01']
    assert store.describe().control_record is True


# --- past the caps (1,503 documents) --------------------------------------------------------


def test_scale_listing_finds_every_low_count_orphan(scale_store):
    contract.check_scale_listing(scale_store)


def test_scale_counts(scale_store):
    assert scale_store.countChunks(_vx_filter(chunkIds=[0])) == contract.SCALE_DOCS
    assert scale_store.countChunks(_vx_filter()) == 2 * contract.SCALE_DOCS + len(contract.SCALE_ORPHANS)


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
