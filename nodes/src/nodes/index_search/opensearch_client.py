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

"""
Client wrapper for OpenSearch 2.x.

High-level facade for OpenSearch index and search workloads.
Uses opensearch-py (~2.13.x).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from rocketlib import debug
from opensearchpy import OpenSearch, helpers  # type: ignore

from .constants import (
    CONTENT_FIELD,
    DEFAULT_HIGHLIGHT_FRAGMENT_SIZE,
    DEFAULT_SCROLL,
    DEFAULT_TEXT_BATCH_SIZE,
    VECTOR_FIELD,
)

# OpenSearch-specific default (config overrides at runtime)
DEFAULT_HOST = "http://localhost:9200"


def _build_highlight_config(field: str, fragment_size: int) -> Dict[str, Any]:
    """Shared highlight configuration for text searches (Elasticsearch/OpenSearch DSL)."""
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


def _get_index_properties(mapping: Dict[str, Any], index: str) -> Dict[str, Any]:
    """Extract properties dict from index get_mapping() response."""
    index_mappings = (mapping.get(index) or {}).get('mappings') or {}
    return index_mappings.get('properties') or {}


class OpenSearchClient:
    """
    High-level client facade for OpenSearch index and search workloads.

    Supports both text/BM25 and k-NN vector search modes.
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        username: Optional[str] = None,
        password: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """Initialize the OpenSearch client with optional basic auth."""
        http_auth = (username, password or '') if username else None
        self.client: Optional[OpenSearch] = OpenSearch(hosts=[host], http_auth=http_auth, **kwargs)

    def _require_client(self) -> Optional[OpenSearch]:
        """Return the client if initialized; otherwise log and return None."""
        if self.client is None:
            debug('OpenSearch client is not initialized')
            return None
        return self.client

    def close(self) -> None:
        """Close the OpenSearch client."""
        if self.client is not None:
            try:
                self.client.close()
                debug('Closed OpenSearch client')
            except Exception as e:
                debug(f'Error closing OpenSearch client: {e}')
            self.client = None

    # ------------------------- Connection -------------------------

    def ping(self) -> bool:
        """Check connectivity to the cluster.

        SDK: client.ping()
        """
        client = self._require_client()
        if client is None:
            return False
        ok = bool(client.ping())
        debug(f'Ping OpenSearch -> {ok}')
        return ok

    # ------------------------- Index lifecycle -------------------------

    def ensure_index_text(self, index: str, mappings: Optional[Dict[str, Any]] = None) -> None:
        """Create a text/BM25 index if missing.

        SDK: client.indices.exists(index), client.indices.create(index, body=...).
        Mapping example: {"properties": {"content": {"type": "text"}}}
        """
        client = self._require_client()
        if client is None:
            return
        if not client.indices.exists(index=index):
            debug(f'Creating index {index}')
            body: Dict[str, Any] = {}
            if mappings:
                body['mappings'] = mappings
            else:
                body['mappings'] = {'properties': {CONTENT_FIELD: {'type': 'text'}}}
            client.indices.create(index=index, body=body, ignore=[400])
        else:
            debug(f'Index {index} already exists')

    def ensure_index_vector(
        self,
        index: str,
        dimension: int,
        method: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Create a vector index if missing (knn_vector)."""
        client = self._require_client()
        if client is None:
            return
        if not method:
            method = {
                'name': 'hnsw',
                'engine': 'faiss',
                'space_type': 'cosinesimil',
            }
        recreate = False
        if client.indices.exists(index=index):
            mapping = client.indices.get_mapping(index=index)
            debug(f'Mapping: {mapping}')
            props = _get_index_properties(mapping, index)
            vec = props.get(VECTOR_FIELD)
            if not vec or vec.get('type') != 'knn_vector' or int(vec.get('dimension', 0)) != dimension:
                debug(f'Existing index {index} missing knn_vector or dim mismatch; recreating')
                recreate = True
            else:
                debug(f'Vector index {index} already exists with correct mapping')
                return
        if recreate:
            try:
                client.indices.delete(index=index, ignore=[400, 404])
            except Exception as e:
                debug(f'Failed to delete index {index} before recreate: {e}')
                raise
        body: Dict[str, Any] = {
            'settings': {'index': {'knn': True}},
            'mappings': {
                'properties': {
                    VECTOR_FIELD: {
                        'type': 'knn_vector',
                        'dimension': dimension,
                        'method': method,
                    },
                    CONTENT_FIELD: {'type': 'text'},
                    'metadata': {'type': 'object', 'enabled': True},
                }
            },
        }
        debug(f'Creating vector index {index} dim={dimension}')
        try:
            client.indices.create(index=index, body=body)
        except Exception as e:
            debug(f'Create vector index failed: {e}')
            raise
        try:
            mapping = client.indices.get_mapping(index=index)
            props = _get_index_properties(mapping, index)
            vec = props.get(VECTOR_FIELD)
            if not vec or vec.get('type') != 'knn_vector':
                debug(f'Post-create mapping check failed for index {index}; vector mapping={vec}')
                raise Exception(f'Index {index} vector field not created as knn_vector')
        except Exception as e:
            debug(f'Verify mapping after create failed: {e}')
            raise

    # ------------------------- Ingestion -------------------------

    def upsert_document(
        self,
        index: str,
        doc_id: Optional[str],
        body: Dict[str, Any],
        refresh: bool = False,
    ) -> None:
        """Index or update a single document (text and/or vector). If doc_id is None, an id is auto-generated."""
        client = self._require_client()
        if client is None:
            return
        debug(f'Upserting document id={doc_id} index={index} body_keys={list(body.keys())}')
        client.index(index=index, id=doc_id, body=body, refresh=refresh)

    def upsert_vector_document(
        self,
        index: str,
        doc_id: str,
        vector: List[float],
        content: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        refresh: bool = False,
    ) -> None:
        """Index or update a single vector document."""
        client = self._require_client()
        if client is None:
            return
        body: Dict[str, Any] = {VECTOR_FIELD: vector}
        if content:
            body[CONTENT_FIELD] = content
        if metadata:
            body['metadata'] = metadata
        debug(f'Upserting vector doc id={doc_id} index={index} vector_dim={len(vector)}')
        client.index(index=index, id=doc_id, body=body, refresh=refresh)

    # ------------------------- Search -------------------------

    def search_vector(
        self,
        index: str,
        vector: Sequence[float],
        k: int = 10,
        source: Optional[List[str]] = None,
        num_candidates: Optional[int] = None,
    ) -> Dict[str, Any]:
        """k-NN search on vector field."""
        client = self._require_client()
        if client is None:
            return {}
        try:
            vector_list = [float(x) for x in vector]
        except Exception:
            debug('search_vector: vector not convertible to float list; aborting')
            return {}
        body: Dict[str, Any] = {
            'size': k,
            'query': {
                'knn': {
                    VECTOR_FIELD: {
                        'vector': vector_list,
                        'k': k,
                    }
                }
            },
        }
        if num_candidates:
            body['query']['knn'][VECTOR_FIELD]['num_candidates'] = num_candidates
        if source is not None:
            body['_source'] = source
        debug(f'Executing vector search index={index} k={k}')
        return client.search(index=index, body=body)

    def search_text_all(
        self,
        index: str,
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
        """
        Scroll/scan all matching documents and return every hit.

        Uses opensearchpy.helpers.scan under the hood.
        """
        client = self._require_client()
        if client is None:
            return []
        if body is None:
            body = self._build_search_body(
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
        debug(f'Executing scan index={index} batch_size={batch_size} scroll={scroll} highlight={highlight}')
        hits: List[Dict[str, Any]] = []
        for hit in helpers.scan(
            client,
            index=index,
            query=body,
            scroll=scroll,
            size=batch_size,
            _source=source,
        ):
            hits.append(hit)
        debug(f'Scan completed hits={len(hits)}')
        return hits

    def _build_search_body(
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
        """Construct a search body for the configured flags."""
        op = (match_operator or 'or').strip().lower()
        if op not in ('and', 'or', 'exact'):
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
            body: Dict[str, Any] = {
                'query': {'bool': {'must': base_query, 'filter': filters}},
                'size': size,
            }
        else:
            body = {'query': base_query, 'size': size}
        if include_source and source is not None:
            body['_source'] = source
        if highlight:
            frag_size = max(int(highlight_fragment_size or 0), 0) or DEFAULT_HIGHLIGHT_FRAGMENT_SIZE
            body['highlight'] = _build_highlight_config(CONTENT_FIELD, frag_size)
        return body

