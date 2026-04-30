# Mock opensearchpy.helpers for index_search tests.
from typing import Any, Iterator, Optional, Dict, List

from . import _store_data


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
