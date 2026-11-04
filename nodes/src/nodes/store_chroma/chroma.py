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

from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Set, Tuple
import chromadb
from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config
from nodes.store_chroma.mode import is_local
from rocketlib import debug
import base64
import binascii
import json
import math
import random
import uuid
import sys
import re


# Minimum rescaled [0, 1] similarity for a result to count as relevant; below
# this it is dropped as noise. A caller that sets DocFilter.minScore (the
# explorer tools) overrides it.
MIN_RELEVANCE_SCORE = 0.20

# objectId of the collection's control record (model name and vector size).
CONTROL_OBJECT_ID = 'schema'


def point_id_for(objectId: str, chunkId: int) -> str:
    """
    Return the deterministic record id of a chunk: uuid5(NAMESPACE_URL, 'objectId#chunkId').

    Rows written before this id scheme carry random ids; every read by key
    falls back to a filter on objectId/chunkId for those.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'{objectId}#{int(chunkId)}'))


def _vx():
    """The explorer value types, imported on use (the driver also loads on an older ai package)."""
    from ai.common.store import vx_types

    return vx_types


def _errors():
    from ai.common.store import errors

    return errors


def _where(*clauses: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Combine where clauses: None when empty, the clause alone, else $and (Chroma needs two or more)."""
    parts: List[Dict[str, Any]] = []
    for clause in clauses:
        if not clause:
            continue
        if set(clause) == {'$and'}:
            parts.extend(clause['$and'])
        else:
            parts.append(clause)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else {'$and': parts}


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_list(vector: Any) -> List[float]:
    """An embedding as a plain list of floats (the client returns numpy arrays)."""
    if vector is None:
        return []
    if hasattr(vector, 'tolist'):
        vector = vector.tolist()
    return [float(v) for v in vector]


# Minimum Chroma *server* version this client supports, as (major, minor). The v2
# tenant/database API the modern client requires landed in Chroma 0.6.0; older servers
# (e.g. 0.5.18) fail cryptically (KeyError('_type')) instead of indexing. The project's
# own test infra runs chromadb/chroma:0.6.3, which works.
_MIN_CHROMA_VERSION = (0, 6)


def _check_server_version(version: str) -> None:
    """
    Raise a clear error if the connected Chroma server is too old.

    Lenient by design: if the version string can't be parsed (or has no minor component)
    we do not block the connection (the connect-time wrapper still surfaces any hard
    incompatibility).
    """
    match = re.match(r'\s*v?(\d+)\.(\d+)', version or '')
    if match and (int(match.group(1)), int(match.group(2))) < _MIN_CHROMA_VERSION:
        floor = f'{_MIN_CHROMA_VERSION[0]}.{_MIN_CHROMA_VERSION[1]}'
        raise Exception(
            f'Chroma server version {version} is too old; RocketRide requires '
            f'Chroma >= {floor}. Please upgrade your Chroma server.'
        )


