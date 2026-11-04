# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task.
#
# Sits on the shared store base like store_postgres, differing only in how it
# connects: there are no host/user/password fields; the task engine delivers
# the authorized DSN for this node's scope / target. The base supplies the lifecycle (open the
# store outside CONFIG mode, wire the tool-path embedder, register the
# transform key) and, through StoreInstanceBase, the agent tools.
#
# The table is the team's managed database, so the whole tool surface is
# opt-in through the expose_tools setting (off by default), and the write tools
# (upsert, delete, soft_delete, restore) also need the allow_write setting (off
# by default). The data lanes are always available.
# ------------------------------------------------------------------------------
import os
import re
from typing import Any, Dict

from rocketlib import warning

from ai.common.rocketride_db import DsnNotDelivered, db_target, resolve_rocketride_dsn
from ai.common.store import StoreGlobalBase

# Valid unquoted PostgreSQL identifier: letter/underscore start, alphanumeric/underscore body, max 63 chars
VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


class IGlobal(StoreGlobalBase):
    serverName: str = 'rrvector'

    # Read by VectorStoreToolMixin when the engine lists or dispatches tools.
    # The base resolves the rrvector.expose_tools setting at start; this class
    # default keeps the tool surface off when nothing is configured, because
    # objdir and get together return the whole table of the team's managed
    # database to any caller of the pipeline's tool path.
    expose_tools: bool = False

    # Read by VectorStoreToolMixin before a write tool runs. The base resolves
    # the rrvector.allow_write setting at start; this class default keeps
    # writes off when nothing is configured.
    allow_write: bool = False

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .rocketride_vector import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key, scoped by tenant.

        The resolved DSN points at the per-tenant database, so key on that
        database: the store must not be shared across tenants even when the
        pooler host/port are identical. (Identity rides the task file since
        #1686; env identity is untrusted, and the tenant DB is the actual
        isolation unit.)
        """
        tenant_scope = self.store.database or f'{self.store.host}:{self.store.port}'
        return f'{tenant_scope}/{self.store.collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Validate the RocketRide cloud vector store config with fast, read-only probes.

        - Enforce a safe unquoted identifier for the table (collection).
        - Check scope / target. Outside a task no DSN is delivered, so stop
          there: connectivity is checked when the pipeline runs.
        - Inside a task, connect with a short timeout, run SELECT 1.
        - Verify pgvector availability via ``SELECT NULL::vector``.
        - Surface raw provider errors without truncation.
        """
        try:
            # Support legacy key 'collection' if the UI still sends it
            table = ((config.get('table') or config.get('collection')) or '').strip()

            # Table name validation: unquoted identifier rules, total ≤63 chars
            if not VALID_TABLE.fullmatch(table or ''):
                warning(
                    'Table name must be ≤63 chars; start with letter/underscore; only letters, digits, underscore; no spaces or special characters (- . / \\ \' " ` ( ) [ ] { } , ; : * + = | & # @ % ^ ! ? ~ $)'
                )
                return

            # No host/user/password fields: read the delivered DSN.
            try:
                dsn = resolve_rocketride_dsn(*db_target(config))
            except DsnNotDelivered:
                return

            # Load deps on demand: in CONFIG mode beginGlobal never imports
            # .rocketride_vector (where the node's other depends() lives), so
            # this is the only thing that installs the driver at save time —
            # same pattern as store_postgres and the other DB nodes.
            from depends import depends  # type: ignore

            depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

            import psycopg2  # type: ignore

            conn = None
            try:
                # Connect quickly; surface auth/host/db errors
                conn = psycopg2.connect(dsn, connect_timeout=3)
                with conn.cursor() as cur:
                    # Minimal probe
                    cur.execute('SELECT 1')
                    # Explicit type check - surfaces provider error if pgvector is not installed
                    cur.execute('SELECT NULL::vector')
                    cur.fetchone()
            finally:
                try:
                    if conn is not None:
                        conn.close()
                except Exception:
                    pass
        except Exception as e:
            warning(_format_error(e))


def _format_error(e: Exception) -> str:
    """Concise error string for psycopg2 exceptions.

    psycopg2 errors carry SQL fragment + caret context on subsequent lines
    that are noisy in an LLM transcript, so we keep only the first line of
    the message. Anything else (including the case where ``psycopg2`` is
    not installed) falls back to ``str(e).strip()``.
    """
    try:
        from psycopg2 import OperationalError, ProgrammingError  # type: ignore
        import socket

        if isinstance(e, (OperationalError, ProgrammingError, socket.timeout)):
            msg = str(e).strip()
            return msg.splitlines()[0] if msg else msg
    except Exception:
        pass
    return str(e).strip()
