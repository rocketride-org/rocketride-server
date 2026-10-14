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

``rocketride_sql``, ``rocketride_vector`` and ``rocketride_graph`` take **no**
connection config. Each node names a database by ``scope`` (``org``, ``team``
or ``user``) and an optional ``target`` (a team id or user id; empty means the
run's own). The task engine authorizes every ``(scope, target)`` a pipeline
asks for, resolves each DSN server-side at task start, and delivers them as a
JSON map in ``ROCKETRIDE_DB_DSNS``. Nodes only look their key up. They never resolve a
DSN themselves: a missing key raises, and outside a task (a save-time probe in
the server process) nothing is delivered, so the probe does static checks only
(datacore isolation SDD 4.6).

Stdlib only: nodes tests load this file in isolation.
"""

import json
import os
import re
import urllib.parse
from collections.abc import Iterable, Mapping

# The task engine resolves every DSN server-side at task start (only the
# server process has SaaS account context) and delivers them here as a JSON
# map, keyed by dsn_key(scope, target), for pipelines with RocketRide cloud
# DB nodes.
DB_DSNS_ENV = 'ROCKETRIDE_DB_DSNS'

# When server-side resolution fails (e.g. a broker outage), or the engine has
# no database broker at all, the task engine passes the reason down here
# instead of a DSN, so the node can report the real cause rather than a
# missing-identity error that nothing the user does can fix.
DB_RESOLVE_ERROR_ENV = 'ROCKETRIDE_DB_RESOLVE_ERROR'


# The node providers that use a RocketRide cloud database.
DB_PROVIDERS = frozenset({'rocketride_sql', 'rocketride_vector', 'rocketride_graph'})

# Source providers whose callers reach the run as its owner with no identity
# of their own: a pk_ chat, dropper or webhook link, or a chat bot. A pipeline
# with any of them exposes a public endpoint (SDD 4.4 hard rule 2). Every task
# gets a pk_ token, so the token alone can't decide this (open question 14).
PUBLIC_SOURCE_PROVIDERS = frozenset({'chat', 'dropper', 'webhook', 'discord', 'telegram'})

DB_SCOPES = ('org', 'team', 'user')

# A team or user id: the provisioner's owner-id shape
# (datacore/provisioner/provisioner.py _SAFE_ID), capped at the width the SaaS
# audit log stores (64).
_TARGET_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._@-]{0,63}')


class DsnNotDelivered(ValueError):
    """No DSN was delivered to this process: it is not a task.

    Raised to save-time probes, which run in the server process with no
    identity. They do static checks only; connectivity is checked when the
    pipeline runs.
    """


def db_target(config: Mapping) -> tuple[str, str]:
    """Read and check a DB node's ``(scope, target)`` from its resolved config.

    Args:
        config: The node config after ``Config.getNodeConfig`` (flat keys).

    Returns:
        ``(scope, target)``. scope defaults to ``'org'``; target ``''`` means
        the run's own team or user.

    Raises:
        ValueError: unknown scope, a target on the org scope, or a malformed id.
    """
    scope = config.get('scope') or 'org'
    target = config.get('target') or ''
    if not isinstance(scope, str) or scope.strip() not in DB_SCOPES:
        raise ValueError(f'scope must be one of {", ".join(DB_SCOPES)} (got {scope!r})')
    if not isinstance(target, str):
        raise ValueError(f'target must be a team or user id (got {target!r})')
    scope, target = scope.strip(), target.strip()
    if scope == 'org' and target:
        raise ValueError('the org scope takes no target: clear the target or pick the team or user scope')
    if target and not _TARGET_ID.fullmatch(target):
        raise ValueError(f'target {target!r} is not a valid team or user id')
    return scope, target


def dsn_key(scope: str, target: str = '') -> str:
    """The ``ROCKETRIDE_DB_DSNS`` key for a node's ``(scope, target)``."""
    return f'{scope}:{target}' if target else scope


def exposes_public_endpoint(components: Iterable) -> bool:
    """True when any component is a public source (``PUBLIC_SOURCE_PROVIDERS``)."""
    return any(isinstance(c, dict) and c.get('provider') in PUBLIC_SOURCE_PROVIDERS for c in components or ())


def _describe(scope: str, target: str) -> str:
    if scope == 'org':
        return 'the org database'
    return f'the {scope} database {target!r}' if target else f"the run's own {scope} database"


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


def resolve_rocketride_dsn(scope: str = 'org', target: str = '') -> str:
    """Return the DSN the task engine delivered for ``(scope, target)``.

    Lookup order:

    1. ``ROCKETRIDE_DB_DSNS``: the per-task map. A missing key raises; it
       never falls back to another database.
    2. ``ROCKETRIDE_DB_RESOLVE_ERROR``: server-side resolution failed, or the
       engine has no database broker. Raises with that reason.
    3. Nothing delivered: this process is not a task. Raises DsnNotDelivered.

    Returns the raw DSN (URL form, directly usable by ``psycopg2.connect``).
    Callers that need a SQLAlchemy engine URL should wrap the result in
    :func:`to_sqlalchemy_url`.

    Raises:
        ValueError: bad scope/target, a key missing from the map, or a
            server-side resolution failure.
        DsnNotDelivered: called outside a task.
    """
    scope, target = db_target({'scope': scope, 'target': target})
    key = dsn_key(scope, target)

    delivered = os.environ.get(DB_DSNS_ENV, '').strip()
    if delivered:
        try:
            dsns = json.loads(delivered)
        except ValueError:
            raise ValueError(f'{DB_DSNS_ENV} is not valid JSON') from None
        dsn = dsns.get(key) if isinstance(dsns, dict) else None
        if not isinstance(dsn, str) or not dsn.strip():
            raise ValueError(
                f'this task was not given {_describe(scope, target)}; the engine authorizes it at task start'
            )
        return dsn.strip()

    # Server-side resolution was attempted and failed, or the engine has no
    # database broker: report that reason.
    resolve_error = os.environ.get(DB_RESOLVE_ERROR_ENV, '').strip()
    if resolve_error:
        raise ValueError(f'RocketRide cloud database is not available for this task: {resolve_error}')

    raise DsnNotDelivered(
        'no RocketRide cloud database is delivered outside a running pipeline; connectivity is checked when it runs'
    )


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