class Store(DocumentStoreBase):
    # Explorer capabilities beyond the hooks this class overrides (vx_types.CAPABILITY_KEYS).
    # documents_filter: listDocumentPage applies the filter's has_first_chunk (and names the other keys).
    VX_DRIVER_CAPABILITIES = frozenset({'documents_distinct', 'search_keyword', 'documents_filter'})

    # dialect.keyword_match: searchKeyword is where_document {'$contains': text}, which matches text fragments.
    VX_KEYWORD_MATCH = 'substring'

    # Support level reported by the explorer's dialect: the unmocked live suite
    # (nodes/test/test_store_chroma_full.py) runs on a new and a legacy collection.
    VX_SUPPORT = 'supported'

    # Records read per request when a hook walks a filtered set (counts, sweeps).
    READ_PAGE = 5000

    # Most rows the sweep for documents without chunk 0 reads; beyond it the
    # listing ends with the caveat 'document_count_capped'.
    SWEEP_ROWS_CAP = 200000

    # Most objectIds in one `$in` list when deleting or marking documents.
    # chromadb 1.5.9 binds every value as an SQL variable and refuses a list of
    # about 32,760 values ("too many SQL variables"); an engine delete can name more.
    ID_LIST_MAX = 1000

    apikey: str | None = None
    node: str = 'chroma'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    top_k: int | None = None
    client: chromadb.HttpClient
    collectionObj: chromadb.Collection | None = None

    # Upper bound for the configured top_k. Generous enough for reranker
    # fan-in (40x the data-lane default of 25, 10x the chroma.search tool's
    # own cap of 100) while keeping a fat-fingered value from turning a query
    # into a full-collection scan.
    MAX_TOP_K: int = 1000

    @staticmethod
    def _coerceBool(value: Any) -> bool:
        """Read a boolean that may arrive as a string from an env-var placeholder."""
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ('false', '0', 'no', 'off'):
            return False
        # An unresolved '${...}' placeholder is not a deliberate 'off', so it
        # keeps the safe default rather than silently dropping TLS.
        return True

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the chroma vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.host = re.sub(r'^https?://', '', config.get('host', 'localhost').strip()).rstrip('/')
        self.port = self._coercePort(config.get('port', 8000))
        self.threshold_search = config.get('score', 0.5)

        # Optional per-node retrieval limit. When set, it controls how many
        # candidate documents are fetched from Chroma before score filtering,
        # overriding the incoming DocFilter default (25). Left unset it falls
        # back to the caller-supplied limit, so existing pipelines are unchanged.
        self.top_k = self._coerceTopK(config.get('top_k', None))

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        # Chroma Cloud multi-tenancy - both are required by Chroma Cloud
        # accounts and optional for self-hosted servers
        self.tenant = (config.get('tenant') or '').strip() or None
        self.database = (config.get('database') or '').strip() or None

        # TLS for the cloud/remote profile. Defaults on, since Chroma Cloud is
        # HTTPS-only; a self-hosted server behind plain HTTP turns it off.
        self.ssl = self._coerceBool(config.get('ssl', True))

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.payload_limit = config.get('payloadLimit', self.payload_limit)

        # Read the same way as the key check (IGlobal._credentials), so the key is
        # checked exactly when it is sent.
        local = is_local(config)

        # check if the similarity matches qdrant configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'l2', 'ip']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required chroma configurations')

        # The Chroma client connects eagerly (identity/tenant validation on construction),
        # so an incompatible/old server surfaces here as a cryptic error (e.g.
        # KeyError('_type')). Wrap it so the user gets an actionable message instead of a
        # silent failure.
        try:
            if local:
                self.client = chromadb.HttpClient(host=self.host, port=self.port)
            else:
                # Cloud / remote server. Chroma Cloud only serves HTTPS, and a
                # plain HTTP request against the TLS port hangs or is rejected
                # with "illegal request line" -- so TLS is the default. It stays
                # configurable because this profile also covers a self-hosted
                # server reached over plain HTTP with token auth, which the
                # removed Settings path supported and which would otherwise lose
                # its only working configuration.
                # The API key travels in the x-chroma-token header, and Chroma
                # Cloud additionally requires the tenant and database.
                kwargs: Dict[str, Any] = {}
                if self.tenant:
                    kwargs['tenant'] = self.tenant
                if self.database:
                    kwargs['database'] = self.database
                self.client = chromadb.HttpClient(
                    host=self.host,
                    port=self.port,
                    ssl=self.ssl,
                    headers={'x-chroma-token': self.apikey} if self.apikey else None,
                    **kwargs,
                )
        except Exception as e:
            self.client = None
            floor = f'{_MIN_CHROMA_VERSION[0]}.{_MIN_CHROMA_VERSION[1]}'
            raise Exception(
                'Failed to connect to Chroma. This may be due to '
                f'network/connectivity issues, invalid host/port/credentials, or an '
                f'incompatible/too-old Chroma server (RocketRide requires Chroma server '
                f'>= {floor}). Original error: {e}'
            ) from e

        self._enforceServerVersion()
        return

    def __del__(self):
        """
        Deinitialize the chroma client.
        """
        # Deinit everything we did
        self.apikey = None
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'
        self.client = None
        self.collectionObj = None

    @staticmethod
    def _coercePort(value: Any, default: int = 8000) -> int:
        """
        Coerce a configured port to an int for the chromadb HTTP client.

        The port schema accepts both a number and a string so env-var
        interpolation (which always yields a string, e.g.
        '${ROCKETRIDE_CHROMA_PORT}') validates. Normalize here: pass ints and
        whole-number floats through, parse numeric strings, reject values
        outside the valid TCP port range 1-65535, and fall back to ``default``
        for anything unparseable, such as an unresolved placeholder, rather than
        crashing the client, which requires an int.
        """
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            parsed = value
        elif isinstance(value, float):
            # A JSON 'number' may arrive as a float (e.g. 8443.0). Accept
            # whole-number floats; a fractional port is invalid, so fall back.
            if not value.is_integer():
                debug(f'chroma: port {value!r} is not a whole number; using default {default}')
                return default
            parsed = int(value)
        elif isinstance(value, str):
            try:
                parsed = int(value.strip())
            except ValueError:
                debug(f'chroma: port {value!r} is not numeric (unresolved env var?); using default {default}')
                return default
        else:
            return default
        if not 1 <= parsed <= 65535:
            debug(f'chroma: port {parsed} is out of range 1-65535; using default {default}')
            return default
        return parsed

    @staticmethod
    def _coerceTopK(value: Any) -> int | None:
        """
        Validate the configured top_k and coerce it to a positive int, or None.

        Accepts an int, a whole-number float, or an integer string, rejecting
        bool. Like the port field, the schema accepts both a number and a
        string because env-var interpolation always yields a string (e.g.
        '${ROCKETRIDE_TOP_K}').

        Returns None -- meaning "no override", so retrieval falls back to the
        incoming DocFilter limit -- for an unset/blank value and for a still
        unresolved '${...}' placeholder. Falling back to the *absence of an
        override* is the correct answer here rather than a hardcoded 25: the
        whole design is that an unset top_k means "use the caller's limit".

        An explicit but malformed value still raises: a fractional number, a
        non-integer string, or anything outside 1..``MAX_TOP_K`` is a pipeline
        misconfiguration this node deliberately rejects instead of quietly
        retrieving a different number of documents than the author asked for.

        Note: this deliberately does not reuse ``ai.common.utils.config_int``.
        That helper always returns an int (never None, so "unset" could not
        fall back to ``docFilter.limit``), treats ``<= 0`` as "unspecified",
        and silently clamps out-of-range values instead of raising. Here an
        out-of-range top_k is a pipeline misconfiguration worth failing on at
        startup rather than quietly retrieving a different number of documents
        than the author asked for. Do not "simplify" this to ``config_int``
        without changing those semantics on purpose.
        """
        if value is None:
            return None
        invalid = f'top_k must be an integer 1..{Store.MAX_TOP_K}, got {value!r}'
        # bool is an int subclass; reject it explicitly.
        if isinstance(value, bool):
            raise ValueError(invalid)
        if isinstance(value, int):
            parsed = value
        elif isinstance(value, float):
            # A JSON 'number' may arrive as a float (e.g. 50.0). Accept
            # whole-number floats; a fractional top_k is meaningless.
            if not value.is_integer():
                raise ValueError(invalid)
            parsed = int(value)
        elif isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            # An unresolved '${...}' placeholder is not a limit the author
            # chose, so it falls back to the caller's limit rather than
            # failing the node -- the same fallback _coercePort makes.
            if re.fullmatch(r'\$\{[^{}]+\}', text):
                debug("chroma: top_k contains an unresolved env var; using the caller's DocFilter.limit")
                return None
            try:
                parsed = int(text)
            except ValueError:
                raise ValueError(invalid) from None
        else:
            raise ValueError(invalid)
        if not 1 <= parsed <= Store.MAX_TOP_K:
            raise ValueError(invalid)
        return parsed

    def _effectiveLimit(self, docFilter: DocFilter) -> int | None:
        """
        Resolve the retrieval limit: the configured top_k wins when set,
        otherwise the caller-supplied DocFilter limit is used.
        """
        if self.top_k is not None:
            return self.top_k
        return docFilter.limit

    def _getServerVersion(self) -> str | None:
        """
        Return the Chroma server version string, or None if it can't be determined.

        Defensive: the pinned `chromadb-client` (1.5.9) does expose get_version(), but a
        probe that is absent, fails, or returns a non-string must not be mistaken for a
        connection error — the connect wrapper and index-path guards cover hard incompat.
        """
        getter = getattr(self.client, 'get_version', None)
        if not callable(getter):
            return None
        try:
            version = getter()
            return version if isinstance(version, str) else None
        except Exception:
            return None

    def _enforceServerVersion(self) -> None:
        """
        Reject a server below the supported floor, dropping the client handle with it.

        An unknown version is not a rejection (see _getServerVersion). When the floor does
        reject, the handle is cleared first so a caller that survives the raise cannot keep
        issuing calls against a server we just declared incompatible — matching the
        connect-failure path above.
        """
        server_version = self._getServerVersion()
        if not server_version:
            return
        try:
            _check_server_version(server_version)
        except Exception:
            self.client = None
            raise

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        # Normalize across client versions: list_collections() returns collection *names*
        # (strings) on some versions and Collection *objects* (with a .name) on others.
        collections = self.client.list_collections()
        names = [c if isinstance(c, str) else getattr(c, 'name', c) for c in collections]
        if self.collection in names:
            if self.collectionObj is None:
                self.collectionObj = self.client.get_collection(name=self.collection)
            return True
        else:
            return False

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a new ChromaDB collection, even if one already exists.

        Ensures metadata fields are stored for efficient querying.
        """
        try:
            # Create a new collection
            self.collectionObj = self.client.get_or_create_collection(
                name=self.collection,
                metadata={
                    'hnsw:space': self.similarity  # Similarity metric (cosine, L2, etc.)
                },
            )

            return True

        except Exception as e:
            # Surface the real cause instead of swallowing it into a transient trace.
            # The only caller (base createCollection) ignores the return value, so a
            # bare `return False` here left collectionObj as None and produced a cryptic
            # "'NoneType' object has no attribute 'delete'" crash downstream in flush().
            raise Exception(f'Error creating Chroma collection: {e}') from e

    @staticmethod
    def _deletedClause(deleted: str) -> Optional[Dict[str, Any]]:
        """
        Where clause selecting the 'active', 'deleted' or 'all' rows.

        'active' excludes only rows explicitly marked deleted: a null/absent
        isDeleted (the client strips None via exclude_none) must still count as
        not deleted, so use $ne True (which matches absent-key records).
        """
        if deleted == 'deleted':
            return {'isDeleted': {'$eq': True}}
        if deleted == 'all':
            return None
        return {'isDeleted': {'$ne': True}}

    @staticmethod
    def _selectsNothing(docFilter: DocFilter) -> bool:
        """
        Whether a list filter of ``docFilter`` is empty, so it matches no row.

        Chroma refuses ``$in: []``; the callers answer an empty result instead
        of asking the server (as Qdrant does for the same filter).
        """
        lists = (docFilter.objectIds, docFilter.tableIds, docFilter.permissions, docFilter.chunkIds)
        return any(value is not None and len(value) == 0 for value in lists)

    def _convertFilter(self, docFilter: DocFilter) -> Dict[str, Any]:
        filters = []
        if docFilter.nodeId is not None:
            filters.append({'nodeId': {'$eq': docFilter.nodeId}})
        if docFilter.isTable is not None:
            filters.append({'isTable': {'$eq': docFilter.isTable}})
        if docFilter.tableIds is not None:
            filters.append({'tableId': {'$in': docFilter.tableIds}})
        if docFilter.parent is not None:
            filters.append({'parent': {'$eq': docFilter.parent}})
        if docFilter.permissions is not None:
            filters.append({'permissionId': {'$in': docFilter.permissions}})
        if docFilter.objectIds is not None:
            filters.append({'objectId': {'$in': docFilter.objectIds}})
        # Which rows by their deleted flag: DocFilter.deleted when set, otherwise
        # isDeleted None/False selects the active rows and True every row.
        deleted = self._deletedClause(self.resolveDeleted(docFilter))
        if deleted is not None:
            filters.append(deleted)
        if docFilter.chunkIds is not None:
            filters.append({'chunkId': {'$in': docFilter.chunkIds}})
        # If we are min chunk id, add a condition
        if docFilter.minChunkId is not None:
            filters.append({'chunkId': {'$gte': docFilter.minChunkId}})

        # If we are max chunk id, add a condition
        if docFilter.maxChunkId is not None:
            filters.append({'chunkId': {'$lte': docFilter.maxChunkId}})
        if len(filters) > 1:
            return {'$and': filters}
        elif len(filters) == 1:
            return filters[0]
        else:
            return None

    def _space(self) -> str:
        """The collection's distance space ('cosine', 'l2' or 'ip'); the configured one until it exists."""
        collection = self.__dict__.get('collectionObj')
        if collection is None and self._exists():
            # Not read yet on this instance: the collection's space wins over the configuration.
            collection = self.__dict__.get('collectionObj')
        if collection is not None:
            config = getattr(collection, 'configuration_json', None)
            space = ((config or {}).get('hnsw') or {}).get('space') if isinstance(config, dict) else None
            if not space:
                space = (getattr(collection, 'metadata', None) or {}).get('hnsw:space')
            if space in ('cosine', 'l2', 'ip'):
                return space
            if space is None and isinstance(getattr(collection, 'metadata', None), dict):
                return 'l2'  # Chroma's default space
        return self.similarity

    @staticmethod
    def _distanceToScore(distance: float, space: str) -> float:
        """
        Map a Chroma distance in ``space`` to a score where higher means closer.

        cosine (1 - cos) and ip (1 - dot): (2 - d) / 2, i.e. (1 + similarity) / 2.
        l2 (squared euclidean): 1 / (1 + euclidean distance).
        """
        distance = float(distance)
        if space == 'l2':
            return 1.0 / (1.0 + math.sqrt(max(distance, 0.0)))
        return (2.0 - distance) / 2.0

    def _convertToDocs(self, results: Dict, floor: float = MIN_RELEVANCE_SCORE) -> List[Doc]:
        """
        Convert ChromaDB results to a list of Docs.

        Query results (with distances) below ``floor`` are dropped.
        """
        docs: List[Doc] = []
        # The space the distances were measured in (read once per result set)
        space = self._space() if results.get('distances', None) is not None else None

        # Now we need to unwrap each list of ndarrays returned by Chroma in case of Query
        if results.get('distances', None) is not None:
            results['ids'] = results['ids'][0]
            results['metadatas'] = results['metadatas'][0]
            results['distances'] = results['distances'][0]
            results['documents'] = results['documents'][0]

        # Now, add the documents to the results
        for i in range(len(results['ids'])):
            # Get the payload content and meadata
            metadata = results['metadatas'][i]
            content = results['documents'][i]

            if results.get('distances', None) is not None:
                score = self._distanceToScore(results['distances'][i], space)

                # Ignore it if it doesn't have a high enough score
                if score < floor:
                    continue
            else:
                score = 0.0

            # Create asearc new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            docs.append(doc)
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
        # The collection's record count (control record included, as before);
        # count() is answered by the server without reading every id.
        return int(self.collectionObj.count())

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

        # An empty id list matches nothing (and Chroma refuses it)
        if self._selectsNothing(docFilter):
            return []

        # Build up the filter
        filters = self._convertFilter(docFilter)

        results = self.collectionObj.get(
            where=filters,
            where_document={'$contains': query.text},
            offset=docFilter.offset,
            limit=self._effectiveLimit(docFilter),
            include=['metadatas', 'documents'],
        )

        # Convert the points into groups
        docs = self._convertToDocs(results)

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
        filters = self._convertFilter(docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise ValueError('Non-zero offset is not supported in semantic searching')

        # An empty id list matches nothing (and Chroma refuses it)
        if self._selectsNothing(docFilter):
            return []

        # Perform the search
        results = self.collectionObj.query(
            query_embeddings=[query.embedding], n_results=self._effectiveLimit(docFilter), where=filters
        )

        # Convert the points into groups, applying the score floor (DocFilter.minScore or the legacy floor)
        docs = self._convertToDocs(results, self.effectiveFloor(docFilter))

        # Return them
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve document groups matching a given filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # An empty id list matches nothing (and Chroma refuses it)
        if self._selectsNothing(docFilter):
            return []

        # Convert filter to ChromaDB format
        filter_dict = self._convertFilter(docFilter)

        # Perform the query
        #
        # Note: get() is an exact-fetch path (QuestionType.GET and, internally,
        # full-table/full-document rehydration). It must honor the caller's
        # limit directly — the node-level top_k applies only to similarity
        # search (searchSemantic/searchKeyword), not to whole-object fetches.
        results = self.collectionObj.get(
            where=filter_dict,
            offset=docFilter.offset,
            limit=docFilter.limit,
        )

        # Convert results to Docs
        return self._convertToDocs(results)

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Retrieve unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Base filter: first chunks of active documents, never the control record
        filter_dict = _where(
            {'chunkId': {'$eq': 0}},
            {'objectId': {'$ne': CONTROL_OBJECT_ID}},
            {'isDeleted': {'$ne': True}},
            {'parent': {'$eq': parent}} if parent is not None else None,
        )

        # Perform the query
        results = self.collectionObj.get(where=filter_dict, limit=limit, offset=offset, include=['metadatas'])

        # Build paths dictionary
        paths = {}
        for i in range(len(results['ids'])):
            metadata = results['metadatas'][i]
            parent_id = metadata.get('parent', None)
            object_id = metadata.get('objectId', None)

            if parent_id and object_id:
                paths[parent_id] = object_id

        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the ChromaDB collection.

        Args:
            chunks: A list of Doc objects containing the chunks to add.
            check_collection: Whether to check if the collection exists. (In ChromaDB, creation is handled in init)
        """
        if not chunks:
            return

        # Create the collection if needed
        if checkCollection and not self.createCollection(chunks):
            return

        # The objects this batch starts over
        object_ids_to_delete = self.objectIdsToReplace(chunks)
        ids: List[str] = []
        embeddings: List[List[float]] = []
        metadatas: List[Dict] = []
        documents: List[str] = []

        def flush():
            """Delete the replaced objects on the first call, then upsert the queued chunks."""
            nonlocal ids, embeddings, metadatas, documents
            # One record per id: a later chunk with the same key replaces an earlier one
            # (the server refuses duplicate ids in one upsert).
            if len(set(ids)) != len(ids):
                last = {record_id: index for index, record_id in enumerate(ids)}
                keep = sorted(last.values())
                ids[:] = [ids[i] for i in keep]
                embeddings[:] = [embeddings[i] for i in keep]
                metadatas[:] = [metadatas[i] for i in keep]
                documents[:] = [documents[i] for i in keep]
            # Defense in depth: never index against a missing collection. Surface a clear,
            # actionable error instead of a cryptic "'NoneType' object has no attribute
            # 'delete'" if the collection was not created (e.g. a failed/incompatible server).
            if self.collectionObj is None:
                raise Exception(
                    'Chroma collection is not available (creation may have failed); cannot '
                    'index documents. Check the Chroma server connection and version.'
                )
            if object_ids_to_delete:
                # $in lists, not an $or with a clause per document: the server refuses an
                # expression deeper than about 1,000 clauses.
                for batch in self._idBatches(object_ids_to_delete):
                    self.collectionObj.delete(where={'objectId': {'$in': batch}})
                object_ids_to_delete.clear()

            if ids:
                self.collectionObj.upsert(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)
                ids.clear()
                embeddings.clear()
                metadatas.clear()
                documents.clear()

        sum_size = 0
        cur_size = 0

        for chunk in chunks:
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            metadata = {k: v for k, v in chunk.metadata.toDict().items() if v is not None}

            # The id is derived from (objectId, chunkId), so a key maps to one record
            ids.append(point_id_for(chunk.metadata.objectId, chunk.metadata.chunkId))
            embeddings.append(embedding)
            metadatas.append(metadata)
            documents.append(chunk.page_content)

            tmp_struct = {'content': chunk.page_content, 'meta': metadata, 'vector': embedding}
            cur_size = sys.getsizeof(tmp_struct)
            sum_size += cur_size

            if len(ids) >= 500 or (sum_size + cur_size > self.payload_limit):
                flush()
                cur_size = 0
                sum_size = 0

        flush()

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

        # Delete the points with the given object Id
        for batch in self._idBatches(objectIds):
            self.collectionObj.delete(where={'objectId': {'$in': batch}})

        return

    def markDeleted(self, objectIds: List[str]) -> int:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.

        @returns: The number of chunks moved to the trash.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return 0

        return self._setIsDeleted(objectIds, True)

    def markActive(self, objectIds: List[str]) -> int:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted.

        @returns: The number of chunks taken out of the trash.
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not objectIds or not self.doesCollectionExist():
            return 0

        return self._setIsDeleted(objectIds, False)

    def _setIsDeleted(self, objectIds: List[str], value: bool) -> int:
        """Set isDeleted on the records of ``objectIds`` in the other state (update takes ids and full metadata).

        A record without the flag reads as active. Returns the records changed.
        """
        moved = 0
        for batch in self._idBatches(objectIds):
            results = self.collectionObj.get(where={'objectId': {'$in': batch}}, include=['metadatas'])
            pairs = [
                (rid, meta or {})
                for rid, meta in zip(results.get('ids') or [], results.get('metadatas') or [])
                if bool((meta or {}).get('isDeleted')) != value
            ]
            if not pairs:
                continue
            ids = [rid for rid, _meta in pairs]
            metadatas = [{**meta, 'isDeleted': value} for _rid, meta in pairs]
            # The HTTP client refuses one request above the server's batch limit, which it reports;
            # a document with many chunks is updated in slices.
            size = self._maxBatchSize(fallback=len(ids))
            for start in range(0, len(ids), size):
                self.collectionObj.update(ids=ids[start : start + size], metadatas=metadatas[start : start + size])
            moved += len(ids)
        return moved

    def _maxBatchSize(self, fallback: int) -> int:
        """
        Return the largest batch the connected server accepts, as the client reports it.

        @param fallback: The size to use when the client cannot report one.
        """
        get_max = getattr(getattr(self, 'client', None), 'get_max_batch_size', None)
        size = get_max() if callable(get_max) else None
        return size if isinstance(size, int) and not isinstance(size, bool) and size > 0 else max(fallback, 1)

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Render the complete document.

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
            filter = {
                '$and': [
                    {
                        'chunkId': {
                            '$gte': offset,
                        }
                    },
                    {
                        'chunkId': {
                            '$lt': offset + self.renderChunkSize,
                        }
                    },
                    {
                        'objectId': {
                            '$eq': objectId,
                        }
                    },
                ]
            }
            results = self.collectionObj.get(
                where=filter, include=['documents', 'metadatas'], limit=self.renderChunkSize
            )
            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            text: List[str] = [''] * self.renderChunkSize
            lastIndex = -1
            for i in range(len(results['ids'])):
                # Get the info
                metadata = results['metadatas'][i] or {}
                content = results['documents'][i]
                chunk = metadata.get('chunkId', 0)

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
    # Reading helpers
    # ------------------------------------------------------------------

    def _exists(self) -> bool:
        """Whether the collection exists (no control-record read)."""
        return bool(self.collection) and self._doesCollectionExist()

    def _idBatches(self, object_ids: Iterable[str]) -> Iterator[List[str]]:
        """The distinct ``object_ids`` in lists of at most ``ID_LIST_MAX``, for `$in` filters."""
        ids = [str(oid) for oid in dict.fromkeys(object_ids)]
        step = max(1, int(self.ID_LIST_MAX))
        for start in range(0, len(ids), step):
            yield ids[start : start + step]

    def _readAll(
        self, where: Optional[Dict[str, Any]], include: List[str], cap: Optional[int] = None
    ) -> Iterator[Tuple[str, Dict[str, Any]]]:
        """
        Yield (id, row) for every record matching ``where``, ``READ_PAGE`` at a time.

        ``row`` holds the included fields of one record ('metadata', 'document',
        'embedding'). Stops after ``cap`` records when given.
        """
        offset = 0
        page = max(1, int(self.READ_PAGE))
        while True:
            results = self.collectionObj.get(where=where, include=list(include), limit=page, offset=offset)
            ids = list(results.get('ids') or [])
            for index, record_id in enumerate(ids):
                if cap is not None and offset + index >= cap:
                    return
                yield record_id, self._row(results, index)
            if len(ids) < page:
                return
            offset += page

    @staticmethod
    def _row(results: Dict[str, Any], index: int) -> Dict[str, Any]:
        row: Dict[str, Any] = {}
        for field, key in (('metadatas', 'metadata'), ('documents', 'document'), ('embeddings', 'embedding')):
            values = results.get(field)
            if values is not None:
                row[key] = values[index]
        return row

    def _rowToDoc(self, record_id: str, row: Dict[str, Any], *, with_vector: bool = False) -> Doc:
        """A Doc from a stored record, with ``metadata.pointId`` (and the vector when asked)."""
        meta = {k: v for k, v in (row.get('metadata') or {}).items() if v is not None}
        doc = Doc(
            score=0, page_content=row.get('document') or '', metadata=DocMetadata(**{**meta, 'pointId': record_id})
        )
        if with_vector:
            doc.embedding = _as_list(row.get('embedding'))
        return doc

    def _documentsWhere(self, deleted: str, object_ids: Optional[Sequence[str]], *extra: Optional[Dict[str, Any]]):
        """Records of real documents (never the control record) in the given deleted state."""
        return _where(
            self._deletedClause(deleted),
            {'objectId': {'$ne': CONTROL_OBJECT_ID}},
            {'objectId': {'$in': list(object_ids)}} if object_ids is not None else None,
            *extra,
        )

    # ------------------------------------------------------------------
    # Explorer hooks (docs/development/nodes/vector-tool-contract.md, section 2)
    # ------------------------------------------------------------------

    def scoreInfo(self) -> Dict[str, Any]:
        """How ``Doc.score`` is derived from Chroma's distance for this collection's space."""
        space = self._space()
        if space == 'l2':
            formula, value_range = '1 / (1 + euclidean_distance)', [0, 1]
        elif space == 'ip':
            # [0, 1] only for unit-length vectors; an inner product is otherwise unbounded.
            formula, value_range = '(2 - ip_distance) / 2', None
        else:
            formula, value_range = '(2 - cosine_distance) / 2', [0, 1]
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
        caveats = ['score_scale_inverted_fixed']
        version = self._getServerVersion()
        if not self._exists():
            return vx.StoreInfo(
                backend='chroma',
                backend_version=version,
                collection=self.collection or None,
                collection_exists=False,
                control_record=None,
                meta_column=None,
                metric=self.similarity if self.similarity in ('cosine', 'l2', 'ip') else None,
                dimension=None,
                model=None,
                index=None,
                size_bytes=None,
                caveats=caveats,
            )
        try:
            control = self.doesCollectionExist()
        except Exception:
            control = False
        space = self._space()
        params: Dict[str, Any] = {'space': space}
        config = getattr(self.collectionObj, 'configuration_json', None)
        hnsw = (config or {}).get('hnsw') if isinstance(config, dict) else None
        if isinstance(hnsw, dict):
            # The explorer's names (m, ef_construction); Chroma calls m 'max_neighbors'.
            for key, name in (
                ('max_neighbors', 'm'),
                ('ef_construction', 'ef_construction'),
                ('ef_search', 'ef_search'),
            ):
                if hnsw.get(key) is not None:
                    params[name] = hnsw[key]
        return vx.StoreInfo(
            backend='chroma',
            backend_version=version,
            collection=self.collection,
            collection_exists=True,
            control_record=bool(control),
            meta_column=None,
            metric=space,
            dimension=(self.vectorSize or None) if control else None,
            model=(self.modelName or None) if control else None,
            index={'type': 'hnsw', 'params': params},
            size_bytes=None,
            caveats=caveats,
        )

    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """
        Count the chunk rows matching ``docFilter`` (control record excluded).

        Chroma has no filtered count: this reads the matching ids (no payload),
        ``READ_PAGE`` at a time. The tools cache it (counts_cached_s).
        """
        if not self._exists() or self._selectsNothing(docFilter):
            return 0
        where = _where(self._convertFilter(docFilter), {'objectId': {'$ne': CONTROL_OBJECT_ID}})
        return sum(1 for _ in self._readAll(where, []))

    @staticmethod
    def _encodeCursor(state: Dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(state, separators=(',', ':')).encode()).decode()

    @staticmethod
    def _decodeCursor(cursor: Optional[str]) -> Dict[str, Any]:
        """The listing state in an opaque cursor; a cursor this driver did not issue is refused."""
        if cursor is None:
            return {'ph': 'c', 'o': 0}
        try:
            state = json.loads(base64.urlsafe_b64decode(str(cursor).encode()).decode())
        except (binascii.Error, UnicodeDecodeError, ValueError):
            state = None

        def position(value: Any) -> bool:
            return isinstance(value, int) and not isinstance(value, bool) and value >= 0

        valid = (
            isinstance(state, dict)
            and (
                (state.get('ph') == 'c' and position(state.get('o')))
                or (state.get('ph') == 'o' and position(state.get('i')))
            )
            # 'hf': the has_first_chunk the listing was filtered on (absent when it was not).
            and state.get('hf', None) in (None, True, False)
        )
        if not valid:
            raise _errors().ToolRefusal(
                'INVALID_INPUT', 'The documents cursor is not valid; start from the first page.'
            )
        return state

    @staticmethod
    def _documentRow(
        record_id: str, meta: Dict[str, Any], chunks: Optional[int], tables: Optional[int], has_first: bool
    ):
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
            pointId=record_id,
        )

    def _sweep(self, deleted: str, object_ids: Optional[Sequence[str]]):
        """
        Read every document row's metadata once: (orphans, distinct documents, capped).

        ``orphans`` are the documents without a chunk-0 row, sorted by objectId,
        each with (lowest-chunk record id, its metadata, rows).
        """
        per_object: Dict[str, Dict[str, Any]] = {}
        cap = max(1, int(self.SWEEP_ROWS_CAP))
        read = 0
        capped = False
        # One row past the cap tells a capped sweep from one that read exactly the cap.
        for record_id, row in self._readAll(self._documentsWhere(deleted, object_ids), ['metadatas'], cap=cap + 1):
            if read == cap:
                capped = True
                break
            read += 1
            meta = row.get('metadata') or {}
            oid = str(meta.get('objectId', ''))
            chunk = _int_or_none(meta.get('chunkId'))
            entry = per_object.setdefault(oid, {'rows': 0, 'first': False, 'low': None})
            entry['rows'] += 1
            if chunk == 0:
                entry['first'] = True
            if chunk is not None and (entry['low'] is None or chunk < entry['low'][0]):
                entry['low'] = (chunk, record_id, meta)
        orphans = [
            (oid, entry['low'][1], entry['low'][2], entry['rows'])
            for oid, entry in sorted(per_object.items())
            if not entry['first'] and entry['low'] is not None
        ]
        return orphans, len(per_object), capped

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort, filter=None):
        """
        One page of documents: chunk-0 records by offset, then documents without chunk 0.

        Chunk and table counts come from one metadata read over the page's
        objectIds. Documents without a first chunk are found by reading every
        row's metadata once, after the chunk-0 records are exhausted (at most
        ``SWEEP_ROWS_CAP`` rows; beyond it the caveat ``document_count_capped``);
        that read also gives ``total``, so earlier pages answer total=None.
        Rows are not sorted by path (``sorted=False``).

        ``filter`` (contract section 4.4-A): ``has_first_chunk`` is applied by
        reading only the phase that holds the answer (true: the chunk-0 records,
        and no sweep, the last page's ``total`` counting them; false: the sweep
        alone, whose ``total`` then counts the documents without chunk 0). Chroma's metadata filters compare numbers
        only and cannot aggregate, so every other key is named in
        ``filter_ignored`` and left to the app. A cursor remembers the
        ``has_first_chunk`` it was issued under and is refused with another.
        """
        vx = _vx()
        limit = max(1, int(limit))
        first = filter.has_first_chunk if filter is not None else None
        ignored = tuple(key for key in filter.given() if key != 'has_first_chunk') if filter is not None else ()
        state = self._decodeCursor(cursor)
        if cursor is not None and state.get('hf') != first:
            raise _errors().ToolRefusal(
                'INVALID_INPUT',
                'The documents cursor belongs to a listing with another filter; start again without one.',
            )
        if cursor is None and first is False:
            state = {'ph': 'o', 'i': 0}
        caveats = ['documents_unsorted']

        def page_of(items, next_state, total, *, counts_exact=True):
            if next_state is not None and first is not None:
                next_state = {**next_state, 'hf': first}
            # Only a filtered call names skipped keys: the tool of an older ai package never hands a
            # filter over, and its DocPage has no filter_ignored.
            extra = {'filter_ignored': ignored} if filter is not None else {}
            return vx.DocPage(
                items=items,
                next_cursor=None if next_state is None else self._encodeCursor(next_state),
                total=total,
                counts_exact=counts_exact,
                distinct=True,
                sorted=False,
                caveats=caveats,
                **extra,
            )

        if not self._exists():
            return page_of([], None, 0)

        ids = None if object_ids is None else [str(o) for o in object_ids if str(o) != CONTROL_OBJECT_ID]
        if ids == []:
            # No document asked for (or only the control record): Chroma refuses `$in: []`.
            return page_of([], None, 0)
        items = []
        if state['ph'] == 'c':
            offset = state['o']
            results = self.collectionObj.get(
                where=self._documentsWhere(deleted, ids, {'chunkId': {'$eq': 0}}),
                include=['metadatas'],
                offset=offset,
                limit=limit + 1,
            )
            page_ids = list(results.get('ids') or [])
            more = len(page_ids) > limit
            rows: List[Tuple[str, Dict[str, Any]]] = []
            seen: Set[str] = set()
            for index, record_id in enumerate(page_ids[:limit]):
                meta = (results['metadatas'][index] or {}) if results.get('metadatas') else {}
                oid = str(meta.get('objectId', ''))
                if oid and oid not in seen:
                    seen.add(oid)
                    rows.append((record_id, meta))
            counts: Dict[str, int] = {}
            tables: Dict[str, int] = {}
            if seen:
                for _, row in self._readAll(self._documentsWhere(deleted, sorted(seen)), ['metadatas']):
                    meta = row.get('metadata') or {}
                    oid = str(meta.get('objectId', ''))
                    counts[oid] = counts.get(oid, 0) + 1
                    if meta.get('isTable') is True:
                        tables[oid] = tables.get(oid, 0) + 1
            for record_id, meta in rows:
                oid = str(meta.get('objectId'))
                items.append(self._documentRow(record_id, meta, counts.get(oid), tables.get(oid, 0), True))
            if more:
                return page_of(items, {'ph': 'c', 'o': offset + limit}, None)
            if first is True:
                # Only documents with a first chunk: the listing ends with the chunk-0 records, and
                # its last page knows how many there were: the records paged past plus this page's.
                # One chunk-0 record per document (the ids are objectId#chunkId), as distinct=True
                # already relies on, so that is the number of documents listed.
                return page_of(items, None, offset + len(rows))
            state = {'ph': 'o', 'i': 0}

        # The chunk-0 records are exhausted: fill the page with documents that have no chunk 0.
        orphans, total, capped = self._sweep(deleted, ids)
        if capped:
            caveats.append('document_count_capped')
        if first is False:
            total = len(orphans)
        start = state['i']
        room = max(0, limit - len(items))
        for oid, record_id, meta, rows_count in orphans[start : start + room]:
            items.append(self._documentRow(record_id, meta, rows_count, None, False))
        next_state = {'ph': 'o', 'i': start + room} if start + room < len(orphans) else None
        return page_of(items, next_state, None if capped else total, counts_exact=not capped)

    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: str):
        """
        The chunks of one document after ``after_chunk``, in chunk order, without vectors.

        Reads the window (after_chunk, after_chunk + limit] and probes for one row
        beyond it; only when the window is short and rows lie beyond it (gaps in
        the chunk ids) reads the remaining chunk ids and fetches the next
        ``limit`` by id.
        """
        vx = _vx()
        after_chunk = int(after_chunk)
        limit = max(1, int(limit))
        if objectId == CONTROL_OBJECT_ID or not self._exists():
            return vx.ChunkPage(docs=[], has_more=False, next_after=after_chunk)
        window = self.collectionObj.get(
            where=self._documentsWhere(
                deleted,
                [objectId],
                {'chunkId': {'$gt': after_chunk}},
                {'chunkId': {'$lte': after_chunk + limit}},
            ),
            include=['metadatas', 'documents'],
        )
        rows = [(rid, self._row(window, i)) for i, rid in enumerate(window.get('ids') or [])]
        beyond = self.collectionObj.get(
            where=self._documentsWhere(deleted, [objectId], {'chunkId': {'$gt': after_chunk + limit}}),
            include=[],
            limit=1,
        )
        more = bool(beyond.get('ids'))
        if len(rows) < limit and more:
            # Gaps in the chunk ids: find the next `limit` chunk ids, then read those records.
            remaining = sorted(
                (
                    (_int_or_none((row.get('metadata') or {}).get('chunkId')) or 0, rid)
                    for rid, row in self._readAll(
                        self._documentsWhere(deleted, [objectId], {'chunkId': {'$gt': after_chunk}}), ['metadatas']
                    )
                ),
            )
            wanted = [rid for _, rid in remaining[:limit]]
            more = len(remaining) > limit
            fetched = self.collectionObj.get(ids=wanted, include=['metadatas', 'documents']) if wanted else {'ids': []}
            rows = [(rid, self._row(fetched, i)) for i, rid in enumerate(fetched.get('ids') or [])]
        rows.sort(key=lambda item: _int_or_none((item[1].get('metadata') or {}).get('chunkId')) or 0)
        docs = [self._rowToDoc(rid, row) for rid, row in rows[:limit]]
        next_after = docs[-1].metadata.chunkId if docs else after_chunk
        return vx.ChunkPage(docs=docs, has_more=more, next_after=next_after)

    def sampleChunks(self, *, n, seed, strategy, docFilter, include_keys):
        """
        Up to ``n`` chunks with vectors, as one contiguous window of the collection.

        Chroma cannot sample at random: 'first' reads from the start and
        'random' from an offset chosen by ``seed``; both report 'first'.
        'stratified' is not native (StoreUnsupported).
        """
        if strategy == 'stratified':
            raise _errors().StoreUnsupported('sampleChunks(strategy="stratified") is not native on Chroma')
        if strategy not in ('random', 'first'):
            raise ValueError(f'unknown sampling strategy {strategy!r}')
        n = max(0, int(n))
        if not n or self._selectsNothing(docFilter) or not self._exists():
            return [], 'first'
        where = _where(self._convertFilter(docFilter), {'objectId': {'$ne': CONTROL_OBJECT_ID}})
        offset = 0
        if strategy == 'random':
            total = sum(1 for _ in self._readAll(where, []))
            offset = random.Random(int(seed)).randint(0, max(0, total - n))
        results = self.collectionObj.get(
            where=where, include=['embeddings', 'metadatas', 'documents'], offset=offset, limit=n
        )
        docs = [
            self._rowToDoc(rid, self._row(results, i), with_vector=True)
            for i, rid in enumerate(results.get('ids') or [])
        ]
        return docs, 'first'

    def getVectors(self, keys):
        """
        The chunks for ``keys`` with vectors, in the order asked; missing keys are left out.

        Reads by deterministic id first, then by filter for every miss (rows
        written before deterministic ids carry random ids). Deleted rows included.
        """
        wanted = list(dict.fromkeys((str(o), int(c)) for o, c in keys if str(o) != CONTROL_OBJECT_ID))
        if not wanted or not self._exists():
            return []
        want = set(wanted)
        found: Dict[Tuple[str, int], Tuple[str, Dict[str, Any]]] = {}
        include = ['embeddings', 'metadatas', 'documents']
        ids = [point_id_for(oid, chunk) for oid, chunk in wanted]
        for start in range(0, len(ids), 1000):
            results = self.collectionObj.get(ids=ids[start : start + 1000], include=include)
            for index, record_id in enumerate(results.get('ids') or []):
                row = self._row(results, index)
                meta = row.get('metadata') or {}
                key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
                if key in want and key not in found:
                    found[key] = (record_id, row)
        misses = [k for k in wanted if k not in found]
        if misses:
            by_object: Dict[str, Set[int]] = {}
            for oid, chunk in misses:
                by_object.setdefault(oid, set()).add(chunk)
            objects = sorted(by_object)
            for start in range(0, len(objects), 64):
                batch = objects[start : start + 64]
                chunks = sorted(set().union(*(by_object[o] for o in batch)))
                where = _where({'objectId': {'$in': batch}}, {'chunkId': {'$in': chunks}})
                for record_id, row in self._readAll(where, include):
                    meta = row.get('metadata') or {}
                    key = (str(meta.get('objectId')), _int_or_none(meta.get('chunkId')))
                    if key in want and key not in found:
                        found[key] = (record_id, row)
        return [self._rowToDoc(*found[k], with_vector=True) for k in wanted if k in found]

    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """Remove every chunk of ``objectIds`` (deleted rows too); return the rows removed. Never the control record."""
        ids = [oid for oid in dict.fromkeys(str(o).strip() for o in objectIds) if oid and oid != CONTROL_OBJECT_ID]
        if not ids or not self._exists():
            return 0
        removed = 0
        for batch in self._idBatches(ids):
            where = {'objectId': {'$in': batch}}
            rows = sum(1 for _ in self._readAll(where, []))
            if rows:
                self.collectionObj.delete(where=where)
                removed += rows
        return removed

    def removeTrashed(self, objectIds: List[str]) -> Optional[int]:
        """Delete the chunks of ``objectIds`` that are in the trash, and only those, in one operation; return the rows removed.

        The deleted flag is part of the delete's own filter, so a chunk a concurrent ``restore`` has just made
        live is never removed. Never the control record.
        """
        ids = [oid for oid in dict.fromkeys(str(o).strip() for o in objectIds) if oid and oid != CONTROL_OBJECT_ID]
        if not ids or not self._exists():
            return 0
        removed = 0
        for batch in self._idBatches(ids):
            where = {'$and': [{'objectId': {'$in': batch}}, {'isDeleted': {'$eq': True}}]}
            rows = sum(1 for _ in self._readAll(where, []))
            if rows:
                self.collectionObj.delete(where=where)
                removed += rows
        return removed
