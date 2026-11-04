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

"""The pgvector document store shared by ``store_postgres`` and ``rocketride_vector``.

The two nodes differ only in how they reach the database (host, user and
password from the node configuration, or the organization's DSN resolved by
the server) and in their defaults; both hand ``PgVectorStore`` the connection
arguments and the table, and everything else lives here.

Table shape. A table this driver creates has the legacy columns plus
``signature`` and a ``meta`` jsonb column, an ``(objectid, chunkid)`` index and,
up to 2,000 dimensions, an HNSW index whose operator class follows the metric.
Tables written by the drivers this one replaced have no ``meta`` column: it is
added when the store opens, in its own transaction with a 2-second lock
timeout. If another session holds the table, the store writes without it
(metadata outside the column allowlist is not stored), reports
``meta_column: False`` with the caveats ``meta_column_pending`` and
``extras_not_stored``, and tries again at most once a minute on a later write.

Writes. A batch replaces every stored chunk of a document only when it carries
the document's chunk 0; a later batch of the same document replaces just its
own ``(objectId, chunkId)`` keys. The embedding nodes send a long document in
several batches, so this keeps all of them. Every write runs in one
transaction under the table's advisory lock.

Reads run in short read-only transactions (see :mod:`.pool`). Every explorer
hook and search leaves out the control record (objectId ``'schema'``); the
legacy ``get`` still reads it, because the base class finds the collection's
model and dimension through it.
"""

from __future__ import annotations

import base64
import binascii
import dataclasses
import hashlib
import json
import math
import threading
import time

from typing import Any, Callable, Dict, FrozenSet, List, Mapping, Optional, Sequence, Tuple

from rocketlib import warning

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText

from ..document_store import DocumentStoreBase
from ..errors import ToolRefusal
from ..vx_types import ChunkPage, DocListFilter, DocPage, DocumentRow, StoreInfo
from .pool import CollectionMissing, PgDatabase
from .sql import (
    CONTROL_OBJECT_ID,
    HNSW_MAX_DIMS,
    Having,
    METADATA_COLUMNS,
    METRICS,
    OPERATORS,
    TABLE_COLUMNS,
    VALID_TABLE,
    WRITE_COLUMNS,
    Statements,
    Where,
    vector_literal,
)

#: Read statements run at most this long (also reported as ``dialect.limits.statement_timeout_ms``).
DEFAULT_STATEMENT_TIMEOUT_MS = 30000

#: The first pgvector version with ``hnsw.iterative_scan`` (filtered HNSW searches that keep scanning until k rows).
ITERATIVE_SCAN_VERSION = (0, 8, 0)

#: The fixed score floor below which a search drops rows unless ``minScore`` says otherwise.
MIN_SIMILARITY_SCORE = 0.20

#: The score each metric reports, how to read it, and its range.
_SCORE_INFO = {
    'cosine': {'formula': '1 - cosine_distance', 'range': [-1, 1]},
    'l2': {'formula': '1 / (1 + l2_distance)', 'range': [0, 1]},
    'ip': {'formula': 'inner_product', 'range': None},
}

_INVALID_TABLE = (
    'Invalid collection name: {name!r}. Must be a valid PostgreSQL identifier '
    '(letters, digits, underscores; max 63 chars).'
)


