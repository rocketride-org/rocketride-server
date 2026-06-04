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

import urllib.parse
from typing import Any, Dict

from ai.common.database import DatabaseGlobalBase


class IGlobal(DatabaseGlobalBase):
    """PostgreSQL-specific global state.

    Implements the two abstract methods that carry PostgreSQL knowledge:
    how to read connection params from the node config, and how to
    build a psycopg2 DSN from those params.  Everything else (schema
    reflection, type inference, session lifecycle) lives in the base.
    """

    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        """Map the node's stored config to a flat PostgreSQL connection-params dict."""
        # Config.getNodeConfig() strips the node namespace prefix before returning;
        # keys are unprefixed here by design (e.g. 'host', not 'postgresdb.host').
        return {
            'host': config.get('host', 'localhost').strip(),
            'user': config.get('user', 'postgres').strip(),
            'password': config.get('password', ''),  # Do not strip — whitespace is valid in passwords
            'database': config.get('database', 'postgres').strip(),
            'table': config.get('table', 'table').strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        """Build a psycopg2 PostgreSQL DSN from the connection params."""
        # URL-encode user / password / database so reserved characters
        # (e.g. @, /, #, :) don't break the SQLAlchemy connection string.
        # Host may include an explicit port (e.g. localhost:5433); SQLAlchemy
        # handles host:port in the authority section correctly.
        user = urllib.parse.quote_plus(params['user'])
        password = urllib.parse.quote_plus(params['password'])
        database = urllib.parse.quote_plus(params['database'])
        return f'postgresql+psycopg2://{user}:{password}@{params["host"]}/{database}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        """Return the EXPLAIN-validation retry count from config (default 5)."""
        try:
            return int(config.get('max_attempts', 5))
        except (ValueError, TypeError):
            return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        """Return the user-provided database description (empty string if unset)."""
        return config.get('db_description', '')
