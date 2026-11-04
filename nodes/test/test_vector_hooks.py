# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The optional explorer hooks on ``DocumentStoreBase`` and their shared defaults.

Every vector store driver inherits ``describe``, ``listDocumentPage``,
``scrollChunks``, ``knnGraph`` and ``removeCounted`` from the base class and may
override them natively. These tests drive the defaults through an in-memory
driver that implements only the abstract API, so they hold for a driver that
overrides nothing. The in-memory drivers defined here are reused by the other
vector explorer suites (``test_vector_write_gate``, ``test_vector_tool_envelope``,
``test_vectordb_tool_mixin``).
"""

from __future__ import annotations

import random
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pytest

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store import document_store as ds
from ai.common.store import vx_math
from ai.common.store.errors import StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import ChunkPage, DocPage, DocumentRow, KnnGraph, StoreInfo

MODEL = 'test-model'

# ---------------------------------------------------------------------------
# In-memory drivers
# ---------------------------------------------------------------------------


def _deleted_of(flt: DocFilter) -> str:
    return DocumentStoreBase.resolveDeleted(flt)


class MemoryStore(DocumentStoreBase):
    """A driver that implements only the abstract API; every hook is the base default.

    Rows are kept with their embeddings in insertion order (the "storage order").
    ``ignore_offset`` makes ``get`` ignore ``DocFilter.offset`` like several real
    backends do.
    """

    def __init__(self, provider: str = 'memory', *, similarity: str = 'cosine', ignore_offset: bool = False) -> None:
        super().__init__(provider, {}, {})
        self.similarity = similarity
        self.collection = 'vx_test_docs'
        self.threshold_search = 0.3
        self.exists = False
        self.rows: Dict[Tuple[str, int], Doc] = {}
        self.calls: List[tuple] = []
        self.ignore_offset = ignore_offset
        self.raise_semantic: Optional[BaseException] = None
        self.keyword_unsupported = False

    # --- helpers -----------------------------------------------------------

    def seed(self, docs: Sequence[Doc]) -> 'MemoryStore':
        self.addChunks(list(docs))
        self.calls.clear()
        return self

    def _match(self, doc: Doc, flt: DocFilter) -> bool:
        md = doc.metadata
        if flt.objectIds is not None and md.objectId not in flt.objectIds:
            return False
        if flt.chunkIds is not None and md.chunkId not in flt.chunkIds:
            return False
        if flt.minChunkId is not None and md.chunkId < flt.minChunkId:
            return False
        if flt.maxChunkId is not None and md.chunkId > flt.maxChunkId:
            return False
        if flt.isTable is not None and bool(md.isTable) != bool(flt.isTable):
            return False
        if flt.nodeId is not None and md.nodeId != flt.nodeId:
            return False
        if flt.parent is not None and md.parent != flt.parent:
            return False
        deleted = _deleted_of(flt) if (flt.deleted is not None or flt.isDeleted is not None) else 'all'
        if deleted == 'active' and md.isDeleted:
            return False
        if deleted == 'deleted' and not md.isDeleted:
            return False
        return True

    def _copy(self, doc: Doc, with_vector: bool = False) -> Doc:
        out = doc.model_copy(deep=True)
        out.metadata.pointId = f'pt-{doc.metadata.objectId}-{doc.metadata.chunkId}'
        if not with_vector:
            out.embedding = None
        return out

    # --- abstract API ------------------------------------------------------

    def _doesCollectionExist(self) -> bool:
        return self.exists

    def _createCollection(self, vectorSize) -> bool:
        self.exists = True
        return True

    def count_documents(self) -> int:
        return len(self.rows)

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        self.calls.append(('keyword', query, docFilter))
        if self.keyword_unsupported:
            raise StoreUnsupported('keyword search is not supported by this store')
        flt = docFilter.model_copy()
        if flt.deleted is None and flt.isDeleted is None:
            flt.isDeleted = False
        hits = [
            self._copy(d) for d in self.rows.values() if self._match(d, flt) and query.text in (d.page_content or '')
        ]
        for doc in hits:
            doc.score = 0.0
        return hits[: docFilter.limit or len(hits)]

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        self.calls.append(('semantic', query, docFilter))
        if self.raise_semantic is not None:
            raise self.raise_semantic
        self.doesCollectionExist(query.embedding_model)
        flt = docFilter.model_copy()
        if flt.deleted is None and flt.isDeleted is None:
            flt.isDeleted = False
        floor = self.effectiveFloor(docFilter)
        metric = vx_math.normalize_metric(self.similarity) or 'cosine'
        out = []
        for doc in self.rows.values():
            if not self._match(doc, flt) or doc.metadata.objectId == 'schema':
                continue
            score = float(vx_math.similarity(metric, [query.embedding], [doc.embedding])[0, 0])
            if score < floor:
                continue
            hit = self._copy(doc)
            hit.score = score
            out.append(hit)
        out.sort(key=lambda d: -d.score)
        return out[: docFilter.limit or len(out)]

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        self.calls.append(('get', docFilter))
        rows = [d for d in self.rows.values() if self._match(d, docFilter)]
        offset = 0 if self.ignore_offset else int(docFilter.offset or 0)
        limit = docFilter.limit if docFilter.limit is not None else len(rows)
        return [self._copy(d) for d in rows[offset : offset + limit]]

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        paths = {d.metadata.parent: d.metadata.objectId for d in self.rows.values() if d.metadata.chunkId == 0}
        return dict(list(paths.items())[offset : offset + limit])

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        self.calls.append(('addChunks', [(c.metadata.objectId, c.metadata.chunkId) for c in chunks]))
        if checkCollection:
            self.createCollection(chunks)
        first_batch = {c.metadata.objectId for c in chunks if c.metadata.chunkId == 0}
        for key in [k for k in self.rows if k[0] in first_batch]:
            del self.rows[key]
        for chunk in chunks:
            self.rows[(chunk.metadata.objectId, chunk.metadata.chunkId)] = chunk.model_copy(deep=True)

    def remove(self, objectIds: List[str]) -> None:
        self.calls.append(('remove', list(objectIds)))
        for key in [k for k in self.rows if k[0] in objectIds]:
            del self.rows[key]

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those."""
        self.calls.append(('removeTrashed', list(objectIds)))
        keys = [k for k, d in self.rows.items() if k[0] in objectIds and k[0] != 'schema' and d.metadata.isDeleted]
        for key in keys:
            del self.rows[key]
        return len(keys)

    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        return self._mark(objectIds, True)

    def markActive(self, objectIds: List[str]) -> Optional[int]:
        return self._mark(objectIds, False)

    def _mark(self, objectIds: List[str], value: bool) -> int:
        """Set isDeleted on every chunk of ``objectIds``; return the chunks whose state changed."""
        moved = 0
        for key, doc in self.rows.items():
            if key[0] in objectIds and key[0] != 'schema' and bool(doc.metadata.isDeleted) != value:
                doc.metadata.isDeleted = value
                moved += 1
        return moved

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        for key in sorted(k for k in self.rows if k[0] == objectId):
            callback(self.rows[key].page_content or '')


