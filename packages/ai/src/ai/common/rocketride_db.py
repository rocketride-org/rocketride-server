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
import sys
import urllib.parse
from collections.abc import Iterable, Mapping, MutableMapping
from typing import NamedTuple

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


# The database broker (the data-core provisioner) is configured by the
# operator in the engine's own environment. The operator-only RR_ tier is the
# home of that credential: unlike ROCKETRIDE_*, no client can list, read,
# rewrite or expand it. The legacy ROCKETRIDE_DB_BROKER_* names still work as
# a deprecated fallback, but only as a pair from the same tier (see
# ``broker_config``), and they are hidden from the client-facing paths too.
DB_BROKER_URL_ENV = 'RR_DB_BROKER_URL'
DB_BROKER_TOKEN_ENV = 'RR_DB_BROKER_TOKEN'
LEGACY_DB_BROKER_URL_ENV = 'ROCKETRIDE_DB_BROKER_URL'
LEGACY_DB_BROKER_TOKEN_ENV = 'ROCKETRIDE_DB_BROKER_TOKEN'

# Operator-only settings for the tenant database connection itself (see
# ``enforce_dsn_tls``).
DB_TLS_ROOT_CERT_ENV = 'RR_DB_TLS_ROOT_CERT'
DB_ALLOW_INSECURE_DSN_ENV = 'RR_DB_ALLOW_INSECURE_DSN'

# Names that belong to the engine, not to a client or a pipeline. They are
# hidden from ``get_env``/``env_keys`` and from the ${...} expansion source,
# immune to ``set_env`` (it can neither create, change nor delete them), and
# scrubbed from every task's environment. Compared case-insensitively, like
# the task environment allowlist.
ENGINE_DB_ENV = frozenset(
    {
        DB_BROKER_URL_ENV,
        DB_BROKER_TOKEN_ENV,
        LEGACY_DB_BROKER_URL_ENV,
        LEGACY_DB_BROKER_TOKEN_ENV,
        DB_TLS_ROOT_CERT_ENV,
        DB_ALLOW_INSECURE_DSN_ENV,
        DB_DSNS_ENV,
        'ROCKETRIDE_DB_DSN',
        DB_RESOLVE_ERROR_ENV,
    }
)


def is_engine_db_env(name: str) -> bool:
    """True for a name in ``ENGINE_DB_ENV``, in any case."""
    return isinstance(name, str) and name.upper() in ENGINE_DB_ENV


def scrub_db_env(env: MutableMapping) -> None:
    """Remove every ``ENGINE_DB_ENV`` name, in any case, from ``env`` in place."""
    for name in [name for name in env if is_engine_db_env(name)]:
        del env[name]


class BrokerConfig(NamedTuple):
    """The database broker settings found in an environment.

    ``tier`` is 'operator' (RR_DB_BROKER_*), 'legacy' (ROCKETRIDE_DB_BROKER_*)
    or '' when nothing is set. ``missing`` names the variables of that tier
    that are unset or blank; the broker is configured when it is empty.
    """

    url: str
    token: str
    tier: str
    missing: tuple


def broker_config(environ: Mapping[str, str]) -> BrokerConfig:
    """Read the broker URL and token from ONE tier of ``environ``.

    The URL picks the tier (the operator tier first), and the token must come
    from the same tier: a token from the other tier is never paired with this
    tier's URL, because the legacy names live in the namespace a client may
    have been able to write. With no URL in either tier, the first tier with
    any value is reported, else the operator tier.
    """
    tiers = (
        ('operator', DB_BROKER_URL_ENV, DB_BROKER_TOKEN_ENV),
        ('legacy', LEGACY_DB_BROKER_URL_ENV, LEGACY_DB_BROKER_TOKEN_ENV),
    )
    values = {
        tier: ((environ.get(url_var) or '').strip(), (environ.get(token_var) or '').strip())
        for tier, url_var, token_var in tiers
    }
    chosen = next((t for t in tiers if values[t[0]][0]), None) or next(
        (t for t in tiers if any(values[t[0]])), tiers[0]
    )
    tier, url_var, token_var = chosen
    url, token = values[tier]
    missing = tuple(name for name, value in ((url_var, url), (token_var, token)) if not value)
    return BrokerConfig(url, token, tier if (url or token) else '', missing)


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


