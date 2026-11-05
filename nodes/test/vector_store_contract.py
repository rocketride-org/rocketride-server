# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The driver contract the live vector-store suites share (Qdrant, Chroma).

``test_store_qdrant_full.py`` and ``test_store_chroma_full.py`` run the same
checks of the Vector Explorer hooks (``docs/development/nodes/vector-tool-contract.md``,
section 2) against three collections per backend:

- ``new``: written by the current driver (deterministic ids);
- ``legacy_shape``: the same corpus written the way the previous drivers
  wrote it (random ids, same payload), built by the suite;
- ``seeded_legacy``: the shared ``vx_legacy_docs`` collection, seeded by the
  acceptance scripts with the previous drivers and one planted document
  without its first chunk. Read only: the suites never write to it.

Every expectation is computed independently of the driver: from the corpus
below for the collections the suite writes, and from a raw client scan for
the seeded one. This module is not a test module (no ``test_`` prefix).

A second, larger corpus (``scale_docs``: 1,500 documents and three documents
without chunk 0, each with the fewest rows) checks the behaviour that only
shows past the drivers' internal caps.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np

# Documents of the synthetic corpus and their chunk counts.
DOCS: Dict[str, int] = {
    'doc-00': 5,
    'doc-01': 3,
    'doc-02': 4,
    'doc-03': 1,
    'doc-04': 6,
    'doc-05': 2,
    'doc-06': 3,
    'doc-07': 4,
}
DIM = 32
MODEL = 'vx-contract-model'
ORPHAN = 'doc-05'  # chunk 0 is deleted after ingest: a document without its first chunk
SOFT_DELETED = 'doc-07'  # marked deleted after ingest
TABLE_CHUNK = ('doc-02', 1)
INGESTED_AT = '2026-10-08T18:20:11Z'

# The scale corpus: SCALE_DOCS documents of two chunks, plus documents whose
# only row is chunk 1 (no first chunk, and the lowest row count of all).
SCALE_DOCS = 1500
SCALE_DIM = 64
SCALE_ORPHANS = ('scale-orphan-a', 'scale-orphan-b', 'scale-orphan-c')

# The collection the acceptance scripts seed with the previous drivers.
SEEDED_LEGACY_COLLECTION = os.environ.get('RR_TEST_VX_LEGACY_COLLECTION', 'vx_legacy_docs')

# Strings that must never appear in what a hook returns (connection details).
LEAK_PATTERNS = (re.compile(r'127\.0\.0\.1'), re.compile(r'localhost'), re.compile(r'https?://'))


def required() -> bool:
    """Whether a missing server fails the run (CI's database lane) instead of skipping it."""
    raw = str(os.environ.get('RR_REQUIRE_DB_TESTS', '')).strip().lower()
    return bool(raw) and raw not in ('0', 'false', 'no', 'off')


def path_of(object_id: str) -> str:
    index = int(object_id.split('-')[1])
    return f'C:/vx-contract/folder-{index % 3}/{object_id}.md' if index % 2 else f'/srv/vx-contract/{object_id}.txt'


def corpus_vectors() -> Dict[Tuple[str, int], List[float]]:
    """Unit vectors in four clusters, fixed by a seed."""
    rng = np.random.default_rng(11)
    centres = rng.normal(size=(4, DIM))
    out: Dict[Tuple[str, int], List[float]] = {}
    for d, (oid, chunks) in enumerate(DOCS.items()):
        for c in range(chunks):
            v = centres[(d + c) % 4] + 0.35 * rng.normal(size=DIM)
            out[(oid, c)] = (v / np.linalg.norm(v)).tolist()
    return out


def corpus_docs() -> List[Any]:
    """The corpus as the embedding node hands it to a store."""
    from ai.common.schema import Doc, DocMetadata

    docs = []
    for (oid, chunk), vector in corpus_vectors().items():
        metadata = DocMetadata(
            objectId=oid,
            chunkId=chunk,
            nodeId='chunk_1',
            parent=path_of(oid),
            permissionId=0,
            isDeleted=False,
            isTable=(oid, chunk) == TABLE_CHUNK,
            tableId=0,
            size=1000 + int(oid.split('-')[1]),
            ingestedAt=INGESTED_AT,
        )
        doc = Doc(page_content=f'{oid} chunk {chunk} text', metadata=metadata)
        doc.embedding = vector
        doc.embedding_model = MODEL
        docs.append(doc)
    return docs


def scale_object_id(index: int) -> str:
    return f'scale-{index:05d}'


