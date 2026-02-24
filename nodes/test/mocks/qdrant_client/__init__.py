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
Mock qdrant_client Module for Testing
=====================================

This module provides a mock implementation of the qdrant_client library for testing
RocketRide's vector store integration without requiring a real Qdrant server.

How Mock Injection Works:
-------------------------
1. The test framework sets ROCKETRIDE_MOCK environment variable to point to nodes/test/mocks/
2. When the EAAS server starts a pipeline subprocess (node.py), it inherits this env var
3. node.py detects ROCKETRIDE_MOCK and inserts that path at the FRONT of sys.path
4. When the qdrant node does `from qdrant_client import QdrantClient`, Python finds
   THIS mock module first (because sys.path is searched in order)
5. The real qdrant_client is never loaded - this mock completely shadows it

Key Design Principles:
----------------------
1. MIRROR THE REAL API: Export the same classes, functions, and submodules that the
   real library provides. The node code shouldn't need any changes to use the mock.

2. CLASS-LEVEL STATE: Use class variables (not instance variables) for storage so
   that data persists across multiple QdrantClient instances within the same process.
   This simulates a real database server that multiple clients can connect to.

3. PROPER SERIALIZATION: When storing Pydantic models or dataclasses, they must be
   serialized to dicts before returning from queries. Use model_dump(exclude_none=True)
   to avoid validation errors when the data is deserialized back into models.

4. FILTER THE SCHEMA DOC: The RocketRide store creates a hidden "schema" document with
   isDeleted=True to track vector size and model name. This should be filtered out
   from search results but included in scroll() when specifically requested.

Creating a New Mock:
--------------------
1. Create a directory: nodes/test/mocks/<library_name>/
2. Create __init__.py that exports all classes/functions the real library provides
3. Create submodule files (models.py, etc.) matching the real library structure
4. Implement the minimum API needed by the node being tested
5. Add comprehensive tests in the node's services.json "test" section

Usage:
------
The mock is automatically loaded when running tests via:
    builder nodes:test --pytest="-k <node_name>"

Or manually:
    set ROCKETRIDE_MOCK=C:\\Projects\\engine-new\\nodes\\test\\mocks
    python -m pytest nodes/test/test_dynamic.py -k qdrant -s -v
"""

from typing import List, Any, Optional, Tuple, Dict
from dataclasses import dataclass, field



# =============================================================================
# Submodule Imports
# =============================================================================
# The real qdrant_client has submodules that nodes may import from directly.
# We must provide matching submodules to avoid ImportError.

from . import models
from . import http
from . import conversions
from .conversions import common_types


# =============================================================================
# Re-exported Types
# =============================================================================
# These types are commonly imported directly from qdrant_client or qdrant_client.models.
# Re-exporting them here allows both import styles to work:
#   from qdrant_client import PointStruct
#   from qdrant_client.models import PointStruct

from .models import (
    PointStruct,      # Represents a point (vector + payload) to store
    Filter,           # Query filter with must/should/must_not conditions
    FieldCondition,   # Single field condition (key + match criteria)
    Record,           # Result record from scroll() operations
    MatchValue,       # Match exact value
    MatchAny,         # Match any value in a list
    MatchText,        # Full-text match
    Range,            # Numeric range match (gte, lte, gt, lt)
    SearchParams,     # Search algorithm parameters
    TextIndexParams,  # Text indexing configuration
    TokenizerType,    # Text tokenization options
    PayloadSchemaType,# Payload field type for indexing
    TextIndexType,    # Text index type
    ScoredPoint,      # Search result with similarity score
)
from .conversions.common_types import CollectionInfo, VectorParams


# =============================================================================
# Query Result Container
# =============================================================================

@dataclass
class QueryResult:
    """
    Container for query_points() results.
    
    The real Qdrant returns a QueryResponse object; we simplify to just the points list.
    """
    points: List[ScoredPoint] = field(default_factory=list)


# =============================================================================
# Payload Serialization Helper
# =============================================================================

def _serialize_payload(payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Serialize a payload dict containing Pydantic models or dataclasses to plain dicts.
    
    This is CRITICAL for proper mock operation. The RocketRide store code does:
        metadata = DocMetadata(**point.payload['meta'])
    
    If payload['meta'] is still a DocMetadata object (not a dict), this fails with:
        "argument after ** must be a mapping, not DocMetadata"
    
    Additionally, we must use exclude_none=True because DocMetadata has fields like:
        nodeId: str = Field(None, ...)
    
    The type annotation doesn't include Optional, so passing explicit None fails
    Pydantic validation. By excluding None values, we let the defaults apply.
    
    Args:
        payload: The payload dict to serialize, may contain nested objects
        
    Returns:
        A new dict with all nested objects converted to plain dicts
    """
    if payload is None:
        return None
    
    result = {}
    for key, value in payload.items():
        if hasattr(value, 'model_dump'):
            # Pydantic v2 model - use model_dump with exclude_none
            result[key] = value.model_dump(exclude_none=True)
        elif hasattr(value, '__dict__') and not isinstance(value, (str, int, float, bool, list, dict)):
            # Regular object/dataclass - convert __dict__, excluding None values
            result[key] = {attr: val for attr, val in value.__dict__.items() if val is not None}
        else:
            # Primitive type or already a dict/list - keep as-is
            result[key] = value
    
    return result