def is_db_provider(provider: object) -> bool:
    """True when ``provider`` names one of the RocketRide cloud DB nodes.

    The service registry finds a node whatever the case of its provider
    (``ROCKETRIDE_SQL`` loads ``rocketride_sql``), so the engine must too, or a
    differently-cased node would run without being authorized. Not stripped:
    the registry does not strip either, so ``' rocketride_sql'`` names nothing.
    """
    return isinstance(provider, str) and provider.lower() in DB_PROVIDERS


def exposes_public_endpoint(components: Iterable) -> bool:
    """True when any component is a public source (``PUBLIC_SOURCE_PROVIDERS``).

    Providers compare case-insensitively, like the service registry.
    """
    return any(
        isinstance(c, dict) and isinstance(c.get('provider'), str) and c['provider'].lower() in PUBLIC_SOURCE_PROVIDERS
        for c in components or ()
    )


def _describe(scope: str, target: str) -> str:
    if scope == 'org':
        return 'the org database'
    return f'the {scope} database {target!r}' if target else f"the run's own {scope} database"


# Task subprocesses of a hosted engine get this flag on their command line
# (task_engine.CONST_HOSTED_CHILD_FLAG); a pipeline can add flags but not remove it.
HOSTED_CHILD_FLAG = '--hosted'

_DSN_SCHEMES = ('postgres', 'postgresql')
_INSECURE_SSLMODES = ('disable', 'allow', 'prefer')
_SSLMODES = (*_INSECURE_SSLMODES, 'require', 'verify-ca', 'verify-full')
# The only connection parameters a tenant DSN may carry. Anything else (host,
# hostaddr, service, dbname, user, passfile, options, sslcert, sslkey,
# sslnegotiation, requiressl, channel_binding, ...) can redirect the
# connection or weaken its TLS, so it is refused, not dropped.
_DSN_QUERY_KEYS = ('sslmode', 'sslrootcert')


def _inspect_dsn(dsn: str) -> tuple:
    """Split a tenant DSN into ``(SplitResult, {query key: value})`` or refuse it.

    Raises:
        ValueError: with a noun phrase that never repeats any part of the DSN
            (it carries a password): a non-PostgreSQL DSN, one with a
            fragment / several hosts / no host / a bad port, a repeated
            parameter (after percent-decoding, so ``ssl%6dode`` counts as
            ``sslmode``), or a parameter outside ``_DSN_QUERY_KEYS``.
    """
    try:
        parts = urllib.parse.urlsplit(dsn)
        host = parts.hostname
        parts.port  # noqa: B018 (raises ValueError on a bad port)
    except ValueError:
        raise ValueError('DSN that cannot be parsed') from None
    if parts.scheme.lower() not in _DSN_SCHEMES:
        raise ValueError(f'non-PostgreSQL DSN (scheme {parts.scheme!r})')
    if parts.fragment or not host or ',' in parts.netloc.rpartition('@')[2]:
        raise ValueError('DSN with a fragment, several hosts or no host')
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True, separator='&')
    keys = [key for key, _ in pairs]
    repeated = sorted({key for key in keys if keys.count(key) > 1})
    if repeated:
        raise ValueError(f'DSN with a repeated parameter: {", ".join(repeated)}')
    unsupported = sorted(set(keys) - set(_DSN_QUERY_KEYS))
    if unsupported:
        raise ValueError(f'DSN with unsupported parameter(s): {", ".join(unsupported)}')
    return parts, dict(pairs)


