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
# Mirrors vectordb_postgres/IGlobal, differing only in how it connects: there
# are no host/user/password fields; the per-tenant DSN is resolved from the
# account layer (keyed by the authenticated client_id).
# ------------------------------------------------------------------------------
import re
from rocketlib import OPEN_MODE, warning
from ai.common.transform import IGlobalTransform
from ai.common.config import Config
from ai.common.rocketride_db import resolve_rocketride_dsn

# Valid unquoted PostgreSQL identifier: letter/underscore start, alphanumeric/underscore body, max 63 chars
VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


class IGlobal(IGlobalTransform):
    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .rocketride_vector import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Get the configuration
            self.store = Store(self.glb.logicalType, connConfig, bag)

            # Get the info about our store
            collection = self.store.collection

            # Scope the subKey by tenant: the resolved DSN points at the
            # per-tenant database, so key on that database — the store must
            # not be shared across tenants even when the pooler host/port are
            # identical. (Identity rides the task file since #1686; env
            # identity is untrusted, and the tenant DB is the actual
            # isolation unit.)
            tenant_scope = self.store.database or f'{self.store.host}:{self.store.port}'
            subKey = f'{tenant_scope}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def validateConfig(self):
        """
        Validate the RocketRide cloud vector store config with fast, read-only probes.

        - Enforce a safe unquoted identifier for the table (collection).
        - Resolve the per-tenant DSN, connect with a short timeout, run SELECT 1.
        - Verify pgvector availability via ``SELECT NULL::vector``.
        - Surface raw provider errors without truncation.
        """
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            # Support legacy key 'collection' if the UI still sends it
            table = ((cfg.get('table') or cfg.get('collection')) or '').strip()

            # Table name validation: unquoted identifier rules, total ≤63 chars
            if not VALID_TABLE.fullmatch(table or ''):
                warning(
                    'Table name must be ≤63 chars; start with letter/underscore; only letters, digits, underscore; no spaces or special characters (- . / \\ \' " ` ( ) [ ] { } , ; : * + = | & # @ % ^ ! ? ~ $)'
                )
                return

            # No host/user/password fields — resolve the per-tenant DSN.
            dsn = resolve_rocketride_dsn()

            # Load deps on demand: in CONFIG mode beginGlobal never imports
            # .rocketride_vector (where the node's other depends() lives), so
            # this is the only thing that installs the driver at save time —
            # same pattern as store_postgres and the other DB nodes.
            import os

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

    def endGlobal(self):
        # Release the index and embeddings
        self.store = None


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
