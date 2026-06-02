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

    @staticmethod
    def _normalize_field(value: Any, default: str) -> str:
        """Coerce a config value to a stripped string, returning ``default`` when it is None or empty.

        Non-string values are coerced via ``str()`` first, so a stored null or a
        non-string (e.g. a number) can never raise ``AttributeError`` on ``.strip()``.
        """
        if value is None:
            return default
        text = str(value).strip()
        return text or default

    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        """Map the node's stored config to a flat ClickHouse connection-params dict."""
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
            'host': self._normalize_field(config.get('host'), 'localhost'),
            'user': self._normalize_field(config.get('user'), 'default'),
            'password': config.get('password') or '',  # Do not strip — whitespace is valid in passwords
            'database': self._normalize_field(config.get('database'), 'default'),
            'table': self._normalize_field(config.get('table'), 'table'),
            # Normalised to a flag string so the params dict stays Dict[str, str];
            # consumed by _build_connection_url below.
            'tls': 'true' if tls else '',
        }

    def _build_connection_url(self, params: Dict[str, str]) -> str:
        """Build a clickhouse-sqlalchemy native-TCP DSN, enabling TLS when requested."""
        # URL-encode user / password / database so reserved characters
        # (e.g. @, /, #, :) can't break the SQLAlchemy connection string.
        user = urllib.parse.quote_plus(params['user'])
        password = urllib.parse.quote_plus(params['password'])
        database = urllib.parse.quote_plus(params['database'])

        host = params['host']
        if params.get('tls'):
            # TLS is required by managed services such as ClickHouse Cloud, whose
            # native-protocol TLS port is 9440. Default to it when the user did
            # not pin an explicit port, so a bare cloud hostname just works.
            # Port detection is bracket-aware: a bracketed IPv6 literal (e.g.
            # [::1]) only carries a port when a ':' follows the closing ']'.
            if host.startswith('['):
                has_port = ']' in host and ':' in host.split(']', 1)[1]
            else:
                has_port = ':' in host
            if not has_port:
                host = f'{host}:9440'
            # ?secure=true is clickhouse-driver's own wire-level parameter name for
            # enabling TLS; it is unrelated to the node's "tls" config field.
            return f'clickhouse+native://{user}:{password}@{host}/{database}?secure=true'

        # Plaintext native (e.g. a local server); defaults to port 9000 when the
        # host carries no explicit port. SQLAlchemy handles host:port correctly.
        return f'clickhouse+native://{user}:{password}@{host}/{database}'

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        """Return the EXPLAIN-validation retry count, clamped to the documented 1..20 range."""
        try:
            value = int(config.get('max_attempts', 5))
        except (ValueError, TypeError):
            return 5
        # Clamp to the documented 1..20 range (services.json minimum/maximum) so
        # a value supplied directly (bypassing UI validation) can't request 0,
        # negative, or excessive EXPLAIN-validation retries.
        return max(1, min(20, value))

    def _db_description(self, config: Dict[str, Any]) -> str:
        """Return the user-provided database description, always as a string."""
        # A stored null (or non-string) must not violate the -> str contract.
        value = config.get('db_description')
        return value if isinstance(value, str) else ''
