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
# Interface implementation for the Milvus store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends  # type: ignore

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
from typing import List, Callable, Dict, Any, Iterable, Iterator, Optional, Sequence, Tuple
import numpy as np
from pymilvus import MilvusClient, DataType

import re
import functools
import json
import uuid
import base64
import random
import engLib

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import DELETED_VALUES, ChunkPage, DocPage, DocumentRow, StoreInfo
from ai.common.config import Config
from nodes.store_milvus.mode import is_local

# Default batch size for bulk upsert operations
DEFAULT_BULK_INSERT_BATCH_SIZE = 50

# Default connection timeout in seconds
DEFAULT_TIMEOUT = 60

# Largest offset + limit a Milvus query accepts
MAX_QUERY_WINDOW = 16384

# Documents whose rows one read of markDeleted / markActive covers
MARK_IDS_PER_QUERY = 100

# Empty chunk-id windows in a row after which that read stops (the rest is left unread)
MARK_EMPTY_WINDOWS_MAX = 64

# objectId of the collection's control record
CONTROL_OBJECT_ID = 'schema'

# Milvus metric -> the explorer's metric vocabulary (None: no vector-space equivalent)
METRICS = {'COSINE': 'cosine', 'L2': 'l2', 'IP': 'ip'}

# Most objectId x chunkId combinations one vectors read asks for
VECTOR_BATCH_ROWS = 4096


# Network libraries under the clients (their errors can name the server too)
_TRANSPORTS = ('grpc', 'httpx', 'httpcore', 'h11', 'h2', 'urllib3', 'requests', 'aiohttp', 'ssl', 'socket', 'dns')

#: Libraries whose errors can carry the server address: the client and the transports under it
_CLIENT_MODULES = frozenset(('pymilvus',) + _TRANSPORTS)


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
    with the exception's text, so the text becomes 'Milvus <operation> failed: <ErrorClass> (code N)'.
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
                raise StoreError(f'Milvus {operation} failed: {detail}') from error

        return call

    return decorate


def _escape_milvus_str(value: object) -> str:
    """Escape a value for safe interpolation into a Milvus filter expression."""
    return str(value).replace('\\', '\\\\').replace("'", "\\'")


def _int_list(values: Sequence[Any]) -> str:
    """Render integers for a Milvus ``in [...]`` list; anything that is not an integer is refused."""
    return ', '.join(str(int(v)) for v in values)


def _str_list(values: Sequence[Any]) -> str:
    """Render strings for a Milvus ``in [...]`` list."""
    return ', '.join(f"'{_escape_milvus_str(v)}'" for v in values)


