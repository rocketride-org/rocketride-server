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

"""TLS policy of the RocketRide cloud database DSN, against a REAL TLS PostgreSQL.

``rocketride_db.enforce_dsn_tls`` decides what a DSN handed out by the database
broker may say about TLS. These tests run its output through the two ways the
cloud database nodes connect:

* ``psycopg2.connect(dsn)``                           (``rocketride_graph`` / ``rocketride_vector``)
* ``create_engine(to_sqlalchemy_url(dsn)).connect()`` (``rocketride_sql``)

against a PostgreSQL that only speaks TLS, with a certificate from a throwaway
CA that names ``localhost`` only (see ``db_harness/start-pg-tls.sh``).

The invariant is "fail closed, never a silent downgrade": for every DSN a broker
could return, the policy either refuses it or hands back a DSN that
(a) says ``verify-full`` against the configured CA and carries no connection
override (``host``, ``hostaddr``, ``service``, ``options``, ...), and
(b) really connects over verified TLS through BOTH connection forms. A right
CA with a wrong host name, and a wrong CA, are refused by the database client.

Configuration (the server is started outside the run, by CI or a developer)::

    nodes/test/db_harness/start-pg-tls.sh           # prints the two variables
    RR_TEST_PG_TLS_PORT   host port of the server
    RR_TEST_PG_TLS_CA     path to the CA PEM that signed its certificate

Skips cleanly when the server is not configured or unreachable; fails instead
when ``RR_REQUIRE_DB_TESTS`` is set (CI sets it once its containers are healthy).
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

from .db_harness import pg_tls, pki

_REPO = Path(__file__).resolve().parents[2]
_RRDB_PATH = _REPO / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'rocketride_db.py'

if pg_tls.required():
    import psycopg2
    import sqlalchemy  # noqa: F401
else:
    psycopg2 = pytest.importorskip('psycopg2')
    pytest.importorskip('sqlalchemy')

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402


def _load_rrdb():
    """Load ai.common.rocketride_db in isolation (it only imports the standard library)."""
    spec = importlib.util.spec_from_file_location('_tls_full_rocketride_db', _RRDB_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rrdb = _load_rrdb()


def enforce(dsn, *, hosted=True, ca_file=None, allow_insecure=False):
    """``rocketride_db.enforce_dsn_tls`` (a missing function is a failing test, not a skip)."""
    fn = getattr(rrdb, 'enforce_dsn_tls', None)
    assert fn is not None, 'ai.common.rocketride_db.enforce_dsn_tls does not exist yet'
    return fn(dsn, hosted=hosted, ca_file=ca_file, allow_insecure=allow_insecure)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope='module')
def server() -> pg_tls.TlsServer:
    return pg_tls.locate()


@pytest.fixture(scope='module')
def wrong_ca(tmp_path_factory) -> Path:
    """A CA that did not sign the server's certificate."""
    try:
        return pki.mint(tmp_path_factory.mktemp('rr-tls-wrong-ca')).other_ca
    except pki.PkiUnavailable as e:
        if pg_tls.required():
            raise
        pytest.skip(str(e))


# ---------------------------------------------------------------------------
# The two connection forms the nodes use
# ---------------------------------------------------------------------------


def connect_psycopg2(dsn: str) -> dict:
    """The graph/vector form: ``psycopg2.connect(dsn)``. Returns what the server says about the session."""
    conn = psycopg2.connect(dsn, connect_timeout=8)
    try:
        cur = conn.cursor()
        cur.execute(
            'select current_database(), s.ssl, s.version from pg_stat_ssl s where s.pid = pg_backend_pid()',
        )
        database, ssl_on, version = cur.fetchone()
        return {'database': database, 'ssl': ssl_on, 'tls_version': version}
    finally:
        conn.close()


def connect_sqlalchemy(dsn: str) -> dict:
    """The SQL form: ``create_engine(to_sqlalchemy_url(dsn))`` (query parameters become libpq options)."""
    engine = create_engine(rrdb.to_sqlalchemy_url(dsn), poolclass=NullPool, connect_args={'connect_timeout': 8})
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text('select current_database(), s.ssl, s.version from pg_stat_ssl s where s.pid = pg_backend_pid()')
            ).one()
            return {'database': row[0], 'ssl': row[1], 'tls_version': row[2]}
    finally:
        engine.dispose()


CONNECTION_FORMS = pytest.mark.parametrize(
    'connect',
    [connect_psycopg2, connect_sqlalchemy],
    ids=['psycopg2-graph-vector', 'sqlalchemy-sql'],
)


def libpq_view(dsn: str) -> dict:
    """What libpq itself will use (its own parser, not ours)."""
    return psycopg2.extensions.parse_dsn(dsn)


