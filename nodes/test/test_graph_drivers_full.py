# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""One graph, three drivers, one JSON: the graph result contract with REAL driver objects.

Offline (no database), but it needs the real driver packages:

- Neo4j entities and typed values are built by the ``neo4j`` driver's own
  Bolt hydration (``HydrationHandler`` from the packstream structures a server
  sends), so ids, labels, endpoints and path direction come out exactly as a
  live session would deliver them.
- FalkorDB values are produced by the ``falkordb`` client's own reply parser
  (``query_result.parse_scalar``) from compact-protocol payloads.
- Apache AGE values are agtype text as psycopg2 returns it, parsed by the
  vendored AGE parser.

The same logical graph — parallel, reverse and self relationships, a path that
walks one relationship backwards, a collect() cell, @-keys and an integer
beyond 2**53 — must normalize to identical JSON on all three once each
driver's opaque ids are mapped to logical names.

Runs in the unmocked database pass (``nodes/test/mocks`` shadows ``falkordb``
in the mocked pass). Skips without the drivers unless ``RR_REQUIRE_DB_TESTS``
is set, in which case a missing driver fails the run.
"""

from __future__ import annotations

import importlib
import json
import math
import os
import sys
import types

from pathlib import Path

import pytest

_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))

# A mocked unit-test module may have left stub driver modules behind.
for _name in [n for n in sys.modules if n.split('.')[0] in ('neo4j', 'falkordb')]:
    if not getattr(sys.modules[_name], '__file__', None):
        del sys.modules[_name]

if _REQUIRED:
    import falkordb  # noqa: F401
    import neo4j
else:
    neo4j = pytest.importorskip('neo4j')
    pytest.importorskip('falkordb')
    pytest.importorskip('antlr4')

from falkordb import query_result as falkor_qr  # noqa: E402

# Driver versions this suite (and the graph-ui wire fixtures generated from it)
# was validated with. The node requirements pin these versions, and nodes/test
# gets them through the engine constraints.
VALIDATED_DRIVERS = {'neo4j': '6.3.1', 'falkordb': '1.7.0'}

# The neo4j driver offers no public way to build Node/Relationship/Path
# objects as a Bolt session hydrates them, so this suite uses the driver's
# private hydration API, isolated here. Its module path changed between
# releases (hydration.v2 up to 6.3, hydration.bolt.v2 from 6.4).
_BOLT_HYDRATION_MODULES = ('neo4j._codec.hydration.v2', 'neo4j._codec.hydration.bolt.v2')


def _bolt_hydration():
    """(HydrationHandler, Structure) from the installed neo4j driver, or a clear failure."""
    try:
        structure = importlib.import_module('neo4j._codec.packstream').Structure
        for name in _BOLT_HYDRATION_MODULES:
            try:
                return importlib.import_module(name).HydrationHandler, structure
            except ImportError:
                continue
    except (ImportError, AttributeError):
        pass
    message = (
        f'neo4j {getattr(neo4j, "__version__", "?")} moved its private Bolt hydration API; '
        f'update _bolt_hydration() in {Path(__file__).name} '
        f'(validated with neo4j {VALIDATED_DRIVERS["neo4j"]})'
    )
    if _REQUIRED:
        pytest.fail(message, pytrace=False)
    pytest.skip(message, allow_module_level=True)


HydrationHandler, Structure = _bolt_hydration()

_GRAPH_DIR = Path(__file__).resolve().parents[2] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'graph'


def _load_graph_modules():
    """Load the real normalizer/adapters/age package under a private name."""
    name = '_rr_test_graph_contract'
    pkg = types.ModuleType(name)
    pkg.__path__ = [str(_GRAPH_DIR)]
    sys.modules[name] = pkg
    return (
        importlib.import_module(f'{name}.normalize'),
        importlib.import_module(f'{name}.adapters'),
        importlib.import_module(f'{name}.age'),
    )


normalize, adapters, age = _load_graph_modules()
MAX_SAFE = normalize.MAX_SAFE_INTEGER


def strict_json(value):
    return json.loads(json.dumps(value, allow_nan=False))


def assert_js_safe(value):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, int):
        assert -MAX_SAFE <= value <= MAX_SAFE, value
    elif isinstance(value, float):
        assert math.isfinite(value), value
    elif isinstance(value, list):
        for item in value:
            assert_js_safe(item)
    else:
        for item in value.values():
            assert_js_safe(item)


def rename_ids(value, names):
    """Replace driver ids (and endpoints) with logical names for comparison."""
    if isinstance(value, list):
        return [rename_ids(v, names) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: rename_ids(v, names) for k, v in value.items()}
    if value.get('@kind') in ('node', 'relationship'):
        out['id'] = names[value['id']]
    if value.get('@kind') == 'relationship':
        out['start'] = names[value['start']]
        out['end'] = names[value['end']]
    return out


# ---------------------------------------------------------------------------
# The logical graph
# ---------------------------------------------------------------------------

BIG = 9007199254740993  # 2**53 + 1
META = {'@kind': 'node', '@@kind': 'already', '_labels': ['not', 'metadata'], '_type': 'user value', '': 'empty key'}
NODES = {
    'alice': ('Person', {'name': 'Alice', 'age': 37, 'score': 0.5, 'big': BIG, 'meta': META}),
    'bob': ('Person', {'name': 'Bob', 'age': 41}),
    'acme': ('Company', {'name': 'Acme'}),
}
RELS = {
    'k1': ('KNOWS', 'alice', 'bob', {'since': 2019}),
    'k2': ('KNOWS', 'alice', 'bob', {'since': 2021}),  # parallel to k1
    'kb': ('KNOWS', 'bob', 'alice', {'since': 2020}),  # reverse direction
    'likes': ('LIKES', 'alice', 'alice', {}),  # self loop
    'works': ('WORKS_AT', 'alice', 'acme', {'role': 'eng'}),
}
COLUMNS = ['a', 'r', 'm', 'friends', 'p', 'name']
# (a, r, m, collect-list, path?, name); path p = (bob)<-[k1]-(alice)-[works]->(acme)
ROWS = [
    ('alice', 'k1', 'bob', ['bob'], True, 'Alice'),
    ('alice', 'k2', 'bob', ['bob'], True, 'Alice'),
    ('alice', 'likes', 'alice', ['bob'], True, 'Alice'),
    ('alice', 'works', 'acme', ['bob'], True, 'Alice'),
    ('bob', 'kb', 'alice', ['alice'], False, 'Bob'),
]


# --- Neo4j: Bolt structures through the driver's hydration ------------------

NEO_IDS = {'alice': '4:gx:0', 'bob': '4:gx:1', 'acme': '4:gx:2'}
NEO_IDS.update({key: f'5:gx:{i}' for i, key in enumerate(RELS)})
NEO_LEGACY = {key: i for i, key in enumerate(list(NODES) + list(RELS))}


def neo4j_rows(extra_alice_labels=()):
    scope = HydrationHandler().new_hydration_scope()
    hydrate = scope.hydration_hooks[Structure]

    def node(key):
        label, props = NODES[key]
        labels = [label, *extra_alice_labels] if key == 'alice' else [label]
        return hydrate(Structure(b'N', NEO_LEGACY[key], labels, props, NEO_IDS[key]))

    def rel(key):
        rtype, start, end, props = RELS[key]
        return hydrate(
            Structure(
                b'R',
                NEO_LEGACY[key],
                NEO_LEGACY[start],
                NEO_LEGACY[end],
                rtype,
                props,
                NEO_IDS[key],
                NEO_IDS[start],
                NEO_IDS[end],
            )
        )

    def unbound(key):
        rtype, _start, _end, props = RELS[key]
        return hydrate(Structure(b'r', NEO_LEGACY[key], rtype, props, NEO_IDS[key]))

    # Path nodes are unique nodes; the sequence says: k1 walked backwards
    # (-1) to node 1 (alice), then works forwards (+2) to node 2 (acme).
    path = hydrate(
        Structure(b'P', [node('bob'), node('alice'), node('acme')], [unbound('k1'), unbound('works')], [-1, 1, 2, 2])
    )
    rows = []
    for a, r, m, friends, with_path, name in ROWS:
        rows.append([node(a), rel(r), node(m), [node(f) for f in friends], path if with_path else None, name])
    return rows


# --- FalkorDB: compact payloads through the client's own parser -------------

FK_LABELS = ['Person', 'Company', 'Employee']
FK_PROPS = ['name', 'age', 'score', 'big', 'meta', 'since', 'role']
FK_RELS = ['KNOWS', 'LIKES', 'WORKS_AT']
FK_NODE_IDS = {'alice': 0, 'bob': 1, 'acme': 2}
FK_REL_IDS = {key: i for i, key in enumerate(RELS)}
T = falkor_qr.ResultSetScalarTypes


class _FalkorSchema:
    def get_label(self, i):
        return FK_LABELS[i]

    def get_property(self, i):
        return FK_PROPS[i]

    def get_relation(self, i):
        return FK_RELS[i]


_FALKOR_GRAPH = types.SimpleNamespace(schema=_FalkorSchema())


def falkor_scalar(value):
    """Python value -> compact (type, payload) pair as FalkorDB sends it."""
    if value is None:
        return [T.VALUE_NULL.value, None]
    if isinstance(value, bool):
        return [T.VALUE_BOOLEAN.value, 'true' if value else 'false']
    if isinstance(value, int):
        return [T.VALUE_INTEGER.value, value]
    if isinstance(value, float):
        return [T.VALUE_DOUBLE.value, repr(value)]
    if isinstance(value, str):
        return [T.VALUE_STRING.value, value]
    if isinstance(value, list):
        return [T.VALUE_ARRAY.value, [falkor_scalar(v) for v in value]]
    if isinstance(value, dict):
        payload = []
        for k, v in value.items():
            payload.extend([k, falkor_scalar(v)])
        return [T.VALUE_MAP.value, payload]
    raise TypeError(value)


def falkor_props(props):
    return [[FK_PROPS.index(k), *falkor_scalar(v)] for k, v in props.items()]


def falkor_node(key, extra_labels=()):
    label, props = NODES[key]
    labels = [FK_LABELS.index(label)] + [FK_LABELS.index(x) for x in (extra_labels if key == 'alice' else ())]
    return [T.VALUE_NODE.value, [FK_NODE_IDS[key], labels, falkor_props(props)]]


def falkor_edge(key):
    rtype, start, end, props = RELS[key]
    return [
        T.VALUE_EDGE.value,
        [FK_REL_IDS[key], FK_RELS.index(rtype), FK_NODE_IDS[start], FK_NODE_IDS[end], falkor_props(props)],
    ]


def falkordb_rows(extra_alice_labels=()):
    def parse(compact):
        return falkor_qr.parse_scalar(compact, _FALKOR_GRAPH)

    def node(key):
        return parse(falkor_node(key, extra_alice_labels))

    path = parse(
        [
            T.VALUE_PATH.value,
            [
                [T.VALUE_ARRAY.value, [falkor_node(k, extra_alice_labels) for k in ('bob', 'alice', 'acme')]],
                [T.VALUE_ARRAY.value, [falkor_edge('k1'), falkor_edge('works')]],
            ],
        ]
    )
    rows = []
    for a, r, m, friends, with_path, name in ROWS:
        rows.append(
            [node(a), parse(falkor_edge(r)), node(m), [node(f) for f in friends], path if with_path else None, name]
        )
    return rows


# --- Apache AGE: agtype text -----------------------------------------------

AGE_IDS = {'alice': 844424930131969, 'bob': 844424930131970, 'acme': 11821949021847553}
AGE_IDS.update({'k1': 1125899906842625, 'k2': 1125899906842626, 'kb': 1125899906842627})
AGE_IDS.update({'likes': 1407374883553281, 'works': 11540474045136897})


def _agtype_map(props):
    parts = []
    for k, v in props.items():
        if k == 'big':
            parts.append(f'{json.dumps(k)}: {v}')  # agtype integers are exact 64-bit
        else:
            parts.append(f'{json.dumps(k)}: {json.dumps(v)}')
    return '{' + ', '.join(parts) + '}'


def age_vertex(key):
    label, props = NODES[key]
    return f'{{"id": {AGE_IDS[key]}, "label": "{label}", "properties": {_agtype_map(props)}}}::vertex'


def age_edge(key):
    rtype, start, end, props = RELS[key]
    return (
        f'{{"id": {AGE_IDS[key]}, "label": "{rtype}", "end_id": {AGE_IDS[end]}, '
        f'"start_id": {AGE_IDS[start]}, "properties": {_agtype_map(props)}}}::edge'
    )


def age_rows():
    path = f'[{age_vertex("bob")}, {age_edge("k1")}, {age_vertex("alice")}, {age_edge("works")}, {age_vertex("acme")}]::path'
    rows = []
    for a, r, m, friends, with_path, name in ROWS:
        cells = [age_vertex(a), age_edge(r), age_vertex(m), '[' + ', '.join(age_vertex(f) for f in friends) + ']']
        cells += [path if with_path else None, json.dumps(name)]
        rows.append([age.parse_agtype(c) for c in cells])
    return rows


def normalized(rows, adapter):
    normalizer = normalize.GraphNormalizer(adapter)
    out = strict_json([normalizer.row(row) for row in rows])
    assert_js_safe(out)
    return out, normalizer


# ---------------------------------------------------------------------------
# Cross-driver equality
# ---------------------------------------------------------------------------


class TestSameGraphSameJson:
    def test_all_three_drivers_agree(self):
        neo, _ = normalized(neo4j_rows(), adapters.neo4j_adapter())
        falkor, _ = normalized(falkordb_rows(), adapters.falkordb_adapter())
        age_out, _ = normalized(age_rows(), adapters.age_adapter())

        neo_names = {v: k for k, v in NEO_IDS.items()}
        falkor_names = {str(v): k for k, v in FK_NODE_IDS.items()}
        falkor_rel_names = {str(v): k for k, v in FK_REL_IDS.items()}
        age_names = {str(v): k for k, v in AGE_IDS.items()}

        neo_logical = rename_ids(neo, neo_names)
        age_logical = rename_ids(age_out, age_names)
        assert neo_logical == age_logical

        # FalkorDB numbers nodes and relationships separately, so ids overlap
        # across the two kinds; rename each kind with its own table.
        def rename_falkor(value):
            if isinstance(value, list):
                return [rename_falkor(v) for v in value]
            if not isinstance(value, dict):
                return value
            out = {k: rename_falkor(v) for k, v in value.items()}
            if value.get('@kind') == 'node':
                out['id'] = falkor_names[value['id']]
            if value.get('@kind') == 'relationship':
                out['id'] = falkor_rel_names[value['id']]
                out['start'] = falkor_names[value['start']]
                out['end'] = falkor_names[value['end']]
            return out

        assert rename_falkor(falkor) == neo_logical

    def test_the_shared_shape(self):
        rows, normalizer = normalized(age_rows(), adapters.age_adapter())
        names = {str(v): k for k, v in AGE_IDS.items()}
        logical = rename_ids(rows, names)
        alice = logical[0][0]
        assert alice['@kind'] == 'node' and alice['labels'] == ['Person']
        assert alice['properties']['big'] == {'@kind': 'number', 'value': str(BIG)}
        assert alice['properties']['meta'] == {
            '@@kind': 'node',
            '@@@kind': 'already',
            '_labels': ['not', 'metadata'],
            '_type': 'user value',
            '': 'empty key',
        }
        # parallel, reverse and self relationships keep their stored ends
        assert [(row[1]['id'], row[1]['start'], row[1]['end']) for row in logical] == [
            ('k1', 'alice', 'bob'),
            ('k2', 'alice', 'bob'),
            ('likes', 'alice', 'alice'),
            ('works', 'alice', 'acme'),
            ('kb', 'bob', 'alice'),
        ]
        path = logical[0][4]
        assert [n['id'] for n in path['nodes']] == ['bob', 'alice', 'acme']  # traversal order
        assert [(r['id'], r['start'], r['end']) for r in path['relationships']] == [
            ('k1', 'alice', 'bob'),  # walked backwards, stored alice -> bob
            ('works', 'alice', 'acme'),
        ]
        assert logical[4][4] is None
        assert [n['id'] for n in logical[0][3]] == ['bob']
        # elements: 3 entity cells + 1 collected node + 3 path nodes + 2 path rels per path row
        assert normalizer.elements == 4 * (3 + 1 + 5) + (3 + 1)
        assert decode_round_trip(rows) == rows

    def test_multi_labels_are_sorted_on_both_multi_label_drivers(self):
        neo, _ = normalized(neo4j_rows(extra_alice_labels=('Employee',)), adapters.neo4j_adapter())
        falkor, _ = normalized(falkordb_rows(extra_alice_labels=('Employee',)), adapters.falkordb_adapter())
        assert neo[0][0]['labels'] == falkor[0][0]['labels'] == ['Employee', 'Person']


def decode_round_trip(rows):
    """Decoding then re-encoding through the reference helpers is the identity."""
    decoded = normalize.decode_graph_value(rows)
    assert decoded[0][0]['properties']['meta'] == META
    return strict_json(rows)


# ---------------------------------------------------------------------------
# Neo4j typed values (driver hydration)
# ---------------------------------------------------------------------------


class TestNeo4jValues:
    def hydrate(self, *structures):
        scope = HydrationHandler().new_hydration_scope()
        hook = scope.hydration_hooks[Structure]
        return [hook(s) for s in structures]

    def test_temporals(self):
        values = self.hydrate(
            Structure(b'D', 19782),  # date: days since epoch
            Structure(b't', 45015123456789),  # local time, ns since midnight
            Structure(b'T', 45000000000000, 7200),  # time with offset
            Structure(b'd', 1704164645, 1),  # local datetime
            Structure(b'I', 1704164645, 123456789, 3600),  # offset datetime
            Structure(b'i', 1704164645, 1, 'Europe/Berlin'),  # zoned datetime
            Structure(b'E', 14, 3, 7, 5),  # duration: months, days, seconds, nanoseconds
        )
        out = strict_json(normalize.GraphNormalizer(adapters.neo4j_adapter()).row(values))
        assert out == [
            {'@kind': 'temporal', 'type': 'date', 'value': '2024-02-29'},
            {'@kind': 'temporal', 'type': 'localtime', 'value': '12:30:15.123456789'},
            {'@kind': 'temporal', 'type': 'time', 'value': '12:30:00.000000000+02:00'},
            {'@kind': 'temporal', 'type': 'localdatetime', 'value': '2024-01-02T03:04:05.000000001'},
            {'@kind': 'temporal', 'type': 'datetime', 'value': '2024-01-02T04:04:05.123456789+01:00'},
            {
                '@kind': 'temporal',
                'type': 'datetime',
                'value': '2024-01-02T04:04:05.000000001+01:00',
                'zone': 'Europe/Berlin',
            },
            {'@kind': 'temporal', 'type': 'duration', 'value': 'P1Y2M3DT7.000000005S'},
        ]

    def test_points_are_tagged_not_lists(self):
        values = self.hydrate(
            Structure(b'X', 7203, 1.5, 2.0),
            Structure(b'Y', 4979, 13.4, 52.5, 34.0),
            Structure(b'X', 4326, 13.405, 52.52),
        )
        out = strict_json(normalize.GraphNormalizer(adapters.neo4j_adapter()).row(values))
        assert out == [
            {'@kind': 'point', 'srid': 7203, 'coordinates': [1.5, 2.0]},
            {'@kind': 'point', 'srid': 4979, 'coordinates': [13.4, 52.5, 34.0]},
            {'@kind': 'point', 'srid': 4326, 'coordinates': [13.405, 52.52]},
        ]

    def test_large_integers_and_special_floats(self):
        out = strict_json(normalize.GraphNormalizer(adapters.neo4j_adapter()).row([2**62, float('nan'), -0.0]))
        assert out == [{'@kind': 'number', 'value': str(2**62)}, {'@kind': 'number', 'value': 'NaN'}, -0.0]

    def test_byte_array_properties_never_fail_the_query(self):
        small, large = bytearray(b'\x00\xffraw'), bytearray(b'z' * 100_000)
        (node,) = self.hydrate(Structure(b'N', 9, ['Doc'], {'small': small, 'large': large}, '4:gx:9'))
        out = strict_json(normalize.GraphNormalizer(adapters.neo4j_adapter()).value(node))
        assert out['properties'] == {
            'small': {'@kind': 'bytes', 'size': 5, 'base64': 'AP9yYXc='},
            'large': {'@kind': 'bytes', 'size': 100_000, 'base64': None},
        }

    def test_vector_is_a_plain_list(self):
        from neo4j.vector import Vector, VectorDType

        out = normalize.GraphNormalizer(adapters.neo4j_adapter()).value(Vector([1.0, 2.5], VectorDType.F32))
        assert out == [1.0, 2.5]


# ---------------------------------------------------------------------------
# FalkorDB typed values (client reply parser)
# ---------------------------------------------------------------------------


class TestFalkorDBValues:
    def parse(self, scalar_type, payload):
        return falkor_qr.parse_scalar([scalar_type.value, payload], _FALKOR_GRAPH)

    def test_typed_values(self):
        values = [
            self.parse(T.VALUE_DATE, 1709164800),  # 2024-02-29
            self.parse(T.VALUE_DATETIME, 1704164645),
            self.parse(T.VALUE_TIME, 45015),
            self.parse(T.VALUE_DURATION, 40 * 86400 + 2 * 3600),
            self.parse(T.VALUE_POINT, ['52.52', '13.405']),
            self.parse(T.VALUE_VECTORF32, ['1.0', '2.5']),
            self.parse(T.VALUE_INTEGER, BIG),
        ]
        out = strict_json(normalize.GraphNormalizer(adapters.falkordb_adapter()).row(values))
        assert out == [
            {'@kind': 'temporal', 'type': 'date', 'value': '2024-02-29'},
            {'@kind': 'temporal', 'type': 'datetime', 'value': '2024-01-02T03:04:05+00:00'},
            {'@kind': 'temporal', 'type': 'localtime', 'value': '12:30:15'},
            {'@kind': 'temporal', 'type': 'duration', 'value': 'P40DT2H'},
            {'latitude': 52.52, 'longitude': 13.405},  # documented: the client erases the point type
            [1.0, 2.5],
            {'@kind': 'number', 'value': str(BIG)},
        ]

    def test_duration_is_exact_even_where_the_client_shows_months(self):
        rd = self.parse(T.VALUE_DURATION, 40 * 86400 + 2 * 3600)
        assert rd.months == 1  # the client's calendar view (Jan 1 + 40 days)
        tag = normalize.GraphNormalizer(adapters.falkordb_adapter()).value(rd)
        assert tag['value'] == 'P40DT2H'
