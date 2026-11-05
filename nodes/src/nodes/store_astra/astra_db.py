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

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any, Iterable, Iterator, Optional, Sequence, Tuple
from uuid import uuid4
import re
import functools
import json
import base64

from astrapy import DataAPIClient, Database
from astrapy.data_types import DataAPIVector
from astrapy.info import CollectionDefinition, CollectionVectorOptions, CollectionLexicalOptions

try:
    from astrapy.exceptions import TooManyDocumentsToCountException
except ImportError:  # older astrapy: count_documents has no upper bound to exceed

    class TooManyDocumentsToCountException(Exception):  # type: ignore[no-redef]
        """Placeholder that is never raised."""


from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import DELETED_VALUES, ChunkPage, DocPage, DocumentRow, StoreInfo
from ai.common.config import Config

from rocketlib import warning

# objectId of the collection's control record
CONTROL_OBJECT_ID = 'schema'

# count_documents needs a ceiling; above it the count is unknown (the Data API caps counts near 1000)
COUNT_UPPER_BOUND = 1000

# A bounded count is exact; past it, stats reports the server's estimate (see count_documents).
_COUNT_UPPER_BOUND = 10_000
# The Data API's default exact-count limit, Astra DB's: past it, countDocuments answers with the limit and
# moreData, and astrapy raises naming the limit.
_SERVER_COUNT_LIMIT = 1_000

# Metadata keys stored with every chunk: the declared DocMetadata fields plus the control record's extras.
# Other extras (file size, ingest time, ...) are not stored on Astra.
STORED_META_KEYS = frozenset(DocMetadata.model_fields) | {'vectorSize', 'modelName'}

# Astra metric -> the explorer's metric vocabulary
METRICS = {'cosine': 'cosine', 'euclidean': 'l2', 'dot_product': 'ip'}

# Most objectId x chunkId combinations one vectors read asks for
VECTOR_BATCH_ROWS = 1000

# Doubling steps the chunk scroll takes to find the next chunk id after a gap
GAP_SEARCH_STEPS = 64

# Note on sorting: a find sorted on a regular field (not $vector / $lexical) returns at most 20
# documents and stops there, and sorts at most 10,000 matching rows in memory. Every read below
# is therefore unsorted (the Data API pages it) and ordered on the node where order matters.


# Most documents of one Data API page a listing cursor can skip (a find page holds at most 20)
MAX_PAGE_SKIP = 1000

# Network libraries under the clients (their errors can name the server too)
_TRANSPORTS = ('grpc', 'httpx', 'httpcore', 'h11', 'h2', 'urllib3', 'requests', 'aiohttp', 'ssl', 'socket', 'dns')

#: Libraries whose errors can carry the server address: the client and the transports under it
_CLIENT_MODULES = frozenset(('astrapy',) + _TRANSPORTS)


def _count_floor(exc: TooManyDocumentsToCountException) -> int:
    """The number of rows a collection is known to exceed when astrapy refuses to count it."""
    if not getattr(exc, 'server_max_count_exceeded', False):
        return _COUNT_UPPER_BOUND
    # astrapy carries the server's limit only in its message ("Document count
    # exceeds 1000, the maximum allowed by the server"); the Data API default
    # stands in when the message does not name it.
    match = re.search(r'exceeds (\d+)', getattr(exc, 'text', None) or '')
    return int(match.group(1)) if match else _SERVER_COUNT_LIMIT


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
    with the exception's text, so the text becomes 'Astra DB <operation> failed: <ErrorClass> (code N)'.
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
                raise StoreError(f'Astra DB {operation} failed: {detail}') from error

        return call

    return decorate


def _meta_dump(metadata: DocMetadata) -> Dict[str, Any]:
    """The metadata stored with a chunk: declared fields and the control-record extras, never null."""
    return {k: v for k, v in metadata.model_dump(exclude_none=True).items() if k in STORED_META_KEYS}