# =============================================================================
# Mock QdrantClient
# =============================================================================

class QdrantClient:
    """
    Mock implementation of the Qdrant vector database client.
    
    This mock stores all data in class-level dictionaries, simulating a database
    server that persists data across multiple client instances. This is important
    because the RocketRide store may create multiple QdrantClient instances during
    a single pipeline run (e.g., one for checking collection existence, another
    for actual operations).
    
    Storage Structure:
        _collections: {
            "ROCKETRIDE": {
                "vectors_config": VectorParams(...),
                "payload_schema": {"meta.nodeId": PayloadSchemaType.KEYWORD, ...}
            }
        }
        
        _points: {
            "ROCKETRIDE": [
                PointStruct(id="uuid1", vector=[0.1, ...], payload={...}),
                PointStruct(id="uuid2", vector=[0.2, ...], payload={...}),
            ]
        }
    
    Important Implementation Notes:
        1. The RocketRide store creates a "schema" document with isDeleted=True and
           objectId="schema" to track vector dimensions and embedding model.
           This must be returned by scroll() when filtered for, but excluded
           from query_points() search results.
           
        2. All payload objects must be serialized before returning to avoid
           "argument after ** must be a mapping" errors in the store code.
           
        3. Filter support is minimal - only the filters actually used by the
           RocketRide store are implemented (MatchAny for objectId filtering).
    """
    
    # -------------------------------------------------------------------------
    # Class-Level Storage (Shared Across All Instances)
    # -------------------------------------------------------------------------
    # Using class variables ensures data persists when multiple QdrantClient
    # instances are created within the same process/pipeline run.
    
    _collections: Dict[str, Dict[str, Any]] = {}  # Collection metadata
    _points: Dict[str, List[PointStruct]] = {}     # Collection name -> points list
    
    # -------------------------------------------------------------------------
    # Constructor
    # -------------------------------------------------------------------------
    
    def __init__(
        self,
        host: str = None,
        port: int = None,
        url: str = None,
        api_key: str = None,
        prefer_grpc: bool = False,
        timeout: int = 60,
        **kwargs
    ):
        """
        Initialize a mock Qdrant client connection.
        
        All parameters are accepted for API compatibility but most are ignored
        since we're not connecting to a real server.
        
        Args:
            host: Qdrant server hostname (logged but ignored)
            port: Qdrant server port (logged but ignored)
            url: Alternative URL specification (ignored)
            api_key: API key for authentication (ignored)
            prefer_grpc: Whether to prefer gRPC over HTTP (ignored)
            timeout: Connection timeout in seconds (ignored)
            **kwargs: Additional arguments for forward compatibility
        """
        self.host = host
        self.port = port
        self.url = url
    
    # -------------------------------------------------------------------------
    # Collection Management
    # -------------------------------------------------------------------------
    
    def collection_exists(self, collection_name: str) -> bool:
        """
        Check if a collection exists.
        
        Args:
            collection_name: Name of the collection to check
            
        Returns:
            True if the collection exists, False otherwise
        """
        return collection_name in QdrantClient._collections
    
    def create_collection(self, collection_name: str, vectors_config: Any = None) -> None:
        """
        Create a new collection.
        
        Args:
            collection_name: Name for the new collection
            vectors_config: Vector configuration (VectorParams with size and distance metric)
        """
        QdrantClient._collections[collection_name] = {
            'vectors_config': vectors_config,
            'payload_schema': {}
        }
        QdrantClient._points[collection_name] = []
    
    def get_collection(self, collection_name: str) -> CollectionInfo:
        """
        Get information about a collection.
        
        Args:
            collection_name: Name of the collection
            
        Returns:
            CollectionInfo with vectors_count and payload_schema
            
        Raises:
            Exception: If collection doesn't exist
        """
        if collection_name not in QdrantClient._collections:
            raise Exception(f"Collection {collection_name} not found")
        
        return CollectionInfo(
            vectors_count=len(QdrantClient._points.get(collection_name, [])),
            payload_schema=QdrantClient._collections[collection_name].get('payload_schema', {})
        )
    
    def create_payload_index(
        self,
        collection_name: str,
        field_name: str,
        field_type: str = None,
        field_schema: Any = None
    ) -> None:
        """
        Create an index on a payload field for faster filtering.
        
        In the mock, we just record the schema but don't actually build an index.
        
        Args:
            collection_name: Name of the collection
            field_name: Dot-notation path to the field (e.g., "meta.nodeId")
            field_type: Simple type string (e.g., "keyword")
            field_schema: Complex schema object (e.g., TextIndexParams)
        """
        if collection_name in QdrantClient._collections:
            QdrantClient._collections[collection_name]['payload_schema'][field_name] = (
                field_type or field_schema
            )
    
    # -------------------------------------------------------------------------
    # Data Retrieval: scroll()
    # -------------------------------------------------------------------------
    
    def scroll(
        self,
        collection_name: str,
        scroll_filter: Filter = None,
        offset: int = 0,
        limit: int = 100,
        with_vectors: bool = False,
        with_payload: bool = True
    ) -> Tuple[List[Record], Optional[str]]:
        """
        Scroll through collection points with optional filtering.
        
        Used by the RocketRide store to:
        1. Find the schema document (filter by objectId='schema', isDeleted=True)
        2. Retrieve documents by various criteria
        
        Args:
            collection_name: Name of the collection to scroll
            scroll_filter: Filter conditions to apply
            offset: Starting position for pagination
            limit: Maximum number of records to return
            with_vectors: Whether to include vectors in results (ignored in mock)
            with_payload: Whether to include payload in results
            
        Returns:
            Tuple of (list of Records, next_offset or None if no more results)
        """
        points = QdrantClient._points.get(collection_name, [])
        
        # Apply filtering if specified
        filtered_points = points
        if scroll_filter and scroll_filter.must:
            for condition in scroll_filter.must:
                if hasattr(condition, 'key') and hasattr(condition, 'match'):
                    # Parse the dot-notation key path (e.g., "meta.objectId")
                    key_parts = condition.key.split('.')
                    match = condition.match
                    
                    def matches_condition(point: PointStruct) -> bool:
                        """Check if a point matches this filter condition."""
                        # Navigate through nested structure to find the value
                        value = point.payload
                        for part in key_parts:
                            if value is None:
                                return False
                            if isinstance(value, dict):
                                value = value.get(part)
                            elif hasattr(value, part):
                                value = getattr(value, part)
                            elif hasattr(value, '__dict__'):
                                value = getattr(value, part, None)
                            else:
                                return False
                        
                        # Check the match condition
                        if hasattr(match, 'any'):
                            # MatchAny: value must be in the list
                            return value in match.any
                        elif hasattr(match, 'value'):
                            # MatchValue: exact match
                            return value == match.value
                        
                        # Unknown match type - include by default
                        return True
                    
                    filtered_points = [p for p in filtered_points if matches_condition(p)]
        
        # Apply pagination
        result = filtered_points[offset:offset + limit]
        
        # Convert to Record objects with serialized payloads
        records = [
            Record(
                id=p.id,
                payload=_serialize_payload(p.payload) if with_payload else None
            )
            for p in result
        ]
        
        # Return next offset for pagination, or None if we've reached the end
        next_offset = None if len(result) < limit else str(offset + limit)
        return records, next_offset
    
    # -------------------------------------------------------------------------
    # Data Retrieval: query_points() - Semantic Search
    # -------------------------------------------------------------------------
    
    def query_points(
        self,
        collection_name: str,
        query: List[float],
        query_filter: Filter = None,
        with_vectors: bool = False,
        with_payload: bool = True,
        limit: int = 10,
        score_threshold: float = 0.0,
        search_params: Any = None
    ) -> QueryResult:
        """
        Perform semantic similarity search.
        
        In a real Qdrant, this computes vector similarity between the query
        and all stored vectors. Our mock simply returns all non-deleted points
        with a fixed score of 0.95.
        
        IMPORTANT: We filter out the schema document (isDeleted=True) because
        it should never appear in search results - it's only used internally
        to track collection metadata.
        
        Args:
            collection_name: Name of the collection to search
            query: Query vector for similarity comparison
            query_filter: Additional filter conditions (not implemented in mock)
            with_vectors: Whether to include vectors in results (ignored)
            with_payload: Whether to include payload in results
            limit: Maximum number of results to return
            score_threshold: Minimum similarity score (ignored in mock)
            search_params: Search algorithm parameters (ignored)
            
        Returns:
            QueryResult containing list of ScoredPoint objects
        """
        points = QdrantClient._points.get(collection_name, [])
        
        # Filter out the schema document (isDeleted=True)
        # This document is created by the RocketRide store to track metadata
        # and should never appear in search results
        filtered_points = []
        for p in points:
            meta = p.payload.get('meta') if p.payload else None
            is_deleted = False
            
            if meta is not None:
                if hasattr(meta, 'isDeleted'):
                    # meta is a DocMetadata object
                    is_deleted = meta.isDeleted
                elif isinstance(meta, dict):
                    # meta is already serialized to dict
                    is_deleted = meta.get('isDeleted', False)
            
            if not is_deleted:
                filtered_points.append(p)
        
        # Return mock scored points
        # In a real implementation, score would be computed from vector similarity
        scored = [
            ScoredPoint(
                id=p.id,
                score=0.95,  # Fixed score for mock
                payload=_serialize_payload(p.payload) if with_payload else None
            )
            for p in filtered_points[:limit]
        ]
        
        return QueryResult(points=scored)
    
    # -------------------------------------------------------------------------
    # Data Modification: batch_update_points()
    # -------------------------------------------------------------------------
    
    def batch_update_points(
        self,
        collection_name: str,
        update_operations: List[Any]
    ) -> None:
        """
        Perform batch update operations (upsert, delete, etc.).
        
        The RocketRide store uses this to:
        1. Delete existing points with matching objectId (DeleteOperation)
        2. Insert new points (UpsertOperation)
        
        Args:
            collection_name: Name of the collection to update
            update_operations: List of operation objects (UpsertOperation, DeleteOperation, etc.)
        """
        for op in update_operations:
            if hasattr(op, 'upsert'):
                # UpsertOperation: insert or update points
                points_list = op.upsert.points
                QdrantClient._points.setdefault(collection_name, []).extend(points_list)
                
            elif hasattr(op, 'delete'):
                # DeleteOperation: remove points matching a filter
                # In the mock, we don't actually delete - the store handles
                # deduplication by always deleting before inserting
                pass
    
    # -------------------------------------------------------------------------
    # Additional Operations (Minimal Implementation)
    # -------------------------------------------------------------------------
    
    def delete(
        self,
        collection_name: str,
        points_selector: Any,
        wait: bool = True
    ) -> None:
        """
        Delete points from a collection.
        
        Not fully implemented in mock - the RocketRide store uses batch_update_points
        for deletions instead.
        """
        pass
    
    def set_payload(
        self,
        collection_name: str,
        payload: dict,
        points: Any
    ) -> None:
        """
        Update payload on existing points.
        
        Not fully implemented in mock - would need to find and update
        matching points by their selector.
        """
        pass
    
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
                from qdrant_client import QdrantClient
                QdrantClient.reset()
                yield
                QdrantClient.reset()
        """
        cls._collections = {}
        cls._points = {}


# =============================================================================
# Module Exports
# =============================================================================
# List everything that should be importable from this module.
# This should match what the real qdrant_client exports.

__all__ = [
    # Main client class
    'QdrantClient',
    
    # Submodules (for `from qdrant_client import models` style imports)
    'models',
    'http',
    'conversions',
    'common_types',
    
    # Re-exported types (for direct import convenience)
    'PointStruct',
    'Filter',
    'FieldCondition',
    'Record',
    'MatchValue',
    'MatchAny',
    'MatchText',
    'Range',
    'SearchParams',
    'TextIndexParams',
    'TokenizerType',
    'PayloadSchemaType',
    'TextIndexType',
    'ScoredPoint',
    'CollectionInfo',
    'VectorParams',
    
    # Query result container
    'QueryResult',
]
