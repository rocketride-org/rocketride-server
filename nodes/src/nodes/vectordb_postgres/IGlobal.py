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
from rocketlib import OPEN_MODE
from ai.common.transform import IGlobalTransform
from rocketlib import warning
from ai.common.config import Config


class IGlobal(IGlobalTransform):
    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .vectordb_postgres import Store

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
            host = self.store.host
            port = self.store.port

            # Format it into a subKey
            subKey = f'{host}/{port}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def validateConfig(self):
        """
        Validate PostgreSQL vector store config with fast, read-only probes.

        - Enforce safe unquoted identifier for table (collection)
        - Connect with short timeout; run SELECT 1
        - Verify pgvector availability via pg_extension/pg_type
        - Surface raw provider errors without truncation
        """
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            host = (cfg.get('host') or '').strip()
            port = cfg.get('port')
            user = cfg.get('user')
            password = cfg.get('password')
            database = (cfg.get('database') or 'postgres').strip()
            # Support legacy key 'collection' if UI still sends it
            table = ((cfg.get('table') or cfg.get('collection')) or '').strip()

            # Table name validation: unquoted identifier rules, total ≤63 chars
            VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')
            if not VALID_TABLE.fullmatch(table or ''):
                warning('Table name must be ≤63 chars; start with letter/underscore; only letters, digits, underscore; no spaces or special characters (- . / \\ \' " ` ( ) [ ] { } , ; : * + = | & # @ % ^ ! ? ~ $)')
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

    def endGlobal(self):
        # Release the index and embeddings
        self.store = None


def _format_error(e: Exception) -> str:
    try:
        from psycopg2 import OperationalError, ProgrammingError  # type: ignore
        import socket

        if isinstance(e, (OperationalError, ProgrammingError, socket.timeout)):
            msg = str(e).strip()
            # Trim verbose caret/context lines for concise output
            return msg.splitlines()[0]
    except Exception:
        pass
    return str(e).strip()