def _meta_load(meta: Dict[str, Any]) -> DocMetadata:
    """DocMetadata from stored metadata; older rows hold explicit nulls, which are skipped."""
    return DocMetadata(**{k: v for k, v in (meta or {}).items() if v is not None})


def _field(obj: Any, name: str, default: Any = None) -> Any:
    """Read a field from a result that may be a dict or an object."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _is_count(value: Any) -> bool:
    """Whether a cursor field is a non-negative integer (a float or a boolean is not)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _encode_cursor(state: Optional[str], skip: int, first: Optional[str]) -> str:
    """
    Opaque listing cursor: the Data API page state to resume from (None: the first page), how many
    of that page's documents were already served, and the listing's first objectId.
    """
    raw = json.dumps({'s': state, 'k': skip, 'f': first}, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode_cursor(cursor: Optional[str]) -> Tuple[Optional[str], int, Optional[str]]:
    """Read a cursor from :func:`_encode_cursor`; anything else is INVALID_INPUT."""
    if not cursor:
        return None, 0, None
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
        state = data['s']
        skip = data['k']
        first = data.get('f')
        if (state is not None and not isinstance(state, str)) or not _is_count(skip) or skip > MAX_PAGE_SKIP:
            raise ValueError('cursor out of range')
        if first is not None and not isinstance(first, str):
            raise ValueError('cursor out of range')
        return state, skip, first
    except Exception:
        raise ToolRefusal('INVALID_INPUT', 'cursor is not one this store issued')


def _first_chunk_after(exists: Callable[[int, int], bool], high: int, span: int) -> Optional[int]:
    """
    The smallest chunk id above ``high``, found with existence probes.

    ``exists(low, top)`` says whether a chunk id lies in (low, top]. Windows of doubling width
    find the first non-empty one, then a binary search finds its smallest id: a few probes of
    one row each instead of one empty page per ``span`` ids. None when nothing is within reach.
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
    application_token: str | None = None
    node: str = 'astra_db'
    collection_name: str = ''
    api_endpoint: str = ''
    similarity: str = 'cosine'
    client: DataAPIClient | None = None
    database: Database | None = None

    #: Vector Explorer support level. Only an unmocked live suite can promote a driver.
    VX_SUPPORT: str = 'experimental'

    #: Capabilities beyond the hooks this driver overrides.
    VX_DRIVER_CAPABILITIES = frozenset({'search_keyword'})

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the astradb vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection_name = config.get('collection', '')

        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9_]*$', self.collection_name):
            raise Exception(f'Invalid collection name: {self.collection_name}')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.api_endpoint = config.get('api_endpoint')

        # check if the similarity matches astra configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'euclidean', 'dot_product']:
            self.similarity = similarity
        else:
            raise Exception(
                'The similarity metric you provided in the config.json does not match required astra configurations'
            )

        # Strip API key also
        self.application_token = config.get('application_token', None)
        if self.application_token is not None:
            self.application_token = self.application_token.strip()

        # Init the store
        self.client = DataAPIClient()
        self.database = self.client.get_database(self.api_endpoint, token=self.application_token)
        return

    def __del__(self):
        """
        Deinitializes the AstraDB client.
        """
        # Deinit everything we did
        self.application_token = None
        self.api_endpoint = ''
        self.client = None
        self.database = None
        return

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.database is None:
            return False
        return self.collection_name in self.database.list_collection_names()

    def doesCollectionExist(self, modelName: str = None) -> bool:
        """
        Override base class to handle AstraDB-specific collection validation.

        Returns False if collection doesn't exist or doesn't have control document,
        allowing base class to create it properly.
        """
        try:
            return super().doesCollectionExist(modelName)
        except Exception:
            # If validation fails (e.g., no control document), return False
            # so base class will attempt to create/fix the collection
            return False

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection with proper vector configuration.

        The base class will handle creating the control document separately.
        """
        try:
            # Define collection with custom embedding support
            collection_definition = CollectionDefinition(
                vector=CollectionVectorOptions(dimension=vectorSize, metric=self.similarity),
                lexical=CollectionLexicalOptions(enabled=True, analyzer='standard'),
            )

            # Create the collection
            self.database.create_collection(name=self.collection_name, definition=collection_definition)

            return True

        except Exception as e:
            # The client's text can name the endpoint: report the error class and code only
            code = _error_code(e)
            warning(f'Collection creation failed: {type(e).__name__}' + (f' (code {code})' if code else ''))
            return False

    def _convertFilter(self, docFilter: DocFilter, deleted: Optional[str] = None) -> Dict:
        """
        Build the generic filter based on required permissions, node, parent, etc.

        Convert DocFilter to AstraDB query format. ``deleted`` ('active' | 'deleted' | 'all')
        overrides what the filter itself asks for (``DocFilter.deleted``, else the legacy
        ``isDeleted`` flag).
        """
        filter_dict = {}

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            filter_dict['meta.nodeId'] = docFilter.nodeId

        if docFilter.isTable is not None:
            filter_dict['meta.isTable'] = docFilter.isTable

        if docFilter.tableIds is not None:
            filter_dict['meta.tableId'] = {'$in': docFilter.tableIds}

        # If a parent was specified
        if docFilter.parent is not None:
            filter_dict['meta.parent'] = {'$regex': docFilter.parent}

        # If a permissionId list was specified
        if docFilter.permissions is not None:
            filter_dict['meta.permissionId'] = {'$in': docFilter.permissions}

        # If a objectIds list was specified
        if docFilter.objectIds is not None:
            filter_dict['meta.objectId'] = {'$in': docFilter.objectIds}

        # Match other document stores (Qdrant, Postgres, Elasticsearch): default
        # queries must not return soft-deleted rows ('active'); 'deleted' returns only
        # those, and 'all' (or the legacy isDeleted=True) omits the clause.
        mode = _deleted_mode(docFilter, deleted)
        if mode == 'active':
            filter_dict['meta.isDeleted'] = False
        elif mode == 'deleted':
            filter_dict['meta.isDeleted'] = True

        # If we are going after specific chunks
        if docFilter.chunkIds is not None:
            filter_dict['meta.chunkId'] = {'$in': docFilter.chunkIds}

        # If we have min chunk id
        if docFilter.minChunkId is not None:
            if 'meta.chunkId' not in filter_dict:
                filter_dict['meta.chunkId'] = {}
            filter_dict['meta.chunkId']['$gte'] = docFilter.minChunkId

        # If we have max chunk id
        if docFilter.maxChunkId is not None:
            if 'meta.chunkId' not in filter_dict:
                filter_dict['meta.chunkId'] = {}
            filter_dict['meta.chunkId']['$lte'] = docFilter.maxChunkId

        return filter_dict

    def _convertToDocs(self, documents: List[Dict], floor: Optional[float] = None) -> List[Doc]:
        """
        Convert a list of AstraDB documents to Doc objects.

        Search hits (documents with ``$similarity``) below ``floor`` are dropped.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for document in documents:
            # Check for required fields - updated field name
            if 'content' not in document or 'meta' not in document:
                continue

            # Get the content and metadata - updated field name
            metadata = _meta_load(document['meta'])
            content = document['content']

            # Determine the score of this document
            if '$similarity' in document:
                score = document['$similarity']
                # Ignore if score is under the floor
                if floor is not None and score < floor:
                    continue
            else:
                score = 0

            # Create a new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def _countWhere(self, filter_dict: Dict[str, Any]) -> Optional[int]:
        """Documents matching ``filter_dict``; None when there are more than COUNT_UPPER_BOUND."""
        collection = self.database.get_collection(self.collection_name)
        try:
            return collection.count_documents(filter_dict, upper_bound=COUNT_UPPER_BOUND)
        except TooManyDocumentsToCountException:
            return None

    @_backend_errors('count_documents')
    def count_documents(self) -> int:
        """
        Return the number of documents in the document store.
        """
        # If the collection does not exist, by definition there are
        # no documents in the collection
        if not self._doesCollectionExist():
            return 0

        collection = self.database.get_collection(self.collection_name)

        try:
            return collection.count_documents({}, upper_bound=_COUNT_UPPER_BOUND)
        except TooManyDocumentsToCountException as exc:
            # Past the exact-count ceiling (this node's bound, or the server's
            # limit), report the server's estimate rather than paging through
            # every row ID on each stats call. The estimate can lag recent
            # writes, so never report less than the count known to be exceeded.
            return max(collection.estimated_document_count(), _count_floor(exc) + 1)

    @_backend_errors('searchKeyword')
    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search using AstraDB's native lexical search.
        """
        if not self._doesCollectionExist():
            return []

        docs: List[Doc] = []

        # Convert docFilter to AstraDB filter format
        filter_dict = self._convertFilter(docFilter)

        # Pure lexical search using $lexical sort
        cursor = self.database.get_collection(self.collection_name).find(
            filter_dict,
            sort={'$lexical': query.text},  # Native BM25 lexical search
            limit=docFilter.limit,
            skip=docFilter.offset,
            projection={'$vector': 0},
        )

        # Convert results to your Doc format
        docs = self._convertToDocs(cursor)

        return docs

    @_backend_errors('searchSemantic')
    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.
        """
        if not self._doesCollectionExist():
            return []

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        filter_dict = self._convertFilter(docFilter)

        # Combine both lexical and vector search
        cursor = self.database.get_collection(self.collection_name).find(
            filter_dict,
            sort={'$vector': query.embedding},  # Automatic embedding generation + search
            limit=docFilter.limit,
            projection={'$lexical': 0},
            include_similarity=True,
            include_sort_vector=True,
        )

        # Convert results to your Doc format, dropping hits under the floor
        docs = self._convertToDocs(cursor, floor=self.effectiveFloor(docFilter))

        return docs

    @_backend_errors('get')
    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve documents matching the filter.

        The offset is applied here, on an unsorted read: ``skip`` needs a sort, and a sorted find
        returns at most 20 documents. Unsorted reads come back in the same order for the same data.
        """
        if checkCollection and not self._doesCollectionExist():
            return []

        collection = self.database.get_collection(self.collection_name)

        filter_dict = self._convertFilter(docFilter)
        offset = max(0, int(docFilter.offset or 0))
        limit = docFilter.limit or 100

        # Execute query: the first offset + limit documents, then drop the offset
        documents = list(collection.find(filter=filter_dict, limit=offset + limit))[offset:]
        return self._convertToDocs(documents)

    @_backend_errors('getPaths')
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        List distinct active parent paths, ordered by path, then paged locally (never the control record).

        Astra collections have no aggregation API. An unsorted cursor follows
        every server page; a server-side sort or limit could truncate the input
        before paths are grouped (a sorted find returns at most 20 documents). Only
        chunk-zero parent/object metadata is read.
        """
        if not self._doesCollectionExist():
            return {}

        # Chunk 0 of the live documents
        match_filter = {'meta.chunkId': 0, 'meta.isDeleted': False}

        if parent is not None:
            match_filter['meta.parent'] = parent

        collection = self.database.get_collection(self.collection_name)
        results = collection.find(
            filter=match_filter, projection={'meta.parent': True, 'meta.objectId': True, '_id': False}
        )

        # Choose the lowest object ID for each path so result order does not
        # change page boundaries when Astra returns chunks in a different order.
        paths: Dict[str, str] = {}
        for result in results:
            metadata = result.get('meta') or {}
            if not isinstance(metadata, dict):
                continue
            parent_path = metadata.get('parent')
            object_id = metadata.get('objectId')
            if not isinstance(parent_path, str) or not parent_path:
                continue
            if not isinstance(object_id, str) or not object_id or object_id == CONTROL_OBJECT_ID:
                continue
            if parent_path not in paths or object_id < paths[parent_path]:
                paths[parent_path] = object_id

        return dict(sorted(paths.items())[offset : offset + limit])

    @_backend_errors('createCollection')
    def createCollection(self, documents: List[Doc]) -> bool:
        """Create the collection as the base does; a client failure is reported without the server address."""
        return super().createCollection(documents)

    @_backend_errors('addChunks')
    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.

        Args:
            chunks: The batch to write.
            checkCollection: Create the collection if it is missing and check that the chunks match its
                embedding model and vector size; createCollection passes False when it writes its control row.
        """
        if not chunks:
            return

        if checkCollection and not self.createCollection(chunks):
            return

        collection = self.database.get_collection(self.collection_name)

        # Clear the documents list
        documents: List[Dict] = []

        # The objects this batch starts over
        objectIds = self.objectIdsToReplace(chunks)

        def flush():
            """Delete the replaced objects (first call only), then insert the queued documents that have a vector."""
            nonlocal documents
            nonlocal objectIds

            # First, delete existing documents if we have objectIds to delete
            if len(objectIds):
                # Delete all documents with these object IDs
                for objectId in objectIds:
                    collection.delete_many({'meta.objectId': objectId})

            def is_valid_vector(vector):
                magnitude = sum(x * x for x in vector) ** 0.5
                return magnitude > 1e-6

            valid_docs = [doc for doc in documents if is_valid_vector(doc.get('$vector', [1]))]

            # Insert the new documents
            if len(valid_docs):
                collection.insert_many(valid_docs)

            # Clear them
            objectIds = []
            documents = []

        # A later batch replaces its own chunks: sent again (a retried flush) it must not store them twice
        later: Dict[str, List[int]] = {}
        for chunk in chunks:
            if chunk.metadata.objectId not in objectIds:
                later.setdefault(chunk.metadata.objectId, []).append(chunk.metadata.chunkId)
        if later:
            clauses = [{'meta.objectId': o, 'meta.chunkId': {'$in': sorted(set(c))}} for o, c in later.items()]
            collection.delete_many(clauses[0] if len(clauses) == 1 else {'$or': clauses})

        # For each document, prepare the data for insertion
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # The control document carries a zero vector, which the Data API rejects (and which
            # is_valid_vector below would drop): store a unit vector instead
            if chunk.metadata.objectId == CONTROL_OBJECT_ID and all(x == 0 for x in embedding):
                embedding = [0.0] * (len(embedding) - 1) + [1.0]

            # Create the document structure for AstraDB: declared metadata fields and
            # the control record's extras, without nulls (they would not read back)
            document = {
                '_id': str(uuid4()),
                '$vector': DataAPIVector(embedding),
                'content': chunk.page_content,
                'meta': _meta_dump(chunk.metadata),
            }

            documents.append(document)

            if len(documents) >= 500:
                flush()

        # Flush any remaining documents
        flush()

    @_backend_errors('remove')
    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self._doesCollectionExist():
            return

        # Build a filter for an object id
        filter_objectId = {'meta.objectId': {'$in': objectIds}}

        collection = self.database.get_collection(self.collection_name)
        collection.delete_many(filter_objectId)
        return

    @_backend_errors('markDeleted')
    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.
        Returns the chunks moved to the trash, counted before the update (None above the
        count ceiling).
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self._doesCollectionExist():
            return 0

        # The chunks this call moves: the ones not in the trash yet
        moving = self.vxChunksInState(objectIds, deleted=False)

        # Build a filter for an object id
        filter_objectId = {'meta.objectId': {'$in': objectIds}}

        # Set all the objects with the given objectId to true
        collection = self.database.get_collection(self.collection_name)
        collection.update_many(filter_objectId, {'$set': {'meta.isDeleted': True}})
        return moving

    @_backend_errors('markActive')
    def markActive(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now 'comes back' after begin deleted.
        Returns the chunks taken out of the trash, counted before the update.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self._doesCollectionExist():
            return 0

        # The chunks this call moves: the ones in the trash
        moving = self.vxChunksInState(objectIds, deleted=True)

        # Build a filter for an object id
        filter_objectId = {'meta.objectId': {'$in': objectIds}}

        # Set all the objects with the given objectId to true
        collection = self.database.get_collection(self.collection_name)
        collection.update_many(filter_objectId, {'$set': {'meta.isDeleted': False}})
        return moving

    # Since chunks are returned in any order, and a single objectId
    # may contain tens of thousands of chunks, we grave them one
    # group at a time (renderChunkSize), put them into an array,
    # join them and call the callback
    @_backend_errors('render')
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self._doesCollectionExist():
            return

        # Get the collection
        collection = self.database.get_collection(self.collection_name)

        # Find all chunks for the objectId
        cursor = collection.find(
            {
                'meta.objectId': objectId,
                'meta.isDeleted': False,  # Only get non-deleted chunks
            }
        )

        # Collect all chunks
        chunks = []
        for document in cursor:
            if 'content' not in document or 'meta' not in document:
                continue

            chunks.append({'chunkId': document['meta']['chunkId'], 'content': document['content']})

        # Sort by chunkId in application code (since AstraDB doesn't guarantee order)
        chunks.sort(key=lambda x: x['chunkId'])

        # Reconstruct document
        full_text = ''.join([chunk['content'] for chunk in chunks])
        callback(full_text)

    # ------------------------------------------------------------------
    # Vector Explorer hooks (docs/development/nodes/vector-tool-contract.md)
    # ------------------------------------------------------------------

    def _collection(self) -> Any:
        """The Data API collection."""
        return self.database.get_collection(self.collection_name)

    def _notControl(self, filter_dict: Dict[str, Any]) -> Dict[str, Any]:
        """``filter_dict`` with the control record excluded."""
        condition = filter_dict.get('meta.objectId')
        if isinstance(condition, dict):
            filter_dict['meta.objectId'] = {**condition, '$ne': CONTROL_OBJECT_ID}
        elif condition is None:
            filter_dict['meta.objectId'] = {'$ne': CONTROL_OBJECT_ID}
        return filter_dict

    def _toDoc(self, document: Dict[str, Any], *, with_vector: bool = False) -> Doc:
        """A Doc from a stored document; carries ``metadata.pointId`` and, on request, the embedding."""
        metadata = _meta_load(document.get('meta') or {})
        metadata.pointId = str(document.get('_id'))
        doc = Doc(score=0, page_content=document.get('content') or '', metadata=metadata)
        if with_vector:
            doc.embedding = [float(x) for x in document.get('$vector') or []]
        return doc

    def _readControl(self) -> Tuple[Optional[bool], Optional[int], Optional[str]]:
        """(control record present, vector size, model) read from the control record."""
        rows = list(self._collection().find({'meta.objectId': CONTROL_OBJECT_ID}, limit=2, projection={'meta': True}))
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

    @_backend_errors('describe')
    def describe(self) -> StoreInfo:
        """Describe the collection; never raises for a missing one and never names the endpoint."""
        caveats = ['experimental', 'cloud_only_unverified', 'extras_not_stored']
        if not self._doesCollectionExist():
            return StoreInfo(
                backend='astra',
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
        metric = self.similarity
        try:
            vector = getattr(self._collection().options(), 'vector', None)
            if vector is not None:
                metric = getattr(vector, 'metric', None) or metric
                if dimension is None:
                    dimension = getattr(vector, 'dimension', None)
        except Exception:
            pass
        return StoreInfo(
            backend='astra',
            backend_version=None,
            collection=self.collection_name,
            collection_exists=True,
            control_record=control,
            meta_column=None,
            metric=METRICS.get(str(metric)),
            dimension=dimension,
            model=model,
            index={'type': 'vector', 'metric': str(metric), 'params': {}},
            size_bytes=None,
            caveats=caveats,
        )

    def scoreInfo(self) -> Dict[str, Any]:
        """How Doc.score is computed on Astra: the Data API's normalised $similarity."""
        if self.similarity == 'euclidean':
            formula = '1 / (1 + squared euclidean distance)'
        elif self.similarity == 'dot_product':
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
        """Chunks matching ``docFilter``, control record excluded; None above the count ceiling."""
        if not self._doesCollectionExist():
            return 0
        return self._countWhere(self._notControl(self._convertFilter(docFilter)))

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
        One page of documents: chunk-0 documents in storage order, paged with the Data API's page state.

        The read is unsorted because a sorted find returns at most 20 documents. A document whose
        chunk 0 is missing is not listed. Chunk counts are not reported (one count request per
        document is too costly); the total is unknown above the count ceiling.
        """
        state, skip, first_of_listing = _decode_cursor(cursor)
        limit = max(1, int(limit))
        caveats = ['documents_unsorted', 'documents_by_first_chunk', 'extras_not_stored']

        # No collection, or an empty id list (no document asked for): an empty last page
        if (object_ids is not None and not object_ids) or not self._doesCollectionExist():
            return DocPage(
                items=[], next_cursor=None, total=0, counts_exact=False, distinct=False, sorted=False, caveats=caveats
            )

        first_chunks = self._notControl(
            self._convertFilter(
                DocFilter(chunkIds=[0], objectIds=list(object_ids) if object_ids else None), deleted=deleted
            )
        )

        def object_of(document: Dict[str, Any]) -> Optional[str]:
            return (document.get('meta') or {}).get('objectId')

        served: List[Dict[str, Any]] = []
        next_cursor: Optional[str] = None
        for _ in range(limit + 2):
            options = {'initial_page_state': state} if state else {}
            page = self._collection().find(filter=first_chunks, projection={'meta': True}, **options).fetch_next_page()
            results = list(page.results or [])

            # The backend ignored the page state: it answered the listing's first page again
            if state and results and first_of_listing is not None and object_of(results[0]) == first_of_listing:
                caveats = caveats + ['documents_paging_unsupported']
                next_cursor = None
                break
            if state is None and skip == 0 and first_of_listing is None and results:
                first_of_listing = object_of(results[0])

            remaining = results[skip:]
            room = limit - len(served)
            served.extend(remaining[:room])
            if len(remaining) > room:
                # Stopped inside this page: resume from the same page state, further in
                next_cursor = _encode_cursor(state, skip + room, first_of_listing)
                break
            if not page.next_page_state:
                break
            state, skip = page.next_page_state, 0
            if len(served) >= limit:
                next_cursor = _encode_cursor(state, 0, first_of_listing)
                break

        # No chunk counts: the Data API has no group-by, and a count per document would cost one
        # request per row (the contract allows chunks=None when counting is not cheap)
        items: List[DocumentRow] = []
        seen = set()
        for document in served:
            meta = document.get('meta') or {}
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
                    size=None,
                    modifyTime=None,
                    ingestedAt=None,
                    pointId=str(document.get('_id')),
                )
            )

        return DocPage(
            items=items,
            next_cursor=next_cursor,
            total=self._countWhere(first_chunks),
            counts_exact=False,
            distinct=False,
            sorted=False,
            caveats=caveats,
        )

    def _chunkWindow(self, document: Dict[str, Any], low: int, high: int, *, probe: bool = False) -> List[Doc]:
        """Chunks of one document with low < chunkId <= high (unsorted read; ``probe``: at most one)."""
        filter_dict = dict(document)
        filter_dict['meta.chunkId'] = {'$gt': low, '$lte': high}
        rows = self._collection().find(
            filter=filter_dict, limit=1 if probe else None, projection={'meta': True, 'content': True}
        )
        return [self._toDoc(row) for row in rows]

    def _chunkAfter(self, document: Dict[str, Any], high: int) -> bool:
        """Whether the document has a chunk with chunkId > high."""
        filter_dict = dict(document)
        filter_dict['meta.chunkId'] = {'$gt': high}
        return bool(list(self._collection().find(filter=filter_dict, limit=1, projection={'meta': True})))

    @_backend_errors('scrollChunks')
    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str) -> ChunkPage:
        """
        The chunks of one document after ``after_chunk``, in chunk order, without embeddings.

        Reads the window of chunk ids (after_chunk, after_chunk + limit] unsorted and orders it here
        (a sorted find returns at most 20 documents). When the window is empty but the document
        goes on, the next chunk id is found with a few one-row probes and the window starts there.
        """
        after_chunk = int(after_chunk)
        limit = max(1, int(limit))
        if objectId == CONTROL_OBJECT_ID or not self._doesCollectionExist():
            return ChunkPage(docs=[], has_more=False, next_after=after_chunk)

        document = self._convertFilter(DocFilter(objectIds=[objectId]), deleted=deleted)
        low = after_chunk
        docs = self._chunkWindow(document, low, low + limit)
        more = self._chunkAfter(document, low + limit)
        if not docs and more:
            first = _first_chunk_after(
                lambda lo, hi: bool(self._chunkWindow(document, lo, hi, probe=True)), low + limit, limit
            )
            if first is not None:
                low = first - 1
                docs = self._chunkWindow(document, low, low + limit)
                more = self._chunkAfter(document, low + limit)
        docs = _one_per_chunk(docs)
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
        """Up to ``n`` chunks with embeddings in storage order ('first'); stratified is not native."""
        if strategy == 'stratified':
            raise StoreUnsupported('sampleChunks(strategy="stratified") is not native on Astra DB')
        if not self._doesCollectionExist():
            return [], 'first'
        pinned = {(str(o), int(c)) for o, c in include_keys or []}
        documents = self._collection().find(
            filter=self._notControl(self._convertFilter(docFilter)),
            limit=max(1, int(n)) + len(pinned),
            projection={'$vector': True, 'content': True, 'meta': True},
        )
        docs = []
        for document in documents:
            doc = self._toDoc(document, with_vector=True)
            if (doc.metadata.objectId, doc.metadata.chunkId) in pinned:
                continue
            docs.append(doc)
            if len(docs) >= n:
                break
        return docs, 'first'

    @_backend_errors('getVectors')
    def getVectors(self, keys: Sequence[Tuple[str, int]]) -> List[Doc]:
        """Chunks with embeddings for ``keys`` (by filter: ids are random), in request order."""
        wanted = [(str(o), int(c)) for o, c in keys or [] if o != CONTROL_OBJECT_ID]
        if not wanted or not self._doesCollectionExist():
            return []
        found: Dict[Tuple[str, int], Doc] = {}
        for object_ids, chunk_ids in _key_batches(wanted):
            documents = self._collection().find(
                filter={'meta.objectId': {'$in': object_ids}, 'meta.chunkId': {'$in': chunk_ids}},
                limit=len(object_ids) * len(chunk_ids),
                projection={'$vector': True, 'content': True, 'meta': True},
            )
            for document in documents:
                doc = self._toDoc(document, with_vector=True)
                found.setdefault((doc.metadata.objectId, doc.metadata.chunkId), doc)
        return [found[key] for key in wanted if key in found]

    @_backend_errors('removeCounted')
    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Remove every chunk of ``objectIds``; return the rows removed."""
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        counted = self._countWhere({'meta.objectId': {'$in': ids}})
        result = self._collection().delete_many({'meta.objectId': {'$in': ids}})
        deleted = _field(result, 'deleted_count')
        return counted if counted is not None else deleted

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those, in one operation; return the rows removed.

        The deleted flag is part of the delete's own filter, so a chunk a concurrent ``restore`` has just made
        live is never removed. Never the control record.
        """
        ids = [o for o in objectIds or [] if o != CONTROL_OBJECT_ID]
        if not ids or not self._doesCollectionExist():
            return 0
        trashed = {'meta.objectId': {'$in': ids}, 'meta.isDeleted': True}
        counted = self._countWhere(trashed)
        result = self._collection().delete_many(trashed)
        deleted = _field(result, 'deleted_count')
        return counted if counted is not None else deleted
