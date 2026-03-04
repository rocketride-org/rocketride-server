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
Mock Weaviate client for testing.

This mock simulates the Weaviate Python client for testing vector store operations
without requiring a real Weaviate instance.

Mocked Components:
    - weaviate.connect_to_local() - Creates a mock local client
    - weaviate.connect_to_weaviate_cloud() - Creates a mock cloud client
    - WeaviateClient - Mock client with collections management
    - Collection - Mock collection with query, data, and batch operations

Storage:
    - Uses class-level storage to persist data across operations within a test
    - Call MockWeaviateClient.reset() between tests to clear state
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
from pydantic import BaseModel
import hashlib


# =============================================================================
# Data Classes for Query Results
# =============================================================================

@dataclass
class MetadataResult:
    """Metadata returned with query results."""
    distance: Optional[float] = None


@dataclass
class QueryObject:
    """Object returned from queries."""
    uuid: str
    properties: Dict[str, Any]
    vector: Optional[List[float]] = None
    metadata: MetadataResult = field(default_factory=MetadataResult)


@dataclass
class QueryResult:
    """Result from query operations."""
    objects: List[QueryObject]


@dataclass
class AggregateResult:
    """Result from aggregate operations."""
    total_count: int


# =============================================================================
# Filter Classes
# =============================================================================

class Filter:
    """Mock filter for Weaviate queries."""
    
    def __init__(self, conditions: List[Dict] = None, logic: str = "and"):
        self.conditions = conditions or []
        self.logic = logic
    
    @classmethod
    def by_property(cls, name: str) -> 'FilterByProperty':
        return FilterByProperty(name)
    
    @classmethod
    def all_of(cls, filters: List['Filter']) -> 'Filter':
        combined = Filter(logic="and")
        for f in filters:
            if isinstance(f, Filter):
                combined.conditions.extend(f.conditions)
        return combined
    
    @classmethod
    def any_of(cls, filters: List['Filter']) -> 'Filter':
        combined = Filter(logic="or")
        for f in filters:
            if isinstance(f, Filter):
                combined.conditions.extend(f.conditions)
        return combined
    
    def __and__(self, other: 'Filter') -> 'Filter':
        return Filter.all_of([self, other])
    
    def matches(self, properties: Dict[str, Any]) -> bool:
        """Check if properties match this filter."""
        if not self.conditions:
            return True
        
        results = []
        for cond in self.conditions:
            prop_name = cond.get("property")
            op = cond.get("op")
            value = cond.get("value")
            
            prop_value = properties.get(prop_name)
            
            if op == "equal":
                results.append(prop_value == value)
            elif op == "like":
                # Simple wildcard matching
                pattern = value.replace("*", "")
                results.append(pattern.lower() in str(prop_value).lower() if prop_value else False)
            elif op == "greater_or_equal":
                results.append(prop_value >= value if prop_value is not None else False)
            elif op == "less_or_equal":
                results.append(prop_value <= value if prop_value is not None else False)
            elif op == "less_than":
                results.append(prop_value < value if prop_value is not None else False)
            elif op == "in":
                results.append(prop_value in value if value else False)
            else:
                results.append(True)
        
        if self.logic == "and":
            return all(results) if results else True
        else:  # or
            return any(results) if results else True


class FilterByProperty:
    """Filter builder for a specific property."""
    
    def __init__(self, name: str):
        self.name = name
    
    def equal(self, value: Any) -> Filter:
        f = Filter()
        f.conditions.append({"property": self.name, "op": "equal", "value": value})
        return f
    
    def like(self, value: str) -> Filter:
        f = Filter()
        f.conditions.append({"property": self.name, "op": "like", "value": value})
        return f
    
    def greater_or_equal(self, value: Any) -> Filter:
        f = Filter()
        f.conditions.append({"property": self.name, "op": "greater_or_equal", "value": value})
        return f
    
    def less_or_equal(self, value: Any) -> Filter:
        f = Filter()
        f.conditions.append({"property": self.name, "op": "less_or_equal", "value": value})
        return f
    
    def less_than(self, value: Any) -> Filter:
        f = Filter()
        f.conditions.append({"property": self.name, "op": "less_than", "value": value})
        return f


