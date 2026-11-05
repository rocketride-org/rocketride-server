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

"""Graph schema snapshots (``get_schema`` / ``refresh_schema``, schema version 2).

A driver reflects its graph into a :class:`SchemaBuilder`; the base publishes
the finished block as one immutable snapshot (a single reference swap, so a
reader sees the old schema or the new one, never half of each). Shape::

    {'version': 2,
     'labels': [{'name', 'properties': [{'name', 'types': [...]}], 'count'?, 'count_estimated'?}],
     'relationship_types': [{'type', 'endpoints': [{'start', 'end', 'observed'}],
                             'properties': [...], 'count'?, 'count_estimated'?}],
     'sampled': bool, 'truncated': bool,
     'refreshed_at': ISO-8601 UTC | None, 'source': 'startup' | 'refresh',
     'stale': bool, 'error': str | None, 'capable': bool}

Property types use one vocabulary for every engine: string, integer, float,
boolean, list, map, temporal, point (and 'unknown'); every observed type of a
property is kept. ``observed: true`` endpoints were seen on sampled data.
"""

from __future__ import annotations

import datetime as _dt

from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCHEMA_VERSION = 2
# Bounds on reflection work, shared by the three drivers.
SCHEMA_LABEL_LIMIT = 200
SCHEMA_REL_TYPE_LIMIT = 100
SCHEMA_SAMPLE_SIZE = 100
SCHEMA_REFRESH_BUDGET_MS = 60_000

TYPE_ORDER = ('string', 'integer', 'float', 'boolean', 'list', 'map', 'temporal', 'point', 'unknown')

# Neo4j's db.schema.*TypeProperties type names, plus valueType() spellings.
_NEO4J_TYPES = {
    'string': 'string',
    'long': 'integer',
    'integer': 'integer',
    'int': 'integer',
    'double': 'float',
    'float': 'float',
    'boolean': 'boolean',
    'date': 'temporal',
    'datetime': 'temporal',
    'localdatetime': 'temporal',
    'time': 'temporal',
    'localtime': 'temporal',
    'duration': 'temporal',
    'zoned datetime': 'temporal',
    'local datetime': 'temporal',
    'zoned time': 'temporal',
    'local time': 'temporal',
    'point': 'point',
    'map': 'map',
}


def value_type(value: Any) -> str:
    """Vocabulary type of one sampled Python value (any driver)."""
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, int):
        return 'integer'
    if isinstance(value, (float, Decimal)):
        return 'float'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, dict):
        # FalkorDB returns points as {latitude, longitude} maps.
        if set(value) == {'latitude', 'longitude'}:
            return 'point'
        return 'map'
    name = type(value).__name__
    module = type(value).__module__ or ''
    if module.startswith('neo4j.spatial') or name.endswith('Point'):
        return 'point'
    if module.startswith('neo4j.time') or name in ('relativedelta',):
        return 'temporal'
    if isinstance(value, (_dt.date, _dt.time, _dt.datetime, _dt.timedelta)):
        return 'temporal'
    if isinstance(value, (list, tuple)):
        return 'list'
    return 'unknown'


def neo4j_type_name(name: str) -> str:
    """Neo4j procedure/valueType type spelling -> vocabulary type."""
    text = str(name or '').strip()
    lowered = text.lower().replace(' not null', '').strip()
    if lowered.endswith('array') or lowered.startswith('list'):
        return 'list'
    return _NEO4J_TYPES.get(lowered, 'unknown')


def _sorted_types(types: Iterable[str]) -> List[str]:
    return sorted(set(types), key=lambda t: TYPE_ORDER.index(t) if t in TYPE_ORDER else len(TYPE_ORDER))