class CountingStore(MemoryStore):
    """Adds native filtered counts."""

    def _live(self, flt: DocFilter) -> List[Doc]:
        return [d for d in self.rows.values() if d.metadata.objectId != 'schema' and self._match(d, flt)]

    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        self.calls.append(('countChunks', docFilter))
        return len(self._live(docFilter))

    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        self.calls.append(('countDocumentsWhere', docFilter))
        return len({d.metadata.objectId for d in self._live(docFilter)})


class VectorMemoryStore(CountingStore):
    """Adds getVectors and random/first sampling (stratified is not native)."""

    VX_DRIVER_CAPABILITIES = frozenset({'search_keyword'})

    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        self.calls.append(('getVectors', [tuple(k) for k in keys]))
        out = []
        for key in keys:
            doc = self.rows.get((str(key[0]), int(key[1])))
            if doc is not None and doc.metadata.objectId != 'schema':
                out.append(self._copy(doc, with_vector=True))
        return out

    def sampleChunks(self, *, n, seed, strategy, docFilter, include_keys):
        self.calls.append(('sampleChunks', strategy, n))
        if strategy == 'stratified':
            raise StoreUnsupported('sampleChunks(strategy="stratified") is not native on this backend')
        rows = [d for d in self.rows.values() if d.metadata.objectId != 'schema' and self._match(d, docFilter)]
        if strategy == 'random':
            rows = list(rows)
            random.Random(seed).shuffle(rows)
        return [self._copy(d, with_vector=True) for d in rows[: max(0, int(n))]], strategy


class ExactListingStore(VectorMemoryStore):
    """Adds a native, sorted, distinct document listing with exact chunk counts."""

    VX_DRIVER_CAPABILITIES = frozenset({'search_keyword', 'documents_distinct', 'documents_sorted'})

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort) -> DocPage:
        self.calls.append(('listDocumentPage', cursor, limit))
        groups: Dict[str, List[Doc]] = {}
        for doc in self.rows.values():
            md = doc.metadata
            if md.objectId == 'schema' or (object_ids and md.objectId not in object_ids):
                continue
            if deleted == 'active' and md.isDeleted or deleted == 'deleted' and not md.isDeleted:
                continue
            groups.setdefault(md.objectId, []).append(doc)
        rows = []
        for oid, docs in groups.items():
            first = min(docs, key=lambda d: d.metadata.chunkId)
            extra = first.metadata.model_extra or {}
            rows.append(
                DocumentRow(
                    objectId=oid,
                    path=first.metadata.parent,
                    chunks=len(docs),
                    has_first_chunk=any(d.metadata.chunkId == 0 for d in docs),
                    deleted=all(d.metadata.isDeleted for d in docs),
                    tables=sum(1 for d in docs if d.metadata.isTable),
                    nodeId=first.metadata.nodeId,
                    size=extra.get('size'),
                    modifyTime=extra.get('modifyTime'),
                    ingestedAt=extra.get('ingestedAt'),
                    pointId=f'pt-{oid}-{first.metadata.chunkId}',
                )
            )
        rows.sort(key=lambda r: (r.path, r.objectId))
        offset = ds.defaultCursorState(cursor)[0]
        page = rows[offset : offset + limit]
        nxt = ds.encodeCursor({'o': offset + limit}) if offset + limit < len(rows) else None
        return DocPage(page, nxt, len(rows), True, True, True, [])


