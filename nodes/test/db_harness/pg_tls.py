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

"""The TLS-enabled PostgreSQL the database acceptance tests connect to.

The server is started outside the test run (``start-pg-tls.sh``, which CI and a
developer both use) and described by two environment variables:

    RR_TEST_PG_TLS_PORT   host port of the server (127.0.0.1)
    RR_TEST_PG_TLS_CA     path to the PEM of the CA that signed its certificate

Its certificate names ``localhost`` only, so ``127.0.0.1`` is a real host-name
mismatch. Every non-TLS connection is refused by ``pg_hba.conf``. Databases:
``rrtenant`` (role ``rruser``) and two synthetic tenants, ``t_orga``/``r_orga``
and ``t_orgb``/``r_orgb``; the passwords are fixed synthetic values of the
throwaway container.

``RR_REQUIRE_DB_TESTS`` (set by CI once its containers are healthy) turns every
skip into a failure, as in the other ``*_full`` suites.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import pytest

ENV_PORT = 'RR_TEST_PG_TLS_PORT'
ENV_CA = 'RR_TEST_PG_TLS_CA'
ENV_REQUIRE = 'RR_REQUIRE_DB_TESTS'

TENANTS = {
    'orga': {'user': 'r_orga', 'password': 'pw_orga', 'database': 't_orga'},
    'orgb': {'user': 'r_orgb', 'password': 'pw_orgb', 'database': 't_orgb'},
}


@dataclass(frozen=True)
class TlsServer:
    """Where the TLS PostgreSQL is and which CA signed it."""

    port: int
    ca: Path
    host: str = 'localhost'

    def dsn(self, tenant: str = 'orga', *, host: Optional[str] = None, query: str = 'sslmode=require') -> str:
        """A broker-style DSN for a tenant database (what the provisioner returns)."""
        t = TENANTS[tenant]
        netloc = f'{quote(t["user"])}:{quote(t["password"])}@{host or self.host}:{self.port}'
        return f'postgresql://{netloc}/{t["database"]}' + (f'?{query}' if query else '')


def required() -> bool:
    return bool(os.environ.get(ENV_REQUIRE))


def locate() -> TlsServer:
    """The configured server, or skip (fail under ``RR_REQUIRE_DB_TESTS``) when it is not usable."""

    def unavailable(reason: str):
        if required():
            pytest.fail(f'{ENV_REQUIRE} is set but {reason}', pytrace=False)
        pytest.skip(reason)

    port, ca = os.environ.get(ENV_PORT), os.environ.get(ENV_CA)
    if not port or not ca:
        unavailable(f'{ENV_PORT} and {ENV_CA} are not set (run nodes/test/db_harness/start-pg-tls.sh)')
    ca_path = Path(ca)
    if not ca_path.is_file():
        unavailable(f'{ENV_CA}={ca} is not a file')
    try:
        with socket.create_connection(('127.0.0.1', int(port)), timeout=3):
            pass
    except OSError:
        unavailable(f'the TLS PostgreSQL is not reachable on 127.0.0.1:{port}')
    return TlsServer(port=int(port), ca=ca_path)