class PgVectorStore(DocumentStoreBase):
    """A ``DocumentStoreBase`` over one pgvector table, with every explorer hook answered natively."""

    #: ``describe().backend``.
    backend = 'pgvector'

    #: The extras (size, modifyTime, ingestedAt) go to the ``meta`` column; without it they are dropped per row.
    VX_STORES_EXTRAS = True

    #: Support level reported by the explorer's dialect, for both pgvector providers (postgres and
    #: rocketride_vector): the unmocked live suites (nodes/test/test_store_postgres_full.py,
    #: test_rocketride_db_full.py and test_vector_toolpath_full.py) run on a new and a legacy
    #: table, directly and through a transaction-mode pooler.
    VX_SUPPORT = 'supported'

    #: ``documents_filter``: ``listDocumentPage`` applies the documents filter in the statement that pages the keys.
    VX_DRIVER_CAPABILITIES: FrozenSet[str] = frozenset(
        {'sample_stratified_native', 'documents_distinct', 'documents_sorted', 'search_keyword', 'documents_filter'}
    )

    #: ``dialect.keyword_match``: the keyword search is ``"content" ILIKE '%<text>%'``, so it matches text fragments.
    VX_KEYWORD_MATCH = 'substring'

    #: Seconds between two attempts to add the ``meta`` column after one was blocked.
    META_RETRY_S = 60.0
    #: How long the ``meta`` ALTER waits for the table lock before giving up for now.
    META_LOCK_TIMEOUT_MS = 2000
    #: Rows per INSERT statement.
    INSERT_BATCH = 200
    #: Rows ``render`` reads per statement.
    RENDER_PAGE = 1000

    def __init__(
        self,
        provider: str,
        connConfig: Dict[str, Any],
        bag: Dict[str, Any],
        *,
        connect_args: Mapping[str, Any],
        table: str,
        similarity: str = 'cosine',
        threshold: Any = 0.5,
        hnsw: bool = True,
        hnsw_m: Any = 16,
        hnsw_ef_construction: Any = 64,
        statement_timeout_ms: int = DEFAULT_STATEMENT_TIMEOUT_MS,
        pool_size: int = 4,
        idle_timeout_s: Optional[float] = 60.0,
        caveats: Sequence[str] = (),
    ) -> None:
        """Open the store over ``table``.

        ``connect_args`` are passed to ``psycopg2.connect`` (``dsn=...`` or
        ``host=..., dbname=...``). The constructor reads the table's catalog and
        its control record, so a wrong address or a missing pgvector extension
        fails here, at pipeline start.
        """
        super().__init__(provider, connConfig, bag)

        name = (table or '').strip()
        if not name or not VALID_TABLE.fullmatch(name):
            raise ValueError(_INVALID_TABLE.format(name=name))

        metric = METRICS.get(str(similarity or 'cosine').strip().lower())
        if metric is None:
            raise Exception(
                'The metric you provided in the config.json does not match required postgres configurations'
            )

        #: The configured table name (the transform key uses it); ``table`` is the name PostgreSQL uses.
        self.collection = name
        self.table = name.lower()
        self.metric = metric
        #: The distance operator of the metric (``<=>``, ``<->`` or ``<#>``).
        self.similarity = OPERATORS[metric]
        try:
            self.threshold_search = float(threshold)
        except (TypeError, ValueError):
            self.threshold_search = 0.5
        self.create_hnsw = bool(hnsw)
        self.hnsw_m, self.hnsw_ef_construction = _hnsw_params(hnsw_m, hnsw_ef_construction)
        self.store_caveats: Tuple[str, ...] = tuple(caveats)

        self._sql = Statements(self.table)
        self._db = PgDatabase(
            connect_args,
            self._sql,
            statement_timeout_ms=statement_timeout_ms,
            max_size=pool_size,
            idle_timeout_s=idle_timeout_s,
        )
        self._write_lock = threading.RLock()
        self._state_lock = threading.Lock()
        # Known table state: None = not looked up yet.
        self._exists: Optional[bool] = None
        self._columns: Optional[List[str]] = None
        self._meta_attempt_at: Optional[float] = None
        self._extension_version: Optional[str] = None

        try:
            self._open()
        except BaseException:
            self._db.close()
            raise

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the store's connections (idle ones now, the others as they return)."""
        db = getattr(self, '_db', None)
        if db is not None and not db.closed:
            db.close()

    def __del__(self):
        """Release the pool when the store is dropped without ``close()``."""
        try:
            self.close()
        except Exception:
            pass

    def _open(self) -> None:
        """Read the extension version, the table's columns and its control record; add ``meta`` if missing."""

        def probe(cur):
            cur.execute(*self._sql.extension_version())
            row = cur.fetchone()
            version = row[0] if row else None
            cur.execute(*self._sql.exists())
            exists = bool(cur.fetchone()[0])
            columns = self._read_columns(cur) if exists else None
            control = self._read_control(cur) if exists and columns and 'objectid' in columns else []
            return version, exists, columns, control

        version, exists, columns, control = self._db.run_read(probe)
        self._extension_version = version
        self._db.iterative_scan = _version_at_least(version, ITERATIVE_SCAN_VERSION)
        with self._state_lock:
            self._exists = exists
            self._columns = columns
        self._apply_control(control)
        if exists and columns is not None and 'meta' not in columns:
            self._try_add_meta()

    # ------------------------------------------------------------------
    # Table state
    # ------------------------------------------------------------------

    def _read_columns(self, cur) -> List[str]:
        cur.execute(*self._sql.columns())
        return [row[0] for row in cur.fetchall()]

    def _cached_columns(self) -> List[str]:
        """The columns as last seen, without a lookup (the new-table columns when unknown)."""
        with self._state_lock:
            columns = self._columns
        return columns if columns is not None else list(TABLE_COLUMNS)

    def _columns_now(self) -> List[str]:
        """The table's columns (looked up again when unknown), or the new-table columns when it does not exist."""
        with self._state_lock:
            columns = self._columns
        if columns is not None:
            return columns
        if not self._exists_now():
            return list(TABLE_COLUMNS)
        columns = self._db.run_read(self._read_columns)
        with self._state_lock:
            self._columns = columns
        return columns

    def _exists_now(self) -> bool:
        """Whether the table exists: remembered once seen, looked up again while it was missing."""
        with self._state_lock:
            if self._exists:
                return True
        self._doesCollectionExist()
        with self._state_lock:
            return bool(self._exists)

    def _mark_missing(self) -> None:
        with self._state_lock:
            self._exists = False
            self._columns = None

    def _read(self, work: Callable[[Any], Any], missing: Any) -> Any:
        """Run a read; answer ``missing`` when the table does not exist."""
        if not self._exists_now():
            return missing
        try:
            return self._db.run_read(work)
        except CollectionMissing:
            self._mark_missing()
            return missing

    def _read_control(self, cur) -> List[Tuple[Any, Any]]:
        cur.execute(*self._sql.control())
        return list(cur.fetchall())

    def _apply_control(self, control: Sequence[Tuple[Any, Any]]) -> None:
        """Take the model and dimension from a single control record (the stats tool reads them)."""
        if len(control) == 1:
            model, size = control[0]
            self.modelName = model or ''
            self.vectorSize = int(size or 0)

    def _try_add_meta(self) -> bool:
        """Add the ``meta`` column if the table lock is free within 2 s; never inside a batch write."""
        self._meta_attempt_at = time.monotonic()
        try:
            self._db.run_write(
                lambda cur: cur.execute(*self._sql.add_meta_column()),
                lock=False,
                lock_timeout_ms=self.META_LOCK_TIMEOUT_MS,
            )
        except Exception as e:  # noqa: BLE001 - any failure leaves the column for a later attempt
            warning(
                f'pgvector: could not add the metadata column to table {self.table!r} yet ({e}); '
                'writing without it and retrying later'
            )
            return False
        with self._state_lock:
            if self._columns is not None and 'meta' not in self._columns:
                self._columns = self._columns + ['meta']
        return True

    def _meta_column(self) -> Optional[bool]:
        with self._state_lock:
            if not self._exists or self._columns is None:
                return None
            return 'meta' in self._columns

    # ------------------------------------------------------------------
    # Filters and rows
    # ------------------------------------------------------------------

    def _where(self, docFilter: Optional[DocFilter], *, exclude_control: bool = True, **extra: Any) -> Where:
        """The ``Where`` of a DocFilter; ``extra`` sets more ``Where`` fields."""
        f = docFilter if docFilter is not None else DocFilter()
        where = Where(
            exclude_control=exclude_control,
            deleted=self.resolveDeleted(f),
            node_id=getattr(f, 'nodeId', None),
            is_table=getattr(f, 'isTable', None),
            table_ids=getattr(f, 'tableIds', None),
            parent=getattr(f, 'parent', None),
            permissions=getattr(f, 'permissions', None),
            object_ids=getattr(f, 'objectIds', None),
            chunk_ids=getattr(f, 'chunkIds', None),
            min_chunk_id=getattr(f, 'minChunkId', None),
            max_chunk_id=getattr(f, 'maxChunkId', None),
        )
        for key, value in extra.items():
            setattr(where, key, value)
        return where

    @staticmethod
    def _limit_offset(docFilter: Optional[DocFilter]) -> Tuple[Optional[int], int]:
        limit = getattr(docFilter, 'limit', None)
        offset = getattr(docFilter, 'offset', None)
        try:
            limit = None if limit is None else max(0, int(limit))
        except (TypeError, ValueError):
            limit = None
        try:
            offset = max(0, int(offset or 0))
        except (TypeError, ValueError):
            offset = 0
        return limit, offset

    @staticmethod
    def _fetch_dicts(cur) -> List[Dict[str, Any]]:
        names = [d[0] for d in cur.description]
        return [dict(zip(names, row)) for row in cur.fetchall()]

    @staticmethod
    def _metadata(row: Mapping[str, Any]) -> DocMetadata:
        """The DocMetadata of a row: its columns, then its ``meta`` keys (which never override a column)."""
        point_id = row.get('id')
        fields: Dict[str, Any] = {
            'objectId': row.get('objectid') or '',
            'chunkId': int(row.get('chunkid') or 0),
            'nodeId': row.get('nodeid') if row.get('nodeid') is not None else '',
            'parent': row.get('parent') if row.get('parent') is not None else '',
            'permissionId': row.get('permissionid') if row.get('permissionid') is not None else 0,
            'isDeleted': bool(row.get('isdeleted')),
            'isTable': bool(row.get('istable')) if row.get('istable') is not None else False,
            'tableId': row.get('tableid') if row.get('tableid') is not None else 0,
            'modelName': row.get('modelname') if row.get('modelname') is not None else '',
            'vectorSize': row.get('vectorsize') if row.get('vectorsize') is not None else 0,
        }
        if row.get('signature') is not None:
            fields['signature'] = row['signature']
        if point_id is not None:
            fields['id'] = point_id
            fields['pointId'] = str(point_id)
        meta = _as_dict(row.get('meta'))
        for key, value in meta.items():
            if key not in fields and key not in METADATA_COLUMNS:
                fields[key] = value
        return DocMetadata(**fields)

    def _doc(self, row: Mapping[str, Any], *, score: float = 0.0, with_embedding: bool = False) -> Doc:
        doc = Doc(score=score, page_content=row.get('content'), metadata=self._metadata(row))
        if with_embedding:
            doc.embedding = _parse_vector(row.get('embedding_text'))
        return doc

    def _score(self, distance: Any) -> Optional[float]:
        """The score of a distance under the store's metric (None for NaN)."""
        if distance is None:
            return None
        d = float(distance)
        if math.isnan(d):
            return None
        if self.metric == 'l2':
            return 1.0 / (1.0 + d)
        if self.metric == 'ip':
            return -d
        return 1.0 - d

    # ------------------------------------------------------------------
    # DocumentStoreBase: existence and creation
    # ------------------------------------------------------------------

    def _doesCollectionExist(self) -> bool:
        """Whether the collection exists; a table left without a single row by a failed first write counts as not created."""

        def check(cur):
            cur.execute(*self._sql.exists())
            exists = bool(cur.fetchone()[0])
            if not exists:
                return False, None
            cur.execute(*self._sql.has_rows())
            return bool(cur.fetchone()[0]), self._read_columns(cur)

        try:
            has_rows, columns = self._db.run_read(check)
        except CollectionMissing:
            has_rows, columns = False, None
        with self._state_lock:
            self._exists = columns is not None
            if columns is not None:
                self._columns = columns
        return has_rows

    def _createCollection(self, vectorSize: int = 0) -> None:
        """Create the table and its indexes; an existing table that already holds rows is left alone."""
        dimension = int(vectorSize)
        build_hnsw = self.create_hnsw and 0 < dimension <= HNSW_MAX_DIMS
        if self.create_hnsw and dimension > HNSW_MAX_DIMS:
            warning(
                f'pgvector HNSW supports at most {HNSW_MAX_DIMS} dimensions; got {dimension} for table '
                f'{self.table!r}. Skipping index creation — semantic search will use a sequential scan.'
            )

        def create(cur):
            cur.execute(*self._sql.exists())
            existed = bool(cur.fetchone()[0])
            if existed:
                cur.execute(*self._sql.has_rows())
                if cur.fetchone()[0]:
                    return
            cur.execute(*self._sql.create_table(dimension))
            cur.execute(*self._sql.create_key_index())
            if build_hnsw:
                cur.execute(*self._sql.create_hnsw_index(self.metric, self.hnsw_m, self.hnsw_ef_construction))

        self._db.run_write(create)
        columns = self._db.run_read(self._read_columns)
        with self._state_lock:
            self._exists = True
            self._columns = columns
        if 'meta' not in columns:
            self._try_add_meta()

    # ------------------------------------------------------------------
    # DocumentStoreBase: reads
    # ------------------------------------------------------------------

    def count_documents(self) -> int:
        """Every row of the table (chunks, deleted chunks and the control record); also reloads the model."""

        def work(cur):
            cur.execute(*self._sql.count_all())
            total = int(cur.fetchone()[0])
            return total, self._read_control(cur)

        total, control = self._read(work, (0, []))
        self._apply_control(control)
        return total

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """Chunks matching ``docFilter`` in ``(objectId, chunkId)`` order, honouring ``offset`` and ``limit``.

        This is the one read that may return the control record (when the filter
        asks for objectId ``'schema'``): the base class reads it through here.
        """
        limit, offset = self._limit_offset(docFilter)
        columns = self._columns_now()
        statement = self._sql.get(columns, self._where(docFilter, exclude_control=False), limit, offset)

        def work(cur):
            cur.execute(*statement)
            return [self._doc(row) for row in self._fetch_dicts(cur)]

        if not checkCollection:
            try:
                return self._db.run_read(work)
            except CollectionMissing:
                self._mark_missing()
                return []
        return self._read(work, [])

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """``{path: objectId}`` of every active document, one per distinct path (its lowest object id), by path.

        Any chunk counts, so a document is listed whatever chunk ids it has; ``offset`` and ``limit`` count paths.
        """
        where = Where(deleted='active', parent=parent)
        statement = self._sql.paths(where, max(0, int(limit)), max(0, int(offset)))

        def work(cur):
            cur.execute(*statement)
            return {row[0]: row[1] for row in cur.fetchall()}

        return self._read(work, {})

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """Chunks whose content contains the question text (case-insensitive)."""
        text = getattr(query, 'text', None)
        if not isinstance(text, str):
            text = str(query)
        pattern = '%' + _escape_like(text) + '%'
        limit, offset = self._limit_offset(docFilter)
        columns = self._columns_now()
        statement = self._sql.keyword(columns, self._where(docFilter, content_like=pattern), limit, offset)

        def work(cur):
            cur.execute(*statement)
            return [self._doc(row) for row in self._fetch_dicts(cur)]

        return self._read(work, [])

    def _search_semantic_in(
        self, cur, embedding: Sequence[float], docFilter: DocFilter, *, exact: bool = False
    ) -> List[Dict[str, Any]]:
        """Run the semantic search on ``cur`` (inside a read transaction); rows carry ``distance``.

        ``exact`` runs the statement no approximate index can serve (see ``Statements.semantic_exact``).
        """
        limit, offset = self._limit_offset(docFilter)
        build = self._sql.semantic_exact if exact else self._sql.semantic
        statement = build(
            self._cached_columns(), self.metric, vector_literal(embedding), self._where(docFilter), limit, offset
        )
        cur.execute(*statement)
        return self._fetch_dicts(cur)

    def _semantic_with_recovery(self, cur, embedding: Sequence[float], docFilter: DocFilter) -> List[Dict[str, Any]]:
        """The semantic rows for ``docFilter``, with the exact recovery of a filtered HNSW scan.

        HNSW filters its candidate list after scanning it, so excluded neighbours (a trashed document's
        chunks, other paths) can hide eligible matches. The scan continues past them (iterative scan) where
        pgvector has it, but may still end with too few usable rows. Usable rows are those at or above the
        score threshold (and the 0.20 floor). Then, on a table with a valid approximate index, the same search runs again exactly, in the same
        transaction:

        - an unbounded request (no limit) cannot be satisfied by a bounded approximate scan, so it runs exactly at once;
        - on pgvector with the iterative scan, an answer with at least one usable row stays approximate (fewer
          than ``limit`` alone does not justify a full-table scan), and only an answer with none is confirmed exactly;
        - before it (no iterative scan), any underfilled answer is recovered exactly.

        A table without an approximate index is exact already: it is never scanned twice.
        """
        limit, _offset = self._limit_offset(docFilter)
        if limit is None:
            return self._search_semantic_in(cur, embedding, docFilter, exact=True)
        rows = self._search_semantic_in(cur, embedding, docFilter)
        # A row is usable when the question lane would keep it: at or above the node's score threshold, which
        # is never below the floor. A caller that sets minScore (the explorer) asks for its own bound instead.
        floor = self.effectiveFloor(docFilter)
        if getattr(docFilter, 'minScore', None) is None:
            floor = max(floor, self.threshold_search)
        usable = 0
        for row in rows:
            score = self._score(row.get('distance'))
            if score is not None and score >= floor:
                usable += 1
        if usable >= limit or (self._db.iterative_scan and usable > 0):
            return rows
        cur.execute(*self._sql.has_ann_index())
        if not cur.fetchone()[0]:
            return rows
        return self._search_semantic_in(cur, embedding, docFilter, exact=True)

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """The nearest chunks to the question's embedding, best first, above ``effectiveFloor``."""
        if not self._exists_now():
            return []
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')
        embedding = list(query.embedding)
        self._columns_now()
        rows = self._read(lambda cur: self._semantic_with_recovery(cur, embedding, docFilter), [])
        floor = self.effectiveFloor(docFilter)
        docs: List[Doc] = []
        for row in rows:
            score = self._score(row.get('distance'))
            if score is None or score < floor:
                continue
            docs.append(self._doc(row, score=score))
        # The strict-order scan already returns rows by distance; the stable sort only fixes ties by score.
        docs.sort(key=lambda d: -d.score)
        return docs

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """Send the document's text to ``callback``, one call per page of chunks, in chunk order."""
        after = -1
        while True:
            statement = self._sql.render(objectId, after, self.RENDER_PAGE)

            def work(cur, statement=statement):
                cur.execute(*statement)
                return cur.fetchall()

            rows = self._read(work, [])
            if not rows:
                return
            callback(''.join(content or '' for content, _chunk in rows))
            if len(rows) < self.RENDER_PAGE:
                return
            after = rows[-1][1]

    # ------------------------------------------------------------------
    # DocumentStoreBase: writes
    # ------------------------------------------------------------------

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """Write a batch of chunks (see the module docstring for what a batch replaces)."""
        if not chunks:
            return
        if checkCollection and not self.createCollection(chunks):
            return
        with self._write_lock:
            if self._meta_column() is False and (
                self._meta_attempt_at is None or time.monotonic() - self._meta_attempt_at >= self.META_RETRY_S
            ):
                self._try_add_meta()
            columns = [c for c in WRITE_COLUMNS if c in self._columns_now()]
            rows = [self._row(chunk, columns) for chunk in chunks]
            whole = sorted({chunk.metadata.objectId for chunk in chunks if chunk.metadata.chunkId == 0})
            whole_set = set(whole)
            keys = sorted(
                {
                    (chunk.metadata.objectId, int(chunk.metadata.chunkId))
                    for chunk in chunks
                    if chunk.metadata.objectId not in whole_set
                }
            )
            insert_columns = columns

            def write(cur):
                if whole:
                    cur.execute(*self._sql.delete(Where(exclude_control=False, deleted='all', object_ids=whole)))
                if keys:
                    cur.execute(*self._sql.delete(Where(exclude_control=False, deleted='all', keys=keys)))
                for start in range(0, len(rows), self.INSERT_BATCH):
                    batch = rows[start : start + self.INSERT_BATCH]
                    params: List[Any] = []
                    for row in batch:
                        params.extend(row)
                    cur.execute(self._sql.insert(insert_columns, len(batch)), params)

            self._db.run_write(write)
            with self._state_lock:
                self._exists = True

    def _row(self, chunk: Doc, columns: Sequence[str]) -> List[Any]:
        """The values of one chunk for ``columns``; metadata outside the allowlist goes to ``meta``."""
        meta = chunk.metadata
        data = meta.model_dump() if hasattr(meta, 'model_dump') else dict(meta or {})
        values: Dict[str, Any] = {}
        extras: Dict[str, Any] = {}
        for key, value in data.items():
            column = METADATA_COLUMNS.get(key)
            if column is not None and column in columns:
                values[column] = value
            elif column == 'signature' and value is not None:
                extras[key] = value
            elif column is None and key not in ('id', 'pointId') and value is not None:
                extras[key] = value
        for column, default in (('isdeleted', False), ('istable', False), ('tableid', 0), ('permissionid', 0)):
            if values.get(column) is None:
                values[column] = default
        embedding = chunk.embedding
        if values.get('vectorsize') is None:
            values['vectorsize'] = len(embedding) if embedding else 0
        if values.get('modelname') is None:
            values['modelname'] = ''
        values['content'] = (chunk.page_content or '').replace('\x00', '')
        values['embedding'] = vector_literal(embedding) if embedding is not None else None
        if 'meta' in columns:
            values['meta'] = json.dumps(_clean_json(extras), default=str, separators=(',', ':')) if extras else None
        return [values.get(column) for column in columns]

    def remove(self, objectIds: List[str]) -> None:
        """Delete every chunk of ``objectIds`` (never the control record)."""
        self.removeCounted(objectIds)

    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        """Mark every chunk of ``objectIds`` deleted (never the control record); return the chunks moved."""
        return self._set_deleted(objectIds, True)

    def markActive(self, objectIds: List[str]) -> Optional[int]:
        """Mark every chunk of ``objectIds`` active again (never the control record); return the chunks moved."""
        return self._set_deleted(objectIds, False)

    def _set_deleted(self, objectIds: List[str], value: bool) -> Optional[int]:
        """One UPDATE over the chunks of ``objectIds`` in the other state; its row count is what moved.

        A NULL ``isdeleted`` reads as active, so ``markDeleted`` takes it and ``markActive`` leaves it.
        psycopg2 reports -1 when a statement's row count is not known: that is None here (unknown),
        never 0 (nothing moved).
        """
        ids = [str(o) for o in objectIds or []]
        if not ids or not self._exists_now():
            return 0
        statement = self._sql.set_deleted(Where(deleted='active' if value else 'deleted', object_ids=ids), value)

        def work(cur):
            cur.execute(*statement)
            moved = cur.rowcount
            return int(moved) if isinstance(moved, int) and not isinstance(moved, bool) and moved >= 0 else None

        with self._write_lock:
            return self._db.run_write(work)

    # ------------------------------------------------------------------
    # Explorer hooks
    # ------------------------------------------------------------------

    def scoreInfo(self) -> Dict[str, Any]:
        """How ``Doc.score`` is computed under the configured metric."""
        info = dict(_SCORE_INFO[self.metric])
        info.update({'higher_is_better': True, 'floor': MIN_SIMILARITY_SCORE, 'threshold': self.threshold_search})
        return info

    def describe(self) -> StoreInfo:
        """The table from the catalog; never a host, port, user or database name."""

        def work(cur):
            cur.execute(*self._sql.extension_version())
            row = cur.fetchone()
            version = row[0] if row else None
            cur.execute(*self._sql.exists())
            if not cur.fetchone()[0]:
                return version, None
            columns_types = self._read_column_types(cur)
            cur.execute(*self._sql.indexes())
            indexes = cur.fetchall()
            cur.execute(*self._sql.size())
            size = cur.fetchone()[0]
            control = self._read_control(cur)
            return version, (columns_types, indexes, size, control)

        try:
            version, found = self._db.run_read(work)
        except CollectionMissing:
            version, found = self._extension_version, None

        caveats: List[str] = list(self.store_caveats)
        if not _version_at_least(version, ITERATIVE_SCAN_VERSION):
            # No iterative scan: an HNSW search with a filter may stop before it has k matching rows.
            caveats.append('filtered_search_may_underfill')
        if found is None:
            self._mark_missing()
            return StoreInfo(
                backend=self.backend,
                backend_version=version,
                collection=self.table,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=self.metric,
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )

        columns_types, indexes, size, control = found
        columns = [name for name, _type in columns_types]
        with self._state_lock:
            self._exists = True
            self._columns = columns
        self._apply_control(control)
        meta_column = 'meta' in columns
        if not meta_column:
            caveats += ['meta_column_pending', 'extras_not_stored']
        index = _vector_index(indexes)
        if index['type'] == 'none':
            caveats.append('brute_force_search')
        dimension = _dimension(dict(columns_types).get('embedding'))
        if len(control) == 1 and control[0][1]:
            dimension = int(control[0][1])
        return StoreInfo(
            backend=self.backend,
            backend_version=version,
            collection=self.table,
            collection_exists=True,
            control_record=len(control) == 1,
            meta_column=meta_column,
            metric=self.metric,
            dimension=dimension,
            model=(control[0][0] or None) if len(control) == 1 else None,
            index=index,
            size_bytes=int(size) if size is not None else None,
            caveats=caveats,
        )

    def _read_column_types(self, cur) -> List[Tuple[str, str]]:
        cur.execute(*self._sql.columns())
        return [(row[0], row[1]) for row in cur.fetchall()]

    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """Chunks matching ``docFilter`` (the control record never counts)."""
        statement = self._sql.count_chunks(self._where(docFilter))

        def work(cur):
            cur.execute(*statement)
            return int(cur.fetchone()[0])

        return self._read(work, 0)

    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        """Distinct objectIds matching ``docFilter`` (the control record never counts)."""
        statement = self._sql.count_documents(self._where(docFilter))

        def work(cur):
            cur.execute(*statement)
            return int(cur.fetchone()[0])

        return self._read(work, 0)

    def listDocumentPage(
        self,
        *,
        cursor: Optional[str],
        limit: int,
        object_ids: Optional[Sequence[str]],
        deleted: str,
        sort: str,
        filter: Optional[DocListFilter] = None,
    ) -> DocPage:
        """One page of documents ordered by ``(path, objectId)``, with exact per-document counts.

        A page costs one pass over the table that aggregates only each
        document's path, plus the counts and metadata of the page's own
        documents (read through the ``(objectid, chunkid)`` index). The total
        is counted on the first page and carried by the cursor, so later
        pages do not count again.

        ``filter`` (contract section 4.4-A) is applied in the pass that pages
        the keys (:class:`Having`), so the page, the keyset cursor and the
        total cover only matching documents. On a table without the ``meta``
        column the ingest-time keys cannot be applied: they are named in
        ``filter_ignored`` and the app applies them. A cursor carries a
        digest of the filter it was issued under and is refused with any
        other filter. Each row also reports ``max_chunk_id`` and
        ``deleted_chunks`` (contract section 4.4-F).
        """
        columns = self._columns_now()
        having, ignored = _listing_filter(filter, 'meta' in columns)
        bound = _filter_digest(having)
        after: Optional[Tuple[str, str]] = None
        carried: Optional[int] = None
        if cursor:
            path, object_id, carried, issued = _decode_cursor(cursor)
            # A cursor of another filter would page from the wrong position with the wrong total;
            # one of this filter always carries its total (only the unfiltered listing may recount).
            if issued != bound or (having is not None and carried is None):
                raise ToolRefusal(
                    'INVALID_INPUT',
                    'The documents cursor belongs to a listing with another filter; start again without one',
                )
            after = (path, object_id)
        page = max(1, int(limit))
        where = Where(deleted=deleted if deleted in ('active', 'deleted', 'all') else 'active')
        if object_ids is not None:
            where.object_ids = [str(o) for o in object_ids]
        keys_statement = self._sql.list_document_keys(where, after, page + 1, with_total=after is None, having=having)
        count_statement = self._sql.count_documents(where) if after is not None and carried is None else None

        def work(cur):
            cur.execute(*keys_statement)
            keys = self._fetch_dicts(cur)
            rows: List[Dict[str, Any]] = []
            if keys:
                shown = [key['objectid'] for key in keys[:page]]
                cur.execute(*self._sql.list_documents(columns, dataclasses.replace(where, object_ids=shown)))
                rows = self._fetch_dicts(cur)
            counted = None
            if count_statement is not None:
                cur.execute(*count_statement)
                counted = int(cur.fetchone()[0])
            return keys, rows, counted

        keys, rows, counted = self._read(work, ([], [], None))
        if after is None:
            total = int(keys[0]['total']) if keys else 0
        else:
            total = carried if carried is not None else (counted or 0)
        more = len(keys) > page
        keys = keys[:page]
        by_id = {row['objectid']: row for row in rows}
        items = []
        for key in keys:
            row = by_id.get(key['objectid'])
            # Gone between the two statements, or none of its rows is of the listing's mode any more.
            if row is not None and int(row.get('chunks') or 0) > 0:
                items.append(_document_row({**row, 'path': key['path']}))
        next_cursor = _encode_cursor(keys[-1]['path'], keys[-1]['objectid'], total, bound) if more and keys else None
        return DocPage(
            items=items,
            next_cursor=next_cursor,
            total=total,
            counts_exact=True,
            distinct=True,
            sorted=True,
            caveats=[],
            filter_ignored=ignored,
        )

    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str) -> ChunkPage:
        """The document's chunks after ``after_chunk`` in chunk order, without embeddings."""
        if objectId == CONTROL_OBJECT_ID:
            return ChunkPage(docs=[], has_more=False, next_after=int(after_chunk))
        page = max(1, int(limit))
        where = Where(
            deleted=deleted if deleted in ('active', 'deleted', 'all') else 'active',
            object_id=str(objectId),
            after_chunk_id=int(after_chunk),
        )
        statement = self._sql.scroll(self._columns_now(), where, page + 1)

        def work(cur):
            cur.execute(*statement)
            return self._fetch_dicts(cur)

        rows = self._read(work, [])
        more = len(rows) > page
        docs = [self._doc(row) for row in rows[:page]]
        next_after = docs[-1].metadata.chunkId if docs else int(after_chunk)
        return ChunkPage(docs=docs, has_more=more, next_after=next_after)

    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        """The chunks of ``keys`` with their embeddings, in the order asked; missing keys are left out."""
        wanted = [(str(o), int(c)) for o, c in keys if str(o) != CONTROL_OBJECT_ID]
        if not wanted:
            return []
        columns = self._columns_now()
        found: Dict[Tuple[str, int], Doc] = {}
        for start in range(0, len(wanted), 500):
            statement = self._sql.vectors(columns, Where(deleted='all', keys=wanted[start : start + 500]))

            def work(cur, statement=statement):
                cur.execute(*statement)
                return self._fetch_dicts(cur)

            for row in self._read(work, []):
                found[(row['objectid'], int(row['chunkid']))] = self._doc(row, with_embedding=True)
        return [found[key] for key in dict.fromkeys(wanted) if key in found]

    def sampleChunks(
        self,
        *,
        n: int,
        seed: int,
        strategy: str,
        docFilter: DocFilter,
        include_keys: Sequence[Tuple[str, int]],
    ) -> Tuple[List[Doc], str]:
        """Up to ``n`` chunks with embeddings; ``random`` and ``stratified`` are seeded and repeatable."""
        if strategy not in ('random', 'stratified', 'first'):
            raise ToolRefusal('INVALID_INPUT', f'Unknown sampling strategy {strategy!r}')
        count = max(0, int(n))
        if count == 0:
            return [], strategy
        where = self._where(docFilter)
        pinned = [(str(o), int(c)) for o, c in include_keys or []]
        if pinned:
            where.not_keys = pinned
        statement = self._sql.sample(self._columns_now(), strategy, where, count, seed)

        def work(cur):
            cur.execute(*statement)
            return self._fetch_dicts(cur)

        rows = self._read(work, [])
        return [self._doc(row, with_embedding=True) for row in rows], strategy

    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Delete every chunk of ``objectIds`` and return the rows removed (the control record is never removed)."""
        ids = [str(o) for o in objectIds or [] if str(o) != CONTROL_OBJECT_ID]
        if not ids or not self._exists_now():
            return 0
        statement = self._sql.delete(Where(deleted='all', object_ids=ids))

        def work(cur):
            cur.execute(*statement)
            return max(0, int(cur.rowcount or 0))

        with self._write_lock:
            try:
                return self._db.run_write(work)
            except CollectionMissing:
                self._mark_missing()
                return 0

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` whose ``isdeleted`` is true, in one statement; return the rows removed.

        The state is part of the DELETE's WHERE, so a row a concurrent ``restore`` has just flipped (the
        UPDATE commits first, or this statement waits for it and re-reads the row) is not deleted. The
        control record is never removed.
        """
        ids = [str(o) for o in objectIds or [] if str(o) != CONTROL_OBJECT_ID]
        if not ids or not self._exists_now():
            return 0
        statement = self._sql.delete(Where(deleted='deleted', object_ids=ids))

        def work(cur):
            cur.execute(*statement)
            return max(0, int(cur.rowcount or 0))

        with self._write_lock:
            try:
                return self._db.run_write(work)
            except CollectionMissing:
                self._mark_missing()
                return 0


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------


