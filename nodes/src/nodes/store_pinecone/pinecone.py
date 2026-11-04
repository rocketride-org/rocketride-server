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
# Interface implementation for the Pinecone store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
from typing import List, Callable, Dict, Any, Iterable, Iterator, Optional, Sequence, Tuple
import sys
import functools
import json
import re
import uuid
import base64

from pinecone.grpc import PineconeGRPC as Pinecone
from pinecone import ServerlessSpec, PodSpec

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import DELETED_VALUES, ChunkPage, DocPage, DocumentRow, StoreInfo
from ai.common.config import Config

"""
Note: a 'collection' as we know it is referred to as an index in pinecone
    * There are objects called 'collectons' within the pinecone architecture and can be found here:
    * https://docs.pinecone.io/guides/indexes/pods/understanding-collections

    From this point forward, any function calls dealing with checking existence of a collection or reffering to a
    collection are actually referring to an index. If the pinecone specific 'collection' is used, it will be referred
    to as pinecone_collection
"""

# objectId of the collection's control record
CONTROL_OBJECT_ID = 'schema'

# Pinecone returns at most this many matches when metadata or values are included
MAX_QUERY_MATCHES = 1000

# A filter that matches every row (fetch_by_metadata requires a non-empty filter)
MATCH_ALL = {'chunkId': {'$gte': 0}}

# Pinecone metric -> the explorer's metric vocabulary
METRICS = {'cosine': 'cosine', 'euclidean': 'l2', 'dotproduct': 'ip'}

# Most objectId x chunkId combinations one vectors read asks for (within the match cap), and ids per fetch
VECTOR_BATCH_ROWS = 1000
FETCH_BATCH_IDS = 200


# Network libraries under the clients (their errors can name the server too)
_TRANSPORTS = ('grpc', 'httpx', 'httpcore', 'h11', 'h2', 'urllib3', 'requests', 'aiohttp', 'ssl', 'socket', 'dns')

#: Libraries whose errors can carry the server address: the client and the transports under it
_CLIENT_MODULES = frozenset(('pinecone', 'pinecone_plugins') + _TRANSPORTS)


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
    with the exception's text, so the text becomes 'Pinecone <operation> failed: <ErrorClass> (code N)'.
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
                raise StoreError(f'Pinecone {operation} failed: {detail}') from error

        return call

    return decorate


#: Integer metadata fields; Pinecone stores every metadata number as a double and returns floats
INT_METADATA = frozenset({'chunkId', 'tableId', 'permissionId', 'vectorSize', 'size', 'modifyTime'})


def _int_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Metadata with the integral floats of integer fields turned back into ints."""
    return {
        key: int(value) if key in INT_METADATA and isinstance(value, float) and value.is_integer() else value
        for key, value in metadata.items()
    }


def _keyed_id(objectId: str, chunkId: int) -> str:
    """The vector id of a chunk: uuid5 of '<objectId>#<chunkId>'."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'{objectId}#{chunkId}'))


def _field(obj: Any, name: str, default: Any = None) -> Any:
    """Read a field from a response that may be a dict or a client model object."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        value = obj.get(name, default)
    else:
        try:
            value = obj[name]
        except Exception:
            value = getattr(obj, name, default)
    return default if value is None else value


def _as_dict(obj: Any) -> Dict[str, Any]:
    """A client model object (or dict) as a plain dict."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    for converter in ('to_dict', 'model_dump', 'dict'):
        method = getattr(obj, converter, None)
        if callable(method):
            try:
                value = method()
                if isinstance(value, dict):
                    return value
            except Exception:
                continue
    return {}


