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
Mock astrapy Module for Testing
===============================

This module provides a mock implementation of the astrapy library for testing
RocketRide's Astra DB vector store integration without requiring a real Astra DB server.

How Mock Injection Works:
-------------------------
1. The test framework sets ROCKETRIDE_MOCK environment variable to point to nodes/test/mocks/
2. When the EAAS server starts a pipeline subprocess (node.py), it inherits this env var
3. node.py detects ROCKETRIDE_MOCK and inserts that path at the FRONT of sys.path
4. When the astra_db node does `from astrapy import DataAPIClient`, Python finds
   THIS mock module first (because sys.path is searched in order)
5. The real astrapy is never loaded - this mock completely shadows it

Key Design Principles:
----------------------
1. MIRROR THE REAL API: Export the same classes, functions, and submodules that the
   real library provides. The node code shouldn't need any changes to use the mock.

2. CLASS-LEVEL STATE: Use class variables (not instance variables) for storage so
   that data persists across multiple client instances within the same process.
   This simulates a real database server that multiple clients can connect to.

3. MONGODB-STYLE QUERIES: Astra DB uses MongoDB-style query operators ($in, $gte, etc.)
   The mock must parse and evaluate these filter expressions.

Usage:
------
The mock is automatically loaded when running tests via:
    builder nodes:test --pytest="-k astra_db"

Or manually:
    set ROCKETRIDE_MOCK=C:\\Projects\\rocketride-server\\nodes\\test\\mocks
    python -m pytest nodes/test/test_dynamic.py -k astra_db -s -v
