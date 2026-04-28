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
        # Config.getNodeConfig() strips the node namespace prefix before returning;
        # keys are unprefixed here by design (e.g. 'host', not 'mysql.host').
        return {
            'host': config.get('host', 'localhost').strip(),
            'user': config.get('user', 'root').strip(),
            'password': config.get('password', ''),  # Do not strip — whitespace is valid in passwords
            'database': config.get('database', 'database').strip(),
            'table': config.get('table', 'table').strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        # URL-encode the password so special characters (e.g. @, /, #) don't
        # break the SQLAlchemy connection string.
        password = urllib.parse.quote_plus(params['password'])
        return f'mysql+pymysql://{params["user"]}:{password}@{params["host"]}/{params["database"]}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        try:
            return int(config.get('max_attempts', 5))
        except (ValueError, TypeError):
            return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        return config.get('db_description', '')