def _encode_cursor(token: Optional[str], first: Optional[str]) -> str:
    """Opaque listing cursor: Pinecone's pagination token and the first objectId of the page just served."""
    raw = json.dumps({'t': token, 'f': first}, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode_cursor(cursor: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Read a cursor from :func:`_encode_cursor`; anything else is INVALID_INPUT."""
    if not cursor:
        return None, None
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
        token = data['t']
        first = data.get('f')
        if not isinstance(token, str) or (first is not None and not isinstance(first, str)):
            raise ValueError('cursor out of range')
        return token, first
    except Exception:
        raise ToolRefusal('INVALID_INPUT', 'cursor is not one this store issued')


# Doubling steps the chunk scroll takes to find the next chunk id after a gap
GAP_SEARCH_STEPS = 64


def _first_chunk_after(exists: Callable[[int, int], bool], high: int, span: int) -> Optional[int]:
    """
    The smallest chunk id above ``high``, found with existence probes.

    ``exists(low, top)`` says whether a chunk id lies in (low, top]. Windows of doubling width
    find the first non-empty one, then a binary search finds its smallest id: a few probes of
    one row each instead of one empty page per ``span`` ids. Reading "any row beyond the window"
    would not do: Pinecone returns rows in storage order, not chunk order. None when nothing is
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


class Store(DocumentStoreBase):
    apikey: str | None = None
    node: str = 'pinecone'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client = None

    #: Vector Explorer support level. Only an unmocked live suite can promote a driver.
    VX_SUPPORT: str = 'experimental'

    #: Capabilities beyond the hooks this driver overrides (no keyword search on Pinecone).
    VX_DRIVER_CAPABILITIES = frozenset()

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the pinecone vector store. We use our own custom DocumentStoreBase.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')  # name of our pinecone index

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.profile = config.get('mode')  # either pod-based or serverless-dense TODO: talk about sparse indexes
        self.threshold_search = config.get('score', 0.5)

        # check if the similarity matches pinecone configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'euclidean', 'dotproduct']:
            self.similarity = similarity
        else:
            raise Exception(
                'The metric you provided in the config.json does not match required pinecone configurations'
            )

        # Init the store
        self.client = Pinecone(api_key=self.apikey)
        return

    def __del__(self):
        """
        Deinitialize the pinecone client.
        """
        # Deinit everything we did
        self.apikey = None
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'
        self.client = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False

        return self.client.has_index(self.collection)

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
        if not self._doesCollectionExist():
            # Spec dependent on user choice of index config
            if self.profile == 'serverless-dense':
                spec = ServerlessSpec(cloud='aws', region='us-east-1')
            else:
                # You can customize this as needed
                spec = PodSpec(
                    environment='us-east1-gcp',  # example
                    pods=1,
                    pod_type='p1.x1',
                )

            # Create the collection
            self.client.create_index(name=self.collection, dimension=vectorSize, metric=self.similarity, spec=spec)

        return True

    def _convertFilter(self, docFilter: DocFilter, deleted: Optional[str] = None) -> Dict[str, Any]:
        """
        Build the generic filter based on required permissions, node, parent, etc.

        ``deleted`` ('active' | 'deleted' | 'all') overrides what the filter itself asks for
        (``DocFilter.deleted``, else the legacy ``isDeleted`` flag, where True means all rows).
        Returns ``{'$and': [...]}``, or ``{}`` when nothing filters.
        """
        finalFilterList = []

        # Soft-deleted rows: active (default), deleted only, or all
        mode = _deleted_mode(docFilter, deleted)
        if mode == 'active':
            finalFilterList.append({'isDeleted': {'$eq': False}})
        elif mode == 'deleted':
            finalFilterList.append({'isDeleted': {'$eq': True}})

        # Declare the filters we could be filtering the collection on and how we filter them
        filters = {
            '$eq': {'nodeId': docFilter.nodeId, 'isTable': docFilter.isTable, 'parent': docFilter.parent},
            '$in': {
                'tableId': docFilter.tableIds,
                'permissionId': docFilter.permissions,
                'objectId': docFilter.objectIds,
                'chunkId': docFilter.chunkIds,
            },
            '$gte': {'chunkId': docFilter.minChunkId},
            '$lte': {'chunkId': docFilter.maxChunkId},
        }

        # Looping through filter types to get all filter attributes that are not None
        for filter_type in filters:
            for doc_filter_attribute in filters[filter_type]:
                if filters[filter_type][doc_filter_attribute] is not None:
                    finalFilterList.append(
                        {doc_filter_attribute: {filter_type: filters[filter_type][doc_filter_attribute]}}
                    )

        # Return full filter
        return {'$and': finalFilterList} if finalFilterList else {}

    def _rowOf(self, item: Any, vec_id: Optional[str] = None) -> Dict[str, Any]:
        """A query match or fetched vector as {'id', 'score', 'metadata', 'values'}."""
        return {
            'id': str(_field(item, 'id', vec_id)),
            'score': _field(item, 'score', 0.0),
            'metadata': _int_metadata(dict(_field(item, 'metadata', {}) or {})),
            'values': list(_field(item, 'values', []) or []),
        }

    def _toDoc(self, row: Dict[str, Any], *, with_vector: bool = False, score: Optional[float] = None) -> Doc:
        """A Doc from a row; carries ``metadata.pointId`` and, on request, the embedding."""
        metadata = {k: v for k, v in row['metadata'].items() if k != 'content' and v is not None}
        metadata['pointId'] = row['id']
        doc = Doc(
            score=row['score'] if score is None else score,
            page_content=row['metadata'].get('content'),
            metadata=DocMetadata(**metadata),
        )
        if with_vector:
            doc.embedding = [float(x) for x in row['values']]
        return doc

    def _convertToDocs(self, points: List[dict], floor: Optional[float] = None) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Matches scoring below ``floor`` are dropped.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            row = self._rowOf(point)

            # Ignore it if it is under the floor
            if floor is not None and row['score'] < floor:
                continue

            docs.append(self._toDoc(row))

        # Return it
        return docs

    def _dummyVector(self, index: Any) -> List[float]:
        """The constant query vector used to read rows by filter."""
        return [1] * int(index.describe_index_stats()['dimension'])

    def _fetchPage(
        self, index: Any, flt: Dict[str, Any], limit: int, token: Optional[str]
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """One fetch_by_metadata page: (rows, next token)."""
        response = index.fetch_by_metadata(
            filter=flt or MATCH_ALL, limit=max(1, min(int(limit), 10000)), pagination_token=token
        )
        vectors = _field(response, 'vectors', {}) or {}
        rows = [self._rowOf(vector, vec_id) for vec_id, vector in vectors.items()]
        pagination = _field(response, 'pagination')
        return rows, _field(pagination, 'next')

    def _selectRows(
        self, flt: Dict[str, Any], offset: int, limit: int, *, with_values: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Rows matching ``flt``, ``offset``/``limit`` applied.

        Pinecone returns at most 1000 matches per query with metadata, so reads past that
        page through fetch_by_metadata (serverless indexes; a pod index stops at 1000).
        """
        index = self.client.Index(self.collection)
        offset = max(0, int(offset or 0))
        limit = max(0, int(limit if limit is not None else 25))
        need = offset + limit
        if need <= MAX_QUERY_MATCHES or not self._isServerless():
            matches = index.query(
                vector=self._dummyVector(index),
                top_k=max(1, min(need, MAX_QUERY_MATCHES)),
                filter=flt or None,
                include_metadata=True,
                include_values=with_values,
            )['matches']
            return [self._rowOf(match) for match in matches][offset:need]
        rows: List[Dict[str, Any]] = []
        token = None
        while len(rows) < need:
            page, token = self._fetchPage(index, flt, min(1000, need - len(rows)), token)
            rows.extend(page)
            if not token:
                break
        return rows[offset:need]

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

        index = self.client.Index(self.collection)
        return int(index.describe_index_stats()['total_vector_count'])

    @_backend_errors('searchKeyword')
    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search: not available on Pinecone (dense indexes have no text matching).
        """
        raise StoreUnsupported('keyword search is not supported on Pinecone')

    @_backend_errors('searchSemantic')
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

        # Getting index
        index = self.client.Index(self.collection)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise ValueError('Non-zero offset is not supported in semantic searching')

        # Perform the search
        points = index.query(
            vector=query.embedding,
            top_k=max(1, min(docFilter.limit if docFilter.limit is not None else 25, MAX_QUERY_MATCHES)),
            filter=filter or None,
            include_metadata=True,
            include_values=False,
        )['matches']

        # Convert the points into groups, dropping matches under the floor
        docs = self._convertToDocs(points, floor=self.effectiveFloor(docFilter))

        # Return them
        return docs

    @_backend_errors('get')
    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Given a filter, return the document groups matching the filter (offset and limit applied).
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        rows = self._selectRows(self._convertFilter(docFilter=docFilter), docFilter.offset, docFilter.limit)
        return [self._toDoc(row, score=0.0) for row in rows]

    @_backend_errors('getPaths')
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return the unique parent paths of the live documents (never the control record).
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Chunk 0 of the live documents
        filterList = [
            {'chunkId': {'$eq': 0}},
            {'isDeleted': {'$eq': False}},
            {'objectId': {'$ne': CONTROL_OBJECT_ID}},
        ]

        # If parent specified, add it to the filter
        if parent is not None:
            filterList.append({'parent': {'$eq': parent}})

        # Build up the path list
        paths: Dict[str, str] = {}
        for row in self._selectRows({'$and': filterList}, offset, limit):
            parent_path = row['metadata'].get('parent')
            object_id = row['metadata'].get('objectId')
            if parent_path is not None and object_id:
                paths[parent_path] = object_id

        # And return what we found
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
        Add document chunks to the document store.

        (currently doing it chunk by chunk but will upgrade to batch additions with payload limits like others)
        """
        # If no documents present, get out
        if not len(chunks):
            return

        # Create the collection if needed
        if checkCollection and not self.createCollection(chunks):
            return

        points_to_upsert = []

        # Clear the object id list
        objectIds: Dict = {}

        def flush():
            nonlocal points_to_upsert
            nonlocal objectIds

            # Getting index
            index = self.client.Index(self.collection)

            # Batch operation for deletion
            if len(objectIds):
                self.remove(list(objectIds.keys()))

            # Batch operation for upsert
            if len(points_to_upsert):
                index.upsert(vectors=points_to_upsert)

            # Clear them
            objectIds = {}
            points_to_upsert = []

        # A batch holding chunk 0 of an object starts a new version of it: delete the
        # object's older chunks first. Later batches of the same object add to it.
        for chunk in chunks:
            if chunk.metadata.objectId != CONTROL_OBJECT_ID and not chunk.metadata.chunkId:
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

            # Pinecone rejects null metadata values: leave unset fields out
            metadata = chunk.metadata.model_dump(exclude_none=True)
            metadata['content'] = chunk.page_content

            # Bogus document which is not compatible with pinecone because it can't accept all zeroes
            if chunk.metadata.objectId == CONTROL_OBJECT_ID:
                embedding[-1] = 1
                metadata['nodeId'] = ''
                metadata['parent'] = ''
                metadata['permissionId'] = 0
                metadata['isTable'] = False
                metadata['tableId'] = 0

            # The id is keyed by (objectId, chunkId), so writing a chunk again replaces it
            vector_struct = {
                'id': _keyed_id(chunk.metadata.objectId, chunk.metadata.chunkId),
                'values': embedding,
                'metadata': metadata,
            }

            cur_size = sys.getsizeof(vector_struct)
            sum_size += cur_size
            points_to_upsert.append(vector_struct)

            # Pinecone maxes out at 100 for bulk upsert but chose 50 to ensure it doesn't hit the limit
            if (len(points_to_upsert) >= 50) or (sum_size + cur_size > self.payload_limit):
                flush()
                cur_size = 0
                sum_size = 0

        flush()

    def updateRecords(
        self, objectIds: List[str], metadataUpdates: Dict[str, Any] = None, isDeleteOperation: bool = False
    ) -> int:
        """
        Collect the ids of records in a list of objectIds to update or delete the records.

        Returns the records whose metadata the call changed (0 for a delete, which Pinecone does not count).
        """
        if not objectIds:
            return 0

        # By definition, if the collection does not exists, there
        # is nothing to update
        if not self.doesCollectionExist():
            return 0

        # Getting index
        index = self.client.Index(self.collection)
        object_ids_filter = {'objectId': {'$in': objectIds}}

        # Deleting if we need to fully remove documents
        if isDeleteOperation:
            index.delete(filter=object_ids_filter)
            return 0

        if not metadataUpdates:
            return 0

        vector_size = int(index.describe_index_stats()['dimension'])
        batch_size = 1000

        # Query only records that still differ from the target metadata state.
        # This makes every loop iteration monotonic: updated records are excluded
        # from subsequent queries, so we can safely process batches until complete.
        pending_conditions = [{key: {'$ne': value}} for key, value in metadataUpdates.items()]
        pending_filter = {
            '$and': [
                object_ids_filter,
                pending_conditions[0] if len(pending_conditions) == 1 else {'$or': pending_conditions},
            ]
        }

        # Updating the metadata fields we want changed for the batch update
        changed = 0
        while True:
            records = index.query(
                vector=[1] * vector_size,
                top_k=batch_size,
                filter=pending_filter,
                include_metadata=False,
                include_values=False,
            )['matches']
            if not records:
                break

            batch_ids = [record['id'] for record in records]
            for id_to_update in batch_ids:
                index.update(id=id_to_update, set_metadata=metadataUpdates)
            changed += len(batch_ids)
            if len(batch_ids) < batch_size:
                break
        return changed

    @_backend_errors('remove')
    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        self.updateRecords(objectIds, isDeleteOperation=True)
        return

    @_backend_errors('removeTrashed')
    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those, in one delete by metadata filter (Pinecone does not count what it deletes: None).

        The deleted flag is part of the delete's own filter, so a chunk a concurrent ``restore`` has just made
        live is never removed. Never the control record.
        """
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self.doesCollectionExist():
            return 0
        index = self.client.Index(self.collection)
        index.delete(filter={'$and': [{'objectId': {'$in': ids}}, {'isDeleted': {'$eq': True}}]})
        return None

    @_backend_errors('markDeleted')
    def markDeleted(self, objectIds: List[str]) -> int:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.
        Returns the records moved to the trash.
        """
        return self.updateRecords(objectIds, {'isDeleted': True})

    @_backend_errors('markActive')
    def markActive(self, objectIds: List[str]) -> int:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted.
        Returns the records taken out of the trash.
        """
        return self.updateRecords(objectIds, {'isDeleted': False})

    @_backend_errors('render')
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Render the complete document.

        Rehydrates all the chunks into the proper order, one window of chunk ids at a time.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self.doesCollectionExist():
            return

        window = max(1, min(int(self.renderChunkSize), MAX_QUERY_MATCHES))
        offset = 0
        while True:
            # The chunks of this object within the current window
            chunk_range_objectId_filter = DocFilter(
                objectIds=[objectId], minChunkId=offset, maxChunkId=offset + window - 1, limit=window
            )
            parts: Dict[int, str] = {}
            for chunk in self.get(chunk_range_objectId_filter):
                parts[chunk.metadata.chunkId] = chunk.page_content or ''

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

    def _describeIndex(self) -> Dict[str, Any]:
        """The index description as a dict (never returned to callers as-is: it holds the host)."""
        described = self.client.describe_index(self.collection)
        return _as_dict(described) or {key: _field(described, key) for key in ('dimension', 'metric', 'spec')}

    def _isServerless(self) -> bool:
        """Whether the index is serverless (pod indexes have no metadata fetch or id listing)."""
        cached = self.__dict__.get('_serverless')
        if cached is not None:
            return cached
        try:
            spec = _field(self._describeIndex(), 'spec', {}) or {}
            spec = _as_dict(spec) or spec
            serverless = (
                bool(spec.get('serverless')) if isinstance(spec, dict) else bool(getattr(spec, 'serverless', None))
            )
        except Exception:
            return self.profile == 'serverless-dense'
        self._serverless = serverless
        return serverless

    def _readControl(self) -> Tuple[Optional[bool], Optional[int], Optional[str]]:
        """(control record present, vector size, model) read from the control record."""
        rows = self._selectRows({'$and': [{'objectId': {'$in': [CONTROL_OBJECT_ID]}}]}, 0, 2)
        if len(rows) != 1:
            return False, None, None
        meta = rows[0]['metadata']
        size = meta.get('vectorSize')
        model = meta.get('modelName')
        if isinstance(size, (int, float)) and size > 0:
            size = int(size)
            self.vectorSize = size
        else:
            size = None
        if isinstance(model, str) and model:
            self.modelName = model
        else:
            model = None
        return True, size, model

    @_backend_errors('describe')
    def describe(self) -> StoreInfo:
        """Describe the index; never raises for a missing one and never names the index host."""
        caveats = ['experimental', 'cloud_only_unverified', 'score_scale_raw']
        if not self._doesCollectionExist():
            return StoreInfo(
                backend='pinecone',
                backend_version=None,
                collection=self.collection or None,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=METRICS.get(str(self.similarity).lower()),
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )

        described = self._describeIndex()
        metric = str(_field(described, 'metric', self.similarity)).lower()
        control, dimension, model = self._readControl()
        if dimension is None:
            try:
                dimension = int(_field(described, 'dimension')) or None
            except (TypeError, ValueError):
                dimension = None
        index = {
            'type': 'serverless' if self._isServerless() else 'pod',
            'metric': metric,
            'params': {},
        }
        return StoreInfo(
            backend='pinecone',
            backend_version=None,
            collection=self.collection,
            collection_exists=True,
            control_record=control,
            meta_column=None,
            metric=METRICS.get(metric),
            dimension=dimension,
            model=model,
            index=index,
            size_bytes=None,
            caveats=caveats,
        )

    def scoreInfo(self) -> Dict[str, Any]:
        """How Doc.score is computed on Pinecone: the service's raw score."""
        metric = str(self.similarity).lower()
        if metric == 'euclidean':
            formula, score_range, higher = 'squared euclidean distance (raw)', None, False
        elif metric == 'dotproduct':
            formula, score_range, higher = 'dot product (raw)', None, True
        else:
            formula, score_range, higher = 'cosine similarity (raw)', [-1, 1], True
        return {
            'formula': formula,
            'range': score_range,
            'higher_is_better': higher,
            'floor': 0.0,
            'threshold': self.threshold_search,
        }

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
        One page of documents: chunk-0 vectors fetched by metadata, paged by Pinecone's token.

        Pinecone cannot count, so chunk counts and the total are unknown. A pod index has no
        metadata fetch: it lists the first page only (at most 1000 documents).
        """
        token, previous_first = _decode_cursor(cursor)
        limit = max(1, int(limit))
        caveats = ['documents_unsorted', 'documents_by_first_chunk']
        empty = DocPage(
            items=[], next_cursor=None, total=None, counts_exact=False, distinct=False, sorted=False, caveats=caveats
        )

        # No collection, or an empty id list (no document asked for): an empty last page
        if (object_ids is not None and not object_ids) or not self._doesCollectionExist():
            return empty

        flt = self._convertFilter(
            DocFilter(chunkIds=[0], objectIds=list(object_ids) if object_ids else None), deleted=deleted
        )
        flt.setdefault('$and', []).append({'objectId': {'$ne': CONTROL_OBJECT_ID}})

        if self._isServerless():
            rows, next_token = self._fetchPage(self.client.Index(self.collection), flt, limit, token)
        else:
            rows = self._selectRows(flt, 0, min(limit, MAX_QUERY_MATCHES))
            next_token = None
            if len(rows) >= limit:
                caveats = caveats + ['documents_paging_unsupported']

        # The backend ignored the token: this page repeats the previous one
        if previous_first is not None and rows and rows[0]['metadata'].get('objectId') == previous_first:
            return DocPage(
                items=[],
                next_cursor=None,
                total=None,
                counts_exact=False,
                distinct=False,
                sorted=False,
                caveats=caveats + ['documents_paging_unsupported'],
            )

        items: List[DocumentRow] = []
        seen = set()
        for row in rows:
            meta = row['metadata']
            object_id = meta.get('objectId')
            if not object_id or object_id in seen:
                continue
            seen.add(object_id)
            items.append(
                DocumentRow(
                    objectId=object_id,
                    path=meta.get('parent') or '',
                    chunks=None,
                    has_first_chunk=True,
                    deleted=bool(meta.get('isDeleted')),
                    tables=None,
                    nodeId=meta.get('nodeId'),
                    size=meta.get('size'),
                    modifyTime=meta.get('modifyTime'),
                    ingestedAt=meta.get('ingestedAt'),
                    pointId=row['id'],
                )
            )

        first = rows[0]['metadata'].get('objectId') if rows else None
        return DocPage(
            items=items,
            next_cursor=_encode_cursor(next_token, first) if next_token else None,
            total=None,
            counts_exact=False,
            distinct=False,
            sorted=False,
            caveats=caveats,
        )

    @_backend_errors('scrollChunks')
    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str) -> ChunkPage:
        """
        The chunks of one document after ``after_chunk``, in chunk order, without embeddings.

        Reads the window of chunk ids (after_chunk, after_chunk + limit] and orders it here. When
        the window is empty but the document goes on, the next chunk id is found with a few one-row
        probes and the window starts there.
        """
        after_chunk = int(after_chunk)
        limit = max(1, min(int(limit), MAX_QUERY_MATCHES))
        if objectId == CONTROL_OBJECT_ID or not self._doesCollectionExist():
            return ChunkPage(docs=[], has_more=False, next_after=after_chunk)

        def window(low: int, high: int, *, probe: bool = False) -> List[Dict[str, Any]]:
            flt = self._convertFilter(
                DocFilter(objectIds=[objectId], minChunkId=low + 1, maxChunkId=high), deleted=deleted
            )
            return self._selectRows(flt, 0, 1 if probe else min(limit * 4, MAX_QUERY_MATCHES))

        def beyond(high: int) -> bool:
            flt = self._convertFilter(DocFilter(objectIds=[objectId], minChunkId=high + 1), deleted=deleted)
            return bool(self._selectRows(flt, 0, 1))

        low = after_chunk
        rows = window(low, low + limit)
        more = beyond(low + limit)
        if not rows and more:
            first = _first_chunk_after(lambda lo, hi: bool(window(lo, hi, probe=True)), low + limit, limit)
            if first is not None:
                low = first - 1
                rows = window(low, low + limit)
                more = beyond(low + limit)
        docs = _one_per_chunk(self._toDoc(row, score=0.0) for row in rows)
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
        """
        Up to ``n`` chunks with embeddings in storage order ('first'), on serverless indexes.

        Stratified sampling is not native, and a pod index cannot fetch by metadata.
        """
        if strategy == 'stratified':
            raise StoreUnsupported('sampleChunks(strategy="stratified") is not native on Pinecone')
        if not self._doesCollectionExist():
            return [], 'first'
        if not self._isServerless():
            raise StoreUnsupported('sampleChunks needs a serverless Pinecone index')
        pinned = {(str(o), int(c)) for o, c in include_keys or []}
        flt = self._convertFilter(docFilter)
        flt.setdefault('$and', []).append({'objectId': {'$ne': CONTROL_OBJECT_ID}})
        index = self.client.Index(self.collection)
        docs: List[Doc] = []
        token = None
        while len(docs) < n:
            rows, token = self._fetchPage(index, flt, min(1000, n + len(pinned)), token)
            for row in rows:
                doc = self._toDoc(row, with_vector=True, score=0.0)
                if (doc.metadata.objectId, doc.metadata.chunkId) in pinned:
                    continue
                docs.append(doc)
                if len(docs) >= n:
                    break
            if not token:
                break
        return docs, 'first'

    @_backend_errors('getVectors')
    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        """
        Chunks with embeddings for ``keys``, in request order.

        Fetches the keyed ids first, then reads every miss by filter (older vectors have random ids).
        """
        wanted = [(str(o), int(c)) for o, c in keys or [] if o != CONTROL_OBJECT_ID]
        if not wanted or not self._doesCollectionExist():
            return []
        index = self.client.Index(self.collection)
        found: Dict[Tuple[str, int], Doc] = {}

        # Fast path: keyed ids
        for start in range(0, len(wanted), FETCH_BATCH_IDS):
            batch = wanted[start : start + FETCH_BATCH_IDS]
            response = index.fetch(ids=[_keyed_id(o, c) for o, c in batch])
            for vec_id, vector in (_field(response, 'vectors', {}) or {}).items():
                doc = self._toDoc(self._rowOf(vector, vec_id), with_vector=True, score=0.0)
                found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)

        # Misses: by objectId and chunkId
        missing = [key for key in wanted if key not in found]
        for object_ids, chunk_ids in _key_batches(missing):
            flt = {'$and': [{'objectId': {'$in': object_ids}}, {'chunkId': {'$in': chunk_ids}}]}
            limit = min(len(object_ids) * len(chunk_ids), MAX_QUERY_MATCHES)
            for row in self._selectRows(flt, 0, limit, with_values=True):
                doc = self._toDoc(row, with_vector=True, score=0.0)
                found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)

        return [found[key] for key in wanted if key in found]
