# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Filtered pgvector search shared by the managed and generic PostgreSQL stores.

The managed and generic nodes inherit search and connection serialization here.
Other store backends keep their own native search implementations. Import only
after the PostgreSQL node has loaded its optional dependencies.
"""

import threading
from contextlib import contextmanager
from typing import Any, Iterator

import numpy as np
from rocketlib import warning
from ai.common.schema import Doc, DocFilter, QuestionText
from ai.common.store import DocumentStoreBase

MIN_SIMILARITY_SCORE = 0.20

SEARCH_SQL = {
    'semantic_search': 'SELECT *, embedding {similarity_operator} %s AS distance FROM {collection} {where_clause} ORDER BY distance LIMIT %s',
    # Adding zero to the distance prevents an approximate index from serving
    # this ORDER BY. The subquery makes the distance alias available to the
    # expression without passing the query vector a second time. Exclude
    # undefined distances (NULL / NaN, including zero vectors with cosine).
    'semantic_search_exact': (
        'SELECT * FROM (SELECT *, embedding {similarity_operator} %s AS distance '
        'FROM {collection} {where_clause}) AS candidates '
        "WHERE distance < 'Infinity'::float8 ORDER BY distance + 0 LIMIT %s"
    ),
}


class PgVectorStoreBase(DocumentStoreBase):
    """Shared search for PostgreSQL vector drivers with a validated table name."""

    def __init__(self, provider: str, connConfig: dict[str, Any], bag: dict[str, Any]):
        super().__init__(provider, connConfig, bag)
        # All driver cursors share this lock: another caller must not enter a
        # search transaction or reset its local settings by committing a write.
        self._lock = threading.RLock()
        self._iterative_scan: bool | None = None

    @contextmanager
    def _cursor(self) -> Iterator[Any]:
        """
        Yield a cursor for autocommitted statements (one implicit transaction each).
        """
        with self._lock, self.client.cursor() as cur:
            yield cur

    @contextmanager
    def _transaction(self) -> Iterator[Any]:
        """
        Yield a cursor whose statements commit together, or not at all.

        Rolls back on any error, so the connection is never left inside a
        transaction (open or aborted), then returns to autocommit.
        """
        with self._lock:
            self.client.autocommit = False
            try:
                with self.client.cursor() as cur:
                    yield cur
                self.client.commit()
            except BaseException:
                # A rollback that fails itself (a broken connection) must not
                # replace the write error.
                try:
                    self.client.rollback()
                except Exception as rollback_error:  # noqa: BLE001
                    warning(f'{self.collection}: rollback after a failed write also failed: {rollback_error}')
                raise
            finally:
                # Fails only if the rollback failed too. Close rather than keep
                # a connection that may still sit in a transaction (pinning a
                # pooler slot); the next call surfaces the closed connection.
                try:
                    self.client.autocommit = True
                except Exception as restore_error:  # noqa: BLE001
                    warning(f'{self.collection}: closing the connection, autocommit restore failed: {restore_error}')
                    self.client.close()

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> list[Doc]:
        """Continue filtered HNSW scans; confirm otherwise empty answers exactly."""
        if not self._doesCollectionExist():
            return []

        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        where_sql, params = self._convertFilter(docFilter)
        embedding_arr = np.array(query.embedding)

        # pgvector 0.8+ can continue an HNSW scan past excluded candidates.
        # Cache the extension capability per connection, not a tenant setting.
        with self._lock:
            if self._iterative_scan is None:
                with self._cursor() as cur:
                    cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
                    version = cur.fetchone()[0]
                self._iterative_scan = tuple(int(part) for part in version.split('.')[:2]) >= (0, 8)

        # An unbounded request cannot be satisfied by a bounded ANN scan.
        search_sql = 'semantic_search_exact' if docFilter.limit is None else 'semantic_search'
        iterative = self._iterative_scan and docFilter.limit is not None
        # SET LOCAL and the query must share a transaction behind PgBouncer.
        # _transaction commits/rolls back and restores autocommit on every exit.
        with self._transaction() if iterative else self._cursor() as cur:
            if iterative:
                cur.execute('SET LOCAL hnsw.iterative_scan = strict_order')
            cur.execute(
                SEARCH_SQL[search_sql].format(
                    collection=self.collection, similarity_operator=self.similarity, where_clause=where_sql
                ),
                (embedding_arr, *params, docFilter.limit),
            )
            results = cur.fetchall()

            columns = [desc[0] for desc in cur.description]
            points = [dict(zip(columns, row)) for row in results]
            # Match the exact query's treatment of undefined distances even
            # when an unindexed table needs no retry (NULL or zero/cosine).
            points = [point for point in points if point['distance'] is not None and point['distance'] < float('inf')]
            docs = self._convertToDocs(points)
            try:
                threshold = max(MIN_SIMILARITY_SCORE, float(self.threshold_search))
            except (TypeError, ValueError):
                threshold = MIN_SIMILARITY_SCORE

            # HNSW filters its candidate list after scanning. Deleted or
            # excluded neighbours can hide eligible matches, or leave only
            # low-scoring candidates. Count usable matches, not raw rows.
            usable = sum(doc.score >= threshold for doc in docs)
            if docFilter.limit is None or usable >= docFilter.limit or (iterative and usable > 0):
                return docs

            # The generic PostgreSQL node creates no ANN index by default. Its
            # first query is already exact; avoid scanning an unindexed table twice.
            # Check at retry time so an administrator can add/drop indexes while
            # this store stays open. A valid ANN index may still be unused by the
            # planner, in which case the retry remains correct but redundant.
            cur.execute(
                'SELECT EXISTS (SELECT 1 FROM pg_index i '
                'JOIN pg_class c ON c.oid = i.indexrelid '
                'JOIN pg_am a ON a.oid = c.relam '
                "WHERE i.indrelid = to_regclass(%s) AND i.indisvalid AND a.amname IN ('hnsw', 'ivfflat'))",
                (self.collection,),
            )
            if not cur.fetchone()[0]:
                return docs

            # Even iterative HNSW can miss an isolated relevant neighbour,
            # particularly with many duplicate vectors. Recover an otherwise
            # empty answer exactly. On pre-0.8 servers also recover underfilled
            # batches, since those cannot scan past the initial candidate list.
            # A nonempty modern result stays approximate: fewer than limit
            # usable matches alone must not cause a full-table retry.
            cur.execute(
                SEARCH_SQL['semantic_search_exact'].format(
                    collection=self.collection, similarity_operator=self.similarity, where_clause=where_sql
                ),
                (embedding_arr, *params, docFilter.limit),
            )
            results = cur.fetchall()

        # Convert results to dictionary
        points = [dict(zip([desc[0] for desc in cur.description], row)) for row in results]
        return self._convertToDocs(points)
