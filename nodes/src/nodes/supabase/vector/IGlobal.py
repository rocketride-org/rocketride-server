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

"""Supabase Vector: global state.

Subclasses store_postgres's IGlobal, so the store lifecycle (open the store,
wire the tool-path embedder, register the transform key) is
``StoreGlobalBase``'s, unchanged. Three things differ, all because this node
connects to a Supabase pooler with the shared ``supabase.pooler.*`` fields:

* the store is :class:`.store.Store`, which always connects with
  ``sslmode=require`` and splits ``host[:port]`` (store_postgres has separate
  host and port fields and connects without an sslmode);
* the save-time probe does the same (TLS, split host) instead of
  store_postgres's plain probe;
* ``supabase.access`` is the only switch for the agent tools: ``read`` keeps
  the mixin's ``allow_write`` off, ``write`` turns it on (``upsert``), and
  ``admin`` also allows ``delete``, ``soft_delete`` and ``restore``
  (IInstance gates those).
"""

from __future__ import annotations

import inspect
import os
from typing import Any, Dict

from ai.common.config import Config
from rocketlib import OPEN_MODE, warning

from nodes.store_postgres.IGlobal import VALID_TABLE, IGlobal as PostgresStoreGlobal

from .. import supabase_client as sc

SERVICE = 'supabase_vector'
PRODUCT = 'Supabase Vector'

# store_postgres's requirements (psycopg2-binary, pgvector): the driver this node reuses.
_STORE_POSTGRES_REQUIREMENTS = os.path.join(
    os.path.dirname(os.path.realpath(inspect.getfile(PostgresStoreGlobal))), 'requirements.txt'
)

# pgvector's type is missing (SQLSTATE undefined_object): the extension is not turned on.
_UNDEFINED_OBJECT = '42704'
VECTOR_EXTENSION_HINT = 'Turn on the vector extension in the Supabase dashboard (Database -> Extensions -> vector).'


class IGlobal(PostgresStoreGlobal):
    """store_postgres's IGlobal over a TLS pooler connection, with the Supabase access level."""

    # Label of the tool messages (a refused write names supabase_vector.upsert).
    serverName: str = SERVICE

    # The credentials catalog wires all three to ${ROCKETRIDE_SUPABASE_DB_*}
    # variables, so an unset one must stop start-up naming the variable (as
    # Cron does) instead of reaching psycopg2 as a literal host or user.
    credential_fields = ('host', 'user', 'password')

    # Off until beginGlobal reads the access level: the default level is read.
    allow_write: bool = False

    access: str = sc.DEFAULT_ACCESS

    def beginGlobal(self) -> None:
        # The editor opens nodes in CONFIG mode only to validate settings:
        # no driver, no connection there (same guard as StoreGlobalBase).
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.getConnConfig())
        try:
            self.access = sc.normalize_access(cfg.get('access'))
        except sc.SupabaseConfigError as e:
            raise sc.SupabaseConfigError(f'{SERVICE}: {e}') from None

        super().beginGlobal()

        # The access level is this node's only write switch: StoreGlobalBase
        # read allow_write from the config, which this node does not offer.
        # allow_write opens upsert at write; IInstance keeps the deleting
        # tools for admin.
        self.allow_write = sc.access_allows(self.access, sc.WRITE)

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the TLS store, imported lazily so CONFIG mode never loads the driver."""
        from .store import Store

        try:
            return Store(logical_type, conn_config, bag)
        except sc.SupabaseConfigError as e:
            # A blank host, user or password stops start-up naming the field.
            raise sc.SupabaseConfigError(f'{SERVICE}: {e}') from None

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time probe: settings, table name, then a TLS connection and the vector type.

        Reports problems with ``warning()`` and never raises (the user is still
        editing the node). Messages never carry the password.
        """
        redactor = sc.Redactor([config.get('password') if isinstance(config.get('password'), str) else ''])
        try:
            problems = sc.postgres_config_problems(config)
            try:
                sc.normalize_access(config.get('access'))
            except sc.SupabaseConfigError as e:
                problems.append(str(e))
            table = (config.get('table') or '').strip()
            if not VALID_TABLE.fullmatch(table):
                problems.append(
                    'Table must be a plain PostgreSQL name: a letter or "_" first, then letters, digits or "_", '
                    'at most 63 characters'
                )
            if problems:
                for problem in problems:
                    warning(f'{PRODUCT}: {problem}')
                return

            from depends import depends  # type: ignore

            depends(_STORE_POSTGRES_REQUIREMENTS)

            conn = sc.connect_postgres(sc.resolve_postgres_connection(config), connect_timeout=3)
            try:
                with conn.cursor() as cur:
                    cur.execute('SELECT 1')
                    # Fails with undefined_object when the vector extension is off.
                    cur.execute('SELECT NULL::vector')
                    cur.fetchone()
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        except Exception as e:
            message = redactor.redact(sc.first_line(str(e)) or type(e).__name__)
            if getattr(e, 'pgcode', None) == _UNDEFINED_OBJECT:
                message = f'{message}. {VECTOR_EXTENSION_HINT}'
            warning(f'{PRODUCT}: {message}')
