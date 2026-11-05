# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Graph Explorer acceptance: Python SDK -> real engine -> graph node -> real database.

Makes exactly the calls Graph Explorer makes, through the public SDK only:
connect, use() a tools-only graph pipeline, find it with get_tasks() the way the
shared library does (project + source + owner, never a token lookup), then call
dialect / get_schema / refresh_schema / read_query / execute with client.tool().

Database state is checked with an independent admin connection before and after
every refused write, so a refusal is proved by the data, not by the message.

Seeds its own graph (ACCEPT_GRAPH; on Neo4j, nodes labelled RUN_LABEL) and
leaves it in place for the TypeScript script and the browser lanes.

Usage (from dist/server):
  ./engine <this folder>/graph_acceptance.py --engine all [--uri URL] [--pipe-dir DIR] [--json OUT]
--pipe-dir apps/graph-ui/templates runs the shipped templates instead of a
generated pipeline. Settings (engine URL, databases, graph names) come from the
environment; see local_env.py.
Exit code 0 only when every check passed. Checks that need something missing
(e.g. a node build without read_query) are reported as FAIL, never skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid

from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_env as E  # noqa: E402 - after the sys.path line above
from rocketride import CommandException, RocketRideClient  # noqa: E402

MAX_SAFE = 2**53 - 1

# Disposable local servers (throwaway local-only credentials, see local_env.py).
AGE_ADMIN_DSN = E.AGE_DSN
NEO4J = (E.NEO4J_URI, E.NEO4J_USER, E.NEO4J_PASSWORD)
FALKOR = (E.FALKORDB_HOST, E.FALKORDB_PORT)
GRAPH = E.ACCEPT_GRAPH  # own graph: never touch other runs' graphs
RUN = E.RUN_LABEL  # Neo4j has one database: every seeded node carries this label


def run_scope(engine: str) -> str:
    """Label suffix that keeps a Neo4j statement on this run's nodes (AGE and FalkorDB use their own graph)."""
    return f':{RUN}' if engine == 'neo4j' else ''


def write_probes(engine: str) -> List[str]:
    """Writes the read path must refuse.

    On Neo4j they carry the run label, so a write that got through would be
    counted, and later deleted, within this run only.
    """
    t = run_scope(engine)
    return [
        f'CREATE (:Intruder{t} {{x: 1}})',
        f'MATCH (n:Person{t}) SET n.flag = true',
        f'MERGE (:Intruder{t} {{x: 2}})',
    ]


def execute_probe(engine: str) -> str:
    """A write sent to ``execute``, which must be refused while allow_execute is off."""
    return f'CREATE (:Intruder{run_scope(engine)} {{x: 3}})'


NODE_CONFIG = {
    'age': ('rocketride_graph', {'graph': GRAPH, 'allow_execute': False}),
    'neo4j': ('graph_neo4j', {'uri': NEO4J[0], 'user': NEO4J[1], 'password': NEO4J[2], 'allow_execute': False}),
    'falkordb': ('graph_falkordb', {'host': FALKOR[0], 'port': FALKOR[1], 'graph': GRAPH, 'allow_execute': False}),
}


# ---------------------------------------------------------------------------
# Independent admin access (seeding and before/after state), never via the node
# ---------------------------------------------------------------------------


