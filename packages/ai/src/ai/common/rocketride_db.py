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

"""
Shared connection resolution for the RocketRide cloud database nodes.

``rocketride_sql``, ``rocketride_vector`` and ``rocketride_graph`` all connect
to the same per-tenant cloud database and take **no** connection config.  Rather
than reading host/user/password, they resolve a ready DSN from the account layer
keyed by the authenticated ``client_id``.  Centralising that resolution here
gives the three nodes one identical seam — and one place for tests to inject a
fake resolver — so node code is byte-for-byte independent of which
``Account.resolve_db_dsn`` implementation (OSS stub, real SaaS, or fake) is live.

Identity comes from ``ROCKETRIDE_CLIENT_ID`` (injected into the node subprocess
by the task engine, the same accessor ``tool_filesystem`` uses).  The account
call is async while node lifecycle code (``beginGlobal`` / ``Store.__init__``)
is synchronous, so it is bridged with ``asyncio.run`` — safe only from a thread
with no running loop, which is exactly how nodes are constructed.
"""

import asyncio
import os
import urllib.parse

# The task engine injects the authenticated connection identity here (userId ==
# client_id).  Same env accessor as tool_filesystem (nodes run in a subprocess
# and cannot see the server-side AccountInfo directly).
CLIENT_ID_ENV = 'ROCKETRIDE_CLIENT_ID'

# The task engine resolves the per-tenant DSN server-side at task start (only
# the server process has SaaS account context) and injects it here for
# pipelines that contain RocketRide cloud DB nodes.
DB_DSN_ENV = 'ROCKETRIDE_DB_DSN'

# When server-side resolution fails (e.g. a broker outage), the task engine
# passes the reason down here instead of a DSN, so the node can report the
# real cause rather than the misleading "sign into RocketRide cloud" error.
DB_RESOLVE_ERROR_ENV = 'ROCKETRIDE_DB_RESOLVE_ERROR'


def _run_async(coro):
    """Run a coroutine from synchronous node lifecycle code.

    Only safe to call from a thread with no running event loop — node
    ``beginGlobal`` / ``Store.__init__`` are invoked synchronously by the
    engine, which is the supported caller.  Pre-check so a misuse surfaces with
    a clear message instead of ``asyncio.run``'s generic RuntimeError.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError(
            'resolve_rocketride_dsn must not be called from a thread with a running event loop; '
            'RocketRide DB node lifecycle methods are constructed synchronously by the engine.'
        )
    return asyncio.run(coro)


def current_client_id() -> str:
    """Return the authenticated ``client_id`` for the running task.

    Raises:
        ValueError: if the identity env var is missing — which normally means
            the node is running outside the task engine, or the connection is
            not signed into RocketRide cloud.
    """
    client_id = os.environ.get(CLIENT_ID_ENV, '').strip()
    if not client_id:
        raise ValueError(
            f'{CLIENT_ID_ENV} is not set; RocketRide cloud DB nodes require a signed-in RocketRide cloud identity'
        )
    return client_id


def to_sqlalchemy_url(dsn: str) -> str:
    """Normalise a libpq URL DSN to a SQLAlchemy psycopg2 URL.

    ``psycopg2.connect`` accepts a bare ``postgresql://`` / ``postgres://`` URL,
    but SQLAlchemy's ``create_engine`` needs an explicit driver in the scheme.
    A DSN that already names a driver (``postgresql+psycopg2://``) or is a
    key/value libpq string (``host=... dbname=...``) is passed through
    unchanged.
    """
    if '+' in dsn.split(':', 1)[0]:
        # Scheme already carries a driver (e.g. postgresql+psycopg2://).
        return dsn
    for prefix in ('postgresql://', 'postgres://'):
        if dsn.startswith(prefix):
            return 'postgresql+psycopg2://' + dsn[len(prefix) :]
    return dsn


def resolve_rocketride_dsn() -> str:
    """Resolve the per-tenant libpq DSN for the current client.

    Delivery order:

    1. ``ROCKETRIDE_DB_DSN`` env — the production path. The task engine
       resolves the DSN server-side at task start (the SaaS account context
       exists only in the server process; node subprocesses always see the
       OSS account) and injects it here, exactly like ``ROCKETRIDE_CLIENT_ID``.
    2. ``Account.resolve_db_dsn(client_id)`` — fallback for callers running
       inside the server process (or tests injecting a fake account). On an
       unconfigured open-source build this raises the cloud-sign-in error.

    Returns the raw DSN (URL form, directly usable by ``psycopg2.connect``).
    Callers that need a SQLAlchemy engine URL should wrap the result in
    :func:`to_sqlalchemy_url`.
    """
    injected = os.environ.get(DB_DSN_ENV, '').strip()
    if injected:
        return injected

    # Server-side resolution was attempted and failed: report that failure,
    # not the sign-in error the account fallback below would produce (the
    # task engine scrubs the broker env from node subprocesses, so the
    # fallback cannot succeed here anyway).
    resolve_error = os.environ.get(DB_RESOLVE_ERROR_ENV, '').strip()
    if resolve_error:
        raise ValueError(f'RocketRide cloud database resolution failed at task start: {resolve_error}')

    # Lazy import: ai.common is imported very early, and ai.account pulls in the
    # OSS/SaaS overlay — importing at module load risks a cycle.
    from ai.account import account

    dsn = _run_async(account.resolve_db_dsn(current_client_id()))
    if not dsn or not isinstance(dsn, str):
        raise ValueError('Account.resolve_db_dsn returned an empty DSN')
    return dsn


def parse_dsn_fields(dsn: str) -> dict:
    """Best-effort parse of a URL-form DSN into host/user/password/database.

    Used only to populate cosmetic / bookkeeping fields (e.g. the base class's
    ``database`` used in log messages and the vector node's connection subKey).
    The DSN itself remains the source of truth for the actual connection.
    Non-URL DSNs yield empty fields.
    """
    empty = {'host': '', 'port': None, 'user': '', 'password': '', 'database': ''}
    try:
        parsed = urllib.parse.urlparse(dsn)
    except ValueError:
        # e.g. mismatched IPv6 brackets — urlparse itself rejects the URL.
        return empty
    if not parsed.scheme:
        return empty
    # hostname/port validate lazily and raise ValueError on malformed
    # authorities (bad bracket host, non-numeric or out-of-range port); these
    # fields are cosmetic, so degrade per-field rather than fail node
    # construction.
    try:
        host = parsed.hostname or ''
    except ValueError:
        host = ''
    try:
        port = parsed.port
    except ValueError:
        port = None
    return {
        'host': host,
        'port': port,
        'user': urllib.parse.unquote(parsed.username) if parsed.username else '',
        'password': urllib.parse.unquote(parsed.password) if parsed.password else '',
        'database': (parsed.path or '').lstrip('/'),
    }