def _hnsw_params(m: Any, ef_construction: Any) -> Tuple[int, int]:
    """HNSW build parameters clamped to pgvector's ranges (m 2-100, ef_construction 4-1000 and >= 2m)."""
    try:
        m_value = min(100, max(2, int(m)))
    except (TypeError, ValueError):
        m_value = 16
    try:
        ef_value = min(1000, max(4, int(ef_construction)))
    except (TypeError, ValueError):
        ef_value = 64
    return m_value, max(ef_value, 2 * m_value)


def _version_at_least(version: Optional[str], wanted: Tuple[int, ...]) -> bool:
    if not version:
        return False
    parts: List[int] = []
    for piece in str(version).split('.'):
        digits = ''.join(ch for ch in piece if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts + [0] * (len(wanted) - len(parts))) >= wanted


def _escape_like(text: str) -> str:
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, (str, bytes)) and value:
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _clean_json(value: Any) -> Any:
    """``value`` with NUL characters removed from strings (jsonb rejects them)."""
    if isinstance(value, str):
        return value.replace('\x00', '')
    if isinstance(value, dict):
        return {str(k).replace('\x00', ''): _clean_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean_json(v) for v in value]
    return value


def _parse_vector(text: Any) -> Optional[List[float]]:
    """A list of floats from pgvector's text form (``'[1,2,3]'``)."""
    if text is None:
        return None
    if isinstance(text, (list, tuple)):
        return [float(v) for v in text]
    values = json.loads(text)
    return [float(v) for v in values]