# ---------------------------------------------------------------------------
# Accepted DSNs become verify-full against the configured CA, and really verify
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'query',
    ['sslmode=require', '', 'sslmode=verify-ca', 'sslmode=verify-full'],
    ids=['require', 'no-sslmode', 'verify-ca', 'verify-full'],
)
@CONNECTION_FORMS
def test_hosted_policy_upgrades_to_verify_full_and_connects_over_verified_tls(server, connect, query):
    returned = enforce(server.dsn(query=query), hosted=True, ca_file=str(server.ca))

    view = libpq_view(returned)
    assert view['sslmode'] == 'verify-full'
    assert view['sslrootcert'] == str(server.ca)
    session = connect(returned)
    assert session['ssl'] is True
    assert session['database'] == 't_orga'


@CONNECTION_FORMS
def test_right_ca_but_wrong_host_name_is_refused_by_the_client(server, connect):
    """``127.0.0.1`` reaches the server, but its certificate names ``localhost`` only."""
    returned = enforce(server.dsn(host='127.0.0.1'), hosted=True, ca_file=str(server.ca))

    assert libpq_view(returned)['sslmode'] == 'verify-full'
    with pytest.raises(Exception) as refused:
        connect(returned)
    assert 'does not match host name' in str(refused.value)


@CONNECTION_FORMS
def test_wrong_ca_is_refused_by_the_client(server, wrong_ca, connect):
    returned = enforce(server.dsn(), hosted=True, ca_file=str(wrong_ca))

    with pytest.raises(Exception) as refused:
        connect(returned)
    assert 'certificate verify failed' in str(refused.value)


@CONNECTION_FORMS
def test_the_server_alone_would_not_have_stopped_a_downgrade_to_unverified_tls(server, connect):
    """Why the policy matters: ``require`` encrypts but does not authenticate.

    The same server certificate, which does not match the host name, is accepted
    when the DSN says ``require`` and no CA (what the broker sends today). Only
    ``verify-full`` against a CA refuses it. Without the policy this is the
    connection a hosted engine would make.
    """
    unverified = server.dsn(host='127.0.0.1', query='sslmode=require')

    session = connect(unverified)
    assert session['ssl'] is True  # encrypted ... to whoever answered
    enforced = enforce(unverified, hosted=True, ca_file=str(server.ca))  # outside the block: a bug here must not pass
    with pytest.raises(psycopg2.OperationalError if connect is connect_psycopg2 else Exception):
        connect(enforced)


# ---------------------------------------------------------------------------
# Broker-returned downgrades and overrides: fail closed before any connect
# ---------------------------------------------------------------------------

HOSTILE = {
    'sslmode-disable': 'sslmode=disable',
    'sslmode-allow': 'sslmode=allow',
    'sslmode-prefer': 'sslmode=prefer',
    'sslmode-unknown': 'sslmode=nonsense',
    'duplicate-require-then-disable': 'sslmode=require&sslmode=disable',
    'duplicate-disable-then-require': 'sslmode=disable&sslmode=require',
    'duplicate-verify-full-then-allow': 'sslmode=verify-full&sslmode=allow',
    'percent-encoded-key': 'ssl%6Dode=disable',
    'host-override': 'sslmode=require&host=attacker.example',
    'hostaddr-override': 'sslmode=require&hostaddr=203.0.113.9',
    'sslrootcert-dev-null': 'sslmode=verify-ca&sslrootcert=/dev/null',
    'sslrootcert-other-file': 'sslmode=verify-full&sslrootcert=/etc/ssl/cert.pem',
    'sslcert-sslkey': 'sslmode=require&sslcert=/tmp/c&sslkey=/tmp/k',
    'service': 'sslmode=require&service=anything',
    'passfile': 'sslmode=require&passfile=/tmp/pass',
    'options': 'sslmode=require&options=-c%20search_path%3Dpublic',
    'requiressl-off': 'requiressl=0',
    'channel-binding-off': 'sslmode=require&channel_binding=disable',
    'target-session-attrs': 'sslmode=require&target_session_attrs=any',
    'ssl-min-protocol-version': 'sslmode=require&ssl_min_protocol_version=TLSv1',
}


@pytest.mark.parametrize('variant', sorted(HOSTILE))
def test_hostile_query_is_rejected_by_policy_before_any_connect(server, monkeypatch, variant):
    def no_connect(*args, **kwargs):
        raise AssertionError('a connection was attempted before the policy decided')

    monkeypatch.setattr(psycopg2, 'connect', no_connect)

    with pytest.raises(RuntimeError):
        enforce(server.dsn(query=HOSTILE[variant]), hosted=True, ca_file=str(server.ca))