class NumpyVectorStore(ExactListingStore):
    """Hands back embeddings as numpy rows assigned after the Doc is built (as a chromadb 1.x driver may)."""

    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        out = super().getVectors(keys)
        for doc in out:
            doc.embedding = np.asarray(doc.embedding, dtype=np.float32)
        return out


class NativeStratifiedStore(ExactListingStore):
    """Adds a native stratified sampler."""

    VX_DRIVER_CAPABILITIES = frozenset(
        {'search_keyword', 'documents_distinct', 'documents_sorted', 'sample_stratified_native'}
    )

    def sampleChunks(self, *, n, seed, strategy, docFilter, include_keys):
        if strategy != 'stratified':
            return super().sampleChunks(
                n=n, seed=seed, strategy=strategy, docFilter=docFilter, include_keys=include_keys
            )
        self.calls.append(('sampleChunks', strategy, n))
        rows_by_doc: Dict[str, List[Tuple[str, int]]] = {}
        for (oid, chunk), doc in self.rows.items():
            if oid != 'schema' and self._match(doc, docFilter):
                rows_by_doc.setdefault(oid, []).append((oid, chunk))
        keys = vx_math.stratified_pick(rows_by_doc, n, seed, pinned=[])
        return [self._copy(self.rows[k], with_vector=True) for k in keys], 'stratified'


class EveryRowFlagStore(MemoryStore):
    """Reads only the legacy ``isDeleted`` flag and ignores ``DocFilter.deleted``, as drivers written before it do.

    None or False selects the active rows; True selects every row, as the pgvector,
    Qdrant, Milvus, Weaviate, Astra and Atlas drivers read it.
    """

    FLAG_TRUE_SELECTS = 'all'

    def _match(self, doc: Doc, flt: DocFilter) -> bool:
        legacy = flt.model_copy(update={'deleted': self.FLAG_TRUE_SELECTS if flt.isDeleted else 'active'})
        return super()._match(doc, legacy)


class DeletedOnlyFlagStore(EveryRowFlagStore):
    """As :class:`EveryRowFlagStore`, but True selects only the deleted rows, as the Chroma and Pinecone drivers read it.

    ``deletedFilter('all')`` therefore reads no active row here.
    """

    FLAG_TRUE_SELECTS = 'deleted'


#: The three ways a driver may read the deleted selector: exactly (``DocFilter.deleted``), or the legacy flag only.
DELETED_READINGS = [MemoryStore, EveryRowFlagStore, DeletedOnlyFlagStore]


# ---------------------------------------------------------------------------
# Corpus helpers
# ---------------------------------------------------------------------------


def make_doc(
    object_id: str,
    chunk_id: int,
    *,
    path: Optional[str] = None,
    text: Optional[str] = None,
    vector: Optional[Sequence[float]] = None,
    dim: int = 4,
    deleted: bool = False,
    table: bool = False,
    model: str = MODEL,
    **extras: Any,
) -> Doc:
    """One chunk with a deterministic vector unless one is given."""
    if vector is None:
        rng = np.random.default_rng(abs(hash((object_id, chunk_id))) % (2**32))
        vector = rng.normal(size=dim).tolist()
    md = DocMetadata(
        objectId=object_id,
        chunkId=chunk_id,
        parent=path if path is not None else f'C:/demo/{object_id}.md',
        nodeId='chunk_1',
        isDeleted=deleted,
        isTable=table,
        tableId=0,
        **extras,
    )
    doc = Doc(page_content=text if text is not None else f'{object_id} chunk {chunk_id} text', metadata=md)
    doc.embedding = list(vector)
    doc.embedding_model = model
    return doc


def corpus(spec: Dict[str, Sequence[int]], *, dim: int = 4, **kw: Any) -> List[Doc]:
    """Chunks for ``{objectId: chunk ids}``, chunk 0 of every document first so re-ingest keeps the rest."""
    docs: List[Doc] = []
    for oid, chunks in spec.items():
        for chunk in sorted(chunks):
            docs.append(make_doc(oid, chunk, dim=dim, **kw))
    return docs


def seeded(store_cls=MemoryStore, spec: Optional[Dict[str, Sequence[int]]] = None, **kw: Any):
    store = store_cls(**kw)
    store.seed(corpus(spec if spec is not None else {'b': [0, 1, 2], 'a': [0, 1], 'c': [0]}))
    return store