def _dimension(type_name: Optional[str]) -> Optional[int]:
    """``384`` from ``'vector(384)'``."""
    if not type_name or '(' not in type_name:
        return None
    try:
        return int(type_name.split('(', 1)[1].rstrip(')'))
    except ValueError:
        return None


def _vector_index(indexes: Sequence[Sequence[Any]]) -> Dict[str, Any]:
    """The vector index of the table (HNSW or IVFFlat) and its build parameters."""
    for _name, method, _definition, options in indexes:
        if method not in ('hnsw', 'ivfflat'):
            continue
        params: Dict[str, Any] = {}
        for option in options or []:
            key, _sep, value = str(option).partition('=')
            try:
                params[key] = int(value)
            except ValueError:
                params[key] = value
        if method == 'hnsw':
            params.setdefault('m', 16)
            params.setdefault('ef_construction', 64)
        return {'type': method, 'params': params}
    return {'type': 'none', 'params': {}}


#: The ingest-time keys of the documents filter: applied only where the table has its ``meta`` column.
_INGEST_KEYS = ('ingested_after', 'ingested_before')


def _listing_filter(flt: Optional[DocListFilter], meta_column: bool) -> Tuple[Optional[Having], Tuple[str, ...]]:
    """``(conditions to apply, keys left to the app)`` for a documents filter (contract section 4.4-A).

    Every key is applied, except the ingest-time keys on a table without the ``meta``
    column, which holds the ingest time. None when nothing is left to apply.
    """
    if flt is None:
        return None, ()
    given = flt.given()
    ignored = tuple(key for key in given if key in _INGEST_KEYS and not meta_column)
    applied = {key: getattr(flt, key) for key in given if key not in ignored}
    if not applied:
        return None, ignored
    return Having(**applied), ignored