# =============================================================================
# MetadataQuery for return_metadata parameter
# =============================================================================

class MetadataQuery:
    """Query configuration for metadata return."""
    
    def __init__(self, distance: bool = False):
        self.distance = distance


# =============================================================================
# Mock Collection Components
# =============================================================================

class MockBatchContext:
    """Context manager for batch operations."""
    
    def __init__(self, collection: 'MockCollection'):
        self.collection = collection
        self.objects_to_add: List[Dict] = []
    
    def add_object(self, properties: Dict, uuid: str, vector: List[float]):
        """Add object to batch."""
        self.objects_to_add.append({
            "uuid": uuid,
            "properties": properties,
            "vector": vector
        })
    
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        # Commit all objects
        for obj in self.objects_to_add:
            self.collection._storage[obj["uuid"]] = {
                "properties": obj["properties"],
                "vector": obj["vector"]
            }
        return False


class MockBatch:
    """Mock batch operations."""
    
    def __init__(self, collection: 'MockCollection'):
        self.collection = collection
        self.failed_objects: List = []
    
    def dynamic(self) -> MockBatchContext:
        return MockBatchContext(self.collection)


class MockQuery:
    """Mock query operations."""
    
    def __init__(self, collection: 'MockCollection'):
        self.collection = collection
    
    def near_vector(
        self,
        near_vector: List[float],
        filters: Optional[Filter] = None,
        limit: int = 10,
        return_metadata: Optional[MetadataQuery] = None
    ) -> QueryResult:
        """Perform vector similarity search."""
        results = []
        
        for uuid, data in self.collection._storage.items():
            properties = data["properties"]
            
            # Apply filters
            if filters and not filters.matches(properties):
                continue
            
            # Skip deleted documents
            if properties.get("isDeleted", False):
                continue
            
            # Calculate cosine similarity
            stored_vector = data.get("vector", [])
            if stored_vector and near_vector:
                distance = self._cosine_distance(near_vector, stored_vector)
            else:
                distance = 1.0
            
            metadata = MetadataResult(distance=distance) if return_metadata else MetadataResult()
            
            results.append(QueryObject(
                uuid=uuid,
                properties=self._serialize_properties(properties),
                vector=stored_vector,
                metadata=metadata
            ))
        
        # Sort by distance (lower is better for cosine distance)
        results.sort(key=lambda x: x.metadata.distance if x.metadata.distance else 1.0)
        
        return QueryResult(objects=results[:limit])
    
    def fetch_objects(
        self,
        filters: Optional[Filter] = None,
        limit: int = 100,
        offset: int = 0
    ) -> QueryResult:
        """Fetch objects matching filters."""
        results = []
        
        for uuid, data in self.collection._storage.items():
            properties = data["properties"]
            
            # Apply filters
            if filters and not filters.matches(properties):
                continue
            
            results.append(QueryObject(
                uuid=uuid,
                properties=self._serialize_properties(properties),
                vector=data.get("vector"),
                metadata=MetadataResult()
            ))
        
        return QueryResult(objects=results[offset:offset + limit])
    
    def _cosine_distance(self, v1: List[float], v2: List[float]) -> float:
        """Calculate cosine distance between two vectors."""
        if len(v1) != len(v2):
            return 1.0
        
        dot_product = sum(a * b for a, b in zip(v1, v2))
        norm1 = sum(a * a for a in v1) ** 0.5
        norm2 = sum(b * b for b in v2) ** 0.5
        
        if norm1 == 0 or norm2 == 0:
            return 1.0
        
        similarity = dot_product / (norm1 * norm2)
        return 1.0 - similarity  # Convert to distance
    
    def _serialize_properties(self, properties: Dict) -> Dict:
        """Serialize properties, handling Pydantic models."""
        result = {}
        for key, value in properties.items():
            if hasattr(value, 'model_dump'):
                result[key] = value.model_dump(exclude_none=True)
            elif isinstance(value, dict):
                result[key] = {k: v for k, v in value.items() if v is not None}
            else:
                result[key] = value
        return result