# ---------------------------------------------------------------------------
# capabilities / scoreInfo / effectiveFloor / resolveDeleted
# ---------------------------------------------------------------------------


def test_capabilities_of_a_driver_that_overrides_nothing_is_empty():
    assert MemoryStore().capabilities() == frozenset()


def test_capabilities_lists_overridden_hooks_and_driver_constants():
    caps = NativeStratifiedStore().capabilities()
    assert {'countChunks', 'countDocumentsWhere', 'getVectors', 'sampleChunks', 'listDocumentPage'} <= caps
    assert {'sample_stratified_native', 'documents_distinct', 'documents_sorted'} <= caps
    assert 'describe' not in caps and 'knnGraph' not in caps


def test_score_info_default():
    store = MemoryStore()
    assert store.scoreInfo() == {'formula': 'unknown', 'higher_is_better': True, 'floor': 0.2, 'threshold': 0.3}


def test_effective_floor_is_the_legacy_floor_when_min_score_is_unset():
    assert MemoryStore().effectiveFloor(DocFilter()) == 0.2


def test_effective_floor_honours_min_score_including_minus_infinity():
    store = MemoryStore()
    assert store.effectiveFloor(DocFilter(minScore=0.55)) == 0.55
    assert store.effectiveFloor(DocFilter(minScore=float('-inf'))) == float('-inf')


@pytest.mark.parametrize(
    'flt,expected',
    [
        (DocFilter(), 'active'),
        (DocFilter(isDeleted=False), 'active'),
        (DocFilter(isDeleted=True), 'all'),
        (DocFilter(deleted='deleted', isDeleted=False), 'deleted'),
        (DocFilter(deleted='all'), 'all'),
    ],
)
def test_resolve_deleted(flt, expected):
    assert DocumentStoreBase.resolveDeleted(flt) == expected


def test_count_hooks_default_to_none():
    store = seeded()
    assert store.countChunks(DocFilter()) is None
    assert store.countDocumentsWhere(DocFilter()) is None


def test_get_vectors_and_sample_chunks_default_to_unsupported():
    store = seeded()
    with pytest.raises(StoreUnsupported):
        store.getVectors([('a', 0)])
    with pytest.raises(StoreUnsupported):
        store.sampleChunks(n=3, seed=1, strategy='random', docFilter=DocFilter(), include_keys=[])


def test_deleted_filter_sets_both_the_exact_and_the_legacy_field():
    assert (ds.deletedFilter('active').deleted, ds.deletedFilter('active').isDeleted) == ('active', False)
    assert (ds.deletedFilter('all').deleted, ds.deletedFilter('all').isDeleted) == ('all', True)
    flt = ds.deletedFilter('deleted', objectIds=['a'], limit=3)
    assert (flt.deleted, flt.isDeleted, flt.objectIds, flt.limit) == ('deleted', True, ['a'], 3)


def _object_ids_read(store: MemoryStore, deleted: str) -> List[str]:
    return sorted(
        {d.metadata.objectId for d in store.get(ds.deletedFilter(deleted)) if d.metadata.objectId != 'schema'}
    )


@pytest.mark.parametrize('store_cls', DELETED_READINGS)
def test_active_then_deleted_reads_cover_every_row_whatever_the_legacy_flag_selects(store_cls):
    store = seeded(store_cls)
    store.markDeleted(['b'])
    assert _object_ids_read(store, 'active') == ['a', 'c']
    assert 'b' in _object_ids_read(store, 'deleted')


def test_the_all_selector_misses_active_rows_where_the_legacy_flag_selects_deleted_rows_only():
    store = seeded(DeletedOnlyFlagStore)
    store.markDeleted(['b'])
    assert _object_ids_read(store, 'all') == ['b']
    assert _object_ids_read(seeded(EveryRowFlagStore), 'all') == ['a', 'b', 'c']


def test_cursor_round_trip_is_url_safe_and_unpadded():
    cursor = ds.encodeCursor({'o': 200, 'f': 'a#0'})
    assert '=' not in cursor and '+' not in cursor and '/' not in cursor
    assert ds.decodeCursor(cursor) == {'o': 200, 'f': 'a#0'}


@pytest.mark.parametrize('bad', ['not base64!', 'WzEsMl0', ''])
def test_decode_cursor_rejects_garbage(bad):
    with pytest.raises(ValueError):
        ds.decodeCursor(bad)


#: Cursors that decode to a JSON object but were never issued by the default listing.
FORGED_CURSORS = [
    {'o': 'abc'},
    {'o': [1]},
    {'o': 1e300},
    {'o': 2.0},
    {'o': -5},
    {'o': True},
    {'o': 2**40},
    {'f': 'a#0'},
    {'o': 2, 'f': 5},
]