def _filter_digest(having: Optional[Having]) -> Optional[str]:
    """A short digest of the conditions a listing applies (None without any), bound into its cursors."""
    if having is None:
        return None
    applied = {
        k: list(v) if isinstance(v, tuple) else v for k, v in dataclasses.asdict(having).items() if v is not None
    }
    raw = json.dumps(applied, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()[:16]


def _encode_cursor(path: str, object_id: str, total: Optional[int] = None, digest: Optional[str] = None) -> str:
    """The documents cursor: the last ``(path, objectId)`` of a page, the listing's total and its filter digest."""
    value: Dict[str, Any] = {'p': path, 'o': object_id}
    if total is not None:
        value['t'] = int(total)
    if digest is not None:
        value['f'] = digest
    raw = json.dumps(value, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode_cursor(cursor: str) -> Tuple[str, str, Optional[int], Optional[str]]:
    """``(path, objectId, total, filter digest)`` of a documents cursor; None for what the cursor does not carry."""
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
        if isinstance(value, dict) and isinstance(value.get('p'), str) and isinstance(value.get('o'), str):
            total = value.get('t')
            if not (isinstance(total, int) and not isinstance(total, bool) and total >= 0):
                total = None
            digest = value.get('f')
            return value['p'], value['o'], total, digest if isinstance(digest, str) else None
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        pass
    raise ToolRefusal('INVALID_INPUT', 'The documents cursor is not valid; start again without one')


@dataclasses.dataclass(frozen=True)
class PgDocumentRow(DocumentRow):
    """A ``DocumentRow`` with the per-document health fields of contract section 4.4-F."""

    #: The largest chunkId among the rows the listing's ``deleted`` mode selects.
    max_chunk_id: Optional[int] = None
    #: The document's soft-deleted rows, whatever the listing's mode.
    deleted_chunks: Optional[int] = None


def _document_row(row: Mapping[str, Any]) -> DocumentRow:
    meta = _as_dict(row.get('meta'))

    def as_int(value: Any) -> Optional[int]:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    ingested = meta.get('ingestedAt')
    point_id = row.get('point_id')
    return PgDocumentRow(
        objectId=row['objectid'],
        path=row.get('path') or '',
        chunks=int(row['chunks']),
        has_first_chunk=bool(row.get('has_first_chunk')),
        deleted=bool(row.get('deleted')),
        tables=int(row.get('tables') or 0),
        nodeId=row.get('nodeid'),
        size=as_int(meta.get('size')),
        modifyTime=as_int(meta.get('modifyTime')),
        ingestedAt=str(ingested) if ingested is not None else None,
        pointId=str(point_id) if point_id is not None else None,
        max_chunk_id=as_int(row.get('max_chunk_id')),
        deleted_chunks=as_int(row.get('deleted_chunks')),
    )


__all__ = ['DEFAULT_STATEMENT_TIMEOUT_MS', 'MIN_SIMILARITY_SCORE', 'PgDocumentRow', 'PgVectorStore']
