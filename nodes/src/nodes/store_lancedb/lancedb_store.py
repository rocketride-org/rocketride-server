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

# ------------------------------------------------------------------------------
# Interface implementation for the LanceDB store
# ------------------------------------------------------------------------------
# LanceDB is not a base engine package, so install the requirements before
# loading the driver. IGlobal imports this module lazily, so config mode never
# gets here.
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
import json
import threading
import time
from datetime import timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional

import lancedb
import pyarrow as pa
from lancedb.rerankers import RRFReranker

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config
from ai.constants import CONST_TASK_DATA_PATH
from rocketlib import warning

from .lancedb_config import (
    DISTANCES,
    SEARCH_MODES,
    is_object_uri,
    parse_storage_options,
    read_choice,
    read_count,
    resolve_uri,
    validate_table,
)

# Minimum rescaled [0, 1] similarity for a result to count as relevant; below
# this it is dropped as noise regardless of the configured retrieval score.
MIN_RELEVANCE_SCORE = 0.20

# Rows per add, delete and update call
BATCH_SIZE = 1000

# Results returned when the filter does not set a limit, as DocFilter does
DEFAULT_LIMIT = 25

# Longest error text passed on from LanceDB or Arrow
MAX_ERROR_LENGTH = 300

# Vector index built once a table passes indexAfterRows. IVF_HNSW_SQ keeps
# far more of each vector than IVF_PQ, and a refine pass re-ranks the top
# candidates on the raw vectors; together they stay close to brute force (on
# 384 dimension embeddings, recall@10 of about 0.99 against 0.75 for IVF_PQ).
INDEX_TYPE = 'IVF_HNSW_SQ'
INDEX_NPROBES = 20
INDEX_REFINE_FACTOR = 50

# How often an open table checks for writes made by other pipelines. Without
# it a cached table keeps the version it first saw until the engine restarts.
READ_CONSISTENCY_INTERVAL = timedelta(seconds=5)

# Columns every table carries. The metadata column keeps the whole DocMetadata
# as JSON so extra fields survive; the others are copies used for filtering.
COLUMNS = (
    'id',
    'objectId',
    'chunk',
    'nodeId',
    'path',
    'permissionId',
    'isTable',
    'tableId',
    'deleted',
    'text',
    'metadata',
    'vector',
)


def _schema(vectorSize: int) -> pa.Schema:
    """Arrow schema of a store table for the given vector size."""
    return pa.schema(
        [
            pa.field('id', pa.string()),
            pa.field('objectId', pa.string()),
            pa.field('chunk', pa.int64()),
            pa.field('nodeId', pa.string()),
            pa.field('path', pa.string()),
            pa.field('permissionId', pa.int64()),
            pa.field('isTable', pa.bool_()),
            pa.field('tableId', pa.int64()),
            pa.field('deleted', pa.bool_()),
            pa.field('text', pa.string()),
            pa.field('metadata', pa.string()),
            pa.field('vector', pa.list_(pa.float32(), vectorSize)),
        ]
    )


def _column(name: str) -> str:
    """Return a column name for a filter, refusing anything outside the schema."""
    if name not in COLUMNS:
        raise ValueError(f'Unknown column {name!r} in filter')
    return name


def _quote(value: Any) -> str:
    """Quote a value as a SQL string literal, doubling any single quotes."""
    return "'" + str(value).replace("'", "''") + "'"


def _batches(items: List[Any], size: int = BATCH_SIZE) -> Iterable[List[Any]]:
    """Yield the list in slices of at most size items."""
    for start in range(0, len(items), size):
        yield items[start : start + size]