"""

from typing import List, Any, Dict, Iterator
from dataclasses import dataclass
import copy
import math
import re


# =============================================================================
# Submodule Imports - Create submodules for proper import structure
# =============================================================================

from . import data_types
from . import exceptions
from . import info
from .exceptions import DataAPIResponseException, TooManyDocumentsToCountException

# Re-export commonly used types
from .data_types import DataAPIVector
from .info import CollectionDefinition, CollectionVectorOptions, CollectionLexicalOptions


# =============================================================================
# Data API limits the drivers must live with
# =============================================================================

#: A find sorted on a regular field returns at most this many documents and stops there
#: (astrapy ``Collection.find``: "the Data API will return a smaller number of documents, set to 20")
SORTED_FIND_MAX = 20

#: A find sorted on a regular field sorts the matching documents in memory, at most this many
IN_MEMORY_SORT_LIMIT = 10000


@dataclass
class FindPage:
    """One page of a find (``astrapy.data.cursors.pagination.FindPage``)."""

    results: List[Dict[str, Any]]
    next_page_state: Any = None
    sort_vector: Any = None


def _encode_page_state(offset: int) -> str:
    """The opaque page state of the page starting at ``offset``."""
    return f'mock-page-state:{offset}'


def _decode_page_state(state: Any) -> int:
    """Offset of a page state from :func:`_encode_page_state`."""
    if not isinstance(state, str) or not state.startswith('mock-page-state:'):
        raise DataAPIResponseException('Invalid page state', error_code='INVALID_PAGE_STATE')
    return int(state.split(':', 1)[1])


# =============================================================================
# Payload Serialization Helper
# =============================================================================


def _serialize_value(value: Any, exclude_none: bool = False) -> Any:
    """
    Serialize a value, converting Pydantic models and dataclasses to dicts.

    Args:
        value: The value to serialize
        exclude_none: If True, exclude None values from dicts (important for Pydantic validation)
    """
    if value is None:
        return None

    if hasattr(value, 'model_dump'):
        # Pydantic v2 model - always exclude None to avoid validation errors
        return value.model_dump(exclude_none=True)
    elif hasattr(value, '__dict__') and not isinstance(value, (str, int, float, bool, list, dict)):
        # Regular object/dataclass - exclude None values
        return {attr: val for attr, val in value.__dict__.items() if val is not None}
    elif isinstance(value, dict):
        if exclude_none:
            return {k: _serialize_value(v, exclude_none=True) for k, v in value.items() if v is not None}
        return {k: _serialize_value(v, exclude_none=False) for k, v in value.items()}
    elif isinstance(value, list):
        return [_serialize_value(item, exclude_none=exclude_none) for item in value]
    else:
        return value


# =============================================================================
# MongoDB-Style Filter Evaluator
# =============================================================================


def _evaluate_filter(filter_dict: Dict[str, Any], document: Dict[str, Any]) -> bool:
    """
    Evaluate a MongoDB-style filter against a document.

    Supports operators: $in, $gte, $lte, $gt, $lt, $regex, $eq, $ne, $exists
    Supports dot notation for nested fields: 'meta.objectId'

    Args:
        filter_dict: MongoDB-style filter (e.g., {'meta.objectId': {'$in': ['doc-1']}})
        document: The document to evaluate

    Returns:
        True if the document matches the filter, False otherwise
    """
    if not filter_dict:
        return True

    for field_path, condition in filter_dict.items():
        # Logical operators
        if field_path == '$and':
            if not all(_evaluate_filter(sub, document) for sub in condition):
                return False
            continue
        if field_path == '$or':
            if not any(_evaluate_filter(sub, document) for sub in condition):
                return False
            continue

        # Get the value from the document using dot notation
        value = document
        for part in field_path.split('.'):
            if isinstance(value, dict):
                value = value.get(part)
            elif hasattr(value, part):
                value = getattr(value, part)
            elif hasattr(value, '__dict__'):
                value = value.__dict__.get(part)
            else:
                value = None
                break

        # Evaluate the condition
        if isinstance(condition, dict):
            # Complex condition with operators
            for op, expected in condition.items():
                if op == '$in':
                    if value not in expected:
                        return False
                elif op == '$nin':
                    if value in expected:
                        return False
                elif op == '$gte':
                    if value is None or value < expected:
                        return False
                elif op == '$lte':
                    if value is None or value > expected:
                        return False
                elif op == '$gt':
                    if value is None or value <= expected:
                        return False
                elif op == '$lt':
                    if value is None or value >= expected:
                        return False
                elif op == '$eq':
                    if value != expected:
                        return False
                elif op == '$ne':
                    if value == expected:
                        return False
                elif op == '$regex':
                    if value is None or not re.search(expected, str(value)):
                        return False
                elif op == '$exists':
                    if expected and value is None:
                        return False
                    if not expected and value is not None:
                        return False
        else:
            # Simple equality
            if value != condition:
                return False

    return True


# =============================================================================
# Mock Collection Class
# =============================================================================


@dataclass
class CollectionDeleteResult:
    """Result of ``delete_many`` (``astrapy.results.CollectionDeleteResult``)."""

    deleted_count: int


def _get_path(document: Dict[str, Any], path: str) -> Any:
    """Read a dotted path from a document."""
    value: Any = document
    for part in path.split('.'):
        if isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def _similarity(metric: str, a: List[float], b: List[float]) -> float:
    """The Data API's ``$similarity``: normalised to [0, 1] for every metric."""
    if not a or not b or len(a) != len(b):
        return 0.0
    if metric == 'euclidean':
        return 1.0 / (1.0 + sum((x - y) ** 2 for x, y in zip(a, b)))
    dot = sum(x * y for x, y in zip(a, b))
    if metric == 'dot_product':
        return (1.0 + dot) / 2.0
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return (1.0 + dot / (na * nb)) / 2.0


