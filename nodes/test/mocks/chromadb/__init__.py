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
    - Collection - Collection with query, get, upsert, delete operations
    - Settings - Client configuration

Storage:
    - Uses class-level storage to persist data across operations within a test
    - Call MockHttpClient.reset() between tests to clear state
"""

from typing import Any, Dict, List, Optional
import uuid as uuid_module


# =============================================================================
# Settings (from chromadb.config)
# =============================================================================

class Settings:
    """Mock ChromaDB settings."""
    
    def __init__(
        self,
        chroma_client_auth_provider: str = None,
        chroma_client_auth_credentials: str = None,
        **kwargs
    ):
        self.chroma_client_auth_provider = chroma_client_auth_provider
        self.chroma_client_auth_credentials = chroma_client_auth_credentials


# =============================================================================
# Mock Collection
# =============================================================================

class MockCollection:
    """Mock ChromaDB collection."""
    
    # Class-level storage: {collection_name: {id: {embedding, metadata, document}}}
    _all_storage: Dict[str, Dict[str, Dict]] = {}
    _collection_metadata: Dict[str, Dict] = {}
    
    def __init__(self, name: str, metadata: Dict = None):
        self.name = name
        if name not in MockCollection._all_storage:
            MockCollection._all_storage[name] = {}
        if metadata:
            MockCollection._collection_metadata[name] = metadata
    
    @property
    def _storage(self) -> Dict[str, Dict]:
        return MockCollection._all_storage.get(self.name, {})
    
    def query(
        self,
        query_embeddings: List[List[float]] = None,
        n_results: int = 10,
        where: Optional[Dict] = None,
        where_document: Optional[Dict] = None,
        include: List[str] = None
    ) -> Dict[str, Any]:
        """Query the collection for similar vectors."""
        if include is None:
            include = ["metadatas", "documents", "distances"]
        
        query_vector = query_embeddings[0] if query_embeddings else None
        
        results = {
            "ids": [[]],
            "metadatas": [[]],
            "documents": [[]],
            "distances": [[]]
        }
        
        matches = []
        for id, data in self._storage.items():
            metadata = data.get("metadata", {})
            document = data.get("document", "")
            
            # Filter out schema/deleted documents from search results
            if metadata.get("isDeleted") is True:
                continue
            
            # Apply metadata filter
            if where and not self._matches_filter(metadata, where):
                continue
            
            # Apply document filter
            if where_document and not self._matches_document_filter(document, where_document):
                continue
            
            # Calculate distance
            stored_vector = data.get("embedding", [])
            if stored_vector and query_vector:
                distance = self._cosine_distance(query_vector, stored_vector)
            else:
                distance = 1.0
            
            matches.append({
                "id": id,
                "metadata": self._serialize_metadata(metadata),
                "document": document,
                "distance": distance
            })
        
        # Sort by distance (lower is better)
        matches.sort(key=lambda x: x["distance"])
        matches = matches[:n_results]
        
        for match in matches:
            results["ids"][0].append(match["id"])
            results["metadatas"][0].append(match["metadata"])
            results["documents"][0].append(match["document"])
            results["distances"][0].append(match["distance"])
        
        return results
    
    def get(
        self,
        ids: List[str] = None,
        where: Optional[Dict] = None,
        where_document: Optional[Dict] = None,
        include: List[str] = None,
        limit: int = None,
        offset: int = 0
    ) -> Dict[str, Any]:
        """Get items from the collection."""
        if include is None:
            include = ["metadatas", "documents"]
        
        results = {
            "ids": [],
            "metadatas": [],
            "documents": [],
            "embeddings": []
        }
        
        items = list(self._storage.items())
        
        # Filter by ids if provided
        if ids:
            items = [(id, data) for id, data in items if id in ids]
        
        count = 0
        for id, data in items:
            metadata = data.get("metadata", {})
            document = data.get("document", "")
            
            # Apply metadata filter
            if where and not self._matches_filter(metadata, where):
                continue
            
            # Apply document filter
            if where_document and not self._matches_document_filter(document, where_document):
                continue
            
            # Apply offset
            if count < offset:
                count += 1
                continue
            
            results["ids"].append(id)
            if "metadatas" in include:
                results["metadatas"].append(self._serialize_metadata(metadata))
            if "documents" in include:
                results["documents"].append(document)
            if "embeddings" in include:
                results["embeddings"].append(data.get("embedding"))
            
            count += 1
            
            # Apply limit
            if limit and len(results["ids"]) >= limit:
                break
        
        return results
    
    def upsert(
        self,
        ids: List[str],
        embeddings: List[List[float]] = None,
        metadatas: List[Dict] = None,
        documents: List[str] = None
    ):
        """Upsert items into the collection."""
        for i, id in enumerate(ids):
            self._storage[id] = {
                "embedding": embeddings[i] if embeddings else [],
                "metadata": metadatas[i] if metadatas else {},
                "document": documents[i] if documents else ""
            }
    
    def add(
        self,
        ids: List[str],
        embeddings: List[List[float]] = None,
        metadatas: List[Dict] = None,
        documents: List[str] = None
    ):
        """Add items to the collection."""
        self.upsert(ids, embeddings, metadatas, documents)
    
    def delete(
        self,
        ids: List[str] = None,
        where: Optional[Dict] = None
    ):
        """Delete items from the collection."""
        if ids:
            for id in ids:
                if id in self._storage:
                    del self._storage[id]
        elif where:
            to_delete = []
            for id, data in self._storage.items():
                if self._matches_filter(data.get("metadata", {}), where):
                    to_delete.append(id)
            for id in to_delete:
                del self._storage[id]
    
    def update(
        self,
        ids: List[str] = None,
        where: Optional[Dict] = None,
        new_metadata: Dict = None
    ):
        """Update items in the collection."""
        if ids:
            for id in ids:
                if id in self._storage and new_metadata:
                    self._storage[id]["metadata"].update(new_metadata)
        elif where:
            for id, data in self._storage.items():
                if self._matches_filter(data.get("metadata", {}), where):
                    if new_metadata:
                        self._storage[id]["metadata"].update(new_metadata)
    
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
                    elif op == "$lt":
                        if value is None or value >= expected:
                            return False
            else:
                # Direct equality
                if value != condition:
                    return False
        
        return True
    
    def _matches_document_filter(self, document: str, filter: Dict) -> bool:
        """Check if document matches the filter."""
        if not filter:
            return True
        
        if "$contains" in filter:
            return filter["$contains"] in document
        
        return True
    
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
    
    def _serialize_metadata(self, metadata: Dict) -> Dict:
        """Serialize metadata, handling special types."""
        result = {}
        for key, value in metadata.items():
            if hasattr(value, 'model_dump'):
                result[key] = value.model_dump(exclude_none=True)
            elif isinstance(value, dict):
                result[key] = {k: v for k, v in value.items() if v is not None}
            else:
                result[key] = value
        return result


# =============================================================================
# Mock HTTP Client
# =============================================================================

class HttpClient:
    """Mock ChromaDB HTTP client."""
    
    # Class-level set of collection names
    _collections: set = set()
    
    def __init__(
        self,
        host: str = "localhost",
        port: int = 8000,
        settings: Settings = None
    ):
        self.host = host
        self.port = port
        self.settings = settings
    
    def list_collections(self) -> List[str]:
        """List all collections."""
        return list(HttpClient._collections)
    
    def get_collection(self, name: str) -> MockCollection:
        """Get a collection by name."""
        return MockCollection(name)
    
    def get_or_create_collection(
        self,
        name: str,
        metadata: Dict = None
    ) -> MockCollection:
        """Get or create a collection."""
        HttpClient._collections.add(name)
        return MockCollection(name, metadata)
    
    def create_collection(
        self,
        name: str,
        metadata: Dict = None
    ) -> MockCollection:
        """Create a new collection."""
        HttpClient._collections.add(name)
        return MockCollection(name, metadata)
    
    def delete_collection(self, name: str):
        """Delete a collection."""
        if name in HttpClient._collections:
            HttpClient._collections.remove(name)
        if name in MockCollection._all_storage:
            del MockCollection._all_storage[name]
    
    @classmethod
    def reset(cls):
        """Reset all mock state for testing."""
        cls._collections.clear()
        MockCollection._all_storage.clear()
        MockCollection._collection_metadata.clear()


# Alias for backwards compatibility
Collection = MockCollection


# =============================================================================
# Config submodule
# =============================================================================

class config:
    """Mock config submodule."""
    Settings = Settings

