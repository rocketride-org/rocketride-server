# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Live tests for graph_falkordb's read_query / execute(shape='graph') against a real FalkorDB.

read_query must always use GRAPH.RO_QUERY, whatever ``allow_writes`` and
``allow_execute`` say; refused writes are proven by graph state before and
after. Also covers the server's RESULTSET_SIZE (silent truncation) and
TIMEOUT settings.

Configuration: RR_TEST_FALKORDB_URL (default redis://127.0.0.1:56379) and
RR_TEST_FALKORDB_GRAPH (scratch graph, default gx_live_<random>, dropped
after each test).
Skips when the server is unreachable unless RR_REQUIRE_DB_TESTS is set.
"""

from __future__ import annotations

import os
import sys
import time
import uuid

import pytest

_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))
for _name in [n for n in sys.modules if n.split('.')[0] in ('falkordb', 'redis')]:
    if not getattr(sys.modules[_name], '__file__', None):
        del sys.modules[_name]
if _REQUIRED:
    import falkordb
else:
    falkordb = pytest.importorskip('falkordb')

from .test_graph_neo4j_full import load_graph_node, start_node  # noqa: E402

URL = os.environ.get('RR_TEST_FALKORDB_URL', 'redis://127.0.0.1:56379')
# Per-run scratch graph, so concurrent runs on one server never share it.
GRAPH = os.environ.get('RR_TEST_FALKORDB_GRAPH') or f'gx_live_{uuid.uuid4().hex[:8]}'


def _client():
    return falkordb.FalkorDB.from_url(URL)


def _reachable() -> bool:
    try:
        client = _client()
        client.list_graphs()
        client.close()
        return True
    except Exception:
        return False


_REACHABLE = _reachable()
if _REQUIRED and not _REACHABLE:
    pytest.fail(f'RR_REQUIRE_DB_TESTS is set but FalkorDB is not reachable at {URL}', pytrace=False)
pytestmark = pytest.mark.skipif(not _REACHABLE, reason=f'FalkorDB test server not reachable at {URL}')

SEED = (
    "CREATE (a:Person:Employee {name: 'Alice', age: 37, big: 9007199254740993, born: date('1989-02-28'), "
    "seen: localdatetime('2026-10-04T12:30:15'), tenure: duration({days: 40, hours: 2}), "
    'home: point({latitude: 52.52, longitude: 13.405})}), '
    "(b:Person {name: 'Bob', age: 41}), (c:Company {name: 'Acme'}), "
    '(a)-[:KNOWS {since: 2019}]->(b), (a)-[:KNOWS {since: 2021}]->(b), (b)-[:KNOWS {since: 2020}]->(a), '
    "(a)-[:LIKES]->(a), (a)-[:WORKS_AT {role: 'eng'}]->(c)"
)


@pytest.fixture()
def falkor_graph():
    client = _client()
    graph = client.select_graph(GRAPH)
    try:
        graph.delete()
    except Exception:
        pass
    graph.query(SEED)
    yield graph
    try:
        graph.delete()
    except Exception:
        pass
    client.close()


@pytest.fixture()
def falkor_env(monkeypatch):
    return load_graph_node(monkeypatch, 'graph_falkordb')


def _start(env, **config):
    return start_node(env, 'graph_falkordb', {'mode': 'url', 'url': URL, 'graph': GRAPH, **config})


def _state(graph):
    nodes = graph.ro_query('MATCH (n) RETURN count(n)').result_set[0][0]
    rels = graph.ro_query('MATCH ()-[r]->() RETURN count(r)').result_set[0][0]
    labels = sorted(r[0] for r in graph.ro_query('CALL db.labels()').result_set)
    return nodes, rels, labels


class TestReadQueryShape:
    def test_entities_and_direction(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env)
        try:
            out = inst.read_query(
                {'cypher': "MATCH (a:Person {name: 'Alice'})-[r]->(m) RETURN a, r, m ORDER BY type(r), r.since"}
            )
            alice = out['rows'][0][0]
            assert alice['labels'] == ['Employee', 'Person']
            props = alice['properties']
            assert props['big'] == {'@kind': 'number', 'value': '9007199254740993'}
            assert props['born'] == {'@kind': 'temporal', 'type': 'date', 'value': '1989-02-28'}
            assert props['seen'] == {'@kind': 'temporal', 'type': 'datetime', 'value': '2026-10-04T12:30:15+00:00'}
            assert props['tenure'] == {'@kind': 'temporal', 'type': 'duration', 'value': 'P40DT2H'}
            # Documented policy: a plain map (the client erases the point type).
            # FalkorDB stores point coordinates as 32-bit floats.
            assert props['home'] == {
                'latitude': pytest.approx(52.52, rel=1e-6),
                'longitude': pytest.approx(13.405, rel=1e-6),
            }
            rels = [row[1] for row in out['rows']]
            assert [r['type'] for r in rels] == ['KNOWS', 'KNOWS', 'LIKES', 'WORKS_AT']
            assert rels[0]['id'] != rels[1]['id']
            assert rels[2]['start'] == rels[2]['end'] == alice['id']
        finally:
            glb.endGlobal()

    def test_path_direction_and_id_round_trip(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env)
        try:
            path = inst.read_query(
                {'cypher': "MATCH p = (b:Person {name: 'Bob'})<-[:KNOWS {since: 2019}]-(a) RETURN p"}
            )['rows'][0][0]
            assert [n['properties']['name'] for n in path['nodes']] == ['Bob', 'Alice']
            rel = path['relationships'][0]
            assert (rel['start'], rel['end']) == (path['nodes'][1]['id'], path['nodes'][0]['id'])
            out = inst.read_query(
                {
                    'cypher': 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n.name',
                    'params': {'id': path['nodes'][1]['id']},
                }
            )
            assert out['rows'] == [['Alice']]
        finally:
            glb.endGlobal()

    def test_parameters_round_trip(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env)
        try:
            tricky = 'x" RETURN 1 // \\ \' end'
            params = {'s': tricky, 'b': True, 'n': None, 'f': 1.5, 'l': [1, 'two'], 'm': {'k': 'v'}}
            out = inst.read_query({'cypher': 'RETURN $s, $b, $n, $f, $l, $m', 'params': params})
            assert out['rows'] == [[tricky, True, None, 1.5, [1, 'two'], {'k': 'v'}]]
        finally:
            glb.endGlobal()


WRITES = [
    "CREATE (:Evil {name: 'x'})",
    "MERGE (:Evil {name: 'x'})",
    "MATCH (a:Person {name: 'Alice'}) SET a.evil = true",
    "MATCH (a:Person {name: 'Bob'}) DETACH DELETE a",
    'MATCH (a:Person) REMOVE a.age',
]


class TestReadOnlyInvariant:
    @pytest.mark.parametrize('allow_writes', [False, True])
    @pytest.mark.parametrize('allow_execute', [False, True])
    @pytest.mark.parametrize('statement', WRITES)
    def test_writes_refused_under_every_flag_combination(
        self, falkor_env, falkor_graph, allow_writes, allow_execute, statement
    ):
        glb, inst = _start(falkor_env, allow_writes=allow_writes, allow_execute=allow_execute)
        try:
            before = _state(falkor_graph)
            with pytest.raises(falkor_env.GraphToolError) as err:
                inst.read_query({'cypher': statement})
            assert str(err.value).startswith('Refused: read_query is read-only')
            assert 'read-only queries' in str(err.value)  # the server's own refusal
            assert _state(falkor_graph) == before
            props = falkor_graph.ro_query("MATCH (a:Person {name: 'Alice'}) RETURN properties(a)").result_set[0][0]
            assert 'evil' not in props and props['age'] == 37
        finally:
            glb.endGlobal()

    def test_legacy_query_tool_is_unchanged(self, falkor_env, falkor_graph):
        # The pre-existing `query` tool still writes when allow_writes is on;
        # Graph Explorer never uses it for reads.
        glb, inst = _start(falkor_env, allow_writes=True)
        try:
            inst.query({'cypher': "CREATE (:Legacy {name: 'kept'})"})
            assert falkor_graph.ro_query('MATCH (n:Legacy) RETURN count(n)').result_set[0][0] == 1
        finally:
            glb.endGlobal()


class TestReadQueryRefusals:
    @pytest.mark.parametrize(
        'cypher',
        [
            "LOAD CSV FROM 'https://example.invalid/rr-test.csv' AS r RETURN r",
            "MATCH (a:Person) WITH 'file://' + a.name AS f LOAD CSV FROM f AS r RETURN count(r)",
        ],
    )
    def test_load_csv_is_refused(self, falkor_env, falkor_graph, cypher):
        glb, inst = _start(falkor_env, allow_writes=True)
        try:
            with pytest.raises(falkor_env.GraphToolError) as err:
                inst.read_query({'cypher': cypher})
            assert str(err.value).startswith('Refused: LOAD CSV is not allowed on the read-only path')
        finally:
            glb.endGlobal()


class TestServerLimits:
    def test_resultset_size_is_read_and_respected(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env, max_rows=25000)
        try:
            cap = glb.server_result_cap
            if cap is None:
                pytest.skip('server does not allow GRAPH.CONFIG GET RESULTSET_SIZE')
            assert glb.read_query_cap == min(25000, cap - 1)
            over = inst.read_query({'cypher': f'UNWIND range(1, {cap + 5000}) AS i RETURN i', 'limit': 25000})
            assert over['row_limit'] == cap - 1 and len(over['rows']) == cap - 1
            assert over['truncated'] is True and over['truncated_by'] == 'rows'
            exact = inst.read_query({'cypher': f'UNWIND range(1, {cap - 1}) AS i RETURN i', 'limit': 25000})
            assert len(exact['rows']) == cap - 1 and exact['truncated'] is False
        finally:
            glb.endGlobal()

    def test_execute_graph_shape_reports_a_resultset_size_cut(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env, allow_execute=True)
        try:
            cap = glb.server_result_cap
            if cap is None:
                pytest.skip('server does not allow GRAPH.CONFIG GET RESULTSET_SIZE')
            assert glb.execute_graph_cap == min(glb.max_execute_rows, cap - 1)
            over = inst.execute({'query': f'UNWIND range(1, {cap + 5000}) AS i RETURN i', 'shape': 'graph'})
            assert over['row_limit'] == cap - 1 and len(over['rows']) == cap - 1
            assert over['truncated'] is True and over['truncated_by'] == 'rows'
            exact = inst.execute({'query': f'UNWIND range(1, {cap - 1}) AS i RETURN i', 'shape': 'graph'})
            assert len(exact['rows']) == cap - 1 and exact['truncated'] is False
        finally:
            glb.endGlobal()

    def test_get_data_and_query_report_a_resultset_size_cut(self, falkor_env, falkor_graph):
        """get_data and the query tool keep their cap below RESULTSET_SIZE, so a cut reply reads as truncated."""
        glb, inst = _start(falkor_env, max_rows=25000)
        try:
            cap = glb.server_result_cap
            if cap is None:
                pytest.skip('server does not allow GRAPH.CONFIG GET RESULTSET_SIZE')
            over = f'UNWIND range(1, {cap + 5000}) AS i RETURN i'
            out = inst.query({'cypher': over})
            assert 'error' not in out, out
            assert out['row_count'] == cap - 1 and out['truncated'] is True
            # get_data without the LLM: the generated query is the over-long one.
            inst.get_query = lambda args: {'query': over, 'valid': True}
            data = inst.get_data({'question': 'every number', 'limit': 25000})
            assert data['valid'] is True, data
            assert data['row_limit'] == cap - 1 and len(data['rows']) == cap - 1 and data['truncated'] is True
            assert len(glb._run_query(over)) == cap - 1  # the questions lane
        finally:
            glb.endGlobal()

    def test_legacy_execute_read_fails_instead_of_returning_a_cut_reply(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env, allow_execute=True)
        try:
            cap = glb.server_result_cap
            if cap is None:
                pytest.skip('server does not allow GRAPH.CONFIG GET RESULTSET_SIZE')
            with pytest.raises(ValueError, match=rf'^EXECUTE query reached the server RESULTSET_SIZE={cap}'):
                inst.execute({'query': f'UNWIND range(1, {cap + 5000}) AS i RETURN i'})
            exact = inst.execute({'query': f'UNWIND range(1, {cap - 1}) AS i RETURN i'})
            assert len(exact['rows']) == cap - 1 and exact['rows'][-1] == {'i': cap - 1}
        finally:
            glb.endGlobal()

    def test_every_command_sends_the_clamped_timeout(self, falkor_env, falkor_graph):
        """get_data, the questions lane, legacy execute and query send min(query timeout, TIMEOUT_MAX).

        The shared test server runs with TIMEOUT_MAX off, and changing that
        server-wide setting would affect other users of the server, so the
        node is told of a 100 ms TIMEOUT_MAX instead: each path must then end
        within that, not within the node's own 5-second timeout.
        """
        glb, inst = _start(falkor_env, allow_execute=True, query_timeout_ms=5000)
        slow = 'UNWIND range(1, 300000000) AS i WITH i WHERE i % 7 = 3 RETURN count(i) AS c'
        try:
            glb.server_timeout_max_ms = 100
            assert glb.statement_timeout_ms == 100
            inst.get_query = lambda args: {'query': slow, 'valid': True}
            calls = {
                'get_data': lambda: inst.get_data({'question': 'count'}),
                'lane': lambda: glb._run_query(slow),
                'execute': lambda: inst.execute({'query': slow}),
                'query': lambda: inst.query({'cypher': slow}),
            }
            for name, call in calls.items():
                started = time.monotonic()
                try:
                    out = call()
                except Exception as e:  # noqa: BLE001 - the error text is what is checked
                    out = {'error': str(e)}
                elapsed = time.monotonic() - started
                assert 'timed out' in str(out.get('error', '')).lower(), (name, out)
                assert elapsed < 2.5, (name, elapsed)
        finally:
            glb.endGlobal()

    def test_exact_limit_and_truncation(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env)
        try:
            q = 'MATCH (p:Person) RETURN p.name ORDER BY p.name'
            assert inst.read_query({'cypher': q, 'limit': 2})['truncated'] is False
            cut = inst.read_query({'cypher': q, 'limit': 1})
            assert cut['rows'] == [['Alice']] and cut['truncated_by'] == 'rows'
        finally:
            glb.endGlobal()

    def test_timeout(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env, query_timeout_ms=100)
        try:
            with pytest.raises(falkor_env.GraphToolError) as err:
                inst.read_query({'cypher': 'UNWIND range(1, 300000000) AS i WITH i WHERE i % 7 = 3 RETURN count(i)'})
            assert str(err.value).startswith(f'Query timed out after {glb.statement_timeout_ms} ms')
        finally:
            glb.endGlobal()

    def test_collect_is_bounded_by_the_element_budget(self, falkor_env, falkor_graph):
        falkor_graph.query('UNWIND range(1, 10050) AS i CREATE (:Bulk {i: i})')
        glb, inst = _start(falkor_env)
        try:
            with pytest.raises(falkor_env.GraphToolError, match='first row holds more than 10,000 graph elements'):
                inst.read_query({'cypher': 'MATCH (n:Bulk) RETURN collect(n)'})
        finally:
            glb.endGlobal()


class TestExecuteGraphShape:
    def test_graph_shape(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env, allow_execute=True)
        try:
            out = inst.execute({'query': "CREATE (n:New {name: 'n1'}) RETURN n", 'shape': 'graph'})
            assert out['rows'][0][0]['labels'] == ['New'] and out['affected_rows'] >= 2
        finally:
            glb.endGlobal()


class TestSchemaAndDialect:
    def test_refresh_contents(self, falkor_env, falkor_graph):
        falkor_graph.query("CREATE (:Person {name: 'Carol', age: 'unknown'})")
        glb, inst = _start(falkor_env)
        try:
            block = inst.refresh_schema({})['schema']
            labels = {label['name']: label for label in block['labels']}
            assert set(labels) == {'Company', 'Employee', 'Person'}
            person = labels['Person']
            assert person['count'] == 3 and person['count_estimated'] is False
            types = {p['name']: p['types'] for p in person['properties']}
            assert (
                types['age'] == ['string', 'integer'] and types['home'] == ['point'] and types['born'] == ['temporal']
            )
            knows = {r['type']: r for r in block['relationship_types']}['KNOWS']
            assert knows['count'] == 3
            # Alice is Person:Employee and KNOWS runs both ways, so every pairing is observed.
            assert {(e['start'], e['end']) for e in knows['endpoints']} == {
                ('Person', 'Person'),
                ('Employee', 'Person'),
                ('Person', 'Employee'),
            }
            assert {'name': 'since', 'types': ['integer']} in knows['properties']
        finally:
            glb.endGlobal()

    def test_refresh_shows_a_change_made_by_execute(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env, allow_execute=True)
        try:
            inst.execute({'query': "CREATE (:Later {k: 1})-[:LATER_REL]->(:Person {name: 'z'})"})
            assert 'Later' not in inst.get_schema({})['labels']
            out = inst.refresh_schema({})
            assert 'Later' in out['labels']
            assert any(r['type'] == 'LATER_REL' for r in out['schema']['relationship_types'])
        finally:
            glb.endGlobal()

    def test_timeout_never_becomes_an_empty_schema(self, falkor_env, falkor_graph, monkeypatch):
        glb, inst = _start(falkor_env)
        try:
            good = inst.get_schema({})['schema']
            assert good['relationship_types']
            monkeypatch.setattr(sys.modules['ai.common.graph.graph_global_base'], 'SCHEMA_REFRESH_BUDGET_MS', 0)
            out = inst.refresh_schema({})
            assert out['schema']['stale'] is True and out['schema']['error']
            assert out['schema']['relationship_types'] == good['relationship_types']
            assert out['relationships']  # legacy keys keep the last good schema too
        finally:
            glb.endGlobal()

    def test_dialect_identity(self, falkor_env, falkor_graph):
        glb, inst = _start(falkor_env)
        try:
            out = inst.dialect({})
            assert out['dialect'] == 'falkordb' and out['graph'] == GRAPH and out['database'] is None
            assert out['engine']['name'] == 'FalkorDB' and out['engine']['version'].count('.') == 2
            assert out['read_boundary'] == 'ro_command'
            assert out['limits']['server_result_cap'] == glb.server_result_cap
            assert out['limits']['max_rows'] == glb.read_query_cap
            # The default is what read_query returns without a limit: 1,000, capped by max_rows (250 by default).
            assert out['limits']['default_rows'] == min(1000, glb.read_query_cap) == 250
            assert inst.read_query({'cypher': 'UNWIND range(1, 300) AS i RETURN i'})['row_limit'] == 250
            assert '56379' not in str(out) and 'redis' not in str(out)
            assert 'GRAPH.RO_QUERY' in ' '.join(glb._prompt_rules())
        finally:
            glb.endGlobal()