@pytest.mark.parametrize('state', FORGED_CURSORS, ids=[str(s) for s in FORGED_CURSORS])
def test_default_cursor_state_refuses_a_forged_cursor(state):
    with pytest.raises(ToolRefusal) as caught:
        ds.defaultCursorState(ds.encodeCursor(state))
    assert caught.value.code == 'INVALID_INPUT'


@pytest.mark.parametrize('state', FORGED_CURSORS, ids=[str(s) for s in FORGED_CURSORS])
def test_list_documents_default_refuses_a_forged_cursor(state):
    store = MemoryStore().seed(corpus({'a': [0], 'b': [0]}))
    with pytest.raises(ToolRefusal) as caught:
        store.listDocumentPage(cursor=ds.encodeCursor(state), limit=2, object_ids=None, deleted='active', sort='path')
    assert caught.value.code == 'INVALID_INPUT'
    assert not [call for call in store.calls if call[0] == 'get']


def test_default_cursor_state_reads_an_issued_cursor():
    assert ds.defaultCursorState(None) == (0, None)
    assert ds.defaultCursorState(ds.encodeCursor({'o': 200, 'f': 'a#0'})) == (200, 'a#0')
    assert ds.defaultCursorState(ds.encodeCursor({'o': 0})) == (0, None)
    with pytest.raises(ToolRefusal):
        ds.defaultCursorState('not a cursor!')


# ---------------------------------------------------------------------------
# describe
# ---------------------------------------------------------------------------


def test_describe_a_missing_collection_answers_instead_of_raising():
    info = MemoryStore().describe()
    assert isinstance(info, StoreInfo)
    assert info.collection_exists is False
    assert info.control_record is None
    assert (info.metric, info.dimension, info.model) == (None, None, None)
    assert info.collection == 'vx_test_docs'


def test_describe_loads_model_and_dimension_from_the_control_record():
    store = seeded()
    store.vectorSize, store.modelName = 0, ''
    info = store.describe()
    assert info.collection_exists is True and info.control_record is True
    assert (info.metric, info.dimension, info.model) == ('cosine', 4, MODEL)
    assert info.backend == 'memory'
    assert info.meta_column is None and info.index is None and info.size_bytes is None
    assert info.caveats == []


def test_describe_reports_a_missing_control_record():
    store = seeded()
    del store.rows[('schema', 0)]
    info = store.describe()
    assert info.collection_exists is True
    assert info.control_record is False


def test_describe_maps_the_backend_from_the_provider():
    assert MemoryStore(provider='postgres').describe().backend == 'pgvector'
    assert MemoryStore(provider='rocketride_vector').describe().backend == 'pgvector'
    assert MemoryStore(provider='astra_db').describe().backend == 'astra'
    assert MemoryStore(provider='mongodb+srv').describe().backend == 'atlas'


def test_describe_normalises_the_metric_name():
    store = seeded(similarity='euclidean')
    assert store.describe().metric == 'l2'


def test_describe_never_names_a_database_or_host():
    store = seeded()
    store.host, store.database, store.dsn = 'db.internal', 'tenant_db', 'postgresql://u:p@h/db'
    text = repr(store.describe())
    for secret in ('db.internal', 'tenant_db', 'postgresql://'):
        assert secret not in text


def test_does_collection_exist_with_another_model_still_returns_true():
    store = seeded()
    assert store.doesCollectionExist('another-model') is True


def test_model_mismatch_is_a_caveat_not_a_refusal():
    store = seeded()
    store.doesCollectionExist('another-model')
    info = store.describe()
    assert 'model_mismatch' in info.caveats
    assert store.modelMismatch is True


def test_matching_model_clears_the_mismatch():
    store = seeded()
    store.doesCollectionExist('another-model')
    store.doesCollectionExist(MODEL)
    assert store.modelMismatch is False
    assert 'model_mismatch' not in store.describe().caveats


def test_no_model_compared_yet_is_unknown():
    assert seeded().modelMismatch is None


# ---------------------------------------------------------------------------
# listDocumentPage default
# ---------------------------------------------------------------------------


def test_list_documents_default_lists_first_chunks_sorted_within_the_page():
    store = seeded()
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    assert [row.objectId for row in page.items] == ['a', 'b', 'c']
    assert (page.distinct, page.sorted, page.counts_exact, page.total) == (False, False, False, None)
    assert all(row.chunks is None and row.has_first_chunk for row in page.items)
    assert page.next_cursor is None and page.caveats == ['documents_by_first_chunk']


def test_list_documents_default_never_lists_the_control_record():
    store = seeded()
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='all', sort='path')
    assert 'schema' not in [row.objectId for row in page.items]


