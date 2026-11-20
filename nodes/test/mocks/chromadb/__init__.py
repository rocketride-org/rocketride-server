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
Mock ChromaDB client for testing.

This mock simulates the ChromaDB Python client for testing vector store operations
without requiring a real ChromaDB instance.

Mocked Components:
    - HttpClient - Main client class
    - Collection - Collection with query, get, upsert, delete, update and count
    - Settings - Client configuration

Storage:
    - Uses class-level storage to persist data across operations within a test
    - Call HttpClient.reset() between tests to clear state

Behaviour mirrored from the real server (the Vector Explorer suites pair these
with the same assertions against a live Chroma, chromadb/chroma 1.5.9):
    - get() returns records in insertion order and honours offset/limit;
      fields left out of ``include`` come back as None.
    - where filters support $and/$or (each with at least two clauses),
      $eq/$ne/$in/$nin/$gt/$gte/$lt/$lte and plain equality; a value of
      another type never matches (True is not 1). A filter the server refuses
      (an empty or over-long $in/$nin list, a short or huge $and/$or) is
      refused by get(), query() and delete() before any record is read.
    - query() distances follow the collection's ``hnsw:space``: cosine
      (1 - cos), l2 (squared euclidean, the default) or ip (1 - dot).
    - upsert() with duplicate ids in one call is refused, as the server does.
    - Every get() is recorded in ``MockCollection.calls`` and every delete()
      in ``MockCollection.deletes`` so tests can assert what a code path sent.
"""

from typing import Any, Dict, List, Optional


# =============================================================================
# Settings (from chromadb.config)
# =============================================================================


class Settings:
    """Mock ChromaDB settings."""

    def __init__(self, chroma_client_auth_provider: str = None, chroma_client_auth_credentials: str = None, **kwargs):
        self.chroma_client_auth_provider = chroma_client_auth_provider
        self.chroma_client_auth_credentials = chroma_client_auth_credentials


# =============================================================================
# Filter evaluation
# =============================================================================

_MISSING = object()


def _same(a: Any, b: Any) -> bool:
    """Equality without Python's bool/int coercion (Chroma metadata values are typed)."""
    if a is _MISSING:
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


# Fewest $and/$or clauses the server refuses (see _matches_where).
_MAX_WHERE_CLAUSES = 998

# Longest $in/$nin list the server accepts. chromadb 1.5.9 binds every value as
# an SQL variable and SQLite allows 32,766 per statement: a lone $in is refused
# from 32,763 values, and from 32,758 next to one more clause ("too many SQL
# variables"). The mock refuses from the smaller of the two.
_MAX_IN_VALUES = 32757


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_where(where: Optional[Dict[str, Any]]) -> None:
    """Refuse a filter the server refuses before reading any record (empty or over-long lists, short $and/$or)."""
    if not where:
        return
    if '$and' in where or '$or' in where:
        op = '$and' if '$and' in where else '$or'
        clauses = where[op]
        if not isinstance(clauses, list) or len(clauses) < 2:
            raise ValueError(
                f'Expected where value for {op} to be a list with at least two where expressions, got {clauses}'
            )
        if len(clauses) >= _MAX_WHERE_CLAUSES:
            raise RuntimeError('Expression tree is too large (maximum depth 1000)')
        for clause in clauses:
            _check_where(clause)
        return
    for condition in where.values():
        if not isinstance(condition, dict):
            continue
        for op, expected in condition.items():
            if op not in ('$in', '$nin'):
                continue
            if not isinstance(expected, list) or not expected:
                raise ValueError(
                    'Expected where operand value to be a non-empty list, '
                    f'and all values to be of the same type got {expected}'
                )
            if len(expected) > _MAX_IN_VALUES:
                raise RuntimeError(
                    'Error executing plan: Internal error: error returned from database: '
                    '(code: 1) too many SQL variables'
                )


