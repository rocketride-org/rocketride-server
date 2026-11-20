# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""G0-5: the disposable stores answer, and the clients the engine ships connect to them.

- ``vx-qdrant``: ``/healthz`` passes, the pinned version answers, and
  ``qdrant_client`` lists collections.
- ``vx-chroma``: the heartbeat answers and ``chromadb.HttpClient`` reaches it.
- ``vx-pgbouncer`` (transaction pooler in front of ``gx-pgvector``): ``psycopg2``
  and ``psql`` reach ``rrtenant`` through it, with pgvector installed.

Every default is a throwaway LOCAL-ONLY value for a disposable container.
A missing ``psql`` binary is the only skip, and it says NOT RUN.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.request
from typing import Any

import pytest

from phase0_lib import record

pytestmark = pytest.mark.timeout(300)

QDRANT_HOST = os.environ.get('VX_QDRANT_HOST', '127.0.0.1')
QDRANT_PORT = int(os.environ.get('VX_QDRANT_PORT', '56333'))
QDRANT_VERSION = os.environ.get('VX_QDRANT_VERSION', '1.17.1')
CHROMA_HOST = os.environ.get('VX_CHROMA_HOST', '127.0.0.1')
CHROMA_PORT = int(os.environ.get('VX_CHROMA_PORT', '58000'))
POOLER_DSN = os.environ.get('RR_TEST_PGVECTOR_POOLER_DSN', 'postgresql://rruser:rrpass@127.0.0.1:56434/rrtenant')
PGVECTOR_VERSION = os.environ.get('VX_PGVECTOR_VERSION', '0.8.0')


def _get(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=10) as response:  # noqa: S310 - fixed local URL
        body = response.read().decode('utf-8')
    try:
        return json.loads(body)
    except ValueError:
        return body


def test_qdrant_answers_health_and_the_client_connects():
    """vx-qdrant passes /healthz, reports the pinned version, and qdrant_client lists collections."""
    health = _get(f'http://{QDRANT_HOST}:{QDRANT_PORT}/healthz')
    root = _get(f'http://{QDRANT_HOST}:{QDRANT_PORT}/')
    assert 'passed' in str(health)
    assert root['version'] == QDRANT_VERSION

    from qdrant_client import QdrantClient

    qdrant = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=10)
    collections = qdrant.get_collections().collections
    record('g0_5_qdrant', {'health': health, 'version': root['version'], 'collections': len(collections)})


def test_chroma_answers_heartbeat_and_the_client_connects():
    """vx-chroma answers its heartbeat over HTTP and through chromadb.HttpClient."""
    beat = _get(f'http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/heartbeat')
    assert isinstance(beat, dict) and beat.get('nanosecond heartbeat')

    import chromadb

    chroma = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    assert chroma.heartbeat() > 0
    record('g0_5_chroma', {'heartbeat': True, 'client': chromadb.__version__})


def test_pgvector_through_the_transaction_pooler_with_psycopg2():
    """psycopg2 reaches rrtenant through vx-pgbouncer, and the vector extension is there."""
    import psycopg2

    connection = psycopg2.connect(POOLER_DSN, connect_timeout=10)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database(), (SELECT extversion FROM pg_extension WHERE extname = 'vector')")
            database, version = cursor.fetchone()
        connection.rollback()
    finally:
        connection.close()
    assert database == 'rrtenant'
    assert version == PGVECTOR_VERSION
    record('g0_5_pooler', {'database': database, 'pgvector': version})


def test_pgvector_through_the_transaction_pooler_with_psql():
    """The psql command line reaches rrtenant through vx-pgbouncer."""
    psql = shutil.which('psql')
    if psql is None:
        pytest.skip('NOT RUN: psql is not installed on this machine')
    done = subprocess.run(
        [psql, POOLER_DSN, '-Atc', 'SELECT current_database()'],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, 'PGCONNECT_TIMEOUT': '10'},
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip().splitlines()[-1] == 'rrtenant'
