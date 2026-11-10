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
import urllib.parse
from typing import Any, Dict

from depends import depends

# SQLAlchemy loads the pymysql driver when the engine connects, so the
# requirements are installed before that happens. This module is only imported
# on the run path (config mode imports the validator alone), so the install
# never runs while a user is merely opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from ai.common.database import DatabaseGlobalBase


class IGlobal(DatabaseGlobalBase):
    """MySQL-specific global state.

    Implements the two abstract methods that carry MySQL knowledge:
    how to read connection params from the node config, and how to
    build a pymysql DSN from those params.  Everything else (schema
    reflection, type inference, session lifecycle) lives in the base.
    """

    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        """Map the resolved node config to a flat connection-params dict.

        The resolver has applied the schema defaults (host, user, database,
        table) and flattened the keys to their short names ('host', not
        'mysql.host'); the password has no default, so an unset one is None.
        """
        return {
            'host': config['host'].strip(),
            'user': config['user'].strip(),
            'password': config['password'] or '',  # Do not strip: whitespace is valid in passwords
            'database': config['database'].strip(),
            'table': config['table'].strip(),
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        """Build a pymysql MySQL DSN from the connection params."""
        # URL-encode user / password / database so reserved characters
        # (e.g. @, /, #, :) don't break the SQLAlchemy connection string.
        user = urllib.parse.quote_plus(params['user'])
        password = urllib.parse.quote_plus(params['password'])
        database = urllib.parse.quote_plus(params['database'])
        return f'mysql+pymysql://{user}:{password}@{params["host"]}/{database}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        """Return the EXPLAIN-validation retry count; the resolver bounded it to the schema's 1..20."""
        return config['max_attempts']

    def _db_description(self, config: Dict[str, Any]) -> str:
        """Return the user-provided database description (empty string if unset)."""
        return config['db_description'] or ''
