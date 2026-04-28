# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Mock opensearchpy for index_search node tests.

When ROCKETRIDE_MOCK is set, this module shadows the real opensearchpy package
so the OpenSearch client uses in-memory storage. Supports indices.exists/create/
delete/get_mapping, index(), search(), helpers.scan(), ping(), and close().
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

    def get_mapping(self, index: str) -> Dict[str, Any]:
        m = _indices.get(index, {})
        mappings = m.get('mappings', {})
        if isinstance(mappings, dict) and 'properties' not in mappings:
            mappings = {'properties': mappings}
        return {index: {'mappings': mappings}}


class OpenSearch:
    def __init__(self, hosts: Optional[List[str]] = None, http_auth: Optional[tuple] = None, **kwargs: Any) -> None:
        self.indices = IndicesMock()

    def ping(self) -> bool:
        return True

    def index(
        self, index: str, id: Optional[str] = None, body: Optional[Dict] = None, refresh: bool = False, **kwargs: Any
    ) -> Dict[str, Any]:
        if index not in _store:
            _store[index] = []
        doc_id = id or str(len(_store[index]) + 1)
        _store[index].append({'_id': doc_id, '_source': body or {}})
        return {'_id': doc_id, 'result': 'created'}

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

    def close(self) -> None:
        pass
