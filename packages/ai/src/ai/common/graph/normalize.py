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

"""One result shape for every graph driver (the ``read_query`` contract).

Every graph driver returns nodes, relationships, paths and typed values in its
own Python shape. :class:`GraphNormalizer` turns a driver value into strict,
JSON-ready data that is identical for the same logical graph on Neo4j,
FalkorDB and Apache AGE. Each driver supplies a small adapter
(:mod:`.adapters`) that recognises its own objects; everything else — numbers,
strings, containers, standard-library temporals, key escaping, budgets — is
handled once, here.

Shape (only this module creates tags)::

    {'@kind': 'node', 'id': str, 'labels': [str, ...sorted], 'properties': {...}}
    {'@kind': 'relationship', 'id': str, 'type': str, 'start': str, 'end': str, 'properties': {...}}
    {'@kind': 'path', 'nodes': [node, ...], 'relationships': [relationship, ...]}
    {'@kind': 'temporal', 'type': 'date'|'time'|'localtime'|'datetime'|'localdatetime'|'duration',
     'value': ISO-8601 text[, 'zone': name]}
    {'@kind': 'point', 'srid': int, 'coordinates': [number, ...]}
    {'@kind': 'number', 'value': text}
    {'@kind': 'bytes', 'size': int, 'base64': text | None}   (CONTRACT v1.1)

Rules:

- **Ids are opaque strings** (Neo4j ``elementId``; FalkorDB/AGE integer ids in
  decimal). They are live handles, not durable keys.
- **Direction**: a path's ``nodes`` keep traversal order; every relationship's
  ``start``/``end`` keep the direction it is STORED in, even when the path
  walks it backwards. ``relationships[i]`` joins ``nodes[i]`` and ``nodes[i+1]``.
- **Numbers**: ints within ±(2**53 - 1) and finite floats stay JSON numbers;
  larger ints, NaN, ±Infinity and non-integral or unsafe ``Decimal`` values
  become ``{'@kind': 'number', 'value': text}`` with the exact text.
- **Tag reservation**: every key of a user map (or property map) that starts
  with ``@`` gains exactly one more leading ``@``, recursively, so a user map
  can never be mistaken for a tagged value. :func:`decode_graph_value` reverses
  it by stripping exactly one.
- **Budgets**: graph elements (each serialized node or relationship, path
  members included) and values (every scalar, container and tag) are counted
  per response; exceeding a budget raises :class:`GraphBudgetExceeded`, and
  nesting deeper than ``max_depth`` raises ``ValueError``.
- **Bytes** (e.g. a Neo4j ``byte[]`` property) become a ``bytes`` tag with the
  full content in base64 up to 64 KiB, and only the size above that, so one
  binary property never fails a whole browse query. A bytes value counts as
  one value toward the value budget.
- Anything not recognised raises ``ValueError`` naming the type — never a
  ``repr`` passed off as data.
"""

from __future__ import annotations

import base64
import datetime as _dt
import math

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional, Sequence, Union

MAX_SAFE_INTEGER = 2**53 - 1
DEFAULT_ELEMENT_LIMIT = 10_000
DEFAULT_VALUE_LIMIT = 500_000
DEFAULT_MAX_DEPTH = 64
# Binary values above this size are reported by size only.
BYTES_INLINE_LIMIT = 65_536

TAG = '@kind'


# ---------------------------------------------------------------------------
# What adapters hand back
# ---------------------------------------------------------------------------


@dataclass
class NodeParts:
    id: str
    labels: Sequence[str]
    properties: Dict[str, Any]


@dataclass
class RelationshipParts:
    id: str
    type: str
    start: str
    end: str
    properties: Dict[str, Any]


@dataclass
class PathParts:
    # Driver objects (or Parts) in traversal order; relationships[i] joins
    # nodes[i] and nodes[i + 1].
    nodes: Sequence[Any]
    relationships: Sequence[Any]