class Admin:
    """Direct driver access used only to seed and to measure state."""

    def __init__(self, engine: str):
        self.engine = engine

    def run(self, cypher: str) -> List[Any]:
        if self.engine == 'age':
            import psycopg2

            conn = psycopg2.connect(AGE_ADMIN_DSN)
            try:
                with conn, conn.cursor() as cur:
                    cur.execute('LOAD \'age\'; SET search_path = ag_catalog, "$user", public;')
                    cur.execute(f'SELECT * FROM cypher(%s, $$ {cypher} $$) AS (v agtype)', (GRAPH,))
                    return [r[0] for r in cur.fetchall()] if cur.description else []
            finally:
                conn.close()
        if self.engine == 'neo4j':
            from neo4j import GraphDatabase

            with GraphDatabase.driver(NEO4J[0], auth=(NEO4J[1], NEO4J[2])) as drv:
                records, _, _ = drv.execute_query(cypher)
                return [r.values()[0] if r.values() else None for r in records]
        from falkordb import FalkorDB

        res = FalkorDB(host=FALKOR[0], port=FALKOR[1]).select_graph(GRAPH).query(cypher)
        return [row[0] for row in res.result_set]

    def count(self, label: str = '') -> int:
        scope = (f':{label}' if label else '') + run_scope(self.engine)
        rows = self.run(f'MATCH (n{scope}) RETURN count(n)')
        return int(str(rows[0]).split('::')[0]) if rows else 0

    def reset_and_seed(self) -> None:
        """A small known graph; AGE gets 35 labels so ids pass 2^53."""
        if self.engine == 'age':
            import psycopg2

            conn = psycopg2.connect(AGE_ADMIN_DSN)
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute('LOAD \'age\'; SET search_path = ag_catalog, "$user", public;')
                cur.execute('SELECT count(*) FROM ag_graph WHERE name = %s', (GRAPH,))
                if cur.fetchone()[0]:
                    cur.execute('SELECT drop_graph(%s, true)', (GRAPH,))
                cur.execute('SELECT create_graph(%s)', (GRAPH,))
            conn.close()
            for i in range(35):
                self.run(f'CREATE (:L{i:02d} {{i: {i}}})')
        elif self.engine == 'neo4j':
            self.run(f'MATCH (n:{RUN}) DETACH DELETE n')
        else:
            try:
                from falkordb import FalkorDB

                FalkorDB(host=FALKOR[0], port=FALKOR[1]).select_graph(GRAPH).delete()
            except Exception:  # noqa: BLE001 - graph may not exist yet
                pass
        t = run_scope(self.engine)
        self.run(
            f"CREATE (a:Person{t} {{name: 'Ada GX', born: 1815}})-[:KNOWS {{since: 1833}}]->(b:Person{t} {{name: 'Charles GX'}}), "
            f"(b)-[:KNOWS {{since: 1840}}]->(c:Person{t} {{name: 'Grace GX'}}), (c)-[:WROTE]->(:Paper{t} {{title: 'Compilers'}})"
        )


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


class Report:
    def __init__(self, engine: str):
        self.engine = engine
        self.rows: List[Dict[str, Any]] = []

    def check(self, name: str, ok: bool, detail: Any = None) -> bool:
        self.rows.append({'engine': self.engine, 'check': name, 'status': 'PASS' if ok else 'FAIL', 'detail': detail})
        print(
            f'  [{"PASS" if ok else "FAIL"}] {self.engine}: {name}'
            + (f' -- {detail}' if not ok and detail is not None else ''),
            flush=True,
        )
        return ok


def graph_values(value: Any, kind: str) -> List[Dict[str, Any]]:
    """All tagged values of one kind anywhere inside a cell."""
    found: List[Dict[str, Any]] = []

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            if v.get('@kind') == kind:
                found.append(v)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(value)
    return found


async def call(client, token, node_id, tool, inp, timeout=40_000) -> Any:
    # client.tool timeout is in MILLISECONDS (above the node's 30 s statement deadline).
    return await client.tool(token=token, tool=tool, node_id=node_id, input=inp, timeout=timeout)


async def expect_refusal(client, token, node_id, tool, inp) -> str:
    try:
        await call(client, token, node_id, tool, inp)
    except CommandException as e:
        return str(e)
    raise AssertionError(f'{tool} was not refused')


