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

from typing import List, Dict, Any, Callable, cast
import chromadb
from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config
from rocketlib import debug, warning
import uuid
import numpy as np
import json
import sys
import re


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
    apikey: str | None = None
    node: str = 'chroma'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client: chromadb.HttpClient
    collectionObj: chromadb.Collection | None = None

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

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        # Chroma Cloud multi-tenancy - both are required by Chroma Cloud
        # accounts and optional for self-hosted servers
        self.tenant = (config.get('tenant') or '').strip() or None
        self.database = (config.get('database') or '').strip() or None

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.payload_limit = config.get('payloadLimit', self.payload_limit)

        # The merged node config carries the profile selection in 'mode':
        # getNodeConfig consumes the 'profile' key while merging the selected
        # profile's contents, so 'profile' is absent when configured through
        # a service/autopipe config and the cloud branch was never taken.
        # Keep 'profile' as a fallback for direct configurations.
        profile = config.get('mode') or config.get('profile') or 'local'

        # check if the similarity matches qdrant configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'l2', 'ip']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required chroma configurations')

        # The chromadb client builds its httpx session with timeout=None and
        # issues its first request while HttpClient() is still constructing,
        # so one unresponsive connection hangs the whole pipeline forever.
        # Give every session created by chromadb's transport module a default
        # timeout.
        #
        # Scope: the replacement only shadows the `httpx` name inside
        # chromadb.api.fastapi, which is where this client builds its sessions.
        # Nothing else in the process sees it, and any explicit timeout the
        # caller passes is preserved. chromadb-client exposes no supported
        # timeout setting, which is why the default is installed this way.
        try:
            import httpx
            import chromadb.api.fastapi as _chroma_fastapi

            if not getattr(_chroma_fastapi, '_rocketrideTimeoutShim', False):

                class _HttpxShim:
                    class Client(httpx.Client):
                        def __init__(self, *args, **kwargs):
                            if kwargs.get('timeout', 'unset') in (None, 'unset'):
                                kwargs['timeout'] = httpx.Timeout(120.0, connect=30.0)
                            super().__init__(*args, **kwargs)

                    def __getattr__(self, name):
                        return getattr(httpx, name)

                _chroma_fastapi.httpx = _HttpxShim()
                _chroma_fastapi._rocketrideTimeoutShim = True
        except Exception as exc:
            # This is hardening against an upstream default, not a feature, so a
            # failure here must not stop the node from connecting: if chromadb
            # reorganises its transport module the store still works, just
            # without the timeout. Say so rather than failing silently, because
            # the symptom otherwise is a pipeline that hangs with no explanation.
            warning(f'chroma: HTTP timeout shim not applied ({exc}); an unresponsive server may hang requests')

        # The Chroma client connects eagerly (identity/tenant validation on construction),
        # so an incompatible/old server surfaces here as a cryptic error (e.g.
        # KeyError('_type')). Wrap it so the user gets an actionable message instead of a
        # silent failure.
        try:
            if profile == 'local':
                self.client = chromadb.HttpClient(host=self.host, port=self.port)
            else:
                # Cloud / remote server. TLS is required: Chroma Cloud only
                # serves HTTPS, and a plain HTTP request against the TLS port
                # hangs or is rejected with "illegal request line". The API
                # key travels in the x-chroma-token header, and Chroma Cloud
                # additionally requires the tenant and database.
                kwargs: Dict[str, Any] = {}
                if self.tenant:
                    kwargs['tenant'] = self.tenant
                if self.database:
                    kwargs['database'] = self.database
                self.client = chromadb.HttpClient(
                    host=self.host,
                    port=self.port,
                    ssl=True,
                    headers={'x-chroma-token': self.apikey} if self.apikey else None,
                    **kwargs,
                )
        except Exception as e:
            self.client = None
            floor = f'{_MIN_CHROMA_VERSION[0]}.{_MIN_CHROMA_VERSION[1]}'
            raise Exception(
                f'Failed to connect to Chroma at {self.host}:{self.port}. This may be due to '
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

    def _convertFilter(self, docFilter: DocFilter) -> Dict[str, Any]:
        filters = []
        if docFilter.nodeId is not None:
            filters.append({'nodeId': {'$eq': docFilter.nodeId}})
        if docFilter.isTable:
            filters.append({'isTable': {'$eq': docFilter.isTable}})
        if docFilter.tableIds is not None:
            filters.append({'tableId': {'$in': docFilter.tableIds}})
        if docFilter.parent is not None:
            filters.append({'parent': {'$eq': docFilter.parent}})
        if docFilter.permissions is not None:
            filters.append({'permissionId': {'$in': docFilter.permissions}})
        if docFilter.objectIds is not None:
            filters.append({'objectId': {'$in': docFilter.objectIds}})
        if docFilter.isDeleted is None or not docFilter.isDeleted:
            # Exclude only docs explicitly marked deleted. A null/absent isDeleted
            # (the client strips None via exclude_none) must still count as not
            # deleted, so use $ne True (which matches absent-key records) instead of
            # $eq False (which would drop them).
            filters.append({'isDeleted': {'$ne': True}})
        else:
            filters.append({'isDeleted': {'$eq': True}})
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

    def _convertToDocs(self, results: Dict) -> List[Doc]:
        """
        Convert ChromaDB results to a list of Docs.
        """
        docs: List[Doc] = []
        # Now we need to unwrap each list of ndarrays returned by Chroma in case of Query
        if results.get('distances', None) is not None:
            results['ids'] = results['ids'][0]
            results['metadatas'] = results['metadatas'][0]
            results['distances'] = results['distances'][0]
            results['documents'] = results['documents'][0]

        # Now, add the documents to the results
        for i in range(len(results['ids'])):
            # Get the payload content and meadata
            metadata = cast(DocMetadata, results['metadatas'][i])
            content = results['documents'][i]

            if results.get('distances', None) is not None:
                if self.similarity == 'cosine':
                    score = (results['distances'][i] + 1) / 2
                else:
                    score = float(1.0 / (1.0 + np.exp(results['distances'][i] / -100)))

                # Ignore it if it doesn't have a high enough score
                if score < 0.20:
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
        # Get all ids in collection
        result = self.collectionObj.get(include=[])
        return len(result['ids'])

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
        filters = self._convertFilter(docFilter)

        results = self.collectionObj.get(
            where=filters,
            where_document={'$contains': query.text},
            offset=docFilter.offset,
            limit=docFilter.limit,
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
            raise BaseException('Non-zero offset is not supported in semantic searching')

        # Perform the search
        results = self.collectionObj.query(query_embeddings=[query.embedding], n_results=docFilter.limit, where=filters)

        # Convert the points into groups
        docs = self._convertToDocs(results)

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

        # Convert filter to ChromaDB format
        filter_dict = self._convertFilter(docFilter)

        # Perform the query
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

        # Base filter: Only chunk 0
        filter_dict = {'chunk': 0}

        # If parent specified, add condition
        if parent is not None:
            filter_dict['parent'] = {'$eq': json.dumps(parent, ensure_ascii=False)}

        # Perform the query
        results = self.collectionObj.get(where=filter_dict, limit=limit, offset=offset)

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

        object_ids_to_delete: Dict[str, bool] = {}
        ids: List[str] = []
        embeddings: List[List[float]] = []
        metadatas: List[Dict] = []
        documents: List[str] = []

        def flush():
            nonlocal ids, embeddings, metadatas, documents
            # Defense in depth: never index against a missing collection. Surface a clear,
            # actionable error instead of a cryptic "'NoneType' object has no attribute
            # 'delete'" if the collection was not created (e.g. a failed/incompatible server).
            if self.collectionObj is None:
                raise Exception(
                    'Chroma collection is not available (creation may have failed); cannot '
                    'index documents. Check the Chroma server connection and version.'
                )
            if object_ids_to_delete:
                if len(object_ids_to_delete) > 1:
                    filter_condition = {'$or': [{'objectId': object_id} for object_id in object_ids_to_delete]}
                    self.collectionObj.delete(where=filter_condition)
                else:
                    filter_condition = {'objectId': list(object_ids_to_delete.keys())[0]}
                    self.collectionObj.delete(where=filter_condition)
                object_ids_to_delete.clear()

            if ids:
                self.collectionObj.upsert(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)
                ids.clear()
                embeddings.clear()
                metadatas.clear()
                documents.clear()

        for chunk in chunks:
            if chunk.metadata.chunkId == 0:
                object_ids_to_delete[chunk.metadata.objectId] = True

        sum_size = 0
        cur_size = 0

        for chunk in chunks:
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            metadata = {k: v for k, v in chunk.metadata.toDict().items() if v is not None}

            ids.append(str(uuid.uuid4()))
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
        self.collectionObj.delete(where={'objectId': {'$in': objectIds}})

        return

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not self.doesCollectionExist():
            return

        if not objectIds:
            return

        # Get all the objects with the given objectIds
        results = self.collectionObj.get(where={'objectId': {'$in': objectIds}}, include=['metadatas'])

        # Set all isDeleted parameters for the objects with the given objectId to true
        for res in results:
            res['metadata']['isDeleted'] = True
            self.collectionObj.update(where={'objectId': res['metadata']['objectId']}, new_metadata=res['metadata'])

        return

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not self.doesCollectionExist():
            return

        if not objectIds:
            return

        # Get all the objects with the given objectIds
        results = self.collectionObj.get(where={'objectId': {'$in': objectIds}}, include=['metadatas'])

        # Set all isDeleted parameters for the objects with the given objectId to false
        for res in results:
            res['metadata']['isDeleted'] = False
            self.collectionObj.update(where={'objectId': res['metadata']['objectId']}, new_metadata=res['metadata'])

        return

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
            results = self.collectionObj.get(where=filter, include=['documents'], limit=self.renderChunkSize)
            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            text: List[str] = [''] * self.renderChunkSize
            lastIndex = -1
            for i in range(len(results['ids'])):
                # Get the info
                metadata = results['metadatas'][i]
                content = results['documents'][i]
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