@dataclass
class TagParts:
    """A finished scalar tag (temporal/point/number), already JSON-ready."""

    value: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PlainParts:
    """Driver value that stands for a plain JSON value (e.g. a vector -> list)."""

    value: Any


Classified = Union[NodeParts, RelationshipParts, PathParts, TagParts, PlainParts]

# An adapter returns None for values that are not driver-specific.
Adapter = Callable[[Any], Optional[Classified]]


class GraphBudgetExceeded(ValueError):
    """A response budget ran out; ``kind`` is 'elements' or 'values'."""

    def __init__(self, kind: str, limit: int) -> None:
        self.kind = kind
        self.limit = limit
        what = 'graph elements' if kind == 'elements' else 'values'
        super().__init__(f'response exceeds {limit:,} {what}')


# ---------------------------------------------------------------------------
# Scalar helpers (shared by every driver)
# ---------------------------------------------------------------------------


def number_tag(text: str) -> Dict[str, Any]:
    return {TAG: 'number', 'value': text}


def temporal_tag(kind: str, value: str, zone: Optional[str] = None) -> Dict[str, Any]:
    tag: Dict[str, Any] = {TAG: 'temporal', 'type': kind, 'value': value}
    if zone:
        tag['zone'] = zone
    return tag


def point_tag(srid: int, coordinates: Sequence[float]) -> Dict[str, Any]:
    return {TAG: 'point', 'srid': int(srid), 'coordinates': [_finite_or_tag(float(c)) for c in coordinates]}


def _finite_or_tag(value: float) -> Any:
    if math.isnan(value):
        return number_tag('NaN')
    if math.isinf(value):
        return number_tag('Infinity' if value > 0 else '-Infinity')
    return value


def bytes_tag(value: Any) -> Dict[str, Any]:
    data = bytes(value)
    encoded = base64.b64encode(data).decode('ascii') if len(data) <= BYTES_INLINE_LIMIT else None
    return {TAG: 'bytes', 'size': len(data), 'base64': encoded}


def normalize_int(value: int) -> Any:
    if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
        return value
    return number_tag(str(value))


def normalize_decimal(value: Decimal) -> Any:
    if value.is_nan():
        return number_tag('NaN')
    if value.is_infinite():
        return number_tag('Infinity' if value > 0 else '-Infinity')
    if value == value.to_integral_value():
        as_int = int(value)
        if -MAX_SAFE_INTEGER <= as_int <= MAX_SAFE_INTEGER:
            return as_int
    # Exact text; never a lossy float().
    return number_tag(format(value, 'f') if value.as_tuple().exponent < 0 else str(value))


def iso_duration_from_timedelta(delta: _dt.timedelta) -> str:
    """Exact ISO-8601 duration (days + time) for a ``timedelta``.

    Months and years are never produced: a timedelta (and a FalkorDB duration,
    which is stored as a number of seconds) has no calendar component.
    A negative length is written with a leading ``-`` (the XML Schema form).
    """
    total_us = (delta.days * 86_400 + delta.seconds) * 1_000_000 + delta.microseconds
    sign = '-' if total_us < 0 else ''
    total_us = abs(total_us)
    days, rem_us = divmod(total_us, 86_400 * 1_000_000)
    hours, rem_us = divmod(rem_us, 3_600 * 1_000_000)
    minutes, rem_us = divmod(rem_us, 60 * 1_000_000)
    seconds, micros = divmod(rem_us, 1_000_000)
    out = f'{sign}P'
    if days:
        out += f'{days}D'
    time_part = ''
    if hours:
        time_part += f'{hours}H'
    if minutes:
        time_part += f'{minutes}M'
    if seconds or micros:
        time_part += f'{seconds}.{micros:06d}'.rstrip('0').rstrip('.') + 'S'
    if time_part:
        out += 'T' + time_part
    if out in ('P', '-P'):
        out = 'PT0S'
    return out