def _matches_where(metadata: Dict[str, Any], where: Optional[Dict[str, Any]]) -> bool:
    """Evaluate a Chroma ``where`` filter against one record's metadata."""
    if not where:
        return True
    if '$and' in where or '$or' in where:
        op = '$and' if '$and' in where else '$or'
        clauses = where[op]
        if not isinstance(clauses, list) or len(clauses) < 2:
            raise ValueError(
                f'Expected where value for {op} to be a list with at least two where expressions, got {clauses}'
            )
        if len(clauses) >= _MAX_WHERE_CLAUSES:
            # chromadb 1.5.9 answers 500 for an $or of 998 clauses (500 work): SQLite's
            # expression tree depth limit of 1000. An $in list is bounded by the
            # number of SQL variables instead (_MAX_IN_VALUES).
            raise RuntimeError('Expression tree is too large (maximum depth 1000)')
        results = [_matches_where(metadata, clause) for clause in clauses]
        return all(results) if op == '$and' else any(results)
    for field, condition in where.items():
        value = metadata.get(field, _MISSING)
        if not isinstance(condition, dict):
            condition = {'$eq': condition}
        for op, expected in condition.items():
            if op == '$eq':
                ok = value is not _MISSING and _same(value, expected)
            elif op == '$ne':
                ok = value is _MISSING or not _same(value, expected)
            elif op in ('$in', '$nin') and (not isinstance(expected, list) or not expected):
                # The server refuses an empty list (chromadb 1.5.9 validates it client side).
                raise ValueError(
                    'Expected where operand value to be a non-empty list, '
                    f'and all values to be of the same type got {expected}'
                )
            elif op == '$in':
                ok = value is not _MISSING and any(_same(value, e) for e in expected)
            elif op == '$nin':
                ok = value is _MISSING or not any(_same(value, e) for e in expected)
            elif op in ('$gt', '$gte', '$lt', '$lte'):
                if not _number(value):
                    ok = False
                elif op == '$gt':
                    ok = value > expected
                elif op == '$gte':
                    ok = value >= expected
                elif op == '$lt':
                    ok = value < expected
                else:
                    ok = value <= expected
            else:
                raise ValueError(f'Unsupported where operator {op}')
            if not ok:
                return False
    return True


def _matches_document(document: str, where_document: Optional[Dict[str, Any]]) -> bool:
    if not where_document:
        return True
    if '$contains' in where_document:
        return where_document['$contains'] in (document or '')
    if '$not_contains' in where_document:
        return where_document['$not_contains'] not in (document or '')
    return True


def _distance(space: str, a: List[float], b: List[float]) -> float:
    if len(a) != len(b):
        return 1.0
    if space == 'ip':
        return 1.0 - sum(x * y for x, y in zip(a, b))
    if space == 'cosine':
        dot = sum(x * y for x, y in zip(a, b))
        norm = (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5)
        return 1.0 if not norm else 1.0 - dot / norm
    return float(sum((x - y) ** 2 for x, y in zip(a, b)))


# =============================================================================
# Mock Collection
# =============================================================================


