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
    set ROCKETRIDE_MOCK=C:\\Projects\\rocketride-server\\nodes\\test\\mocks
    python -m pytest nodes/test/test_dynamic.py -k qdrant -s -v
"""

import copy
import random
import uuid
from types import SimpleNamespace
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
    PointStruct,  # Represents a point (vector + payload) to store
    Filter,  # Query filter with must/should/must_not conditions
    FieldCondition,  # Single field condition (key + match criteria)
    Record,  # Result record from scroll() operations
    MatchValue,  # Match exact value
    MatchAny,  # Match any value in a list
    MatchText,  # Full-text match
    Range,  # Numeric range match (gte, lte, gt, lt)
    SearchParams,  # Search algorithm parameters
    TextIndexParams,  # Text indexing configuration
    TokenizerType,  # Text tokenization options
    PayloadSchemaType,  # Payload field type for indexing
    TextIndexType,  # Text index type
    ScoredPoint,  # Search result with similarity score
)
from .conversions.common_types import CollectionConfig, CollectionInfo, CollectionParams, HnswConfig, VectorParams


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
# Filter evaluation (mirrors Qdrant's semantics for the conditions the store uses)
# =============================================================================

_MISSING = object()


def _payload_value(payload: Optional[Dict[str, Any]], key: str) -> Any:
    """Return the value at a dot-notation ``key`` (e.g. ``meta.objectId``), or ``_MISSING``."""
    value: Any = payload
    for part in key.split('.'):
        if isinstance(value, dict):
            if part not in value:
                return _MISSING
            value = value[part]
        elif value is not None and hasattr(value, part):
            value = getattr(value, part)
        else:
            return _MISSING
    return value


def _id_sort_key(point_id: Any) -> Tuple[int, Any]:
    """Qdrant orders point ids numerically first, then UUIDs."""
    if isinstance(point_id, int):
        return (0, point_id)
    return (1, str(point_id))


def _field_matches(point: PointStruct, cond: FieldCondition) -> bool:
    """Evaluate one ``FieldCondition`` against a stored point."""
    value = _payload_value(point.payload, cond.key)
    values = value if isinstance(value, list) else [value]
    match = cond.match
    if match is not None:
        if isinstance(match, models.MatchExcept):
            return value is not _MISSING and all(v not in match.except_ for v in values)
        if isinstance(match, MatchAny):
            return any(v in match.any for v in values if v is not _MISSING)
        if isinstance(match, MatchText):
            return any(isinstance(v, str) and match.text in v for v in values)
        if isinstance(match, MatchValue):
            return any(v == match.value and type(v) is type(match.value) for v in values if v is not _MISSING)
        return True
    if cond.range is not None:
        rng = cond.range
        for v in values:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            if rng.gte is not None and v < rng.gte:
                continue
            if rng.lte is not None and v > rng.lte:
                continue
            if rng.gt is not None and v <= rng.gt:
                continue
            if rng.lt is not None and v >= rng.lt:
                continue
            return True
        return False
    return True


def _condition_matches(point: PointStruct, cond: Any) -> bool:
    """Evaluate a filter condition (field, id, null/empty, or a nested ``Filter``)."""
    if isinstance(cond, Filter):
        return _filter_matches(point, cond)
    if isinstance(cond, FieldCondition):
        return _field_matches(point, cond)
    if isinstance(cond, models.HasIdCondition):
        return point.id in set(cond.has_id)
    if isinstance(cond, models.IsNullCondition):
        return _payload_value(point.payload, cond.is_null.key) is None
    if isinstance(cond, models.IsEmptyCondition):
        value = _payload_value(point.payload, cond.is_empty.key)
        return value is _MISSING or value is None or value == []
    return True


def _filter_matches(point: PointStruct, flt: Optional[Filter]) -> bool:
    """Evaluate a ``Filter`` (must / should / must_not) against a stored point."""
    if flt is None:
        return True
    if flt.must and not all(_condition_matches(point, c) for c in flt.must):
        return False
    if flt.should and not any(_condition_matches(point, c) for c in flt.should):
        return False
    if flt.must_not and any(_condition_matches(point, c) for c in flt.must_not):
        return False
    return True


def _similarity(distance: str, a: List[float], b: List[float]) -> float:
    """Qdrant's score for two vectors: cosine/dot similarity, or the euclid/manhattan distance."""
    if distance == 'Dot':
        return float(sum(x * y for x, y in zip(a, b)))
    if distance == 'Euclid':
        return float(sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5)
    if distance == 'Manhattan':
        return float(sum(abs(x - y) for x, y in zip(a, b)))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if not norm_a or not norm_b:
        return 0.0
    return float(sum(x * y for x, y in zip(a, b)) / (norm_a * norm_b))


