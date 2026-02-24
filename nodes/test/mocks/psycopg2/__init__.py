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
Mock psycopg2 client for testing PostgreSQL with pgvector.

This mock simulates the psycopg2 Python client for testing vector store operations
without requiring a real PostgreSQL instance.

Mocked Components:
    - connect() - Database connection
    - Cursor - SQL execution
    - Basic SQL parsing for vector operations

Storage:
    - Uses class-level storage to persist data across operations within a test
    - Call MockConnection.reset() between tests to clear state
"""

from typing import Any, Dict, List, Optional, Tuple
import re
import numpy as np


# =============================================================================
# Mock Cursor
# =============================================================================

class MockCursor:
    """Mock database cursor."""
    
    def __init__(self, connection: 'MockConnection'):
        self.connection = connection
        self.description: List[Tuple] = []
        self._results: List[Tuple] = []
        self._result_index = 0
    
    def execute(self, query: str, params: Tuple = None):
        """Execute a SQL query."""
        # Normalize query
        query_lower = query.lower().strip()
        
        # Handle different query types
        if query_lower.startswith("select exists"):
            self._handle_exists_query(query, params)
        elif query_lower.startswith("create table"):
            self._handle_create_table(query, params)
        elif query_lower.startswith("select count"):
            self._handle_count_query(query, params)
        elif query_lower.startswith("select") and "embedding" in query_lower:
            self._handle_semantic_search(query, params)
        elif query_lower.startswith("select"):
            self._handle_select_query(query, params)
        elif query_lower.startswith("insert"):
            self._handle_insert(query, params)
        elif query_lower.startswith("delete"):
            self._handle_delete(query, params)
        elif query_lower.startswith("update"):
            self._handle_update(query, params)
    
    def fetchone(self) -> Optional[Tuple]:
        """Fetch one result."""
        if self._result_index < len(self._results):
            result = self._results[self._result_index]
            self._result_index += 1
            return result
        return None
    
    def fetchall(self) -> List[Tuple]:
        """Fetch all results."""
        results = self._results[self._result_index:]
        self._result_index = len(self._results)
        return results
    
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        return False
    
    def _handle_exists_query(self, query: str, params: Tuple):
        """Handle table existence check."""
        table_name = params[0] if params else None
        exists = table_name in self.connection._tables
        self._results = [(exists,)]
        self.description = [("exists",)]
    
    def _handle_create_table(self, query: str, params: Tuple):
        """Handle table creation."""
        # Extract table name from query
        match = re.search(r'create table if not exists (\w+)', query.lower())
        if match:
            table_name = match.group(1)
            self.connection._tables.add(table_name)
            if table_name not in self.connection._storage:
                self.connection._storage[table_name] = {}
        self._results = []
    
    def _handle_count_query(self, query: str, params: Tuple):
        """Handle count query."""
        # Extract table name
        match = re.search(r'from (\w+)', query.lower())
        if match:
            table_name = match.group(1)
            storage = self.connection._storage.get(table_name, {})
            self._results = [(len(storage),)]
            self.description = [("count",)]
        else:
            self._results = [(0,)]
    
    def _handle_select_query(self, query: str, params: Tuple):
        """Handle generic select query."""
        # Extract table name
        match = re.search(r'from (\w+)', query.lower())
        if not match:
            self._results = []
            return
        
        table_name = match.group(1)
        storage = self.connection._storage.get(table_name, {})
        
        # Build results
        results = []
        columns = self._extract_columns(query)
        
        for id, data in storage.items():
            # Apply WHERE filters if present
            if params and not self._matches_where(data, query, params):
                continue
            
            row = self._build_row(data, columns, id)
            results.append(tuple(row))
        
        # Apply LIMIT
        limit = self._extract_limit(query, params)
        if limit:
            results = results[:limit]
        
        self._results = results
        self.description = [(col,) for col in columns]
    
    def _handle_semantic_search(self, query: str, params: Tuple):
        """Handle semantic search with vector distance."""
        # Extract table name
        match = re.search(r'from (\w+)', query.lower())
        if not match:
            self._results = []
            return
        
        table_name = match.group(1)
        storage = self.connection._storage.get(table_name, {})
        
        # Get query vector (first param is usually the vector)
        query_vector = None
        limit = 10
        filter_params = []
        
        if params:
            for p in params:
                if isinstance(p, np.ndarray):
                    query_vector = p.tolist()
                elif isinstance(p, (list, tuple)) and len(p) > 3:
                    query_vector = list(p)
                elif isinstance(p, int) and p < 1000:
                    limit = p
                else:
                    filter_params.append(p)
        
        # Build results with distance
        results = []
        columns = self._extract_columns(query) + ["distance"]
        
        for id, data in storage.items():
            # Apply WHERE filters
            if "where" in query.lower() and filter_params:
                if not self._matches_where_params(data, filter_params):
                    continue
            
            # Calculate distance
            stored_vector = data.get("embedding", [])
            if query_vector and stored_vector:
                if isinstance(stored_vector, np.ndarray):
                    stored_vector = stored_vector.tolist()
                distance = self._cosine_distance(query_vector, stored_vector)
            else:
                distance = 1.0
            
            row = self._build_row(data, columns[:-1], id)
            row.append(distance)
            results.append((tuple(row), distance))
        
        # Sort by distance
        results.sort(key=lambda x: x[1])
        results = [r[0] for r in results[:limit]]
        
        self._results = results
        self.description = [(col,) for col in columns]
    
    def _handle_insert(self, query: str, params: Tuple):
        """Handle insert query."""
        # Extract table name
        match = re.search(r'insert into (\w+)', query.lower())
        if not match:
            return
        
        table_name = match.group(1)
        if table_name not in self.connection._storage:
            self.connection._storage[table_name] = {}
        
        # Extract columns
        col_match = re.search(r'\(([^)]+)\)\s*values', query.lower())
        if col_match:
            columns = [c.strip() for c in col_match.group(1).split(',')]
            
            # Create record
            record = dict(zip(columns, params))
            
            # Generate ID if not provided
            id = len(self.connection._storage[table_name]) + 1
            record['id'] = id
            
            self.connection._storage[table_name][id] = record
        
        self._results = []
    
    def _handle_delete(self, query: str, params: Tuple):
        """Handle delete query."""
        # Extract table name
        match = re.search(r'delete from (\w+)', query.lower())
        if not match:
            return
        
        table_name = match.group(1)
        storage = self.connection._storage.get(table_name, {})
        
        # Handle objectId = ANY(%s) pattern
        if params and "objectid = any" in query.lower():
            object_ids = params[0] if isinstance(params[0], (list, tuple)) else [params[0]]
            to_delete = [id for id, data in storage.items() if data.get("objectid") in object_ids]
            for id in to_delete:
                del storage[id]
        
        self._results = []
    
    def _handle_update(self, query: str, params: Tuple):
        """Handle update query."""
        # Extract table name
        match = re.search(r'update (\w+)', query.lower())
        if not match:
            return
        
        table_name = match.group(1)
        storage = self.connection._storage.get(table_name, {})
        
        # Handle SET isDeleted = TRUE/FALSE WHERE objectId = ANY(%s)
        if "isdeleted" in query.lower() and params:
            new_value = "true" in query.lower()
            object_ids = params[0] if isinstance(params[0], (list, tuple)) else [params[0]]
            for id, data in storage.items():
                if data.get("objectid") in object_ids:
                    data["isdeleted"] = new_value
        
        self._results = []
    
    def _extract_columns(self, query: str) -> List[str]:
        """Extract column names from SELECT query."""
        # Handle SELECT *
        if re.search(r'select\s+\*', query.lower()):
            return ["id", "content", "objectid", "nodeid", "parent", "permissionid", 
                    "isdeleted", "chunkid", "istable", "tableid", "vectorsize", 
                    "modelname", "embedding"]
        
        # Extract specific columns
        match = re.search(r'select\s+(.+?)\s+from', query.lower())
        if match:
            cols = match.group(1)
            # Handle computed columns
            cols = re.sub(r'embedding\s*[<>=]+\s*%s\s+as\s+distance', 'distance', cols)
            return [c.strip() for c in cols.split(',') if c.strip()]
        
        return []
    
    def _extract_limit(self, query: str, params: Tuple) -> Optional[int]:
        """Extract LIMIT value."""
        if "limit" in query.lower() and params:
            # Last param is often the limit
            for p in reversed(params):
                if isinstance(p, int) and p < 10000:
                    return p
        return None
    
    def _matches_where(self, data: Dict, query: str, params: Tuple) -> bool:
        """Check if data matches WHERE clause."""
        # Simple implementation - check common patterns
        return True
    
    def _matches_where_params(self, data: Dict, params: List) -> bool:
        """Check if data matches filter parameters."""
        # Check isDeleted
        is_deleted = data.get("isdeleted", False)
        if False in params and is_deleted:
            return False
        return True
    
    def _build_row(self, data: Dict, columns: List[str], id: int) -> List:
        """Build a result row from data."""
        row = []
        for col in columns:
            col_lower = col.lower()
            if col_lower == "id":
                row.append(id)
            elif col_lower in data:
                row.append(data[col_lower])
            elif col_lower == "distance":
                row.append(0.0)
            else:
                row.append(None)
        return row
    
    def _cosine_distance(self, v1: List[float], v2: List[float]) -> float:
        """Calculate cosine distance."""
        if len(v1) != len(v2):
            return 1.0
        
        dot_product = sum(a * b for a, b in zip(v1, v2))
        norm1 = sum(a * a for a in v1) ** 0.5
        norm2 = sum(b * b for b in v2) ** 0.5
        
        if norm1 == 0 or norm2 == 0:
            return 1.0
        
        similarity = dot_product / (norm1 * norm2)
        return 1.0 - similarity


# =============================================================================
# Mock Connection
# =============================================================================

class MockConnection:
    """Mock database connection."""
    
    # Class-level storage
    _storage: Dict[str, Dict[int, Dict]] = {}
    _tables: set = set()
    
    def __init__(self, **kwargs):
        self.dbname = kwargs.get("dbname")
        self.user = kwargs.get("user")
        self.password = kwargs.get("password")
        self.host = kwargs.get("host")
        self.port = kwargs.get("port")
    
    def cursor(self) -> MockCursor:
        """Get a cursor."""
        return MockCursor(self)
    
    def commit(self):
        """Commit transaction."""
        pass
    
    def close(self):
        """Close connection."""
        pass
    
    @classmethod
    def reset(cls):
        """Reset all mock state for testing."""
        cls._storage.clear()
        cls._tables.clear()


# =============================================================================
# Connection Function
# =============================================================================

def connect(
    dbname: str = None,
    user: str = None,
    password: str = None,
    host: str = None,
    port: int = None,
    **kwargs
) -> MockConnection:
    """Create a database connection."""
    return MockConnection(
        dbname=dbname,
        user=user,
        password=password,
        host=host,
        port=port,
        **kwargs
    )

