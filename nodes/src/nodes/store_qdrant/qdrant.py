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
# Interface implementation for the Qdrant store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
import base64
import binascii
import json
import re
import secrets
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Set, Tuple
from uuid import NAMESPACE_URL, UUID, uuid5
import sys
import numpy as np
from rocketlib import debug
from qdrant_client import QdrantClient
from qdrant_client.models import (
    PointStruct,
    Filter,
    FieldCondition,
    Record,
    MatchValue,
    Range,
    SearchParams,
    TextIndexParams,
    TokenizerType,
    PayloadSchemaType,
    TextIndexType,
    ScoredPoint,
)
from qdrant_client.http import models
from qdrant_client.conversions import common_types as types

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import CONTROL_OBJECT_ID, DocumentStoreBase
from ai.common.config import Config


# The most points one objdir scroll request asks for. A collection can cap the
# size of a single request (max_query_limit), so a page is read in requests of
# this size, following next_page_offset, however large offset + limit is.
_OBJDIR_SCROLL_PAGE = 1000

"""
NOTE: https://qdrant.tech/documentation/concepts/indexing/

This ***MAY*** be a problem, but since we provide our own embeddings, probably not...
However, this may affect the full text search and the parsing of words in the payload...

Qdrant does not support all languages out of the box:

multilingual - special type of tokenizer based on charabia package. It allows proper
tokenization and lemmatization for multiple languages, including those with non-latin
alphabets and non-space delimiters. See charabia documentation for full list of supported
languages supported normalization options. In the default build configuration, qdrant does
not include support for all languages, due to the increasing size of the resulting
binary. Chinese, Japanese and Korean languages are not enabled by default, but can be
enabled by building qdrant from source with
--features multiling-chinese,multiling-japanese,multiling-korean flags.
"""

# Minimum rescaled [0, 1] similarity for a result to count as relevant; below
# this it is dropped as noise regardless of the configured retrieval score.
# A caller that sets DocFilter.minScore (the explorer tools) overrides it.
MIN_RELEVANCE_SCORE = 0.20

# Qdrant distance -> the explorer's metric vocabulary ('cosine' | 'l2' | 'ip').
_METRICS = {'Cosine': 'cosine', 'Euclid': 'l2', 'Dot': 'ip'}

# Distances where a smaller raw score means a closer point.
_DISTANCE_METRICS = ('Euclid', 'Manhattan')

# Page size of the internal scrolls that walk a filtered set.
_SCROLL_PAGE = 256

# Rows per block of the node-side exact kNN: the similarity block is
# _KNN_BLOCK x n floats, never the whole n x n matrix.
_KNN_BLOCK = 256


# The listing token in a documents cursor (see Store._rememberOrphans).
_LISTING_TOKEN = re.compile(r'[0-9a-f]{16}')


def point_id_for(objectId: str, chunkId: int) -> str:
    """
    Return the deterministic point id of a chunk: uuid5(NAMESPACE_URL, 'objectId#chunkId').

    Rows written before this id scheme carry random ids; every read by key
    falls back to a filter on objectId/chunkId for those.
    """
    return str(uuid5(NAMESPACE_URL, f'{objectId}#{int(chunkId)}'))


def _vx():
    """The explorer value types, imported on use (the driver also loads on an older ai package)."""
    from ai.common.store import vx_types

    return vx_types


def _errors():
    from ai.common.store import errors

    return errors


def _meta_of(record: Any) -> Dict[str, Any]:
    payload = getattr(record, 'payload', None) or {}
    meta = payload.get('meta') or {}
    return meta if isinstance(meta, dict) else {}


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _similarities(metric: str, X: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Similarity of each (row, col) pair under the explorer's definition (higher is closer)."""
    a = X[rows].astype(np.float64)
    b = X[cols].astype(np.float64)
    if metric == 'l2':
        return 1.0 / (1.0 + np.linalg.norm(a - b, axis=1))
    dots = np.einsum('ij,ij->i', a, b)
    if metric == 'ip':
        return dots
    norms = np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1)
    return np.divide(dots, norms, out=np.zeros_like(dots), where=norms > 0)