def scale_docs() -> List[Any]:
    """The scale corpus as the embedding node hands it to a store (unit vectors in eight clusters)."""
    from ai.common.schema import Doc, DocMetadata

    rng = np.random.default_rng(23)
    centres = rng.normal(size=(8, SCALE_DIM))
    rows = [(scale_object_id(d), c) for d in range(SCALE_DOCS) for c in range(2)]
    rows += [(oid, 1) for oid in SCALE_ORPHANS]
    docs = []
    for i, (oid, chunk) in enumerate(rows):
        v = centres[i % 8] + 0.5 * rng.normal(size=SCALE_DIM)
        metadata = DocMetadata(
            objectId=oid,
            chunkId=chunk,
            nodeId='chunk_1',
            parent=f'/srv/vx-scale/{oid}.txt',
            permissionId=0,
            isDeleted=False,
            isTable=False,
            tableId=0,
        )
        doc = Doc(page_content=f'{oid} chunk {chunk}', metadata=metadata)
        doc.embedding = (v / np.linalg.norm(v)).tolist()
        doc.embedding_model = MODEL
        docs.append(doc)
    return docs


def check_scale_listing(store, *, limit: int = 500) -> None:
    """Every scale document listed once, the low-count documents without chunk 0 included."""
    items, pages = list_all(store, limit=limit)
    ids = [i.objectId for i in items]
    assert len(ids) == len(set(ids)), 'a document was listed twice'
    assert len(ids) == SCALE_DOCS + len(SCALE_ORPHANS)
    assert {i.objectId for i in items if not i.has_first_chunk} == set(SCALE_ORPHANS)
    assert all(i.chunks == 1 for i in items if not i.has_first_chunk)
    assert {p.total for p in pages if p.total is not None} == {SCALE_DOCS + len(SCALE_ORPHANS)}
    assert all('document_count_capped' not in p.caveats for p in pages)


def control_doc(vector_size: int = DIM) -> Any:
    """The control record exactly as DocumentStoreBase.createCollection builds it."""
    from ai.common.schema import Doc, DocMetadata

    doc = Doc(
        page_content='',
        metadata=DocMetadata(objectId='schema', chunkId=0, vectorSize=vector_size, modelName=MODEL, isDeleted=True),
    )
    doc.embedding_model = MODEL
    doc.embedding = [0] * vector_size
    return doc


@dataclass
class Expect:
    """What a collection holds, computed without the driver."""

    #: active objectId -> active chunk rows
    documents: Dict[str, int]
    #: active objectIds without an active chunk 0
    orphans: Set[str]
    #: objectIds whose rows are all marked deleted
    deleted_documents: Set[str]
    #: active objectId -> active table rows
    tables: Dict[str, int] = field(default_factory=dict)
    #: active objectId -> path
    paths: Dict[str, str] = field(default_factory=dict)
    dimension: int = DIM
    model: str = MODEL
    #: (objectId, chunkId) -> vector, for the rows the suite checks vectors of
    vectors: Dict[Tuple[str, int], List[float]] = field(default_factory=dict)
    writable: bool = True

    @property
    def chunks(self) -> int:
        return sum(self.documents.values())


def corpus_expectations() -> Expect:
    """Expectations for a collection holding the corpus after the orphan and the soft delete."""
    documents = {oid: n for oid, n in DOCS.items() if oid != SOFT_DELETED}
    documents[ORPHAN] -= 1
    vectors = corpus_vectors()
    vectors.pop((ORPHAN, 0))
    return Expect(
        documents=documents,
        orphans={ORPHAN},
        deleted_documents={SOFT_DELETED},
        tables={TABLE_CHUNK[0]: 1},
        paths={oid: path_of(oid) for oid in documents},
        vectors={k: v for k, v in vectors.items() if k[0] != SOFT_DELETED},
    )


def expectations_from_rows(
    rows: Iterable[Tuple[Dict[str, Any], Optional[List[float]]]], dimension: int, model: str
) -> Expect:
    """Expectations from a raw scan: (metadata, vector) per stored row, control record included."""
    active: Dict[str, Set[int]] = {}
    tables: Dict[str, int] = {}
    paths: Dict[str, str] = {}
    seen: Set[str] = set()
    vectors: Dict[Tuple[str, int], List[float]] = {}
    for meta, vector in rows:
        oid = str(meta.get('objectId'))
        if oid == 'schema':
            continue
        seen.add(oid)
        if meta.get('isDeleted') is True:
            continue
        chunk = int(meta.get('chunkId'))
        active.setdefault(oid, set()).add(chunk)
        if meta.get('isTable') is True:
            tables[oid] = tables.get(oid, 0) + 1
        if chunk == 0 or oid not in paths:
            paths[oid] = str(meta.get('parent') or '')
        if vector is not None:
            vectors[(oid, chunk)] = [float(x) for x in vector]
    return Expect(
        documents={oid: len(chunks) for oid, chunks in active.items()},
        orphans={oid for oid, chunks in active.items() if 0 not in chunks},
        deleted_documents=seen - set(active),
        tables=tables,
        paths=paths,
        dimension=dimension,
        model=model,
        vectors=vectors,
        writable=False,
    )


# --- checks ---------------------------------------------------------------------------


def assert_no_connection_details(value: Any) -> None:
    text = repr(value)
    for pattern in LEAK_PATTERNS:
        assert not pattern.search(text), f'connection detail {pattern.pattern!r} in {text[:300]}'


