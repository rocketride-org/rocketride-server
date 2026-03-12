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
    """MySQL-specific global state.

    Implements the two abstract methods that carry MySQL knowledge:
    how to read connection params from the node config, and how to
    build a pymysql DSN from those params.  Everything else (schema
    reflection, type inference, session lifecycle) lives in the base.
    """

    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        # The UI stores connection fields nested under 'mysql.default'; fall
        # back to flat keys for compatibility with hand-crafted configs.
        block = config.get('mysql.default')
        if not isinstance(block, dict):
            block = {}
        return {
            'host':     (block.get('mysql.host')     or config.get('host')     or 'localhost').strip(),
            'user':     (block.get('mysql.user')     or config.get('user')     or 'root').strip(),
            'password': str(block.get('mysql.password') or config.get('password') or ''),
            'database': (block.get('mysql.database') or config.get('database') or 'database').strip(),
            'table':    (block.get('mysql.table')    or config.get('table')    or 'table').strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        # URL-encode the password so special characters (e.g. @, /, #) don't
        # break the SQLAlchemy connection string.
        password = urllib.parse.quote_plus(params['password'])
        return f'mysql+pymysql://{params["user"]}:{password}@{params["host"]}/{params["database"]}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        # Read from the same mysql.default block as the other connection fields.
        """
        Determine the maximum number of validation attempts from the provided configuration.
        
        Looks for 'mysql.max_attempts' inside the 'mysql.default' block first, then at the top level, and falls back to 5. If the configured value cannot be parsed as an integer, returns 5.
        
        Parameters:
            config (Dict[str, Any]): Configuration mapping to read values from.
        
        Returns:
            Maximum number of validation attempts as an int; defaults to 5 if missing or invalid.
        """
        block = config.get('mysql.default')
        if not isinstance(block, dict):
            block = {}
        try:
            return int(block.get('mysql.max_attempts') or config.get('mysql.max_attempts') or 5)
        except (ValueError, TypeError):
            return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        """
        Return the configured MySQL database description.
        
        Parameters:
            config (Dict[str, Any]): Configuration mapping that may include a 'mysql.default' dict and/or a top-level 'mysql.db_description' entry.
        
        Returns:
            str: The value of `mysql.db_description` from the 'mysql.default' block if present, otherwise the top-level `mysql.db_description`, or an empty string if neither is set.
        """
        block = config.get('mysql.default')
        if not isinstance(block, dict):
            block = {}
        return str(block.get('mysql.db_description') or config.get('mysql.db_description') or '')