class SchemaBuilder:
    """Accumulates what a driver observes during one refresh."""

    def __init__(self) -> None:
        self._labels: Dict[str, Dict[str, Any]] = {}
        self._rels: Dict[str, Dict[str, Any]] = {}
        self.sampled = True
        self.truncated = False

    # -- labels ----------------------------------------------------------

    def label(self, name: str, *, count: Optional[int] = None, estimated: bool = False) -> None:
        entry = self._labels.setdefault(name, {'properties': {}, 'count': None, 'estimated': False})
        if count is not None:
            entry['count'] = int(count)
            entry['estimated'] = bool(estimated)

    def label_property(self, label: str, prop: str, kind: str) -> None:
        self.label(label)
        self._labels[label]['properties'].setdefault(str(prop), set()).add(kind)

    def sample_label_properties(self, label: str, properties: Optional[Dict[str, Any]]) -> None:
        for key, value in (properties or {}).items():
            if value is not None:
                self.label_property(label, key, value_type(value))

    # -- relationship types ---------------------------------------------

    def rel_type(self, name: str, *, count: Optional[int] = None, estimated: bool = False) -> None:
        entry = self._rels.setdefault(name, {'properties': {}, 'endpoints': {}, 'count': None, 'estimated': False})
        if count is not None:
            entry['count'] = int(count)
            entry['estimated'] = bool(estimated)

    def rel_property(self, rel: str, prop: str, kind: str) -> None:
        self.rel_type(rel)
        self._rels[rel]['properties'].setdefault(str(prop), set()).add(kind)

    def sample_rel_properties(self, rel: str, properties: Optional[Dict[str, Any]]) -> None:
        for key, value in (properties or {}).items():
            if value is not None:
                self.rel_property(rel, key, value_type(value))

    def endpoint(self, rel: str, start: str, end: str, *, observed: bool = True) -> None:
        self.rel_type(rel)
        key = (str(start), str(end))
        endpoints = self._rels[rel]['endpoints']
        endpoints[key] = endpoints.get(key, False) or observed

    # -- output ------------------------------------------------------------

    def block(self, *, source: str, refreshed_at: Optional[str] = None) -> Dict[str, Any]:
        def props(table: Dict[str, set]) -> List[Dict[str, Any]]:
            return [{'name': name, 'types': _sorted_types(kinds)} for name, kinds in sorted(table.items())]

        labels = []
        for name in sorted(self._labels):
            entry = self._labels[name]
            item: Dict[str, Any] = {'name': name, 'properties': props(entry['properties'])}
            if entry['count'] is not None:
                item['count'] = entry['count']
                item['count_estimated'] = entry['estimated']
            labels.append(item)
        rels = []
        for name in sorted(self._rels):
            entry = self._rels[name]
            item = {
                'type': name,
                'endpoints': [
                    {'start': start, 'end': end, 'observed': observed}
                    for (start, end), observed in sorted(entry['endpoints'].items())
                ],
                'properties': props(entry['properties']),
            }
            if entry['count'] is not None:
                item['count'] = entry['count']
                item['count_estimated'] = entry['estimated']
            rels.append(item)
        return {
            'version': SCHEMA_VERSION,
            'labels': labels,
            'relationship_types': rels,
            'sampled': self.sampled,
            'truncated': self.truncated,
            'refreshed_at': refreshed_at or utc_now(),
            'source': source,
            'stale': False,
            'error': None,
            'capable': True,
        }


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def empty_block(*, source: str, error: Optional[str], capable: bool = True) -> Dict[str, Any]:
    """A block for a node whose schema never reflected successfully."""
    return {
        'version': SCHEMA_VERSION,
        'labels': [],
        'relationship_types': [],
        'sampled': False,
        'truncated': False,
        'refreshed_at': None,
        'source': source,
        'stale': False,
        'error': error,
        'capable': capable,
    }


def legacy_from_block(block: Dict[str, Any]) -> Dict[str, Any]:
    """The pre-v2 ``graph_schema`` the LLM prompt and legacy ``get_schema`` keys use."""
    nodes: Dict[str, List[Tuple[str, str]]] = {}
    for label in block.get('labels') or []:
        nodes[label['name']] = [(p['name'], p['types'][0] if p['types'] else 'unknown') for p in label['properties']]
    relationships: List[Dict[str, str]] = []
    for rel in block.get('relationship_types') or []:
        if rel['endpoints']:
            for ep in rel['endpoints']:
                relationships.append({'type': rel['type'], 'start': ep['start'], 'end': ep['end']})
        else:
            relationships.append({'type': rel['type'], 'start': '', 'end': ''})
    return {'nodes': nodes, 'relationships': relationships}
