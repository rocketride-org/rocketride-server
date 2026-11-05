# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Settings for the Graph Explorer acceptance scripts, read from the environment.

Every default below points at a disposable local container started for these
lanes (see README.md). The credentials are throwaway LOCAL-ONLY test values for
those containers, not secrets: never point these scripts at a database that
holds data you care about, and never reuse these values anywhere else.
"""

import os

# Engine under test. An OSS engine started without ROCKETRIDE_APIKEY accepts any
# non-empty key, so RR_TEST_APIKEY is a local label, not a credential.
ENGINE_URL = os.environ.get('ENGINE_URL', 'http://127.0.0.1:5580')
API_KEY = os.environ.get('RR_TEST_APIKEY', 'local-acceptance-key')

# Apache AGE (rocketride_graph reaches it through the DB broker; the scripts use
# this DSN only to seed and to measure state).
AGE_DSN = os.environ.get('AGE_DSN', 'postgresql://rruser:rrpass@127.0.0.1:55433/rrtenant')

# Neo4j (one database: every node an acceptance run seeds carries RUN_LABEL).
NEO4J_URI = os.environ.get('NEO4J_URI', 'bolt://127.0.0.1:57687')
NEO4J_USER = os.environ.get('NEO4J_USER', 'neo4j')
NEO4J_PASSWORD = os.environ.get('NEO4J_PASSWORD', 'gxlocal-test-pass')

# FalkorDB.
FALKORDB_HOST = os.environ.get('FALKORDB_HOST', '127.0.0.1')
FALKORDB_PORT = int(os.environ.get('FALKORDB_PORT', '56379'))

# Postgres with pgvector, for the SQL Explorer fixtures.
SQL_HOST = os.environ.get('SQL_HOST', '127.0.0.1:55432')
SQL_USER = os.environ.get('SQL_USER', 'rruser')
SQL_PASSWORD = os.environ.get('SQL_PASSWORD', 'rrpass')
SQL_DATABASE = os.environ.get('SQL_DATABASE', 'rrtenant')
SQL_TABLE = os.environ.get('SQL_TABLE', 'gx_items')

# Namespacing, so concurrent runs against the same containers do not collide.
ACCEPT_GRAPH = os.environ.get('ACCEPT_GRAPH', 'gx_accept')
RUN_LABEL = os.environ.get('RUN_LABEL', 'GxAcc')
PERF_GRAPH = os.environ.get('PERF_GRAPH', 'gx_perf')
# FalkorDB graph of the write-enabled fixture, the only fixture that can write (lane_graph's write console steps).
WRITE_GRAPH = os.environ.get('WRITE_GRAPH', 'gx_accept_write')
DEMO_GRAPH = os.environ.get('DEMO_GRAPH', 'gx_demo')
DEMO_SQL_PREFIX = os.environ.get('DEMO_SQL_PREFIX', 'demo_')


def sql_dsn() -> str:
    """Return a libpq DSN for the SQL fixture database."""
    host, _, port = SQL_HOST.partition(':')
    return f'postgresql://{SQL_USER}:{SQL_PASSWORD}@{host}:{port or "5432"}/{SQL_DATABASE}'


# The tools-only source every fixture pipeline starts from.
TOOLS_SOURCE = {
    'id': 'tools_1',
    'provider': 'tools',
    'name': 'Tools',
    'config': {'mode': 'Source', 'type': 'tools', 'name': 'Tools', 'parameters': {}},
}