STRUCTURAL = {
    'fragment': 'postgresql://u:p@localhost:5432/t_x?sslmode=require#sslmode=disable',
    'several-hosts': 'postgresql://u:p@h1:5432,h2:5432/t_x?sslmode=require',
    'no-host': 'postgresql:///t_x?sslmode=require',
    'keyword-value': 'host=localhost user=u password=p dbname=t_x sslmode=disable',
    'other-database-scheme': 'mysql://u:p@localhost:3306/t_x',
    'sqlalchemy-driver-scheme': 'postgresql+psycopg2://u:p@localhost:5432/t_x?sslmode=require',
}


@pytest.mark.parametrize('variant', sorted(STRUCTURAL))
def test_structurally_unsafe_dsn_is_rejected_by_policy(server, variant):
    with pytest.raises(RuntimeError):
        enforce(STRUCTURAL[variant], hosted=True, ca_file=str(server.ca))


@pytest.mark.parametrize('variant', sorted(HOSTILE))
@CONNECTION_FORMS
def test_no_broker_variant_ever_yields_an_unverified_connection(server, connect, variant):
    """The invariant, over both connection forms: refused, or verify-full against the CA and connected.

    Whatever a broker returns, a hosted engine never ends up with a session whose
    server it did not authenticate. (When the policy refuses, nothing connects.)
    """
    try:
        returned = enforce(server.dsn(query=HOSTILE[variant]), hosted=True, ca_file=str(server.ca))
    except RuntimeError:
        return  # failed closed

    view = libpq_view(returned)
    assert view['sslmode'] == 'verify-full'
    assert view['sslrootcert'] == str(server.ca)
    for override in ('host', 'hostaddr', 'service', 'options', 'passfile', 'sslcert', 'sslkey'):
        assert override not in view or (override == 'host' and view['host'] == server.host)
    assert connect(returned)['ssl'] is True


def test_hosted_policy_without_a_database_ca_refuses_to_hand_out_a_dsn(server):
    with pytest.raises(RuntimeError):
        enforce(server.dsn(), hosted=True, ca_file=None)


def test_hosted_policy_ignores_the_insecure_development_switch(server):
    with pytest.raises(RuntimeError):
        enforce(server.dsn(query='sslmode=disable'), hosted=True, ca_file=str(server.ca), allow_insecure=True)


# ---------------------------------------------------------------------------
# Non-hosted engines: explicit, narrow exception
# ---------------------------------------------------------------------------


def test_non_hosted_engine_refuses_a_downgrade_unless_explicitly_allowed(server):
    with pytest.raises(RuntimeError):
        enforce(server.dsn(query='sslmode=disable'), hosted=False)


def test_non_hosted_insecure_switch_only_lets_the_dsn_through_the_server_still_refuses(server):
    """``RR_DB_ALLOW_INSECURE_DSN`` is a policy exception, not a way around the server's own rules."""
    returned = enforce(server.dsn(query='sslmode=disable'), hosted=False, allow_insecure=True)

    assert libpq_view(returned)['sslmode'] == 'disable'
    with pytest.raises(psycopg2.OperationalError) as refused:
        connect_psycopg2(returned)
    assert 'no encryption' in str(refused.value)


def test_non_hosted_engine_without_a_ca_still_encrypts(server):
    """No CA available (a developer machine): ``require`` is the floor, and it does reach the server over TLS."""
    returned = enforce(server.dsn(query=''), hosted=False)

    assert libpq_view(returned)['sslmode'] == 'require'
    assert connect_psycopg2(returned)['ssl'] is True


# ---------------------------------------------------------------------------
# The CA the DSN carries is the dedicated database CA, never a merged bundle
# ---------------------------------------------------------------------------


def test_hosted_dsn_carries_the_dedicated_database_ca_not_a_merged_bundle(server, wrong_ca, tmp_path, monkeypatch):
    """``SSL_CERT_FILE`` is a merged multi-CA bundle in a deployment (it also trusts the broker's CA).

    The DSN must name the one CA that signs the database, ``RR_DB_TLS_ROOT_CERT``,
    so that trusting the broker's CA, or any CA in the bundle, never helps a
    server impersonate the database.
    """
    merged = pki.bundle(tmp_path / 'merged-bundle.pem', wrong_ca, server.ca)
    monkeypatch.setenv('SSL_CERT_FILE', str(merged))

    returned = enforce(server.dsn(), hosted=True, ca_file=str(server.ca))

    carried = libpq_view(returned)['sslrootcert']
    assert carried == str(server.ca)
    assert carried != os.environ['SSL_CERT_FILE']
    assert connect_psycopg2(returned)['ssl'] is True
