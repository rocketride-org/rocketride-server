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
        # The UI stores connection fields nested under 'postgres.default'; fall
        # back to flat keys for compatibility with hand-crafted configs.
        block = config.get('postgresdb.default')
        if not isinstance(block, dict):
            block = {}
        return {
            'host':     (block.get('postgresdb.host')     or config.get('host')     or 'localhost').strip(),
            'user':     (block.get('postgresdb.user')     or config.get('user')     or 'postgres').strip(),
            'password': str(block.get('postgresdb.password') or config.get('password') or ''),
            'database': (block.get('postgresdb.database') or config.get('database') or 'postgres').strip(),
            'table':    (block.get('postgresdb.table')    or config.get('table')    or 'table').strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        # URL-encode the password so special characters (e.g. @, /, #) don't
        # break the SQLAlchemy connection string.
        # Host may include an explicit port (e.g. localhost:5433); SQLAlchemy
        # handles host:port in the authority section correctly.
        password = urllib.parse.quote_plus(params['password'])
        return f'postgresql+psycopg2://{params["user"]}:{password}@{params["host"]}/{params["database"]}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        # Read from the same postgres.default block as the other connection fields.
        """
        Determine the maximum number of validation attempts for the PostgreSQL connection.
        
        Parameters:
            config (Dict[str, Any]): Node configuration mapping; the method reads from the nested
                'postgresdb.default' block (falling back to top-level keys) to find
                'postgresdb.max_attempts'.
        
        Returns:
            Maximum number of validation attempts, as an integer. Defaults to 5 if the value
            is missing or cannot be converted to an integer.
        """
        block = config.get('postgresdb.default')
        if not isinstance(block, dict):
            block = {}
        try:
            return int(block.get('postgresdb.max_attempts') or config.get('postgresdb.max_attempts') or 5)
        except (ValueError, TypeError):
            return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        """
        Retrieve the database description for the PostgreSQL configuration.
        
        Returns:
            str: The description from the 'postgresdb.default' block key 'postgresdb.db_description', or from the top-level 'postgresdb.db_description', or an empty string if none is provided.
        """
        block = config.get('postgresdb.default')
        if not isinstance(block, dict):
            block = {}
        return str(block.get('postgresdb.db_description') or config.get('postgresdb.db_description') or '')