def enforce_dsn_tls(dsn: str, *, hosted: bool, ca_file: str = '', allow_insecure: bool = False) -> str:
    """Check a broker-issued tenant DSN against the TLS policy and return the DSN to hand out.

    The DSN is PARSED and REBUILT, never appended to: scheme, userinfo, host,
    port and database are carried over byte for byte (a password with ``%40``
    or ``%25`` stays as it was) and only the query is rewritten. Any query
    parameter other than ``sslmode`` / ``sslrootcert``, a repeated one, a
    fragment, several hosts or a non-PostgreSQL scheme is refused. libpq takes
    the LAST of a repeated parameter while SQLAlchemy turns it into a tuple,
    and ``host=`` / ``hostaddr=`` / ``service=`` in the query override the
    URL, so a DSN is only safe when it says each thing once.

    Hosted engine (``hosted=True``): the connection must verify the server.
    A broker ``sslmode`` of require, verify-ca or verify-full is raised to
    ``verify-full`` and ``sslrootcert=<ca_file>`` is added. disable, allow,
    prefer, an unknown mode or a broker-chosen ``sslrootcert`` are refused,
    and a missing ``ca_file`` fails closed (``RR_DB_TLS_ROOT_CERT``).
    ``ca_file`` must be a single-purpose CA file: libpq reads ``sslrootcert``
    only and ignores ``SSL_CERT_FILE``, so the merged system + broker bundle
    that ``SSL_CERT_FILE`` points at is NOT acceptable here. Giving it a CA
    that signs only the database servers is also what makes a DSN host the
    broker should not have chosen unusable. ``allow_insecure`` is ignored.

    Otherwise (a local or self-hosted engine): an absent ``sslmode`` becomes
    ``require`` and a stronger one passes. disable, allow and prefer are
    refused unless ``allow_insecure`` (``RR_DB_ALLOW_INSECURE_DSN=1``) is set.
    A ``sslrootcert`` the broker chose is kept there.

    Raises:
        RuntimeError: the DSN or the configuration fails the policy; the
            message never contains the DSN.
    """
    try:
        parts, query = _inspect_dsn(dsn)
    except ValueError as e:
        raise RuntimeError(f'DB broker returned a {e}') from None

    mode = query.get('sslmode')
    if mode is not None and mode not in _SSLMODES:
        raise RuntimeError('DB broker returned a DSN with an unsupported sslmode')
    if hosted:
        if not ca_file:
            raise RuntimeError(
                f'{DB_TLS_ROOT_CERT_ENV} is not set: a hosted engine verifies the database server certificate '
                'and has no CA file to verify it against'
            )
        if mode in _INSECURE_SSLMODES:
            raise RuntimeError(f'DB broker returned a DSN with sslmode={mode}, which a hosted engine never accepts')
        if 'sslrootcert' in query:
            raise RuntimeError('DB broker returned a DSN that chooses its own CA: only the operator names it')
        query = {'sslmode': 'verify-full', 'sslrootcert': ca_file}
    else:
        if mode in _INSECURE_SSLMODES and not allow_insecure:
            raise RuntimeError(
                f'DB broker returned a DSN with sslmode={mode}; set {DB_ALLOW_INSECURE_DSN_ENV}=1 to accept it '
                'on a local engine'
            )
        query = {
            'sslmode': mode or 'require',
            **({'sslrootcert': query['sslrootcert']} if 'sslrootcert' in query else {}),
        }
    rebuilt = urllib.parse.urlencode(query, quote_via=urllib.parse.quote, safe='/')
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, rebuilt, ''))


def check_hosted_dsn(dsn: str) -> None:
    """Assert that ``dsn`` carries the hosted TLS policy; never rewrites it.

    The engine already rebuilt the DSN (:func:`enforce_dsn_tls`); a hosted
    task checks what it was handed before connecting, so a regression or a
    tampered delivery fails the node instead of connecting weakly.

    Raises:
        ValueError: ``sslmode`` is not ``verify-full``, ``sslrootcert`` is
            missing, or the DSN has a repeated or unsupported parameter.
    """
    try:
        _, query = _inspect_dsn(dsn)
    except ValueError as e:
        raise ValueError(f'hosted policy: the delivered database connection is a {e}') from None
    if query.get('sslmode') != 'verify-full' or not query.get('sslrootcert'):
        raise ValueError(
            'hosted policy: the delivered database connection does not verify the server '
            '(it needs sslmode=verify-full and an sslrootcert)'
        )


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
    In a hosted task (``--hosted`` on the command line) the DSN is first
    checked against the hosted TLS policy (:func:`check_hosted_dsn`).
    Callers that need a SQLAlchemy engine URL should wrap the result in
    :func:`to_sqlalchemy_url`.

    Raises:
        ValueError: bad scope/target, a key missing from the map, a
            server-side resolution failure, or (hosted) a DSN that fails the
            TLS policy.
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
        dsn = dsn.strip()
        if HOSTED_CHILD_FLAG in sys.argv:
            check_hosted_dsn(dsn)
        return dsn

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