class MockCollection:
    """Mock ChromaDB collection."""

    # Class-level storage: {collection_name: {id: {embedding, metadata, document}}}
    _all_storage: Dict[str, Dict[str, Dict]] = {}
    _collection_metadata: Dict[str, Dict] = {}

    # Every get(): {'collection', 'ids', 'where', 'include', 'limit', 'offset'}
    calls: List[Dict[str, Any]] = []

    # Every delete(): {'collection', 'ids', 'where'}
    deletes: List[Dict[str, Any]] = []

    def __init__(self, name: str, metadata: Dict = None):
        self.name = name
        self.id = name
        if name not in MockCollection._all_storage:
            MockCollection._all_storage[name] = {}
        if metadata:
            MockCollection._collection_metadata[name] = metadata

    @property
    def _storage(self) -> Dict[str, Dict]:
        return MockCollection._all_storage.get(self.name, {})

    @property
    def metadata(self) -> Optional[Dict[str, Any]]:
        """Collection metadata as created (``{'hnsw:space': ...}``), or None."""
        return MockCollection._collection_metadata.get(self.name)

    @property
    def configuration_json(self) -> Dict[str, Any]:
        """The collection configuration as the server reports it (HNSW parameters)."""
        return {'hnsw': {'space': self._space(), 'ef_construction': 100, 'ef_search': 100, 'max_neighbors': 16}}

    def _space(self) -> str:
        return (self.metadata or {}).get('hnsw:space', 'l2')

    def count(self) -> int:
        """Number of records in the collection."""
        return len(self._storage)

    def query(
        self,
        query_embeddings: List[List[float]] = None,
        n_results: int = 10,
        where: Optional[Dict] = None,
        where_document: Optional[Dict] = None,
        include: List[str] = None,
    ) -> Dict[str, Any]:
        """Nearest records to each query embedding, by the collection's distance."""
        if include is None:
            include = ['metadatas', 'documents', 'distances']
        _check_where(where)
        results: Dict[str, Any] = {'ids': [], 'metadatas': [], 'documents': [], 'distances': [], 'embeddings': []}
        space = self._space()
        for query_vector in query_embeddings or []:
            matches = []
            for id, data in self._storage.items():
                if not _matches_where(data.get('metadata', {}), where):
                    continue
                if not _matches_document(data.get('document', ''), where_document):
                    continue
                matches.append((id, data, _distance(space, list(query_vector), list(data.get('embedding') or []))))
            matches.sort(key=lambda m: m[2])
            matches = matches[:n_results]
            results['ids'].append([m[0] for m in matches])
            results['metadatas'].append([dict(m[1].get('metadata', {})) for m in matches])
            results['documents'].append([m[1].get('document', '') for m in matches])
            results['distances'].append([m[2] for m in matches])
            results['embeddings'].append([list(m[1].get('embedding') or []) for m in matches])
        for field in ('metadatas', 'documents', 'distances', 'embeddings'):
            if field not in include:
                results[field] = None
        return results

    def get(
        self,
        ids: Any = None,
        where: Optional[Dict] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        where_document: Optional[Dict] = None,
        include: List[str] = None,
    ) -> Dict[str, Any]:
        """Records matching ``ids``/``where``, in insertion order, after ``offset``, at most ``limit``."""
        if include is None:
            include = ['metadatas', 'documents']
        if isinstance(ids, str):
            ids = [ids]
        MockCollection.calls.append(
            {
                'collection': self.name,
                'ids': None if ids is None else list(ids),
                'where': where,
                'include': list(include),
                'limit': limit,
                'offset': offset,
            }
        )
        _check_where(where)
        wanted = None if ids is None else set(ids)
        rows = [
            (id, data)
            for id, data in self._storage.items()
            if (wanted is None or id in wanted)
            and _matches_where(data.get('metadata', {}), where)
            and _matches_document(data.get('document', ''), where_document)
        ]
        start = int(offset or 0)
        rows = rows[start:] if limit is None else rows[start : start + int(limit)]
        return {
            'ids': [id for id, _ in rows],
            'metadatas': [dict(d.get('metadata', {})) for _, d in rows] if 'metadatas' in include else None,
            'documents': [d.get('document', '') for _, d in rows] if 'documents' in include else None,
            'embeddings': [list(d.get('embedding') or []) for _, d in rows] if 'embeddings' in include else None,
            'included': list(include),
        }

    def upsert(
        self,
        ids: List[str],
        embeddings: List[List[float]] = None,
        metadatas: List[Dict] = None,
        documents: List[str] = None,
    ):
        """Insert or replace records by id (duplicate ids in one call are refused)."""
        if len(set(ids)) != len(ids):
            raise ValueError('Expected IDs to be unique, found duplicates')
        for i, id in enumerate(ids):
            self._storage[id] = {
                'embedding': list(embeddings[i]) if embeddings else [],
                'metadata': dict(metadatas[i]) if metadatas else {},
                'document': documents[i] if documents else '',
            }

    def add(
        self,
        ids: List[str],
        embeddings: List[List[float]] = None,
        metadatas: List[Dict] = None,
        documents: List[str] = None,
    ):
        """Add items to the collection."""
        self.upsert(ids, embeddings, metadatas, documents)

    def delete(self, ids: List[str] = None, where: Optional[Dict] = None, where_document: Optional[Dict] = None):
        """Delete the records matching ``ids`` and/or ``where``."""
        _check_where(where)
        MockCollection.deletes.append(
            {'collection': self.name, 'ids': None if ids is None else list(ids), 'where': where}
        )
        wanted = None if ids is None else set(ids)
        doomed = [
            id
            for id, data in self._storage.items()
            if (wanted is None or id in wanted)
            and (where is None or _matches_where(data.get('metadata', {}), where))
            and (where_document is None or _matches_document(data.get('document', ''), where_document))
        ]
        if wanted is None and where is None and where_document is None:
            doomed = []
        for id in doomed:
            del self._storage[id]

    def update(
        self,
        ids: List[str] = None,
        embeddings: List[List[float]] = None,
        metadatas: List[Dict] = None,
        documents: List[str] = None,
        where: Optional[Dict] = None,
        new_metadata: Dict = None,
    ):
        """
        Update records by id: replace the metadata/document/embedding given for each.

        ``where``/``new_metadata`` are accepted for older call sites only; the
        real client has no such parameters.
        """
        for i, id in enumerate(ids or []):
            if id not in self._storage:
                continue
            if metadatas is not None:
                self._storage[id]['metadata'] = dict(metadatas[i])
            if documents is not None:
                self._storage[id]['document'] = documents[i]
            if embeddings is not None:
                self._storage[id]['embedding'] = list(embeddings[i])
            if new_metadata:
                self._storage[id]['metadata'].update(new_metadata)
        if ids is None and where and new_metadata:
            for data in self._storage.values():
                if _matches_where(data.get('metadata', {}), where):
                    data['metadata'].update(new_metadata)


