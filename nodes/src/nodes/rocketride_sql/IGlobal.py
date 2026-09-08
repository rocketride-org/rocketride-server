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

from typing import Any, Dict

from ai.common.database import DatabaseGlobalBase
from ai.common.rocketride_db import (
    parse_dsn_fields,
    resolve_rocketride_dsn,
    to_sqlalchemy_url,
)


class IGlobal(DatabaseGlobalBase):
    """RocketRide cloud SQL global state.

    Identical to the generic PostgreSQL node in every respect except one: it
    takes **no** connection config. Instead of reading host/user/password, it
    resolves a ready per-tenant DSN from the account layer, keyed by the
    authenticated ``client_id`` (see ``ai.common.rocketride_db``). Everything
    else — schema reflection, EXPLAIN validation, the structured query surface,
    and the raw EXECUTE path — is inherited unchanged from the base.
    """

    # Cache the resolved DSN between the paired _connection_params /
    # _build_connection_url calls the base makes in beginGlobal and
    # validateConfig, so both come from a single resolution.
    _dsn: str = ''

    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        """Resolve the cloud DSN and expose the pieces the base needs.

        There are no host/user/password fields; the DSN comes from
        ``Account.resolve_db_dsn(client_id)``. Resolve it once here, cache it
        for ``_build_connection_url``, and parse out ``database`` so the base's
        schema-reflection messaging names the real tenant database. ``table``
        remains the one structured, user-facing target field.
        """
        self._dsn = resolve_rocketride_dsn()
        fields = parse_dsn_fields(self._dsn)
        return {
            'host': fields['host'],
            'user': fields['user'],
            'password': fields['password'],
            'database': fields['database'] or 'rocketride',
            'table': config.get('table', 'table').strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        """Return the SQLAlchemy engine URL for the per-tenant cloud DSN.

        The DSN was resolved and cached in ``_connection_params`` (the base
        always calls that first). Fall back to a fresh resolution if invoked
        directly, so the method is safe in isolation.
        """
        dsn = self._dsn or resolve_rocketride_dsn()
        return to_sqlalchemy_url(dsn)

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        """Return the EXPLAIN-validation retry count from config (default 5)."""
        try:
            return int(config.get('max_attempts', 5))
        except (ValueError, TypeError):
            return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        """Return the user-provided database description (empty string if unset)."""
        return config.get('db_description', '')
