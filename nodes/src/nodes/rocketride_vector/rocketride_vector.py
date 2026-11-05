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
# RocketRide cloud vector store.
#
# The same pgvector store as ``store_postgres`` (the shared driver
# ``ai.common.store.pgvector.PgVectorStore``) except for two things:
#   1. Connection: instead of reading host/user/password from config, it
#      reads the DSN the task engine delivered for the node's scope / target
#      (``ai.common.rocketride_db``). The DSN usually points at a
#      transaction-mode pooler, which the driver is built for: nothing is ever
#      set for the session.
#   2. Index parameters: the HNSW ``m`` and ``ef_construction`` come from the
#      node configuration.
# The table is shared by every pipeline that names it in the same managed
# database (the organization's by default), which ``describe()`` reports as the
# caveat ``shared_org_table``.
# ------------------------------------------------------------------------------
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict

from ai.common.config import Config
from ai.common.rocketride_db import db_target, parse_dsn_fields, resolve_rocketride_dsn
from ai.common.store.pgvector import HNSW_MAX_DIMS, PgVectorStore
from .IGlobal import VALID_TABLE

# Default PostgreSQL port
DEFAULT_POSTGRES_PORT = 5432

__all__ = ['DEFAULT_POSTGRES_PORT', 'HNSW_MAX_DIMS', 'Store']


class Store(PgVectorStore):
    """A pgvector table in a managed RocketRide cloud database (the node's scope / target)."""

    node: str = 'rocketride'

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the RocketRide cloud vector store.

        @param provider: The name of the provider.
        @param connConfig: The connection configuration.
        @param bag: A dictionary of additional parameters.
        """
        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # The table name is validated before the DSN is resolved
        table = ((config.get('table') or config.get('collection')) or '').strip()
        if not table or not VALID_TABLE.fullmatch(table):
            raise ValueError(
                f'Invalid collection name: {table!r}. Must be a valid PostgreSQL identifier (letters, digits, underscores; max 63 chars).'
            )

        # RocketRide cloud: no host/user/password fields. Read the DSN the
        # task engine delivered for this node's scope / target.
        # host/port/database are parsed only for bookkeeping (the connection
        # subKey keys on database); the DSN is the source of truth and is
        # never reported.
        dsn = resolve_rocketride_dsn(*db_target(config))
        fields = parse_dsn_fields(dsn)
        self.host = fields['host']
        self.port = fields['port'] or DEFAULT_POSTGRES_PORT
        self.database = fields['database']

        super().__init__(
            provider,
            connConfig,
            bag,
            connect_args={'dsn': dsn},
            table=table,
            similarity=config.get('similarity', 'cosine'),
            threshold=config.get('score', 0.5),
            hnsw_m=config.get('hnsw_m', 16),
            hnsw_ef_construction=config.get('hnsw_ef_construction', 64),
            caveats=('shared_org_table',),
        )
