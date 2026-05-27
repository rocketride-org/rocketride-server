# Mock elasticsearch.helpers for index_search tests (shares store with elasticsearch mock).
from typing import Any, List, Iterator, Optional, Dict

from . import _store_data


def bulk(client: Any, actions: List[Dict[str, Any]], **kwargs: Any) -> Any:
    _store = _store_data._store
    for action in actions:
        idx = action.get('_index', 'default')
        if idx not in _store:
            _store[idx] = []
        doc_id = action.get('_id') or str(len(_store[idx]) + 1)
        _store[idx].append({'_id': doc_id, '_source': action.get('_source', {})})
    return (len(actions), [])


def scan(
    client: Any,
    index: str,
    query: Optional[Dict] = None,
    scroll: str = '1m',
    size: int = 500,
    _source: Optional[List[str]] = None,
    **kwargs: Any,
) -> Iterator[Dict[str, Any]]:
    _store = _store_data._store
    docs = _store.get(index, [])
    for i, d in enumerate(docs):
        yield {
            '_index': index,
            '_id': d.get('_id', str(i)),
            '_score': 0.9,
            '_source': d.get('_source', {}),
        }
