# =============================================================================
# RocketRide Engine
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

"""Per-driver adapters for :class:`~.normalize.GraphNormalizer`.

Each factory returns a function that recognises its driver's own objects and
says what they are; it returns ``None`` for anything else, which the
normalizer then handles generically. The driver package is imported only when
its factory is called, so this module stays importable without any driver.

Driver specifics and the documented policies (CONTRACT v1):

- **Neo4j** (driver 6.x): ``element_id`` is the id; ``Path.nodes`` is the
  traversal order while each ``Relationship.start_node/end_node`` is the
  stored direction (the driver's path hydration guarantees it). Temporals use
  the driver's ISO text (nanoseconds kept); a named zone is reported in
  ``zone``. ``Point`` and ``Duration`` are tuple subclasses, so they are
  matched here before the generic list rule. ``Vector`` becomes a plain list.
- **FalkorDB** (falkordb-py 1.x): integer ids as decimal strings; ``Edge``
  ``src_node``/``dest_node`` are the stored endpoints. A duration arrives as a
  ``relativedelta`` the client derived from a number of seconds; it is turned
  back into that exact length and written as an ISO day/time duration.
  Points arrive as plain ``{latitude, longitude}`` maps (the client erases the
  type) and stay plain maps; ``vectorf32`` values stay lists of numbers;
  datetimes arrive in UTC and are reported as ``datetime``.
- **Apache AGE**: the vendored agtype parser's ``Vertex``/``Edge``/``Path``
  objects. Graph ids are 64-bit and routinely exceed 2**53, so they are
  decimal strings. The empty label of an unlabelled vertex means no labels.
"""

from __future__ import annotations

import datetime as _dt

from typing import Any, Optional

from .normalize import (
    Adapter,
    Classified,
    NodeParts,
    PathParts,
    PlainParts,
    RelationshipParts,
    TagParts,
    iso_duration_from_timedelta,
    point_tag,
    temporal_tag,
    zone_name,
)


# ---------------------------------------------------------------------------
# Neo4j
# ---------------------------------------------------------------------------


def neo4j_adapter() -> Adapter:
    """Adapter for the ``neo4j`` Python driver (5.x/6.x object model)."""
    from neo4j import graph as neo_graph
    from neo4j import spatial as neo_spatial
    from neo4j import time as neo_time

    try:
        from neo4j.vector import Vector  # driver 6+
    except ImportError:  # pragma: no cover - older driver
        Vector = None  # noqa: N806

    def classify(value: Any) -> Optional[Classified]:
        if isinstance(value, neo_graph.Node):
            return NodeParts(value.element_id, list(value.labels), dict(value.items()))
        if isinstance(value, neo_graph.Relationship):
            start, end = value.start_node, value.end_node
            if start is None or end is None:
                raise ValueError('Neo4j relationship arrived without its endpoints')
            return RelationshipParts(
                value.element_id, value.type, start.element_id, end.element_id, dict(value.items())
            )
        if isinstance(value, neo_graph.Path):
            return PathParts(list(value.nodes), list(value.relationships))
        if isinstance(value, neo_spatial.Point):
            return TagParts(point_tag(value.srid, list(value)))
        if isinstance(value, neo_time.Duration):
            return TagParts(temporal_tag('duration', value.iso_format()))
        if isinstance(value, neo_time.DateTime):
            if value.tzinfo is None:
                return TagParts(temporal_tag('localdatetime', value.iso_format()))
            return TagParts(temporal_tag('datetime', value.iso_format(), zone_name(value.tzinfo)))
        if isinstance(value, neo_time.Date):
            return TagParts(temporal_tag('date', value.iso_format()))
        if isinstance(value, neo_time.Time):
            kind = 'localtime' if value.tzinfo is None else 'time'
            return TagParts(temporal_tag(kind, value.iso_format()))
        if Vector is not None and isinstance(value, Vector):
            return PlainParts(list(value.to_native()))
        return None

    return classify


# ---------------------------------------------------------------------------
# FalkorDB
# ---------------------------------------------------------------------------

_EPOCH = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)


def _falkordb_entity_id(endpoint: Any) -> str:
    # Edge endpoints are ids as parsed from a reply, or Node objects when an
    # Edge is built by hand.
    raw = getattr(endpoint, 'id', endpoint)
    if raw is None:
        raise ValueError('FalkorDB entity arrived without an id')
    return str(int(raw))


def falkordb_adapter() -> Adapter:
    """Adapter for the ``falkordb`` Python client (1.x object model)."""
    from falkordb import Edge, Node, Path

    try:
        from dateutil.relativedelta import relativedelta
    except ImportError:  # pragma: no cover - a falkordb dependency
        relativedelta = None

    def classify(value: Any) -> Optional[Classified]:
        if isinstance(value, Node):
            return NodeParts(_falkordb_entity_id(value), list(value.labels or []), dict(value.properties or {}))
        if isinstance(value, Edge):
            return RelationshipParts(
                _falkordb_entity_id(value),
                value.relation,
                _falkordb_entity_id(value.src_node),
                _falkordb_entity_id(value.dest_node),
                dict(value.properties or {}),
            )
        if isinstance(value, Path):
            return PathParts(list(value.nodes()), list(value.edges()))
        if relativedelta is not None and isinstance(value, relativedelta):
            # The client built this as relativedelta(epoch + seconds, epoch);
            # adding it back to the epoch recovers the stored length exactly.
            return TagParts(temporal_tag('duration', iso_duration_from_timedelta((_EPOCH + value) - _EPOCH)))
        return None

    return classify


# ---------------------------------------------------------------------------
# Apache AGE
# ---------------------------------------------------------------------------


def age_adapter() -> Adapter:
    """Adapter for values from :func:`ai.common.graph.age.decode.parse_agtype`."""
    from .age._agtype import Edge, Path, Vertex

    def classify(value: Any) -> Optional[Classified]:
        if isinstance(value, Vertex):
            labels = [value.label] if value.label else []
            return NodeParts(str(int(value.id)), labels, dict(value.properties or {}))
        if isinstance(value, Edge):
            return RelationshipParts(
                str(int(value.id)),
                value.label,
                str(int(value.start_id)),
                str(int(value.end_id)),
                dict(value.properties or {}),
            )
        if isinstance(value, Path):
            entities = list(value.entities or [])
            nodes, rels = entities[0::2], entities[1::2]
            if not all(isinstance(n, Vertex) for n in nodes) or not all(isinstance(r, Edge) for r in rels):
                raise ValueError('AGE path does not alternate vertices and edges')
            return PathParts(nodes, rels)
        return None

    return classify
