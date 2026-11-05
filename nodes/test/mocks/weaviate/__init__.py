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
    - Values are typed as the server types them: a property the collection does not
      declare is auto-schemaed on first write (numbers as ``number``, returned as
      floats; RFC 3339 strings as ``date``, returned as datetimes)
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import re


# =============================================================================
# Auto-schema (what the server does with properties a collection does not declare)
# =============================================================================

#: Objects a query returns when it sets no limit (the server's QUERY_DEFAULTS_LIMIT)
QUERY_DEFAULTS_LIMIT = 10

#: An RFC 3339 timestamp, which auto-schema types as ``date`` (AUTOSCHEMA_DEFAULT_DATE)
_RFC3339 = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')


def _data_type_name(data_type: Any) -> str:
    """'text', 'int', 'number', 'date', ... for a DataType member or its value."""
    return str(getattr(data_type, 'value', data_type))


def _infer_type(value: Any) -> str:
    """The type auto-schema gives an undeclared property: numbers become 'number', timestamps 'date'."""
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, datetime) or (isinstance(value, str) and _RFC3339.match(value)):
        return 'date'
    if isinstance(value, str):
        return 'text'
    return 'object'


def _as_type(data_type: str, value: Any) -> Any:
    """A value as the server stores (and the client returns) it for a property of ``data_type``."""
    if value is None:
        return None
    if data_type == 'number' and isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if data_type == 'int' and isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if data_type == 'date' and isinstance(value, str):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    return value


def _apply_schema(collection_name: str, properties: Dict[str, Any]) -> Dict[str, Any]:
    """Type ``properties`` by the collection's schema, adding undeclared ones as auto-schema would."""
    schema = MockCollections._schemas.setdefault(collection_name, {})
    typed = {}
    for key, value in properties.items():
        if key not in schema and value is not None:
            schema[key] = _infer_type(value)
        typed[key] = _as_type(schema.get(key, ''), value)
    return typed


# =============================================================================
# Data Classes for Query Results
# =============================================================================


@dataclass
class MetadataResult:
    """Metadata returned with query results."""

    distance: Optional[float] = None


@dataclass
class QueryObject:
    """Object returned from queries.

    Like the real client (v4), ``vector`` is a dict of named vectors
    (``{'default': [...]}``) and is empty unless ``include_vector`` was asked for.
    """

    uuid: str
    properties: Dict[str, Any]
    vector: Dict[str, List[float]] = field(default_factory=dict)
    metadata: MetadataResult = field(default_factory=MetadataResult)


@dataclass
class QueryResult:
    """Result from query operations."""

    objects: List[QueryObject]


@dataclass
class AggregateResult:
    """Result from aggregate operations."""

    total_count: int


@dataclass
class GroupedBy:
    """The property and value an aggregate group was built from."""

    prop: str
    value: Any


@dataclass
class AggregateGroup:
    """One group of a grouped aggregate."""

    grouped_by: GroupedBy
    total_count: int
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AggregateGroupByReturn:
    """Result of an aggregate with ``group_by``."""

    groups: List[AggregateGroup]


@dataclass
class DeleteManyReturn:
    """Result of ``data.delete_many``."""

    matches: int
    successful: int
    failed: int = 0


# =============================================================================
# Filter Classes
# =============================================================================


class Filter:
    """Mock filter for Weaviate queries.

    A filter is a tree: leaf ``conditions`` and nested ``children`` combined
    with ``logic`` ('and' / 'or'), so ``all_of([any_of([...]), ...])`` keeps
    the inner 'or' as the real client does.
    """

    def __init__(self, conditions: List[Dict] = None, logic: str = 'and', children: List['Filter'] = None):
        self.conditions = conditions or []
        self.logic = logic
        self.children = children or []

    @classmethod
    def by_property(cls, name: str) -> 'FilterByProperty':
        return FilterByProperty(name)

    @classmethod
    def by_id(cls) -> 'FilterByProperty':
        return FilterByProperty('_id')

    @classmethod
    def all_of(cls, filters: List['Filter']) -> 'Filter':
        return Filter(logic='and', children=[f for f in filters if isinstance(f, Filter)])

    @classmethod
    def any_of(cls, filters: List['Filter']) -> 'Filter':
        return Filter(logic='or', children=[f for f in filters if isinstance(f, Filter)])

    def __and__(self, other: 'Filter') -> 'Filter':
        return Filter.all_of([self, other])

    def __or__(self, other: 'Filter') -> 'Filter':
        return Filter.any_of([self, other])

    @staticmethod
    def _matches_condition(cond: Dict[str, Any], properties: Dict[str, Any], uuid: Optional[str]) -> bool:
        prop_name = cond.get('property')
        op = cond.get('op')
        value = cond.get('value')
        prop_value = uuid if prop_name == '_id' else properties.get(prop_name)

        if op == 'equal':
            return prop_value == value
        if op == 'not_equal':
            return prop_value != value
        if op == 'like':
            # Simple wildcard matching
            pattern = value.replace('*', '')
            return pattern.lower() in str(prop_value).lower() if prop_value is not None else False
        if op == 'greater_or_equal':
            return prop_value >= value if prop_value is not None else False
        if op == 'greater_than':
            return prop_value > value if prop_value is not None else False
        if op == 'less_or_equal':
            return prop_value <= value if prop_value is not None else False
        if op == 'less_than':
            return prop_value < value if prop_value is not None else False
        if op in ('in', 'contains_any'):
            return prop_value in value if value else False
        return True

    def matches(self, properties: Dict[str, Any], uuid: Optional[str] = None) -> bool:
        """Check if properties (and the object's uuid, for ``by_id``) match this filter."""
        results = [self._matches_condition(cond, properties, uuid) for cond in self.conditions]
        results += [child.matches(properties, uuid) for child in self.children]
        if not results:
            return True
        if self.logic == 'and':
            return all(results)
        return any(results)


