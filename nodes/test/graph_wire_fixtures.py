# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Generator for graph-ui's CONTRACT v1 wire fixtures (``apps/graph-ui/tests/fixtures/v1``).

graph-ui's tests parse these JSON files as the graph nodes' wire output, so
they must stay what the Python side really emits. Two sets:

- **Driver goldens** (``v1/read_query_*.json``): one logical graph through the
  real ``neo4j`` / ``falkordb`` driver objects and AGE agtype text (the
  builders in ``test_graph_drivers_full.py``), normalized by the shared
  normalizer into the ``read_query`` envelope. Offline; needs the drivers.
- **Live captures** (``v1/live/*.json``): the real node tools (``read_query``,
  ``dialect``, ``get_schema``, ``refresh_schema``, error text) against the live
  test databases the ``*_full.py`` suites use (same ``RR_TEST_*`` variables).

``test_graph_wire_fixtures_full.py`` regenerates both sets in the live-database
lane and compares them with the committed files, so a change to the envelope,
an ``@kind`` tag or a tool's output fails CI until the fixtures are
regenerated. To regenerate, from ``nodes/`` (unmocked, with the live test
databases up for ``--live``)::

    ../dist/server/engine test/graph_wire_fixtures.py ../apps/graph-ui/tests/fixtures/v1
    ../dist/server/engine test/graph_wire_fixtures.py --live ../apps/graph-ui/tests/fixtures/v1/live
"""

from __future__ import annotations

import json
import os
import sys

from typing import Any, Callable, Dict

DRIVER_FIXTURES = (
    'read_query_age.json',
    'read_query_falkordb.json',
    'read_query_falkordb_types.json',
    'read_query_neo4j.json',
    'read_query_neo4j_types.json',
)


def _envelope(columns, rows, normalizer, row_limit=1000) -> Dict[str, Any]:
    return {
        'columns': columns,
        'rows': rows,
        'row_limit': row_limit,
        'truncated': False,
        'truncated_by': None,
        'element_limit': normalizer.element_limit,
        'elements': normalizer.elements,
        'value_limit': normalizer.value_limit,
        'values': normalizer.values,
    }


def driver_fixtures() -> Dict[str, Any]:
    """The driver goldens, by file name (requires the neo4j and falkordb drivers)."""
    from . import test_graph_drivers_full as t

    out: Dict[str, Any] = {}
    for name, rows, adapter in (
        ('neo4j', t.neo4j_rows(extra_alice_labels=('Employee',)), t.adapters.neo4j_adapter()),
        ('falkordb', t.falkordb_rows(extra_alice_labels=('Employee',)), t.adapters.falkordb_adapter()),
        ('age', t.age_rows(), t.adapters.age_adapter()),
    ):
        columns = list(t.COLUMNS)
        if name == 'age':  # AGE allows duplicate column names; rows stay positional
            columns.append('name')
            rows = [row + [row[-1]] for row in rows]
        normalized, normalizer = t.normalized(rows, adapter)
        out[f'read_query_{name}.json'] = _envelope(columns, normalized, normalizer)

    structure = t.Structure
    neo_types = t.TestNeo4jValues().hydrate(
        structure(b'D', 19782),
        structure(b't', 45015123456789),
        structure(b'T', 45000000000000, 7200),
        structure(b'd', 1704164645, 1),
        structure(b'I', 1704164645, 123456789, 3600),
        structure(b'i', 1704164645, 1, 'Europe/Berlin'),
        structure(b'E', 14, 3, 7, 5),
        structure(b'X', 7203, 1.5, 2.0),
        structure(b'Y', 4979, 13.4, 52.5, 34.0),
    )
    normalized, normalizer = t.normalized(
        [neo_types + [2**62, float('nan'), float('-inf')]], t.adapters.neo4j_adapter()
    )
    out['read_query_neo4j_types.json'] = _envelope(
        [
            'date',
            'localtime',
            'time',
            'localdatetime',
            'datetime',
            'zoned',
            'duration',
            'cartesian',
            'wgs84_3d',
            'big',
            'nan',
            'neg_inf',
        ],
        normalized,
        normalizer,
    )

    types_ = t.T
    falkor = t.TestFalkorDBValues()
    falkor_types = [
        falkor.parse(types_.VALUE_DATE, 1709164800),
        falkor.parse(types_.VALUE_DATETIME, 1704164645),
        falkor.parse(types_.VALUE_TIME, 45015),
        falkor.parse(types_.VALUE_DURATION, 40 * 86400 + 2 * 3600),
        falkor.parse(types_.VALUE_POINT, ['52.52', '13.405']),
        falkor.parse(types_.VALUE_VECTORF32, ['1.0', '2.5']),
        falkor.parse(types_.VALUE_INTEGER, t.BIG),
    ]
    normalized, normalizer = t.normalized([falkor_types], t.adapters.falkordb_adapter())
    out['read_query_falkordb_types.json'] = _envelope(
        ['date', 'datetime', 'localtime', 'duration', 'point_as_map', 'vectorf32', 'big'], normalized, normalizer
    )
    return out


def _error_text(call: Callable[[], Any]):
    try:
        call()
        return None
    except Exception as e:  # noqa: BLE001 - the error text IS the fixture
        return str(e)


def live_neo4j() -> Dict[str, Any]:
    """Neo4j live captures (the database of test_graph_neo4j_full.py)."""
    import neo4j

    from pytest import MonkeyPatch

    from . import test_graph_neo4j_full as n4

    out: Dict[str, Any] = {}
    mp = MonkeyPatch()
    driver = neo4j.GraphDatabase.driver(n4.URI, auth=(n4.USER, n4.PASSWORD))
    try:
        with driver.session(database='neo4j') as s:
            s.run(n4.ns(n4.CLEANUP)).consume()
            s.run(n4.ns(n4.SEED)).consume()
            s.run(n4.ns('CREATE (:GxBlob {b: $b})'), b=bytearray(b'\x00\xffraw')).consume()
        env = n4.load_graph_node(mp, 'graph_neo4j')
        glb, inst = n4._start(env)
        try:
            out['neo4j_read_query_graph.json'] = inst.read_query(
                {
                    'cypher': "MATCH (a:GxPerson {name: 'Alice'})-[r]->(m) RETURN a, r, m ORDER BY type(r), r.since",
                    'limit': 10,
                }
            )
            out['neo4j_read_query_path.json'] = inst.read_query(
                {
                    'cypher': "MATCH p = (b:GxPerson {name: 'Bob'})<-[:GX_KNOWS {since: 2019}]-(a)-[:GX_WORKS_AT]->(c) "
                    'RETURN p, b.name AS name, [x IN [1, 2] | x] AS l'
                }
            )
            out['neo4j_read_query_truncated.json'] = inst.read_query(
                {'cypher': 'MATCH (p:GxPerson) RETURN p.name ORDER BY p.name', 'limit': 1}
            )
            out['neo4j_read_query_bytes.json'] = inst.read_query({'cypher': 'MATCH (n:GxBlob) RETURN n.b AS blob'})
            out['neo4j_dialect.json'] = inst.dialect({})
            out['neo4j_get_schema.json'] = inst.get_schema({})
            errors = {
                'refused_write': _error_text(lambda: inst.read_query({'cypher': 'CREATE (:GxEvil)'})),
                'refused_call': _error_text(
                    lambda: inst.read_query(
                        {'cypher': "CALL apoc.periodic.iterate('MATCH (n) RETURN n', 'DELETE n', {})"}
                    )
                ),
                'invalid_input': _error_text(lambda: inst.read_query({'cypher': 'RETURN 1', 'limit': True})),
                'db_error': _error_text(lambda: inst.read_query({'cypher': 'MATCH (n RETURN n'})),
                'execute_disabled': _error_text(lambda: inst.execute({'query': 'CREATE (n)', 'shape': 'graph'})),
            }
        finally:
            glb.endGlobal()
        mp.setattr(env.iglobal_cls, 'QUERY_TIMEOUT', 0.3)
        glb, inst = n4._start(env)
        try:
            errors['timeout'] = _error_text(
                lambda: inst.read_query(
                    {'cypher': 'UNWIND range(1, 200000000) AS x WITH x WHERE x % 7 = 0 RETURN count(x)'}
                )
            )
        finally:
            glb.endGlobal()
        out['neo4j_errors.json'] = errors
    finally:
        with driver.session(database='neo4j') as s:
            s.run(n4.ns(n4.CLEANUP)).consume()
        driver.close()
        mp.undo()
    return out


def live_falkordb() -> Dict[str, Any]:
    """FalkorDB live captures (the server of test_graph_falkordb_full.py)."""
    from pytest import MonkeyPatch

    from . import test_graph_falkordb_full as fk
    from .test_graph_neo4j_full import load_graph_node

    out: Dict[str, Any] = {}
    mp = MonkeyPatch()
    client = fk._client()
    graph = client.select_graph(fk.GRAPH)
    try:
        try:
            graph.delete()
        except Exception:  # noqa: BLE001 - nothing to delete
            pass
        graph.query(fk.SEED)
        env = load_graph_node(mp, 'graph_falkordb')
        glb, inst = fk._start(env)
        try:
            out['falkordb_read_query_graph.json'] = inst.read_query(
                {'cypher': "MATCH (a:Person {name: 'Alice'})-[r]->(m) RETURN a, r, m ORDER BY type(r), r.since"}
            )
            out['falkordb_read_query_path.json'] = inst.read_query(
                {'cypher': "MATCH p = (b:Person {name: 'Bob'})<-[:KNOWS {since: 2019}]-(a)-[:WORKS_AT]->(c) RETURN p"}
            )
            out['falkordb_dialect.json'] = inst.dialect({})
            out['falkordb_get_schema.json'] = inst.get_schema({})
            out['falkordb_errors.json'] = {
                'refused_write': _error_text(lambda: inst.read_query({'cypher': 'CREATE (:Evil)'}))
            }
        finally:
            glb.endGlobal()
    finally:
        try:
            graph.delete()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass
        client.close()
        mp.undo()
    return out


def live_age() -> Dict[str, Any]:
    """Apache AGE live captures (the database of test_rocketride_graph_full.py)."""
    from pytest import MonkeyPatch

    from . import test_graph_age_full as ag
    from . import test_rocketride_graph_full as rr

    out: Dict[str, Any] = {}
    mp = MonkeyPatch()
    try:
        env = rr.make_rr_env(mp)
        with rr.seeded_age_graph():
            for i in range(36):
                ag._cypher_admin(f'CREATE (:L{i} {{k: {i}}})')
            ag._cypher_admin("MATCH (a:Person {name: 'alice'}) SET a.big = 9007199254740993, a.precise = 1.5::numeric")
            glb = rr._begin(env)
            inst = env.iinstance_cls()
            inst.IGlobal = glb
            try:
                out['age_read_query_graph.json'] = inst.read_query(
                    {'cypher': "MATCH (a:Person {name: 'alice'})-[r:KNOWS]->(b) RETURN a, r, b, a.name, a.name"}
                )
                out['age_read_query_path.json'] = inst.read_query(
                    {'cypher': "MATCH p = (b:Person {name: 'bob'})<-[:KNOWS]-(a) RETURN p"}
                )
                out['age_read_query_big_id.json'] = inst.read_query(
                    {'cypher': 'MATCH (n:L35) RETURN n, id(n) AS raw_id'}
                )
                out['age_dialect.json'] = inst.dialect({})
                out['age_get_schema.json'] = inst.get_schema({})
                with MonkeyPatch.context() as budget:
                    budget.setattr(sys.modules['ai.common.graph.graph_global_base'], 'SCHEMA_REFRESH_BUDGET_MS', 0)
                    out['age_refresh_schema_stale.json'] = inst.refresh_schema({})
                errors = {
                    'refused_write': _error_text(lambda: inst.read_query({'cypher': 'CREATE (:Evil)'})),
                    'refused_call': _error_text(lambda: inst.read_query({'cypher': 'CALL db.labels()'})),
                    'hint_date': _error_text(lambda: inst.read_query({'cypher': "RETURN date('2024-01-01')"})),
                    'hint_exists_subquery': _error_text(
                        lambda: inst.read_query({'cypher': 'MATCH (n) WHERE EXISTS { MATCH (n)-->() } RETURN n'})
                    ),
                    'invalid_cypher': _error_text(lambda: inst.read_query({'cypher': 'MATCHX (n) RETURN n'})),
                }
            finally:
                glb.endGlobal()
            glb = rr._begin(env, {'query_timeout_ms': 200})
            inst = env.iinstance_cls()
            inst.IGlobal = glb
            try:
                ag._cypher_admin('UNWIND range(1, 2000) AS i CREATE (:Bulk {i: i})')
                errors['timeout'] = _error_text(
                    lambda: inst.read_query({'cypher': 'MATCH (a:Bulk), (b:Bulk), (c:Bulk) RETURN count(*)'})
                )
            finally:
                glb.endGlobal()
            out['age_errors.json'] = errors
    finally:
        mp.undo()
    return out


def live_fixtures() -> Dict[str, Any]:
    """All live captures, by file name (requires the three live test databases)."""
    return {**live_neo4j(), **live_falkordb(), **live_age()}


def _write(out_dir: str, fixtures: Dict[str, Any]) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for name, value in sorted(fixtures.items()):
        with open(os.path.join(out_dir, name), 'w', encoding='utf-8') as handle:
            json.dump(value, handle, indent=2, allow_nan=False)


def main(argv) -> int:
    live = '--live' in argv
    targets = [a for a in argv if a != '--live']
    if len(targets) != 1:
        print(__doc__)
        return 2
    fixtures = live_fixtures() if live else driver_fixtures()
    _write(targets[0], fixtures)
    print('\n'.join(sorted(fixtures)))
    return 0


if __name__ == '__main__':
    if not __package__:
        # Run as a script: import this module as part of the test package so
        # its relative imports of the live suites resolve.
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from test.graph_wire_fixtures import main as package_main

        sys.exit(package_main(sys.argv[1:]))
    sys.exit(main(sys.argv[1:]))
