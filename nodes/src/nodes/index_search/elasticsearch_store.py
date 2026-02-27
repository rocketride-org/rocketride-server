# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
# Elasticsearch store: DocumentStoreBase implementation for index_search.
#
# Loads requirements.txt before importing so node dependencies are available.
# ------------------------------------------------------------------------------
import re
import sys
from typing import Any, Callable, Dict, List, Optional, cast
from uuid import uuid4

import numpy as np
from elasticsearch import Elasticsearch
from elasticsearch.helpers import bulk, scan, BulkIndexError

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config

from .constants import (
    CONTENT_FIELD,
    DEFAULT_HIGHLIGHT_FRAGMENT_SIZE,
    DEFAULT_INDEX_NAME,
    DEFAULT_SCROLL,
    DEFAULT_TEXT_BATCH_SIZE,
    ELASTICSEARCH_DEFAULT_PORT,
)


def _build_highlight_config(field: str, fragment_size: int) -> Dict[str, Any]:
    """Highlight configuration for text search (Elasticsearch/OpenSearch DSL)."""
    return {
        'fields': {
            field: {
                'type': 'unified',
                'fragment_size': fragment_size,
                'no_match_size': 0,
            }
        },
        'pre_tags': ['<mark class="ap-highlight">'],
        'post_tags': ['</mark>'],
    }


