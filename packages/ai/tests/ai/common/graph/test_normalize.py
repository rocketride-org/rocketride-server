# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the shared graph value normalizer (no driver packages needed).

Apache AGE values come from real agtype text as psycopg2 returns it, parsed by
the vendored AGE parser; Neo4j and FalkorDB entities are covered with their real
driver objects in ``nodes/test/test_graph_drivers_full.py``.
"""

from __future__ import annotations

import datetime as dt
import json
import math

from decimal import Decimal

import pytest

from ai.common.graph.adapters import age_adapter
from ai.common.graph.age import parse_agtype
from ai.common.graph.normalize import (
    MAX_SAFE_INTEGER,
    GraphBudgetExceeded,
    GraphNormalizer,
    decode_graph_value,
    escape_key,
    iso_duration_from_timedelta,
    unescape_key,
)


def strict_json(value):
    """Serialize like the node does: strict JSON, then parse back."""
    return json.loads(json.dumps(value, allow_nan=False))


def assert_js_safe(value):
    """Every JSON number must survive JavaScript's JSON.parse unchanged."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, int):
        assert -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER, value
    elif isinstance(value, float):
        assert math.isfinite(value), value
    elif isinstance(value, list):
        for item in value:
            assert_js_safe(item)
    elif isinstance(value, dict):
        for item in value.values():
            assert_js_safe(item)
    else:  # pragma: no cover
        raise AssertionError(type(value))


# ---------------------------------------------------------------------------
# numbers
# ---------------------------------------------------------------------------


class TestNumbers:
    @pytest.mark.parametrize('value', [0, 1, -1, MAX_SAFE_INTEGER, -MAX_SAFE_INTEGER, 0.5, -2.25, 1e300])
    def test_safe_numbers_stay_numbers(self, value):
        assert GraphNormalizer().value(value) == value

    @pytest.mark.parametrize(
        'value,text',
        [
            (MAX_SAFE_INTEGER + 1, '9007199254740992'),
            (2**63 - 1, '9223372036854775807'),
            (-(2**63), '-9223372036854775808'),
            (float('nan'), 'NaN'),
            (float('inf'), 'Infinity'),
            (float('-inf'), '-Infinity'),
        ],
    )
    def test_unsafe_numbers_are_tagged_with_exact_text(self, value, text):
        assert GraphNormalizer().value(value) == {'@kind': 'number', 'value': text}

    @pytest.mark.parametrize(
        'value,expected',
        [
            (Decimal('3'), 3),
            (Decimal('3.000'), 3),
            (Decimal('1.5'), {'@kind': 'number', 'value': '1.5'}),
            (Decimal('0.10000000000000000001'), {'@kind': 'number', 'value': '0.10000000000000000001'}),
            (Decimal('123456789012345678901234567890'), {'@kind': 'number', 'value': '123456789012345678901234567890'}),
            (Decimal('NaN'), {'@kind': 'number', 'value': 'NaN'}),
        ],
    )
    def test_decimals_are_exact(self, value, expected):
        assert GraphNormalizer().value(value) == expected

    def test_booleans_are_not_numbers(self):
        assert GraphNormalizer().value(True) is True

    def test_output_is_strict_json_and_js_safe(self):
        out = GraphNormalizer().value([2**60, float('nan'), {'x': float('inf')}, Decimal('1e400')])
        assert_js_safe(strict_json(out))


# ---------------------------------------------------------------------------
# key escaping
# ---------------------------------------------------------------------------


class TestKeyEscaping:
    USER_MAP = {
        '@kind': 'node',
        '@@kind': 'already escaped',
        '@': 'just at',
        '': 'empty key',
        '_labels': ['not', 'metadata'],
        '_type': 'user value',
        'id': 'user id',
        'nested': {'@kind': 'relationship', 'deeper': [{'@x': 1}]},
    }

    def test_every_at_key_gains_exactly_one_at(self):
        out = GraphNormalizer().value(self.USER_MAP)
        assert set(out) == {'@@kind', '@@@kind', '@@', '', '_labels', '_type', 'id', 'nested'}
        assert out['nested'] == {'@@kind': 'relationship', 'deeper': [{'@@x': 1}]}
        assert '@kind' not in out, 'a user map must never look tagged'

    def test_round_trip_is_exact(self):
        out = strict_json(GraphNormalizer().value(self.USER_MAP))
        assert decode_graph_value(out) == self.USER_MAP

    @pytest.mark.parametrize('key', ['@kind', '@@kind', '@', 'plain', '', 'a@b'])
    def test_key_helpers_are_inverse(self, key):
        assert unescape_key(escape_key(key)) == key

    def test_property_maps_are_escaped_too(self):
        text = '{"id": 844424930131969, "label": "P", "properties": {"@kind": "node", "_labels": ["x"]}}::vertex'
        node = GraphNormalizer(age_adapter()).value(parse_agtype(text))
        assert node['properties'] == {'@@kind': 'node', '_labels': ['x']}
        assert decode_graph_value(strict_json(node))['properties'] == {'@kind': 'node', '_labels': ['x']}

    def test_non_string_keys_are_refused(self):
        with pytest.raises(ValueError, match='map key'):
            GraphNormalizer().value({1: 'x'})


