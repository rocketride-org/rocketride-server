# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Check that the live test databases run the server versions the wire captures were taken on.

``test_graph_wire_fixtures_full.py`` (run by ``nodes:test`` and ``nodes:test-db``)
compares the graph tools' output exactly with the committed captures in
``apps/graph-ui/tests/fixtures/v1/live``, including each server's version and its
own error text. CI starts exactly those servers (images pinned by digest in
``nodes/test/db-services/graph.sh``; README.md here starts the same images). On a
container made from a newer image that suite fails with "regenerate the
fixtures", which would be the wrong fix: this check names the real cause first.

It reads the servers the node suites use, with the same variables and defaults:
``RR_TEST_NEO4J_URI`` / ``_USER`` / ``_PASSWORD``, ``RR_TEST_FALKORDB_URL`` and
``RR_TEST_AGE_DSN``. It prints one line per engine (no credentials) and exits 1
when a server is unreachable or reports another version or edition.

Usage (from dist/server): ./engine <this folder>/check_db_versions.py
"""

import json
import os
import sys

from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parents[3]
CAPTURES = REPO / 'apps' / 'graph-ui' / 'tests' / 'fixtures' / 'v1' / 'live'
ENGINES = ('neo4j', 'falkordb', 'age')

# The node suites' defaults (nodes/test/test_graph_neo4j_full.py, test_graph_falkordb_full.py,
# test_rocketride_graph_full.py): the local containers from README.md.
NEO4J_URI = os.environ.get('RR_TEST_NEO4J_URI', 'bolt://127.0.0.1:57687')
NEO4J_USER = os.environ.get('RR_TEST_NEO4J_USER', 'neo4j')
NEO4J_PASSWORD = os.environ.get('RR_TEST_NEO4J_PASSWORD', 'gxlocal-test-pass')
FALKORDB_URL = os.environ.get('RR_TEST_FALKORDB_URL', 'redis://127.0.0.1:56379')
AGE_DSN = os.environ.get('RR_TEST_AGE_DSN', 'postgresql://rruser:rrpass@localhost:55433/rrtenant')

Server = Tuple[Optional[str], Optional[str]]  # (version, edition)


def expected_versions(captures: Path = CAPTURES) -> Dict[str, Dict[str, Optional[str]]]:
    """The version and edition each engine's committed dialect capture records."""
    out = {}
    for engine in ENGINES:
        identity = json.loads((captures / f'{engine}_dialect.json').read_text())['engine']
        out[engine] = {'version': identity.get('version'), 'edition': identity.get('edition')}
    return out


def neo4j_server() -> Server:
    """Version and edition as the graph_neo4j node reads them (dbms.components)."""
    import neo4j

    with neo4j.GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD)) as driver:
        records, _, _ = driver.execute_query('CALL dbms.components() YIELD versions, edition RETURN versions, edition')
    versions = records[0]['versions'] or []
    return (str(versions[0]) if versions else None, str(records[0]['edition'] or '').lower() or None)


def falkordb_server() -> Server:
    """The graph module version as the graph_falkordb node reads it (MODULE LIST)."""
    from falkordb import FalkorDB

    url = urlparse(FALKORDB_URL)
    db = FalkorDB(host=url.hostname or '127.0.0.1', port=url.port or 6379, password=url.password)
    for module in db.connection.execute_command('MODULE', 'LIST') or []:
        fields = dict(zip(module[0::2], module[1::2]))
        if fields.get('name', fields.get(b'name')) in ('graph', b'graph'):
            ver = int(fields.get('ver', fields.get(b'ver')))
            return (f'{ver // 10000}.{ver // 100 % 100}.{ver % 100}', None)
    return (None, None)


def age_server() -> Server:
    """The AGE extension version as the rocketride_graph node reads it (pg_extension)."""
    import psycopg2

    conn = psycopg2.connect(AGE_DSN, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'age'")
            row = cur.fetchone()
    finally:
        conn.close()
    return (row[0] if row else None, None)


def compare(expected: Dict[str, Dict[str, Optional[str]]], actual: Dict[str, Union[Server, Exception]]) -> List[str]:
    """One sentence per engine whose server is unreachable or differs from its capture."""
    problems = []
    for engine, want in expected.items():
        got = actual.get(engine)
        wanted = ' '.join(filter(None, (want['version'], want['edition'])))
        if isinstance(got, Exception) or got is None:
            problems.append(f'{engine}: could not read the server version ({got}); the captures expect {wanted}')
        elif (got[0], got[1]) != (want['version'], want['edition']):
            seen = ' '.join(filter(None, got)) or 'no version'
            problems.append(
                f'{engine}: the server reports {seen}, the committed captures and CI use {wanted}: '
                'recreate the container from the image in README.md (the one nodes/test/db-services/graph.sh pins); '
                'do not regenerate the fixtures'
            )
    return problems


def main() -> int:
    """Read every server, compare, print one line per engine."""
    expected = expected_versions()
    readers = {'neo4j': neo4j_server, 'falkordb': falkordb_server, 'age': age_server}
    actual: Dict[str, Union[Server, Exception]] = {}
    for engine in ENGINES:
        try:
            actual[engine] = readers[engine]()
        except Exception as e:  # noqa: BLE001 - reported as a problem below
            actual[engine] = RuntimeError(f'{type(e).__name__}: {str(e).splitlines()[0][:200] if str(e) else ""}')
    problems = compare(expected, actual)
    for engine in ENGINES:
        mine = [p for p in problems if p.startswith(f'{engine}:')]
        print(mine[0] if mine else f'{engine}: {" ".join(filter(None, actual[engine]))} (as the captures expect)')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