def _lower_is_better(distance: str) -> bool:
    return distance in ('Euclid', 'Manhattan')


def _strategy_of(recommend: Any) -> str:
    """A recommendation's strategy as its string value ('average_vector' when unset)."""
    strategy = getattr(recommend, 'strategy', None)
    return str(getattr(strategy, 'value', strategy) or 'average_vector')


def _is_point_id(value: Any) -> bool:
    """Whether ``value`` is a point id the server accepts: an unsigned integer or a UUID string."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    if isinstance(value, str):
        try:
            uuid.UUID(value)
        except ValueError:
            return False
        return True
    return False


def _index_kind(entry: Any) -> str:
    """The data type of a payload index entry ('keyword', 'integer', ...), as a plain string."""
    kind = getattr(entry, 'data_type', None) or getattr(entry, 'type', None) or entry
    return str(getattr(kind, 'value', kind) or '').lower()


def _select_payload(payload: Dict[str, Any], keys: Any) -> Dict[str, Any]:
    """The parts of ``payload`` a payload selector names; a dotted key keeps its nesting."""
    out: Dict[str, Any] = {}
    for key in keys:
        value = _payload_value(payload, key)
        if value is _MISSING:
            continue
        parts = str(key).split('.')
        target = out
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value
    return out


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
            "ROCKETRIDE": {
                "uuid1": PointStruct(id="uuid1", vector=[0.1, ...], payload={...}),
            }
        }

    Behaviour mirrored from the real server (the Vector Explorer suites pair these
    with the same assertions against a live Qdrant):
        1. Upsert replaces a point with the same id; deletes really delete.
        2. scroll() returns points ordered by id (numbers first, then UUIDs);
           ``offset`` is a point id to start from (inclusive) and the second
           return value is the id of the next point, not a position.
        3. Filters support must / should / must_not, nested filters,
           MatchValue / MatchAny / MatchText / MatchExcept, Range, HasIdCondition,
           IsNullCondition and IsEmptyCondition.
        4. Payloads are stored serialized (plain dicts), as a server stores JSON.
        5. set_payload() overwrites top-level keys unless ``key`` names a nested
           object to merge into (overwriting ``meta`` wholesale is what the real
           server does too).
        6. query_points() scores by the collection's distance; a ``SampleQuery``
           draws random points; a ``RecommendQuery`` recommends from positive and
           negative examples (point ids or raw vectors) by ``average_vector``,
           ``best_score`` or ``sum_scores`` and never returns an example point.
        7. facet() needs a keyword or integer index on its key (the server answers
           400 "No appropriate index for faceting" otherwise).
        8. A scroll ``offset`` must be a point id (unsigned integer or UUID);
           anything else is a 400, as on the server.
        9. A payload selector list may name nested keys (``['meta.objectId']``).
    """

    # -------------------------------------------------------------------------
    # Class-Level Storage (Shared Across All Instances)
    # -------------------------------------------------------------------------

    _collections: Dict[str, Dict[str, Any]] = {}  # Collection metadata
    _points: Dict[str, Dict[Any, PointStruct]] = {}  # Collection name -> {point id: point}

    # Call counters, so tests can assert which native calls a code path made.
    calls: Dict[str, int] = {}

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
        **kwargs,
    ):
        """
        Initialize a mock Qdrant client connection.

        All parameters are accepted for API compatibility but ignored, since
        no real server is contacted.
        """
        self.host = host
        self.port = port
        self.url = url

    @classmethod
    def _count_call(cls, name: str) -> None:
        cls.calls[name] = cls.calls.get(name, 0) + 1

    def _store(self, collection_name: str) -> Dict[Any, PointStruct]:
        if collection_name not in QdrantClient._collections:
            raise Exception(f'Collection {collection_name} not found')
        return QdrantClient._points.setdefault(collection_name, {})

    def _sorted_points(self, collection_name: str, flt: Optional[Filter] = None) -> List[PointStruct]:
        points = sorted(self._store(collection_name).values(), key=lambda p: _id_sort_key(p.id))
        return [p for p in points if _filter_matches(p, flt)]

    def _distance(self, collection_name: str) -> str:
        cfg = QdrantClient._collections[collection_name].get('vectors_config')
        distance = getattr(cfg, 'distance', 'Cosine') or 'Cosine'
        return str(getattr(distance, 'value', distance))

    @staticmethod
    def _record(point: PointStruct, with_payload: Any, with_vectors: Any) -> Record:
        payload = point.payload if with_payload else None
        if isinstance(with_payload, (list, tuple)):
            payload = _select_payload(point.payload or {}, with_payload)
        return Record(id=point.id, payload=copy.deepcopy(payload), vector=list(point.vector) if with_vectors else None)

    def _select(self, collection_name: str, selector: Any) -> List[PointStruct]:
        """Resolve a points selector (Filter, FilterSelector, PointIdsList or id list)."""
        if isinstance(selector, models.FilterSelector):
            selector = selector.filter
        if isinstance(selector, Filter):
            return self._sorted_points(collection_name, selector)
        if isinstance(selector, models.PointIdsList):
            selector = selector.points
        ids = set(selector or [])
        return [p for p in self._store(collection_name).values() if p.id in ids]

    def _upsert(self, collection_name: str, points: List[PointStruct]) -> None:
        store = QdrantClient._points.setdefault(collection_name, {})
        for p in points:
            store[p.id] = PointStruct(
                id=p.id, vector=list(p.vector), payload=copy.deepcopy(_serialize_payload(p.payload) or {})
            )

    # -------------------------------------------------------------------------
    # Server / collection management
    # -------------------------------------------------------------------------

    def info(self) -> Any:
        """Return the (mock) server version."""
        return models.VersionInfo()

    def get_collections(self) -> Any:
        """List collections (shape: ``.collections[i].name``)."""
        return SimpleNamespace(collections=[SimpleNamespace(name=n) for n in QdrantClient._collections])

    def collection_exists(self, collection_name: str) -> bool:
        """Return True if the collection exists."""
        return collection_name in QdrantClient._collections

    def create_collection(self, collection_name: str, vectors_config: Any = None, **kwargs) -> None:
        """Create (or recreate) a collection."""
        QdrantClient._collections[collection_name] = {'vectors_config': vectors_config, 'payload_schema': {}}
        QdrantClient._points[collection_name] = {}

    def delete_collection(self, collection_name: str, **kwargs) -> bool:
        """Drop a collection and its points."""
        QdrantClient._collections.pop(collection_name, None)
        QdrantClient._points.pop(collection_name, None)
        return True

    def get_collection(self, collection_name: str) -> CollectionInfo:
        """Return collection info (points count, payload indexes, vector and HNSW config)."""
        if collection_name not in QdrantClient._collections:
            raise Exception(f'Collection {collection_name} not found')
        count = len(QdrantClient._points.get(collection_name, {}))
        return CollectionInfo(
            vectors_count=count,
            points_count=count,
            payload_schema=dict(QdrantClient._collections[collection_name].get('payload_schema', {})),
            config=CollectionConfig(
                params=CollectionParams(vectors=QdrantClient._collections[collection_name].get('vectors_config')),
                hnsw_config=HnswConfig(),
            ),
        )

    def create_payload_index(
        self, collection_name: str, field_name: str, field_type: str = None, field_schema: Any = None, **kwargs
    ) -> None:
        """Record a payload index (no index is built; filters scan)."""
        if collection_name in QdrantClient._collections:
            QdrantClient._collections[collection_name]['payload_schema'][field_name] = field_type or field_schema

    # -------------------------------------------------------------------------
    # Reads
    # -------------------------------------------------------------------------

    def scroll(
        self,
        collection_name: str,
        scroll_filter: Filter = None,
        limit: int = 10,
        order_by: Any = None,
        offset: Any = None,
        with_payload: Any = True,
        with_vectors: Any = False,
        **kwargs,
    ) -> Tuple[List[Record], Optional[Any]]:
        """
        Scroll through matching points.

        Without ``order_by``: ordered by id; ``offset`` is the point id to start
        from (inclusive) and the next-page value is the id of the next point.
        With ``order_by``: ordered by that payload key (ties by id), no next page
        (as the real server does), optionally starting at ``start_from``.
        """
        QdrantClient._count_call('scroll')
        if offset is not None and not _is_point_id(offset):
            raise Exception(f'Bad request: Format error in JSON body: value {offset} is not a valid point ID')
        limit = 10 if limit is None else int(limit)
        points = self._sorted_points(collection_name, scroll_filter)

        if order_by is not None:
            if isinstance(order_by, str):
                order_by = models.OrderBy(key=order_by)
            if order_by.key not in QdrantClient._collections[collection_name].get('payload_schema', {}):
                raise Exception(f'Bad request: No range index for `order_by` key: {order_by.key}')
            if offset is not None:
                raise Exception('Bad request: Offset is not supported with order_by')
            keyed = [(p, _payload_value(p.payload, order_by.key)) for p in points]
            keyed = [(p, v) for p, v in keyed if isinstance(v, (int, float)) and not isinstance(v, bool)]
            descending = order_by.direction == models.Direction.DESC
            if order_by.start_from is not None:
                start = order_by.start_from
                keyed = [(p, v) for p, v in keyed if (v <= start if descending else v >= start)]
            keyed.sort(key=lambda pv: (pv[1], _id_sort_key(pv[0].id)), reverse=descending)
            return [self._record(p, with_payload, with_vectors) for p, _ in keyed[:limit]], None

        if offset is not None:
            start = _id_sort_key(offset)
            points = [p for p in points if _id_sort_key(p.id) >= start]
        page = points[:limit]
        next_offset = points[limit].id if len(points) > limit else None
        return [self._record(p, with_payload, with_vectors) for p in page], next_offset

    def retrieve(
        self,
        collection_name: str,
        ids: List[Any],
        with_payload: Any = True,
        with_vectors: Any = False,
        **kwargs,
    ) -> List[Record]:
        """Return the stored points with these ids (unknown ids are skipped)."""
        QdrantClient._count_call('retrieve')
        store = self._store(collection_name)
        return [self._record(store[i], with_payload, with_vectors) for i in dict.fromkeys(ids) if i in store]

    def count(self, collection_name: str, count_filter: Filter = None, exact: bool = True, **kwargs) -> Any:
        """Count the points matching ``count_filter``."""
        QdrantClient._count_call('count')
        return models.CountResult(count=len(self._sorted_points(collection_name, count_filter)))

    def facet(
        self,
        collection_name: str,
        key: str,
        facet_filter: Filter = None,
        limit: int = 10,
        exact: bool = False,
        **kwargs,
    ) -> Any:
        """Count matching points per distinct value of ``key`` (highest counts first)."""
        QdrantClient._count_call('facet')
        schema = QdrantClient._collections.get(collection_name, {}).get('payload_schema', {})
        if _index_kind(schema.get(key)) not in ('keyword', 'integer', 'uuid'):
            raise Exception(f'Bad request: Wrong input: No appropriate index for faceting: `{key}`')
        counts: Dict[Any, int] = {}
        for p in self._sorted_points(collection_name, facet_filter):
            value = _payload_value(p.payload, key)
            if value is _MISSING or value is None:
                continue
            for v in value if isinstance(value, list) else [value]:
                counts[v] = counts.get(v, 0) + 1
        hits = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[: int(limit)]
        return models.FacetResponse(hits=[models.FacetValueHit(value=v, count=c) for v, c in hits])

    def query_points(
        self,
        collection_name: str,
        query: Any = None,
        query_filter: Filter = None,
        with_vectors: Any = False,
        with_payload: Any = True,
        limit: int = 10,
        score_threshold: float = None,
        search_params: Any = None,
        **kwargs,
    ) -> QueryResult:
        """
        Score matching points against ``query`` by the collection's distance.

        A ``SampleQuery`` returns ``limit`` random matching points instead; a
        ``RecommendQuery`` recommends from examples (see :meth:`_recommend`).
        """
        QdrantClient._count_call('query_points')
        points = self._sorted_points(collection_name, query_filter)
        limit = 10 if limit is None else int(limit)

        if isinstance(query, models.RecommendQuery):
            scored = self._recommend(collection_name, query.recommend, points)
            if score_threshold is not None:
                lower = (
                    _lower_is_better(self._distance(collection_name))
                    and _strategy_of(query.recommend) == 'average_vector'
                )
                scored = [ps for ps in scored if (ps[1] <= score_threshold if lower else ps[1] >= score_threshold)]
            return QueryResult(
                points=[
                    ScoredPoint(
                        id=p.id,
                        score=s,
                        payload=copy.deepcopy(p.payload) if with_payload else None,
                        vector=list(p.vector) if with_vectors else None,
                    )
                    for p, s in scored[:limit]
                ]
            )

        if isinstance(query, models.SampleQuery):
            chosen = random.sample(points, min(limit, len(points)))
            return QueryResult(
                points=[
                    ScoredPoint(
                        id=p.id,
                        score=0.0,
                        payload=copy.deepcopy(p.payload) if with_payload else None,
                        vector=list(p.vector) if with_vectors else None,
                    )
                    for p in chosen
                ]
            )

        distance = self._distance(collection_name)
        scored = [(p, _similarity(distance, list(query or []), p.vector)) for p in points]
        scored.sort(key=lambda ps: ps[1], reverse=not _lower_is_better(distance))
        if score_threshold is not None:
            if _lower_is_better(distance):
                scored = [ps for ps in scored if ps[1] <= score_threshold]
            else:
                scored = [ps for ps in scored if ps[1] >= score_threshold]
        return QueryResult(
            points=[
                ScoredPoint(
                    id=p.id,
                    score=s,
                    payload=copy.deepcopy(p.payload) if with_payload else None,
                    vector=list(p.vector) if with_vectors else None,
                )
                for p, s in scored[:limit]
            ]
        )

    def _example_vectors(
        self, collection_name: str, examples: Optional[List[Any]]
    ) -> Tuple[List[Tuple[List[float], bool]], set]:
        """The vectors of a recommendation's examples on one side, and the point ids among them.

        An example is a point id (looked up whatever the query's filter says, as the
        server does; an unknown id is a 404) or a raw vector. Each vector comes with
        whether it is a stored point's (True) or a raw vector of the query (False).
        """
        store = self._store(collection_name)
        vectors: List[Tuple[List[float], bool]] = []
        ids: set = set()
        for example in examples or []:
            if isinstance(example, (list, tuple)):
                vectors.append(([float(v) for v in example], False))
                continue
            if example not in store:
                raise Exception(f'Not found: No point with id {example} found')
            vectors.append((list(store[example].vector), True))
            ids.add(example)
        return vectors, ids

    def _recommend(
        self, collection_name: str, recommend: 'models.RecommendInput', candidates: List[PointStruct]
    ) -> List[Tuple[PointStruct, float]]:
        """
        Score ``candidates`` for a recommendation, best first, never returning an example point.

        Mirrors a Qdrant 1.17 server (checked against one):

        * ``average_vector`` (the default) searches with
          ``avg_positive + avg_positive - avg_negative`` (``avg_positive`` without
          negatives). On a Cosine collection the server stores unit vectors, so a
          stored point counts at unit length, while a raw vector given as an example
          is averaged as given; on Dot and Euclid every example is averaged as given.
          No positive example is a 400.
        * ``best_score`` measures each candidate against every example and keeps
          its best positive and best negative similarity: ``sigmoid(best_positive)``
          when that is the larger, else ``-sigmoid(best_negative)``, with
          ``sigmoid(x) = 0.5 * (1 + x / (1 + |x|))``. Negatives alone are allowed.
        * ``sum_scores`` adds the positive similarities and subtracts the negative ones.

        For ``best_score`` and ``sum_scores`` the similarity on Euclid is the negated
        squared distance (the score a server hands to ``sigmoid``, checked for
        ``best_score``) and on Manhattan the negated distance (not checked against a
        server), so higher stays closer.
        """
        distance = self._distance(collection_name)
        strategy = _strategy_of(recommend)
        positive_examples, positive_ids = self._example_vectors(collection_name, recommend.positive)
        negative_examples, negative_ids = self._example_vectors(collection_name, recommend.negative)
        positives = [vector for vector, _stored in positive_examples]
        negatives = [vector for vector, _stored in negative_examples]
        examples = positive_ids | negative_ids
        candidates = [p for p in candidates if p.id not in examples]

        if strategy == 'average_vector':
            if not positives:
                raise Exception(
                    'Bad request: Wrong input: Positive vectors should not be empty with `average` strategy'
                )

            def prepared(vector: List[float], stored: bool) -> List[float]:
                if distance != 'Cosine' or not stored:
                    return list(vector)
                norm = sum(x * x for x in vector) ** 0.5
                return [x / norm for x in vector] if norm else list(vector)

            def mean(side: List[Tuple[List[float], bool]]) -> List[float]:
                rows = [prepared(vector, stored) for vector, stored in side]
                return [sum(column) / len(rows) for column in zip(*rows)]

            avg_positive = mean(positive_examples)
            query = avg_positive
            if negatives:
                avg_negative = mean(negative_examples)
                query = [p + p - n for p, n in zip(avg_positive, avg_negative)]
            scored = [(p, _similarity(distance, query, p.vector)) for p in candidates]
            scored.sort(key=lambda ps: ps[1], reverse=not _lower_is_better(distance))
            return scored

        if strategy not in ('best_score', 'sum_scores'):
            raise Exception(f'Bad request: Format error in JSON body: unknown variant `{strategy}`')
        if not positives and not negatives:
            raise Exception('Bad request: Wrong input: No positive or negative examples given')

        def sim(a: List[float], b: List[float]) -> float:
            value = _similarity(distance, a, b)
            if distance == 'Euclid':
                return -(value * value)
            return -value if _lower_is_better(distance) else value

        def sigmoid(x: float) -> float:
            return 0.5 * (1.0 + (x / (1.0 + abs(x))))

        scored = []
        for p in candidates:
            to_positive = [sim(p.vector, v) for v in positives]
            to_negative = [sim(p.vector, v) for v in negatives]
            if strategy == 'sum_scores':
                score = sum(to_positive) - sum(to_negative)
            else:
                best_positive = max(to_positive) if to_positive else float('-inf')
                best_negative = max(to_negative) if to_negative else float('-inf')
                score = sigmoid(best_positive) if best_positive > best_negative else -sigmoid(best_negative)
            scored.append((p, float(score)))
        scored.sort(key=lambda ps: ps[1], reverse=True)
        return scored

    def search_matrix_offsets(
        self,
        collection_name: str,
        query_filter: Filter = None,
        limit: int = 3,
        sample: int = 10,
        **kwargs,
    ) -> Any:
        """
        Nearest neighbours among a sample of the matching points, in coordinate form.

        Takes the first ``sample`` matching points (the real server samples
        randomly; with a ``has_id`` filter of ``sample`` ids both take them all)
        and lists each point's ``limit`` nearest others, never itself.
        """
        QdrantClient._count_call('search_matrix_offsets')
        points = self._sorted_points(collection_name, query_filter)[: int(sample)]
        distance = self._distance(collection_name)
        rows: List[int] = []
        cols: List[int] = []
        scores: List[float] = []
        for i, a in enumerate(points):
            others = [(j, _similarity(distance, a.vector, b.vector)) for j, b in enumerate(points) if j != i]
            others.sort(key=lambda js: js[1], reverse=not _lower_is_better(distance))
            for j, s in others[: int(limit)]:
                rows.append(i)
                cols.append(j)
                scores.append(s)
        return models.SearchMatrixOffsetsResponse(
            offsets_row=rows, offsets_col=cols, scores=scores, ids=[p.id for p in points]
        )

    # -------------------------------------------------------------------------
    # Writes
    # -------------------------------------------------------------------------

    def upsert(self, collection_name: str, points: Any, wait: bool = True, **kwargs) -> None:
        """Insert or replace points by id."""
        if isinstance(points, models.PointsList):
            points = points.points
        self._upsert(collection_name, list(points))

    def batch_update_points(self, collection_name: str, update_operations: List[Any], **kwargs) -> None:
        """Apply delete and upsert operations in order."""
        for op in update_operations:
            if isinstance(op, models.UpsertOperation):
                self._upsert(collection_name, list(op.upsert.points))
            elif isinstance(op, models.DeleteOperation):
                self.delete(collection_name, op.delete)

    def delete(self, collection_name: str, points_selector: Any, wait: bool = True, **kwargs) -> None:
        """Delete the selected points."""
        QdrantClient._count_call('delete')
        store = self._store(collection_name)
        for p in self._select(collection_name, points_selector):
            store.pop(p.id, None)

    def set_payload(
        self, collection_name: str, payload: dict, points: Any, key: Optional[str] = None, wait: bool = True, **kwargs
    ) -> None:
        """
        Set payload values on the selected points.

        Top-level keys are overwritten (a nested object is replaced whole);
        with ``key='meta'`` the values are merged into that nested object.
        """
        values = _serialize_payload(payload) or {}
        for p in self._select(collection_name, points):
            if key:
                target = p.payload.setdefault(key, {})
                target.update(copy.deepcopy(values))
            else:
                p.payload.update(copy.deepcopy(values))

    # -------------------------------------------------------------------------
    # Test Utilities
    # -------------------------------------------------------------------------

    @classmethod
    def reset(cls) -> None:
        """
        Reset all mock data and call counters.

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
        cls.calls = {}


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