def _is_count(value: Any) -> bool:
    """Whether a cursor field is a non-negative integer (a float or a boolean is not)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


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
        if not _is_count(offset) or offset > MAX_QUERY_WINDOW:
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


# Doubling steps the chunk scroll takes to find the next chunk id after a gap
GAP_SEARCH_STEPS = 64


def _first_chunk_after(exists: Callable[[int, int], bool], high: int, span: int) -> Optional[int]:
    """
    The smallest chunk id above ``high``, found with existence probes.

    ``exists(low, top)`` says whether a chunk id lies in (low, top]. Windows of doubling width
    find the first non-empty one, then a binary search finds its smallest id: a few probes of
    one row each instead of one empty page per ``span`` ids. Reading "any row beyond the window"
    would not do: Milvus returns rows in storage order, not chunk order. None when nothing is
    within reach.
    """
    low, width = high, max(1, span)
    for _ in range(GAP_SEARCH_STEPS):
        top = low + width
        if exists(low, top):
            break
        low, width = top, width * 2
    else:
        return None
    empty, found = low, top
    while found - empty > 1:
        middle = (empty + found) // 2
        if exists(low, middle):
            found = middle
        else:
            empty = middle
    return found


def _plain_meta(meta: Any) -> Dict[str, Any]:
    """A stored metadata value as a plain dict (older rows may hold other shapes)."""
    if meta is None:
        return {}
    if hasattr(meta, 'model_dump'):
        return meta.model_dump(exclude_none=True)
    return {k: v for k, v in dict(meta).items() if v is not None}


class Store(DocumentStoreBase):
    apikey: str = ''
    collection: str = ''
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client: MilvusClient | None = None
    vectorSizePos: int = 1
    vectorIndexType: str = 'IVF_FLAT'
    scalarIndexType: str = 'STL_SORT'

    #: Vector Explorer support level. Only an unmocked live suite can promote a driver.
    VX_SUPPORT: str = 'experimental'

    #: Capabilities beyond the hooks this driver overrides.
    VX_DRIVER_CAPABILITIES = frozenset({'search_keyword'})

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the milvus vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.host = re.sub(r'^https?://', '', config.get('host').strip()).rstrip('/')
        self.port = config.get('port')

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.threshold_search = config.get('score', 0.5)

        # Configurable timeout (seconds) and bulk insert batch size
        self.timeout = max(int(config.get('timeout', DEFAULT_TIMEOUT)), 1)
        self.bulkInsertBatchSize = max(int(config.get('bulkInsertBatchSize', DEFAULT_BULK_INSERT_BATCH_SIZE)), 1)

        # check if the similarity matches milvus configuration options
        similarity = config.get('similarity', 'COSINE')
        if similarity in ['L2', 'IP', 'COSINE', 'JACCARD', 'HAMMING', 'BM25']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required milvus configurations')

        # Establish a connection to the Milvus instance with configurable timeout
        try:
            # Read the same way as the key check (IGlobal._credentials).
            if not is_local(config):
                # Init the store (host was stripped of protocol at line 87, so always add https://)
                self.client = MilvusClient(uri=f'https://{self.host}', token=self.apikey, timeout=self.timeout)
            else:
                self.client = MilvusClient(uri=f'http://{self.host}:{self.port}', timeout=self.timeout)
        except Exception as e:
            self.client = None
            raise Exception(f'Failed to connect to Milvus at {self.host}: {e}') from e

        return

    def __del__(self):
        """
        Deinitialize the milvus client.
        """
        # Deinit everything we did
        self.collection = ''
        self.vectorSize = 0
        self.renderChunkSize = 0
        self.similarity = 'COSINE'
        self.client = None
        self.apikey = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        return self.client.has_collection(collection_name=self.collection)

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection, returning True on success and raising on failure.
        """
        # no collection present so far -> Let's build by starting with the parameters for the schema

        schema = MilvusClient.create_schema(
            auto_id=False,
            enable_dynamic_field=False,
        )

        # ID field
        schema.add_field(field_name='id', datatype=DataType.INT64, is_primary=True, max_length=300)

        # create the vector field
        schema.add_field(field_name='vector', datatype=DataType.FLOAT_VECTOR, dim=vectorSize)

        # this is the field for the complete context
        schema.add_field(
            field_name='content',
            datatype=DataType.VARCHAR,
            max_length=65535,  # max length
        )

        # Setup our metadata for filtering
        schema.add_field(field_name='meta', datatype=DataType.JSON)

        # Prepare index parameters
        index_params = self.client.prepare_index_params()

        # Add indexes
        index_params.add_index(field_name='id', index_type=self.scalarIndexType)

        index_params.add_index(
            field_name='vector',
            index_type=self.vectorIndexType,
            metric_type=self.similarity,
            params={'nlist': 1024},  # number of cells in the inverted index
        )

        # Create a collection
        # Note: Use _doesCollectionExist() instead of doesCollectionExist() because
        # this method is called from the base class createCollection() which already
        # holds collectionLock. Using doesCollectionExist() would cause a deadlock.
        if not self._doesCollectionExist():
            self.client.create_collection(collection_name=self.collection, schema=schema, index_params=index_params)
        return True

    def _convertFilter(self, docFilter: DocFilter, deleted: Optional[str] = None) -> List[str]:
        """
        Build the generic filter expression based on required permissions, node, parent, etc.

        ``deleted`` ('active' | 'deleted' | 'all') overrides what the filter itself asks for
        (``DocFilter.deleted``, else the legacy ``isDeleted`` flag).
        """
        # Declare the must list to start adding conditions
        must_conditions = []

        if docFilter.nodeId is not None:
            must_conditions.append(f"meta['nodeId'] == '{_escape_milvus_str(docFilter.nodeId)}'")

        if docFilter.isTable is not None:
            must_conditions.append(f"meta['isTable'] == {bool(docFilter.isTable)}")

        if docFilter.tableIds is not None:
            must_conditions.append(f"meta['tableId'] in [{_int_list(docFilter.tableIds)}]")

        if docFilter.parent is not None:
            must_conditions.append(f"meta['parent'] == '{_escape_milvus_str(docFilter.parent)}'")

        if docFilter.permissions is not None:
            must_conditions.append(f"meta['permissionId'] in [{_int_list(docFilter.permissions)}]")

        if docFilter.objectIds is not None:
            must_conditions.append(f"meta['objectId'] in [{_str_list(docFilter.objectIds)}]")

        # Soft-deleted rows: active (default), deleted only, or all
        mode = _deleted_mode(docFilter, deleted)
        if mode == 'active':
            must_conditions.append("meta['isDeleted'] == False")
        elif mode == 'deleted':
            must_conditions.append("meta['isDeleted'] == True")

        if docFilter.chunkIds is not None:
            must_conditions.append(f"meta['chunkId'] in [{_int_list(docFilter.chunkIds)}]")

        # If we are min chunk id, add a condition
        if docFilter.minChunkId is not None:
            must_conditions.append(f"meta['chunkId'] >= {int(docFilter.minChunkId)}")

        # If we are min chunk id, add a condition
        if docFilter.maxChunkId is not None:
            must_conditions.append(f"meta['chunkId'] <= {int(docFilter.maxChunkId)}")

        return must_conditions

    def _score(self, distance: float) -> float:
        """Map a Milvus search distance onto a higher-is-better score."""
        if self.similarity == 'COSINE':
            # Milvus COSINE returns the similarity in [-1, 1]; rescale to [0, 1]
            return (distance + 1) / 2
        if self.similarity in ('L2', 'JACCARD', 'HAMMING'):
            # Distances: 0 is identical, larger is farther
            return 1.0 / (1.0 + max(float(distance), 0.0))
        # IP and BM25 are already higher-is-better
        return float(1.0 / (1.0 + np.exp(distance / -100)))  # expit function unwrapped

    def _convertToDocs(self, points: List[dict], floor: Optional[float] = None) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Search hits (points with an ``entity``) below ``floor`` are dropped.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # Check it
            if not isinstance(point, dict):
                raise Exception('scored search is not a dictionary')

            if not isinstance(point.get('id'), int):
                raise Exception('scored id is not an integer')

            # Get the payload
            entity = point.get('entity')
            if entity is None:
                entity = point
                score = 0
            else:
                score = self._score(point.get('distance'))

                # Ignore it if it is under the floor
                if floor is not None and score < floor:
                    continue

            # Get the payload content and metadata
            content = entity.get('content')
            metadata = DocMetadata(**_plain_meta(entity.get('meta')))

            # Create a new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    @_backend_errors('count_documents')
    def count_documents(self) -> int:
        """
        Return the number of vectors in the document store, not the number of documents themselves.

        Returns how many documents are present in the document store.
        """
        # If the collection does not exists, by definition there are
        # no documents in the collection
        if not self.doesCollectionExist():
            return 0

        # Get cound documents using query
        res = self.client.query(collection_name=self.collection, output_fields=['count(*)'])

        # Parse query result
        return res[0]['count(*)']

    @_backend_errors('searchKeyword')
    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the docs list
        docs: List[Doc] = []

        # Build up the conditions
        must_conditions = self._convertFilter(docFilter=docFilter)

        # Match on the question text (not on the question's repr)
        text = getattr(query, 'text', None) or ''
        must_conditions.append(f"content like '%{_escape_milvus_str(text)}%'")

        # Combine all conditions into a single filter expression
        filter_expression = ' and '.join(must_conditions) if must_conditions else None

        # Perform the keyword solo search
        points = self.client.query(
            collection_name=self.collection,
            filter=filter_expression,
            limit=docFilter.limit,
            output_fields=['meta', 'content'],
        )

        docs = self._convertToDocs(points)

        # Return them
        return docs

    @_backend_errors('searchSemantic')
    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.

        As on develop, hits below the node's score threshold (``threshold_search``)
        are dropped here, so the agent ``search`` tool answers what the ``questions``
        lane keeps. A caller that sets ``DocFilter.minScore`` (the Vector Explorer)
        gets every hit down to it instead.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the docs list
        docs: List[Doc] = []

        # Build up the conditions
        must_conditions = self._convertFilter(docFilter=docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise ValueError('Non-zero offset is not supported in semantic searching')

        # Combine all conditions into a single filter expression
        filter_expression = ' and '.join(must_conditions) if must_conditions else None

        # Perform the search
        points = self.client.search(
            collection_name=self.collection,
            data=[query.embedding],
            filter=filter_expression,
            limit=25 if docFilter.limit <= 10 else docFilter.limit,
            output_fields=['meta', 'content'],
        )

        min_score = getattr(docFilter, 'minScore', None)
        cut = float(min_score) if min_score is not None else float(self.threshold_search)
        docs = self._convertToDocs(points[0], floor=cut)

        # Return the results
        return docs

    @_backend_errors('get')
    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve document groups matching a given filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # Convert filter to Milvus format
        must_conditions = self._convertFilter(docFilter)

        # Combine all conditions into a single filter expression
        filter_expression = ' and '.join(must_conditions) if must_conditions else None

        # Perform the query
        results = self.client.query(
            collection_name=self.collection,
            filter=filter_expression,
            output_fields=['meta', 'content'],
            offset=docFilter.offset,
            limit=docFilter.limit,
        )

        # Convert results to Docs
        return self._convertToDocs(results)

    @_backend_errors('getPaths')
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Retrieve unique parent paths of the live documents (never the control record).
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Base filter: Only chunk 0 of live documents
        filter_expr = (
            f"meta['chunkId'] == 0 and meta['isDeleted'] == false and meta['objectId'] != '{CONTROL_OBJECT_ID}'"
        )

        # If parent specified, add condition
        if parent is not None:
            filter_expr += f" and meta['parent'] == '{_escape_milvus_str(parent)}'"

        # Perform the query
        results = self.client.query(
            collection_name=self.collection, filter=filter_expr, output_fields=['meta'], offset=offset, limit=limit
        )

        # Build paths dictionary
        paths = {}
        for record in results:
            metadata = _plain_meta(record.get('meta'))
            parent_id = metadata.get('parent', None)
            object_id = metadata.get('objectId', None)

            if parent_id and object_id:
                paths[parent_id] = object_id

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
        """
        Add document chunks to the document store using batched bulk upsert.

        A batch holding chunk 0 of an object starts a new version of it, so the
        object's older chunks are removed first; later batches of the same object
        (the embedding nodes send long documents in several) are added to it.
        """
        # If no documents present, get out
        if not len(chunks):
            return

        # Create the collection if needed
        if checkCollection and not self.createCollection(chunks):
            return

        # The objects this batch starts (it holds their chunk 0)
        objectIds: Dict = {}
        for chunk in chunks:
            if not chunk.metadata.chunkId:
                objectIds[chunk.metadata.objectId] = True

        # Erase the previous version of those objects in one operation
        if len(objectIds.keys()):
            filter_condition = f"meta['objectId'] in [{_str_list(objectIds.keys())}]"
            try:
                # Delete entities
                self.client.delete(collection_name=self.collection, filter=filter_condition)
            except Exception as e:
                engLib.debug(f'Error deleting old chunks: {e}')

        # A later batch replaces its own chunks: sent again (a retried flush) it must not store them twice
        later: Dict[str, List[int]] = {}
        for chunk in chunks:
            if chunk.metadata.objectId not in objectIds:
                later.setdefault(chunk.metadata.objectId, []).append(int(chunk.metadata.chunkId))
        for objectId, chunkIds in later.items():
            self.client.delete(
                collection_name=self.collection,
                filter=(
                    f"meta['objectId'] == '{_escape_milvus_str(objectId)}' and "
                    f"meta['chunkId'] in [{_int_list(sorted(set(chunkIds)))}]"
                ),
            )

        # Collect chunks into batches for bulk upsert instead of one-at-a-time
        batch: List[dict] = []

        def flush_batch():
            nonlocal batch
            if not batch:
                return
            try:
                self.client.upsert(collection_name=self.collection, data=batch)
                engLib.debug(f'Milvus bulk upsert: {len(batch)} chunks inserted')
            except Exception as e:
                engLib.debug(f'Error during bulk upsert ({len(batch)} chunks): {e}')
                raise
            batch = []

        # For each document
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # Append the points // create a unique identifier that fits into an int64 id field.
            # The JSON meta field takes a plain dict (pymilvus cannot serialise a pydantic model).
            tmp_struct = {
                'id': np.int64(((uuid.uuid1().time & 0x1FFFFFFFF) << 27) | random.getrandbits(27)),
                'vector': embedding,
                'content': chunk.page_content,
                'meta': chunk.metadata.model_dump(exclude_none=True),
            }

            batch.append(tmp_struct)

            # Flush when batch reaches configured size
            if len(batch) >= self.bulkInsertBatchSize:
                flush_batch()

        # Flush any remaining chunks
        flush_batch()

    @_backend_errors('remove')
    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self.doesCollectionExist():
            return

        must_conditions = []

        # If a permissionId list was specified
        if objectIds:
            must_conditions.append(f"meta['objectId'] in [{_str_list(objectIds)}]")

        filter_expression = ' and '.join(must_conditions) if must_conditions else None
        if filter_expression:
            try:
                self.client.delete(collection_name=self.collection, filter=filter_expression, timeout=self.timeout)
            except Exception as e:
                engLib.debug(f'Error removing documents: {e}')
                raise

        return

    def _batchUpsertResults(self, results: List[dict], *, isDeleted: bool) -> int:
        """
        Batch-update the isDeleted metadata field on a list of query results.

        Collects the results in the other state into batches of bulkInsertBatchSize and
        upserts them together, avoiding the performance bottleneck of one-at-a-time
        upserts. A result without the flag reads as active. Returns the results changed.
        """
        batch: List[dict] = []
        changed = 0

        for result in results:
            meta = _plain_meta(result.get('meta'))
            if bool(meta.get('isDeleted')) == isDeleted:
                continue
            meta['isDeleted'] = isDeleted
            result['meta'] = meta
            batch.append(result)
            changed += 1

            if len(batch) >= self.bulkInsertBatchSize:
                self.client.upsert(collection_name=self.collection, data=batch)
                batch = []

        # Flush remaining
        if batch:
            self.client.upsert(collection_name=self.collection, data=batch)
        return changed

    def _rowsOfObjects(self, objectIds: List[str], output_fields: List[str]) -> Iterator[List[dict]]:
        """
        Every row of ``objectIds``, one page at a time.

        A query without a limit answers Milvus's default page only, and offset + limit may
        not pass MAX_QUERY_WINDOW, so the rows are read for at most MARK_IDS_PER_QUERY
        documents at a time, by windows of chunk ids small enough that one query holds a
        whole window. Chunk ids do not change when a row is upserted, so marking the rows
        of one page does not move a row into or out of another.

        A count(*) ends each read. So that a count which keeps answering rows the windows
        never return cannot keep it going, a read also stops after MARK_EMPTY_WINDOWS_MAX
        empty windows in a row; what it did not return is left unread (and unmarked, so the
        callers' counts stay the rows they changed).
        """
        ids = [str(oid) for oid in dict.fromkeys(objectIds or [])]
        for start in range(0, len(ids), MARK_IDS_PER_QUERY):
            batch = ids[start : start + MARK_IDS_PER_QUERY]
            of_batch = f"meta['objectId'] in [{_str_list(batch)}]"
            window = max(1, MAX_QUERY_WINDOW // len(batch))
            remaining = self._countWhere([of_batch])
            low = 0
            empty = 0
            while remaining > 0:
                rows = self.client.query(
                    collection_name=self.collection,
                    filter=f"{of_batch} and meta['chunkId'] >= {low} and meta['chunkId'] < {low + window}",
                    output_fields=output_fields,
                    limit=len(batch) * window,
                )
                if rows:
                    remaining -= len(rows)
                    empty = 0
                    yield rows
                elif not self._countWhere([of_batch, f"meta['chunkId'] >= {low + window}"]):
                    # Nothing past this window either: the rest has no chunk id to page by
                    break
                else:
                    empty += 1
                    if empty >= MARK_EMPTY_WINDOWS_MAX:
                        engLib.debug(
                            f'Milvus: stopped reading the rows of {len(batch)} documents after '
                            f'{MARK_EMPTY_WINDOWS_MAX} empty chunk-id windows; {remaining} counted rows were not read'
                        )
                        break
                low += window

    @_backend_errors('markDeleted')
    def markDeleted(self, objectIds: List[str]) -> int:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.
        Every row is read (see _rowsOfObjects); returns the rows moved to the trash.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return 0

        # Batch-update instead of one-at-a-time to avoid performance bottleneck
        return sum(
            self._batchUpsertResults(rows, isDeleted=True)
            for rows in self._rowsOfObjects(objectIds, ['id', 'vector', 'content', 'meta'])
        )

    @_backend_errors('markActive')
    def markActive(self, objectIds: List[str]) -> int:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted.
        Every row is read (see _rowsOfObjects); returns the rows taken out of the trash.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return 0

        return sum(
            self._batchUpsertResults(rows, isDeleted=False)
            for rows in self._rowsOfObjects(objectIds, ['id', 'vector', 'content', 'meta'])
        )

    @_backend_errors('render')
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order, one window of
        ``renderChunkSize`` chunk ids at a time.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self.doesCollectionExist():
            return

        window = max(1, min(int(self.renderChunkSize), MAX_QUERY_WINDOW))
        offset = 0
        while True:
            # Build filter for getting a set of chunks within the offset range
            must_condition = (
                f"meta['objectId'] == '{_escape_milvus_str(objectId)}' and "
                f"meta['chunkId'] >= {offset} and meta['chunkId'] < {offset + window}"
            )

            results = self.client.query(
                collection_name=self.collection, filter=must_condition, output_fields=['meta', 'content'], limit=window
            )

            # Order this window's chunks by chunk id
            parts: Dict[int, str] = {}
            for point in results:
                chunk = _plain_meta(point.get('meta')).get('chunkId')
                if isinstance(chunk, int) and offset <= chunk < offset + window:
                    parts[chunk] = point.get('content') or ''

            # If we got no items back, we are done
            if not parts:
                break

            # Join it together and call the output function
            callback(''.join(parts[chunk] for chunk in sorted(parts)))

            # If the window was not full, must be done
            if max(parts) < offset + window - 1:
                break

            offset += window

    # ------------------------------------------------------------------
    # Vector Explorer hooks (docs/development/nodes/vector-tool-contract.md)
    # ------------------------------------------------------------------

    def _metricName(self) -> Optional[str]:
        """The configured metric in the explorer's vocabulary."""
        return METRICS.get(str(self.similarity).upper())

    def _countWhere(self, conditions: List[str]) -> int:
        """``count(*)`` of the rows matching ``conditions``."""
        filter_expression = ' and '.join(conditions) if conditions else ''
        res = self.client.query(collection_name=self.collection, filter=filter_expression, output_fields=['count(*)'])
        return int(res[0]['count(*)']) if res else 0

    def _readControl(self) -> Tuple[Optional[bool], Optional[int], Optional[str]]:
        """(control record present, vector size, model) read from the control record."""
        rows = self.client.query(
            collection_name=self.collection,
            filter=f"meta['objectId'] == '{CONTROL_OBJECT_ID}'",
            output_fields=['meta'],
            limit=2,
        )
        if len(rows) != 1:
            return False, None, None
        meta = _plain_meta(rows[0].get('meta'))
        size = meta.get('vectorSize')
        model = meta.get('modelName')
        if isinstance(size, int) and size > 0:
            self.vectorSize = size
        if isinstance(model, str) and model:
            self.modelName = model
        return True, size if isinstance(size, int) else None, model if isinstance(model, str) else None

    def _toDoc(self, row: Dict[str, Any], *, with_vector: bool) -> Doc:
        """A Doc from a query row; carries ``metadata.pointId`` and, on request, the embedding."""
        meta = _plain_meta(row.get('meta'))
        meta['pointId'] = str(row.get('id'))
        doc = Doc(page_content=row.get('content') or '', metadata=DocMetadata(**meta), score=0)
        if with_vector:
            doc.embedding = [float(x) for x in row.get('vector') or []]
        return doc

    @_backend_errors('describe')
    def describe(self) -> StoreInfo:
        """Describe the collection; never raises for a missing one and never names the host."""
        caveats = ['experimental']
        version = None
        try:
            version = str(self.client.get_server_version())
        except Exception:
            version = None

        if not self._doesCollectionExist():
            return StoreInfo(
                backend='milvus',
                backend_version=version,
                collection=self.collection or None,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=self._metricName(),
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )

        control, dimension, model = self._readControl()

        # The vector field's dimension when the control record does not say
        if dimension is None:
            try:
                for field in self.client.describe_collection(collection_name=self.collection).get('fields', []):
                    if field.get('name') == 'vector':
                        dimension = int((field.get('params') or {}).get('dim')) or None
            except Exception:
                dimension = None

        # The vector index (IVF_FLAT by default)
        index = None
        try:
            described = self.client.describe_index(collection_name=self.collection, index_name='vector')
            params = {}
            for key in ('nlist', 'M', 'efConstruction', 'nprobe'):
                if key in described:
                    try:
                        params[key] = int(described[key])
                    except (TypeError, ValueError):
                        params[key] = described[key]
            index = {'type': described.get('index_type'), 'metric': described.get('metric_type'), 'params': params}
        except Exception:
            index = None

        return StoreInfo(
            backend='milvus',
            backend_version=version,
            collection=self.collection,
            collection_exists=True,
            control_record=control,
            meta_column=None,
            metric=self._metricName(),
            dimension=dimension,
            model=model,
            index=index,
            size_bytes=None,
            caveats=caveats,
        )

    def scoreInfo(self) -> Dict[str, Any]:
        """How Doc.score is computed on Milvus."""
        if self.similarity == 'COSINE':
            formula, score_range = '(1 + cosine similarity) / 2', [0, 1]
        elif self.similarity == 'L2':
            formula, score_range = '1 / (1 + squared L2 distance)', [0, 1]
        elif self.similarity in ('JACCARD', 'HAMMING'):
            formula, score_range = f'1 / (1 + {self.similarity.lower()} distance)', [0, 1]
        else:
            formula, score_range = f'sigmoid({self.similarity.lower()} score / 100)', [0, 1]
        return {
            'formula': formula,
            'range': score_range,
            'higher_is_better': True,
            'floor': 0.2,
            'threshold': self.threshold_search,
        }

    @_backend_errors('countChunks')
    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """Chunk rows matching ``docFilter``, control record excluded."""
        if not self._doesCollectionExist():
            return 0
        conditions = self._convertFilter(docFilter)
        conditions.append(f"meta['objectId'] != '{CONTROL_OBJECT_ID}'")
        return self._countWhere(conditions)

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
        One page of documents: chunk-0 rows by offset, with per-document chunk counts tallied
        from one query over the page's chunks.

        Milvus has no group-by on scalar fields, so a document is listed by its chunk 0
        (a document without one is not listed) and the rows arrive in storage order.
        """
        offset, previous_first = _decode_cursor(cursor)
        limit = max(1, int(limit))
        caveats = ['documents_unsorted', 'documents_by_first_chunk']

        # No collection, or an empty id list (no document asked for): an empty last page
        if (object_ids is not None and not object_ids) or not self._doesCollectionExist():
            return DocPage(
                items=[], next_cursor=None, total=0, counts_exact=True, distinct=False, sorted=False, caveats=caveats
            )

        conditions = self._convertFilter(
            DocFilter(chunkIds=[0], objectIds=list(object_ids) if object_ids else None), deleted=deleted
        )
        conditions.append(f"meta['objectId'] != '{CONTROL_OBJECT_ID}'")

        # Milvus answers offset + limit <= MAX_QUERY_WINDOW only: serve what fits, then stop with a note
        window_left = MAX_QUERY_WINDOW - offset
        if window_left <= 0:
            return DocPage(
                items=[],
                next_cursor=None,
                total=None,
                counts_exact=True,
                distinct=False,
                sorted=False,
                caveats=caveats + ['documents_paging_unsupported'],
            )
        fetch = min(limit + 1, window_left)
        rows = self.client.query(
            collection_name=self.collection,
            filter=' and '.join(conditions),
            output_fields=['meta'],
            offset=offset,
            limit=fetch,
        )

        # The backend ignored the offset: this page repeats the previous one
        if previous_first is not None and rows and _plain_meta(rows[0].get('meta')).get('objectId') == previous_first:
            return DocPage(
                items=[],
                next_cursor=None,
                total=None,
                counts_exact=True,
                distinct=False,
                sorted=False,
                caveats=caveats + ['documents_paging_unsupported'],
            )

        has_more = len(rows) > limit
        if not has_more and fetch <= limit and len(rows) == fetch:
            # The window ended on a full page: more documents may exist beyond it
            caveats = caveats + ['documents_paging_unsupported']
        rows = rows[:limit]
        page_ids: List[str] = []
        for row in rows:
            object_id = _plain_meta(row.get('meta')).get('objectId')
            if object_id and object_id not in page_ids:
                page_ids.append(object_id)

        # Chunk counts for the whole page from one query (Milvus has no group-by on JSON fields):
        # the page's chunk rows, tallied here. A page with more chunks than one query returns has
        # no counts rather than one count query per document.
        counts: Dict[str, int] = {}
        counts_exact = True
        if page_ids:
            chunk_rows = self.client.query(
                collection_name=self.collection,
                filter=' and '.join(self._convertFilter(DocFilter(objectIds=page_ids), deleted=deleted)),
                output_fields=['meta'],
                limit=MAX_QUERY_WINDOW,
            )
            if len(chunk_rows) >= MAX_QUERY_WINDOW:
                counts_exact = False
            else:
                for chunk_row in chunk_rows:
                    object_id = _plain_meta(chunk_row.get('meta')).get('objectId')
                    counts[object_id] = counts.get(object_id, 0) + 1

        items: List[DocumentRow] = []
        seen = set()
        for row in rows:
            meta = _plain_meta(row.get('meta'))
            object_id = meta.get('objectId')
            if not object_id or object_id in seen:
                continue
            seen.add(object_id)
            items.append(
                DocumentRow(
                    objectId=object_id,
                    path=meta.get('parent') or '',
                    chunks=counts.get(object_id) if counts_exact else None,
                    has_first_chunk=True,
                    deleted=bool(meta.get('isDeleted')),
                    tables=None,
                    nodeId=meta.get('nodeId'),
                    size=meta.get('size'),
                    modifyTime=meta.get('modifyTime'),
                    ingestedAt=meta.get('ingestedAt'),
                    pointId=str(row.get('id')),
                )
            )

        first = _plain_meta(rows[0].get('meta')).get('objectId') if rows else None
        return DocPage(
            items=items,
            next_cursor=_encode_cursor(offset + limit, first) if has_more else None,
            total=self._countWhere(conditions),
            counts_exact=counts_exact,
            distinct=False,
            sorted=False,
            caveats=caveats,
        )

    @_backend_errors('scrollChunks')
    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str) -> ChunkPage:
        """
        The chunks of one document after ``after_chunk``, in chunk order, without embeddings.

        Reads the window of chunk ids (after_chunk, after_chunk + limit] and orders it here (Milvus
        queries do not sort). When the window is empty but the document goes on, the next chunk id
        is found with a few one-row probes and the window starts there.
        """
        after_chunk = int(after_chunk)
        limit = max(1, int(limit))
        if objectId == CONTROL_OBJECT_ID or not self._doesCollectionExist():
            return ChunkPage(docs=[], has_more=False, next_after=after_chunk)

        document = self._convertFilter(DocFilter(objectIds=[objectId]), deleted=deleted)

        def window(low: int, high: int, *, probe: bool = False) -> List[Dict[str, Any]]:
            return self.client.query(
                collection_name=self.collection,
                filter=' and '.join(document + [f"meta['chunkId'] > {low}", f"meta['chunkId'] <= {high}"]),
                output_fields=['meta'] if probe else ['meta', 'content'],
                limit=1 if probe else min(limit * 4, MAX_QUERY_WINDOW),
            )

        def beyond(high: int) -> bool:
            return bool(
                self.client.query(
                    collection_name=self.collection,
                    filter=' and '.join(document + [f"meta['chunkId'] > {high}"]),
                    output_fields=['meta'],
                    limit=1,
                )
            )

        low = after_chunk
        rows = window(low, low + limit)
        more = beyond(low + limit)
        if not rows and more:
            first = _first_chunk_after(lambda lo, hi: bool(window(lo, hi, probe=True)), low + limit, limit)
            if first is not None:
                low = first - 1
                rows = window(low, low + limit)
                more = beyond(low + limit)
        docs = _one_per_chunk(self._toDoc(row, with_vector=False) for row in rows)
        if more:
            next_after = low + limit
        else:
            next_after = docs[-1].metadata.chunkId if docs else after_chunk
        return ChunkPage(docs=docs, has_more=more, next_after=next_after)

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
        """Up to ``n`` chunks with embeddings, in storage order ('first'); stratified is not native."""
        if strategy == 'stratified':
            raise StoreUnsupported('sampleChunks(strategy="stratified") is not native on Milvus')
        if not self._doesCollectionExist():
            return [], 'first'
        pinned = {(str(o), int(c)) for o, c in include_keys or []}
        conditions = self._convertFilter(docFilter)
        conditions.append(f"meta['objectId'] != '{CONTROL_OBJECT_ID}'")
        rows = self.client.query(
            collection_name=self.collection,
            filter=' and '.join(conditions),
            output_fields=['meta', 'content', 'vector'],
            limit=min(max(1, int(n)) + len(pinned), MAX_QUERY_WINDOW),
        )
        docs = []
        for row in rows:
            doc = self._toDoc(row, with_vector=True)
            if (doc.metadata.objectId, doc.metadata.chunkId) in pinned:
                continue
            docs.append(doc)
            if len(docs) >= n:
                break
        return docs, 'first'

    @_backend_errors('getVectors')
    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        """Chunks with embeddings for ``keys`` (by filter: Milvus ids are random), in request order."""
        wanted = [(str(o), int(c)) for o, c in keys or [] if o != CONTROL_OBJECT_ID]
        if not wanted or not self._doesCollectionExist():
            return []
        found: Dict[Tuple[str, int], Doc] = {}
        for object_ids, chunk_ids in _key_batches(wanted):
            rows = self.client.query(
                collection_name=self.collection,
                filter=f"meta['objectId'] in [{_str_list(object_ids)}] and meta['chunkId'] in [{_int_list(chunk_ids)}]",
                output_fields=['meta', 'content', 'vector'],
                limit=min(len(object_ids) * len(chunk_ids), MAX_QUERY_WINDOW),
            )
            for row in rows:
                doc = self._toDoc(row, with_vector=True)
                found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)
        return [found[key] for key in wanted if key in found]

    @_backend_errors('removeCounted')
    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Remove every chunk of ``objectIds``; return the rows removed (counted first)."""
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        removed = self._countWhere([f"meta['objectId'] in [{_str_list(ids)}]"])
        self.remove(ids)
        return removed

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those, in one operation; return the rows removed.

        The deleted flag is part of the delete's own filter, so a chunk a concurrent ``restore`` has just made
        live is never removed. Never the control record.
        """
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        trashed = [f"meta['objectId'] in [{_str_list(ids)}]", "meta['isDeleted'] == true"]
        removed = self._countWhere(trashed)
        if removed:
            self.client.delete(collection_name=self.collection, filter=' and '.join(trashed), timeout=self.timeout)
        return removed