# ---------------------------------------------------------------------------
# temporals (standard library types; FalkorDB returns these)
# ---------------------------------------------------------------------------


class TestTemporals:
    def test_date(self):
        assert GraphNormalizer().value(dt.date(2024, 2, 29)) == {
            '@kind': 'temporal',
            'type': 'date',
            'value': '2024-02-29',
        }

    def test_aware_datetime(self):
        value = dt.datetime(2024, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc)
        assert GraphNormalizer().value(value) == {
            '@kind': 'temporal',
            'type': 'datetime',
            'value': '2024-01-02T03:04:05+00:00',
        }

    def test_naive_datetime_is_local(self):
        value = dt.datetime(2024, 1, 2, 3, 4, 5, 6)
        assert GraphNormalizer().value(value)['type'] == 'localdatetime'

    def test_times(self):
        assert GraphNormalizer().value(dt.time(12, 30, 15))['type'] == 'localtime'
        aware = dt.time(12, 30, tzinfo=dt.timezone(dt.timedelta(hours=2)))
        assert GraphNormalizer().value(aware) == {'@kind': 'temporal', 'type': 'time', 'value': '12:30:00+02:00'}

    @pytest.mark.parametrize(
        'delta,iso',
        [
            (dt.timedelta(0), 'PT0S'),
            (dt.timedelta(days=40, hours=2), 'P40DT2H'),
            (dt.timedelta(seconds=7, microseconds=500000), 'PT7.5S'),
            (dt.timedelta(minutes=1, microseconds=1), 'PT1M0.000001S'),
            (dt.timedelta(days=-1), '-P1D'),
        ],
    )
    def test_durations_are_exact_iso(self, delta, iso):
        assert iso_duration_from_timedelta(delta) == iso


# ---------------------------------------------------------------------------
# AGE entities from real agtype text
# ---------------------------------------------------------------------------

# Captured from PostgreSQL 16 + Apache AGE 1.5.0 (psycopg2 returns agtype as text):
# CREATE (a)-[r:R]->(b:B {...}); MATCH p=(b:B)<-[r]-(a) RETURN p
AGE_PATH = (
    '[{"id": 1125899906842625, "label": "B", "properties": {"f": 0.1, "x": 1.5::numeric, "big": 9007199254740993, '
    '"nested": {"@kind": "node"}}}::vertex, {"id": 844424930131969, "label": "R", "end_id": 1125899906842625, '
    '"start_id": 281474976710657, "properties": {}}::edge, {"id": 281474976710657, "label": "", "properties": {}}'
    '::vertex]::path'
)


