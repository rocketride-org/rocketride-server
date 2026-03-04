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
Mock pymilvus Module for Testing
================================

This module provides a mock implementation of the pymilvus library for testing
RocketRide's Milvus vector store integration without requiring a real Milvus server.

How Mock Injection Works:
-------------------------
1. The test framework sets ROCKETRIDE_MOCK environment variable to point to nodes/test/mocks/
2. When the EAAS server starts a pipeline subprocess (node.py), it inherits this env var
3. node.py detects ROCKETRIDE_MOCK and inserts that path at the FRONT of sys.path
4. When the milvus node does `from pymilvus import MilvusClient, DataType`, Python finds
   THIS mock module first (because sys.path is searched in order)
5. The real pymilvus is never loaded - this mock completely shadows it

Key Design Principles:
----------------------
1. MIRROR THE REAL API: Export the same classes, functions, and submodules that the
   real library provides. The node code shouldn't need any changes to use the mock.

2. CLASS-LEVEL STATE: Use class variables (not instance variables) for storage so
   that data persists across multiple MilvusClient instances within the same process.
   This simulates a real database server that multiple clients can connect to.

3. PROPER SERIALIZATION: When storing Pydantic models or dataclasses, they must be
   serialized to dicts before returning from queries. Use model_dump(exclude_none=True)
   to avoid validation errors when the data is deserialized back into models.

4. STRING-BASED FILTERS: Unlike Qdrant which uses Filter objects, Milvus uses string
   expressions for filtering (e.g., "meta['objectId'] == 'doc-1'"). The mock must
   parse and evaluate these expressions.

Creating Mocks for Other Libraries:
-----------------------------------
1. Create a directory: nodes/test/mocks/<library_name>/
2. Create __init__.py that exports all classes/functions the real library provides
3. Implement the minimum API needed by the node being tested
4. Add comprehensive tests in the node's services.json "test" section

Usage:
------
The mock is automatically loaded when running tests via:
    builder nodes:test --pytest="-k milvus"

Or manually:
    set ROCKETRIDE_MOCK=C:\\Projects\\rocketride-server\\nodes\\test\\mocks
    python -m pytest nodes/test/test_dynamic.py -k milvus -s -v
