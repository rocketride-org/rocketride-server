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
# Interface implementation for the Weaviate store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any, Iterable, Iterator, Optional, Sequence, Tuple
import re
import time
import functools
import json
import uuid
import base64
from datetime import datetime, timezone

import weaviate
from weaviate.client import WeaviateClient
from weaviate.classes.aggregate import GroupByAggregate
from weaviate.classes.init import AdditionalConfig, Timeout, Auth
from weaviate.classes.query import Filter, MetadataQuery
from weaviate.collections.collection import Collection
from weaviate.classes.config import VectorDistances
import weaviate.classes.config as wc

from weaviate.exceptions import UnexpectedStatusCodeError, WeaviateBaseError

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import DELETED_VALUES, ChunkPage, DocPage, DocumentRow, StoreInfo
from ai.common.config import Config

# objectId of the collection's control record
CONTROL_OBJECT_ID = 'schema'

# Weaviate answers at most this many objects for offset + limit (QUERY_MAXIMUM_RESULTS)
MAX_QUERY_RESULTS = 10000

# Objects read per page when updating a document's chunks
UPDATE_PAGE = 1000

# Largest number of documents countDocumentsWhere groups before it gives up (None)
MAX_GROUPS = 10000

# Weaviate distance -> the explorer's metric vocabulary (None: no vector-space equivalent)
METRICS = {'cosine': 'cosine', 'dot': 'ip', 'l2-squared': 'l2'}

# Most objectId x chunkId combinations one vectors read asks for, and ids per id lookup
VECTOR_BATCH_ROWS = 4096
FETCH_BATCH_IDS = 500


# Network libraries under the clients (their errors can name the server too)
_TRANSPORTS = ('grpc', 'httpx', 'httpcore', 'h11', 'h2', 'urllib3', 'requests', 'aiohttp', 'ssl', 'socket', 'dns')

#: Libraries whose errors can carry the server address: the client and the transports under it
_CLIENT_MODULES = frozenset(('weaviate', 'authlib') + _TRANSPORTS)


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
    with the exception's text, so the text becomes 'Weaviate <operation> failed: <ErrorClass> (code N)'.
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
                raise StoreError(f'Weaviate {operation} failed: {detail}') from error

        return call

    return decorate