class FilterByProperty:
    """Filter builder for a specific property."""

    def __init__(self, name: str):
        self.name = name

    def _leaf(self, op: str, value: Any) -> Filter:
        f = Filter()
        f.conditions.append({'property': self.name, 'op': op, 'value': value})
        return f

    def equal(self, value: Any) -> Filter:
        return self._leaf('equal', value)

    def not_equal(self, value: Any) -> Filter:
        return self._leaf('not_equal', value)

    def like(self, value: str) -> Filter:
        return self._leaf('like', value)

    def greater_or_equal(self, value: Any) -> Filter:
        return self._leaf('greater_or_equal', value)

    def greater_than(self, value: Any) -> Filter:
        return self._leaf('greater_than', value)

    def less_or_equal(self, value: Any) -> Filter:
        return self._leaf('less_or_equal', value)

    def less_than(self, value: Any) -> Filter:
        return self._leaf('less_than', value)

    def contains_any(self, values: List[Any]) -> Filter:
        return self._leaf('contains_any', list(values))


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
        self.objects_to_add.append({'uuid': str(uuid), 'properties': properties, 'vector': vector})

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # Commit all objects (an existing uuid is overwritten, as in Weaviate), typed by the schema
        for obj in self.objects_to_add:
            properties = _apply_schema(self.collection.name, dict(obj['properties']))
            self.collection._storage[obj['uuid']] = {'properties': properties, 'vector': obj['vector']}
        return False


class MockBatch:
    """Mock batch operations."""

    def __init__(self, collection: 'MockCollection'):
        self.collection = collection
        self.failed_objects: List = []

    def dynamic(self) -> MockBatchContext:
        return MockBatchContext(self.collection)


def _named_vector(stored: Optional[List[float]], include_vector: bool) -> Dict[str, List[float]]:
    """The ``vector`` of a returned object: ``{'default': [...]}`` when requested, else empty."""
    if include_vector and stored is not None:
        return {'default': list(stored)}
    return {}


class MockQuery:
    """Mock query operations."""

    def __init__(self, collection: 'MockCollection'):
        self.collection = collection

    def near_vector(
        self,
        near_vector: List[float],
        filters: Optional[Filter] = None,
        limit: int = 10,
        return_metadata: Optional[MetadataQuery] = None,
        include_vector: bool = False,
        **kwargs,
    ) -> QueryResult:
        """Perform vector similarity search."""
        results = []

        for uuid, data in self.collection._storage.items():
            properties = data['properties']

            # Apply filters
            if filters and not filters.matches(properties, uuid):
                continue

            # Calculate cosine similarity
            stored_vector = data.get('vector', [])
            if stored_vector and near_vector:
                distance = self._cosine_distance(near_vector, stored_vector)
            else:
                distance = 1.0

            metadata = MetadataResult(distance=distance) if return_metadata else MetadataResult()

            results.append(
                QueryObject(
                    uuid=uuid,
                    properties=self._serialize_properties(properties),
                    vector=_named_vector(stored_vector, include_vector),
                    metadata=metadata,
                )
            )

        # Sort by distance (lower is better for cosine distance)
        results.sort(key=lambda x: x.metadata.distance if x.metadata.distance is not None else 1.0)

        return QueryResult(objects=results[:limit])

    def fetch_objects(
        self,
        filters: Optional[Filter] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        after: Optional[str] = None,
        include_vector: bool = False,
        **kwargs,
    ) -> QueryResult:
        """Fetch objects matching filters (insertion order; ``after`` continues from a uuid)."""
        results = []

        for uuid, data in self.collection._storage.items():
            properties = data['properties']

            # Apply filters
            if filters and not filters.matches(properties, uuid):
                continue

            results.append(
                QueryObject(
                    uuid=uuid,
                    properties=self._serialize_properties(properties),
                    vector=_named_vector(data.get('vector'), include_vector),
                    metadata=MetadataResult(),
                )
            )

        if after is not None:
            ids = [obj.uuid for obj in results]
            results = results[ids.index(str(after)) + 1 :] if str(after) in ids else []

        # Without a limit the server answers QUERY_DEFAULTS_LIMIT (10) objects
        start = offset or 0
        stop = start + (QUERY_DEFAULTS_LIMIT if limit is None else limit)
        return QueryResult(objects=results[start:stop])

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

    def delete_many(self, where: Filter) -> DeleteManyReturn:
        """Delete objects matching filter."""
        to_delete = []
        for uuid, data in self.collection._storage.items():
            if where.matches(data['properties'], uuid):
                to_delete.append(uuid)

        for uuid in to_delete:
            del self.collection._storage[uuid]

        return DeleteManyReturn(matches=len(to_delete), successful=len(to_delete))

    def update(self, uuid: str, properties: Dict):
        """Update object properties."""
        if uuid in self.collection._storage:
            self.collection._storage[uuid]['properties'].update(_apply_schema(self.collection.name, dict(properties)))