class Store(DocumentStoreBase):
    node: str = 'lancedb'
    uri: str = ''
    table: str = ''
    distance: str = 'cosine'
    searchMode: str = 'vector'
    storageOptions: Optional[Dict[str, str]] = None
    indexAfterRows: int = 50000
    optimizeAfterWrites: int = 1000
    renderChunkSize: int = 1000
    threshold_search: float = 0.0
    db: Any = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the LanceDB store and connect to its directory or bucket.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Read and check every setting before touching storage, so a bad value
        # fails at pipeline start with the name of the field
        try:
            self.uri = resolve_uri(config.get('uri'), CONST_TASK_DATA_PATH, object_only=config.get('mode') == 'object')
            self.table = validate_table(config.get('table'))
            self.distance = read_choice(config, 'distance', DISTANCES, 'cosine')
            self.searchMode = read_choice(config, 'searchMode', SEARCH_MODES, 'vector')
            self.indexAfterRows = read_count(config, 'indexAfterRows', 50000)
            self.optimizeAfterWrites = read_count(config, 'optimizeAfterWrites', 1000)
            self.renderChunkSize = read_count(config, 'renderChunkSize', 1000) or 1000
            self.storageOptions = parse_storage_options(config.get('storageOptions'))
        except ValueError as e:
            raise Exception(f'LanceDB configuration error: {e}') from None

        self.threshold_search = config.get('score', 0.5)

        # Storage options only mean something for object storage
        if not is_object_uri(self.uri):
            self.storageOptions = None

        # State shared by the threads of this pipeline
        self._tableObj = None
        self._ftsReady = False
        self._vectorIndexed = False
        self._indexCheckedAt = 0.0
        self._writes = 0
        self._writeLock = threading.Lock()

        try:
            if self.storageOptions:
                self.db = lancedb.connect(
                    self.uri,
                    storage_options=self.storageOptions,
                    read_consistency_interval=READ_CONSISTENCY_INTERVAL,
                )
            else:
                self.db = lancedb.connect(self.uri, read_consistency_interval=READ_CONSISTENCY_INTERVAL)
        except Exception as e:
            self.db = None
            raise Exception(self._error('connect', e)) from e

    def __del__(self):
        """
        Release the connection and the cached table.
        """
        self._tableObj = None
        self.db = None
        self.storageOptions = None

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _error(self, action: str, e: Exception) -> str:
        """Build a short store error from a LanceDB or Arrow exception."""
        text = str(e).strip() or type(e).__name__
        if len(text) > MAX_ERROR_LENGTH:
            text = text[:MAX_ERROR_LENGTH] + '...'
        return f'LanceDB {action} failed on table {self.table!r}: {text}'

    def _tableNames(self) -> List[str]:
        """List every table in the database, following the pages."""
        names: List[str] = []
        token = None
        while True:
            response = self.db.list_tables(page_token=token) if token else self.db.list_tables()
            names.extend(response.tables or [])
            token = getattr(response, 'page_token', None)
            if not token:
                return names

    def _getTable(self):
        """Return the open table, or None when it does not exist yet."""
        if self._tableObj is not None:
            return self._tableObj
        if self.db is None or self.table not in self._tableNames():
            return None
        table = self.db.open_table(self.table)
        # A table indexed by another pipeline or an earlier run still needs the
        # refine pass in searchSemantic, even if this store never writes
        self._vectorIndexed = self._hasVectorIndex(table)
        self._indexCheckedAt = time.monotonic()
        self._tableObj = table
        return self._tableObj

    def _hasVectorIndex(self, table) -> bool:
        """Return True when the table has an index on the vector column."""
        return any('vector' in (index.columns or []) for index in table.list_indices())

    def _refreshVectorIndexed(self, table) -> None:
        """Pick up a vector index another pipeline built after this one opened the table."""
        if self._vectorIndexed:
            return
        now = time.monotonic()
        if now - self._indexCheckedAt < READ_CONSISTENCY_INTERVAL.total_seconds():
            return
        self._indexCheckedAt = now
        self._vectorIndexed = self._hasVectorIndex(table)

    def _limit(self, docFilter: DocFilter) -> int:
        """The result limit for a query, defaulting like DocFilter does."""
        return docFilter.limit if docFilter.limit is not None else DEFAULT_LIMIT

    def _intList(self, values: List[Any], field: str) -> str:
        """A comma separated list of integers, or an error naming the filter field."""
        try:
            return ', '.join(str(int(value)) for value in values)
        except (TypeError, ValueError):
            raise ValueError(f'Cannot filter on {field}: every value must be a whole number') from None

    def _in(self, column: str, values: List[Any], field: str, numeric: bool = False) -> str:
        """A column IN (...) condition. An empty list matches nothing."""
        if not values:
            return 'false'
        items = self._intList(values, field) if numeric else ', '.join(_quote(value) for value in values)
        return f'{_column(column)} IN ({items})'

    def _convertFilter(self, docFilter: DocFilter) -> str:
        """
        Translate a DocFilter into a DataFusion SQL predicate.

        Values are quoted or converted to integers and column names come from a
        fixed list, so nothing from the filter reaches the SQL unquoted. Rows
        marked deleted are left out unless the filter asks for them.
        """
        conditions: List[str] = []

        try:
            if docFilter.nodeId is not None:
                conditions.append(f'{_column("nodeId")} = {_quote(docFilter.nodeId)}')

            if docFilter.isTable is not None:
                conditions.append(f'{_column("isTable")} = {"true" if docFilter.isTable else "false"}')

            if docFilter.tableIds is not None:
                conditions.append(self._in('tableId', docFilter.tableIds, 'tableIds', numeric=True))

            if docFilter.parent is not None:
                conditions.append(f'{_column("path")} = {_quote(docFilter.parent)}')

            if docFilter.permissions is not None:
                conditions.append(self._in('permissionId', docFilter.permissions, 'permissions', numeric=True))

            if docFilter.objectIds is not None:
                conditions.append(self._in('objectId', docFilter.objectIds, 'objectIds'))

            # Exclude only rows explicitly marked deleted
            if not docFilter.isDeleted:
                conditions.append(f'{_column("deleted")} = false')

            if docFilter.chunkIds is not None:
                conditions.append(self._in('chunk', docFilter.chunkIds, 'chunkIds', numeric=True))

            if docFilter.minChunkId is not None:
                conditions.append(f'{_column("chunk")} >= {self._intList([docFilter.minChunkId], "minChunkId")}')

            if docFilter.maxChunkId is not None:
                conditions.append(f'{_column("chunk")} <= {self._intList([docFilter.maxChunkId], "maxChunkId")}')
        except ValueError as e:
            raise Exception(f'LanceDB filter refused: {e}') from None

        return ' AND '.join(conditions)

    def _vectorScore(self, distance: Optional[float]) -> float:
        """
        Rescale a LanceDB distance to a [0, 1] similarity.

        Cosine distance is 1 - cosine and dot distance is 1 - dot product, so
        for normalized embeddings both run from 0 to 2. L2 distance is squared
        and unbounded, so it maps through 1 / (1 + distance).
        """
        if distance is None:
            return 0.0
        if self.distance == 'l2':
            score = 1.0 / (1.0 + max(float(distance), 0.0))
        else:
            score = 1.0 - float(distance) / 2.0
        return min(max(score, 0.0), 1.0)

    def _toDoc(self, row: Dict[str, Any], score: float) -> Doc:
        """Build a Doc from a table row."""
        # Unset fields are left out, since DocMetadata refuses an explicit None
        fields = {key: value for key, value in json.loads(row['metadata']).items() if value is not None}
        # markDeleted and markActive only change the deleted column
        if row.get('deleted') is not None:
            fields['isDeleted'] = bool(row['deleted'])
        metadata = DocMetadata(**fields)
        return Doc(score=score, page_content=row.get('text') or '', metadata=metadata)

    def _toRow(self, chunk: Doc) -> Dict[str, Any]:
        """Build a table row from a document chunk."""
        meta = chunk.metadata
        return {
            'id': f'{meta.objectId}#{meta.chunkId or 0}',
            'objectId': meta.objectId,
            'chunk': int(meta.chunkId or 0),
            'nodeId': meta.nodeId,
            'path': meta.parent,
            'permissionId': meta.permissionId,
            'isTable': bool(meta.isTable),
            'tableId': meta.tableId,
            'deleted': bool(meta.isDeleted),
            'text': chunk.page_content or '',
            'metadata': json.dumps(meta.model_dump(exclude_none=True), default=str),
            'vector': [float(value) for value in chunk.embedding],
        }

    def _ensureFtsIndex(self, table) -> None:
        """Create the full text index on the text column the first time it is needed."""
        if self._ftsReady:
            return
        with self._writeLock:
            if self._ftsReady:
                return
            indexed = any(
                'text' in (index.columns or []) and 'fts' in str(index.index_type).lower()
                for index in table.list_indices()
            )
            if not indexed:
                table.create_fts_index('text', replace=True)
            self._ftsReady = True

    def _afterWrite(self, table) -> None:
        """
        Run the maintenance the configuration asks for after a write.

        optimize() compacts the small fragments every write leaves and folds new
        rows into existing indexes. Once the table is large enough, a vector
        index replaces brute force search. Both are best effort: a failure here
        is reported but never loses the data that was just written.
        """
        self._writes += 1

        if self.optimizeAfterWrites and self._writes % self.optimizeAfterWrites == 0:
            try:
                table.optimize()
            except Exception as e:
                warning(self._error('optimize', e))

        if self.indexAfterRows and not self._vectorIndexed:
            try:
                if self._hasVectorIndex(table):
                    self._vectorIndexed = True
                elif table.count_rows() >= self.indexAfterRows:
                    table.create_index(
                        metric=self.distance, vector_column_name='vector', index_type=INDEX_TYPE, replace=True
                    )
                    self._vectorIndexed = True
            except Exception as e:
                warning(self._error('vector index build', e))

    def _deleteWhere(self, table, column: str, values: List[str]) -> None:
        """Delete the rows whose column is in values, in batches."""
        for batch in _batches(values):
            table.delete(self._in(column, batch, column))

    def _setDeleted(self, objectIds: List[str], deleted: bool) -> None:
        """Set the deleted flag on every chunk of the given objects."""
        if not objectIds or not self.doesCollectionExist():
            return
        table = self._getTable()
        if table is None:
            return
        try:
            with self._writeLock:
                for batch in _batches(list(objectIds)):
                    table.update(where=self._in('objectId', batch, 'objectIds'), values={'deleted': deleted})
                self._afterWrite(table)
        except Exception as e:
            raise Exception(self._error('update', e)) from e

    # ------------------------------------------------------------------
    # DocumentStoreBase
    # ------------------------------------------------------------------

    def _doesCollectionExist(self) -> bool:
        """
        Check if the table exists.
        """
        if self.db is None:
            return False
        try:
            return self._getTable() is not None
        except Exception as e:
            raise Exception(self._error('table lookup', e)) from e

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create the table, or open it when it is already there.

        The base class adds the control document right after this returns.
        """
        try:
            self._tableObj = self.db.create_table(self.table, schema=_schema(vectorSize), exist_ok=True)
        except Exception as e:
            raise Exception(self._error('create table', e)) from e
        return True

    def count_documents(self) -> int:
        """
        Return the number of chunks in the store that are not marked deleted.
        """
        if not self.doesCollectionExist():
            return 0
        try:
            return self._getTable().count_rows('deleted = false')
        except Exception as e:
            raise Exception(self._error('count', e)) from e

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search over the chunk text with the full text index.

        BM25 scores are relative to the query, so each hit is scored against the
        best hit of the same search: the top match scores 1.0.
        """
        if not self.doesCollectionExist():
            return []

        text = (query.text or '').strip()
        if not text:
            return []

        where = self._convertFilter(docFilter)
        table = self._getTable()

        try:
            self._ensureFtsIndex(table)
            search = table.search(text, query_type='fts')
            if where:
                search = search.where(where, prefilter=True)
            rows = search.offset(docFilter.offset or 0).limit(self._limit(docFilter)).to_list()
        except Exception as e:
            raise Exception(self._error('keyword search', e)) from e

        best = max((row.get('_score') or 0.0 for row in rows), default=0.0)
        if best <= 0:
            return []
        return [self._toDoc(row, (row.get('_score') or 0.0) / best) for row in rows]

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search, fused with keyword search when searchMode is hybrid.
        """
        if not self.doesCollectionExist():
            return []

        # We know the table exists, now we can check to make sure the
        # embedding is correct
        self.doesCollectionExist(query.embedding_model)

        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        where = self._convertFilter(docFilter)
        table = self._getTable()
        vector = [float(value) for value in query.embedding]
        text = (query.text or '').strip()

        try:
            if self.searchMode == 'hybrid' and text:
                self._ensureFtsIndex(table)
                search = (
                    table.search(query_type='hybrid', vector_column_name='vector', fts_columns='text')
                    .vector(vector)
                    .text(text)
                    .distance_type(self.distance)
                )
            else:
                search = table.search(vector, vector_column_name='vector').distance_type(self.distance)

            self._refreshVectorIndexed(table)
            if self._vectorIndexed:
                search = search.nprobes(INDEX_NPROBES).refine_factor(INDEX_REFINE_FACTOR)

            if where:
                search = search.where(where, prefilter=True)

            if self.searchMode == 'hybrid' and text:
                search = search.rerank(RRFReranker(return_score='all'))

            rows = search.offset(docFilter.offset or 0).limit(self._limit(docFilter)).to_list()
        except Exception as e:
            raise Exception(self._error('semantic search', e)) from e

        # A hybrid hit found by the vectors carries a distance and one found by
        # the keywords a BM25 score, scaled against the best keyword hit. A hit
        # found both ways keeps the better of the two, so a strong keyword match
        # is not dropped for being far away in vector space.
        best = max((row.get('_score') or 0.0 for row in rows), default=0.0)

        docs: List[Doc] = []
        for row in rows:
            score = 0.0
            if row.get('_distance') is not None:
                score = self._vectorScore(row['_distance'])
            if best > 0 and row.get('_score'):
                score = max(score, row['_score'] / best)

            # Ignore it if it doesn't have a high enough score
            if score < MIN_RELEVANCE_SCORE:
                continue

            docs.append(self._toDoc(row, score))
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Given a filter, return the matching chunks.
        """
        if checkCollection and not self.doesCollectionExist():
            return []

        table = self._getTable()
        if table is None:
            return []

        where = self._convertFilter(docFilter)

        try:
            search = table.search()
            if where:
                search = search.where(where)
            rows = search.offset(docFilter.offset or 0).limit(self._limit(docFilter)).to_list()
        except Exception as e:
            raise Exception(self._error('get', e)) from e

        return [self._toDoc(row, 0) for row in rows]

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """
        if not self.doesCollectionExist():
            return {}

        # Chunk 0 only, not deleted, without the internal schema document
        where = "chunk = 0 AND deleted = false AND NOT (objectId = 'schema')"
        if parent is not None:
            where += f' AND path = {_quote(parent)}'

        try:
            rows = (
                self._getTable()
                .search()
                .where(where)
                .select(['path', 'objectId'])
                .offset(offset or 0)
                .limit(limit)
                .to_list()
            )
        except Exception as e:
            raise Exception(self._error('path listing', e)) from e

        paths: Dict[str, str] = {}
        for row in rows:
            paths[row.get('path') or '/'] = row.get('objectId') or ''
        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the store.

        Writing chunk 0 of an object replaces every chunk the object had, so a
        document that shrank on re-ingest does not keep stale tail chunks. The
        old chunks are dropped in the same merge that writes the new ones, so a
        failed write leaves the previous version in place. Other rows are
        upserted by id.
        """
        if not len(chunks):
            return

        # Create the table if needed
        if checkCollection and not self.createCollection(chunks):
            return

        rows: List[Dict[str, Any]] = []
        replaced: Dict[str, bool] = {}
        for chunk in chunks:
            if chunk.embedding is None:
                raise Exception('No embedding in document')
            if not chunk.metadata.chunkId:
                replaced[chunk.metadata.objectId] = True
            rows.append(self._toRow(chunk))

        table = self._getTable()
        if table is None:
            raise Exception(f'LanceDB table {self.table!r} is missing after it was created')

        try:
            with self._writeLock:
                if replaced:
                    (
                        table.merge_insert('id')
                        .when_matched_update_all()
                        .when_not_matched_insert_all()
                        .when_not_matched_by_source_delete(self._in('objectId', list(replaced), 'objectIds'))
                        .execute(rows)
                    )
                else:
                    for batch in _batches(rows):
                        table.merge_insert('id').when_matched_update_all().when_not_matched_insert_all().execute(batch)
                self._afterWrite(table)
        except Exception as e:
            raise Exception(self._error('write', e)) from e

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all chunks with a matching objectId from the store.
        """
        if not objectIds or not self.doesCollectionExist():
            return
        table = self._getTable()
        try:
            with self._writeLock:
                self._deleteWhere(table, 'objectId', list(objectIds))
                self._afterWrite(table)
        except Exception as e:
            raise Exception(self._error('delete', e)) from e

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """
        self._setDeleted(objectIds, True)

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted
        """
        self._setDeleted(objectIds, False)

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Reads the chunks one window of renderChunkSize at a time, in chunk
        order, and hands each window's text to the callback.
        """
        if not self.doesCollectionExist():
            return

        table = self._getTable()
        offset = 0
        while True:
            end = offset + self.renderChunkSize
            where = f'objectId = {_quote(objectId)} AND chunk >= {offset} AND chunk < {end}'

            try:
                rows = table.search().where(where).select(['chunk', 'text']).limit(self.renderChunkSize).to_list()
            except Exception as e:
                raise Exception(self._error('render', e)) from e

            # If we got no items back, we are done
            if not rows:
                break

            rows.sort(key=lambda row: row['chunk'])
            callback(''.join(row.get('text') or '' for row in rows))

            # If the window was not full, there is nothing after it
            if rows[-1]['chunk'] < end - 1:
                break

            offset = end