def _keyed_uuid(objectId: str, chunkId: int) -> str:
    """The point id of a chunk: uuid5 of '<objectId>#<chunkId>'."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'{objectId}#{chunkId}'))


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
        if not _is_count(offset) or offset > MAX_QUERY_RESULTS:
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
    would not do: Weaviate returns rows in storage order, not chunk order. None when nothing is
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


def _all(*filters: Optional[Filter]) -> Optional[Filter]:
    """AND of the given filters, None entries dropped; None when nothing is left."""
    present = [f for f in filters if f is not None]
    if not present:
        return None
    if len(present) == 1:
        return present[0]
    return Filter.all_of(present)


def _any_equal(prop: str, values: Sequence[Any]) -> Filter:
    """``prop`` equals one of ``values``."""
    return Filter.any_of([Filter.by_property(prop).equal(v) for v in values])


#: Integer properties a collection may hold as Weaviate numbers (auto-schema types undeclared ints as 'number')
INT_PROPERTIES = frozenset({'chunkId', 'tableId', 'permissionId', 'vectorSize', 'size', 'modifyTime'})


def _iso_utc(value: datetime) -> str:
    """A datetime as the ISO-8601 UTC string it was written as ('2026-10-08T18:20:11Z')."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def _plain_properties(properties: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Stored properties as the driver wrote them, nulls dropped.

    A collection created before ``size``, ``modifyTime`` and ``ingestedAt`` were declared had
    them auto-schemaed on the first write: the timestamp as a date (the client returns a datetime)
    and the integers as numbers (floats). They come back as the ISO string and integers.
    """
    plain: Dict[str, Any] = {}
    for key, value in (properties or {}).items():
        if value is None:
            continue
        if isinstance(value, datetime):
            value = _iso_utc(value)
        elif key in INT_PROPERTIES and isinstance(value, float) and value.is_integer():
            value = int(value)
        plain[key] = value
    return plain


def _vector_of(obj: Any) -> List[float]:
    """The embedding of a returned object (v4 clients return named vectors)."""
    vector = getattr(obj, 'vector', None)
    if isinstance(vector, dict):
        vector = vector.get('default', next(iter(vector.values()), None))
    return [float(x) for x in vector or []]


# How long a trash update pauses after a page that left the number of pending
# chunks where it was, so a lagging replica can catch up.
_REPEAT_PAUSE_SECONDS = 1.0

# How many such pages in a row a trash update tolerates before it fails.
_MAX_STALLS = 2


class Store(DocumentStoreBase):
    apikey: str | None = None
    node: str = 'weaviate'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client: WeaviateClient | None = None
    collectionObj: Collection | None = None
    similarityDict: dict = {
        'cosine': VectorDistances.COSINE,
        'dot': VectorDistances.DOT,
        'l2-squared': VectorDistances.L2_SQUARED,
        'hamming': VectorDistances.HAMMING,
        'manhattan': VectorDistances.MANHATTAN,
    }
    # Distance metrics the hfresh vector index supports. hnsw takes every metric
    # in similarityDict above, hfresh does not, so the Cloud fallback in
    # _createCollection is only attempted for these two.
    HFRESH_DISTANCES: frozenset = frozenset(
        {
            VectorDistances.COSINE,
            VectorDistances.L2_SQUARED,
        }
    )

    #: Vector Explorer support level. Only an unmocked live suite can promote a driver.
    VX_SUPPORT: str = 'experimental'

    #: Capabilities beyond the hooks this driver overrides.
    VX_DRIVER_CAPABILITIES = frozenset({'search_keyword'})

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the weaviate vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.host = re.sub(r'^https?://', '', config.get('host').strip()).rstrip('/')
        self.port = config.get('port', None)
        self.grpc_port = config.get('grpc_port', None)

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.threshold_search = config.get('score', 0.5)

        profile = config.get('mode')

        # check if the similarity matches milvus configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'dot', 'l2-squared', 'hamming', 'manhattan']:
            self.similarity = self.similarityDict[similarity]
        else:
            raise Exception(
                'The metric you provided in the config.json does not match required weaviate configurations'
            )

        if profile == 'cloud':
            self.client = weaviate.connect_to_weaviate_cloud(
                cluster_url=self.host,
                auth_credentials=Auth.api_key(self.apikey),
                additional_config=AdditionalConfig(
                    timeout=Timeout(init=30, query=60, insert=120)  # Values in seconds
                ),
            )
        else:
            if self.apikey is None or self.apikey == '':
                self.client = weaviate.connect_to_local(
                    host=self.host,
                    port=self.port,
                    grpc_port=self.grpc_port,
                    additional_config=AdditionalConfig(
                        timeout=Timeout(init=30, query=60, insert=120)  # Values in seconds
                    ),
                )
            else:
                self.client = weaviate.connect_to_local(
                    host=self.host,
                    port=self.port,
                    grpc_port=self.grpc_port,
                    auth_credentials=Auth.api_key(self.apikey),
                    additional_config=AdditionalConfig(
                        timeout=Timeout(init=30, query=60, insert=120)  # Values in seconds
                    ),
                )

        return

    def __del__(self):
        """
        Deinitialize the weaviate client.
        """
        # Deinit everything we did
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'

        # Close the client to omit memory leaks
        if self.client is not None:
            self.client.close()
        self.client = None

        self.apikey = None
        self.vectorSize = 0
        self.collectionObj = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        if self.client.collections.exists(name=self.collection):
            if self.collectionObj is None:
                self.collectionObj = self.client.collections.get(name=self.collection)
            return True
        else:
            return False

    def _createCollection(self, vectorSize: int = 0) -> None:
        """
        Create a collection, doesn't return anything.

        Function has the same parameters for consistency
        """
        properties = [
            wc.Property(name='content', data_type=wc.DataType.TEXT),
            wc.Property(name='objectId', data_type=wc.DataType.TEXT),
            wc.Property(name='nodeId', data_type=wc.DataType.TEXT),
            wc.Property(name='parent', data_type=wc.DataType.TEXT),
            wc.Property(name='permissionId', data_type=wc.DataType.INT),
            wc.Property(name='isDeleted', data_type=wc.DataType.BOOL),
            wc.Property(name='chunkId', data_type=wc.DataType.INT),
            wc.Property(name='isTable', data_type=wc.DataType.BOOL),
            wc.Property(name='tableId', data_type=wc.DataType.INT),
            wc.Property(name='vectorSize', data_type=wc.DataType.INT),
            wc.Property(name='modelName', data_type=wc.DataType.TEXT),
            # The explorer's metadata extras, declared so auto-schema never types them
            # (it would make ingestedAt a date and the integers numbers)
            wc.Property(name='size', data_type=wc.DataType.INT),
            wc.Property(name='modifyTime', data_type=wc.DataType.INT),
            wc.Property(name='ingestedAt', data_type=wc.DataType.TEXT),
        ]

        # Shared across both index types; only vector_index_config differs.
        createArgs = {
            'name': self.collection,
            'properties': properties,
            # Define the vectorizer module (none, as we will add our own vectors)
            'vectorizer_config': wc.Configure.Vectorizer.none(),
        }

        try:
            self.collectionObj = self.client.collections.create(
                **createArgs,
                vector_index_config=wc.Configure.VectorIndex.hnsw(
                    distance_metric=self.similarity,
                ),
            )
        except UnexpectedStatusCodeError as hnswError:
            # Newer Weaviate Cloud clusters restrict the vector index type and
            # reject hnsw with 422 CONFIG_NOT_ALLOWED (only their hfresh index
            # is allowed). Retry with hfresh, keeping the distance metric.
            if hnswError.status_code != 422:
                raise
            hfresh = wc.Configure.VectorIndex.hfresh

            # hfresh accepts fewer distance metrics than hnsw. Retrying with one
            # it cannot take would bury the actionable "hnsw not allowed" error
            # under a second, more confusing rejection, so stop here instead.
            if self.similarity not in self.HFRESH_DISTANCES:
                raise

            try:
                self.collectionObj = self.client.collections.create(
                    **createArgs,
                    vector_index_config=hfresh(
                        distance_metric=self.similarity,
                    ),
                )
            except WeaviateBaseError as hfreshError:
                # The hfresh attempt is the workaround, not the diagnosis. A 422
                # that was never about the index type (a rejected property, say)
                # fails both calls, and the first error is the one that explains
                # why, so report it and keep this one as context.
                #
                # Catching the base class rather than UnexpectedStatusCodeError:
                # a connection or timeout error on the retry derives from
                # WeaviateBaseError, not from it, and would otherwise propagate
                # and replace the actionable "hnsw not allowed" error with a
                # network failure that says nothing about the real cause.
                raise hnswError from hfreshError

    def _convertFilter(self, docFilter: DocFilter, deleted: Optional[str] = None) -> Optional[Filter]:
        """
        Build the generic filter based on required permissions, node, parent, etc.

        ``deleted`` ('active' | 'deleted' | 'all') overrides what the filter itself asks for
        (``DocFilter.deleted``, else the legacy ``isDeleted`` flag). None when nothing filters.
        """
        # Declare the must list to start addding conditions
        must: List[Filter] = []

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            must.append(Filter.by_property('nodeId').equal(docFilter.nodeId))

        if docFilter.isTable is not None:
            must.append(Filter.by_property('isTable').equal(docFilter.isTable))

        if docFilter.tableIds is not None:
            must.append(_any_equal('tableId', docFilter.tableIds))

        if docFilter.parent is not None:
            must.append(Filter.by_property('parent').equal(docFilter.parent))

        if docFilter.permissions is not None:
            must.append(_any_equal('permissionId', docFilter.permissions))

        if docFilter.objectIds is not None:
            must.append(_any_equal('objectId', docFilter.objectIds))

        # Soft-deleted rows: active (default), deleted only, or all
        mode = _deleted_mode(docFilter, deleted)
        if mode == 'active':
            must.append(Filter.by_property('isDeleted').equal(False))
        elif mode == 'deleted':
            must.append(Filter.by_property('isDeleted').equal(True))

        if docFilter.chunkIds is not None:
            must.append(_any_equal('chunkId', docFilter.chunkIds))

        if docFilter.minChunkId is not None:
            must.append(Filter.by_property('chunkId').greater_or_equal(docFilter.minChunkId))

        if docFilter.maxChunkId is not None:
            must.append(Filter.by_property('chunkId').less_or_equal(docFilter.maxChunkId))

        return _all(*must)

    def _metricKey(self) -> str:
        """The configured distance as its Weaviate name ('cosine', 'dot', ...)."""
        return str(getattr(self.similarity, 'value', self.similarity)).lower()

    def _score(self, distance: float) -> float:
        """Map a Weaviate distance onto a higher-is-better score."""
        metric = self._metricKey()
        if metric == 'cosine':
            # Cosine distance is 1 - cosine similarity, in [0, 2]
            return (2.0 - distance) / 2.0
        if metric == 'dot':
            # Dot distance is the negative dot product
            return -float(distance)
        # l2-squared, manhattan, hamming: 0 is identical, larger is farther
        return 1.0 / (1.0 + max(float(distance), 0.0))

    def _toDoc(self, point: Any, *, score: float = 0.0, with_vector: bool = False) -> Doc:
        """A Doc from a returned object; carries ``metadata.pointId`` and, on request, the embedding."""
        properties = _plain_properties(point.properties)
        content = properties.pop('content', None)
        properties['pointId'] = str(point.uuid)
        doc = Doc(score=score, page_content=content, metadata=DocMetadata(**properties))
        if with_vector:
            doc.embedding = _vector_of(point)
        return doc

    def _convertToDocs(self, points: Dict, floor: Optional[float] = None) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Search hits (points with a distance) below ``floor`` are dropped.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # Get the payload content and metadata
            metadata = _plain_properties(point.properties)
            content = metadata.pop('content', None)

            if point.metadata.distance is not None:
                score = self._score(point.metadata.distance)

                # Ignore it if it is under the floor
                if floor is not None and score < floor:
                    continue
            else:
                score = 0.0

            # Create asearc new document
            doc = Doc(score=score, page_content=content, metadata=DocMetadata(**metadata))

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

        response = self.collectionObj.aggregate.over_all(total_count=True)
        return response.total_count

    @_backend_errors('searchKeyword')
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

        # Build up the filters; match on the question text (not on the question's repr)
        text = getattr(query, 'text', None) or ''
        filter = _all(self._convertFilter(docFilter=docFilter), Filter.by_property('content').like(f'*{text}*'))

        points = self.collectionObj.query.fetch_objects(
            filters=filter,
            limit=docFilter.limit,
        )

        # Convert the points into groups
        docs = self._convertToDocs(points.objects)

        return docs

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

        # Build up the filters
        filter = self._convertFilter(docFilter=docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise ValueError('Non-zero offset is not supported in semantic searching')

        points = self.collectionObj.query.near_vector(
            near_vector=query.embedding,
            filters=filter,
            limit=25 if docFilter.limit <= 10 else docFilter.limit,
            return_metadata=MetadataQuery(distance=True),
        )

        # Convert the points into groups, dropping hits under the floor
        docs = self._convertToDocs(points.objects, floor=self.effectiveFloor(docFilter))

        # Return them
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

        # Convert filter to Weaviate format
        filter_expr = self._convertFilter(docFilter)

        results = self.collectionObj.query.fetch_objects(
            filters=filter_expr, limit=docFilter.limit, offset=docFilter.offset or None
        )
        # Convert results to Docs
        return self._convertToDocs(results.objects)

    @_backend_errors('getPaths')
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Retrieve unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Chunk 0 of the live documents, never the control record
        must: List[Filter] = [
            Filter.by_property('chunkId').equal(0),
            Filter.by_property('isDeleted').equal(False),
            Filter.by_property('objectId').not_equal(CONTROL_OBJECT_ID),
        ]

        # If parent specified, add condition
        if parent is not None:
            must.append(Filter.by_property('parent').equal(parent))

        # Perform the query
        results = self.collectionObj.query.fetch_objects(filters=Filter.all_of(must), offset=offset, limit=limit)

        docs = self._convertToDocs(results.objects)

        # Build paths dictionary
        paths = {}
        for record in docs:
            parent_id = record.metadata.parent
            object_id = record.metadata.objectId

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
        Add document chunks to the document store.

        A batch holding chunk 0 of an object starts a new version of it, so the
        object's older chunks are removed first; later batches of the same object
        (the embedding nodes send long documents in several) are added to it.
        Object ids are keyed by (objectId, chunkId), so rewriting a chunk replaces it.
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
        if len(objectIds):
            self.collectionObj.data.delete_many(where=_any_equal('objectId', list(objectIds)))

        # Enter context manager
        with self.collectionObj.batch.dynamic() as batch:
            # For each document
            for chunk in chunks:
                # Get the embedding
                embedding = chunk.embedding

                # If we do not have an embedding
                if embedding is None:
                    raise Exception('No embedding in document')

                # Build the object payload: content plus the metadata (extras included, Nones dropped)
                data = {'content': chunk.page_content}
                data.update(chunk.metadata.model_dump(exclude_none=True))

                # Add object (including vector) to batch queue
                batch.add_object(
                    properties=data,
                    uuid=_keyed_uuid(chunk.metadata.objectId, chunk.metadata.chunkId),
                    vector=embedding,
                )

        # Check for failed objects
        if len(self.collectionObj.batch.failed_objects) > 0:
            raise Exception(f'Failed to import {len(self.collectionObj.batch.failed_objects)} objects')

        return

    @_backend_errors('remove')
    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self.doesCollectionExist():
            return

        if not objectIds:
            return

        objectIdsFilter: List[Filter] = []
        for objectId in objectIds:
            objectIdsFilter.append(Filter.by_property('objectId').equal(objectId))
        self.collectionObj.data.delete_many(where=Filter.any_of(objectIdsFilter))
        return

    def _setDeleted(self, objectIds: List[str], deleted: bool) -> None:
        """
        Set ``isDeleted`` on every chunk of ``objectIds``, draining the chunks still in the other state.

        A query without a limit returns only the server's default of 10 objects, so the chunks are read a
        page at a time (``UPDATE_PAGE``); each update takes a chunk out of the next read, which keeps every
        query bounded without offsets into a shrinking result set or the server's result window. Same
        name, arguments and return as #2704's helper, so either copy serves both callers.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return

        pending = _all(_any_equal('objectId', list(objectIds)), Filter.by_property('isDeleted').equal(not deleted))
        # Progress is the number of chunks still pending, recounted after each
        # page: O(1) state however many chunks the call touches. A page that
        # leaves the count where it was is a stall (a lagging replica, or an
        # update that does not persist); pause and go on for up to _MAX_STALLS
        # stalls in a row, and fail on the next one instead of looping.
        remaining = self.collectionObj.aggregate.over_all(filters=pending, total_count=True).total_count or 0
        stalls = 0
        while True:
            points = self.collectionObj.query.fetch_objects(filters=pending, limit=UPDATE_PAGE)
            if not points.objects:
                return
            for point in points.objects:
                self.collectionObj.data.update(uuid=point.uuid, properties={'isDeleted': deleted})
            left = self.collectionObj.aggregate.over_all(filters=pending, total_count=True).total_count or 0
            if left < remaining:
                remaining, stalls = left, 0
                continue
            stalls += 1
            if stalls > _MAX_STALLS:
                raise Exception(
                    f'isDeleted={deleted} did not persist on {left} chunk(s); the change is partly applied, retry to finish'
                )
            time.sleep(_REPEAT_PAUSE_SECONDS)

    @_backend_errors('markDeleted')
    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.
        Returns the chunks moved to the trash, counted before the update.
        """
        if not objectIds or not self.doesCollectionExist():
            return 0
        moving = self.vxChunksInState(objectIds, deleted=False)
        self._setDeleted(objectIds, True)
        return moving

    @_backend_errors('markActive')
    def markActive(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted.
        Returns the chunks taken out of the trash, counted before the update.
        """
        if not objectIds or not self.doesCollectionExist():
            return 0
        moving = self.vxChunksInState(objectIds, deleted=True)
        self._setDeleted(objectIds, False)
        return moving

    @_backend_errors('render')
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order, one window of chunk ids at a time
        (``renderChunkSize``, at most the MAX_QUERY_RESULTS objects one Weaviate query returns).
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self.doesCollectionExist():
            return

        window = max(1, min(int(self.renderChunkSize), MAX_QUERY_RESULTS))
        offset = 0
        while True:
            # The chunks within this window of chunk ids, in any order
            points = self.collectionObj.query.fetch_objects(
                filters=(
                    Filter.by_property('objectId').equal(objectId)
                    & Filter.by_property('chunkId').greater_or_equal(offset)
                    & Filter.by_property('chunkId').less_than(offset + window)
                ),
                limit=window,
            ).objects

            # Order this window's chunks by chunk id
            parts: Dict[int, str] = {}
            for point in points:
                properties = _plain_properties(point.properties)
                chunk = properties.get('chunkId')
                if isinstance(chunk, int) and offset <= chunk < offset + window:
                    parts[chunk] = properties.get('content') or ''

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

    def _notControl(self) -> Filter:
        """Excludes the control record."""
        return Filter.by_property('objectId').not_equal(CONTROL_OBJECT_ID)

    def _count(self, filters: Optional[Filter]) -> int:
        """Objects matching ``filters``."""
        return int(self.collectionObj.aggregate.over_all(filters=filters, total_count=True).total_count or 0)

    def _countByObject(self, filters: Optional[Filter], limit: int) -> Dict[Any, int]:
        """Objects matching ``filters`` per objectId (at most ``limit`` groups)."""
        result = self.collectionObj.aggregate.over_all(
            filters=filters, group_by=GroupByAggregate(prop='objectId', limit=limit), total_count=True
        )
        return {group.grouped_by.value: int(group.total_count or 0) for group in result.groups}

    def _readControl(self) -> Tuple[Optional[bool], Optional[int], Optional[str]]:
        """(control record present, vector size, model) read from the control record."""
        points = self.collectionObj.query.fetch_objects(
            filters=Filter.by_property('objectId').equal(CONTROL_OBJECT_ID), limit=2
        ).objects
        if len(points) != 1:
            return False, None, None
        properties = _plain_properties(points[0].properties)
        size = properties.get('vectorSize')
        model = properties.get('modelName')
        if isinstance(size, int) and size > 0:
            self.vectorSize = size
        if isinstance(model, str) and model:
            self.modelName = model
        return True, size if isinstance(size, int) else None, model if isinstance(model, str) else None

    @_backend_errors('describe')
    def describe(self) -> StoreInfo:
        """Describe the collection; never raises for a missing one and never names the host."""
        metric_key = self._metricKey()
        caveats = ['experimental']
        if metric_key == 'cosine':
            caveats.append('score_scale_inverted_fixed')
        version = None
        try:
            version = (self.client.get_meta() or {}).get('version')
        except Exception:
            version = None

        if not self._doesCollectionExist():
            return StoreInfo(
                backend='weaviate',
                backend_version=version,
                collection=self.collection or None,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=METRICS.get(metric_key),
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )

        control, dimension, model = self._readControl()

        index = None
        try:
            config = self.collectionObj.config.get()
            index_config = getattr(config, 'vector_index_config', None)
            index_type = getattr(config, 'vector_index_type', None)
            if index_type is not None or index_config is not None:
                params = {}
                for key in ('ef_construction', 'max_connections', 'ef'):
                    value = getattr(index_config, key, None)
                    if isinstance(value, int):
                        params[key] = value
                distance = getattr(index_config, 'distance_metric', None)
                index = {
                    'type': str(getattr(index_type, 'value', index_type)) if index_type is not None else None,
                    'metric': str(getattr(distance, 'value', distance)) if distance is not None else None,
                    'params': params,
                }
        except Exception:
            index = None

        return StoreInfo(
            backend='weaviate',
            backend_version=version,
            collection=self.collection,
            collection_exists=True,
            control_record=control,
            meta_column=None,
            metric=METRICS.get(metric_key),
            dimension=dimension,
            model=model,
            index=index,
            size_bytes=None,
            caveats=caveats,
        )

    def scoreInfo(self) -> Dict[str, Any]:
        """How Doc.score is computed on Weaviate."""
        metric = self._metricKey()
        if metric == 'cosine':
            formula, score_range = '1 - cosine distance / 2', [0, 1]
        elif metric == 'dot':
            formula, score_range = 'dot product (negated dot distance)', None
        else:
            formula, score_range = f'1 / (1 + {metric} distance)', [0, 1]
        return {
            'formula': formula,
            'range': score_range,
            'higher_is_better': True,
            'floor': 0.2,
            'threshold': self.threshold_search,
        }

    @_backend_errors('countChunks')
    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """Chunk objects matching ``docFilter``, control record excluded."""
        if not self._doesCollectionExist():
            return 0
        return self._count(_all(self._convertFilter(docFilter), self._notControl()))

    @_backend_errors('countDocumentsWhere')
    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        """Distinct objectIds matching ``docFilter`` (group by objectId); None above the group cap."""
        if not self._doesCollectionExist():
            return 0
        groups = self._countByObject(_all(self._convertFilter(docFilter), self._notControl()), MAX_GROUPS)
        return len(groups) if len(groups) < MAX_GROUPS else None

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
        One page of documents: chunk-0 objects by offset, with per-document counts grouped by objectId.

        A document whose chunk 0 is missing is not listed (``countDocumentsWhere`` still counts it);
        rows arrive in storage order.
        """
        offset, previous_first = _decode_cursor(cursor)
        limit = max(1, int(limit))
        caveats = ['documents_unsorted', 'documents_by_first_chunk']

        # No collection, or an empty id list (no document asked for): an empty last page
        if (object_ids is not None and not object_ids) or not self._doesCollectionExist():
            return DocPage(
                items=[], next_cursor=None, total=0, counts_exact=True, distinct=False, sorted=False, caveats=caveats
            )

        # Weaviate answers offset + limit <= QUERY_MAXIMUM_RESULTS only: serve what fits, then stop with a note
        window_left = MAX_QUERY_RESULTS - offset
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

        first_chunks = _all(
            self._convertFilter(
                DocFilter(chunkIds=[0], objectIds=list(object_ids) if object_ids else None), deleted=deleted
            ),
            self._notControl(),
        )
        fetch = min(limit + 1, window_left)
        points = self.collectionObj.query.fetch_objects(filters=first_chunks, offset=offset, limit=fetch).objects

        # The backend ignored the offset: this page repeats the previous one
        if previous_first is not None and points and (points[0].properties or {}).get('objectId') == previous_first:
            return DocPage(
                items=[],
                next_cursor=None,
                total=None,
                counts_exact=True,
                distinct=False,
                sorted=False,
                caveats=caveats + ['documents_paging_unsupported'],
            )

        has_more = len(points) > limit
        if not has_more and fetch <= limit and len(points) == fetch:
            # The window ended on a full page: more documents may exist beyond it
            caveats = caveats + ['documents_paging_unsupported']
        points = points[:limit]
        page_ids = []
        for point in points:
            object_id = (point.properties or {}).get('objectId')
            if object_id and object_id not in page_ids:
                page_ids.append(object_id)

        counts = {}
        if page_ids:
            counts = self._countByObject(
                self._convertFilter(DocFilter(objectIds=page_ids), deleted=deleted), len(page_ids)
            )

        items: List[DocumentRow] = []
        seen = set()
        for point in points:
            properties = _plain_properties(point.properties)
            object_id = properties.get('objectId')
            if not object_id or object_id in seen:
                continue
            seen.add(object_id)
            items.append(
                DocumentRow(
                    objectId=object_id,
                    path=properties.get('parent') or '',
                    chunks=counts.get(object_id),
                    has_first_chunk=True,
                    deleted=bool(properties.get('isDeleted')),
                    tables=None,
                    nodeId=properties.get('nodeId'),
                    size=properties.get('size'),
                    modifyTime=properties.get('modifyTime'),
                    ingestedAt=properties.get('ingestedAt'),
                    pointId=str(point.uuid),
                )
            )

        first = (points[0].properties or {}).get('objectId') if points else None
        return DocPage(
            items=items,
            next_cursor=_encode_cursor(offset + limit, first) if has_more else None,
            total=self._count(first_chunks),
            counts_exact=True,
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
        limit = max(1, int(limit))
        if objectId == CONTROL_OBJECT_ID or not self._doesCollectionExist():
            return ChunkPage(docs=[], has_more=False, next_after=after_chunk)

        document = self._convertFilter(DocFilter(objectIds=[objectId]), deleted=deleted)

        def window(low: int, high: int, *, probe: bool = False) -> List[Any]:
            return self.collectionObj.query.fetch_objects(
                filters=_all(
                    document,
                    Filter.by_property('chunkId').greater_than(low),
                    Filter.by_property('chunkId').less_or_equal(high),
                ),
                limit=1 if probe else min(limit * 4, MAX_QUERY_RESULTS),
            ).objects

        def beyond(high: int) -> bool:
            return bool(
                self.collectionObj.query.fetch_objects(
                    filters=_all(document, Filter.by_property('chunkId').greater_than(high)), limit=1
                ).objects
            )

        low = after_chunk
        points = window(low, low + limit)
        more = beyond(low + limit)
        if not points and more:
            first = _first_chunk_after(lambda lo, hi: bool(window(lo, hi, probe=True)), low + limit, limit)
            if first is not None:
                low = first - 1
                points = window(low, low + limit)
                more = beyond(low + limit)
        docs = _one_per_chunk(self._toDoc(point) for point in points)
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
        """Up to ``n`` chunks with embeddings in object-id order ('first'); stratified is not native."""
        if strategy == 'stratified':
            raise StoreUnsupported('sampleChunks(strategy="stratified") is not native on Weaviate')
        if not self._doesCollectionExist():
            return [], 'first'
        pinned = {(str(o), int(c)) for o, c in include_keys or []}
        points = self.collectionObj.query.fetch_objects(
            filters=_all(self._convertFilter(docFilter), self._notControl()),
            limit=min(max(1, int(n)) + len(pinned), MAX_QUERY_RESULTS),
            include_vector=True,
        ).objects
        docs = []
        for point in points:
            doc = self._toDoc(point, with_vector=True)
            if (doc.metadata.objectId, doc.metadata.chunkId) in pinned:
                continue
            docs.append(doc)
            if len(docs) >= n:
                break
        return docs, 'first'

    @_backend_errors('getVectors')
    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        """
        Chunks with embeddings for ``keys``, in request order.

        Tries the keyed ids first, then reads every miss by filter (older objects have other ids).
        """
        wanted = [(str(o), int(c)) for o, c in keys or [] if o != CONTROL_OBJECT_ID]
        if not wanted or not self._doesCollectionExist():
            return []
        found: Dict[Tuple[str, int], Doc] = {}

        # Fast path: keyed ids
        for start in range(0, len(wanted), FETCH_BATCH_IDS):
            batch = wanted[start : start + FETCH_BATCH_IDS]
            points = self.collectionObj.query.fetch_objects(
                filters=Filter.by_id().contains_any([_keyed_uuid(o, c) for o, c in batch]),
                limit=len(batch),
                include_vector=True,
            ).objects
            for point in points:
                doc = self._toDoc(point, with_vector=True)
                found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)

        # Misses: by objectId and chunkId
        missing = [key for key in wanted if key not in found]
        for object_ids, chunk_ids in _key_batches(missing):
            points = self.collectionObj.query.fetch_objects(
                filters=_all(_any_equal('objectId', object_ids), _any_equal('chunkId', chunk_ids)),
                limit=min(len(object_ids) * len(chunk_ids), MAX_QUERY_RESULTS),
                include_vector=True,
            ).objects
            for point in points:
                doc = self._toDoc(point, with_vector=True)
                found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)

        return [found[key] for key in wanted if key in found]

    @_backend_errors('removeCounted')
    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Remove every chunk of ``objectIds``; return the objects removed (counted first)."""
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        removed = self._count(_any_equal('objectId', ids))
        self.collectionObj.data.delete_many(where=_any_equal('objectId', ids))
        return removed