async def run_engine(client: RocketRideClient, engine: str, pipe: Dict[str, Any] | None, rep: Report) -> Report:
    admin = Admin(engine)
    admin.reset_and_seed()
    provider, cfg = NODE_CONFIG[engine]
    node_id = f'{provider}_1'
    project_id = str(uuid.uuid4())
    if pipe is None:
        pipe = {
            'project_id': project_id,
            'components': [
                {
                    'id': 'tools_1',
                    'provider': 'tools',
                    'name': 'Tools',
                    'config': {'mode': 'Source', 'type': 'tools', 'name': 'Tools', 'parameters': {}},
                },
                {
                    'id': node_id,
                    'provider': provider,
                    'name': 'Graph',
                    'config': {'profile': 'default', 'default': cfg, 'name': 'Graph'},
                    'control': [{'classType': 'tool', 'from': 'tools_1'}],
                },
            ],
        }
    else:
        pipe = json.loads(json.dumps(pipe))
        pipe['project_id'] = project_id
        for comp in pipe['components']:
            if comp.get('provider') == provider:
                node_id = comp['id']
                comp['config'] = {'profile': 'default', 'default': cfg, 'name': comp.get('name', 'Graph')}

    started = await client.use(pipeline=pipe, source='tools_1')
    try:
        # Discovery exactly as the shared library does it.
        task = None
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and task is None:
            for t in await client.get_tasks():
                p = t.get('pipeline') or {}
                if p.get('project_id') == project_id and t.get('source') == 'tools_1' and t.get('ownerKind') == 'user':
                    task = t
            if task is None:
                await asyncio.sleep(1)
        rep.check('get_tasks lists the run by project+source+owner', task is not None)
        if task is None:
            return rep
        token = task['token']
        rep.check('get_tasks token equals use() token', token == started['token'])
        rep.check(
            'row pipeline carries components (no getTaskPipeline round trip)',
            bool((task.get('pipeline') or {}).get('components')),
        )
        pipeline = await client.get_task_pipeline(token)
        rep.check(
            'get_task_pipeline names the graph node',
            any(c.get('id') == node_id for c in (pipeline or {}).get('components', [])),
        )

        d = await call(client, token, node_id, 'dialect', {})
        rep.check('dialect', d.get('dialect') == engine, d)
        caps = d.get('capabilities') or {}
        rep.check(
            'dialect advertises read_query + refresh_schema',
            bool(caps.get('read_query')) and bool(caps.get('refresh_schema')),
            caps,
        )
        rep.check('dialect reports allow_execute false', d.get('allow_execute') is False, d.get('allow_execute'))
        secrets = [x for x in (urlparse(AGE_ADMIN_DSN).password, NEO4J[2], 'postgresql://') if x]
        rep.check('dialect carries no credentials', all(s not in json.dumps(d) for s in secrets), None)
        limits = d.get('limits') or {}

        s = await call(client, token, node_id, 'get_schema', {})
        sch = s.get('schema') or {}
        labels = {lab['name'] for lab in sch.get('labels', [])}
        rep.check('get_schema v2 lists Person', 'Person' in labels, sorted(labels)[:8])
        rep.check('get_schema keeps legacy keys', 'nodes' in s and 'relationships' in s)

        # Scalars, duplicate columns.
        if engine == 'age':
            # AGE accepts a repeated column name; rows must keep both positionally.
            r = await call(client, token, node_id, 'read_query', {'cypher': 'RETURN 1 AS a, 2 AS a', 'limit': 10})
            rep.check(
                'duplicate columns survive positionally',
                r.get('columns') == ['a', 'a'] and r.get('rows') == [[1, 2]],
                r,
            )
        else:
            # Neo4j and FalkorDB refuse repeated column names server-side; the
            # refusal must arrive as a clean headline + database detail.
            msg = await expect_refusal(
                client, token, node_id, 'read_query', {'cypher': 'RETURN 1 AS a, 2 AS a', 'limit': 10}
            )
            rep.check(
                'server refusal of duplicate columns is headline + detail',
                '\n' in msg and 'same name' in msg,
                msg[:160],
            )
        r = await call(client, token, node_id, 'read_query', {'cypher': 'RETURN 1 AS a, 2 AS b', 'limit': 10})
        rep.check('scalar row positional', r.get('columns') == ['a', 'b'] and r.get('rows') == [[1, 2]], r)
        rep.check(
            'envelope fields present',
            all(
                k in r
                for k in (
                    'row_limit',
                    'truncated',
                    'truncated_by',
                    'element_limit',
                    'elements',
                    'value_limit',
                    'values',
                )
            ),
            sorted(r),
        )

        # Graph values and a path with direction.
        r = await call(
            client,
            token,
            node_id,
            'read_query',
            {'cypher': "MATCH p = (a:Person {name: 'Ada GX'})-[:KNOWS*2]->(c) RETURN p", 'limit': 10},
        )
        paths = graph_values(r.get('rows'), 'path')
        ok = bool(paths) and [n['properties'].get('name') for n in paths[0]['nodes']] == [
            'Ada GX',
            'Charles GX',
            'Grace GX',
        ]
        rep.check('path keeps traversal order', ok, r.get('rows'))
        if paths:
            rels = paths[0]['relationships']
            nodes = paths[0]['nodes']
            rep.check(
                'path relationships keep stored direction',
                all(
                    rels[i]['start'] == nodes[i]['id'] and rels[i]['end'] == nodes[i + 1]['id']
                    for i in range(len(rels))
                ),
            )
            rep.check(
                'ids are strings',
                all(isinstance(n['id'], str) for n in nodes) and all(isinstance(x['id'], str) for x in rels),
            )

        # Reverse traversal keeps stored direction.
        r = await call(
            client,
            token,
            node_id,
            'read_query',
            {'cypher': "MATCH (g:Person {name: 'Grace GX'})<-[k:KNOWS]-(c) RETURN k, c", 'limit': 10},
        )
        rels = graph_values(r.get('rows'), 'relationship')
        nodes = graph_values(r.get('rows'), 'node')
        rep.check(
            'reverse traversal keeps stored start/end',
            bool(rels) and rels[0]['end'] != nodes[0]['id'] if nodes else False,
            r.get('rows'),
        )

        # Id round trip as a bound parameter (unsafe ids on AGE).
        scope = run_scope(engine)
        r = await call(client, token, node_id, 'read_query', {'cypher': f'MATCH (n{scope}) RETURN n', 'limit': 100})
        all_nodes = graph_values(r.get('rows'), 'node')
        if engine == 'age':
            rep.check(
                'AGE ids exceed 2^53 and stay exact',
                any(int(n['id']) > MAX_SAFE for n in all_nodes),
                [n['id'] for n in all_nodes[:3]],
            )
        target = max(all_nodes, key=lambda n: int(n['id']) if n['id'].isdigit() else 0) if all_nodes else None
        if target is not None:
            q = (
                'MATCH (n) WHERE elementId(n) = $id RETURN n'
                if engine == 'neo4j'
                else 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n'
            )
            r = await call(
                client, token, node_id, 'read_query', {'cypher': q, 'params': {'id': target['id']}, 'limit': 5}
            )
            got = graph_values(r.get('rows'), 'node')
            rep.check(
                'id round-trips as a bound parameter', len(got) == 1 and got[0]['id'] == target['id'], target['id']
            )

        # Row limit / truncation at the exact cap.
        r = await call(client, token, node_id, 'read_query', {'cypher': 'UNWIND range(1, 5) AS x RETURN x', 'limit': 5})
        rep.check('exact cap is not truncated', len(r.get('rows', [])) == 5 and r.get('truncated') is False, r)
        r = await call(client, token, node_id, 'read_query', {'cypher': 'UNWIND range(1, 6) AS x RETURN x', 'limit': 5})
        rep.check(
            'one past the cap is truncated by rows',
            len(r.get('rows', [])) == 5 and r.get('truncated') is True and r.get('truncated_by') == 'rows',
            r,
        )

        # Writes refused on the read path, proved by state.
        before = admin.count()
        intruders_before = admin.count('Intruder')
        for stmt in write_probes(engine):
            msg = await expect_refusal(client, token, node_id, 'read_query', {'cypher': stmt, 'limit': 5})
            rep.check(f'read_query refuses {stmt.split()[0]}', bool(msg), msg[:120])
        if engine == 'neo4j':
            msg = await expect_refusal(
                client, token, node_id, 'read_query', {'cypher': "CALL db.createLabel('Intruder')", 'limit': 5}
            )
            rep.check('read_query refuses non-allowlisted CALL', 'Refused' in msg or 'not allowed' in msg, msg[:120])
        after = admin.count()
        intruders_after = admin.count('Intruder')
        flagged = admin.run(f"MATCH (n:Person{scope}) WHERE n.flag = true AND n.name ENDS WITH ' GX' RETURN count(n)")
        rep.check(
            'database unchanged after refused writes',
            before == after and intruders_before == intruders_after and str(flagged[0]).split('::')[0] in ('0', 'None'),
            (before, after, intruders_before, intruders_after, flagged),
        )

        # execute refused with allow_execute off.
        msg = await expect_refusal(client, token, node_id, 'execute', {'query': execute_probe(engine)})
        rep.check('execute refused with allow_execute off', 'allow_execute' in msg, msg[:120])
        rep.check(
            'database unchanged after refused execute',
            admin.count() == after and admin.count('Intruder') == intruders_after,
        )

        # Schema refresh observes a change made outside the node.
        fresh = f'Fresh{uuid.uuid4().hex[:8]}'  # unique per run: no earlier run can have it
        admin.run(f'CREATE (:{fresh}{scope} {{added: true}})')
        sch_before = {
            lab['name']
            for lab in ((await call(client, token, node_id, 'get_schema', {})).get('schema') or {}).get('labels', [])
        }
        fr = await call(client, token, node_id, 'refresh_schema', {}, timeout=70_000)
        fresh_labels = {lab['name'] for lab in (fr.get('schema') or fr).get('labels', [])}
        rep.check('get_schema serves the snapshot until refresh', fresh not in sch_before, sorted(sch_before)[:6])
        rep.check('refresh_schema publishes the new label', fresh in fresh_labels, sorted(fresh_labels)[:8])
        rep.check('refresh_schema stamps refreshed_at', bool((fr.get('schema') or fr).get('refreshed_at')))

        # Invalid input is rejected, not executed.
        for bad in ({}, {'cypher': ''}, {'cypher': 'RETURN 1', 'limit': True}, {'cypher': 'RETURN 1', 'params': []}):
            try:
                await call(client, token, node_id, 'read_query', bad)
                rep.check(f'invalid input refused {bad}', False)
            except CommandException as e:
                rep.check(f'invalid input refused {sorted(bad)}', True, str(e)[:80])
        _ = limits
    finally:
        await client.terminate(started['token'])
    return rep


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--uri', default=E.ENGINE_URL)
    ap.add_argument('--engine', default='all', choices=['all', 'age', 'neo4j', 'falkordb'])
    ap.add_argument(
        '--pipe-dir', default='', help='directory with the shipped templates (age.pipe, neo4j.pipe, falkordb.pipe)'
    )
    ap.add_argument('--json', default='')
    args = ap.parse_args()
    engines = ['age', 'neo4j', 'falkordb'] if args.engine == 'all' else [args.engine]
    rows: List[Dict[str, Any]] = []
    async with RocketRideClient(uri=args.uri, auth=E.API_KEY) as client:
        for engine in engines:
            pipe = None
            if args.pipe_dir:
                pipe = json.loads((Path(args.pipe_dir) / f'{engine}.pipe').read_text())
                pipe = pipe.get('pipeline', pipe)
            print(f'== {engine}', flush=True)
            rep = Report(engine)
            try:
                await run_engine(client, engine, pipe, rep)
            except Exception as e:  # noqa: BLE001 - a crash is a FAIL row, never a skip
                rep.check('run completed', False, f'{type(e).__name__}: {e}')
            rows.extend(rep.rows)
    failed = [r for r in rows if r['status'] != 'PASS']
    print(f'== {len(rows) - len(failed)} passed, {len(failed)} failed')
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1, default=str))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
