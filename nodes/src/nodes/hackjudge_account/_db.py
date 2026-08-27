"""Postgres helper for the hackjudge_* nodes.

Connection-per-operation keeps the node safe under concurrent instance calls
without shared-connection locking; the workload is modest (B2B judging traffic).
psycopg2 is imported lazily so the module can be imported before depends() has
installed the node's requirements (same pattern as db_postgres).
"""

from __future__ import annotations

import os


def resolve_dsn(cfg: dict, conn_config: dict) -> str:
    dsn = str(cfg.get('database_url') or '').strip()
    if not dsn:
        dsn = str(conn_config.get('database_url') or '').strip()
    if not dsn:
        # only the node's own variable: a generic DATABASE_URL in the engine's
        # environment likely points at an unrelated database, and silently
        # writing tenants there is far worse than failing closed here
        dsn = str(os.environ.get('HACKJUDGE_DATABASE_URL') or '').strip()
    return dsn


class Db:
    """Run a function against a fresh connection inside one transaction."""

    def __init__(self, dsn: str):
        self.dsn = dsn

    def run(self, fn):
        import psycopg2
        import psycopg2.extras

        conn = psycopg2.connect(self.dsn)
        try:
            with conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    return fn(cur)
        finally:
            conn.close()