class Store(DocumentStoreBase):
    """
    Elasticsearch document store: vector and text index, search, and lifecycle.

    Implements DocumentStoreBase for the index_search node. Supports
    self-managed, cloud-hosted, and cloud-serverless Elasticsearch.
    """

    apikey: str | None = None
    node: str = 'elasticsearch'
    index: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'cosine'
    threshold_search: float = 0.0
    client: Elasticsearch | None = None
    mode: str = 'self-managed'

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> None:
        """Initialize the Elasticsearch store from node config."""
        super().__init__(provider, connConfig, bag)
        config = Config.getNodeConfig(provider, connConfig)

        self.index = config.get('index', DEFAULT_INDEX_NAME)
        self.mode = config.get('mode', 'self-managed')
        raw_host = (config.get('host') or '').strip()
        self.host = re.sub(r'^https?://', '', raw_host).rstrip('/')
        self.port = config.get('port', ELASTICSEARCH_DEFAULT_PORT)

        self.apikey = (config.get('apikey') or '').strip() or None
        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.payload_limit = config.get('payloadLimit', self.payload_limit)
        self.threshold_search = config.get('score', 0.5)

        similarity = config.get('similarity', 'cosine')
        if similarity not in ('cosine', 'l2_norm', 'dot_product'):
            raise Exception(
                'Similarity must be one of: cosine, l2_norm, dot_product'
            )
        self.similarity = similarity

        # Use explicit scheme from host if present; else derive from mode (self-managed -> http)
        if raw_host.lower().startswith('http://'):
            scheme = 'http'
        elif raw_host.lower().startswith('https://'):
            scheme = 'https'
        else:
            scheme = 'http' if self.mode == 'self-managed' else 'https'
        url = f'{scheme}://{self.host}:{self.port}'
        self.client = Elasticsearch(
            [url],
            api_key=self.apikey,
            request_timeout=60,
        )

    def __del__(self):
        """
        Deinitializes the Elasticsearch client.
        """
        # Deinit everything we did
        self.apikey = None
        self.index = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'
        self.client = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the index exists.
        """
        if self.client is None:
            return False
        return self.client.indices.exists(index=self.index)

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create an index with vector field configuration.

        The base class will only call this if the index doesn't exist or
        is corrupted. We create the index with the proper mapping.
        """
        self.vectorSize = vectorSize

        # Check if index already exists (shouldn't happen, but be safe)
        if self.client.indices.exists(index=self.index):
            # If it exists, we assume the base class has verified it's corrupted
            # and needs to be recreated. Delete it.
            self.client.indices.delete(index=self.index)

        mapping = {
            'mappings': {
                'properties': {
                    'embedding': {
                        'type': 'dense_vector',
                        'dims': vectorSize,
                        'index': True,
                        'similarity': self.similarity,
                    },
                    CONTENT_FIELD: {'type': 'text', 'analyzer': 'standard'},
                    'meta': {
                        'type': 'object',
                        'properties': {
                            'nodeId': {'type': 'keyword'},
                            'objectId': {'type': 'keyword'},
                            'parent': {'type': 'keyword'},
                            'permissionId': {'type': 'integer'},
                            'isDeleted': {'type': 'boolean'},
                            'isTable': {'type': 'boolean'},
                            'chunkId': {'type': 'integer'},
                            'tableId': {'type': 'integer'},
                            'vectorSize': {'type': 'integer'},
                            'modelName': {'type': 'keyword'},
                        },
                    },
                }
            }
        }

        # Create the index (Elasticsearch 8.x uses body parameter)
        self.client.indices.create(index=self.index, body=mapping)

        # Verify it exists
        if not self.client.indices.exists(index=self.index):
            return False

        return True

    def _checkCollectionExists(self) -> bool:
        """
        Check if the collection exists and has the control (schema) document.
        If the index exists but is empty, treat as missing so createCollection can initialize it.
        """
        if not self._doesCollectionExist():
            return False
        doc_filter = DocFilter()
        doc_filter.objectIds = ['schema']
        doc_filter.isDeleted = True
        doc = self.get(doc_filter, checkCollection=False)
        if len(doc) != 1:
            if self.count_documents() == 0:
                return False
            raise Exception(f'Collection does not have control document, found {len(doc)}')
        self.vectorSize = doc[0].metadata.vectorSize
        self.modelName = doc[0].metadata.modelName
        return True

    def _convertFilter(self, docFilter: DocFilter) -> Dict[str, Any]:
        """
        Build the Elasticsearch query filter based on required permissions, node, parent, etc.
        """
        must_clauses = []

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            must_clauses.append({'term': {'meta.nodeId': docFilter.nodeId}})

        if docFilter.isTable is not None:
            must_clauses.append({'term': {'meta.isTable': docFilter.isTable}})

        if docFilter.tableIds is not None:
            must_clauses.append({'terms': {'meta.tableId': docFilter.tableIds}})

        # If a parent was specified
        if docFilter.parent is not None:
            must_clauses.append({'term': {'meta.parent': docFilter.parent}})

        # If a permissionId list was specified
        if docFilter.permissions is not None:
            must_clauses.append({'terms': {'meta.permissionId': docFilter.permissions}})

        # If a objectIds list was specified
        if docFilter.objectIds is not None:
            must_clauses.append({'terms': {'meta.objectId': docFilter.objectIds}})

        # If we are not going after deleted docs, add a condition
        if docFilter.isDeleted is None or not docFilter.isDeleted:
            must_clauses.append({'term': {'meta.isDeleted': False}})

        # If we are not going after chunks, add a condition
        if docFilter.chunkIds is not None:
            must_clauses.append({'terms': {'meta.chunkId': docFilter.chunkIds}})

        # If we are min chunk id, add a condition
        if docFilter.minChunkId is not None:
            must_clauses.append({'range': {'meta.chunkId': {'gte': docFilter.minChunkId}}})

        # If we are max chunk id, add a condition
        if docFilter.maxChunkId is not None:
            must_clauses.append({'range': {'meta.chunkId': {'lte': docFilter.maxChunkId}}})

        return {'bool': {'must': must_clauses}} if must_clauses else {'match_all': {}}

    def _convertToDocs(self, hits: List[Dict[str, Any]]) -> List[Doc]:
        """
        Convert a list of Elasticsearch hits to a list of Docs.

        Groups all document chunks together
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for hit in hits:
            # Get the source
            source = hit.get('_source', {})
            if not source:
                continue

            metadata_dict = source.get('meta', {})
            content = source.get(CONTENT_FIELD, '')

            # Create metadata object
            metadata = DocMetadata(**metadata_dict)

            # Determine the score of this document
            score = hit.get('_score', 0.0)
            if score > 0:
                # Normalize score based on similarity metric
                if self.similarity == 'cosine':
                    # Elasticsearch cosine similarity returns 0-1 for dense_vector with cosine
                    score = float(score)
                elif self.similarity == 'dot_product':
                    # Dot product scores can be negative or positive, normalize to 0-1
                    score = float((score + 1) / 2) if score >= -1 else 0.0
                else:
                    # For l2_norm and others, use sigmoid normalization
                    score = float(1.0 / (1.0 + np.exp(score / -100)))

                # Ignore it if it doesn't have a high enough score
                if score < self.threshold_search:
                    continue
            else:
                score = 0

            # Create a new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def count_documents(self) -> int:
        """
        Return the number of documents in the index.

        Returns how many documents are present in the document store.
        """
        # If the index does not exist, by definition there are
        # no documents in the index
        if not self._doesCollectionExist():
            return 0

        # Get the count
        result = self.client.count(index=self.index)
        return result['count']

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search using Elasticsearch text search.
        """
        # If the index does not exist, by definition there are
        # no search results to return
        if not self._doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter_query = self._convertFilter(docFilter)

        limit = docFilter.limit if docFilter.limit is not None else 25
        from_ = docFilter.offset if docFilter.offset is not None else 0
        search_body = {
            'query': {'bool': {'must': [{'match': {CONTENT_FIELD: query.text}}, filter_query]}},
            'size': limit,
            'from': from_,
        }

        # Perform the search (Elasticsearch 8.x uses body parameter)
        response = self.client.search(index=self.index, body=search_body)

        # Convert the hits into documents
        hits = response.get('hits', {}).get('hits', [])
        docs = self._convertToDocs(hits)

        # Return them
        return docs

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search using vector similarity.
        """
        # If the index does not exist, by definition there are
        # no search results to return
        if not self._doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter_query = self._convertFilter(docFilter)

        # We know the index exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise BaseException('Non-zero offset is not supported in semantic searching')

        # Build the search query with vector search using knn
        # For Elasticsearch 8.x, use knn query for vector search
        search_body = {
            'knn': {'field': 'embedding', 'query_vector': query.embedding, 'k': docFilter.limit if docFilter.limit is not None else 25, 'num_candidates': (docFilter.limit if docFilter.limit is not None else 25) * 10, 'filter': filter_query},
            'size': docFilter.limit if docFilter.limit is not None else 25,
        }

        # Perform the search (Elasticsearch 8.x uses body parameter)
        response = self.client.search(index=self.index, body=search_body)

        # Convert the hits into documents
        hits = response.get('hits', {}).get('hits', [])
        docs = self._convertToDocs(hits)

        # Return them
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Given a filter, this will return the document groups matching the filter.
        """
        # If the index does not exist, by definition there are
        # no documents matching the get
        if checkCollection and not self._doesCollectionExist():
            return []

        # Build up the filter
        filter_query = self._convertFilter(docFilter=docFilter)

        # Build the search query
        search_body = {'query': filter_query, 'size': docFilter.limit if docFilter.limit is not None else 1000, 'from': docFilter.offset if docFilter.offset is not None else 0, 'sort': [{'meta.chunkId': {'order': 'asc'}}]}

        # Perform the search (Elasticsearch 8.x uses body parameter)
        response = self.client.search(index=self.index, body=search_body)

        # Convert the hits into documents
        hits = response.get('hits', {}).get('hits', [])
        docs = self._convertToDocs(hits)
        return docs

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """
        # If the index does not exist, by definition there are
        # no paths to return
        if not self._doesCollectionExist():
            return {}

        # Build the query
        must_clauses = [{'term': {'meta.chunkId': 0}}]

        # If parent specified, match on it
        if parent is not None:
            must_clauses.append({'term': {'meta.parent': parent}})

        filter_query = {'bool': {'must': must_clauses}}

        # Build up the path list
        paths: Dict[str, str] = {}

        # Build the search query
        search_body = {'query': filter_query, 'size': limit, 'from': offset, '_source': ['meta.parent', 'meta.objectId']}

        # Perform the search (Elasticsearch 8.x uses body parameter)
        response = self.client.search(index=self.index, body=search_body)

        # Fill it in
        hits = response.get('hits', {}).get('hits', [])
        for hit in hits:
            # Get the source
            source = hit.get('_source', {})
            if not source:
                continue

            # Get the info
            meta = source.get('meta', {})
            parent_path = meta.get('parent', '')
            objectId = meta.get('objectId', '')

            # Add it
            if parent_path and objectId:
                paths[parent_path] = objectId

        # And return what we found
        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.
        """
        # If no documents present, get out
        if not len(chunks):
            return

        # Create the index if needed
        if checkCollection and not self.createCollection(chunks):
            return

        # Clear the object id list
        objectIds: Dict[str, bool] = {}

        # For each document
        for chunk in chunks:
            # If we are writing chunk 0, then delete the object
            if not chunk.metadata.chunkId:
                # Save this object id to be deleted
                objectIds[chunk.metadata.objectId] = True

        # Delete existing documents with matching objectIds
        if objectIds:
            delete_query = {'query': {'terms': {'meta.objectId': list(objectIds.keys())}}}
            self.client.delete_by_query(index=self.index, body=delete_query)

        # Prepare bulk operations
        actions = []
        sum_size = 0

        def _meta_for_es(md: DocMetadata) -> Dict[str, Any]:
            """Build meta dict for ES: only non-None fields, correct types (ES rejects null for int/bool in strict mapping)."""
            meta: Dict[str, Any] = {
                'objectId': md.objectId,
                'chunkId': md.chunkId,
            }
            if md.nodeId is not None:
                meta['nodeId'] = md.nodeId
            if md.parent is not None:
                meta['parent'] = md.parent
            if md.permissionId is not None:
                meta['permissionId'] = md.permissionId
            if md.isDeleted is not None:
                meta['isDeleted'] = md.isDeleted
            if md.isTable is not None:
                meta['isTable'] = md.isTable
            if md.tableId is not None:
                meta['tableId'] = md.tableId
            if getattr(md, 'vectorSize', None) is not None:
                meta['vectorSize'] = md.vectorSize
            if getattr(md, 'modelName', None) is not None:
                meta['modelName'] = md.modelName
            return meta

        def _run_bulk(actions_batch: List[Dict[str, Any]]) -> None:
            try:
                bulk(self.client, actions_batch)
            except BulkIndexError as e:
                errors = getattr(e, 'errors', []) or []
                for item in errors:
                    if not isinstance(item, dict):
                        continue
                    # Bulk item can be under 'index' or 'create'
                    op = item.get('index') or item.get('create') or {}
                    err = op.get('error', {})
                    reason = err.get('reason') or err.get('type') or str(err) or str(e)
                    doc_id = op.get('_id', '?')
                    raise Exception(
                        f'Elasticsearch index failed (id={doc_id}): {reason}'
                    ) from e
                raise

        # For each document
        for chunk in chunks:
            # Get the embedding (ensure list for ES; numpy arrays must be converted)
            embedding = chunk.embedding
            if embedding is None:
                raise Exception('No embedding in document')
            if hasattr(embedding, 'tolist'):
                embedding = embedding.tolist()
            elif not isinstance(embedding, list):
                embedding = list(embedding)
            # Control/schema document uses zero vector; ES cosine similarity rejects zero magnitude
            if getattr(chunk.metadata, 'objectId', None) == 'schema' and all(x == 0 for x in embedding):
                embedding = [1.0] + [0.0] * (len(embedding) - 1) if len(embedding) else [1.0]

            doc = {
                '_index': self.index,
                '_id': str(uuid4()),
                '_source': {
                    'embedding': embedding,
                    CONTENT_FIELD: chunk.page_content or '',
                    'meta': _meta_for_es(chunk.metadata),
                },
            }

            cur_size = sys.getsizeof(doc)
            sum_size += cur_size
            actions.append(doc)

            # Flush if we hit batch size or payload limit
            if (len(actions) >= 500) or (sum_size > self.payload_limit):
                _run_bulk(actions)
                actions = []
                sum_size = 0

        # Flush any stragglers
        if actions:
            _run_bulk(actions)

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the index does not exist, there
        # is nothing to delete
        if not self._doesCollectionExist():
            return

        # Build a query for object ids
        delete_query = {'query': {'terms': {'meta.objectId': objectIds}}}

        # Delete the documents with the given object Id
        self.client.delete_by_query(index=self.index, body=delete_query, wait_for_completion=True)
        return

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """
        # By definition, if the index does not exist, there
        # is nothing to mark
        if not self._doesCollectionExist():
            return

        # Build a query for object ids
        update_query = {'query': {'terms': {'meta.objectId': objectIds}}, 'script': {'source': 'ctx._source.meta.isDeleted = true', 'lang': 'painless'}}

        # Update all the objects with the given objectId to deleted
        self.client.update_by_query(index=self.index, body=update_query, wait_for_completion=True)
        return

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after being deleted
        """
        # By definition, if the index does not exist, there
        # is nothing to mark
        if not self._doesCollectionExist():
            return

        # Build a query for object ids
        update_query = {'query': {'terms': {'meta.objectId': objectIds}}, 'script': {'source': 'ctx._source.meta.isDeleted = false', 'lang': 'painless'}}

        # Update all the objects with the given objectId to active
        self.client.update_by_query(index=self.index, body=update_query, wait_for_completion=True)
        return

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """
        # By definition, if the index does not exist, there
        # is nothing to render
        if not self._doesCollectionExist():
            return

        # Since chunks are returned in any order, and a single objectId
        # may contain tens of thousands of chunks, we grab them one
        # group at a time (renderChunkSize), put them into an array,
        # join them and call the callback
        offset = 0
        while True:
            # Build query for getting a set of chunks
            search_body = {
                'query': {'bool': {'must': [{'term': {'meta.objectId': objectId}}, {'range': {'meta.chunkId': {'gte': offset, 'lt': offset + self.renderChunkSize}}}]}},
                'size': self.renderChunkSize,
                'sort': [{'meta.chunkId': {'order': 'asc'}}],
                '_source': [CONTENT_FIELD, 'meta.chunkId'],
            }

            # Perform the query (Elasticsearch 8.x uses body parameter)
            response = self.client.search(index=self.index, body=search_body)
            hits = response.get('hits', {}).get('hits', [])

            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            text: List[str] = [''] * self.renderChunkSize
            lastIndex = -1

            # Now, add the documents to the results
            for hit in hits:
                # Get the source
                source = hit.get('_source', {})
                if source is None:
                    continue

                # Get the info
                content = source.get(CONTENT_FIELD, '')
                meta = source.get('meta', {})
                chunk = meta.get('chunkId', 0)

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

    # -------------------------------------------------------------------------
    # Text/Index mode (BM25, no embeddings)
    # -------------------------------------------------------------------------

    def ensure_index_text(self, mappings: Optional[Dict[str, Any]] = None) -> None:
        """Create a text/BM25 index if missing. Used for index mode."""
        if self.client is None:
            return
        if not self.client.indices.exists(index=self.index):
            body: Dict[str, Any] = {}
            if mappings:
                body['mappings'] = mappings
            else:
                body['mappings'] = {'properties': {CONTENT_FIELD: {'type': 'text'}}}
            self.client.indices.create(index=self.index, body=body, ignore=[400])

    def upsert_text_document(self, doc_id: Optional[str], body: Dict[str, Any], refresh: bool = False) -> None:
        """Index or update a single text document (index mode ingestion)."""
        if self.client is None:
            return
        self.client.index(index=self.index, id=doc_id, body=body, refresh=refresh)

    def search_text_all(
        self,
        query: str,
        batch_size: int = DEFAULT_TEXT_BATCH_SIZE,
        scroll: str = DEFAULT_SCROLL,
        filters: Optional[Dict[str, Any]] = None,
        source: Optional[List[str]] = None,
        match_operator: str = 'or',
        match_operator_slop: int = 0,
        highlight: bool = False,
        highlight_fragment_size: int = 0,
        body: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Scroll/scan all matching documents and return every hit (elasticsearch.helpers.scan)."""
        if self.client is None:
            return []
        if body is None:
            body = self._build_text_search_body(
                query=query,
                filters=filters,
                source=source,
                match_operator=match_operator,
                match_operator_slop=match_operator_slop,
                size=batch_size,
                include_source=False,
                highlight=highlight,
                highlight_fragment_size=highlight_fragment_size,
            )
        hits: List[Dict[str, Any]] = []
        for hit in scan(
            self.client,
            index=self.index,
            query=body,
            scroll=scroll,
            size=batch_size,
            _source=source,
        ):
            hits.append(hit)
        return hits

    def _build_text_search_body(
        self,
        query: str,
        filters: Optional[Dict[str, Any]],
        source: Optional[List[str]],
        match_operator: str,
        match_operator_slop: int,
        size: int,
        include_source: bool = True,
        highlight: bool = False,
        highlight_fragment_size: int = 0,
    ) -> Dict[str, Any]:
        """Build Elasticsearch search body for text query (match / match_phrase)."""
        op = (match_operator or 'or').strip().lower()
        if op not in ('and', 'or', 'exact', ''):
            op = 'or'
        slop = max(int(match_operator_slop or 0), 0)
        if op == 'exact':
            base_query: Dict[str, Any] = {
                'match_phrase': {CONTENT_FIELD: {'query': query, 'slop': slop}}
            }
        elif op == 'and':
            base_query = {'match': {CONTENT_FIELD: {'query': query, 'operator': 'and'}}}
        elif op == 'or':
            base_query = {'match': {CONTENT_FIELD: {'query': query, 'operator': 'or'}}}
        else:
            base_query = {'match': {CONTENT_FIELD: query}}

        if filters:
            body = {'query': {'bool': {'must': base_query, 'filter': filters}}, 'size': size}
        else:
            body = {'query': base_query, 'size': size}
        if include_source and source is not None:
            body['_source'] = source
        if highlight:
            frag_size = max(int(highlight_fragment_size or 0), 0) or DEFAULT_HIGHLIGHT_FRAGMENT_SIZE
            body['highlight'] = _build_highlight_config(CONTENT_FIELD, frag_size)
        return body