class Collection:
    """
    Mock implementation of an Astra DB collection.

    Provides methods for CRUD operations on documents within the collection.
    Data is stored in the parent Database's class-level storage.
    """

    def __init__(self, name: str, database: 'Database'):
        """
        Initialize a collection reference.

        Args:
            name: Collection name
            database: Parent database instance
        """
        self.name = name
        self._database = database

    def _get_data(self) -> List[Dict[str, Any]]:
        """Get the data list for this collection."""
        return Database._data.get(self.name, [])

    def find(
        self,
        filter: Dict[str, Any] = None,
        sort: Dict[str, Any] = None,
        limit: int = None,
        skip: int = None,
        projection: Dict[str, Any] = None,
        include_similarity: bool = False,
        include_sort_vector: bool = False,
        **kwargs,
    ) -> 'Cursor':
        """
        Find documents matching the filter.

        Mirrors the Data API: ``sort`` is either ``{'$vector': [...]}`` (ranked by
        similarity, ``$similarity`` added when ``include_similarity``) or field sorts
        (``{'meta.chunkId': 1}``); ``skip`` is only accepted with a field sort; ``$vector``
        is returned only when the projection asks for it. Stored documents are never mutated.

        Args:
            filter: MongoDB-style filter conditions
            sort: Sort specification
            limit: Maximum documents to return
            skip: Number of documents to skip (needs a field sort)
            projection: Fields to include/exclude
            include_similarity: Whether to include similarity scores
            include_sort_vector: Whether to include sort vector

        Returns:
            Cursor over matching documents
        """
        if 'initial_page_state' in kwargs and kwargs['initial_page_state'] is None:
            raise ValueError('Passing an explicit null for initial_page_state is not allowed.')
        page_start = 0
        if kwargs.get('initial_page_state') is not None:
            page_start = _decode_page_state(kwargs['initial_page_state'])
        data = [doc for doc in self._get_data() if not filter or _evaluate_filter(filter, doc)]
        vector_sort = bool(sort) and '$vector' in sort
        field_sort = bool(sort) and not vector_sort and '$lexical' not in sort
        if skip and (not sort or vector_sort):
            raise ValueError('skip is only allowed together with a field sort')
        if field_sort and len(data) > IN_MEMORY_SORT_LIMIT:
            raise DataAPIResponseException(
                'Response data set too big to be sorted, add more filters', error_code='DATASET_TOO_BIG'
            )

        if vector_sort:
            metric = self._metric()
            scored = [(_similarity(metric, sort['$vector'], list(doc.get('$vector') or [])), doc) for doc in data]
            scored.sort(key=lambda pair: -pair[0])
            data = []
            for score, doc in scored:
                doc = dict(doc)
                if include_similarity:
                    doc['$similarity'] = score
                data.append(doc)
        elif sort:
            for key, direction in reversed(list(sort.items())):
                data.sort(
                    key=lambda doc: (_get_path(doc, key) is not None, _get_path(doc, key)), reverse=direction == -1
                )

        # Apply skip
        if skip:
            data = data[skip:]

        # Apply limit; a field sort returns at most SORTED_FIND_MAX documents and does not page
        if limit:
            data = data[:limit]
        if field_sort:
            data = data[:SORTED_FIND_MAX]

        # Apply projection: $vector only on request; allow-list or deny-list of fields (a dotted key
        # such as 'meta.parent' names a nested field, as on the Data API)
        projection = projection or {}
        include_vector = projection.get('$vector') in (1, True)
        allow = [k for k, v in projection.items() if v in (1, True) and not k.startswith('$')]
        deny = [k for k, v in projection.items() if v in (0, False) and not k.startswith('$')]
        projected = []
        for doc in data:
            out = {k: copy.deepcopy(v) for k, v in doc.items() if k != '$vector'}
            if allow:
                kept = {k: v for k, v in out.items() if k in allow or k in ('_id', '$similarity')}
                for key in allow:
                    if '.' in key:
                        value = _get_path(doc, key)
                        if value is not None:
                            node = kept
                            *parents, leaf = key.split('.')
                            for part in parents:
                                node = node.setdefault(part, {})
                            node[leaf] = copy.deepcopy(value)
                out = kept
            for k in deny:
                if '.' in k:
                    *parents, leaf = k.split('.')
                    node = out
                    for part in parents:
                        node = node.get(part) if isinstance(node, dict) else None
                    if isinstance(node, dict):
                        node.pop(leaf, None)
                else:
                    out.pop(k, None)
            if include_vector and '$vector' in doc:
                out['$vector'] = list(doc['$vector'])
            projected.append(out)

        # Unsorted finds page through everything (Database.page_size per request); sorted ones do not
        return Cursor(projected, start=page_start, page_size=None if sort else Database.page_size)

    def _metric(self) -> str:
        """The collection's vector metric."""
        definition = (Database._collections.get(self.name) or {}).get('definition')
        vector = getattr(definition, 'vector', None)
        return getattr(vector, 'metric', None) or 'cosine'

    def options(self, **kwargs) -> 'CollectionDefinition':
        """The collection's definition as read from the database."""
        info = Database._collections.get(self.name)
        if info is None:
            raise RuntimeError(f'Collection {self.name} not found')
        return info.get('definition') or CollectionDefinition()

    def insert_many(self, documents: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Insert multiple documents.

        Args:
            documents: List of documents to insert

        Returns:
            Insert result with inserted IDs
        """
        if self.name not in Database._data:
            Database._data[self.name] = []

        inserted_ids = []
        for doc in documents:
            # Serialize any complex objects in the document
            serialized = {}
            for key, value in doc.items():
                if key == '$vector' and hasattr(value, 'vector'):
                    # DataAPIVector object
                    serialized[key] = value.vector
                elif key == 'meta':
                    # Metadata must exclude None values to pass Pydantic validation
                    serialized[key] = _serialize_value(value, exclude_none=True)
                else:
                    serialized[key] = _serialize_value(value)

            Database._data[self.name].append(serialized)
            inserted_ids.append(doc.get('_id'))

        return {'inserted_ids': inserted_ids}

    def delete_many(self, filter: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delete documents matching the filter.

        Args:
            filter: MongoDB-style filter

        Returns:
            Delete result with count
        """
        if self.name not in Database._data:
            return CollectionDeleteResult(deleted_count=0)

        original_count = len(Database._data[self.name])
        Database._data[self.name] = [doc for doc in Database._data[self.name] if not _evaluate_filter(filter, doc)]

        return CollectionDeleteResult(deleted_count=original_count - len(Database._data[self.name]))

    def update_many(self, filter: Dict[str, Any], update: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update documents matching the filter.

        Args:
            filter: MongoDB-style filter
            update: Update operations (e.g., {'$set': {'field': value}})

        Returns:
            Update result with counts
        """
        if self.name not in Database._data:
            return {'matched_count': 0, 'modified_count': 0}

        matched = 0
        modified = 0

        for doc in Database._data[self.name]:
            if _evaluate_filter(filter, doc):
                matched += 1

                # Apply $set operator
                if '$set' in update:
                    for field_path, value in update['$set'].items():
                        parts = field_path.split('.')
                        target = doc
                        for part in parts[:-1]:
                            if part not in target:
                                target[part] = {}
                            target = target[part]
                        target[parts[-1]] = value
                        modified += 1

        return {'matched_count': matched, 'modified_count': modified}

    def count_documents(self, filter: Dict[str, Any], *, upper_bound: int) -> int:
        """
        Count documents matching the filter (``upper_bound`` is required, as in astrapy 2).

        Args:
            filter: Filter conditions
            upper_bound: Ceiling on the count; above it TooManyDocumentsToCountException is raised

        Returns:
            Count of matching documents
        """
        data = self._get_data()

        if filter:
            data = [doc for doc in data if _evaluate_filter(filter, doc)]

        if len(data) > upper_bound:
            raise TooManyDocumentsToCountException(
                'Document count exceeds required upper bound', server_max_count_exceeded=False
            )
        return len(data)

    def estimated_document_count(self, **_: Any) -> int:
        """Estimate the collection size; the mock knows it exactly."""
        return len(self._get_data())


# =============================================================================
# Mock Cursor Class
# =============================================================================


class Cursor:
    """
    Mock cursor for iterating over query results.

    Iterating returns every result from the starting page on (astrapy fetches the pages
    transparently); ``fetch_next_page`` returns one page and the state of the next.
    """

    def __init__(self, data: List[Dict[str, Any]], start: int = 0, page_size: Any = None):
        self._data = data
        self._start = start
        self._page_size = page_size
        self._index = start

    def fetch_next_page(self) -> FindPage:
        """One whole page of results and the page state to continue from (None at the end)."""
        if self._page_size is None:
            results, more = self._data[self._index :], False
            self._index = len(self._data)
        else:
            stop = self._index + self._page_size
            results, more = self._data[self._index : stop], stop < len(self._data)
            self._index = min(stop, len(self._data))
        return FindPage(results=results, next_page_state=_encode_page_state(self._index) if more else None)

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        return iter(self._data[self._start :])

    def __next__(self) -> Dict[str, Any]:
        if self._index >= len(self._data):
            raise StopIteration
        result = self._data[self._index]
        self._index += 1
        return result

    def __len__(self) -> int:
        return len(self._data)


# =============================================================================
# Mock Database Class
# =============================================================================


class Database:
    """
    Mock implementation of an Astra DB database.

    Uses class-level storage to persist data across instances.
    """

    # Class-level storage
    _collections: Dict[str, Dict[str, Any]] = {}  # Collection metadata
    _data: Dict[str, List[Dict[str, Any]]] = {}  # Collection name -> documents

    #: Documents per page of an unsorted find (the Data API answers 20)
    page_size: int = 20

    def __init__(self, api_endpoint: str, token: str = None):
        """
        Initialize a database connection.

        Args:
            api_endpoint: Astra DB API endpoint
            token: Application token
        """
        self.api_endpoint = api_endpoint
        self.token = token

    def list_collection_names(self) -> List[str]:
        """
        List all collection names in the database.

        Returns:
            List of collection names
        """
        return list(Database._collections.keys())

    def create_collection(self, name: str, definition: 'CollectionDefinition' = None, **kwargs) -> Collection:
        """
        Create a new collection.

        Args:
            name: Collection name
            definition: Collection definition with vector options

        Returns:
            The created collection
        """
        Database._collections[name] = {
            'definition': definition,
        }
        Database._data[name] = []

        return Collection(name, self)

    def get_collection(self, name: str) -> Collection:
        """
        Get a collection by name.

        Args:
            name: Collection name

        Returns:
            Collection instance
        """
        return Collection(name, self)

    @classmethod
    def reset(cls) -> None:
        """
        Reset all mock data.

        Call this between test runs to ensure a clean state.
        """
        cls._collections = {}
        cls._data = {}
        cls.page_size = 20


# =============================================================================
# Mock DataAPIClient Class
# =============================================================================


class DataAPIClient:
    """
    Mock implementation of the Astra DB Data API client.

    Entry point for connecting to Astra DB.
    """

    def __init__(self, **kwargs):
        """
        Initialize the Data API client.

        All parameters are accepted for API compatibility but ignored.
        """
        pass

    def get_database(self, api_endpoint: str, token: str = None, **kwargs) -> Database:
        """
        Get a database connection.

        Args:
            api_endpoint: Astra DB API endpoint
            token: Application token

        Returns:
            Database instance
        """
        return Database(api_endpoint, token)

    @classmethod
    def reset(cls) -> None:
        """
        Reset all mock data.

        Call this between test runs.
        """
        Database.reset()


# =============================================================================
# Module Exports
# =============================================================================

__all__ = [
    # Main client class
    'DataAPIClient',
    'Database',
    'Collection',
    'Cursor',
    'CollectionDeleteResult',
    'FindPage',
    # Submodules
    'data_types',
    'exceptions',
    'info',
    # Re-exported types
    'DataAPIVector',
    'CollectionDefinition',
    'CollectionVectorOptions',
    'CollectionLexicalOptions',
]