class MockAggregate:
    """Mock aggregate operations."""

    def __init__(self, collection: 'MockCollection'):
        self.collection = collection

    def over_all(self, filters: Optional[Filter] = None, group_by: Any = None, total_count: bool = False, **kwargs):
        """Count the objects matching ``filters``; with ``group_by``, count per property value."""
        matching = [
            data['properties']
            for uuid, data in self.collection._storage.items()
            if filters is None or filters.matches(data['properties'], uuid)
        ]
        if group_by is None:
            return AggregateResult(total_count=len(matching))
        prop = group_by if isinstance(group_by, str) else group_by.prop
        limit = None if isinstance(group_by, str) else group_by.limit
        counts: Dict[Any, int] = {}
        for properties in matching:
            value = properties.get(prop)
            counts[value] = counts.get(value, 0) + 1
        groups = [AggregateGroup(grouped_by=GroupedBy(prop=prop, value=v), total_count=n) for v, n in counts.items()]
        return AggregateGroupByReturn(groups=groups[:limit] if limit else groups)


@dataclass
class _VectorIndexConfig:
    """What ``config.get().vector_index_config`` reports."""

    distance_metric: Any
    ef_construction: int = 128
    max_connections: int = 32


@dataclass
class _CollectionConfig:
    """What ``collection.config.get()`` returns."""

    name: str
    vector_index_config: Optional[_VectorIndexConfig]
    vector_index_type: Optional[str]


class MockConfig:
    """Mock ``collection.config``."""

    def __init__(self, collection: 'MockCollection'):
        self.collection = collection

    def get(self) -> _CollectionConfig:
        """Return the configuration the collection was created with."""
        created = MockCollections._configs.get(self.collection.name) or {}
        index = created.get('vector_index_config') or {}
        if not index:
            return _CollectionConfig(name=self.collection.name, vector_index_config=None, vector_index_type=None)
        return _CollectionConfig(
            name=self.collection.name,
            vector_index_config=_VectorIndexConfig(distance_metric=index.get('distance_metric')),
            vector_index_type=index.get('type'),
        )


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
        self.config = MockConfig(self)


# =============================================================================
# Mock Collections Manager
# =============================================================================


class MockCollections:
    """Mock collections manager."""

    # Class-level set of collection names, the arguments they were created with, and their
    # schema (property name -> data type), which auto-schema extends on writes
    _collections: set = set()
    _configs: Dict[str, Dict[str, Any]] = {}
    _schemas: Dict[str, Dict[str, str]] = {}

    def exists(self, name: str) -> bool:
        """Check if collection exists."""
        return name in MockCollections._collections

    def get(self, name: str) -> MockCollection:
        """Get a collection by name."""
        return MockCollection(name)

    def create(self, name: str, **kwargs) -> MockCollection:
        """Create a new collection."""
        MockCollections._collections.add(name)
        MockCollections._configs[name] = dict(kwargs)
        MockCollections._schemas[name] = {
            prop.name: _data_type_name(prop.data_type) for prop in kwargs.get('properties') or []
        }
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

    def get_meta(self) -> Dict[str, Any]:
        """Server metadata, as ``WeaviateClient.get_meta()`` returns it."""
        return {'hostname': 'http://[::]:8080', 'version': '1.30.0-mock', 'modules': {}}

    @classmethod
    def reset(cls):
        """Reset all mock state for testing."""
        MockCollections._collections.clear()
        MockCollections._configs.clear()
        MockCollections._schemas.clear()
        MockCollection._all_storage.clear()


# =============================================================================
# Connection Functions
# =============================================================================


def connect_to_local(
    host: str = 'localhost',
    port: int = 8080,
    grpc_port: int = 50051,
    auth_credentials: Any = None,
    additional_config: Any = None,
) -> MockWeaviateClient:
    """Connect to a local Weaviate instance (mocked)."""
    return MockWeaviateClient()


def connect_to_weaviate_cloud(
    cluster_url: str, auth_credentials: Any = None, additional_config: Any = None
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
