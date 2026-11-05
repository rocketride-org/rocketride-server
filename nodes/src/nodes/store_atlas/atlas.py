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
# MongoDB Atlas Vector Store Implementation
# ------------------------------------------------------------------------------

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any, Iterable, Iterator, Optional, Sequence, Tuple
from uuid import uuid4
import sys
import functools
import json
import re
import math
import base64
import numpy as np
import logging

from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.errors import CollectionInvalid, OperationFailure
from pymongo.database import Database
from pymongo.operations import SearchIndexModel

from pydantic import ValidationError

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import DELETED_VALUES, ChunkPage, DocPage, DocumentRow, StoreInfo
from ai.common.config import Config

logger = logging.getLogger(__name__)

# objectId of the collection's control record
CONTROL_OBJECT_ID = 'schema'

# Metadata keys stored with every chunk: the declared DocMetadata fields plus the control record's extras.
# Other extras (file size, ingest time, ...) are not stored on Atlas.
STORED_META_KEYS = frozenset(DocMetadata.model_fields) | {'vectorSize', 'modelName'}

# Metadata paths declared as filter fields of the vectorSearch index ($vectorSearch filters only on those)
FILTER_PATHS = (
    'meta.isDeleted',
    'meta.objectId',
    'meta.chunkId',
    'meta.nodeId',
    'meta.parent',
    'meta.permissionId',
    'meta.isTable',
    'meta.tableId',
)

# Node similarity setting -> Atlas Vector Search similarity name
VECTOR_SIMILARITY = {'cosine': 'cosine', 'euclidean': 'euclidean', 'dotproduct': 'dotProduct'}

# Similarity setting -> the explorer's metric vocabulary
METRICS = {'cosine': 'cosine', 'euclidean': 'l2', 'dotproduct': 'ip', 'dotProduct': 'ip'}

# Most objectId x chunkId combinations one vectors read asks for
VECTOR_BATCH_ROWS = 4096

# Chunk ids render reads per query (renderChunkSize, when smaller)
RENDER_WINDOW = 10000

# Largest listing offset a cursor may carry (no listing pages anywhere near it)
MAX_LISTING_OFFSET = 2**31 - 1

# Network libraries under the clients (their errors can name the server too)
_TRANSPORTS = ('grpc', 'httpx', 'httpcore', 'h11', 'h2', 'urllib3', 'requests', 'aiohttp', 'ssl', 'socket', 'dns')

#: Libraries whose errors can carry the server address: the client and the transports under it
_CLIENT_MODULES = frozenset(('pymongo', 'bson') + _TRANSPORTS)


def _error_code(error: BaseException) -> Optional[str]:
    """The client's error code (a number or an UPPER_CASE name) when the exception carries one."""
    for name in ('code', 'status_code', 'status', 'error_code'):
        try:
            value = getattr(error, name, None)
        except Exception:
            continue
        if isinstance(value, bool) or callable(value):
            continue
        if isinstance(value, int):
            return str(value)
        if isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', value):
            return value
    return None


def _one_per_chunk(docs: Iterable[Doc]) -> List[Doc]:
    """``docs`` in chunk order, one per chunk id (an earlier retried write may have stored a chunk twice)."""
    by_chunk: Dict[int, Doc] = {}
    for doc in docs:
        by_chunk.setdefault(doc.metadata.chunkId, doc)
    return [by_chunk[chunk] for chunk in sorted(by_chunk)]


def _deleted_mode(docFilter: DocFilter, deleted: Optional[str]) -> str:
    """
    The rows a read covers: 'active', 'deleted' or 'all'.

    ``deleted`` wins over ``DocFilter.deleted``; with neither, the legacy ``isDeleted`` flag decides.
    Any other value is INVALID_INPUT (it must not quietly read as 'all' here and 'active' there).
    """
    asked = deleted if deleted is not None else getattr(docFilter, 'deleted', None)
    if asked is None:
        return DocumentStoreBase.resolveDeleted(docFilter)
    if asked not in DELETED_VALUES:
        raise ToolRefusal('INVALID_INPUT', 'deleted must be active, deleted or all')
    return asked


def _module_root(name: Any) -> str:
    """The top-level package of a module name ('grpc' for 'grpc._channel')."""
    return str(name or '').split('.', 1)[0]


def _from_client(error: BaseException) -> bool:
    """
    Whether ``error`` came out of the client library or the network under it.

    It does when its type is defined there, when it is a network failure (an OSError: refused
    connections, timeouts, DNS and TLS errors) or when a frame of those libraries raised it (a
    plain ValueError raised inside the client still carries the client's text). An error the
    driver's own code raises (a KeyError on an odd row, say) does not.
    """
    if isinstance(error, OSError) or _module_root(type(error).__module__) in _CLIENT_MODULES:
        return True
    trace = error.__traceback__
    while trace is not None:
        if _module_root(trace.tb_frame.f_globals.get('__name__')) in _CLIENT_MODULES:
            return True
        trace = trace.tb_next
    return False