# =============================================================================
# Mock HTTP Client
# =============================================================================


class HttpClient:
    """Mock ChromaDB HTTP client."""

    # Class-level set of collection names
    _collections: set = set()

    def __init__(self, host: str = 'localhost', port: int = 8000, settings: Settings = None, **kwargs):
        self.host = host
        self.port = port
        self.settings = settings

    def get_version(self) -> str:
        """Server API version (the 1.5.9 server reports '1.0.0')."""
        return '1.0.0'

    def heartbeat(self) -> int:
        return 1

    def list_collections(self) -> List[MockCollection]:
        """List all collections."""
        return [MockCollection(name) for name in sorted(HttpClient._collections)]

    def get_collection(self, name: str) -> MockCollection:
        """Get a collection by name."""
        if name not in HttpClient._collections:
            raise ValueError(f'Collection {name} does not exist.')
        return MockCollection(name)

    def get_or_create_collection(self, name: str, metadata: Dict = None, **kwargs) -> MockCollection:
        """Get or create a collection."""
        HttpClient._collections.add(name)
        return MockCollection(name, metadata)

    def create_collection(self, name: str, metadata: Dict = None, **kwargs) -> MockCollection:
        """Create a new collection."""
        HttpClient._collections.add(name)
        return MockCollection(name, metadata)

    def delete_collection(self, name: str):
        """Delete a collection."""
        if name in HttpClient._collections:
            HttpClient._collections.remove(name)
        if name in MockCollection._all_storage:
            del MockCollection._all_storage[name]
        MockCollection._collection_metadata.pop(name, None)

    @classmethod
    def reset(cls):
        """Reset all mock state for testing."""
        cls._collections.clear()
        MockCollection._all_storage.clear()
        MockCollection._collection_metadata.clear()
        MockCollection.calls.clear()
        MockCollection.deletes.clear()


# Alias for backwards compatibility
Collection = MockCollection


# =============================================================================
# Config submodule
# =============================================================================


class config:
    """Mock config submodule."""

    Settings = Settings
