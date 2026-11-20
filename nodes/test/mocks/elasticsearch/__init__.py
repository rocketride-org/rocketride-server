# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Mock elasticsearch for index_search node tests.

When ROCKETRIDE_MOCK is set, this module shadows the real elasticsearch package
so the Elasticsearch store uses in-memory storage. Supports indices.exists/create/
delete, index(), search(), bulk(), scan(), cluster.health(), and close().

search() applies the term and range clauses under bool.must, a sort on fields,
from/size, and the server's index.max_result_window limit. Other query clauses
match every document.
"""

from typing import Any, Dict, List, Optional

from . import _store_data

_store = _store_data._store
_indices = _store_data._indices

# index.max_result_window on an index with default settings
MAX_RESULT_WINDOW = 10000


def _field(source: Dict[str, Any], path: str) -> Any:
    """The value at a dotted path such as 'meta.chunkId', or None."""
    value: Any = source
    for part in path.split('.'):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _sort_key(value: Any) -> tuple:
    """Sort missing values last, as Elasticsearch does for an ascending sort."""
    return (value is None, value)


def _matches(source: Dict[str, Any], clause: Dict[str, Any]) -> bool:
    """
    Whether a document matches one bool.must clause.

    Only term and range are applied. Any other clause (match, knn, ...) matches
    every document, as this mock did before it applied filters at all.
    """
    if not isinstance(clause, dict) or len(clause) != 1:
        return True
    ((kind, condition),) = clause.items()
    if kind not in ('term', 'range') or not isinstance(condition, dict) or len(condition) != 1:
        return True
    ((path, expected),) = condition.items()
    actual = _field(source, path)
    if kind == 'term':
        if isinstance(expected, dict):
            expected = expected.get('value')
        return actual == expected
    if actual is None:
        return False
    checks = {
        'gte': lambda b: actual >= b,
        'gt': lambda b: actual > b,
        'lte': lambda b: actual <= b,
        'lt': lambda b: actual < b,
    }
    return all(checks[op](bound) for op, bound in expected.items() if op in checks)


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
        # Like a server with default index settings, reject a page past index.max_result_window
        body = body or {}
        window = int(body.get('from', 0) or 0) + int(body.get('size', 10) or 0)
        if window > MAX_RESULT_WINDOW:
            raise ValueError(
                f'Result window is too large, from + size must be less than or equal to: '
                f'[{MAX_RESULT_WINDOW}] but was [{window}]. This limit can be set by changing the '
                f'[index.max_result_window] index level setting.'
            )

        docs = _store.get(index, [])
        hits = []
        for i, d in enumerate(docs):
            src = d.get('_source', {})
            if not all(_matches(src, clause) for clause in body.get('query', {}).get('bool', {}).get('must', [])):
                continue
            hits.append(
                {
                    '_index': index,
                    '_id': d.get('_id', str(i)),
                    '_score': 0.9,
                    '_source': src,
                }
            )
        total = len(hits)

        # Sort on fields (stable, so equal values keep storage order); '_score' and the like are left alone
        for sort in reversed(body.get('sort', [])):
            if isinstance(sort, dict):
                ((path, order),) = sort.items()
                descending = (order.get('order') if isinstance(order, dict) else order) == 'desc'
                hits.sort(key=lambda hit, path=path: _sort_key(_field(hit['_source'], path)), reverse=descending)

        # A request that names a size gets that page only
        if 'size' in body:
            start = int(body.get('from', 0) or 0)
            hits = hits[start : start + int(body['size'] or 0)]
        return {'hits': {'total': {'value': total}, 'hits': hits}}

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