class MockData:
    """Mock data operations."""
    
    def __init__(self, collection: 'MockCollection'):
        self.collection = collection
    
    def delete_many(self, where: Filter):
        """Delete objects matching filter."""
        to_delete = []
        for uuid, data in self.collection._storage.items():
            if where.matches(data["properties"]):
                to_delete.append(uuid)
        
        for uuid in to_delete:
            del self.collection._storage[uuid]
    
    def update(self, uuid: str, properties: Dict):
        """Update object properties."""
        if uuid in self.collection._storage:
            self.collection._storage[uuid]["properties"].update(properties)


class MockAggregate:
    """Mock aggregate operations."""
    
    def __init__(self, collection: 'MockCollection'):
        self.collection = collection
    
    def over_all(self, total_count: bool = False) -> AggregateResult:
        """Get aggregate statistics."""
        return AggregateResult(total_count=len(self.collection._storage))


class MockCollection:
    """Mock Weaviate collection."""
    
    # Class-level storage shared across instances
    _all_storage: Dict[str, Dict[str, Dict]] = {}
    
    def __init__(self, name: str):
        self.name = name
        if name not in MockCollection._all_storage:
            MockCollection._all_storage[name] = {}
        self._storage = MockCollection._all_storage[name]
        
        self.query = MockQuery(self)
        self.data = MockData(self)
        self.batch = MockBatch(self)
        self.aggregate = MockAggregate(self)


# =============================================================================
# Mock Collections Manager
# =============================================================================

class MockCollections:
    """Mock collections manager."""
    
    # Class-level set of collection names
    _collections: set = set()
    
    def exists(self, name: str) -> bool:
        """Check if collection exists."""
        return name in MockCollections._collections
    
    def get(self, name: str) -> MockCollection:
        """Get a collection by name."""
        return MockCollection(name)
    
    def create(self, name: str, **kwargs) -> MockCollection:
        """Create a new collection."""
        MockCollections._collections.add(name)
        return MockCollection(name)


# =============================================================================
# Mock Weaviate Client
# =============================================================================

class MockWeaviateClient:
    """Mock Weaviate client."""
    
    def __init__(self):
        self.collections = MockCollections()
        self._closed = False
    
    def close(self):
        """Close the client connection."""
        self._closed = True
    
    @classmethod
    def reset(cls):
        """Reset all mock state for testing."""
        MockCollections._collections.clear()
        MockCollection._all_storage.clear()


# =============================================================================
# Connection Functions
# =============================================================================

def connect_to_local(
    host: str = "localhost",
    port: int = 8080,
    grpc_port: int = 50051,
    auth_credentials: Any = None,
    additional_config: Any = None
) -> MockWeaviateClient:
    """Connect to a local Weaviate instance (mocked)."""
    return MockWeaviateClient()


def connect_to_weaviate_cloud(
    cluster_url: str,
    auth_credentials: Any = None,
    additional_config: Any = None
) -> MockWeaviateClient:
    """Connect to Weaviate Cloud (mocked)."""
    return MockWeaviateClient()


# =============================================================================
# UUID Generation (matches weaviate.util.generate_uuid5)
# =============================================================================

def generate_uuid5(identifier: str) -> str:
    """Generate a deterministic UUID from an identifier."""
    return hashlib.md5(identifier.encode()).hexdigest()


# =============================================================================
# Re-exports to match weaviate module structure
# =============================================================================

# These would be imported as weaviate.classes.* in real code
# We'll create submodules for them

class client:
    WeaviateClient = MockWeaviateClient


class util:
    generate_uuid5 = staticmethod(generate_uuid5)

