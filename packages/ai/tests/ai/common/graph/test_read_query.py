# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""read_query and execute(shape='graph') in the shared graph base, with a fake driver."""

from __future__ import annotations

import json

import pytest

from ai.common.graph.adapters import age_adapter
from ai.common.graph.age import parse_agtype
from ai.common.graph.age._agtype import Vertex
from ai.common.graph.graph_errors import GraphToolError
from ai.common.graph.graph_global_base import GraphGlobalBase
from ai.common.graph.graph_instance_base import GraphInstanceBase


class FakeGlobal(GraphGlobalBase):
    """Records calls; serves positional rows (agtype text cells are parsed, others pass as-is)."""

    def __init__(self, rows=None, columns=('n',), *, cap=25000, allow_execute=False, error=None):
        self.rows = rows or []
        self.columns = list(columns)
        self.cap = cap
        self.allow_execute = allow_execute
        self.max_execute_rows = 25000
        self.error = error
        self.read_calls = []
        self.raw_calls = []

    # abstract hooks unused here
    def _open_driver(self, config):
        pass

    def _close_driver(self):
        pass

    def _probe_connection(self, config):
        pass

    def _reflect_schema(self):
        return {'nodes': {}, 'relationships': []}

    def _run_query(self, query, params=None, limit=None):
        raise AssertionError('legacy read path must not be used by read_query')

    def _run_query_raw(self, query):
        self.raw_calls.append(('legacy', query))
        return {'rows': [{'x': 1}], 'affected_rows': 3}

    def _validate_query(self, query):
        return True, ''

    @property
    def read_row_cap(self):
        return self.cap

    def _graph_adapter(self):
        return age_adapter()

    def _read_query_rows(self, cypher, params, fetch_limit, consume):
        self.read_calls.append((cypher, params, fetch_limit))
        if self.error:
            raise self.error
        return consume(self.columns, (_cells(row) for row in self.rows[:fetch_limit]))

    def _raw_query_rows(self, cypher, fetch_limit, consume, params=None):
        self.raw_calls.append(
            ('graph', cypher, fetch_limit) if params is None else ('graph', cypher, fetch_limit, params)
        )
        return consume(self.columns, (_cells(row) for row in self.rows[:fetch_limit])), 2

    def _describe_error(self, exc):
        if isinstance(exc, TimeoutError):
            return 'Query timed out after 30000 ms', str(exc)
        return None


def _cells(row):
    return [parse_agtype(v) if isinstance(v, str) else v for v in row]


def vertices(count):
    return [Vertex(id=i, label='N', properties={}) for i in range(count)]


class Inst(GraphInstanceBase):
    def _db_display_name(self):
        return 'Fake'

    def _db_dialect(self):
        return 'fake'


def make(rows=None, columns=('n',), **kw):
    inst = Inst()
    inst.IGlobal = FakeGlobal(rows, columns, **kw)
    return inst


def vertex(i, label='N', props='{}'):
    return f'{{"id": {i}, "label": "{label}", "properties": {props}}}::vertex'


# ---------------------------------------------------------------------------
# input validation
# ---------------------------------------------------------------------------