def zone_name(tzinfo: Any) -> Optional[str]:
    """Named time zone of ``tzinfo`` (pytz ``zone`` / zoneinfo ``key``), if any.

    UTC and plain offsets return None: the offset is already in the ISO value,
    so only a real zone id adds information.
    """
    name = getattr(tzinfo, 'zone', None) or getattr(tzinfo, 'key', None)
    return str(name) if name and str(name) != 'UTC' else None


def stdlib_temporal(value: Any) -> Optional[Dict[str, Any]]:
    """Tags for the standard library's temporal types (FalkorDB returns these)."""
    if isinstance(value, _dt.datetime):
        if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
            return temporal_tag('localdatetime', value.isoformat())
        return temporal_tag('datetime', value.isoformat(), zone_name(value.tzinfo))
    if isinstance(value, _dt.date):
        return temporal_tag('date', value.isoformat())
    if isinstance(value, _dt.time):
        if value.tzinfo is None or value.utcoffset() is None:
            return temporal_tag('localtime', value.isoformat())
        return temporal_tag('time', value.isoformat())
    if isinstance(value, _dt.timedelta):
        return temporal_tag('duration', iso_duration_from_timedelta(value))
    return None


def escape_key(key: str) -> str:
    """User-map key -> wire key: a leading ``@`` gains exactly one more."""
    return '@' + key if key.startswith('@') else key


def unescape_key(key: str) -> str:
    """Wire key -> user-map key: strip exactly one leading ``@``."""
    return key[1:] if key.startswith('@') else key


# ---------------------------------------------------------------------------
# The normalizer
# ---------------------------------------------------------------------------