"""

from typing import List, Any, Optional, Dict
from dataclasses import dataclass, field
from enum import Enum
import re


# =============================================================================
# DataType Enumeration
# =============================================================================
# Mirrors pymilvus.DataType for schema field type definitions

class DataType(Enum):
    """
    Enumeration of Milvus data types for schema field definitions.

    The Milvus driver uses these when creating collection schemas:
    - INT64 for primary key IDs
    - FLOAT_VECTOR for embedding vectors
    - VARCHAR for text content
    - JSON for metadata
    """
    NONE = 0
    BOOL = 1
    INT8 = 2
    INT16 = 3
    INT32 = 4
    INT64 = 5
    FLOAT = 10
    DOUBLE = 11
    STRING = 20
    VARCHAR = 21
    ARRAY = 22
    JSON = 23
    BINARY_VECTOR = 100
    FLOAT_VECTOR = 101
    FLOAT16_VECTOR = 102
    BFLOAT16_VECTOR = 103
    SPARSE_FLOAT_VECTOR = 104


# =============================================================================
# Schema Helper Classes
# =============================================================================

@dataclass
class FieldSchema:
    """
    Represents a single field in a collection schema.

    Attributes:
        field_name: Name of the field
        datatype: DataType of the field
        is_primary: Whether this is the primary key field
        auto_id: Whether to auto-generate IDs
        max_length: Maximum length for VARCHAR fields
        dim: Dimension for vector fields
    """
    field_name: str
    datatype: DataType
    is_primary: bool = False
    auto_id: bool = False
    max_length: int = 0
    dim: int = 0


@dataclass
class CollectionSchema:
    """
    Schema definition for a Milvus collection.

    Created via MilvusClient.create_schema() and populated with add_field() calls.

    Attributes:
        auto_id: Whether to auto-generate IDs
        enable_dynamic_field: Whether to allow dynamic fields
        fields: List of FieldSchema definitions
    """
    auto_id: bool = False
    enable_dynamic_field: bool = False
    fields: List[FieldSchema] = field(default_factory=list)

    def add_field(
        self,
        field_name: str,
        datatype: DataType,
        is_primary: bool = False,
        auto_id: bool = False,
        max_length: int = 0,
        dim: int = 0,
        **kwargs
    ) -> None:
        """Add a field to the schema."""
        self.fields.append(FieldSchema(
            field_name=field_name,
            datatype=datatype,
            is_primary=is_primary,
            auto_id=auto_id,
            max_length=max_length,
            dim=dim
        ))


@dataclass
class IndexParams:
    """
    Index configuration for a collection.

    Holds a list of index definitions for various fields.

    Attributes:
        indexes: List of index configurations (field_name, index_type, params, etc.)
    """
    indexes: List[Dict[str, Any]] = field(default_factory=list)

    def add_index(
        self,
        field_name: str,
        index_type: str = None,
        metric_type: str = None,
        params: Dict[str, Any] = None,
        **kwargs
    ) -> None:
        """Add an index definition."""
        self.indexes.append({
            'field_name': field_name,
            'index_type': index_type,
            'metric_type': metric_type,
            'params': params or {}
        })


# =============================================================================
# Payload Serialization Helper
# =============================================================================

def _serialize_value(value: Any) -> Any:
    """
    Serialize a value, converting Pydantic models to dicts.

    This is CRITICAL for proper mock operation. The RocketRide store code does:
        metadata = DocMetadata(**entity['meta'])

    If entity['meta'] is still a DocMetadata object (not a dict), this fails with:
        "argument after ** must be a mapping, not DocMetadata"

    Additionally, we must use exclude_none=True because DocMetadata has fields like:
        nodeId: str = Field(None, ...)

    The type annotation doesn't include Optional, so passing explicit None fails
    Pydantic validation. By excluding None values, we let the defaults apply.
    """
    if value is None:
        return None

    if hasattr(value, 'model_dump'):
        # Pydantic v2 model - use model_dump with exclude_none
        return value.model_dump(exclude_none=True)
    elif hasattr(value, '__dict__') and not isinstance(value, (str, int, float, bool, list, dict)):
        # Regular object/dataclass - convert __dict__, excluding None values
        return {attr: val for attr, val in value.__dict__.items() if val is not None}
    elif isinstance(value, dict):
        # Recursively serialize dict values
        return {k: _serialize_value(v) for k, v in value.items()}
    elif isinstance(value, list):
        # Recursively serialize list items
        return [_serialize_value(item) for item in value]
    else:
        # Primitive type - keep as-is
        return value


def _normalize_id(id_value: Any) -> int:
    """
    Convert an ID value to a regular Python int.

    The Milvus driver stores IDs as np.int64, but the _convertToDocs method
    checks isinstance(id, int), which fails for np.int64 in Python 3.

    This function ensures IDs are always returned as native Python ints.
    """
    if id_value is None:
        return 0
    # Convert any numpy integer type or regular int to Python int
    return int(id_value)


# =============================================================================
# Filter Expression Parser
# =============================================================================

def _parse_filter_expression(filter_expr: str, data: Dict[str, Any]) -> bool:
    """
    Parse and evaluate a Milvus filter expression against a data record.

    Milvus uses string-based filter expressions like:
        "meta['objectId'] == 'doc-1'"
        "meta['chunkId'] >= 0 and meta['isDeleted'] == False"
        "content like '%hello%'"

    This is a simplified parser that handles the most common patterns used
    by the RocketRide store driver.

    Args:
        filter_expr: The filter expression string
        data: The data record to evaluate against

    Returns:
        True if the record matches the filter, False otherwise
    """
    if not filter_expr:
        return True

    # Handle 'and' conditions by splitting and checking all
    if ' and ' in filter_expr.lower():
        parts = re.split(r'\s+and\s+', filter_expr, flags=re.IGNORECASE)
        return all(_parse_filter_expression(part.strip(), data) for part in parts)

    # Handle 'or' conditions
    if ' or ' in filter_expr.lower():
        parts = re.split(r'\s+or\s+', filter_expr, flags=re.IGNORECASE)
        return any(_parse_filter_expression(part.strip(), data) for part in parts)

    # Remove parentheses for simple expressions
    filter_expr = filter_expr.strip()
    if filter_expr.startswith('(') and filter_expr.endswith(')'):
        filter_expr = filter_expr[1:-1].strip()

    # Pattern: meta['field'] == value
    match = re.match(r"(\w+)\['(\w+)'\]\s*==\s*(.+)", filter_expr)
    if match:
        container, field, expected = match.groups()
        expected = expected.strip()

        # Get the actual value from data
        container_data = data.get(container, {})
        if isinstance(container_data, dict):
            actual = container_data.get(field)
        else:
            actual = getattr(container_data, field, None)

        # Parse expected value
        if expected.startswith("'") and expected.endswith("'"):
            expected = expected[1:-1]
        elif expected == 'True':
            expected = True
        elif expected == 'False':
            expected = False
        elif expected.isdigit():
            expected = int(expected)

        return actual == expected

    # Pattern: meta['field'] in [values]
    # Note: Milvus format can be: meta['objectId'] in ['schema'] or meta['objectId'] in ['val1', 'val2']
    match = re.match(r"(\w+)\['(\w+)'\]\s+in\s+\[(.+)\]", filter_expr)
    if match:
        container, field, values_str = match.groups()

        # Get the actual value from data
        container_data = data.get(container, {})
        if isinstance(container_data, dict):
            actual = container_data.get(field)
        elif hasattr(container_data, field):
            actual = getattr(container_data, field, None)
        elif hasattr(container_data, '__dict__'):
            actual = container_data.__dict__.get(field)
        else:
            actual = None

        # Parse the values list - handle both 'value' and "value" quoted strings
        values = []
        # Use regex to extract quoted strings or unquoted values
        value_pattern = r"'([^']*)'|\"([^\"]*)\"|([^,\s\[\]]+)"
        for m in re.finditer(value_pattern, values_str):
            v = m.group(1) or m.group(2) or m.group(3)
            if v is not None:
                # Try to convert to int if it looks like a number
                if v.isdigit():
                    v = int(v)
                values.append(v)

        return actual in values

    # Pattern: meta['field'] >= value or <= or > or <
    match = re.match(r"(\w+)\['(\w+)'\]\s*([<>]=?)\s*(.+)", filter_expr)
    if match:
        container, field, op, expected = match.groups()
        expected = expected.strip()

        # Get the actual value from data
        container_data = data.get(container, {})
        if isinstance(container_data, dict):
            actual = container_data.get(field)
        else:
            actual = getattr(container_data, field, None)

        # Parse expected as number
        try:
            expected = float(expected) if '.' in expected else int(expected)
        except ValueError:
            return False

        if actual is None:
            return False

        if op == '>=':
            return actual >= expected
        elif op == '<=':
            return actual <= expected
        elif op == '>':
            return actual > expected
        elif op == '<':
            return actual < expected

    # Pattern: content like '%text%'
    match = re.match(r"(\w+)\s+like\s+'%(.+)%'", filter_expr, re.IGNORECASE)
    if match:
        field, pattern = match.groups()
        actual = data.get(field, '')
        if actual is None:
            return False
        return pattern.lower() in str(actual).lower()

    # Pattern: field range condition: (offset-1 < meta['chunkId'] < offset + renderChunkSize)
    match = re.match(r"\(?(\d+)\s*<\s*(\w+)\['(\w+)'\]\s*<\s*(\d+)\)?", filter_expr)
    if match:
        lower, container, field, upper = match.groups()
        lower = int(lower)
        upper = int(upper)

        container_data = data.get(container, {})
        if isinstance(container_data, dict):
            actual = container_data.get(field)
        else:
            actual = getattr(container_data, field, None)

        if actual is None:
            return False
        return lower < actual < upper

    # If we can't parse it, return True (permissive - better than blocking valid data)
    return True


# =============================================================================
# Mock MilvusClient
# =============================================================================

class MilvusClient:
    """
    Mock implementation of the Milvus vector database client.

    This mock stores all data in class-level dictionaries, simulating a database
    server that persists data across multiple client instances. This is important
    because the RocketRide store may create multiple MilvusClient instances during
    a single pipeline run.

    Storage Structure:
        _collections: {
            "ROCKETRIDE": {
                "schema": CollectionSchema(...),
                "index_params": IndexParams(...),
            }
        }

        _data: {
            "ROCKETRIDE": [
                {"id": 123, "vector": [0.1, ...], "content": "...", "meta": {...}},
                ...
            ]
        }

    Important Implementation Notes:
        1. Milvus uses string-based filter expressions instead of Filter objects
        2. Data is stored as dicts with 'id', 'vector', 'content', 'meta' keys
        3. Search returns results with 'entity', 'id', 'distance' keys
        4. Query returns results with just the requested output fields
    """

    # -------------------------------------------------------------------------
    # Class-Level Storage (Shared Across All Instances)
    # -------------------------------------------------------------------------

    _collections: Dict[str, Dict[str, Any]] = {}
    _data: Dict[str, List[Dict[str, Any]]] = {}

    # -------------------------------------------------------------------------
    # Static Methods for Schema/Index Creation
    # -------------------------------------------------------------------------

    @staticmethod
    def create_schema(
        auto_id: bool = False,
        enable_dynamic_field: bool = False,
        **kwargs
    ) -> CollectionSchema:
        """
        Create a new collection schema.

        This is a static method in the real MilvusClient too.

        Args:
            auto_id: Whether to auto-generate IDs
            enable_dynamic_field: Whether to allow dynamic fields

        Returns:
            A new CollectionSchema instance to be populated with add_field()
        """
        return CollectionSchema(
            auto_id=auto_id,
            enable_dynamic_field=enable_dynamic_field
        )

    # -------------------------------------------------------------------------
    # Constructor
    # -------------------------------------------------------------------------

    def __init__(
        self,
        uri: str = None,
        host: str = None,
        port: int = None,
        token: str = None,
        timeout: int = 60,
        **kwargs
    ):
        """
        Initialize a mock Milvus client connection.

        All parameters are accepted for API compatibility but are ignored
        since we're not connecting to a real server.

        Args:
            uri: Milvus server URI (e.g., "http://localhost:19530")
            host: Milvus server hostname (ignored)
            port: Milvus server port (ignored)
            token: API key for authentication (ignored)
            timeout: Connection timeout in seconds (ignored)
            **kwargs: Additional arguments for forward compatibility
        """
        self.uri = uri
        self.host = host
        self.port = port

    # -------------------------------------------------------------------------
    # Index Parameter Preparation
    # -------------------------------------------------------------------------

    def prepare_index_params(self) -> IndexParams:
        """
        Prepare index parameters for collection creation.

        Returns:
            A new IndexParams instance to be populated with add_index()
        """
        return IndexParams()

    # -------------------------------------------------------------------------
    # Collection Management
    # -------------------------------------------------------------------------

    def has_collection(self, collection_name: str) -> bool:
        """
        Check if a collection exists.

        Args:
            collection_name: Name of the collection to check

        Returns:
            True if the collection exists, False otherwise
        """
        return collection_name in MilvusClient._collections

    def create_collection(
        self,
        collection_name: str,
        schema: CollectionSchema = None,
        index_params: IndexParams = None,
        **kwargs
    ) -> None:
        """
        Create a new collection.

        Args:
            collection_name: Name for the new collection
            schema: Collection schema definition
            index_params: Index configuration
            **kwargs: Additional parameters (dimension, etc.)
        """
        MilvusClient._collections[collection_name] = {
            'schema': schema,
            'index_params': index_params,
        }
        MilvusClient._data[collection_name] = []

    # -------------------------------------------------------------------------
    # Data Operations: Query (Filter-Based Retrieval)
    # -------------------------------------------------------------------------

    def query(
        self,
        collection_name: str,
        filter: str = None,
        output_fields: List[str] = None,
        offset: int = 0,
        limit: int = 100,
        **kwargs
    ) -> List[Dict[str, Any]]:
        """
        Query collection with filter expression.

        Used by the RocketRide store to:
        1. Count documents (with output_fields=['count(*)'])
        2. Retrieve documents by filter criteria
        3. Get paths and metadata

        Args:
            collection_name: Name of the collection to query
            filter: Filter expression string (e.g., "meta['objectId'] == 'doc-1'")
            output_fields: List of fields to return
            offset: Starting position for pagination
            limit: Maximum number of records to return

        Returns:
            List of matching records (dicts with requested fields)
        """
        data = MilvusClient._data.get(collection_name, [])

        # Handle count(*) query
        if output_fields and 'count(*)' in output_fields:
            # For count, we need to apply the filter first
            if filter:
                count = sum(1 for record in data if _parse_filter_expression(filter, record))
            else:
                count = len(data)
            return [{'count(*)': count}]

        # Apply filter
        if filter:
            data = [record for record in data if _parse_filter_expression(filter, record)]

        # Apply pagination
        data = data[offset:offset + limit]

        # Select output fields and serialize
        results = []
        for record in data:
            if output_fields:
                result = {}
                for field in output_fields:
                    if field in record:
                        result[field] = _serialize_value(record[field])
                # Normalize ID to Python int (Milvus driver stores np.int64 but checks isinstance(id, int))
                result['id'] = _normalize_id(record.get('id'))
                results.append(result)
            else:
                results.append({
                    'id': _normalize_id(record.get('id')),
                    **{k: _serialize_value(v) for k, v in record.items() if k != 'id'}
                })

        return results

    # -------------------------------------------------------------------------
    # Data Operations: Search (Semantic Similarity)
    # -------------------------------------------------------------------------

    def search(
        self,
        collection_name: str,
        data: List[List[float]],
        filter: str = None,
        limit: int = 10,
        output_fields: List[str] = None,
        **kwargs
    ) -> List[List[Dict[str, Any]]]:
        """
        Perform semantic similarity search.

        In a real Milvus, this computes vector similarity between the query
        vectors and all stored vectors. Our mock returns all matching points
        with a simulated distance score.

        IMPORTANT: We filter out documents with isDeleted=True because they
        should not appear in search results.

        Args:
            collection_name: Name of the collection to search
            data: List of query vectors (typically just one)
            filter: Additional filter expression
            limit: Maximum number of results per query
            output_fields: Fields to include in results

        Returns:
            List of result lists (one per query vector), each containing
            dicts with 'id', 'distance', and 'entity' keys
        """
        stored_data = MilvusClient._data.get(collection_name, [])

        # Filter out deleted documents
        filtered_data = []
        for record in stored_data:
            meta = record.get('meta', {})
            is_deleted = False

            if hasattr(meta, 'isDeleted'):
                is_deleted = meta.isDeleted
            elif isinstance(meta, dict):
                is_deleted = meta.get('isDeleted', False)

            if not is_deleted:
                filtered_data.append(record)

        # Apply additional filter if specified
        if filter:
            filtered_data = [
                record for record in filtered_data
                if _parse_filter_expression(filter, record)
            ]

        # Build results for each query vector (usually just one)
        all_results = []
        for query_vector in data:
            results = []
            for record in filtered_data[:limit]:
                entity = {}
                if output_fields:
                    for field in output_fields:
                        if field in record:
                            entity[field] = _serialize_value(record[field])
                else:
                    entity = {k: _serialize_value(v) for k, v in record.items() if k != 'vector'}

                results.append({
                    'id': _normalize_id(record.get('id')),
                    'distance': 0.85,  # Fixed distance for mock (cosine similarity)
                    'entity': entity
                })
            all_results.append(results)

        return all_results

    # -------------------------------------------------------------------------
    # Data Operations: Insert/Update/Delete
    # -------------------------------------------------------------------------

    def upsert(
        self,
        collection_name: str,
        data: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Insert or update records in a collection.

        If a record with the same ID exists, it will be updated.
        Otherwise, a new record will be inserted.

        Args:
            collection_name: Name of the collection
            data: List of records to upsert (each is a dict with id, vector, etc.)

        Returns:
            Dict with upsert statistics
        """
        if collection_name not in MilvusClient._data:
            MilvusClient._data[collection_name] = []

        collection_data = MilvusClient._data[collection_name]

        for record in data:
            record_id = record.get('id')

            # Check if record exists (update) or is new (insert)
            existing_idx = None
            for idx, existing in enumerate(collection_data):
                if existing.get('id') == record_id:
                    existing_idx = idx
                    break

            if existing_idx is not None:
                # Update existing record
                collection_data[existing_idx] = record
            else:
                # Insert new record
                collection_data.append(record)

        return {'upsert_count': len(data)}

    def delete(
        self,
        collection_name: str,
        filter: str = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Delete records from a collection.

        Args:
            collection_name: Name of the collection
            filter: Filter expression to match records to delete

        Returns:
            Dict with delete statistics
        """
        if collection_name not in MilvusClient._data:
            return {'delete_count': 0}

        if not filter:
            return {'delete_count': 0}

        # Handle filter as string expression or list
        if isinstance(filter, list):
            # Convert list of conditions to single expression
            filter = ' and '.join(filter)

        original_count = len(MilvusClient._data[collection_name])
        MilvusClient._data[collection_name] = [
            record for record in MilvusClient._data[collection_name]
            if not _parse_filter_expression(filter, record)
        ]

        delete_count = original_count - len(MilvusClient._data[collection_name])
        return {'delete_count': delete_count}

    # -------------------------------------------------------------------------
    # Test Utilities
    # -------------------------------------------------------------------------

    @classmethod
    def reset(cls) -> None:
        """
        Reset all mock data.

        Call this between test runs to ensure a clean state. The test framework
        should call this in fixture setup/teardown.

        Example:
            @pytest.fixture(autouse=True)
            def reset_mock():
                from pymilvus import MilvusClient
                MilvusClient.reset()
                yield
                MilvusClient.reset()
        """
        cls._collections = {}
        cls._data = {}


# =============================================================================
# Module Exports
# =============================================================================
# List everything that should be importable from this module.
# This should match what the real pymilvus exports.

__all__ = [
    # Main client class
    'MilvusClient',

    # Data types
    'DataType',

    # Schema types
    'CollectionSchema',
    'FieldSchema',
    'IndexParams',
]

