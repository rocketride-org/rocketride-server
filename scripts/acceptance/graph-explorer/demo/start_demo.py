# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Start demo tools pipelines on a local engine, for product screenshots only.

Local disposable containers and throwaway local-only test values (see
../local_env.py); prints names only. Run seed_demo.sh first, and
../browser/gen_perf.py 300 for the large-graph pipeline.

Usage (from dist/server): ./engine <this folder>/start_demo.py
"""

import asyncio
import sys

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import local_env as E  # noqa: E402 - after the sys.path line above
from rocketride import RocketRideClient  # noqa: E402

URI = E.ENGINE_URL
TOOLS = E.TOOLS_SOURCE
PG = {
    'host': E.SQL_HOST,
    'user': E.SQL_USER,
    'password': E.SQL_PASSWORD,
    'database': E.SQL_DATABASE,
    'table': f'{E.DEMO_SQL_PREFIX}orders',
}
FALKOR = {'host': E.FALKORDB_HOST, 'port': E.FALKORDB_PORT}

DEMO = [
    (
        'Team graph (FalkorDB)',
        '00000000-0000-4000-8000-00000000d001',
        'graph_falkordb',
        {**FALKOR, 'graph': E.DEMO_GRAPH, 'allow_execute': False},
    ),
    (
        'Team graph (Apache AGE)',
        '00000000-0000-4000-8000-00000000d002',
        'rocketride_graph',
        {'graph': E.DEMO_GRAPH, 'allow_execute': False},
    ),
    (
        'Team graph (Neo4j)',
        '00000000-0000-4000-8000-00000000d003',
        'graph_neo4j',
        {'uri': E.NEO4J_URI, 'user': E.NEO4J_USER, 'password': E.NEO4J_PASSWORD, 'allow_execute': False},
    ),
    (
        'Team graph admin (FalkorDB, writes allowed)',
        '00000000-0000-4000-8000-00000000d004',
        'graph_falkordb',
        {**FALKOR, 'graph': E.DEMO_GRAPH, 'allow_execute': True},
    ),
    (
        'Large graph, 300 nodes (FalkorDB)',
        '00000000-0000-4000-8000-00000000d005',
        'graph_falkordb',
        {**FALKOR, 'graph': E.PERF_GRAPH, 'allow_execute': False},
    ),
    ('Sales DB (Postgres)', '00000000-0000-4000-8000-00000000d101', 'db_postgres', {**PG, 'allow_execute': False}),
    (
        'Sales DB admin (Postgres, writes allowed)',
        '00000000-0000-4000-8000-00000000d102',
        'db_postgres',
        {**PG, 'allow_execute': True},
    ),
    (
        'Sales DB (Supabase preset)',
        '00000000-0000-4000-8000-00000000d103',
        'db_supabase',
        {**PG, 'allow_execute': False},
    ),
    (
        'Tenant DB (RocketRide SQL)',
        '00000000-0000-4000-8000-00000000d104',
        'rocketride_sql',
        {'allow_execute': False, 'table': E.SQL_TABLE},
    ),
]


def pipeline(name, project_id, provider, cfg):
    return {
        'name': name,
        'project_id': project_id,
        'components': [
            TOOLS,
            {
                'id': f'{provider}_1',
                'provider': provider,
                'name': name,
                'config': {'profile': 'default', 'default': cfg, 'name': provider},
                'control': [{'classType': 'tool', 'from': 'tools_1'}],
            },
        ],
    }


async def main():
    async with RocketRideClient(uri=URI, auth=E.API_KEY) as client:
        running = {(t.get('pipeline') or {}).get('project_id') for t in await client.get_tasks()}
        for name, pid, provider, cfg in DEMO:
            if pid in running:
                print(f'running {name}')
                continue
            try:
                # ttl=0: run until --stop. The engine stops a task that is idle for its
                # TTL (15 minutes by default), so a lane run later would find it gone.
                await client.use(pipeline=pipeline(name, pid, provider, cfg), source='tools_1', ttl=0)
                print(f'started {name}')
            except Exception as e:  # noqa: BLE001
                print(f'FAILED {name}: {type(e).__name__}: {str(e)[:200]}')


asyncio.run(main())