class GraphNormalizer:
    """Convert driver values to the contract shape, counting response budgets.

    One instance per response: ``elements`` and ``values`` accumulate across
    calls. Use :meth:`checkpoint` / :meth:`rollback` to drop a row that tipped
    a budget so the response stays internally consistent.
    """

    def __init__(
        self,
        adapter: Optional[Adapter] = None,
        *,
        element_limit: int = DEFAULT_ELEMENT_LIMIT,
        value_limit: int = DEFAULT_VALUE_LIMIT,
        max_depth: int = DEFAULT_MAX_DEPTH,
    ) -> None:
        self.adapter = adapter
        self.element_limit = element_limit
        self.value_limit = value_limit
        self.max_depth = max_depth
        self.elements = 0
        self.values = 0

    # -- budget bookkeeping ------------------------------------------------

    def checkpoint(self) -> tuple:
        return (self.elements, self.values)

    def rollback(self, mark: tuple) -> None:
        self.elements, self.values = mark

    def _count_value(self) -> None:
        self.values += 1
        if self.values > self.value_limit:
            raise GraphBudgetExceeded('values', self.value_limit)

    def _count_element(self) -> None:
        self.elements += 1
        if self.elements > self.element_limit:
            raise GraphBudgetExceeded('elements', self.element_limit)

    # -- public entry points -----------------------------------------------

    def row(self, cells: Sequence[Any]) -> List[Any]:
        """Normalize one positional result row (duplicate columns stay separate)."""
        return [self.value(cell) for cell in cells]

    def value(self, value: Any, depth: int = 0) -> Any:
        if depth > self.max_depth:
            raise ValueError(f'value is nested more than {self.max_depth} levels deep')

        # Driver-specific objects first: some (Neo4j points and durations) are
        # tuple subclasses and must not fall into the generic list branch.
        if self.adapter is not None:
            classified = self.adapter(value)
            if classified is not None:
                return self._classified(classified, depth)

        self._count_value()
        if value is None or isinstance(value, (bool, str)):
            return value
        if isinstance(value, int):
            return normalize_int(value)
        if isinstance(value, float):
            return _finite_or_tag(value)
        if isinstance(value, Decimal):
            return normalize_decimal(value)
        if isinstance(value, (bytes, bytearray, memoryview)):
            return bytes_tag(value)
        if isinstance(value, dict):
            return self._user_map(value, depth)
        if isinstance(value, (list, tuple)):
            return [self.value(item, depth + 1) for item in value]
        tag = stdlib_temporal(value)
        if tag is not None:
            return tag
        raise ValueError(f'Unsupported graph value of type {type(value).__module__}.{type(value).__qualname__}')

    # -- internals -----------------------------------------------------------

    def _user_map(self, mapping: Dict[Any, Any], depth: int) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key, item in mapping.items():
            if not isinstance(key, str):
                raise ValueError(f'Unsupported map key of type {type(key).__name__}')
            out[escape_key(key)] = self.value(item, depth + 1)
        return out

    def _properties(self, properties: Optional[Dict[str, Any]], depth: int) -> Dict[str, Any]:
        self._count_value()
        return self._user_map(dict(properties or {}), depth)

    def _classified(self, classified: Classified, depth: int) -> Any:
        if isinstance(classified, NodeParts):
            self._count_element()
            self._count_value()
            return {
                TAG: 'node',
                'id': str(classified.id),
                'labels': sorted(str(label) for label in classified.labels),
                'properties': self._properties(classified.properties, depth + 1),
            }
        if isinstance(classified, RelationshipParts):
            self._count_element()
            self._count_value()
            return {
                TAG: 'relationship',
                'id': str(classified.id),
                'type': str(classified.type),
                'start': str(classified.start),
                'end': str(classified.end),
                'properties': self._properties(classified.properties, depth + 1),
            }
        if isinstance(classified, PathParts):
            self._count_value()
            nodes = [self._entity(n, NodeParts, depth + 1) for n in classified.nodes]
            rels = [self._entity(r, RelationshipParts, depth + 1) for r in classified.relationships]
            if len(nodes) != len(rels) + 1:
                raise ValueError(f'malformed path: {len(nodes)} nodes for {len(rels)} relationships')
            return {TAG: 'path', 'nodes': nodes, 'relationships': rels}
        if isinstance(classified, TagParts):
            self._count_value()
            return classified.value
        if isinstance(classified, PlainParts):
            # Re-enter without the adapter's opinion on the inner value.
            return self.value(classified.value, depth)
        raise ValueError(f'adapter returned an unknown classification {type(classified).__name__}')

    def _entity(self, item: Any, expected: type, depth: int) -> Dict[str, Any]:
        classified = item if isinstance(item, expected) else (self.adapter(item) if self.adapter else None)
        if not isinstance(classified, expected):
            raise ValueError(f'path member is not a {expected.__name__[:-5].lower()}: {type(item).__name__}')
        return self._classified(classified, depth)


# ---------------------------------------------------------------------------
# Decoding (reference implementation of the reverse mapping)
# ---------------------------------------------------------------------------


def decode_graph_value(value: Any) -> Any:
    """Reverse the user-map key escaping of a normalized value.

    Tagged values are returned with their tag intact; user maps (and property
    maps) have exactly one leading ``@`` stripped from each ``@``-key. This is
    the reference for client decoders and for round-trip tests.
    """
    if isinstance(value, list):
        return [decode_graph_value(v) for v in value]
    if not isinstance(value, dict):
        return value
    kind = value.get(TAG)
    if kind in ('node', 'relationship'):
        out = dict(value)
        out['properties'] = _decode_map(value['properties'])
        return out
    if kind == 'path':
        return {
            TAG: 'path',
            'nodes': [decode_graph_value(n) for n in value['nodes']],
            'relationships': [decode_graph_value(r) for r in value['relationships']],
        }
    if kind in ('temporal', 'point', 'number', 'bytes'):
        return dict(value)
    return _decode_map(value)


def _decode_map(mapping: Dict[str, Any]) -> Dict[str, Any]:
    return {unescape_key(k): decode_graph_value(v) for k, v in mapping.items()}