def test_list_documents_default_rows_carry_path_node_and_extras():
    store = MemoryStore()
    store.seed([make_doc('x', 0, path='C:/demo/x.pdf', size=7419, ingestedAt='2026-10-08T18:20:11Z')])
    row = store.listDocumentPage(cursor=None, limit=5, object_ids=None, deleted='active', sort='path').items[0]
    assert isinstance(row, DocumentRow)
    assert (row.path, row.nodeId, row.size, row.ingestedAt, row.modifyTime) == (
        'C:/demo/x.pdf',
        'chunk_1',
        7419,
        '2026-10-08T18:20:11Z',
        None,
    )
    assert row.pointId == 'pt-x-0' and row.deleted is False and row.tables is None


def test_list_documents_default_pages_with_an_opaque_cursor():
    store = seeded(spec={f'd{i:02d}': [0] for i in range(5)})
    first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    assert [r.objectId for r in first.items] == ['d00', 'd01'] and first.next_cursor
    second = store.listDocumentPage(cursor=first.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert [r.objectId for r in second.items] == ['d02', 'd03'] and second.next_cursor
    third = store.listDocumentPage(cursor=second.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert [r.objectId for r in third.items] == ['d04'] and third.next_cursor is None


def test_list_documents_default_on_an_offset_ignoring_backend_ends_with_a_caveat():
    store = seeded(spec={f'd{i:02d}': [0] for i in range(5)}, ignore_offset=True)
    first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    assert first.next_cursor
    second = store.listDocumentPage(cursor=first.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert second.items == []
    assert second.next_cursor is None
    assert second.caveats == ['documents_by_first_chunk', 'documents_paging_unsupported']


def test_list_documents_default_filters_by_object_ids():
    store = seeded()
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=['c', 'a'], deleted='active', sort='path')
    assert [r.objectId for r in page.items] == ['a', 'c']


def test_list_documents_default_honours_deleted():
    store = seeded()
    store.markDeleted(['b'])
    active = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    deleted = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='deleted', sort='path')
    everything = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='all', sort='path')
    assert [r.objectId for r in active.items] == ['a', 'c']
    assert [r.objectId for r in deleted.items] == ['b'] and deleted.items[0].deleted is True
    assert [r.objectId for r in everything.items] == ['a', 'b', 'c']


@pytest.mark.parametrize('store_cls', DELETED_READINGS)
def test_list_documents_and_scroll_chunks_default_read_active_rows_whatever_the_legacy_flag_selects(store_cls):
    store = seeded(store_cls)
    store.markDeleted(['b'])
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    assert [r.objectId for r in page.items] == ['a', 'c']
    chunks = store.scrollChunks('a', after_chunk=-1, limit=10, deleted='active')
    assert [d.metadata.chunkId for d in chunks.docs] == [0, 1]
    assert store.scrollChunks('b', after_chunk=-1, limit=10, deleted='active').docs == []


def test_list_documents_default_asks_for_one_extra_row_to_detect_more():
    store = seeded()
    store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    flt = [c for c in store.calls if c[0] == 'get'][-1][1]
    assert flt.limit == 3 and flt.chunkIds == [0] and flt.deleted == 'active' and flt.isDeleted is False


# ---------------------------------------------------------------------------
# scrollChunks default
# ---------------------------------------------------------------------------


def test_scroll_chunks_default_pages_in_chunk_order_without_vectors():
    store = seeded(spec={'a': [0, 1, 2, 3, 4]})
    page = store.scrollChunks('a', after_chunk=-1, limit=2, deleted='active')
    assert isinstance(page, ChunkPage)
    assert [d.metadata.chunkId for d in page.docs] == [0, 1]
    assert page.has_more is True and page.next_after == 1
    assert all(d.embedding is None for d in page.docs)
    last = store.scrollChunks('a', after_chunk=3, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in last.docs] == [4] and last.has_more is False


def test_scroll_chunks_default_crosses_gaps_in_chunk_ids():
    store = seeded(spec={'g': [3, 7, 64]})
    first = store.scrollChunks('g', after_chunk=-1, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in first.docs] == [3] and first.has_more is True
    window = store.scrollChunks('g', after_chunk=-1, limit=100, deleted='active')
    assert [d.metadata.chunkId for d in window.docs] == [3, 7, 64] and window.has_more is False


class ReversedGetStore(MemoryStore):
    """A backend whose ``get`` answers in descending chunk order (a probe with limit 1 finds the last chunk)."""

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        self.calls.append(('get', docFilter))
        rows = sorted((d for d in self.rows.values() if self._match(d, docFilter)), key=lambda d: -d.metadata.chunkId)
        limit = docFilter.limit if docFilter.limit is not None else len(rows)
        return [self._copy(d) for d in rows[:limit]]


def _scroll_all(store, object_id: str, limit: int) -> Tuple[List[int], int]:
    seen: List[int] = []
    after, pages = -1, 0
    while True:
        page = store.scrollChunks(object_id, after_chunk=after, limit=limit, deleted='active')
        pages += 1
        seen.extend(d.metadata.chunkId for d in page.docs)
        if not page.has_more:
            return seen, pages
        assert page.next_after > after
        after = page.next_after


