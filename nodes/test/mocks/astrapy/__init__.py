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

from typing import List, Any, Optional, Dict, Iterator
from dataclasses import dataclass, field
import re


# =============================================================================
# Submodule Imports - Create submodules for proper import structure
# =============================================================================

from . import data_types
from . import info

# Re-export commonly used types
from .data_types import DataAPIVector
from .info import CollectionDefinition, CollectionVectorOptions, CollectionLexicalOptions


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
        skip: int = 0,
        projection: Dict[str, int] = None,
        include_similarity: bool = False,
        include_sort_vector: bool = False,
        **kwargs
    ) -> 'Cursor':
        """
        Find documents matching the filter.

        Args:
            filter: MongoDB-style filter conditions
            sort: Sort specification (e.g., {'$vector': [0.1, ...]})
            limit: Maximum documents to return
            skip: Number of documents to skip
            projection: Fields to include/exclude
            include_similarity: Whether to include similarity scores
            include_sort_vector: Whether to include sort vector

        Returns:
            Cursor over matching documents
        """
        data = self._get_data()

        # Apply filter
        if filter:
            data = [doc for doc in data if _evaluate_filter(filter, doc)]

        # Handle vector sort (semantic search)
        if sort and '$vector' in sort:
            # For mock, we just return documents with a fixed similarity score
            # In real Astra, this would compute actual vector similarity
            for doc in data:
                if include_similarity:
                    doc['$similarity'] = 0.925  # Fixed mock score

        # Apply skip
        if skip:
            data = data[skip:]

        # Apply limit
        if limit:
            data = data[:limit]

        # Apply projection (remove excluded fields)
        if projection:
            filtered_data = []
            for doc in data:
                new_doc = {}
                for key, value in doc.items():
                    if key in projection:
                        if projection[key] == 1:
                            new_doc[key] = value
                    elif projection.get(key) != 0:
                        # Include by default unless explicitly excluded
                        if key not in projection or projection[key] != 0:
                            new_doc[key] = value
                filtered_data.append(new_doc if new_doc else doc)
            data = filtered_data

        return Cursor(data)

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
            return {'deleted_count': 0}

        original_count = len(Database._data[self.name])
        Database._data[self.name] = [
            doc for doc in Database._data[self.name]
            if not _evaluate_filter(filter, doc)
        ]

        return {'deleted_count': original_count - len(Database._data[self.name])}

    def update_many(
        self,
        filter: Dict[str, Any],
        update: Dict[str, Any]
    ) -> Dict[str, Any]:
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

    def count_documents(self, filter: Dict[str, Any] = None) -> int:
        """
        Count documents matching the filter.

        Args:
            filter: Optional filter conditions

        Returns:
            Count of matching documents
        """
        data = self._get_data()

        if filter:
            data = [doc for doc in data if _evaluate_filter(filter, doc)]

        return len(data)


# =============================================================================
# Mock Cursor Class
# =============================================================================

class Cursor:
    """
    Mock cursor for iterating over query results.
    """

    def __init__(self, data: List[Dict[str, Any]]):
        self._data = data
        self._index = 0

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        return iter(self._data)

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
    _data: Dict[str, List[Dict[str, Any]]] = {}    # Collection name -> documents

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

    def create_collection(
        self,
        name: str,
        definition: 'CollectionDefinition' = None,
        **kwargs
    ) -> Collection:
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

    def get_database(
        self,
        api_endpoint: str,
        token: str = None,
        **kwargs
    ) -> Database:
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

    # Submodules
    'data_types',
    'info',

    # Re-exported types
    'DataAPIVector',
    'CollectionDefinition',
    'CollectionVectorOptions',
    'CollectionLexicalOptions',
]

