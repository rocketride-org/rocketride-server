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
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
import os
import re
from typing import Any, Dict

from ai.common.store import StoreGlobalBase
from rocketlib import warning

# Valid unquoted PostgreSQL identifier: letter/underscore start, alphanumeric/underscore body, max 63 chars
VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


class IGlobal(StoreGlobalBase):
    serverName: str = 'postgres'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .postgres import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: host/port/collection."""
        return f'{self.store.host}/{self.store.port}/{self.store.collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Validate PostgreSQL vector store config with fast, read-only probes.

        - Enforce safe unquoted identifier for table (collection)
        - Connect with short timeout; run SELECT 1
        - Verify pgvector availability via pg_extension/pg_type
        - Surface raw provider errors without truncation
        """
        try:
            host = (config.get('host') or '').strip()
            port = config.get('port')
            user = config.get('user')
            password = config.get('password')
            database = (config.get('database') or 'postgres').strip()
            # Support legacy key 'collection' if UI still sends it
            table = ((config.get('table') or config.get('collection')) or '').strip()

            # Table name validation: unquoted identifier rules, total ≤63 chars
            if not VALID_TABLE.fullmatch(table or ''):
                warning(
                    'Table name must be ≤63 chars; start with letter/underscore; only letters, digits, underscore; no spaces or special characters (- . / \\ \' " ` ( ) [ ] { } , ; : * + = | & # @ % ^ ! ? ~ $)'
                )
                return

            # Load deps on demand
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            import psycopg2  # type: ignore

            conn = None
            try:
                # Connect quickly; surface auth/host/db errors
                conn = psycopg2.connect(
                    dbname=database,
                    user=user,
                    password=password,
                    host=host,
                    port=port,
                    connect_timeout=3,
                )
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