class TestAge:
    def test_reverse_traversal_keeps_traversal_order_and_stored_direction(self):
        normalizer = GraphNormalizer(age_adapter())
        path = normalizer.value(parse_agtype(AGE_PATH))
        assert [n['id'] for n in path['nodes']] == ['1125899906842625', '281474976710657']
        rel = path['relationships'][0]
        assert (rel['start'], rel['end']) == ('281474976710657', '1125899906842625')
        assert path['nodes'][1]['labels'] == []  # unlabelled vertex
        assert normalizer.elements == 3

    def test_ids_beyond_2_53_are_exact_strings(self):
        text = '{"id": 11821949021847553, "label": "L39", "properties": {"i": 39}}::vertex'
        node = strict_json(GraphNormalizer(age_adapter()).value(parse_agtype(text)))
        assert node['id'] == '11821949021847553'
        assert int(node['id']) > 2**53

    def test_property_values(self):
        props = GraphNormalizer(age_adapter()).value(parse_agtype(AGE_PATH))['nodes'][0]['properties']
        assert props == {
            'f': 0.1,
            'x': {'@kind': 'number', 'value': '1.5'},
            'big': {'@kind': 'number', 'value': '9007199254740993'},
            'nested': {'@@kind': 'node'},
        }

    def test_agtype_special_floats(self):
        values = [parse_agtype(t) for t in ('NaN', 'Infinity', '-Infinity', '1.0', '7')]
        assert GraphNormalizer(age_adapter()).row(values) == [
            {'@kind': 'number', 'value': 'NaN'},
            {'@kind': 'number', 'value': 'Infinity'},
            {'@kind': 'number', 'value': '-Infinity'},
            1.0,
            7,
        ]

    def test_duplicate_columns_stay_positional(self):
        row = GraphNormalizer(age_adapter()).row([parse_agtype('1'), parse_agtype('1'), parse_agtype('"a"')])
        assert row == [1, 1, 'a']

    def test_collect_of_vertices(self):
        text = '[{"id": 1, "label": "N", "properties": {}}::vertex, {"id": 2, "label": "N", "properties": {}}::vertex]'
        normalizer = GraphNormalizer(age_adapter())
        cell = normalizer.value(parse_agtype(text))
        assert [n['@kind'] for n in cell] == ['node', 'node']
        assert normalizer.elements == 2


# ---------------------------------------------------------------------------
# budgets, depth, unsupported types
# ---------------------------------------------------------------------------


class TestBudgets:
    def test_element_budget(self):
        text = '[' + ', '.join(f'{{"id": {i}, "label": "N", "properties": {{}}}}::vertex' for i in range(5)) + ']'
        normalizer = GraphNormalizer(age_adapter(), element_limit=4)
        with pytest.raises(GraphBudgetExceeded) as err:
            normalizer.value(parse_agtype(text))
        assert err.value.kind == 'elements' and err.value.limit == 4

    def test_value_budget_counts_scalars_and_containers(self):
        normalizer = GraphNormalizer(value_limit=10)
        normalizer.value(list(range(9)))  # 1 list + 9 ints
        assert normalizer.values == 10
        with pytest.raises(GraphBudgetExceeded) as err:
            normalizer.value(1)
        assert err.value.kind == 'values'

    def test_checkpoint_rollback(self):
        normalizer = GraphNormalizer(value_limit=5)
        mark = normalizer.checkpoint()
        with pytest.raises(GraphBudgetExceeded):
            normalizer.row([list(range(10))])
        normalizer.rollback(mark)
        assert normalizer.values == 0
        assert normalizer.row([1, 2]) == [1, 2]

    def test_depth_limit(self):
        value = 1
        for _ in range(70):
            value = [value]
        with pytest.raises(ValueError, match='nested more than 64'):
            GraphNormalizer().value(value)
        nested = 1
        for _ in range(60):
            nested = {'k': nested}
        GraphNormalizer().value(nested)

    def test_unknown_types_raise_with_type_name(self):
        class Opaque:
            def __repr__(self):
                return 'looks-like-data'

        with pytest.raises(ValueError, match='Opaque'):
            GraphNormalizer().value(Opaque())


class TestBytes:
    def test_small_bytes_are_inlined_as_base64(self):
        out = GraphNormalizer().value(bytearray(b'\x00\x01binary'))
        assert out == {'@kind': 'bytes', 'size': 8, 'base64': 'AAFiaW5hcnk='}

    def test_large_bytes_report_size_only(self):
        normalizer = GraphNormalizer()
        out = normalizer.value(b'x' * 70_000)
        assert out == {'@kind': 'bytes', 'size': 70_000, 'base64': None}
        assert normalizer.values == 1

    def test_inline_limit_boundary(self):
        assert GraphNormalizer().value(b'y' * 65_536)['base64'] is not None
        assert GraphNormalizer().value(b'y' * 65_537)['base64'] is None

    def test_bytes_inside_properties_do_not_fail_the_row(self):
        text = '{"id": 1, "label": "N", "properties": {"name": "n"}}::vertex'
        node = GraphNormalizer(age_adapter()).value(parse_agtype(text))
        node_with_blob = GraphNormalizer().value({'blob': memoryview(b'ab'), 'n': node['id']})
        assert node_with_blob == {'blob': {'@kind': 'bytes', 'size': 2, 'base64': 'YWI='}, 'n': '1'}
        assert decode_graph_value(strict_json(node_with_blob))['blob']['@kind'] == 'bytes'