class TestValidation:
    @pytest.mark.parametrize(
        'args,message',
        [
            ({}, '"cypher" must be a non-empty string'),
            ({'cypher': '   '}, '"cypher" must be a non-empty string'),
            ({'cypher': 5}, '"cypher" must be a non-empty string'),
            ({'cypher': 'x' * 100_001}, 'limit 100,000'),
            ({'cypher': 'RETURN 1', 'limit': True}, '"limit" must be an integer >= 1 (got True)'),
            ({'cypher': 'RETURN 1', 'limit': 0}, '"limit" must be an integer >= 1 (got 0)'),
            ({'cypher': 'RETURN 1', 'limit': 2.0}, '"limit" must be an integer'),
            ({'cypher': 'RETURN 1', 'limit': '10'}, '"limit" must be an integer'),
            ({'cypher': 'RETURN 1', 'params': []}, '"params" must be an object'),
            ({'cypher': 'RETURN 1', 'params': {'bad-name': 1}}, 'parameter name'),
            ({'cypher': 'RETURN 1', 'params': {'x': float('nan')}}, 'not a finite number'),
            ({'cypher': 'RETURN 1', 'params': {'x': [float('inf')]}}, 'params.x[0] is not a finite number'),
            ({'cypher': 'RETURN 1', 'params': {'x': 2**63}}, '64-bit'),
            ({'cypher': 'RETURN 1', 'params': {'x': {'`k': 1}}}, 'back-quote'),
            ({'cypher': 'RETURN 1', 'params': {'x': object()}}, 'unsupported type object'),
            ({'cypher': 'RETURN 1', 'cyphr': 'typo'}, "unknown field(s) 'cyphr'"),
        ],
    )
    def test_rejected(self, args, message):
        inst = make()
        with pytest.raises(GraphToolError) as err:
            inst.read_query(args)
        assert str(err.value).startswith('Invalid read_query input: ')
        assert message in str(err.value)
        assert inst.IGlobal.read_calls == []

    def test_non_object_input_rejected(self):
        with pytest.raises(GraphToolError, match='expected an object, got list'):
            make().read_query(['RETURN 1'])

    def test_deeply_nested_params_rejected(self):
        value = 1
        for _ in range(40):
            value = [value]
        with pytest.raises(GraphToolError, match='nested more than 32'):
            make().read_query({'cypher': 'RETURN $x', 'params': {'x': value}})

    def test_valid_params_pass_through(self):
        inst = make()
        params = {'id': '11821949021847553', 'n': None, 'b': True, 'f': 1.5, 'l': [1, 'a'], 'm': {'k': [None]}}
        inst.read_query({'cypher': 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n', 'params': params})
        assert inst.IGlobal.read_calls == [('MATCH (n) WHERE id(n) = toInteger($id) RETURN n', params, 1001)]

    def test_json_string_input_is_accepted(self):
        inst = make()
        inst.read_query(json.dumps({'cypher': 'RETURN 1', 'limit': 5}))
        assert inst.IGlobal.read_calls[0][2] == 6


# ---------------------------------------------------------------------------
# limits and truncation
# ---------------------------------------------------------------------------


class TestLimits:
    def test_default_limit_and_sentinel(self):
        inst = make([[str(i)] for i in range(5)])
        out = inst.read_query({'cypher': 'RETURN 1'})
        assert inst.IGlobal.read_calls[0][2] == 1001
        assert out['row_limit'] == 1000 and out['truncated'] is False and out['truncated_by'] is None
        assert out['rows'] == [[0], [1], [2], [3], [4]]

    def test_limit_clamped_to_node_cap(self):
        inst = make([[str(i)] for i in range(10)], cap=3)
        out = inst.read_query({'cypher': 'RETURN 1', 'limit': 1000})
        assert inst.IGlobal.read_calls[0][2] == 4
        assert out['row_limit'] == 3 and out['truncated'] is True and out['truncated_by'] == 'rows'
        assert len(out['rows']) == 3

    def test_hard_ceiling_is_25000(self):
        inst = make(cap=10**9)
        inst.read_query({'cypher': 'RETURN 1', 'limit': 10**9})
        assert inst.IGlobal.read_calls[0][2] == 25001

    def test_exact_limit_is_not_truncation(self):
        out = make([[str(i)] for i in range(3)]).read_query({'cypher': 'RETURN 1', 'limit': 3})
        assert out['truncated'] is False and len(out['rows']) == 3

    def test_one_more_row_is_truncation(self):
        out = make([[str(i)] for i in range(4)]).read_query({'cypher': 'RETURN 1', 'limit': 3})
        assert out['truncated'] is True and out['truncated_by'] == 'rows' and len(out['rows']) == 3

    def test_element_budget_drops_the_whole_overflowing_row(self):
        big = vertices(6000)
        inst = make([[big], [big], [big]])
        out = inst.read_query({'cypher': 'MATCH (n) RETURN collect(n)'})
        assert len(out['rows']) == 1
        assert out['truncated'] is True and out['truncated_by'] == 'elements'
        assert out['elements'] == 6000 and out['element_limit'] == 10000
        assert len(out['rows'][0][0]) == 6000  # no half-serialized row

    def test_first_row_over_element_budget_is_refused(self):
        huge = vertices(10_001)
        with pytest.raises(GraphToolError, match='Refused: the first row holds more than 10,000 graph elements'):
            make([[huge]]).read_query({'cypher': 'MATCH (n) RETURN collect(n)'})

    def test_value_budget(self):
        many = list(range(300_000))
        out = make([[many], [many]]).read_query({'cypher': 'RETURN range(1, 300000)'})
        assert out['truncated_by'] == 'values' and len(out['rows']) == 1
        assert out['value_limit'] == 500000 and out['values'] == 300_001

    def test_duplicate_columns_are_kept(self):
        out = make([['1', '2']], columns=('a', 'a')).read_query({'cypher': 'RETURN 1 AS a, 2 AS a'})
        assert out['columns'] == ['a', 'a'] and out['rows'] == [[1, 2]]

    def test_envelope_fields_always_present(self):
        out = make().read_query({'cypher': 'MATCH (n) RETURN n'})
        assert set(out) == {
            'columns',
            'rows',
            'row_limit',
            'truncated',
            'truncated_by',
            'element_limit',
            'elements',
            'value_limit',
            'values',
        }
        json.dumps(out, allow_nan=False)


# ---------------------------------------------------------------------------
# read-only invariant, errors, execute shape
# ---------------------------------------------------------------------------


class TestInvariantAndErrors:
    @pytest.mark.parametrize('allow_execute', [False, True])
    def test_read_query_never_uses_a_write_path(self, allow_execute):
        inst = make([[vertex(1)]], allow_execute=allow_execute)
        inst.read_query({'cypher': 'MATCH (n) RETURN n'})
        assert inst.IGlobal.raw_calls == []
        assert len(inst.IGlobal.read_calls) == 1

    @pytest.mark.parametrize('allow_execute', [False, True])
    def test_load_csv_is_refused_before_the_driver(self, allow_execute):
        inst = make(allow_execute=allow_execute)
        with pytest.raises(GraphToolError) as err:
            inst.read_query({'cypher': "LOAD CSV FROM 'https://example.invalid/a.csv' AS r RETURN r"})
        assert str(err.value).startswith('Refused: LOAD CSV is not allowed on the read-only path\n')
        assert inst.IGlobal.read_calls == []

    def test_unterminated_text_is_invalid_input_before_the_driver(self):
        inst = make()
        with pytest.raises(GraphToolError) as err:
            inst.read_query({'cypher': "MATCH (n) WHERE n.name = 'open RETURN n"})
        assert str(err.value) == 'Invalid read_query input: unterminated string literal'
        assert inst.IGlobal.read_calls == []

    def test_execute_does_not_apply_the_read_query_rule(self):
        inst = make([[vertex(1)]], allow_execute=True)
        inst.execute({'query': "LOAD CSV FROM 'file:///x' AS r RETURN r", 'shape': 'graph'})
        assert [call[0] for call in inst.IGlobal.raw_calls] == ['graph']

    def test_driver_errors_use_the_shared_formatter(self):
        inst = make(error=TimeoutError('canceling statement due to statement timeout'))
        with pytest.raises(GraphToolError) as err:
            inst.read_query({'cypher': 'MATCH (n) RETURN n'})
        assert str(err.value) == 'Query timed out after 30000 ms\ncanceling statement due to statement timeout'

    def test_unknown_driver_error_is_query_failed(self):
        inst = make(error=RuntimeError('boom\nsecond line'))
        with pytest.raises(GraphToolError) as err:
            inst.read_query({'cypher': 'MATCH (n) RETURN n'})
        assert str(err.value) == 'Query failed\nboom\nsecond line'

    def test_driver_without_read_query_says_so(self):
        inst = make()
        inst.IGlobal._read_query_rows = GraphGlobalBase._read_query_rows.__get__(inst.IGlobal)
        with pytest.raises(GraphToolError, match='read_query is not available on this node'):
            inst.read_query({'cypher': 'RETURN 1'})

    def test_execute_legacy_default_is_unchanged(self):
        inst = make(allow_execute=True)
        assert inst.execute({'query': 'CREATE (n)'}) == {'rows': [{'x': 1}], 'affected_rows': 3}
        assert inst.execute({'query': 'CREATE (n)', 'shape': 'legacy'}) == {'rows': [{'x': 1}], 'affected_rows': 3}

    def test_execute_graph_shape(self):
        inst = make([[vertex(7)]], allow_execute=True)
        out = inst.execute({'query': 'CREATE (n) RETURN n', 'shape': 'graph'})
        assert out['affected_rows'] == 2
        assert out['rows'][0][0]['@kind'] == 'node' and out['rows'][0][0]['id'] == '7'
        assert out['row_limit'] == 25000 and out['truncated'] is False

    def test_execute_still_refused_without_allow_execute(self):
        inst = make()
        for shape in ('legacy', 'graph'):
            with pytest.raises(ValueError, match='execute tool is disabled'):
                inst.execute({'query': 'CREATE (n)', 'shape': shape})
        assert inst.IGlobal.raw_calls == []

    def test_execute_rejects_unknown_shape(self):
        with pytest.raises(ValueError, match='"shape" must be one of'):
            make(allow_execute=True).execute({'query': 'RETURN 1', 'shape': 'table'})

    def test_execute_graph_shape_binds_params_on_a_driver_that_supports_them(self):
        inst = make([[vertex(7)]], allow_execute=True)
        inst.IGlobal.supports_execute_params = True
        query = 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n'
        out = inst.execute({'query': query, 'shape': 'graph', 'params': {'id': '7'}})
        assert inst.IGlobal.raw_calls == [('graph', query, 25001, {'id': '7'})]
        assert out['rows'][0][0]['id'] == '7'

    def test_execute_graph_shape_refuses_params_on_a_driver_without_them(self):
        inst = make(allow_execute=True)
        with pytest.raises(ValueError, match='"params" is not supported'):
            inst.execute({'query': 'RETURN $x', 'shape': 'graph', 'params': {'x': 1}})
        assert inst.IGlobal.raw_calls == []

    def test_execute_input_schema_lists_params_only_where_they_bind(self):
        inst = make(allow_execute=True)
        assert set(inst._execute_input_schema()['properties']) == {'query', 'shape'}
        inst.IGlobal.supports_execute_params = True
        assert set(inst._execute_input_schema()['properties']) == {'query', 'params', 'shape'}


# ---------------------------------------------------------------------------
# read_query's statement rule runs before the driver is called
# ---------------------------------------------------------------------------


class TestReadQueryStatementRule:
    @pytest.mark.parametrize(
        'cypher,headline',
        [
            ('RETURN 7x AS y', "Invalid read_query input: the number 7 runs into 'x'"),
            ('MATCH (n) /* a/b */ RETURN n', "Invalid read_query input: '/' inside a block comment"),
            ("MATCH (n) WHERE n.name = 'open RETURN n", 'Invalid read_query input: unterminated string literal'),
        ],
    )
    def test_read_query_refuses_before_the_driver(self, cypher, headline):
        inst = make()
        with pytest.raises(GraphToolError) as err:
            inst.read_query({'cypher': cypher})
        assert err.value.headline == headline
        assert inst.IGlobal.read_calls == []

    def test_non_ascii_names_reach_the_driver(self):
        inst = make()
        inst.read_query({'cypher': 'MATCH (\u00e9:\u00dcn\u00efcode) RETURN \u00e9'})
        assert [call[0] for call in inst.IGlobal.read_calls] == ['MATCH (\u00e9:\u00dcn\u00efcode) RETURN \u00e9']


# ---------------------------------------------------------------------------
# published tool contracts: the outputSchema an agent's catalog carries must
# describe what the tool returns
# ---------------------------------------------------------------------------


def _published(tool):
    """The output_schema @tool_function publishes as the tool's outputSchema."""
    return getattr(GraphInstanceBase, tool).__tool_meta__['output_schema']


def _json_type(value):
    if isinstance(value, dict):
        return 'object'
    if isinstance(value, list):
        return 'array'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, int):
        return 'integer'
    if isinstance(value, float):
        return 'number'
    if isinstance(value, str):
        return 'string'
    return 'null'


class TestPublishedContracts:
    def test_execute_rows_schema_admits_both_shapes(self):
        rows_schema = _published('execute')['properties']['rows']
        allowed = rows_schema['items']['type']
        allowed = [allowed] if isinstance(allowed, str) else list(allowed)
        inst = make([[vertex(1)]], allow_execute=True)
        legacy = inst.execute({'query': 'MATCH (n) RETURN n'})
        graph = inst.execute({'query': 'MATCH (n) RETURN n', 'shape': 'graph'})
        assert [_json_type(r) for r in legacy['rows']] == ['object']
        assert [_json_type(r) for r in graph['rows']] == ['array']
        for out in (legacy, graph):
            assert all(_json_type(r) in allowed for r in out['rows']), (allowed, out['rows'])
            assert set(out) <= set(_published('execute')['properties'])
        assert 'legacy' in rows_schema['description'] and '"graph"' in rows_schema['description']

    @pytest.mark.parametrize('tool', ['get_schema', 'refresh_schema'])
    def test_schema_tools_declare_what_they_return(self, tool):
        out = getattr(make(), tool)({})
        assert set(out) == set(_published(tool)['properties'])
        assert _published(tool)['properties']['schema']['type'] == 'object'

    @pytest.mark.parametrize('cap,expected', [(250, 250), (1000, 1000), (25000, 1000)])
    def test_dialect_default_rows_is_what_an_omitted_limit_returns(self, cap, expected):
        inst = make([[1]] * 3, cap=cap)
        limits = inst.dialect({})['limits']
        assert limits['default_rows'] == expected and limits['max_rows'] == min(cap, 25000)
        assert inst.read_query({'cypher': 'RETURN 1'})['row_limit'] == limits['default_rows']