@pytest.mark.parametrize(
    'chunk_ids,limit,first',
    [
        ([1, 2, 3, 4, 5], 1, [1]),  # a legacy document whose chunk 0 was removed
        (list(range(100, 110)), 100, list(range(100, 110))),
        (list(range(100, 110)), 1, [100]),
        ([5, 1000, 100000], 2, [5]),
    ],
)
@pytest.mark.parametrize('store_cls', [MemoryStore, ReversedGetStore])
def test_scroll_chunks_default_first_page_carries_the_first_stored_chunk(store_cls, chunk_ids, limit, first):
    store = seeded(store_cls, spec={'g': chunk_ids})
    page = store.scrollChunks('g', after_chunk=-1, limit=limit, deleted='active')
    assert [d.metadata.chunkId for d in page.docs] == first
    assert page.has_more is (len(first) < len(chunk_ids))


@pytest.mark.parametrize(
    'chunk_ids', [[0, 1, 2], [3, 7, 64], list(range(100, 110)), [5, 1000, 100000], [0, 2**20], [9]]
)
@pytest.mark.parametrize('limit', [1, 2, 100])
@pytest.mark.parametrize('store_cls', [MemoryStore, ReversedGetStore])
def test_scroll_chunks_default_reads_every_chunk_once_in_order(store_cls, chunk_ids, limit):
    store = seeded(store_cls, spec={'g': chunk_ids})
    seen, pages = _scroll_all(store, 'g', limit)
    assert seen == sorted(chunk_ids)
    assert pages <= len(chunk_ids) + 1
    assert len([c for c in store.calls if c[0] == 'get']) <= pages * 2 + 2 * 21 * len(chunk_ids)


def test_scroll_chunks_default_never_returns_the_control_record():
    store = seeded()
    page = store.scrollChunks('schema', after_chunk=-1, limit=10, deleted='all')
    assert page.docs == [] and page.has_more is False


def test_scroll_chunks_default_honours_deleted():
    store = seeded(spec={'a': [0, 1]})
    store.markDeleted(['a'])
    assert store.scrollChunks('a', after_chunk=-1, limit=10, deleted='active').docs == []
    assert len(store.scrollChunks('a', after_chunk=-1, limit=10, deleted='all').docs) == 2


# ---------------------------------------------------------------------------
# knnGraph / removeCounted defaults
# ---------------------------------------------------------------------------


def test_knn_graph_default_is_computed_on_the_node():
    store = MemoryStore()
    vectors = np.array([[0.0], [1.0], [3.0], [7.0]], dtype=np.float32)
    graph = store.knnGraph([('a', i) for i in range(4)], vectors, 'l2', 2)
    assert isinstance(graph, KnnGraph)
    assert graph.source == 'node' and graph.k == 2
    assert list(graph.offsets_row) == [0, 2, 4, 6, 8]
    assert list(graph.cols) == [1, 2, 0, 2, 1, 0, 2, 1]


def test_knn_graph_default_clamps_k_for_tiny_samples():
    graph = MemoryStore().knnGraph([('a', 0), ('a', 1)], np.eye(2, dtype=np.float32), 'cosine', 15)
    assert graph.k == 1 and list(graph.offsets_row) == [0, 1, 2]


def test_remove_counted_default_counts_then_removes():
    store = seeded(CountingStore)
    assert store.removeCounted(['b', 'zzz']) == 3
    assert ('b', 0) not in store.rows
    assert ('remove', ['b', 'zzz']) in store.calls


@pytest.mark.parametrize('store_cls', DELETED_READINGS)
def test_remove_counted_default_without_counts_is_none_but_still_removes(store_cls):
    store = seeded(store_cls)
    store.markDeleted(['c'])
    assert store.removeCounted(['b', 'c']) is None
    assert not any(k[0] in ('b', 'c') for k in store.rows)


def test_remove_counted_never_removes_the_control_record():
    store = seeded(CountingStore)
    store.removeCounted(['schema', 'a'])
    assert ('schema', 0) in store.rows
    assert ('remove', ['a']) in store.calls


def test_remove_counted_counts_deleted_rows_too():
    store = seeded(CountingStore)
    store.markDeleted(['b'])
    assert store.removeCounted(['b']) == 3


# ---------------------------------------------------------------------------
# control record path stays untouched
# ---------------------------------------------------------------------------


def test_create_collection_on_an_empty_driver_writes_the_control_record():
    store = MemoryStore()
    store.addChunks([make_doc('a', 0)])
    assert ('schema', 0) in store.rows
    control = store.rows[('schema', 0)].metadata
    assert control.isDeleted is True and control.modelName == MODEL and control.vectorSize == 4


def test_store_base_keeps_the_provider():
    assert MemoryStore(provider='qdrant').provider == 'qdrant'


# ---------------------------------------------------------------------------
# metadata extras reach only the drivers that store them
# ---------------------------------------------------------------------------