def _client_failure(error: BaseException) -> Optional[BaseException]:
    """The client-library exception in ``error``'s chain, or None when the driver raised it itself."""
    seen = set()
    link: Optional[BaseException] = error
    while link is not None and id(link) not in seen:
        seen.add(id(link))
        if isinstance(link, (StoreError, StoreUnsupported, ToolRefusal)):
            return None
        if _from_client(link):
            return link
        link = link.__cause__ or link.__context__
    return None


def _backend_errors(operation: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    Re-raise a client failure inside ``operation`` as a StoreError with a fixed, host-free message.

    Client errors name the server (host, port, endpoint) and the tool wrapper answers a failure
    with the exception's text, so the text becomes 'Atlas <operation> failed: <ErrorClass> (code N)'.
    The driver's own exceptions (refusals, ValueError for offsets, messages it wrote) pass through.
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        def call(*args: Any, **kwargs: Any) -> Any:
            try:
                return fn(*args, **kwargs)
            except Exception as error:
                failure = _client_failure(error)
                if failure is None:
                    raise
                code = _error_code(failure)
                detail = type(failure).__name__ + (f' (code {code})' if code else '')
                raise StoreError(f'Atlas {operation} failed: {detail}') from error

        return call

    return decorate


def _meta_dump(metadata: DocMetadata) -> Dict[str, Any]:
    """The metadata stored with a chunk: declared fields and the control-record extras, never null."""
    return {k: v for k, v in metadata.model_dump(exclude_none=True).items() if k in STORED_META_KEYS}


def _is_count(value: Any) -> bool:
    """Whether a cursor field is a non-negative integer (a float or a boolean is not)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _modified_count(result: Any) -> Optional[int]:
    """The documents an ``update_many`` changed (pymongo's ``modified_count``); None when it did not say."""
    value = getattr(result, 'modified_count', None)
    return value if _is_count(value) else None


def _encode_cursor(offset: int, first: Optional[str]) -> str:
    """Opaque listing cursor: the next offset and the first objectId of the page just served."""
    raw = json.dumps({'o': offset, 'f': first}, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode_cursor(cursor: Optional[str]) -> Tuple[int, Optional[str]]:
    """Read a cursor from :func:`_encode_cursor`; anything else is INVALID_INPUT."""
    if not cursor:
        return 0, None
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
        offset = data['o']
        first = data.get('f')
        if not _is_count(offset) or offset > MAX_LISTING_OFFSET:
            raise ValueError('cursor out of range')
        if first is not None and not isinstance(first, str):
            raise ValueError('cursor out of range')
        return offset, first
    except Exception:
        raise ToolRefusal('INVALID_INPUT', 'cursor is not one this store issued')


def _key_batches(keys: Sequence[Tuple[str, int]]) -> Iterator[Tuple[List[str], List[int]]]:
    """Group keys into (objectIds, chunkIds) reads whose cross product stays within VECTOR_BATCH_ROWS."""
    by_object: Dict[str, set] = {}
    for object_id, chunk_id in keys:
        by_object.setdefault(object_id, set()).add(chunk_id)
    batch_objects: List[str] = []
    batch_chunks: set = set()
    for object_id in sorted(by_object):
        merged = batch_chunks | by_object[object_id]
        if batch_objects and (len(batch_objects) + 1) * len(merged) > VECTOR_BATCH_ROWS:
            yield batch_objects, sorted(batch_chunks)
            batch_objects, merged = [], set(by_object[object_id])
        batch_objects.append(object_id)
        batch_chunks = merged
    if batch_objects:
        yield batch_objects, sorted(batch_chunks)


"""
NOTE: MongoDB Atlas Vector Search requires:
1. An Atlas M10+ cluster or serverless instance
2. Search indexes created for vector search functionality
3. Proper index configuration for vector and metadata fields

Atlas Vector Search supports cosine similarity, euclidean distance, and dot product
similarity metrics for vector search operations.
"""


class Store(DocumentStoreBase):
    """
    MongoDB Atlas Vector Store implementation.

    Implements the abstract methods required by DocumentStoreBase for
    MongoDB Atlas vector search functionality.
    """

    host: str | None = None
    node: str = 'atlas'
    database_name: str = ''
    collection_name: str = ''
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'cosine'
    threshold_search: float = 0.0
    client: MongoClient | None = None
    host: str = ''
    database: Database | None = None
    collection: Collection | None = None
    vector_index_name: str = 'vector_index'
    text_index_name: str = 'text_index'

    #: Vector Explorer support level. Only an unmocked live suite can promote a driver.
    VX_SUPPORT: str = 'experimental'

    #: Capabilities beyond the hooks this driver overrides: an aggregated, sorted, distinct
    #: document listing and native stratified sampling.
    VX_DRIVER_CAPABILITIES = frozenset(
        {'search_keyword', 'documents_distinct', 'documents_sorted', 'sample_stratified_native'}
    )

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the MongoDB Atlas vector store."""
        super().__init__(provider, connConfig, bag)

        # Get configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Store configuration
        self.database_name = config.get('database')
        self.collection_name = config.get('collection')
        self.host = config.get('host', '').strip()
        self.vector_index_name = config.get('vectorIndexName', 'vector_index')
        self.text_index_name = config.get('textIndexName', 'text_index')
        self.similarity = config.get('similarity', 'cosine').lower()
        self.threshold_search = config.get('score', 0.5)
        self.payload_limit = config.get('payloadLimit', 32 * 1024 * 1024)
        self.renderChunkSize = config.get('renderChunkSize', 32 * 1024 * 1024)

        # Validate similarity metric
        if self.similarity not in ['cosine', 'euclidean', 'dotproduct']:
            raise Exception('Similarity metric must be cosine, euclidean, or dotproduct')

        # Initialize MongoDB client
        self.client = MongoClient(self.host)
        self.database = self.client[self.database_name]
        self.collection = self.database[self.collection_name]

    def __del__(self):
        """Clean up MongoDB connection."""
        if hasattr(self, 'client') and self.client:
            self.client.close()

        # Deinit everything we did
        self.host = None
        self.database_name = ''
        self.collection_name = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'
        self.client = None
        self.database = None
        self.collection = None

    def _doesCollectionExist(self) -> bool:
        """Check if the collection exists."""
        if self.database is None:
            return False
        return self.collection_name in self.database.list_collection_names()

    def _createCollection(self, vectorSize: int) -> bool:
        """Create collection with necessary indexes."""
        self.vectorSize = vectorSize

        # Create collection if it doesn't exist
        if not self._doesCollectionExist():
            try:
                self.database.create_collection(self.collection_name)
                logger.info(f'Created MongoDB collection: {self.collection_name}')
            except CollectionInvalid:
                logger.info(f'Collection {self.collection_name} already exists')

        # Create regular indexes for metadata fields
        index_fields = [
            ('meta.nodeId', 1),
            ('meta.objectId', 1),
            ('meta.parent', 1),
            ('meta.permissionId', 1),
            ('meta.isDeleted', 1),
            ('meta.isTable', 1),
            ('meta.chunkId', 1),
            ('meta.tableId', 1),
        ]

        for field_spec in index_fields:
            try:
                self.collection.create_index([field_spec])
                logger.debug(f'Created index on {field_spec[0]}')
            except OperationFailure as e:
                logger.warning(f'Could not create index on {field_spec[0]}: {e}')

        # Create text index for keyword search
        try:
            self.collection.create_index([('content', 'text')], name=self.text_index_name)
            logger.info('Created text search index')
        except OperationFailure as e:
            logger.warning(f'Could not create text search index: {e}')

        # Create vector search index
        try:
            # Check if vector search index already exists
            existing_indexes = list(self.collection.list_search_indexes())
            vector_index_exists = any(idx.get('name') == self.vector_index_name for idx in existing_indexes)

            if not vector_index_exists:
                # $vectorSearch needs an Atlas Vector Search index (type 'vectorSearch'), with every
                # metadata path the search filters on declared as a filter field
                vector_index_definition = {
                    'fields': [
                        {
                            'type': 'vector',
                            'path': 'embedding',
                            'numDimensions': vectorSize,
                            'similarity': VECTOR_SIMILARITY.get(self.similarity, 'cosine'),
                        }
                    ]
                    + [{'type': 'filter', 'path': path} for path in FILTER_PATHS]
                }

                search_index = SearchIndexModel(
                    definition=vector_index_definition, name=self.vector_index_name, type='vectorSearch'
                )

                # Create the search index directly without SearchIndexModel
                result = self.collection.create_search_index(search_index)

                logger.info(
                    f'Created vector search index: {self.vector_index_name} with {vectorSize} dimensions, result: {result}'
                )
            else:
                logger.info(f'Vector search index {self.vector_index_name} already exists')

        except Exception as e:
            # The client's text can name the cluster: log the error class and code only
            code = _error_code(e)
            logger.error(
                f'Could not create vector search index: {type(e).__name__}' + (f' (code {code})' if code else '')
            )
            logger.info('You may need to create the vector search index manually in Atlas UI')

        return True

    @_backend_errors('count_documents')
    def count_documents(self) -> int:
        """Return the number of documents in the store."""
        if not self.doesCollectionExist():
            return 0
        return self.collection.count_documents({})

    @_backend_errors('searchKeyword')
    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """Perform keyword search using MongoDB text search."""
        if not self.doesCollectionExist():
            return []

        # Build filter conditions
        filter_conditions = self._convertFilter(docFilter)
        filter_conditions['$text'] = {'$search': query.text}

        # Build aggregation pipeline
        pipeline = [
            {'$match': filter_conditions},
            {'$addFields': {'score': {'$meta': 'textScore'}}},
            {'$sort': {'score': {'$meta': 'textScore'}}},
            {'$skip': docFilter.offset or 0},
            {'$limit': docFilter.limit or 25},
        ]

        results = list(self.collection.aggregate(pipeline))
        return self._convertToDocs(results, include_score=True, score_kind='text')

    @_backend_errors('searchSemantic')
    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """Perform semantic search using Atlas Vector Search."""
        if not self.doesCollectionExist():
            return []

        # Validate embedding model matches collection
        if not self.doesCollectionExist(query.embedding_model):
            raise Exception('Collection does not exist or model mismatch')

        if query.embedding is None:
            raise Exception('Embedding required for semantic search')

        if docFilter.offset:
            raise ValueError('Non-zero offset not supported in semantic search')

        # Build filter conditions
        filter_conditions = self._convertFilter(docFilter)

        # Build vector search pipeline
        vector_search_stage = {
            '$vectorSearch': {
                'index': self.vector_index_name,
                'path': 'embedding',
                'queryVector': query.embedding,
                'numCandidates': (docFilter.limit or 25) * 10,
                'limit': docFilter.limit or 25,
            }
        }

        if filter_conditions:
            vector_search_stage['$vectorSearch']['filter'] = filter_conditions

        pipeline = [vector_search_stage, {'$addFields': {'score': {'$meta': 'vectorSearchScore'}}}]

        try:
            results = list(self.collection.aggregate(pipeline))
        except OperationFailure as e:
            # Most often the vector search index is missing or is not a vectorSearch index
            raise StoreError(
                f'Atlas vector search failed (code {getattr(e, "code", None)}); check that the vector search index '
                f'{self.vector_index_name!r} exists and is a vectorSearch index'
            ) from e

        return self._convertToDocs(results, include_score=True, floor=self.effectiveFloor(docFilter))

    @_backend_errors('get')
    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """Get documents matching the filter."""
        if checkCollection and not self.doesCollectionExist():
            return []

        filter_conditions = self._convertFilter(docFilter)
        cursor = self.collection.find(filter_conditions)

        if docFilter.offset:
            cursor = cursor.skip(docFilter.offset)
        if docFilter.limit:
            cursor = cursor.limit(docFilter.limit)

        documents = list(cursor)
        return self._convertToDocs(documents)

    @_backend_errors('getPaths')
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """Get unique parent paths."""
        if not self.doesCollectionExist():
            return {}

        filter_conditions = {'meta.chunkId': 0, 'meta.isDeleted': False, 'meta.objectId': {'$ne': CONTROL_OBJECT_ID}}
        if parent is not None:
            filter_conditions['meta.parent'] = {'$regex': parent, '$options': 'i'}

        cursor = self.collection.find(filter_conditions).skip(offset).limit(limit)

        paths = {}
        for document in cursor:
            if 'meta' not in document:
                continue

            metadata = self._validateMetadata(document['meta'])
            if metadata is None:
                continue

            paths[metadata.parent] = metadata.objectId

        return paths

    @_backend_errors('createCollection')
    def createCollection(self, documents: List[Doc]) -> bool:
        """Create the collection as the base does; a client failure is reported without the server address."""
        return super().createCollection(documents)

    @_backend_errors('doesCollectionExist')
    def doesCollectionExist(self, modelName: str = None) -> bool:
        """Check the collection as the base does; a client failure is reported without the server address."""
        return super().doesCollectionExist(modelName)

    @_backend_errors('addChunks')
    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """Add document chunks to the store.

        Args:
            chunks: The batch to write.
            checkCollection: Create the collection if it is missing and check that the chunks match its
                embedding model and vector size; createCollection passes False when it writes its control row.
        """
        if not chunks:
            return

        if checkCollection and not self.createCollection(chunks):
            return

        # The objects this batch starts over
        objectIds = self.objectIdsToReplace(chunks)

        # Delete existing documents with same object IDs
        if objectIds:
            self.collection.delete_many({'meta.objectId': {'$in': objectIds}})

        # A later batch replaces its own chunks: sent again (a retried flush) it must not store them twice
        later: Dict[str, List[int]] = {}
        for chunk in chunks:
            if chunk.metadata.objectId not in objectIds:
                later.setdefault(chunk.metadata.objectId, []).append(chunk.metadata.chunkId)
        if later:
            clauses = [{'meta.objectId': o, 'meta.chunkId': {'$in': sorted(set(c))}} for o, c in later.items()]
            self.collection.delete_many(clauses[0] if len(clauses) == 1 else {'$or': clauses})

        # Prepare documents for insertion
        documents = []
        sum_size = 0

        for chunk in chunks:
            if chunk.embedding is None:
                raise Exception('No embedding in document')

            # Declared metadata fields and the control record's extras, without nulls
            doc = {
                '_id': str(uuid4()),
                'embedding': chunk.embedding,
                'content': chunk.page_content,
                'meta': _meta_dump(chunk.metadata),
            }

            doc_size = sys.getsizeof(doc)
            sum_size += doc_size
            documents.append(doc)

            # Flush when batch size or payload limit is reached
            if len(documents) >= 500 or sum_size > self.payload_limit:
                self.collection.insert_many(documents)
                documents = []
                sum_size = 0

        # Insert remaining documents
        if documents:
            self.collection.insert_many(documents)

    @_backend_errors('remove')
    def remove(self, objectIds: List[str]) -> None:
        """Remove documents by object IDs."""
        if not objectIds:
            return
        if not self.doesCollectionExist():
            return

        self.collection.delete_many({'meta.objectId': {'$in': objectIds}})

    @_backend_errors('markDeleted')
    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        """Mark documents as deleted; return the chunks moved to the trash (MongoDB's modified count)."""
        if not objectIds:
            return 0
        if not self.doesCollectionExist():
            return 0

        result = self.collection.update_many({'meta.objectId': {'$in': objectIds}}, {'$set': {'meta.isDeleted': True}})
        return _modified_count(result)

    @_backend_errors('markActive')
    def markActive(self, objectIds: List[str]) -> Optional[int]:
        """Mark documents as active (not deleted); return the chunks taken out of the trash."""
        if not objectIds:
            return 0
        if not self.doesCollectionExist():
            return 0

        result = self.collection.update_many({'meta.objectId': {'$in': objectIds}}, {'$set': {'meta.isDeleted': False}})
        return _modified_count(result)

    @_backend_errors('render')
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """Render complete document by combining all chunks, one window of chunk ids at a time."""
        if not self.doesCollectionExist():
            return

        window = max(1, min(int(self.renderChunkSize), RENDER_WINDOW))
        offset = 0
        while True:
            filter_conditions = {
                'meta.objectId': objectId,
                'meta.chunkId': {'$gte': offset, '$lt': offset + window},
            }
            documents = list(self.collection.find(filter_conditions, {'embedding': 0}).limit(window))

            # Order this window's chunks by chunk id
            parts: Dict[int, str] = {}
            for document in documents:
                if 'meta' not in document:
                    continue
                metadata = self._validateMetadata(document['meta'])
                if metadata is None:
                    continue
                chunk = metadata.chunkId
                if isinstance(chunk, int) and offset <= chunk < offset + window:
                    parts[chunk] = document.get('content') or ''

            # If we got no items back, we are done
            if not parts:
                break

            callback(''.join(parts[chunk] for chunk in sorted(parts)))

            # If the window was not full, must be done
            if max(parts) < offset + window - 1:
                break

            offset += window

    def _convertFilter(self, docFilter: DocFilter, deleted: Optional[str] = None) -> Dict[str, Any]:
        """
        Convert DocFilter to MongoDB filter conditions.

        ``deleted`` ('active' | 'deleted' | 'all') overrides what the filter itself asks for
        (``DocFilter.deleted``, else the legacy ``isDeleted`` flag).
        """
        filter_conditions = {}

        if docFilter.nodeId is not None:
            filter_conditions['meta.nodeId'] = docFilter.nodeId

        if docFilter.isTable is not None:
            filter_conditions['meta.isTable'] = docFilter.isTable

        if docFilter.tableIds is not None:
            filter_conditions['meta.tableId'] = {'$in': docFilter.tableIds}

        if docFilter.parent is not None:
            filter_conditions['meta.parent'] = {'$regex': docFilter.parent, '$options': 'i'}

        if docFilter.permissions is not None:
            filter_conditions['meta.permissionId'] = {'$in': docFilter.permissions}

        if docFilter.objectIds is not None:
            filter_conditions['meta.objectId'] = {'$in': docFilter.objectIds}

        mode = _deleted_mode(docFilter, deleted)
        if mode == 'active':
            filter_conditions['meta.isDeleted'] = False
        elif mode == 'deleted':
            filter_conditions['meta.isDeleted'] = True

        if docFilter.chunkIds is not None:
            filter_conditions['meta.chunkId'] = {'$in': docFilter.chunkIds}

        if docFilter.minChunkId is not None:
            if 'meta.chunkId' not in filter_conditions:
                filter_conditions['meta.chunkId'] = {}
            filter_conditions['meta.chunkId']['$gte'] = docFilter.minChunkId

        if docFilter.maxChunkId is not None:
            if 'meta.chunkId' not in filter_conditions:
                filter_conditions['meta.chunkId'] = {}
            filter_conditions['meta.chunkId']['$lte'] = docFilter.maxChunkId

        return filter_conditions

    def _validateMetadata(self, meta_dict: Dict[str, Any]) -> Optional[DocMetadata]:
        """Validate and create DocMetadata with proper error handling."""
        required_fields = {
            'nodeId': (str, ''),
            'parent': (str, ''),
            'permissionId': (int, 0),
            'isTable': (bool, False),
            'tableId': (int, 0),
        }

        cleaned_meta = {}

        for field_name, (field_type, default_value) in required_fields.items():
            if field_name in meta_dict and meta_dict[field_name] is not None:
                try:
                    if field_type is bool:
                        if isinstance(meta_dict[field_name], str):
                            cleaned_meta[field_name] = meta_dict[field_name].lower() in ('true', '1', 'yes')
                        else:
                            cleaned_meta[field_name] = bool(meta_dict[field_name])
                    elif field_type is int:
                        cleaned_meta[field_name] = int(meta_dict[field_name])
                    elif field_type is str:
                        cleaned_meta[field_name] = str(meta_dict[field_name])
                    else:
                        cleaned_meta[field_name] = meta_dict[field_name]
                except (ValueError, TypeError) as e:
                    logger.warning(f'Failed to convert {field_name}: {e}')
                    cleaned_meta[field_name] = default_value
            else:
                cleaned_meta[field_name] = default_value

        # Copy additional fields (rows written by earlier releases carry explicit nulls: skip them)
        for key, value in meta_dict.items():
            if key not in required_fields and value is not None:
                cleaned_meta[key] = value

        try:
            return DocMetadata(**cleaned_meta)
        except ValidationError as e:
            logger.error(f'Failed to create DocMetadata: {e}')
            return None

    def _convertToDocs(
        self,
        documents: List[Dict[str, Any]],
        include_score: bool = False,
        floor: Optional[float] = None,
        score_kind: str = 'vector',
    ) -> List[Doc]:
        """
        Convert MongoDB documents to Doc objects.

        Vector scores are Atlas's vectorSearchScore, already normalised; hits below ``floor``
        are dropped. Text scores (keyword search) keep their legacy conversion and 0.20 floor.
        """
        docs = []

        for doc in documents:
            if 'meta' not in doc:
                logger.warning("Document missing 'meta' field")
                continue

            metadata = self._validateMetadata(doc['meta'])
            if metadata is None:
                continue

            content = doc.get('content', '')

            if include_score and 'score' in doc:
                score = doc['score']
                if score_kind == 'text':
                    if self.similarity == 'cosine':
                        score = (score + 1) / 2
                    else:
                        score = float(1.0 / (1.0 + np.exp(score / -100)))
                    if score < 0.20:
                        continue
                elif floor is not None and score < floor:
                    continue
            else:
                score = 0

            doc_obj = Doc(score=score, page_content=content, metadata=metadata)
            docs.append(doc_obj)

        return docs

    # ------------------------------------------------------------------
    # Vector Explorer hooks (docs/development/nodes/vector-tool-contract.md)
    # ------------------------------------------------------------------

    def _notControl(self, filter_conditions: Dict[str, Any]) -> Dict[str, Any]:
        """``filter_conditions`` with the control record excluded."""
        condition = filter_conditions.get('meta.objectId')
        if isinstance(condition, dict):
            filter_conditions['meta.objectId'] = {**condition, '$ne': CONTROL_OBJECT_ID}
        elif condition is None:
            filter_conditions['meta.objectId'] = {'$ne': CONTROL_OBJECT_ID}
        return filter_conditions

    def _toDoc(self, document: Dict[str, Any], *, with_vector: bool = False) -> Optional[Doc]:
        """A Doc from a stored document; carries ``metadata.pointId`` and, on request, the embedding."""
        metadata = self._validateMetadata(document.get('meta') or {})
        if metadata is None:
            return None
        metadata.pointId = str(document.get('_id'))
        doc = Doc(score=0, page_content=document.get('content') or '', metadata=metadata)
        if with_vector:
            doc.embedding = [float(x) for x in document.get('embedding') or []]
        return doc

    def _readControl(self) -> Tuple[Optional[bool], Optional[int], Optional[str]]:
        """(control record present, vector size, model) read from the control record."""
        rows = list(self.collection.find({'meta.objectId': CONTROL_OBJECT_ID}, {'meta': 1}).limit(2))
        if len(rows) != 1:
            return False, None, None
        meta = rows[0].get('meta') or {}
        size = meta.get('vectorSize')
        model = meta.get('modelName')
        if isinstance(size, int) and size > 0:
            self.vectorSize = size
        if isinstance(model, str) and model:
            self.modelName = model
        return True, size if isinstance(size, int) else None, model if isinstance(model, str) else None

    def _vectorIndex(self) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        """(index description, dimension) of the vector search index, from list_search_indexes."""
        for index in self.collection.list_search_indexes():
            if index.get('name') != self.vector_index_name:
                continue
            definition = index.get('latestDefinition') or index.get('definition') or {}
            if index.get('type') == 'vectorSearch':
                vector = next((f for f in definition.get('fields') or [] if f.get('type') == 'vector'), {})
                return (
                    {
                        'type': 'vectorSearch',
                        'metric': vector.get('similarity'),
                        'params': {
                            'filters': len([f for f in definition.get('fields') or [] if f.get('type') == 'filter'])
                        },
                        'vector_search_ready': bool(index.get('queryable', True)),
                    },
                    vector.get('numDimensions'),
                )
            # An Atlas Search mapping (knnVector) cannot serve $vectorSearch
            field = ((definition.get('mappings') or {}).get('fields') or {}).get('embedding') or {}
            return (
                {
                    'type': field.get('type') or index.get('type'),
                    'metric': field.get('similarity'),
                    'params': {},
                    'vector_search_ready': False,
                },
                field.get('dimensions'),
            )
        return None, None

    @_backend_errors('describe')
    def describe(self) -> StoreInfo:
        """Describe the collection; never raises for a missing one and never names the cluster."""
        caveats = ['experimental', 'cloud_only_unverified', 'extras_not_stored']
        if not self._doesCollectionExist():
            return StoreInfo(
                backend='atlas',
                backend_version=None,
                collection=self.collection_name or None,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=METRICS.get(self.similarity),
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )

        control, dimension, model = self._readControl()
        try:
            index, index_dimension = self._vectorIndex()
        except Exception:
            index, index_dimension = None, None
        if dimension is None and isinstance(index_dimension, int):
            dimension = index_dimension
        return StoreInfo(
            backend='atlas',
            backend_version=None,
            collection=self.collection_name,
            collection_exists=True,
            control_record=control,
            meta_column=None,
            metric=METRICS.get(self.similarity),
            dimension=dimension,
            model=model,
            index=index,
            size_bytes=None,
            caveats=caveats,
        )

    def scoreInfo(self) -> Dict[str, Any]:
        """How Doc.score is computed on Atlas: the vectorSearchScore as Atlas returns it."""
        if self.similarity == 'euclidean':
            formula = '1 / (1 + euclidean distance)'
        elif self.similarity == 'dotproduct':
            formula = '(1 + dot product) / 2'
        else:
            formula = '(1 + cosine similarity) / 2'
        return {
            'formula': formula,
            'range': [0, 1],
            'higher_is_better': True,
            'floor': 0.2,
            'threshold': self.threshold_search,
        }

    @_backend_errors('countChunks')
    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """Chunks matching ``docFilter``, control record excluded."""
        if not self._doesCollectionExist():
            return 0
        return self.collection.count_documents(self._notControl(self._convertFilter(docFilter)))

    def _countGroups(self, match: Dict[str, Any]) -> int:
        """Distinct objectIds among the documents matching ``match``."""
        rows = list(
            self.collection.aggregate(
                [{'$match': match}, {'$group': {'_id': '$meta.objectId'}}, {'$count': 'n'}], allowDiskUse=True
            )
        )
        return int(rows[0]['n']) if rows else 0

    @_backend_errors('countDocumentsWhere')
    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        """Distinct objectIds matching ``docFilter`` ($group), control record excluded."""
        if not self._doesCollectionExist():
            return 0
        return self._countGroups(self._notControl(self._convertFilter(docFilter)))

    @_backend_errors('listDocumentPage')
    def listDocumentPage(
        self,
        *,
        cursor: Optional[str],
        limit: int,
        object_ids: Optional[Sequence[str]],
        deleted: str,
        sort: str,
    ) -> DocPage:
        """
        One page of documents, aggregated by objectId and sorted by path: exact chunk and table
        counts, and documents without a chunk 0 included (``has_first_chunk`` false).
        """
        offset, previous_first = _decode_cursor(cursor)
        limit = max(1, int(limit))
        caveats = ['extras_not_stored']

        # No collection, or an empty id list (no document asked for): an empty last page
        if (object_ids is not None and not object_ids) or not self._doesCollectionExist():
            return DocPage(
                items=[], next_cursor=None, total=0, counts_exact=True, distinct=True, sorted=True, caveats=caveats
            )

        match = self._notControl(
            self._convertFilter(DocFilter(objectIds=list(object_ids) if object_ids else None), deleted=deleted)
        )
        pipeline = [
            {'$match': match},
            {
                '$group': {
                    '_id': '$meta.objectId',
                    'path': {'$min': '$meta.parent'},
                    'chunks': {'$sum': 1},
                    'first': {'$min': '$meta.chunkId'},
                    'deleted': {'$max': '$meta.isDeleted'},
                    'tables': {'$sum': {'$cond': [{'$eq': ['$meta.isTable', True]}, 1, 0]}},
                    'nodeId': {'$first': '$meta.nodeId'},
                    'pointId': {'$min': {'$cond': [{'$eq': ['$meta.chunkId', 0]}, '$_id', None]}},
                }
            },
            {'$sort': {'path': 1, '_id': 1}},
            {'$skip': offset},
            {'$limit': limit + 1},
        ]
        groups = list(self.collection.aggregate(pipeline, allowDiskUse=True))

        # The backend ignored the offset: this page repeats the previous one
        if previous_first is not None and groups and groups[0].get('_id') == previous_first:
            return DocPage(
                items=[],
                next_cursor=None,
                total=None,
                counts_exact=True,
                distinct=True,
                sorted=True,
                caveats=caveats + ['documents_paging_unsupported'],
            )

        has_more = len(groups) > limit
        groups = groups[:limit]
        items = [
            DocumentRow(
                objectId=str(group['_id']),
                path=group.get('path') or '',
                chunks=int(group.get('chunks') or 0),
                has_first_chunk=group.get('first') == 0,
                deleted=bool(group.get('deleted')),
                tables=int(group.get('tables') or 0),
                nodeId=group.get('nodeId'),
                size=None,
                modifyTime=None,
                ingestedAt=None,
                pointId=str(group['pointId']) if group.get('pointId') is not None else None,
            )
            for group in groups
            if group.get('_id') is not None
        ]
        return DocPage(
            items=items,
            next_cursor=_encode_cursor(offset + limit, str(groups[0]['_id'])) if has_more else None,
            total=self._countGroups(match),
            counts_exact=True,
            distinct=True,
            sorted=True,
            caveats=caveats,
        )

    @_backend_errors('scrollChunks')
    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str) -> ChunkPage:
        """The chunks of one document after ``after_chunk``, sorted by chunkId, without embeddings."""
        after_chunk = int(after_chunk)
        limit = max(1, int(limit))
        if objectId == CONTROL_OBJECT_ID or not self._doesCollectionExist():
            return ChunkPage(docs=[], has_more=False, next_after=after_chunk)
        filter_conditions = self._convertFilter(DocFilter(objectIds=[objectId]), deleted=deleted)
        filter_conditions['meta.chunkId'] = {'$gt': after_chunk}
        documents = list(
            self.collection.find(filter_conditions, {'embedding': 0}).sort('meta.chunkId', 1).limit(limit + 1)
        )
        has_more = len(documents) > limit
        docs = _one_per_chunk(
            doc for doc in (self._toDoc(document) for document in documents[:limit]) if doc is not None
        )
        return ChunkPage(docs=docs, has_more=has_more, next_after=docs[-1].metadata.chunkId if docs else after_chunk)

    @_backend_errors('sampleChunks')
    def sampleChunks(
        self,
        *,
        n: int,
        seed: int,
        strategy: str,
        docFilter: DocFilter,
        include_keys: Sequence[Tuple[str, int]],
    ) -> Tuple[List[Doc], str]:
        """
        Up to ``n`` chunks with embeddings.

        'stratified' (native): every document's chunk 0 first, then random chunks spread evenly
        across documents ($rand ordering per objectId group, $firstN per group). 'random':
        ``$sample``. 'first': storage order. Atlas cannot seed ``$rand``/``$sample``.
        """
        n = max(1, int(n))
        if not self._doesCollectionExist():
            return [], strategy
        pinned = {(str(o), int(c)) for o, c in include_keys or []}
        match = self._notControl(self._convertFilter(docFilter))

        if strategy == 'stratified':
            documents_count = max(1, self._countGroups(match))
            per_document = max(1, math.ceil(n / documents_count))
            keys = list(
                self.collection.aggregate(
                    [
                        {'$match': match},
                        {
                            '$project': {
                                'o': '$meta.objectId',
                                'c': '$meta.chunkId',
                                'first': {'$cond': [{'$eq': ['$meta.chunkId', 0]}, 0, 1]},
                                'r': {'$rand': {}},
                            }
                        },
                        {'$sort': {'o': 1, 'first': 1, 'r': 1}},
                        {'$group': {'_id': '$o', 'ids': {'$firstN': {'n': per_document, 'input': '$_id'}}}},
                    ],
                    allowDiskUse=True,
                )
            )
            # Round-robin across documents so n rows cover as many documents as possible
            ids: List[Any] = []
            depth = 0
            while len(ids) < n + len(pinned) and any(depth < len(group['ids']) for group in keys):
                for group in keys:
                    if depth < len(group['ids']):
                        ids.append(group['ids'][depth])
                depth += 1
            documents = {str(d['_id']): d for d in self.collection.find({'_id': {'$in': ids}})}
            ordered = [documents[str(i)] for i in ids if str(i) in documents]
            used = 'stratified'
        elif strategy == 'random':
            ordered = list(
                self.collection.aggregate(
                    [{'$match': match}, {'$sample': {'size': n + len(pinned)}}], allowDiskUse=True
                )
            )
            used = 'random'
        else:
            ordered = list(self.collection.find(match).limit(n + len(pinned)))
            used = 'first'

        docs = []
        for document in ordered:
            doc = self._toDoc(document, with_vector=True)
            if doc is None or (doc.metadata.objectId, doc.metadata.chunkId) in pinned:
                continue
            docs.append(doc)
            if len(docs) >= n:
                break
        return docs, used

    @_backend_errors('getVectors')
    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        """Chunks with embeddings for ``keys`` (by filter: ids are random), in request order."""
        wanted = [(str(o), int(c)) for o, c in keys or [] if o != CONTROL_OBJECT_ID]
        if not wanted or not self._doesCollectionExist():
            return []
        found: Dict[Tuple[str, int], Doc] = {}
        for object_ids, chunk_ids in _key_batches(wanted):
            documents = self.collection.find({'meta.objectId': {'$in': object_ids}, 'meta.chunkId': {'$in': chunk_ids}})
            for document in documents:
                doc = self._toDoc(document, with_vector=True)
                if doc is not None:
                    found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)
        return [found[key] for key in wanted if key in found]

    @_backend_errors('removeCounted')
    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Remove every chunk of ``objectIds``; return the rows Atlas reports deleted."""
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        return int(self.collection.delete_many({'meta.objectId': {'$in': ids}}).deleted_count)

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those, in one operation; return the rows removed.

        The deleted flag is part of the delete's own filter, so a chunk a concurrent ``restore`` has just made
        live is never removed. Never the control record.
        """
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        return int(self.collection.delete_many({'meta.objectId': {'$in': ids}, 'meta.isDeleted': True}).deleted_count)
