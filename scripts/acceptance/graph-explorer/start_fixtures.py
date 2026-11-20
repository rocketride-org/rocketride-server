# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Start long-lived tools pipelines for the browser lanes (local disposable databases only).

Starts SQL pipelines (db_postgres, db_supabase, rocketride_sql), one tools-only
graph pipeline per engine (execute off), and one write-enabled FalkorDB pipeline
on its own graph (WRITE_GRAPH, default gx_accept_write) for the write console
steps of browser/lane_graph.cjs. Each has a fixed local-only project id so reruns
reuse them; the script then exits and leaves the tasks running. Before starting,
it makes sure the SQL fixture table (SQL_TABLE, default gx_items) exists with 25
rows and that WRITE_GRAPH exists (created empty); it never drops or rewrites an
existing table or graph. Prints names and project ids only, never tokens.
``--stop`` terminates the fixtures.

Run graph_acceptance.py first: it seeds the ACCEPT_GRAPH graphs these fixtures
read. Run browser/gen_perf.py first too: the perf fixture does not start until
PERF_GRAPH exists (rerunning this script then starts only what is missing).

Usage (from dist/server): ./engine <this folder>/start_fixtures.py [--stop]
Settings come from the environment; see local_env.py.
"""

import asyncio
import sys

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_env as E  # noqa: E402 - after the sys.path line above
from rocketride import RocketRideClient  # noqa: E402

SQL = {
    'host': E.SQL_HOST,
    'user': E.SQL_USER,
    'password': E.SQL_PASSWORD,
    'database': E.SQL_DATABASE,
    'table': E.SQL_TABLE,
}
NEO4J = {'uri': E.NEO4J_URI, 'user': E.NEO4J_USER, 'password': E.NEO4J_PASSWORD}
FALKOR = {'host': E.FALKORDB_HOST, 'port': E.FALKORDB_PORT}

# (display name, fixed local-only project id, provider, node config). The browser
# lanes find the fixtures by these display names (env.cjs FIXTURES).
FIXTURES = [
    ('gx-local SQL (pgvector)', '00000000-0000-4000-8000-00000000c501', 'db_postgres', {**SQL, 'allow_execute': False}),
    (
        'gx-local Graph (AGE)',
        '00000000-0000-4000-8000-00000000a6e1',
        'rocketride_graph',
        {'graph': E.ACCEPT_GRAPH, 'allow_execute': False},
    ),
    (
        'gx-local Graph (Neo4j)',
        '00000000-0000-4000-8000-00000000e041',
        'graph_neo4j',
        {**NEO4J, 'allow_execute': False},
    ),
    (
        'gx-local SQL write-enabled (pgvector)',
        '00000000-0000-4000-8000-00000000c502',
        'db_postgres',
        {**SQL, 'allow_execute': True},
    ),
    (
        'gx-local Supabase preset (pgvector)',
        '00000000-0000-4000-8000-00000000c503',
        'db_supabase',
        {**SQL, 'allow_execute': False},
    ),
    (
        'gx-local RocketRide SQL (fake broker)',
        '00000000-0000-4000-8000-00000000c504',
        'rocketride_sql',
        {'allow_execute': False, 'table': E.SQL_TABLE},
    ),
    (
        'gx-local Graph perf (FalkorDB)',
        '00000000-0000-4000-8000-00000000fa1d',
        'graph_falkordb',
        {**FALKOR, 'graph': E.PERF_GRAPH, 'allow_execute': False},
    ),
    (
        'gx-local Graph (FalkorDB)',
        '00000000-0000-4000-8000-00000000fa1c',
        'graph_falkordb',
        {**FALKOR, 'graph': E.ACCEPT_GRAPH, 'allow_execute': False},
    ),
    # The only graph fixture that can write: the write console steps run their CREATE
    # here and delete what they wrote. Its own graph, never ACCEPT_GRAPH.
    (
        'gx-local Graph write-enabled (FalkorDB)',
        '00000000-0000-4000-8000-00000000fa1e',
        'graph_falkordb',
        {**FALKOR, 'graph': E.WRITE_GRAPH, 'allow_execute': True},
    ),
]


def ensure_sql_table() -> None:
    """Create the SQL fixture table with rows 'item 1'..'item 25' when it does not exist yet."""
    import psycopg2
    from psycopg2 import sql

    conn = psycopg2.connect(E.sql_dsn())
    try:
        with conn, conn.cursor() as cur:
            cur.execute('SELECT to_regclass(%s)', (E.SQL_TABLE,))
            if cur.fetchone()[0] is not None:
                print(f'sql table {E.SQL_TABLE} exists (left unchanged)')
                return
            table = sql.Identifier(E.SQL_TABLE)
            cur.execute(sql.SQL('CREATE TABLE {} (id serial PRIMARY KEY, name text, qty integer)').format(table))
            cur.execute(
                sql.SQL("INSERT INTO {} (name, qty) SELECT 'item ' || g, g FROM generate_series(1, 25) g").format(table)
            )
            print(f'sql table {E.SQL_TABLE} created with 25 rows')
    finally:
        conn.close()


def ensure_write_graph() -> None:
    """Create WRITE_GRAPH empty when it does not exist yet; never change an existing one.

    FalkorDB refuses a read on a graph nothing has written to yet ("Invalid graph
    operation on empty key"), so the write-enabled fixture needs the graph to exist
    before the workbench can read its schema.
    """
    from falkordb import FalkorDB

    try:
        db = FalkorDB(host=E.FALKORDB_HOST, port=E.FALKORDB_PORT)
        if E.WRITE_GRAPH in db.list_graphs():
            print(f'falkordb graph {E.WRITE_GRAPH} exists (left unchanged)')
            return
        db.select_graph(E.WRITE_GRAPH).query('CREATE (n) DELETE n')
        print(f'falkordb graph {E.WRITE_GRAPH} created (empty)')
    except Exception as e:  # noqa: BLE001 - the other fixtures still start
        # Without FalkorDB only its fixtures fail (each on its own line below);
        # the SQL, AGE and Neo4j fixtures still start.
        print(f'FAILED falkordb graph {E.WRITE_GRAPH}: {type(e).__name__}: {str(e)[:200]}')


def pipeline(name, project_id, provider, cfg):
    return {
        'name': name,
        'project_id': project_id,
        'components': [
            E.TOOLS_SOURCE,
            {
                'id': f'{provider}_1',
                'provider': provider,
                'name': name.split('(')[-1].rstrip(')'),
                'config': {'profile': 'default', 'default': cfg, 'name': provider},
                'control': [{'classType': 'tool', 'from': 'tools_1'}],
            },
        ],
    }


async def main():
    stop = '--stop' in sys.argv
    if not stop:
        ensure_sql_table()
        ensure_write_graph()
    async with RocketRideClient(uri=E.ENGINE_URL, auth=E.API_KEY) as client:
        running = {(t.get('pipeline') or {}).get('project_id'): t for t in await client.get_tasks()}
        for name, pid, provider, cfg in FIXTURES:
            if stop:
                if pid in running:
                    await client.terminate(running[pid]['token'])
                    print(f'stopped {name}')
                continue
            if pid in running:
                print(f'running {name} ({pid})')
                continue
            try:
                # ttl=0: run until --stop. The engine stops a task that is idle for its
                # TTL (15 minutes by default), so a lane run later would find it gone.
                await client.use(pipeline=pipeline(name, pid, provider, cfg), source='tools_1', ttl=0)
                print(f'started {name} ({pid})')
            except Exception as e:  # noqa: BLE001
                print(f'FAILED {name}: {type(e).__name__}: {str(e)[:200]}')


if __name__ == '__main__':
    asyncio.run(main())
