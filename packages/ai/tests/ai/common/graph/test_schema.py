# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Schema v2 snapshots, refresh_schema and dialect in the shared graph base (fake driver)."""

from __future__ import annotations

import datetime as dt
import threading
import time

from decimal import Decimal

import pytest

from ai.common.graph import graph_global_base
from ai.common.graph.graph_errors import GraphToolError
from ai.common.graph.graph_global_base import GraphGlobalBase
from ai.common.graph.graph_instance_base import GraphInstanceBase
from ai.common.graph.schema import (
    SchemaBuilder,
    empty_block,
    legacy_from_block,
    neo4j_type_name,
    value_type,
)


class FakeGlobal(GraphGlobalBase):
    def __init__(self, reflect):
        self.reflect = reflect
        self.allow_execute = False
        self.max_execute_rows = 25000
        self.glb = type('G', (), {'logicalType': 'fake'})()

    def _open_driver(self, config):
        pass

    def _close_driver(self):
        pass

    def _probe_connection(self, config):
        pass

    def _run_query(self, query, params=None, limit=None):
        return []

    def _run_query_raw(self, query):
        return {'rows': [], 'affected_rows': 0}

    def _validate_query(self, query):
        return True, ''

    def _reflect_schema_v2(self, builder, deadline):
        self.reflect(builder, deadline)

    def _engine_identity(self):
        return {
            'engine': {'name': 'Fake', 'version': '1.0', 'edition': None},
            'database': 'db1',
            'graph': 'g1',
            'read_boundary': 'ro_command',
            'read_boundary_verified': False,
            'shortest_path': False,
            'server_result_cap': 10000,
        }

    def _prompt_rules(self):
        return ['RULE-ONE', 'RULE-TWO']


class Inst(GraphInstanceBase):
    def _db_display_name(self):
        return 'Fake'

    def _db_dialect(self):
        return 'fake'


def people(builder, deadline):
    builder.label('Person', count=3)
    builder.sample_label_properties('Person', {'name': 'a', 'age': 1})
    builder.sample_label_properties(
        'Person', {'age': 'old', 'tags': ['x'], 'home': {'latitude': 1.0, 'longitude': 2.0}}
    )
    builder.label('Company', count=1)
    builder.rel_type('KNOWS', count=2)
    builder.endpoint('KNOWS', 'Person', 'Person')
    builder.endpoint('KNOWS', 'Employee', 'Person')
    builder.sample_rel_properties('KNOWS', {'since': 2019, 'w': 0.5})


def make(reflect=people):
    inst = Inst()
    inst.IGlobal = FakeGlobal(reflect)
    return inst


class TestVocabulary:
    @pytest.mark.parametrize(
        'value,kind',
        [
            ('s', 'string'),
            (1, 'integer'),
            (True, 'boolean'),
            (1.5, 'float'),
            (Decimal('1.5'), 'float'),
            ([1], 'list'),
            ({'a': 1}, 'map'),
            ({'latitude': 1.0, 'longitude': 2.0}, 'point'),
            (dt.date(2024, 1, 1), 'temporal'),
            (dt.datetime(2024, 1, 1), 'temporal'),
            (dt.timedelta(1), 'temporal'),
            (b'x', 'unknown'),
        ],
    )
    def test_value_type(self, value, kind):
        assert value_type(value) == kind

    @pytest.mark.parametrize(
        'name,kind',
        [
            ('String', 'string'),
            ('Long', 'integer'),
            ('Double', 'float'),
            ('Boolean', 'boolean'),
            ('DateTime', 'temporal'),
            ('LocalTime', 'temporal'),
            ('Duration', 'temporal'),
            ('Point', 'point'),
            ('StringArray', 'list'),
            ('LIST<INTEGER NOT NULL> NOT NULL', 'list'),
            ('INTEGER NOT NULL', 'integer'),
            ('ZONED DATETIME', 'temporal'),
            ('Mystery', 'unknown'),
        ],
    )
    def test_neo4j_type_names(self, name, kind):
        assert neo4j_type_name(name) == kind


class TestBlock:
    def test_block_shape_keeps_every_observed_type(self):
        builder = SchemaBuilder()
        people(builder, None)
        block = builder.block(source='refresh', refreshed_at='2026-10-04T00:00:00.000Z')
        assert block['version'] == 2 and block['source'] == 'refresh' and block['stale'] is False
        person = next(label for label in block['labels'] if label['name'] == 'Person')
        assert person['properties'] == [
            {'name': 'age', 'types': ['string', 'integer']},
            {'name': 'home', 'types': ['point']},
            {'name': 'name', 'types': ['string']},
            {'name': 'tags', 'types': ['list']},
        ]
        assert person['count'] == 3 and person['count_estimated'] is False
        knows = block['relationship_types'][0]
        assert knows['endpoints'] == [
            {'start': 'Employee', 'end': 'Person', 'observed': True},
            {'start': 'Person', 'end': 'Person', 'observed': True},
        ]
        assert knows['properties'] == [{'name': 'since', 'types': ['integer']}, {'name': 'w', 'types': ['float']}]

    def test_legacy_view(self):
        builder = SchemaBuilder()
        people(builder, None)
        legacy = legacy_from_block(builder.block(source='startup'))
        assert legacy['nodes']['Person'][0] == ('age', 'string')
        assert {(r['start'], r['end']) for r in legacy['relationships']} == {
            ('Person', 'Person'),
            ('Employee', 'Person'),
        }

    def test_empty_block_is_not_an_empty_graph(self):
        block = empty_block(source='startup', error='boom')
        assert block['refreshed_at'] is None and block['error'] == 'boom' and block['labels'] == []