#: The columns of a legacy pgvector table: the original DDL plus ``signature``.
LEGACY_COLUMNS = (
    'content',
    'objectId',
    'chunkId',
    'nodeId',
    'parent',
    'permissionId',
    'isDeleted',
    'isTable',
    'tableId',
    'signature',
    'embedding',
    'vectorSize',
    'modelName',
)

EXTRAS = {'size': 7419, 'modifyTime': 1727000000, 'ingestedAt': '2026-10-08T18:20:11Z'}


class ColumnStore(MemoryStore):
    """Writes one table column per metadata key, like the pgvector drivers that predate the ``meta`` column."""

    COLUMNS = LEGACY_COLUMNS

    def __init__(self, provider: str = 'postgres', **kw: Any) -> None:
        super().__init__(provider, **kw)
        self.inserts: List[List[str]] = []

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        for chunk in chunks:
            data = {'content': chunk.page_content, **chunk.metadata.model_dump(), 'embedding': chunk.embedding}
            data.setdefault('vectorSize', len(chunk.embedding or []))
            data.setdefault('modelName', '')
            unknown = [column for column in data if column not in self.COLUMNS]
            if unknown:
                raise Exception(f'column "{unknown[0].lower()}" of relation "vx_test_docs" does not exist')
            self.inserts.append(list(data))
        super().addChunks(chunks, checkCollection)


def _ingested(store: MemoryStore) -> List[Doc]:
    docs = [make_doc('a', 0, **EXTRAS), make_doc('a', 1, **EXTRAS), make_doc('b', 0, **EXTRAS)]
    store.addChunks(docs)
    return docs


def test_a_column_per_key_driver_ingests_metadata_with_extras():
    store = ColumnStore()
    _ingested(store)
    assert {key for key in store.rows if key[0] != 'schema'} == {('a', 0), ('a', 1), ('b', 0)}
    written = {column for columns in store.inserts for column in columns}
    assert written <= set(LEGACY_COLUMNS) and not written & set(EXTRAS)


@pytest.mark.parametrize('provider', ['postgres', 'rocketride_vector'])
def test_pgvector_providers_do_not_receive_the_extras(provider):
    store = ColumnStore(provider)
    _ingested(store)
    assert all(not (doc.metadata.model_extra or {}).keys() & EXTRAS.keys() for doc in store.rows.values())


@pytest.mark.parametrize('provider', ['qdrant', 'chroma', 'milvus', 'weaviate', 'pinecone', 'memory'])
def test_payload_drivers_receive_the_extras(provider):
    store = MemoryStore(provider)
    _ingested(store)
    for key in (('a', 0), ('a', 1), ('b', 0)):
        assert {name: store.rows[key].metadata.model_extra.get(name) for name in EXTRAS} == EXTRAS


def test_a_driver_that_stores_extras_receives_them():
    class MetaColumnStore(ColumnStore):
        VX_STORES_EXTRAS = True
        COLUMNS = LEGACY_COLUMNS + tuple(EXTRAS)

    store = MetaColumnStore()
    _ingested(store)
    assert set(EXTRAS) <= {column for columns in store.inserts for column in columns}


def test_a_driver_may_refuse_extras_on_any_backend():
    class NoExtrasStore(MemoryStore):
        VX_STORES_EXTRAS = False

    store = NoExtrasStore('qdrant')
    _ingested(store)
    assert not (store.rows[('a', 0)].metadata.model_extra or {}).keys() & EXTRAS.keys()


def test_leaving_out_the_extras_does_not_change_the_callers_documents():
    store = ColumnStore()
    docs = _ingested(store)
    for doc in docs:
        assert {name: doc.metadata.model_extra.get(name) for name in EXTRAS} == EXTRAS


def test_other_metadata_extras_still_reach_the_driver():
    store = MemoryStore('postgres')
    store.addChunks([make_doc('a', 0, ingestedAt='2026-10-08T18:20:11Z', entities='person')])
    extra = store.rows[('a', 0)].metadata.model_extra
    assert extra.get('entities') == 'person' and 'ingestedAt' not in extra


def test_the_extras_guard_covers_a_driver_built_without_its_constructor():
    class LegacyModuleStore(ColumnStore):
        __module__ = 'store_postgres.postgres'

    store = object.__new__(LegacyModuleStore)
    MemoryStore.__init__(store, 'memory')
    del store.provider
    store.inserts = []
    _ingested(store)
    written = {column for columns in store.inserts for column in columns}
    assert not written & set(EXTRAS)


def test_vx_stores_extras_follows_the_backend_unless_the_driver_says():
    assert MemoryStore('postgres').vxStoresExtras() is False
    assert MemoryStore('rocketride_vector').vxStoresExtras() is False
    assert MemoryStore('qdrant').vxStoresExtras() is True
    assert MemoryStore('memory').vxStoresExtras() is True

    class Declared(MemoryStore):
        VX_STORES_EXTRAS = True

    assert Declared('postgres').vxStoresExtras() is True
