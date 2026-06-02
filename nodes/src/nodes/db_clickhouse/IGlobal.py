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
    """ClickHouse-specific global state.

    Implements the two abstract methods that carry ClickHouse knowledge:
    how to read connection params from the node config, and how to build a
    clickhouse-sqlalchemy DSN from those params.  Everything else (schema
    reflection, type inference, session lifecycle) lives in the base.

    The DSN uses the native TCP interface (``clickhouse+native://``, default
    port 9000) via the ``clickhouse-driver`` backend.  ClickHouse has no
    foreign keys; ``clickhouse-sqlalchemy`` reflects an empty FK list and a
    best-effort primary key, so the dialect-agnostic base works unchanged.
    """

    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        # Config.getNodeConfig() strips the node namespace prefix before returning;
        # keys are unprefixed here by design (e.g. 'host', not 'clickhouse.host').
        # 'tls' is a ClickHouse-specific option (not present on the MySQL/PostgreSQL
        # nodes). It is distinct from the field-level "secure": true attribute on the
        # password field — that attribute only marks the value as a masked secret and
        # is shared identically across all three database nodes.
        tls = config.get('tls', False)
        if isinstance(tls, str):
            # Config values may arrive as strings ('true'/'false'); 'false' must
            # not be truthy, so don't use bool() directly.
            tls = tls.strip().lower() in {'1', 'true', 'yes', 'on'}
        return {
            'host': config.get('host', 'localhost').strip(),
            'user': config.get('user', 'default').strip(),
            'password': config.get('password', ''),  # Do not strip — whitespace is valid in passwords
            'database': config.get('database', 'default').strip(),
            'table': config.get('table', 'table').strip(),
            # Normalised to a flag string so the params dict stays Dict[str, str];
            # consumed by _build_connection_url below.
            'tls': 'true' if tls else '',
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        # URL-encode the password so special characters (e.g. @, /, #) don't
        # break the SQLAlchemy connection string.
        password = urllib.parse.quote_plus(params['password'])

        host = params['host']
        if params.get('tls'):
            # TLS is required by managed services such as ClickHouse Cloud, whose
            # native-protocol TLS port is 9440. Default to it when the user did
            # not pin an explicit port, so a bare cloud hostname just works.
            if ':' not in host:
                host = f'{host}:9440'
            # ?secure=true is clickhouse-driver's own wire-level parameter name for
            # enabling TLS; it is unrelated to the node's "tls" config field.
            return f'clickhouse+native://{params["user"]}:{password}@{host}/{params["database"]}?secure=true'

        # Plaintext native (e.g. a local server); defaults to port 9000 when the
        # host carries no explicit port. SQLAlchemy handles host:port correctly.
        return f'clickhouse+native://{params["user"]}:{password}@{host}/{params["database"]}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        try:
            return int(config.get('max_attempts', 5))
        except (ValueError, TypeError):
            return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        return config.get('db_description', '')
