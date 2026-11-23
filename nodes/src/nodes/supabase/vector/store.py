# =============================================================================
# RocketRide Engine
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

"""Supabase Vector: store_postgres's pgvector Store over a TLS pooler connection.

Everything the store does (table layout, inserts, deletes, keyword and
semantic search, listing, rendering) is inherited from
``nodes.store_postgres.postgres.Store`` and ``PgVectorStoreBase`` unchanged.
Only the constructor is this node's own, because store_postgres's
constructor connects as soon as it has read the settings (there is no
connect hook to override; asking store_postgres for one is open, see the
STATUS notes). The constructor sets the same attributes from the same
config keys; ``test_store_attributes_match_store_postgres`` fails when the
two drift. What differs:

* store_postgres connects without an ``sslmode``; Supabase Vector must
  require TLS (``sc.postgres_connect_kwargs`` always sets ``sslmode='require'``);
* store_postgres reads ``host`` and ``port`` as separate fields; Supabase
  Vector has the shared ``supabase.pooler.host`` field that may carry ``:port``;
* the password is not kept on the store object.

Importing ``nodes.store_postgres.postgres`` runs its ``depends()``
(psycopg2-binary, pgvector) before the driver loads, as in store_postgres.
"""

from __future__ import annotations

from typing import Any, Dict

from ai.common.config import Config

from nodes.store_postgres import postgres as _pg
from nodes.store_postgres.IGlobal import VALID_TABLE

from .. import supabase_client as sc


class Store(_pg.Store):
    """store_postgres's Store, connected with ``sslmode=require`` to the Supabase pooler."""

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Read the settings and open the TLS connection.

        Deliberately skips ``_pg.Store.__init__`` (it would open a connection
        without TLS) and runs the base above it, ``PgVectorStoreBase``. The
        settings are read the way store_postgres reads them.

        Raises:
            SupabaseConfigError: blank pooler host, user or password (names the field).
            ValueError: the table is not a plain PostgreSQL name.
            Exception: unsupported similarity (same message as store_postgres).
            SupabaseError: the connection failed (the message never carries the password).
        """
        super(_pg.Store, self).__init__(provider, connConfig, bag)

        config = Config.getNodeConfig(provider, connConfig)
        conn = sc.resolve_postgres_connection(config)

        # Validated because the table name is formatted into store_postgres's SQL.
        self.collection = (config.get('table') or '').strip()
        if not VALID_TABLE.fullmatch(self.collection):
            raise ValueError(
                f'Invalid table name: {self.collection!r}. Must be a valid PostgreSQL identifier '
                '(letters, digits, underscores; max 63 chars).'
            )

        # host and port feed the transform key (_sub_key), as in store_postgres.
        self.host = conn.host
        self.port = conn.port
        self.user = conn.user
        self.database = conn.database
        # The password stays in ``conn`` only: unlike store_postgres, it is not
        # kept on the store, which lives as long as the pipeline.

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.threshold_search = config.get('score', 0.5)

        similarity = config.get('similarity', 'cosine')
        supported = tuple(self.similarityDict)
        if similarity not in supported:
            raise Exception(
                f'Supabase Vector (pgvector): unsupported similarity {similarity!r}. '
                f'Set "similarity" to: {", ".join(supported)}.'
            )
        self.similarity = self.similarityDict[similarity]

        # TLS is required: the pooler is reached over the internet with the database password.
        self.client = sc.connect_postgres(conn)

        # Same connection setup as store_postgres: reads must not hold a
        # transaction between calls, and the vector type is registered once.
        self.client.autocommit = True
        _pg.register_vector(self.client)
