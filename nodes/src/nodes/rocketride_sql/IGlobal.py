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

import os
from typing import Dict, Mapping

from depends import depends

# SQLAlchemy loads the psycopg2 driver when the engine connects, so the
# requirements are installed before that happens. This module is only imported
# on the run path (config mode imports the validator alone), so the install
# never runs while a user is merely opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from ai.common.database import DatabaseGlobalBase
from ai.common.rocketride_db import db_target, parse_dsn_fields, resolve_rocketride_dsn, to_sqlalchemy_url


class IGlobal(DatabaseGlobalBase):
    """RocketRide cloud SQL global state.

    Identical to the generic PostgreSQL node in every respect except one: it
    takes **no** connection config. Instead of reading host/user/password, it
    reads the DSN the task engine delivered for its ``scope`` / ``target``
    (see ``ai.common.rocketride_db``). Everything else - schema reflection,
    EXPLAIN validation, the structured query surface, and the raw EXECUTE
    path - is inherited unchanged from the base. Save-time validation lives
    in ``IValidator.py``.
    """

    # PgBouncer already pools, capping each tenant database at 3 server connections per pooler.
    POOL_SIZE = 2
    MAX_OVERFLOW = 2

    # Cache the resolved DSN between the paired _connection_params /
    # _build_connection_url calls the base makes in beginGlobal, so both come
    # from a single resolution.
    _dsn: str = ''

    def _connection_params(self, config: Mapping) -> Dict[str, str]:
        """Read the delivered cloud DSN and expose the pieces the base needs.

        There are no host/user/password fields; the DSN is the one the task
        engine delivered for this node's ``scope`` / ``target``. Read it once
        here, cache it for ``_build_connection_url``, and parse out
        ``database`` so the base's schema-reflection messaging names the real
        tenant database. ``table`` remains the one structured, user-facing
        target field.
        """
        self._dsn = resolve_rocketride_dsn(*db_target(config))
        fields = parse_dsn_fields(self._dsn)
        return {
            'host': fields['host'],
            'user': fields['user'],
            'password': fields['password'],
            'database': fields['database'] or 'rocketride',
            'table': config['table'].strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        """Return the SQLAlchemy engine URL for the per-tenant cloud DSN.

        The DSN was read and cached in ``_connection_params``, which the base
        always calls first. Re-reading here would need the node's scope.
        """
        if not self._dsn:
            raise RuntimeError('_connection_params must run before _build_connection_url')
        return to_sqlalchemy_url(self._dsn)

    def _max_validation_attempts(self, config: Mapping) -> int:
        """Return the EXPLAIN-validation retry count; the schema bounds it to [1, 20]."""
        return int(config['max_attempts'])

    def _db_description(self, config: Mapping) -> str:
        """Return the user-provided database description (empty string if unset)."""
        return config['db_description']
