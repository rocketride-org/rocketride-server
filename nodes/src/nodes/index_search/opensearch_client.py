"""
Client wrapper for OpenSearch 2.x.

High-level facade for OpenSearch index and search workloads.
Uses opensearch-py (~2.13.x).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from rocketlib import debug
from opensearchpy import OpenSearch, helpers  # type: ignore


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


class OpenSearchClient:
    """
    High-level client facade for OpenSearch index and search workloads.

    Supports both text/BM25 and k-NN vector search modes.
    """

    def __init__(
        self,
        host: str = 'http://localhost:9200',
        username: Optional[str] = None,
        password: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """Initialize the OpenSearch client with optional basic auth."""
        http_auth = None
        if username:
            http_auth = (username, password or '')

        self.client: Optional[OpenSearch] = OpenSearch(hosts=[host], http_auth=http_auth, **kwargs)

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
        if self.client is None:
            return False
        ok = bool(self.client.ping())
        debug(f'Ping OpenSearch -> {ok}')
        return ok

    # ------------------------- Index lifecycle -------------------------

    def ensure_index_text(self, index: str, mappings: Optional[Dict[str, Any]] = None) -> None:
        """Create a text/BM25 index if missing.

        SDK: client.indices.exists(index), client.indices.create(index, body=...).
        Mapping example: {"properties": {"content": {"type": "text"}}}
        """
        if self.client is None:
            debug('ensure_index_text called without client')
            return

        if not self.client.indices.exists(index=index):
            debug(f'Creating index {index}')
            body: Dict[str, Any] = {}
            if mappings:
                body['mappings'] = mappings
            else:
                body['mappings'] = {'properties': {'content': {'type': 'text'}}}
            self.client.indices.create(index=index, body=body, ignore=[400])
        else:
            debug(f'Index {index} already exists')

    def ensure_index_vector(
        self,
        index: str,
        dimension: int,
        method: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Create a vector index if missing (knn_vector)."""
        if self.client is None:
            debug('ensure_index_vector called without client')
            return

        if not method:
            method = {
                'name': 'hnsw',
                'engine': 'faiss',
                'space_type': 'cosinesimil',
            }

        recreate = False
        if self.client.indices.exists(index=index):
            mapping = self.client.indices.get_mapping(index=index)
            debug(f'Mapping: {mapping}')
            props = ((mapping.get(index, {}) or {}).get('mappings', {}) or {}).get('properties', {}) or {}
            vec = props.get('vector')
            if not vec or vec.get('type') != 'knn_vector' or int(vec.get('dimension', 0)) != dimension:
                debug(f'Existing index {index} missing knn_vector "vector" or dim mismatch; recreating')
                recreate = True
            else:
                debug(f'Vector index {index} already exists with correct mapping')
                return

        if recreate:
            try:
                self.client.indices.delete(index=index, ignore=[400, 404])
            except Exception as e:
                debug(f'Failed to delete index {index} before recreate: {e}')
                raise

        body: Dict[str, Any] = {
            'settings': {
                'index': {
                    'knn': True,
                }
            },
            'mappings': {
                'properties': {
                    'vector': {
                        'type': 'knn_vector',
                        'dimension': dimension,
                        'method': method,
                    },
                    'content': {'type': 'text'},
                    'metadata': {'type': 'object', 'enabled': True},
                }
            },
        }
        debug(f'Creating vector index {index} dim={dimension}')
        try:
            self.client.indices.create(index=index, body=body)
        except Exception as e:
            debug(f'Create vector index failed: {e}')
            raise

        # Verify mapping to avoid silent fallback to incorrect types
        try:
            mapping = self.client.indices.get_mapping(index=index)
            props = ((mapping.get(index, {}) or {}).get('mappings', {}) or {}).get('properties', {}) or {}
            vec = props.get('vector')
            if not vec or vec.get('type') != 'knn_vector':
                debug(f'Post-create mapping check failed for index {index}; vector mapping={vec}')
                raise Exception(f'Index {index} vector field not created as knn_vector')
        except Exception as e:
            debug(f'Verify mapping after create failed: {e}')
            raise

    # ------------------------- Ingestion -------------------------

    def upsert_document(self, index: str, doc_id: str, body: Dict[str, Any], refresh: bool = False) -> None:
        """Index or update a single document (text and/or vector).

        SDK: client.index(index=index, id=doc_id, body=body, refresh=refresh)
        """
        if self.client is None:
            debug('upsert_document called without client')
            return
        debug(f'Upserting document id={doc_id} index={index} body_keys={list(body.keys())}')
        self.client.index(index=index, id=doc_id, body=body, refresh=refresh)

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
        if self.client is None:
            debug('upsert_vector_document called without client')
            return
        body: Dict[str, Any] = {'vector': vector}
        if content:
            body['content'] = content
        if metadata:
            body['metadata'] = metadata
        debug(f'Upserting vector doc id={doc_id} index={index} vector_dim={len(vector)}')
        self.client.index(index=index, id=doc_id, body=body, refresh=refresh)

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
        if self.client is None:
            return {}

        try:
            vector_list = [float(x) for x in vector]
        except Exception:
            debug('search_vector: vector not convertible to float list; aborting')
            return {}

        # Use the OpenSearch k-NN shape: field name -> {vector, k, num_candidates}
        body: Dict[str, Any] = {
            'size': k,
            'query': {
                'knn': {
                    'vector': {
                        'vector': vector_list,
                        'k': k,
                    }
                }
            },
        }
        if num_candidates:
            body['query']['knn']['vector']['num_candidates'] = num_candidates
        if source is not None:
            body['_source'] = source
        debug(f'Executing vector search index={index} k={k} body={body}')
        return self.client.search(index=index, body=body)

    def search_text_all(
        self,
        index: str,
        query: str,
        batch_size: int = 500,
        scroll: str = '1m',
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
        if self.client is None:
            return []

        if body is None:
            body = self._build_search_body(
                query=query,
                filters=filters,
                source=source,
                match_operator=match_operator,
                match_operator_slop=match_operator_slop,
                size=batch_size,
                include_source=False,  # handled via scan arguments
                highlight=highlight,
                highlight_fragment_size=highlight_fragment_size,
            )

        debug(f'Executing scan index={index} batch_size={batch_size} scroll={scroll} body_query={body.get("query")} highlight={highlight} fragment_size={highlight_fragment_size}')

        hits: List[Dict[str, Any]] = []
        for hit in helpers.scan(
            self.client,
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
        base_query: Dict[str, Any]

        op = (match_operator or 'or').strip().lower()
        if op not in ('and', 'or', 'exact'):
            op = 'or'

        if op == 'exact':
            base_query = {
                'match_phrase': {
                    'content': {
                        'query': query,
                        'slop': max(int(match_operator_slop or 0), 0),
                    }
                }
            }
        elif op == 'and':
            base_query = {'match': {'content': {'query': query, 'operator': 'and'}}}
        elif op == 'or':
            base_query = {'match': {'content': {'query': query, 'operator': 'or'}}}
        else:
            base_query = {'match': {'content': query}}

        if filters:
            body: Dict[str, Any] = {
                'query': {
                    'bool': {
                        'must': base_query,
                        'filter': filters,
                    }
                },
                'size': size,
            }
        else:
            body = {'query': base_query, 'size': size}

        if include_source and source is not None:
            body['_source'] = source

        if highlight:
            frag_size = max(int(highlight_fragment_size or 0), 0) or 250
            body['highlight'] = _build_highlight_config('content', frag_size)

        return body

