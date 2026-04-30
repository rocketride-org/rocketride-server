# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Mock elasticsearch for index_search node tests.

When ROCKETRIDE_MOCK is set, this module shadows the real elasticsearch package
so the Elasticsearch store uses in-memory storage. Supports indices.exists/create/
delete, index(), search(), bulk(), scan(), cluster.health(), and close().
"""

from typing import Any, Dict, List, Optional

from . import _store_data

_store = _store_data._store
_indices = _store_data._indices


class IndicesMock:
    def exists(self, index: str) -> bool:
        return index in _indices or index in _store

    def create(self, index: str, body: Optional[Dict] = None, ignore: Optional[List[int]] = None) -> None:
        _indices[index] = body or {}
        if index not in _store:
            _store[index] = []

    def delete(self, index: str, ignore: Optional[List[int]] = None) -> None:
        _indices.pop(index, None)
        _store.pop(index, None)


class ClusterMock:
    def health(self) -> Dict[str, Any]:
        return {'status': 'green'}


class Elasticsearch:
    def __init__(
        self, hosts: Optional[List[str]] = None, api_key: Optional[str] = None, request_timeout: int = 60, **kwargs: Any
    ) -> None:
        self.indices = IndicesMock()
        self.cluster = ClusterMock()

    def index(
        self, index: str, id: Optional[str] = None, body: Optional[Dict] = None, refresh: bool = False, **kwargs: Any
    ) -> Dict[str, Any]:
        if index not in _store:
            _store[index] = []
        doc_id = id or str(len(_store[index]) + 1)
        _store[index].append({'_id': doc_id, '_source': body or {}})
        return {'_id': doc_id, 'result': 'created'}

    def count(self, index: str, **kwargs: Any) -> Dict[str, int]:
        return {'count': len(_store.get(index, []))}

    def search(self, index: str, body: Optional[Dict] = None, **kwargs: Any) -> Dict[str, Any]:
        docs = _store.get(index, [])
        hits = []
        for i, d in enumerate(docs):
            src = d.get('_source', {})
            hits.append(
                {
                    '_index': index,
                    '_id': d.get('_id', str(i)),
                    '_score': 0.9,
                    '_source': src,
                }
            )
        return {'hits': {'total': {'value': len(hits)}, 'hits': hits}}

    def delete_by_query(
        self, index: str, body: Optional[Dict] = None, wait_for_completion: bool = True, **kwargs: Any
    ) -> Dict[str, Any]:
        if index not in _store:
            return {'deleted': 0}
        terms = (body or {}).get('query', {}).get('terms', {})
        if 'meta.objectId' in terms:
            ids = set(terms['meta.objectId'])
            before = len(_store[index])
            _store[index] = [
                d for d in _store[index] if d.get('_source', {}).get('meta', {}).get('objectId') not in ids
            ]
            return {'deleted': before - len(_store[index])}
        return {'deleted': 0}

    def update_by_query(
        self, index: str, body: Optional[Dict] = None, wait_for_completion: bool = True, **kwargs: Any
    ) -> Dict[str, Any]:
        return {'updated': 0}

    def close(self) -> None:
        pass