class TestRefresh:
    def test_get_schema_carries_legacy_keys_and_block(self):
        inst = make()
        inst.IGlobal.refresh_schema_snapshot('startup')
        out = inst.get_schema({})
        assert set(out) == {'labels', 'nodes', 'relationships', 'schema'}
        assert out['labels'] == ['Company', 'Person']
        assert out['schema']['source'] == 'startup' and out['schema']['refreshed_at']

    def test_refresh_tool_republishes(self):
        state = {'extra': False}

        def reflect(builder, deadline):
            people(builder, deadline)
            if state['extra']:
                builder.label('Added', count=1)

        inst = make(reflect)
        inst.IGlobal.refresh_schema_snapshot('startup')
        state['extra'] = True
        out = inst.refresh_schema({})
        assert 'Added' in out['labels'] and out['schema']['source'] == 'refresh'

    def test_failure_keeps_last_good_snapshot_marked_stale(self):
        calls = {'n': 0}

        def reflect(builder, deadline):
            calls['n'] += 1
            if calls['n'] > 1:
                builder.label('Half')  # partial work must never be published
                raise TimeoutError('Query timed out')
            people(builder, deadline)

        inst = make(reflect)
        good = inst.IGlobal.refresh_schema_snapshot('startup')
        out = inst.refresh_schema({})
        block = out['schema']
        assert block['stale'] is True and 'Query timed out' in block['error']
        assert block['refreshed_at'] == good['refreshed_at']
        assert [label['name'] for label in block['labels']] == ['Company', 'Person']
        assert 'Half' not in out['labels']

    def test_failure_without_a_previous_snapshot_reports_an_error(self):
        def reflect(builder, deadline):
            raise RuntimeError('connection reset')

        inst = make(reflect)
        block = inst.IGlobal.refresh_schema_snapshot('startup')
        assert block['refreshed_at'] is None and block['error'].startswith('Schema refresh failed')
        assert inst.get_schema({})['schema']['error']

    def test_published_snapshot_cannot_be_mutated_by_callers(self):
        inst = make()
        inst.IGlobal.refresh_schema_snapshot('startup')
        inst.get_schema({})['schema']['labels'].clear()
        assert inst.get_schema({})['schema']['labels']

    def test_refreshes_are_serialized_and_readers_see_old_or_new(self):
        gate = threading.Event()
        entered = threading.Event()
        state = {'gen': 0}

        def reflect(builder, deadline):
            state['gen'] += 1
            gen = state['gen']
            builder.label(f'Gen{gen}A')
            if gen == 2:
                entered.set()
                gate.wait(5)
            builder.label(f'Gen{gen}B')

        inst = make(reflect)
        inst.IGlobal.refresh_schema_snapshot('startup')
        seen = []
        worker = threading.Thread(target=lambda: inst.refresh_schema({}))
        worker.start()
        entered.wait(5)
        for _ in range(50):
            seen.append(tuple(sorted(label['name'] for label in inst.get_schema({})['schema']['labels'])))
        second = threading.Thread(target=lambda: inst.refresh_schema({}))
        second.start()
        time.sleep(0.1)
        assert state['gen'] == 2  # the second refresh waits for the first
        gate.set()
        worker.join(5)
        second.join(5)
        assert set(seen) == {('Gen1A', 'Gen1B')}
        assert state['gen'] == 3
        assert [label['name'] for label in inst.get_schema({})['schema']['labels']] == ['Gen3A', 'Gen3B']

    def test_refresh_budget_is_passed_as_a_deadline(self, monkeypatch):
        monkeypatch.setattr(graph_global_base, 'SCHEMA_REFRESH_BUDGET_MS', 1234)
        seen = {}

        def reflect(builder, deadline):
            seen['left'] = deadline - time.monotonic()

        make(reflect).IGlobal.refresh_schema_snapshot()
        assert 1.0 < seen['left'] <= 1.234

    def test_refresh_schema_rejects_arguments(self):
        with pytest.raises(GraphToolError, match='Invalid refresh_schema input'):
            make().refresh_schema({'label': 'x'})


class TestDialect:
    def test_dialect_fields(self):
        out = make().dialect({})
        assert out == {
            'dialect': 'fake',
            'engine': {'name': 'Fake', 'version': '1.0', 'edition': None},
            'database': 'db1',
            'graph': 'g1',
            'allow_execute': False,
            'capabilities': {
                'read_query': True,
                'refresh_schema': True,
                'execute_shape_graph': True,
                'params': True,
                'shortest_path': False,
            },
            'limits': {
                'default_rows': 1000,
                'max_rows': 25000,
                'max_elements': 10000,
                'max_values': 500000,
                'statement_timeout_ms': 30000,
                'server_result_cap': 10000,
            },
            'read_boundary': 'ro_command',
            'read_boundary_verified': False,
        }


class TestPrompt:
    def test_engine_rules_reach_the_prompt(self):
        inst = make()
        inst.IGlobal.refresh_schema_snapshot('startup')
        captured = {}

        class FakeInvoke:
            def invoke(self, request):
                captured['question'] = request['question']
                return type('R', (), {'answer': {'isValid': 'true', 'query': 'MATCH (n) RETURN n'}})()

        inst.instance = FakeInvoke()
        graph_instance_base = __import__('ai.common.graph.graph_instance_base', fromlist=['IInvokeLLM'])
        original = graph_instance_base.IInvokeLLM
        graph_instance_base.IInvokeLLM = type('X', (), {'Ask': staticmethod(lambda question: {'question': question})})
        try:
            inst._buildQueryOnce('who?')
        finally:
            graph_instance_base.IInvokeLLM = original
        text = str(captured['question'].__dict__)
        assert 'RULE-ONE' in text and 'RULE-TWO' in text
