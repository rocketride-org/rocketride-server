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
# PostgreSQL + pgvector store, reached with the connection fields of the node.
#
# Everything about the table (schema, writes, searches, the explorer hooks) is
# the shared driver ``ai.common.store.pgvector.PgVectorStore``, which
# rocketride_vector uses too; this class only turns the node configuration into
# the driver's connection arguments.
# ------------------------------------------------------------------------------
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict

from ai.common.config import Config
from ai.common.store.pgvector import PgVectorStore
from .IGlobal import VALID_TABLE

# Default PostgreSQL port
DEFAULT_POSTGRES_PORT = 5432


class Store(PgVectorStore):
    """The pgvector table of a PostgreSQL server named by host, port, user, password and database."""

    node: str = 'postgres'

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the postgres vector store.

        @param provider: The name of the provider.
        @param connConfig: The connection configuration.
        @param bag: A dictionary of additional parameters.
        """
        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # The table name is validated before anything connects
        table = ((config.get('table') or config.get('collection')) or '').strip()
        if not table or not VALID_TABLE.fullmatch(table):
            raise ValueError(
                f'Invalid collection name: {table!r}. Must be a valid PostgreSQL identifier (letters, digits, underscores; max 63 chars).'
            )

        self.host = (config.get('host') or '').strip()
        self.port = config.get('port', DEFAULT_POSTGRES_PORT)
        self.user = config.get('user')
        self.password = config.get('password')
        self.database = config.get('database', 'postgres')

        super().__init__(
            provider,
            connConfig,
            bag,
            connect_args={
                'dbname': self.database,
                'user': self.user,
                'password': self.password,
                'host': self.host,
                'port': self.port,
            },
            table=table,
            similarity=config.get('similarity', 'cosine'),
            threshold=config.get('score', 0.5),
            hnsw_m=config.get('hnsw_m', 16),
            hnsw_ef_construction=config.get('hnsw_ef_construction', 64),
        )