def _exact_knn(
    metric: str, X: np.ndarray, k: int, block: int = _KNN_BLOCK
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Exact k-nearest neighbours (self excluded) as (offsets_row, cols, sims), rows best-first.

    Computed ``block`` rows at a time, so memory grows with ``block * n``,
    not ``n * n``; ties keep the lower column first.
    """
    n = len(X)
    k = max(0, min(int(k), n - 1))
    if not k:
        return np.zeros(n + 1, dtype=np.int64), np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    Xf = np.asarray(X, dtype=np.float64)
    if metric == 'cosine':
        norms = np.linalg.norm(Xf, axis=1)
        norms[norms == 0] = 1.0
        Xf = Xf / norms[:, None]
    sq = np.sum(Xf * Xf, axis=1) if metric == 'l2' else None
    cols = np.empty((n, k), dtype=np.int64)
    sims = np.empty((n, k), dtype=np.float32)
    step = max(1, int(block))
    for start in range(0, n, step):
        stop = min(n, start + step)
        S = Xf[start:stop] @ Xf.T
        if sq is not None:
            # 1 / (1 + euclidean distance), in place
            S *= -2.0
            S += sq[start:stop, None]
            S += sq[None, :]
            np.maximum(S, 0.0, out=S)
            np.sqrt(S, out=S)
            S += 1.0
            np.reciprocal(S, out=S)
        S[np.arange(stop - start), np.arange(start, stop)] = -np.inf
        top = np.argpartition(S, n - k, axis=1)[:, n - k :]  # the k largest, unordered
        top_sims = np.take_along_axis(S, top, axis=1)
        del S
        order = np.lexsort((top, -top_sims), axis=1)
        cols[start:stop] = np.take_along_axis(top, order, axis=1)
        sims[start:stop] = np.take_along_axis(top_sims, order, axis=1)
    offsets = np.arange(0, n * k + 1, k, dtype=np.int64)
    return offsets, cols.reshape(-1), sims.reshape(-1)


class Store(DocumentStoreBase):
    # Explorer capabilities beyond the hooks this class overrides (vx_types.CAPABILITY_KEYS).
    # 'recommend_best_score': Qdrant ranks a best_score recommendation itself (recommendNative).
    VX_DRIVER_CAPABILITIES = frozenset({'documents_distinct', 'knn_native', 'search_keyword', 'recommend_best_score'})

    # How keyword search matches (dialect.keyword_match): MatchText over the content
    # text index, which matches whole words (tokens), not fragments of them.
    VX_KEYWORD_MATCH = 'token'

    # The recommendation strategies recommendNative asks Qdrant for.
    RECOMMEND_STRATEGIES = ('average_vector', 'best_score')

    # Support level reported by the explorer's dialect: the unmocked live suite
    # (nodes/test/test_store_qdrant_full.py) runs on a new and a legacy collection.
    VX_SUPPORT = 'supported'

    # Most distinct objectIds counted exactly (countDocumentsWhere, the listing's total and
    # its sweep for documents without chunk 0); above it the count is unknown (None)
    # and the listing carries the caveat 'document_count_capped'.
    COUNT_DOCUMENTS_CAP = 10000

    # Most rows read to count documents by scrolling: on a collection whose
    # meta.objectId has no keyword index (Qdrant refuses to facet on it), and to find
    # which documents of a listing's id list have chunk 0.
    FACET_SCROLL_ROWS_CAP = 200000

    # Largest sample whose neighbour graph Qdrant computes (search_matrix_offsets
    # restricted to the sample's point ids); larger samples, the explorer's
    # default of 1,000 included, are computed on the node. The server's memory
    # for that call grows faster than the sample and stays allocated (also after
    # the collection is dropped). Measured on qdrant 1.17.1: 500-point graphs
    # leave nothing measurable, also on a 12,000-point collection; 1,000-point
    # graphs left about +125 MB on a 3,000-point collection, +380 MB over twenty
    # graphs on 6,000 points and +630 MB over eight graphs on 12,000 points, and
    # a 2,000-point graph about +500 MB; a 5,000-point graph killed the server
    # on a 2 GB host.
    NATIVE_KNN_MAX = 500

    # Most (objectId, chunkId) -> point id entries remembered between getVectors and knnGraph.
    POINT_ID_MEMO_MAX = 20000

    # A listing builds its list of documents without chunk 0 once, on the page where
    # the chunk-0 rows run out; its later pages reuse it for this many seconds (the
    # explorer's counts_cached_s). An expired or unknown list is rebuilt.
    ORPHAN_LIST_TTL_S = 60

    # Listings whose list of documents without chunk 0 is remembered at once.
    ORPHAN_LISTS_MAX = 8

    apikey: str | None = None
    node: str = 'qdrant'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    threshold_search: float = 0.0
    client: QdrantClient | None = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the qdrant vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        self.host = (config.get('host', '') or '').strip().rstrip('/')
        self.port = config.get('port')

        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.payload_limit = config.get('payloadLimit', self.payload_limit)
        self.threshold_search = config.get('score', 0.5)

        similarity = config.get('similarity', 'Cosine')
        if similarity in ['Cosine', 'Euclid', 'Dot', 'Manhattan']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required qdrant configurations')

        # If the host already includes a scheme, use it as-is.
        # Otherwise, infer from the profile: cloud -> https://, local -> http://.
        if '://' in self.host:
            url = f'{self.host}:{self.port}'
        else:
            profile = (connConfig.get('profile', '') or '').lower()
            scheme = 'https' if profile == 'cloud' else 'http'
            url = f'{scheme}://{self.host}:{self.port}'

        self.client = QdrantClient(url=url, api_key=self.apikey, prefer_grpc=False, timeout=60)
        return

    def __del__(self):
        """
        Deinitializes the qdrant client.
        """
        # Deinit everything we did
        self.apikey = None
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'Cosine'
        self.client = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        return self.client.collection_exists(collection_name=self.collection)

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection, doesn't return anything.

        It must create a new collection even if one already exists.
        The reason for this is that there are actually three parts to
        an the collection:
            1. The collection itself
            2. The payload schema
            3. A bogus record containing the model/vector size
        If the creation fails somewhere along the way, the base Store class
        will recognize that the collection does not exists (intact anyway)
        and call this function to start setting it up again
        """
        # Build the parameters
        vector_params = types.VectorParams(size=vectorSize, distance=self.similarity)

        # Create the collection
        self.client.create_collection(collection_name=self.collection, vectors_config=vector_params)

        # See if we can get the collection info, throws if it does not exist or other error
        info = self.client.get_collection(collection_name=self.collection)

        # Ensure every payload key we filter/order by has an index. Qdrant under
        # strict mode (Qdrant Cloud sets strict_mode_config.enabled with
        # unindexed_filtering_retrieve=false) rejects filtering on an unindexed
        # key with a 400. We check per-key rather than all-or-nothing so an
        # already-built but under-indexed collection backfills missing indexes
        # on the next connect; create_payload_index is idempotent.
        # NOTE: meta.chunkId / meta.tableId are integer keys that getPaths() and
        # _convertFilter filter on; omitting them previously caused that 400.
        existing = set(info.payload_schema or {})

        keyword_keys = ('meta.nodeId', 'meta.objectId', 'meta.parent')
        integer_keys = ('meta.permissionId', 'meta.chunkId', 'meta.tableId')
        bool_keys = ('meta.isDeleted', 'meta.isTable')

        for field in keyword_keys:
            if field not in existing:
                self.client.create_payload_index(
                    collection_name=self.collection, field_name=field, field_schema=PayloadSchemaType.KEYWORD
                )

        for field in integer_keys:
            if field not in existing:
                self.client.create_payload_index(
                    collection_name=self.collection, field_name=field, field_schema=PayloadSchemaType.INTEGER
                )

        for field in bool_keys:
            if field not in existing:
                self.client.create_payload_index(
                    collection_name=self.collection, field_name=field, field_schema=PayloadSchemaType.BOOL
                )

        # Setup a full text keyword search on our content
        if 'content' not in existing:
            self.client.create_payload_index(
                collection_name=self.collection,
                field_name='content',
                field_schema=TextIndexParams(
                    type=TextIndexType.TEXT,
                    tokenizer=TokenizerType.WORD,
                    min_token_len=2,
                    max_token_len=15,
                    lowercase=True,
                ),
            )

        return True

    @staticmethod
    def _deletedConditions(deleted: str) -> Tuple[List[Any], List[Any]]:
        """
        Return (must, must_not) conditions selecting the 'active', 'deleted' or 'all' rows.

        'active' excludes only rows explicitly marked deleted: a null or absent
        isDeleted (the client strips None via exclude_none) counts as not deleted.
        """
        flag = FieldCondition(key='meta.isDeleted', match=MatchValue(value=True))
        if deleted == 'deleted':
            return [flag], []
        if deleted == 'all':
            return [], []
        return [], [flag]

    @staticmethod
    def _notControl() -> FieldCondition:
        """Condition matching the control record (used under must_not)."""
        return FieldCondition(key='meta.objectId', match=MatchValue(value=CONTROL_OBJECT_ID))

    def _convertFilter(self, docFilter: DocFilter) -> Filter:
        """
        Build the generic filter based on required permissions, node, parent, etc.

        The deleted rows follow ``resolveDeleted``: ``docFilter.deleted`` when set,
        otherwise isDeleted None/False selects the active rows and True all rows.
        """
        # Declare the mist list to start addding conditions
        must: List[models.Condition] = []

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            must.append(models.FieldCondition(key='meta.nodeId', match=models.MatchValue(value=docFilter.nodeId)))

        if docFilter.isTable is not None:
            must.append(models.FieldCondition(key='meta.isTable', match=models.MatchValue(value=docFilter.isTable)))

        if docFilter.tableIds is not None:
            must.append(models.FieldCondition(key='meta.tableId', match=models.MatchAny(any=docFilter.tableIds)))

        # If a parent was specified: the exact path (meta.parent has a keyword index)
        if docFilter.parent is not None:
            must.append(models.FieldCondition(key='meta.parent', match=models.MatchValue(value=docFilter.parent)))

        # If a permissionId list was specified
        if docFilter.permissions is not None:
            must.append(
                models.FieldCondition(key='meta.permissionId', match=models.MatchAny(any=docFilter.permissions))
            )

        # If a objectIds list was specified
        if docFilter.objectIds is not None:
            must.append(models.FieldCondition(key='meta.objectId', match=models.MatchAny(any=docFilter.objectIds)))

        # Which rows by their deleted flag
        deleted_must, deleted_must_not = self._deletedConditions(self.resolveDeleted(docFilter))
        must.extend(deleted_must)

        # If we are not going after chunks, add a condition
        if docFilter.chunkIds is not None:
            must.append(models.FieldCondition(key='meta.chunkId', match=models.MatchAny(any=docFilter.chunkIds)))

        # If we are min chunk id, add a condition
        if docFilter.minChunkId is not None:
            must.append(models.FieldCondition(key='meta.chunkId', range=models.Range(gte=docFilter.minChunkId)))

        # If we are min chunk id, add a condition
        if docFilter.maxChunkId is not None:
            must.append(models.FieldCondition(key='meta.chunkId', range=models.Range(lte=docFilter.maxChunkId)))

        # Determine the basic must conditions
        return Filter(must=must, must_not=deleted_must_not or None)

    def _rawToScore(self, raw: float) -> float:
        """Map Qdrant's raw score to a score where higher means closer ([0, 1] for unit vectors)."""
        if self.similarity in _DISTANCE_METRICS:
            # Euclid/Manhattan answer a distance: smaller is closer.
            return float(1.0 / (1.0 + max(float(raw), 0.0)))
        # Cosine and Dot answer a similarity in [-1, 1] for unit vectors.
        return (float(raw) + 1.0) / 2.0

    def _convertToDocs(self, points: List[ScoredPoint] | List[Record], floor: float = MIN_RELEVANCE_SCORE) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Groups all document chunks  together. Scored points below ``floor`` are dropped.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # If we don't have a payload, skip it
            if point.payload is None:
                continue

            # Get the payload content and meadata
            metadata = DocMetadata(**point.payload['meta'])
            content = point.payload['content']

            # Determine the score of this document
            if isinstance(point, ScoredPoint):
                # If we are return scaled scores, build it
                score = self._rawToScore(point.score)

                # Ignore it if it doesn't have a high enough score
                if score < floor:
                    continue
            else:
                score = 0

            # Create asearc new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def count_documents(self) -> int:
        """
        Return the number of vectors in the document store, not the number of documents themselves.

        Returns how many documents are present in the document store.
        """
        # If the collection does not exists, by definition there are
        # no documents in the collection
        if not self.doesCollectionExist():
            return 0

        # Get the collection info
        info: types.CollectionInfo = self.client.get_collection(collection_name=self.collection)

        # vectors_count was renamed to points_count in newer qdrant-client versions
        return getattr(info, 'points_count', None) or getattr(info, 'vectors_count', 0)

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter = self._convertFilter(docFilter)

        # Add a condition for the keyword
        if filter.must is None:
            filter.must = []

        filter.must.append(models.FieldCondition(key='content', match=models.MatchText(text=query.text)))

        # Perform the search (a numeric offset skips rows; Qdrant's own offset is a point id)
        records = self._scrollWindow(filter, docFilter.offset, docFilter.limit)

        # Convert the points into groups
        docs = self._convertToDocs(records)

        # Return them
        return docs

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter = self._convertFilter(docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise ValueError('Non-zero offset is not supported in semantic searching')

        # Don't pass score_threshold: Qdrant compares it against the raw similarity
        # score, but threshold_search is in the rescaled [0,1] space. The cut is
        # applied post-rescale by the base store (_addDoc).
        points = self.client.query_points(
            collection_name=self.collection,
            query=query.embedding,
            query_filter=filter,
            with_vectors=False,
            with_payload=True,
            limit=docFilter.limit if docFilter.limit is not None else 25,
            search_params=SearchParams(exact=True),
        ).points

        # Convert the points into groups, applying the score floor (DocFilter.minScore or the legacy floor)
        docs = self._convertToDocs(points, self.effectiveFloor(docFilter))

        # Return them
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Given a filter, this will return the document groups matching the filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # Build up the filter
        filter = self._convertFilter(docFilter=docFilter)

        # Perform the search (a numeric offset skips rows; Qdrant's own offset is a point id)
        records = self._scrollWindow(filter, docFilter.offset, docFilter.limit)

        # Convert the points into documents
        docs = self._convertToDocs(records)
        return docs

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Chunk 0 of the active documents (rows without an isDeleted flag count as
        # active), never the internal schema document
        conditions: List[models.Condition] = [FieldCondition(key='meta.chunkId', match=models.MatchValue(value=0))]

        # If parent specified, match the exact path (a text match would also take a token of it)
        if parent is not None:
            conditions.append(FieldCondition(key='meta.parent', match=models.MatchValue(value=parent)))

        filter = self._documentsFilter('active', None, *conditions)

        # Build up the path list
        paths: Dict[str, str] = {}

        # Scroll's offset is a point-ID cursor, not a count, and this driver
        # writes random UUID point IDs, so an integer offset would never move
        # the start. Read the first offset + limit records instead (scroll
        # orders by point ID, so the order is stable), in requests of at most
        # _OBJDIR_SCROLL_PAGE points that follow next_page_offset, and keep the
        # requested page, as the Pinecone driver does. A page costs offset +
        # limit records, and no single request exceeds the server's cap.
        wanted = offset + limit
        records: List[Any] = []
        cursor = None
        while len(records) < wanted:
            batch, cursor = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=filter,
                limit=min(_OBJDIR_SCROLL_PAGE, wanted - len(records)),
                offset=cursor,
                with_vectors=False,
                with_payload=True,
            )
            records.extend(batch)
            if cursor is None or not batch:
                break

        # Fill it in
        for record in records[offset:wanted]:
            # Get the payload
            payload = record.payload
            if payload is None:
                continue

            # Get the info — payload['meta'] is a plain dict from Qdrant, not a DocMetadata
            metadata = payload.get('meta', {})

            # Get the parent and objectId
            parent = metadata.get('parent', '/')
            object_id = metadata.get('objectId', '')

            # Add it
            paths[parent] = object_id

        # And return what we found
        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.
        """
        # If no documents present, get out
        if not len(chunks):
            return

        # Create the collection if needed
        if checkCollection and not self.createCollection(chunks):
            return

        # Clear the points
        points: List[models.PointStruct] = []

        # Clear the object id list
        objectIds: Dict = {}

        def flush():
            nonlocal points
            nonlocal objectIds
            ops = []

            # Build the batch operation for deletion
            if len(objectIds):
                ops.append(
                    models.DeleteOperation(
                        delete=models.FilterSelector(
                            filter=Filter(
                                must=[
                                    FieldCondition(
                                        key='meta.objectId', match=models.MatchAny(any=list(objectIds.keys()))
                                    )
                                ]
                            )
                        )
                    )
                )

            # Build the batch operation for insert
            if len(points):
                ops.append(models.UpsertOperation(upsert=models.PointsList(points=points)))

            # If we have nothing to do, done
            if not len(ops):
                return

            # Perform the batch
            self.client.batch_update_points(collection_name=self.collection, update_operations=ops)

            # Clear them
            objectIds = {}
            points = []

        # For each document
        for chunk in chunks:
            # If we are writing chunk 0, then delete the object
            if not chunk.metadata.chunkId:
                # Save this object id to be deleted
                objectIds[chunk.metadata.objectId] = True

        sum_size = 0
        cur_size = 0
        # For each document
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # Append the points; the id is derived from (objectId, chunkId) so a key maps to one point
            tmp_struct = PointStruct(
                id=point_id_for(chunk.metadata.objectId, chunk.metadata.chunkId),
                vector=embedding,
                payload={'content': chunk.page_content, 'meta': chunk.metadata},
            )
            cur_size = sys.getsizeof(tmp_struct)
            sum_size += cur_size
            points.append(tmp_struct)

            if (len(points) >= 500) or (sum_size + cur_size > self.payload_limit):
                flush()
                cur_size = 0
                sum_size = 0

        # Flush any stragglers
        flush()

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self.doesCollectionExist():
            return

        # Build a filter for an object id
        filter_objectId = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=objectIds))])

        # Delete the points with the given object Id
        self.client.delete(collection_name=self.collection, points_selector=filter_objectId, wait=True)
        return

    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.
        Returns the chunks moved to the trash, counted before the update (None when the
        count fails to answer).
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return 0

        # The chunks this call moves: the ones not in the trash yet
        moving = self.vxChunksInState(objectIds, deleted=False)

        # Build a filter for an object id
        filter_objectId = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=objectIds))])

        # Set meta.isDeleted to true. key='meta' merges into the nested object: a
        # top-level {'meta': {...}} would replace meta whole and drop the rest of it.
        self.client.set_payload(
            collection_name=self.collection, payload={'isDeleted': True}, key='meta', points=filter_objectId
        )
        return moving

    def markActive(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted.
        Returns the chunks taken out of the trash, counted before the update.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return 0

        # The chunks this call moves: the ones in the trash
        moving = self.vxChunksInState(objectIds, deleted=True)

        # Build a filter for an object id
        filter_objectId = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=objectIds))])

        # Set meta.isDeleted to false inside meta (see markDeleted)
        self.client.set_payload(
            collection_name=self.collection, payload={'isDeleted': False}, key='meta', points=filter_objectId
        )
        return moving

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self.doesCollectionExist():
            return

        # Since chunks are returned in any order, and a single objectId
        # may contain tens of thousands of chunks, we grave them one
        # group at a time (renderChunkSize), put them into an array,
        # join them and call the callback
        offset = 0
        while True:
            # Build  filter for getting a set of chunks
            filter_range = FieldCondition(key='meta.chunkId', range=Range(gte=offset, lt=offset + self.renderChunkSize))

            # Build a filter for an object id
            filter_objectId = FieldCondition(key='meta.objectId', match=MatchValue(value=objectId))

            # Perform the query
            records, nextPoint = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=Filter(must=[filter_objectId, filter_range]),
                limit=self.renderChunkSize,
                with_payload=True,
            )

            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            text: List[str] = [''] * self.renderChunkSize
            lastIndex = -1

            # Now, add the documents to the results
            for record in records:
                # Get the payload
                payload = record.payload
                if payload is None:
                    continue

                # Get the info
                metadata = DocMetadata(**payload['meta'])
                content = payload['content']
                chunk = metadata.chunkId

                # Should never happen since we gave it an offset
                if chunk < offset:
                    continue

                # Should never happen since we gave it a range
                if chunk >= offset + self.renderChunkSize:
                    continue

                # Get the index into the array
                index = chunk - offset

                # Add it to our array
                text[index] = content

                # Determine the highest index we use
                if index > lastIndex:
                    lastIndex = index

            # Compute the number of items we are going to process
            numberOfItems = lastIndex + 1

            # If we got no items back, we are done
            if numberOfItems < 1:
                break

            # Join it together
            fullText = ''.join(text[0:numberOfItems])

            # Call the output function
            callback(fullText)

            # If we got less than we asked for, must be done
            if numberOfItems < self.renderChunkSize:
                break

            offset += self.renderChunkSize

    # ------------------------------------------------------------------
    # Scrolling helpers
    # ------------------------------------------------------------------

    def _scrollAll(
        self,
        flt: Optional[Filter],
        *,
        with_payload: Any = True,
        with_vectors: bool = False,
        page: int = _SCROLL_PAGE,
    ) -> Iterator[Any]:
        """Yield every point matching ``flt``, following Qdrant's next-page point id."""
        offset = None
        while True:
            records, offset = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=flt,
                limit=page,
                offset=offset,
                with_payload=with_payload,
                with_vectors=with_vectors,
            )
            yield from records
            if offset is None or not records:
                return

    def _scrollWindow(self, flt: Optional[Filter], offset: Any, limit: Optional[int]) -> List[Any]:
        """
        Return ``limit`` points matching ``flt`` after skipping ``offset`` of them.

        Qdrant's own scroll ``offset`` is a point id, not a position; a numeric
        offset is honoured here by walking the matching points in id order.
        """
        skip = int(offset or 0)
        if skip < 0:
            raise ValueError('offset must not be negative')
        limit = 10 if limit is None else int(limit)
        if limit <= 0:
            return []
        if not skip:
            records, _ = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=flt,
                limit=limit,
                with_payload=True,
                with_vectors=False,
            )
            return list(records)
        window: List[Any] = []
        for index, record in enumerate(self._scrollAll(flt)):
            if index < skip:
                continue
            window.append(record)
            if len(window) >= limit:
                break
        return window

    def _exists(self) -> bool:
        """Whether the collection exists (no control-record read)."""
        return bool(self.collection) and self._doesCollectionExist()

    def _rememberPointIds(self, records: Sequence[Any]) -> None:
        memo: Dict[Tuple[str, int], Any] = self.__dict__.setdefault('_vxPointIds', {})
        if len(memo) > self.POINT_ID_MEMO_MAX:
            memo.clear()
        for record in records:
            meta = _meta_of(record)
            chunk = _int_or_none(meta.get('chunkId'))
            if meta.get('objectId') is not None and chunk is not None:
                memo[(str(meta['objectId']), chunk)] = record.id

    def _recordToDoc(self, record: Any, *, with_vector: bool = False) -> Doc:
        """A Doc from a stored point, with ``metadata.pointId`` (and the vector when asked)."""
        payload = record.payload or {}
        meta = {k: v for k, v in _meta_of(record).items() if v is not None}
        metadata = DocMetadata(**{**meta, 'pointId': str(record.id)})
        doc = Doc(score=0, page_content=payload.get('content', ''), metadata=metadata)
        if with_vector and record.vector is not None:
            vector = record.vector
            if isinstance(vector, dict):  # named vectors: this driver writes the default (unnamed) one
                vector = next(iter(vector.values()), None)
            doc.embedding = [float(v) for v in (vector or [])]
        return doc

    def _documentsFilter(self, deleted: str, object_ids: Optional[Sequence[str]], *extra: Any) -> Filter:
        """Rows of real documents (never the control record) in the given deleted state."""
        must, must_not = self._deletedConditions(deleted)
        must = list(must) + list(extra)
        if object_ids is not None:
            must.append(FieldCondition(key='meta.objectId', match=models.MatchAny(any=list(object_ids))))
        return Filter(must=must, must_not=list(must_not) + [self._notControl()])

    def _canFacetObjectIds(self) -> bool:
        """Whether meta.objectId has the keyword index Qdrant needs to facet on it (remembered once true)."""
        if self.__dict__.get('_vxFacetable') == self.collection:
            return True
        schema = getattr(self.client.get_collection(collection_name=self.collection), 'payload_schema', None) or {}
        entry = schema.get('meta.objectId')
        kind = getattr(entry, 'data_type', entry)
        if str(getattr(kind, 'value', kind) or '').lower() != 'keyword':
            return False
        self.__dict__['_vxFacetable'] = self.collection
        return True

    def _documentCounts(self, flt: Filter, limit: int) -> Tuple[List[Tuple[str, int]], bool]:
        """
        Rows per distinct objectId matching ``flt``, highest counts first, and whether the list is capped.

        At most ``limit`` objectIds; ``capped`` is True when more exist. An exact
        facet answers it; a collection without a keyword index on meta.objectId
        (created outside this driver) is counted by scrolling the matching rows
        instead, at most ``FACET_SCROLL_ROWS_CAP`` of them.
        """
        limit = max(1, int(limit))
        if self._canFacetObjectIds():
            hits = self.client.facet(
                collection_name=self.collection, key='meta.objectId', facet_filter=flt, limit=limit + 1, exact=True
            ).hits
            counts = [(str(h.value), int(h.count)) for h in hits if int(h.count) > 0]
            return counts[:limit], len(counts) > limit
        return self._documentCountsByScroll(flt, limit)

    def _documentCountsByScroll(self, flt: Filter, limit: int) -> Tuple[List[Tuple[str, int]], bool]:
        """
        Rows per distinct objectId matching ``flt``, read by scrolling the rows (at most ``FACET_SCROLL_ROWS_CAP``).

        Same answer as ``_documentCounts``; ``capped`` is also True when the row cap stopped the read.
        """
        limit = max(1, int(limit))
        tally: Dict[str, int] = {}
        capped = False
        for read, record in enumerate(self._scrollAll(flt, with_payload=['meta.objectId'], page=1024)):
            if read >= self.FACET_SCROLL_ROWS_CAP:
                capped = True
                break
            oid = _meta_of(record).get('objectId')
            if oid is not None:
                tally[str(oid)] = tally.get(str(oid), 0) + 1
        counts = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))
        return counts[:limit], capped or len(counts) > limit

    # ------------------------------------------------------------------
    # Explorer hooks (docs/development/nodes/vector-tool-contract.md, section 2)
    # ------------------------------------------------------------------

    @staticmethod
    def _metricName(similarity: Any) -> Optional[str]:
        return _METRICS.get(str(getattr(similarity, 'value', similarity)))

    def scoreInfo(self) -> Dict[str, Any]:
        """How ``Doc.score`` is derived from Qdrant's raw score for this collection's distance."""
        if self.similarity == 'Cosine':
            formula, value_range = '(1 + cosine_similarity) / 2', [0, 1]
        elif self.similarity in _DISTANCE_METRICS:
            formula, value_range = '1 / (1 + distance)', [0, 1]
        else:
            # [0, 1] only for unit-length vectors; a dot product is otherwise unbounded.
            formula, value_range = '(1 + dot) / 2', None
        return {
            'formula': formula,
            'range': value_range,
            'higher_is_better': True,
            'floor': MIN_RELEVANCE_SCORE,
            'threshold': self.threshold_search,
        }

    def describe(self):
        """Backend, collection, metric, dimension, model, index; never a host, port or key."""
        vx = _vx()
        caveats = ['brute_force_search']
        try:
            version = getattr(self.client.info(), 'version', None)
        except Exception:
            version = None
        metric = self._metricName(self.similarity)
        if not self._exists():
            return vx.StoreInfo(
                backend='qdrant',
                backend_version=version,
                collection=self.collection or None,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=metric,
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )

        info = self.client.get_collection(collection_name=self.collection)
        config = getattr(info, 'config', None)
        vectors = getattr(getattr(config, 'params', None), 'vectors', None)
        if isinstance(vectors, dict):  # named vectors: describe the first
            vectors = next(iter(vectors.values()), None)
        hnsw = getattr(config, 'hnsw_config', None)
        try:
            control = self.doesCollectionExist()
        except Exception:
            control = False
        if self.similarity in _DISTANCE_METRICS:
            caveats.append('score_scale_inverted_fixed')
        dimension = _int_or_none(getattr(vectors, 'size', None)) or (self.vectorSize or None)
        index = None
        if hnsw is not None:
            # The explorer's parameter names (Qdrant calls ef_construction 'ef_construct').
            index = {'type': 'hnsw', 'params': {'m': hnsw.m, 'ef_construction': hnsw.ef_construct}}
        return vx.StoreInfo(
            backend='qdrant',
            backend_version=version,
            collection=self.collection,
            collection_exists=True,
            control_record=bool(control),
            meta_column=None,
            metric=self._metricName(getattr(vectors, 'distance', None)) or metric,
            dimension=dimension,
            model=(self.modelName or None) if control else None,
            index=index,
            size_bytes=None,
            caveats=caveats,
        )

    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """Exact count of the chunk rows matching ``docFilter`` (control record excluded)."""
        if not self._exists():
            return 0
        flt = self._convertFilter(docFilter)
        flt.must_not = list(flt.must_not or []) + [self._notControl()]
        return int(self.client.count(collection_name=self.collection, count_filter=flt, exact=True).count)

    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        """
        Distinct objectIds matching ``docFilter``, counted by an exact facet.

        Includes documents whose first chunk is missing. None above
        ``COUNT_DOCUMENTS_CAP`` distinct ids (the tools then count first chunks).
        """
        if not self._exists():
            return 0
        flt = self._convertFilter(docFilter)
        flt.must_not = list(flt.must_not or []) + [self._notControl()]
        counts, capped = self._documentCounts(flt, self.COUNT_DOCUMENTS_CAP)
        return None if capped else len(counts)

    @staticmethod
    def _encodeCursor(state: Dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(state, separators=(',', ':')).encode()).decode()

    @staticmethod
    def _isPointId(value: Any) -> bool:
        """An id Qdrant accepts as a scroll offset: an unsigned integer or a hyphenated UUID."""
        if isinstance(value, bool):
            return False
        if isinstance(value, int):
            return value >= 0
        if not isinstance(value, str) or len(value) != 36:
            return False
        try:
            UUID(value)
        except ValueError:
            return False
        return True

    @staticmethod
    def _decodeCursor(cursor: Optional[str]) -> Dict[str, Any]:
        """
        The listing state in an opaque cursor; a cursor this driver did not issue is refused.

        {'ph': 'c', 'p': next point id} pages the chunk-0 rows, {'ph': 'o', 'i': n}
        the documents without chunk 0; 't' (total or None) and 'x' (capped)
        carry the first page's count so later pages do not recount, and 'k'
        names the listing's remembered list of documents without chunk 0.
        """
        if cursor is None:
            return {'ph': 'c', 'p': None}
        try:
            state = json.loads(base64.urlsafe_b64decode(str(cursor).encode()).decode())
        except (binascii.Error, UnicodeDecodeError, ValueError):
            state = None

        def count(value: Any) -> bool:
            return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)

        valid = (
            isinstance(state, dict)
            and (
                (state.get('ph') == 'c' and Store._isPointId(state.get('p')))
                or (
                    state.get('ph') == 'o'
                    and isinstance(state.get('i'), int)
                    and not isinstance(state.get('i'), bool)
                    and state['i'] >= 0
                )
            )
            and count(state.get('t'))
            and isinstance(state.get('x', False), bool)
            and (state.get('k') is None or (isinstance(state.get('k'), str) and _LISTING_TOKEN.fullmatch(state['k'])))
        )
        if not valid:
            raise _errors().ToolRefusal(
                'INVALID_INPUT', 'The documents cursor is not valid; start from the first page.'
            )
        return state

    def _documentRow(self, record: Any, chunks: Optional[int], tables: Optional[int], has_first: bool):
        meta = _meta_of(record)
        ingested = meta.get('ingestedAt')
        return _vx().DocumentRow(
            objectId=str(meta.get('objectId', '')),
            path=str(meta.get('parent') or ''),
            chunks=chunks,
            has_first_chunk=has_first,
            deleted=meta.get('isDeleted') is True,
            tables=tables,
            nodeId=meta.get('nodeId'),
            size=_int_or_none(meta.get('size')),
            modifyTime=_int_or_none(meta.get('modifyTime')),
            ingestedAt=ingested if isinstance(ingested, str) else None,
            pointId=str(record.id),
        )

    def _firstRow(self, objectId: str, deleted: str) -> Optional[Any]:
        """The lowest-chunk row of a document (its display row when chunk 0 is missing)."""
        flt = self._documentsFilter(deleted, [objectId])
        try:
            records, _ = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=flt,
                order_by=models.OrderBy(key='meta.chunkId'),
                limit=1,
                with_payload=True,
                with_vectors=False,
            )
            return records[0] if records else None
        except Exception:
            # No range index on meta.chunkId (collection not created by this driver): read them all.
            rows = list(self._scrollAll(flt))
            return min(rows, key=lambda r: _int_or_none(_meta_of(r).get('chunkId')) or 0) if rows else None

    def _orphans(
        self, deleted: str, object_ids: Optional[Sequence[str]], every: Tuple[List[Tuple[str, int]], bool]
    ) -> Tuple[List[Tuple[str, int]], bool]:
        """
        Documents without a chunk-0 row: ([(objectId, rows)] sorted by id, capped?).

        ``every`` is (rows per document, capped) over all the documents; the
        documents that do have chunk 0 come from a second count over the
        chunk-0 rows. When ``every`` is capped that count is restricted to the
        ids it holds, so a capped sweep may miss a document but never lists
        one that has chunk 0. Over an id list (capped, or the caller's scope)
        the chunk-0 rows are read rather than faceted: Qdrant's exact facet
        slows down much faster than its MatchAny list grows (qdrant 1.17.1: 500
        ids 0.05 s, 2,000 ids 0.65 s, the 10,000 ids of a capped listing 17-35
        s), while reading those 10,000 rows takes about 0.1 s. If not every
        chunk-0 row could be read, no document is listed as without one.
        """
        counts, capped = every
        if not counts:
            return [], capped
        first = FieldCondition(key='meta.chunkId', match=MatchValue(value=0))
        scope = [oid for oid, _ in counts] if capped else object_ids
        flt = self._documentsFilter(deleted, scope, first)
        if scope is None:
            found, partial = self._documentCounts(flt, len(counts))
        else:
            found, partial = self._documentCountsByScroll(flt, self.FACET_SCROLL_ROWS_CAP)
        if partial:
            return [], True
        with_first = {oid for oid, _ in found}
        return sorted((oid, n) for oid, n in counts if oid not in with_first), capped

    _orphan_lists_lock = threading.Lock()

    def _orphanLists(self) -> 'OrderedDict[str, Tuple[float, Any, List[Tuple[str, int]], bool]]':
        lists = self.__dict__.get('_orphan_lists')
        if lists is None:
            lists = self.__dict__['_orphan_lists'] = OrderedDict()
        return lists

    def _recallOrphans(self, token: Optional[str], scope: Any) -> Optional[Tuple[List[Tuple[str, int]], bool]]:
        """The list a listing remembered under ``token`` for ``scope``, unless unknown or expired."""
        if not token:
            return None
        with self._orphan_lists_lock:
            entry = self._orphanLists().get(token)
        if entry is None:
            return None
        stored_at, stored_scope, orphans, capped = entry
        if stored_scope != scope or time.monotonic() - stored_at > self.ORPHAN_LIST_TTL_S:
            return None
        return orphans, capped

    def _rememberOrphans(self, scope: Any, orphans: List[Tuple[str, int]], capped: bool) -> str:
        """Remember a listing's documents without chunk 0 for its later pages; the token goes in the cursor."""
        token = secrets.token_hex(8)
        with self._orphan_lists_lock:
            lists = self._orphanLists()
            lists[token] = (time.monotonic(), scope, orphans, capped)
            while len(lists) > max(1, int(self.ORPHAN_LISTS_MAX)):
                lists.popitem(last=False)
        return token

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort):
        """
        One page of documents: chunk-0 rows in storage order, then documents without chunk 0.

        The first page counts every document once (an exact facet, at most
        ``COUNT_DOCUMENTS_CAP``; beyond that total is None and the caveat
        ``document_count_capped``) and later pages carry that total in the
        cursor. Chunk and table counts come from facets over the page's
        objectIds. Documents without a first chunk are every document minus
        those with a chunk-0 row: that list is built on the page where the
        chunk-0 rows run out and reused by the listing's later pages for
        ``ORPHAN_LIST_TTL_S`` (a page whose list has expired, or that reaches
        another instance, rebuilds it). Rows are not sorted by path
        (``sorted=False``); each objectId is listed once.
        """
        vx = _vx()
        limit = max(1, int(limit))
        state = self._decodeCursor(cursor)
        caveats = ['documents_unsorted']
        if not self._exists():
            return vx.DocPage(
                items=[], next_cursor=None, total=0, counts_exact=True, distinct=True, sorted=False, caveats=caveats
            )

        ids = None if object_ids is None else [str(o) for o in object_ids if str(o) != CONTROL_OBJECT_ID]
        memo: Dict[str, Tuple[List[Tuple[str, int]], bool]] = {}

        def every() -> Tuple[List[Tuple[str, int]], bool]:
            if 'every' not in memo:
                memo['every'] = self._documentCounts(self._documentsFilter(deleted, ids), self.COUNT_DOCUMENTS_CAP)
            return memo['every']

        if cursor is None:
            counted, capped = every()
            total: Optional[int] = None if capped else len(counted)
        else:
            total, capped = state.get('t'), bool(state.get('x', False))

        def page(items: List[Any], next_state: Optional[Dict[str, Any]]):
            if capped and 'document_count_capped' not in caveats:
                caveats.append('document_count_capped')
            next_cursor = None if next_state is None else self._encodeCursor({**next_state, 't': total, 'x': capped})
            return vx.DocPage(
                items=items,
                next_cursor=next_cursor,
                total=total,
                counts_exact=True,
                distinct=True,
                sorted=False,
                caveats=caveats,
            )

        items = []
        if state['ph'] == 'c':
            first = FieldCondition(key='meta.chunkId', match=MatchValue(value=0))
            records, next_point = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=self._documentsFilter(deleted, ids, first),
                limit=limit,
                offset=state['p'],
                with_payload=True,
                with_vectors=False,
            )
            seen: Set[str] = set()
            unique = []
            for record in records:
                oid = str(_meta_of(record).get('objectId', ''))
                if oid and oid not in seen:
                    seen.add(oid)
                    unique.append(record)
            page_ids = list(seen)
            counts: Dict[str, int] = {}
            tables: Dict[str, int] = {}
            if page_ids:
                counts = dict(self._documentCounts(self._documentsFilter(deleted, page_ids), len(page_ids))[0])
                is_table = FieldCondition(key='meta.isTable', match=MatchValue(value=True))
                tables = dict(
                    self._documentCounts(self._documentsFilter(deleted, page_ids, is_table), len(page_ids))[0]
                )
            for record in unique:
                oid = str(_meta_of(record).get('objectId'))
                items.append(self._documentRow(record, counts.get(oid), tables.get(oid, 0), True))
            if next_point is not None:
                return page(items, {'ph': 'c', 'p': next_point})
            state = {'ph': 'o', 'i': 0}

        # The chunk-0 rows are exhausted: fill the page with documents that have no chunk 0.
        scope = (deleted, None if ids is None else tuple(sorted(ids)))
        token = state.get('k')
        remembered = self._recallOrphans(token, scope)
        if remembered is None:
            orphans, swept_capped = self._orphans(deleted, ids, every())
            token = None
        else:
            orphans, swept_capped = remembered
        capped = capped or swept_capped
        start = state['i']
        room = max(0, limit - len(items))
        for oid, rows in orphans[start : start + room]:
            record = self._firstRow(oid, deleted)
            if record is not None:
                items.append(self._documentRow(record, rows, None, False))
        if start + room >= len(orphans):
            return page(items, None)
        if token is None:
            token = self._rememberOrphans(scope, orphans, swept_capped)
        return page(items, {'ph': 'o', 'i': start + room, 'k': token})

    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str):
        """The chunks of one document after ``after_chunk``, in chunk order, without vectors."""
        vx = _vx()
        after_chunk = int(after_chunk)
        limit = max(1, int(limit))
        if objectId == CONTROL_OBJECT_ID or not self._exists():
            return vx.ChunkPage(docs=[], has_more=False, next_after=after_chunk)
        after = FieldCondition(key='meta.chunkId', range=Range(gt=after_chunk))
        flt = self._documentsFilter(deleted, [objectId], after)
        try:
            records, _ = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=flt,
                order_by=models.OrderBy(key='meta.chunkId'),
                limit=limit + 1,
                with_payload=True,
                with_vectors=False,
            )
        except Exception:
            # No range index on meta.chunkId (collection not created by this driver): sort here.
            records = sorted(self._scrollAll(flt), key=lambda r: _int_or_none(_meta_of(r).get('chunkId')) or 0)
            records = records[: limit + 1]
        self._rememberPointIds(records)
        docs = [self._recordToDoc(r) for r in records[:limit]]
        next_after = docs[-1].metadata.chunkId if docs else after_chunk
        return vx.ChunkPage(docs=docs, has_more=len(records) > limit, next_after=next_after)

    def sampleChunks(self, *, n, seed, strategy, docFilter, include_keys):
        """
        Up to ``n`` chunks with vectors: 'random' (Qdrant's random sample) or 'first' (storage order).

        Qdrant's random sample takes no seed. 'stratified' is not native here
        (StoreUnsupported), so the shared sampler builds it from getVectors.
        """
        if strategy == 'stratified':
            raise _errors().StoreUnsupported('sampleChunks(strategy="stratified") is not native on Qdrant')
        if strategy not in ('random', 'first'):
            raise ValueError(f'unknown sampling strategy {strategy!r}')
        n = max(0, int(n))
        if not n or not self._exists():
            return [], strategy
        flt = self._convertFilter(docFilter)
        flt.must_not = list(flt.must_not or []) + [self._notControl()]
        if strategy == 'random':
            records = self.client.query_points(
                collection_name=self.collection,
                query=models.SampleQuery(sample=models.Sample.RANDOM),
                query_filter=flt,
                limit=n,
                with_payload=True,
                with_vectors=True,
            ).points
        else:
            records = []
            for record in self._scrollAll(flt, with_vectors=True, page=min(n, _SCROLL_PAGE)):
                records.append(record)
                if len(records) >= n:
                    break
        self._rememberPointIds(records)
        return [self._recordToDoc(r, with_vector=True) for r in records], strategy

    def getVectors(self, keys):
        """
        The chunks for ``keys`` with vectors, in the order asked; missing keys are left out.

        Reads by deterministic id first, then by filter for every miss (rows
        written before deterministic ids carry random ids). Deleted rows included.
        """
        wanted = list(dict.fromkeys((str(o), int(c)) for o, c in keys if str(o) != CONTROL_OBJECT_ID))
        if not wanted or not self._exists():
            return []
        found: Dict[Tuple[str, int], Any] = {}
        want = set(wanted)
        ids = [point_id_for(oid, chunk) for oid, chunk in wanted]
        for start in range(0, len(ids), 1000):
            for record in self.client.retrieve(
                collection_name=self.collection, ids=ids[start : start + 1000], with_payload=True, with_vectors=True
            ):
                meta = _meta_of(record)
                key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
                if key in want and key not in found:
                    found[key] = record
        misses = [k for k in wanted if k not in found]
        for record in self._readByKeys(misses, with_vectors=True):
            meta = _meta_of(record)
            key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
            if key in want and key not in found:
                found[key] = record
        records = [found[k] for k in wanted if k in found]
        self._rememberPointIds(records)
        return [self._recordToDoc(r, with_vector=True) for r in records]

    def _readByKeys(
        self, keys: Sequence[Tuple[str, int]], *, with_payload: Any = True, with_vectors: bool = False
    ) -> Iterator[Any]:
        """
        Yield the rows of ``keys`` read by filter (objectId IN ... AND chunkId IN ...), deleted rows included.

        Keys are grouped by objectId in batches so each read asks only for the
        chunk ids of its own documents; the caller pairs rows with keys.
        """
        by_object: Dict[str, Set[int]] = {}
        for oid, chunk in keys:
            by_object.setdefault(oid, set()).add(chunk)
        objects = sorted(by_object)
        for start in range(0, len(objects), 64):
            batch = objects[start : start + 64]
            chunks = sorted(set().union(*(by_object[o] for o in batch)))
            flt = Filter(
                must=[
                    FieldCondition(key='meta.objectId', match=models.MatchAny(any=batch)),
                    FieldCondition(key='meta.chunkId', match=models.MatchAny(any=chunks)),
                ]
            )
            yield from self._scrollAll(flt, with_payload=with_payload, with_vectors=with_vectors)

    def _pointIdsFor(self, keys: Sequence[Tuple[str, int]]) -> Dict[Tuple[str, int], Any]:
        """Point id per key: remembered from earlier reads, else looked up by filter."""
        memo: Dict[Tuple[str, int], Any] = self.__dict__.get('_vxPointIds', {})
        resolved = {k: memo[k] for k in keys if k in memo}
        misses = [k for k in keys if k not in resolved]
        if misses:
            missing = set(misses)
            records = list(self._readByKeys(misses, with_payload=['meta']))
            self._rememberPointIds(records)
            for record in records:
                meta = _meta_of(record)
                key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
                if key in missing and key not in resolved:
                    resolved[key] = record.id
        return resolved

    def _storedPointIds(self, keys: Sequence[Tuple[str, int]]) -> Dict[Tuple[str, int], Any]:
        """
        Point id per key, read from the collection now (never from the remembered ids).

        The deterministic id first, then by filter for every miss (rows written before
        deterministic ids). A key with no stored point is left out, so an id remembered
        for a point removed since is never handed to Qdrant (which would answer 404).
        """
        if not keys:
            return {}
        want = set(keys)
        found: Dict[Tuple[str, int], Any] = {}
        ids = [point_id_for(oid, chunk) for oid, chunk in keys]
        for start in range(0, len(ids), 1000):
            for record in self.client.retrieve(
                collection_name=self.collection,
                ids=ids[start : start + 1000],
                with_payload=['meta'],
                with_vectors=False,
            ):
                meta = _meta_of(record)
                key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
                if key in want and key not in found:
                    found[key] = record.id
        misses = [key for key in keys if key not in found]
        for record in self._readByKeys(misses, with_payload=['meta']):
            meta = _meta_of(record)
            key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
            if key in want and key not in found:
                found[key] = record.id
        return found

    def knnGraph(self, keys, vectors, metric, k):
        """
        The k-nearest-neighbour graph over the sampled keys, computed by Qdrant.

        ``search_matrix_offsets`` restricted to the sample's point ids finds the
        neighbours (source 'native'); similarities are recomputed from the
        vectors by ``metric`` so every visual uses one definition. Above
        ``NATIVE_KNN_MAX`` keys, or if Qdrant cannot answer for every key, the
        graph is computed on the node instead (source 'node').
        """
        vx = _vx()
        X = np.asarray(vectors, dtype=np.float32)
        keys = [(str(o), int(c)) for o, c in keys]
        n = len(keys)
        k = max(0, min(int(k), n - 1))
        if 2 <= n <= self.NATIVE_KNN_MAX and k >= 1:
            try:
                graph = self._nativeKnn(keys, X, metric, k)
                if graph is not None:
                    return graph
            except Exception as e:
                debug(f'Qdrant could not compute the neighbour graph ({type(e).__name__}: {e}); computing it here')
        try:
            return super().knnGraph(keys, X, metric, k)
        except _errors().StoreUnsupported:
            offsets, cols, sims = _exact_knn(metric, X, k)
            return vx.KnnGraph(k=k, offsets_row=offsets, cols=cols, sims=sims, source='node')

    def _nativeKnn(self, keys, X, metric, k):
        pids = self._pointIdsFor(keys)
        if len(pids) != len(keys) or len(set(pids.values())) != len(keys):
            return None
        row_of = {pid: i for i, pid in enumerate(pids[key] for key in keys)}
        response = self.client.search_matrix_offsets(
            collection_name=self.collection,
            query_filter=Filter(must=[models.HasIdCondition(has_id=list(row_of))]),
            sample=len(keys),
            limit=k,
        )
        ids = list(response.ids)
        if len(ids) != len(keys) or any(pid not in row_of for pid in ids):
            return None
        rows = np.asarray([row_of[ids[r]] for r in response.offsets_row], dtype=np.int64)
        cols = np.asarray([row_of[ids[c]] for c in response.offsets_col], dtype=np.int64)
        keep = rows != cols
        rows, cols = rows[keep], cols[keep]
        sims = _similarities(metric, X, rows, cols).astype(np.float32)
        order = np.lexsort((-sims, rows))
        rows, cols, sims = rows[order], cols[order], sims[order]
        out_cols: List[np.ndarray] = []
        out_sims: List[np.ndarray] = []
        offsets = np.zeros(len(keys) + 1, dtype=np.int64)
        bounds = np.searchsorted(rows, np.arange(len(keys) + 1))
        for i in range(len(keys)):
            lo, hi = bounds[i], min(bounds[i + 1], bounds[i] + k)
            out_cols.append(cols[lo:hi])
            out_sims.append(sims[lo:hi])
            offsets[i + 1] = offsets[i] + (hi - lo)
        return _vx().KnnGraph(
            k=k,
            offsets_row=offsets,
            cols=np.concatenate(out_cols) if out_cols else np.zeros(0, dtype=np.int64),
            sims=np.concatenate(out_sims) if out_sims else np.zeros(0, dtype=np.float32),
            source='native',
        )

    def recommendNative(
        self,
        *,
        positive: Sequence[Tuple[str, int]],
        negative: Sequence[Tuple[str, int]],
        strategy: str,
        limit: int,
        object_ids: Optional[Sequence[str]] = None,
        vector: Optional[Sequence[float]] = None,
    ) -> List[Doc]:
        """
        The chunks Qdrant recommends from example keys (and the query vector), best first.

        The explorer's ``recommend`` tool calls this for ``strategy='best_score'``
        (capability ``recommend_best_score``); ``'average_vector'`` is answered too, so
        the node's own average can be held against Qdrant's ranking.

        Keys resolve to point ids (the deterministic id, else by filter for rows
        written before it); a key that resolves to no point is left out, and the
        control record is never an example. ``vector`` (the query vector the embedding
        node returned) is one more positive example. Candidates are the active rows of
        real documents, within ``object_ids`` when given; Qdrant never returns an
        example point. Each Doc carries ``metadata.pointId``, no vector, and as
        ``score`` the score Qdrant gave it: for ``best_score``, ``sigmoid(s)`` of the
        best positive similarity when it beats the best negative one, else
        ``-sigmoid(s)`` of the best negative similarity (a value in [-1, 1]).

        Returns [] when the collection is missing or no example resolves (for
        ``average_vector``: no positive one), and when positive keys were given, none
        of them resolves and there is no ``vector``: "like A, unlike B" with A gone is
        never answered as "unlike B" (only an empty ``positive`` asks for negatives
        alone). Raises ValueError for any other strategy.
        """
        if strategy not in self.RECOMMEND_STRATEGIES:
            raise ValueError(f'unknown recommendation strategy {strategy!r}')
        if not self._exists():
            return []

        def wanted(keys: Sequence[Tuple[str, int]]) -> List[Tuple[str, int]]:
            return list(dict.fromkeys((str(o), int(c)) for o, c in keys or () if str(o) != CONTROL_OBJECT_ID))

        pos, neg = wanted(positive), wanted(negative)
        pids = self._storedPointIds(list(dict.fromkeys(pos + neg)))
        positives: List[Any] = [pids[key] for key in pos if key in pids]
        negatives: List[Any] = [pids[key] for key in neg if key in pids]
        if positive and not positives and vector is None:
            return []
        if vector is not None:
            positives.append([float(v) for v in vector])
        if not positives and (strategy == 'average_vector' or not negatives):
            return []
        points = self.client.query_points(
            collection_name=self.collection,
            query=models.RecommendQuery(
                recommend=models.RecommendInput(
                    positive=positives or None, negative=negatives or None, strategy=strategy
                )
            ),
            query_filter=self._documentsFilter('active', object_ids),
            with_vectors=False,
            with_payload=True,
            limit=max(1, int(limit)),
            search_params=SearchParams(exact=True),
        ).points
        self._rememberPointIds(points)
        docs: List[Doc] = []
        for point in points:
            if point.payload is None:
                continue
            doc = self._recordToDoc(point)
            doc.score = float(point.score)
            docs.append(doc)
        return docs

    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Remove every chunk of ``objectIds`` (deleted rows too); return the rows removed. Never the control record."""
        ids = [oid for oid in dict.fromkeys(str(o).strip() for o in objectIds) if oid and oid != CONTROL_OBJECT_ID]
        if not ids or not self._exists():
            return 0
        flt = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=ids))])
        removed = int(self.client.count(collection_name=self.collection, count_filter=flt, exact=True).count)
        if removed:
            self.client.delete(
                collection_name=self.collection, points_selector=models.FilterSelector(filter=flt), wait=True
            )
        return removed

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those, in one operation; return the rows removed.

        The deleted flag is part of the delete's own filter, so a chunk a concurrent ``restore`` has just made
        live is never removed. Never the control record.
        """
        ids = [oid for oid in dict.fromkeys(str(o).strip() for o in objectIds) if oid and oid != CONTROL_OBJECT_ID]
        if not ids or not self._exists():
            return 0
        flt = self._documentsFilter('deleted', ids)
        removed = int(self.client.count(collection_name=self.collection, count_filter=flt, exact=True).count)
        if removed:
            self.client.delete(
                collection_name=self.collection, points_selector=models.FilterSelector(filter=flt), wait=True
            )
        return removed