def list_all(store, *, limit: int = 3, deleted: str = 'active', object_ids: Optional[Sequence[str]] = None):
    """Every page of listDocumentPage: (items, pages)."""
    items, pages, cursor = [], [], None
    for _ in range(10000):
        page = store.listDocumentPage(cursor=cursor, limit=limit, object_ids=object_ids, deleted=deleted, sort='path')
        assert_no_connection_details(page)
        pages.append(page)
        items.extend(page.items)
        cursor = page.next_cursor
        if cursor is None:
            return items, pages
    raise AssertionError('listDocumentPage did not end')


def check_listing(store, expect: Expect, *, limit: int = 3) -> None:
    items, pages = list_all(store, limit=limit)
    ids = [i.objectId for i in items]
    assert len(ids) == len(set(ids)), 'a document was listed twice'
    assert set(ids) == set(expect.documents)
    assert all(p.sorted is False and p.distinct is True for p in pages)
    assert 'documents_unsorted' in pages[0].caveats
    totals = {p.total for p in pages if p.total is not None}
    assert totals <= {len(expect.documents)}
    rows = {i.objectId: i for i in items}
    assert {oid for oid, row in rows.items() if not row.has_first_chunk} == expect.orphans
    for oid, row in rows.items():
        assert row.chunks == expect.documents[oid], (oid, row.chunks)
        assert row.path == expect.paths[oid], (oid, row.path)
        assert row.deleted is False
        assert row.pointId
        assert row.tables in (None, expect.tables.get(oid, 0))
    orphan_rows = [i for i, item in enumerate(items) if not item.has_first_chunk]
    first_chunk_rows = [i for i, item in enumerate(items) if item.has_first_chunk]
    if orphan_rows and first_chunk_rows:
        assert min(orphan_rows) > max(first_chunk_rows), 'documents without chunk 0 come after the others'

    gone, _ = list_all(store, limit=limit, deleted='deleted')
    assert {i.objectId for i in gone} == expect.deleted_documents
    assert all(i.deleted for i in gone)
    everything, _ = list_all(store, limit=50, deleted='all')
    assert 'schema' not in {i.objectId for i in everything}


def check_scroll_chunks(store, expect: Expect, object_id: str, page: int = 2) -> None:
    chunk_ids: List[int] = []
    after = -1
    for _ in range(10000):
        result = store.scrollChunks(object_id, after_chunk=after, limit=page, deleted='active')
        assert_no_connection_details(result)
        assert all(not d.embedding for d in result.docs)
        assert all(getattr(d.metadata, 'pointId', None) for d in result.docs)
        chunk_ids.extend(d.metadata.chunkId for d in result.docs)
        after = result.next_after
        if not result.has_more:
            break
    assert chunk_ids == sorted(chunk_ids)
    assert len(chunk_ids) == expect.documents[object_id]
    assert store.scrollChunks('schema', after_chunk=-1, limit=5, deleted='all').docs == []


def check_get_vectors(store, expect: Expect, keys: Sequence[Tuple[str, int]]) -> None:
    docs = store.getVectors(list(keys) + [('schema', 0), ('no-such-document', 0)])
    got = {(d.metadata.objectId, d.metadata.chunkId): d for d in docs}
    assert set(got) == set(keys)
    for key in keys:
        assert len(got[key].embedding) == expect.dimension
        assert np.allclose(got[key].embedding, expect.vectors[key], atol=1e-5), key
        assert got[key].metadata.pointId


def exact_knn_sets(X: np.ndarray, k: int) -> List[Set[int]]:
    Xn = X / np.linalg.norm(X, axis=1, keepdims=True)
    S = Xn @ Xn.T
    np.fill_diagonal(S, -np.inf)
    return [set(np.argsort(-S[i], kind='stable')[:k].tolist()) for i in range(len(X))]


def knn_agreement(graph, exact: List[Set[int]], k: int) -> float:
    agree = 0
    for i, expected in enumerate(exact):
        cols = graph.cols[graph.offsets_row[i] : graph.offsets_row[i + 1]].tolist()
        assert i not in cols
        assert len(cols) <= k
        agree += len(set(cols) & expected)
    return agree / float(k * len(exact))


def check_knn_rows(graph, X: np.ndarray, k: int) -> None:
    """CSR shape, best-first rows and similarities recomputed from the vectors (cosine)."""
    assert len(graph.offsets_row) == len(X) + 1
    for i in range(len(X)):
        lo, hi = int(graph.offsets_row[i]), int(graph.offsets_row[i + 1])
        assert hi - lo == k
        sims = graph.sims[lo:hi].tolist()
        assert sims == sorted(sims, reverse=True)
        for j, s in zip(graph.cols[lo:hi].tolist(), sims):
            expected = float(np.dot(X[i], X[j]) / (np.linalg.norm(X[i]) * np.linalg.norm(X[j])))
            assert abs(s - expected) < 1e-4


def drop_collections(names: Iterable[str], drop: Callable[[str], None]) -> None:
    for name in names:
        try:
            drop(name)
        except Exception:
            pass
