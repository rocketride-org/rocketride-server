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
Mock Pinecone client for testing.

This mock simulates the Pinecone Python client for testing vector store operations
without requiring a real Pinecone instance.

Mocked Components:
    - PineconeGRPC (aliased as Pinecone) - Main client class
    - ServerlessSpec, PodSpec - Index specifications
    - Index operations (query, upsert, delete, describe_index_stats)

Storage:
    - Uses class-level storage to persist data across operations within a test
    - Call MockPinecone.reset() between tests to clear state
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass


# =============================================================================
# Index Specifications
# =============================================================================

@dataclass
class ServerlessSpec:
    """Serverless index specification."""
    cloud: str = "aws"
    region: str = "us-east-1"


@dataclass
class PodSpec:
    """Pod-based index specification."""
    environment: str = "us-east1-gcp"
    pods: int = 1
    pod_type: str = "p1.x1"


# =============================================================================
# Mock Index
# =============================================================================

class MockIndex:
    """Mock Pinecone index."""
    
    # Class-level storage: {index_name: {id: {values, metadata}}}
    _all_storage: Dict[str, Dict[str, Dict]] = {}
    _dimensions: Dict[str, int] = {}
    
    def __init__(self, name: str):
        self.name = name
        if name not in MockIndex._all_storage:
            MockIndex._all_storage[name] = {}
    
    @property
    def _storage(self) -> Dict[str, Dict]:
        return MockIndex._all_storage.get(self.name, {})
    
    def describe_index_stats(self) -> Dict[str, Any]:
        """Get index statistics."""
        return {
            "total_vector_count": len(self._storage),
            "dimension": MockIndex._dimensions.get(self.name, 0)
        }
    
    def query(
        self,
        vector: List[float],
        top_k: int = 10,
        filter: Optional[Dict] = None,
        include_metadata: bool = True,
        include_values: bool = False
    ) -> Dict[str, Any]:
        """Query the index for similar vectors."""
        matches = []
        
        for id, data in self._storage.items():
            metadata = data.get("metadata", {})
            
            # Apply filters
            if filter and not self._matches_filter(metadata, filter):
                continue
            
            # Calculate similarity score
            stored_vector = data.get("values", [])
            if stored_vector and vector:
                score = self._cosine_similarity(vector, stored_vector)
            else:
                score = 0.0
            
            match = {"id": id, "score": score}
            if include_metadata:
                match["metadata"] = self._serialize_metadata(metadata)
            if include_values:
                match["values"] = stored_vector
            
            matches.append(match)
        
        # Sort by score descending
        matches.sort(key=lambda x: x["score"], reverse=True)
        
        return {"matches": matches[:top_k]}
    
    def upsert(self, vectors: List[Dict[str, Any]]):
        """Upsert vectors into the index."""
        for vec in vectors:
            vec_id = vec["id"]
            values = vec["values"]
            metadata = vec.get("metadata", {})
            
            # Store dimension if not set
            if self.name not in MockIndex._dimensions and values:
                MockIndex._dimensions[self.name] = len(values)
            
            self._storage[vec_id] = {
                "values": values,
                "metadata": metadata
            }
    
    def delete(self, ids: List[str] = None, filter: Dict = None):
        """Delete vectors from the index."""
        if ids:
            for id in ids:
                if id in self._storage:
                    del self._storage[id]
        elif filter:
            to_delete = []
            for id, data in self._storage.items():
                if self._matches_filter(data.get("metadata", {}), filter):
                    to_delete.append(id)
            for id in to_delete:
                del self._storage[id]
    
    def update(self, id: str, set_metadata: Dict = None):
        """Update vector metadata."""
        if id in self._storage and set_metadata:
            self._storage[id]["metadata"].update(set_metadata)
    
    def _matches_filter(self, metadata: Dict, filter: Dict) -> bool:
        """Check if metadata matches the filter."""
        if not filter:
            return True
        
        # Handle $and
        if "$and" in filter:
            return all(self._matches_filter(metadata, f) for f in filter["$and"])
        
        # Handle $or
        if "$or" in filter:
            return any(self._matches_filter(metadata, f) for f in filter["$or"])
        
        # Handle individual field conditions
        for field, condition in filter.items():
            if field.startswith("$"):
                continue
            
            value = metadata.get(field)
            
            if isinstance(condition, dict):
                for op, expected in condition.items():
                    if op == "$eq":
                        if value != expected:
                            return False
                    elif op == "$in":
                        if value not in expected:
                            return False
                    elif op == "$gte":
                        if value is None or value < expected:
                            return False
                    elif op == "$lte":
                        if value is None or value > expected:
                            return False
                    elif op == "$contains":
                        if expected not in str(value):
                            return False
            else:
                # Direct equality
                if value != condition:
                    return False
        
        return True
    
    def _cosine_similarity(self, v1: List[float], v2: List[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        if len(v1) != len(v2):
            return 0.0
        
        dot_product = sum(a * b for a, b in zip(v1, v2))
        norm1 = sum(a * a for a in v1) ** 0.5
        norm2 = sum(b * b for b in v2) ** 0.5
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return dot_product / (norm1 * norm2)
    
    def _serialize_metadata(self, metadata: Dict) -> Dict:
        """Serialize metadata, handling special types and excluding None values."""
        result = {}
        for key, value in metadata.items():
            if value is None:
                continue  # Skip None values
            if hasattr(value, 'model_dump'):
                result[key] = value.model_dump(exclude_none=True)
            elif isinstance(value, dict):
                result[key] = {k: v for k, v in value.items() if v is not None}
            else:
                result[key] = value
        return result


# =============================================================================
# Mock Pinecone Client
# =============================================================================

class MockPinecone:
    """Mock Pinecone client."""
    
    # Class-level set of index names
    _indexes: Dict[str, Dict] = {}
    
    def __init__(self, api_key: str = None):
        self.api_key = api_key
    
    def has_index(self, name: str) -> bool:
        """Check if an index exists."""
        return name in MockPinecone._indexes
    
    def create_index(
        self,
        name: str,
        dimension: int,
        metric: str = "cosine",
        spec: Any = None
    ):
        """Create a new index."""
        MockPinecone._indexes[name] = {
            "dimension": dimension,
            "metric": metric,
            "spec": spec
        }
        MockIndex._dimensions[name] = dimension
        MockIndex._all_storage[name] = {}
    
    def Index(self, name: str) -> MockIndex:
        """Get an index by name."""
        return MockIndex(name)
    
    @classmethod
    def reset(cls):
        """Reset all mock state for testing."""
        cls._indexes.clear()
        MockIndex._all_storage.clear()
        MockIndex._dimensions.clear()


# =============================================================================
# GRPC submodule (pinecone.grpc.PineconeGRPC)
# =============================================================================

class grpc:
    """Mock grpc submodule."""
    PineconeGRPC = MockPinecone


# Alias for direct import
PineconeGRPC = MockPinecone

