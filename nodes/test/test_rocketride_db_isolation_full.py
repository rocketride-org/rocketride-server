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

"""Tenant isolation of the RocketRide cloud database path, through a REAL launched engine.

One hosted engine (``--saas``) is started and driven with the Python client. Tasks
are launched for two synthetic organisations; their ``rocketride_sql`` nodes run
as real task subprocesses and connect, over verified TLS (``verify-full``), to
one synthetic tenant database each on a TLS PostgreSQL. A fake HTTPS broker stands
in for the data-core provisioner.

WHAT THIS IS, AND IS NOT. The account is a TEST-ONLY stand-in
(``db_harness/extension/saas``): it maps two API keys to two organisations and its
``authorize_db_target`` allows a caller's OWN organisation database only. It is a
proxy. It does NOT exercise the real SaaS authorizer (membership, audit, the
``decide_db_access`` rules); those are proven by the SaaS repository's own tests.
What these tests prove is about the ENGINE: it authorizes the resolved targets
BEFORE it provisions anything, provisions exactly what was approved, hands a task
only the DSNs approved for it, scrubs everything else from the task, and fails
closed when anything is missing or wrong.

Acceptance criteria covered (see the task brief): 2 spoof resistance, 3
authorization precedes issuance, 4 credential confinement, 6 concurrency, and the
secrets-in-logs half of 9.

Needs (skips cleanly otherwise; fails under ``RR_REQUIRE_DB_TESTS``):

* the TLS PostgreSQL of ``db_harness/start-pg-tls.sh``
  (``RR_TEST_PG_TLS_PORT``, ``RR_TEST_PG_TLS_CA``);
* a run under the built engine (``./builder nodes:test-full``, or
  ``dist/server/engine -m pytest ...``) so a real engine can be launched.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from types import SimpleNamespace

import pytest

from .db_harness import engine as engine_mod
from .db_harness import pg_tls, pki
from .db_harness.broker import FakeBroker

# Under RR_REQUIRE_DB_TESTS a missing client must fail the run, not skip the
# whole module at import time (same rule as test_rocketride_db_tls_full.py).
if pg_tls.required():
    import psycopg2
    import rocketride
else:
    psycopg2 = pytest.importorskip('psycopg2')
    rocketride = pytest.importorskip('rocketride')

BROKER_TOKEN = 'isolation-broker-token-5d1c0e'
KEYS = {'orga': 'key-orga', 'orgb': 'key-orgb', 'noorg': 'key-noorg'}
ORG_IDS = {'orga': 'org-aaa', 'orgb': 'org-bbb'}
TENANT_OF_ORG = {'org-aaa': 'orga', 'org-bbb': 'orgb'}
EXPECTED = {'orga': ('t_orga', 'r_orga'), 'orgb': ('t_orgb', 'r_orgb')}
WHO_AM_I = 'select current_database() as db, current_user as usr'


# ---------------------------------------------------------------------------
# Stack: TLS PostgreSQL + fake broker + one hosted engine (module scope)
# ---------------------------------------------------------------------------


def _unavailable(reason: str):
    if pg_tls.required():
        pytest.fail(f'{pg_tls.ENV_REQUIRE} is set but {reason}', pytrace=False)
    pytest.skip(reason)


@pytest.fixture(scope='module')
def server() -> pg_tls.TlsServer:
    return pg_tls.locate()


@pytest.fixture(scope='module')
def stack(server, tmp_path_factory):
    try:
        engine_mod.check_available()
    except engine_mod.EngineUnavailable as e:
        _unavailable(str(e))
    workdir = tmp_path_factory.mktemp('rr-db-isolation')
    try:
        broker_pki = pki.mint(workdir / 'broker-pki')
    except pki.PkiUnavailable as e:
        _unavailable(str(e))

    def dsn_for_tenant(name: str):
        # What the provisioner returns: the tenant's database, sslmode=require.
        if name in TENANT_OF_ORG:
            return server.dsn(TENANT_OF_ORG[name])
        return None

    broker = FakeBroker(cert=broker_pki.cert, key=broker_pki.key, token=BROKER_TOKEN, dsn_for_tenant=dsn_for_tenant)
    engine = engine_mod.HostedEngine(
        workdir,
        broker_url=broker.url,
        broker_token=BROKER_TOKEN,
        db_ca=server.ca,
        broker_ca=broker_pki.ca,
        extra_env={'RR_STORE_URL': f'filesystem://{(workdir / "store").as_posix()}'},
    )
    try:
        engine.start()
    except engine_mod.EngineUnavailable as e:
        broker.close()
        pytest.fail(str(e), pytrace=False)
    events: list[str] = []
    yield SimpleNamespace(
        server=server, broker=broker, engine=engine, workdir=workdir, events=events, broker_pki=broker_pki
    )
    engine.stop()
    broker.close()


@pytest.fixture(autouse=True)
def _fresh(request):
    """Every test starts with an empty broker call log, no armed barrier and an empty authorization log."""
    stack = request.getfixturevalue('stack')
    stack.broker.reset()
    stack.engine.reset_authorizations()
    yield


# ---------------------------------------------------------------------------
# Driving the engine
# ---------------------------------------------------------------------------


def webhook(node_id='webhook_1'):
    return {'id': node_id, 'provider': 'webhook', 'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'}}


def sql_node(node_id='sql_1', *, provider='rocketride_sql', **config):
    config.setdefault('allow_execute', True)
    return {
        'id': node_id,
        'provider': provider,
        'config': config,
        'input': [{'lane': 'questions', 'from': 'webhook_1'}],
    }


def pipeline(*nodes, extra=None):
    body = {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': [webhook(), *nodes]}
    body.update(extra or {})
    return body


class Session:
    """One client connection to the engine, as one organisation."""

    def __init__(self, stack, who: str):
        self.stack, self.who = stack, who
        self.client = None
        self.tokens: list[str] = []
        self.pipelines: dict[str, dict] = {}

    async def __aenter__(self) -> 'Session':
        async def collect(message):
            self.stack.events.append(json.dumps(message, default=str))

        self.client = rocketride.RocketRideClient(uri=self.stack.engine.uri, auth=KEYS[self.who], on_event=collect)
        await self.client.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        for token in self.tokens:
            try:
                await self.client.terminate(token)
            except Exception:  # noqa: S110 - already gone is fine
                pass
        await self.client.disconnect()

    async def start(self, body: dict, *, env=None, args=None, **options) -> str:
        arguments = dict(options)
        if env is not None:
            arguments['env'] = env
        if args is not None:
            arguments['args'] = args
        result = await self.client.use(pipeline=body, ttl=0, **arguments)
        self.tokens.append(result['token'])
        self.pipelines[result['token']] = body
        return result['token']

    async def query(self, token: str, sql: str, node_id: str = 'sql_1') -> dict:
        out = await self.client.tool(
            token=token, tool='execute', node_id=node_id, input={'sql': sql, 'row_mode': 'object'}
        )
        return out['rows'][0]


def assert_own_database(row: dict, who: str) -> None:
    """The one assertion every isolation case uses: the session is on THIS tenant's database and role."""
    assert (row['db'], row['usr']) == EXPECTED[who], f'{who} reached {row["db"]} as {row["usr"]}'


def role_sessions(server, role: str) -> int:
    """How many sessions a tenant role holds open right now (a superuser, verified TLS)."""
    conn = psycopg2.connect(
        host=server.host,
        port=server.port,
        user='rruser',
        password='rrpass',
        dbname='rrtenant',
        sslmode='verify-full',
        sslrootcert=str(server.ca),
        connect_timeout=8,
    )
    try:
        cur = conn.cursor()
        cur.execute('select count(*) from pg_stat_activity where usename = %s', (role,))
        return cur.fetchone()[0]
    finally:
        conn.close()


class ActivityMonitor:
    """Watches ``pg_stat_activity`` from outside and records when both tenants run a marked query at once."""

    def __init__(self, server, marker: str):
        self.server, self.marker = server, marker
        self.seen_together: set[tuple[str, str]] = set()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(10)

    def _run(self):
        conn = psycopg2.connect(
            host=self.server.host,
            port=self.server.port,
            user='rruser',
            password='rrpass',
            dbname='rrtenant',
            sslmode='verify-full',
            sslrootcert=str(self.server.ca),
            connect_timeout=8,
        )
        conn.autocommit = True
        cur = conn.cursor()
        try:
            while not self._stop.is_set():
                cur.execute(
                    "select datname, usename from pg_stat_activity where state = 'active' "
                    'and query like %s and pid <> pg_backend_pid()',
                    (f'%{self.marker}%',),
                )
                rows = set(cur.fetchall())
                if {('t_orga', 'r_orga'), ('t_orgb', 'r_orgb')} <= rows:
                    self.seen_together = rows
                    return
                time.sleep(0.02)
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 6. Concurrency: two tenants overlap in flight and reach only their own database
# ---------------------------------------------------------------------------


async def test_overlapping_tenants_each_reach_only_their_own_database(stack):
    marker = f'rr_overlap_{uuid.uuid4().hex[:8]}'
    stack.broker.arm_barrier(2)  # a provision answer is released only when BOTH tenants are in flight
    async with Session(stack, 'orga') as a, Session(stack, 'orgb') as b:
        token_a, token_b = await asyncio.gather(a.start(pipeline(sql_node())), b.start(pipeline(sql_node())))

        assert stack.broker.barrier_released == {'org-aaa': True, 'org-bbb': True}, 'the starts did not overlap'
        assert sorted(c.tenant for c in stack.broker.calls) == ['org-aaa', 'org-bbb']
        assert all(c.authorized for c in stack.broker.calls)

        # Now run a query on each at the same time and watch the server for both being active at once.
        slow = f'/* {marker} */ select current_database() as db, current_user as usr, pg_sleep(2)'
        with ActivityMonitor(stack.server, marker) as monitor:
            row_a, row_b = await asyncio.gather(a.query(token_a, slow), b.query(token_b, slow))

    assert_own_database(row_a, 'orga')
    assert_own_database(row_b, 'orgb')
    assert monitor.seen_together == {('t_orga', 'r_orga'), ('t_orgb', 'r_orgb')}, 'the queries never overlapped'
    assert [r['org_id'] for r in stack.engine.authorizations()] == ['org-aaa', 'org-bbb'] or sorted(
        r['org_id'] for r in stack.engine.authorizations()
    ) == ['org-aaa', 'org-bbb']


async def test_a_swapped_dsn_would_be_seen_by_the_isolation_assertion(stack):
    """The other tests can fail: if the broker hands tenant B tenant A's database, the check trips.

    This is the deliberate-swap negative. It does not test the engine (the engine cannot know a
    broker answered wrongly); it proves the assertion used everywhere else discriminates.
    """
    stack.broker.set_mode('org-bbb', 'dsn-of:org-aaa')
    async with Session(stack, 'orgb') as b:
        token = await b.start(pipeline(sql_node()))
        row = await b.query(token, WHO_AM_I)

    assert (row['db'], row['usr']) == EXPECTED['orga']
    with pytest.raises(AssertionError):
        assert_own_database(row, 'orgb')


# ---------------------------------------------------------------------------
# 2. Spoof resistance: the caller cannot choose whose database it gets
# ---------------------------------------------------------------------------


def _other_tenants_dsn(stack) -> str:
    """A working, fully verified DSN for tenant B: the best possible forged credential."""
    return stack.server.dsn('orgb', query=f'sslmode=verify-full&sslrootcert={stack.server.ca}')


ENV_SPOOFS = {
    'client-id-user-of-b': lambda stack: {'ROCKETRIDE_CLIENT_ID': 'user-bbb'},
    'client-id-org-of-b': lambda stack: {'ROCKETRIDE_CLIENT_ID': 'org-bbb'},
    'dsn-map': lambda stack: {'ROCKETRIDE_DB_DSNS': json.dumps({'org': _other_tenants_dsn(stack)})},
    'single-dsn': lambda stack: {'ROCKETRIDE_DB_DSN': _other_tenants_dsn(stack)},
    'dsn-map-lowercase-name': lambda stack: {'rocketride_db_dsns': json.dumps({'org': _other_tenants_dsn(stack)})},
    'resolve-error': lambda stack: {'ROCKETRIDE_DB_RESOLVE_ERROR': 'forged'},
    'legacy-broker-vars': lambda stack: {
        'ROCKETRIDE_DB_BROKER_URL': 'https://localhost:9/provision',
        'ROCKETRIDE_DB_BROKER_TOKEN': 'forged-token',
    },
    'operator-broker-vars': lambda stack: {
        'RR_DB_BROKER_URL': 'https://localhost:9/provision',
        'RR_DB_BROKER_TOKEN': 'forged-token',
    },
    'tls-root-cert': lambda stack: {'RR_DB_TLS_ROOT_CERT': '/dev/null'},
    'allow-insecure': lambda stack: {'RR_DB_ALLOW_INSECURE_DSN': '1', 'ROCKETRIDE_DB_ALLOW_INSECURE_DSN': '1'},
    'everything-at-once': lambda stack: {
        'ROCKETRIDE_CLIENT_ID': 'user-bbb',
        'ROCKETRIDE_DB_DSNS': json.dumps({'org': _other_tenants_dsn(stack)}),
        'ROCKETRIDE_DB_DSN': _other_tenants_dsn(stack),
        'ROCKETRIDE_DB_BROKER_URL': 'https://localhost:9/provision',
        'ROCKETRIDE_DB_BROKER_TOKEN': 'forged-token',
    },
}


@pytest.mark.parametrize('spoof', sorted(ENV_SPOOFS))
async def test_caller_environment_cannot_choose_the_database(stack, spoof):
    env = ENV_SPOOFS[spoof](stack)
    async with Session(stack, 'orga') as a:
        token = await a.start(pipeline(sql_node()), env=env)
        row = await a.query(token, WHO_AM_I)

    assert_own_database(row, 'orga')
    assert [(c.tenant, c.authorized) for c in stack.broker.calls] == [('org-aaa', True)]
    assert {r['org_id'] for r in stack.engine.authorizations()} == {'org-aaa'}


async def test_caller_environment_names_never_reach_the_task(stack):
    """Nothing the caller sent as a database setting survives into the task's own environment."""
    env = {
        'ROCKETRIDE_DB_DSNS': json.dumps({'org': _other_tenants_dsn(stack)}),
        'ROCKETRIDE_DB_DSN': _other_tenants_dsn(stack),
        'ROCKETRIDE_DB_BROKER_TOKEN': 'forged-token',
        'ROCKETRIDE_CLIENT_ID': 'user-bbb',
    }
    async with Session(stack, 'orga') as a:
        token = await a.start(pipeline(sql_node()), env=env)
        # The task's own view of its environment, through the SQL node's host process.
        row = await a.query(token, WHO_AM_I)

    assert_own_database(row, 'orga')
    forged = _other_tenants_dsn(stack)
    assert forged not in stack.engine.output()


SAME_TENANT_VARIANTS = {
    'scope-with-spaces': {'config': {'scope': ' org '}},
    'explicit-empty-target': {'config': {'scope': 'org', 'target': ''}},
    'uppercase-provider': {'provider': 'ROCKETRIDE_SQL'},
    'mixed-case-provider': {'provider': 'RocketRide_Sql'},
}

PIPELINE_ENVELOPE_SPOOFS = {
    'top-level-org-fields': {
        'orgId': 'org-bbb',
        'org_id': 'org-bbb',
        'client_id': 'user-bbb',
        'userId': 'user-bbb',
        'teamId': 'team-bbb',
        'identity': {'orgId': 'org-bbb', 'userId': 'user-bbb', 'teamId': 'team-bbb'},
    },
}


@pytest.mark.parametrize('variant', sorted(SAME_TENANT_VARIANTS))
async def test_case_and_whitespace_variants_that_are_valid_stay_on_the_callers_tenant(stack, variant):
    spec = SAME_TENANT_VARIANTS[variant]
    node = sql_node(provider=spec.get('provider', 'rocketride_sql'), **spec.get('config', {}))
    async with Session(stack, 'orga') as a:
        token = await a.start(pipeline(node))
        row = await a.query(token, WHO_AM_I)

    assert_own_database(row, 'orga')
    assert [c.tenant for c in stack.broker.calls] == ['org-aaa']


@pytest.mark.parametrize('variant', sorted(PIPELINE_ENVELOPE_SPOOFS))
async def test_identity_fields_inside_the_pipeline_are_ignored(stack, variant):
    body = pipeline(sql_node(), extra=PIPELINE_ENVELOPE_SPOOFS[variant])
    body['components'][1].update({'orgId': 'org-bbb', 'client_id': 'user-bbb'})
    async with Session(stack, 'orga') as a:
        token = await a.start(body)
        row = await a.query(token, WHO_AM_I)

    assert_own_database(row, 'orga')
    assert [c.tenant for c in stack.broker.calls] == ['org-aaa']


REFUSED_TARGETS = {
    # Not valid scope spellings: the real db_target rules reject them; no normalisation merges them with 'org'.
    'scope-uppercase': {'scope': 'ORG'},
    'scope-capitalised': {'scope': 'Org'},
    'scope-cyrillic-o': {'scope': 'оrg'},
    'scope-zero-width-space': {'scope': 'org​'},
    'scope-fullwidth': {'scope': 'ｏｒｇ'},
    'scope-unknown': {'scope': 'tenant'},
    # The org scope takes no target.
    'org-with-other-tenant-target': {'scope': 'org', 'target': 'org-bbb'},
    # Valid spellings that name another tenant's team or user: the authorizer denies them (own org only).
    'team-of-b': {'scope': 'team', 'target': 'team-bbb'},
    'team-of-b-with-spaces': {'scope': 'team', 'target': ' team-bbb '},
    'team-of-b-uppercase': {'scope': 'team', 'target': 'TEAM-BBB'},
    'user-of-b': {'scope': 'user', 'target': 'user-bbb'},
    'own-team': {'scope': 'team', 'target': ''},
    'own-user': {'scope': 'user', 'target': ''},
    # Not valid ids: lookalike hyphen, slash, wildcard.
    'target-non-breaking-hyphen': {'scope': 'team', 'target': 'team‑bbb'},
    'target-slash': {'scope': 'team', 'target': 'team-bbb/../team-aaa'},
    'target-wildcard': {'scope': 'team', 'target': '*'},
}


@pytest.mark.parametrize('variant', sorted(REFUSED_TARGETS))
async def test_other_tenants_and_lookalike_targets_are_refused_before_any_provisioning(stack, variant):
    async with Session(stack, 'orga') as a:
        with pytest.raises(Exception):  # noqa: B017 - the refusal text is checked below
            await a.start(pipeline(sql_node(**REFUSED_TARGETS[variant])))

    assert stack.broker.calls == [], 'something was provisioned for a refused target'
    assert not any(r['allowed'] and r['scope'] != 'org' for r in stack.engine.authorizations())
    assert {r['org_id'] for r in stack.engine.authorizations()} <= {'org-aaa'}


async def test_a_variable_expanded_target_naming_the_other_tenant_is_authorized_after_expansion(stack):
    """``${...}`` is expanded before the engine reads the target, so the target that is authorized is the real one."""
    node = sql_node(scope='team', target='${ROCKETRIDE_OTHER_TEAM}')
    async with Session(stack, 'orga') as a:
        with pytest.raises(Exception) as refused:  # noqa: B017
            await a.start(pipeline(node), env={'ROCKETRIDE_OTHER_TEAM': 'team-bbb'})

    assert stack.broker.calls == []
    decisions = stack.engine.authorizations()
    assert decisions, 'the target was never authorized'
    assert all(not d['allowed'] for d in decisions if d['scope'] == 'team')
    assert 'standin_denies_team_database' in str(refused.value) or 'may not use' in str(refused.value)


async def test_a_variable_expanded_scope_cannot_hide_a_team_database(stack):
    node = sql_node(scope='${ROCKETRIDE_SCOPE}')
    async with Session(stack, 'orga') as a:
        with pytest.raises(Exception):  # noqa: B017
            await a.start(pipeline(node), env={'ROCKETRIDE_SCOPE': 'team'})

    assert stack.broker.calls == []


async def test_a_provider_that_names_nothing_is_not_a_way_around_authorization(stack):
    """A leading space is not stripped by the service registry, so it names no node; it must not provision."""
    async with Session(stack, 'orga') as a:
        try:
            await a.start(pipeline(sql_node(provider=' rocketride_sql', scope='team')))
        except Exception:  # noqa: S110 - a refusal is the expected outcome
            pass

    assert stack.broker.calls == []


# ---------------------------------------------------------------------------
# 3. Authorization precedes issuance
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('order', ['allowed-first', 'denied-first'])
async def test_one_allowed_and_one_denied_target_provision_nothing_and_deliver_no_map(stack, order):
    allowed = sql_node('sql_1', scope='org')
    denied = sql_node('sql_2', scope='team', target='team-bbb')
    nodes = [allowed, denied] if order == 'allowed-first' else [denied, allowed]
    async with Session(stack, 'orga') as a:
        with pytest.raises(Exception) as refused:  # noqa: B017
            await a.start(pipeline(*nodes))

    assert stack.broker.calls == [], 'the broker was called although one target was denied'
    asked = stack.engine.authorizations()
    assert any(not d['allowed'] for d in asked)
    assert role_sessions(stack.server, 'r_orga') == 0 and role_sessions(stack.server, 'r_orgb') == 0
    assert 'standin_denies' in str(refused.value) or 'may not use' in str(refused.value)


async def test_a_pipeline_without_database_nodes_provisions_nothing(stack):
    plain = pipeline(
        {
            'id': 'response_1',
            'provider': 'response',
            'config': {'lanes': []},
            'input': [{'lane': 'text', 'from': 'webhook_1'}],
        }
    )
    async with Session(stack, 'orga') as a:
        await a.start(plain)

    assert stack.broker.calls == []
    assert stack.engine.authorizations() == []


async def test_two_database_nodes_on_one_target_provision_once(stack):
    async with Session(stack, 'orga') as a:
        token = await a.start(pipeline(sql_node('sql_1'), sql_node('sql_2')))
        row_1 = await a.query(token, WHO_AM_I, 'sql_1')
        row_2 = await a.query(token, WHO_AM_I, 'sql_2')

    assert_own_database(row_1, 'orga')
    assert_own_database(row_2, 'orga')
    assert [c.tenant for c in stack.broker.calls] == ['org-aaa']
    assert len(stack.engine.authorizations()) == 1


# ---------------------------------------------------------------------------
# 4. Credential confinement: failures hand out nothing and revive nothing
# ---------------------------------------------------------------------------

BROKER_FAILURES = ['error500', 'conflict409', 'malformed', 'no-dsn']
HOSTILE_RAW_DSNS = {
    'sslmode-disable': 'sslmode=disable',
    'sslmode-prefer': 'sslmode=prefer',
    'duplicate-sslmode': 'sslmode=require&sslmode=disable',
    'host-override': 'sslmode=require&host=attacker.example',
    'sslrootcert-dev-null': 'sslmode=verify-ca&sslrootcert=/dev/null',
    'service': 'sslmode=require&service=anything',
    'options': 'sslmode=require&options=-c%20search_path%3Dpublic',
}


async def _started_or_refused(session, body):
    """Start a pipeline; return the token, or None when the engine refused to hand it a database."""
    try:
        return await session.start(body)
    except Exception as e:  # noqa: BLE001 - the refusal text is returned for inspection
        return e


@pytest.mark.parametrize('failure', BROKER_FAILURES)
async def test_a_broker_failure_yields_no_database_and_no_stale_credential(stack, failure):
    async with Session(stack, 'orga') as a:
        # 1. A good start, so a credential for tenant A has existed in this engine.
        good = await a.start(pipeline(sql_node()))
        assert_own_database(await a.query(good, WHO_AM_I), 'orga')
        await a.client.terminate(good)
        a.tokens.remove(good)
        await asyncio.sleep(0)  # let the termination settle
        deadline = time.monotonic() + 15
        while role_sessions(stack.server, 'r_orga') and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
        assert role_sessions(stack.server, 'r_orga') == 0

        # 2. The broker now fails for A: the next start must not reach any database.
        stack.broker.reset()
        stack.broker.set_mode('org-aaa', failure)
        outcome = await _started_or_refused(a, pipeline(sql_node()))
        if not isinstance(outcome, Exception):
            with pytest.raises(Exception):  # noqa: B017 - the node cannot run a query without a database
                await a.query(outcome, WHO_AM_I)

        assert role_sessions(stack.server, 'r_orga') == 0, 'a database session was opened without a granted DSN'
        assert role_sessions(stack.server, 'r_orgb') == 0
        failed_calls = list(stack.broker.calls)

        # 3. The broker recovers: the next start works and is on A's database again (nothing stuck).
        stack.broker.set_mode('org-aaa', 'ok')
        recovered = await a.start(pipeline(sql_node()))
        assert_own_database(await a.query(recovered, WHO_AM_I), 'orga')

    assert failed_calls and all(c.tenant == 'org-aaa' for c in failed_calls)
    if isinstance(outcome, Exception):
        text = str(outcome)
        assert BROKER_TOKEN not in text
        assert 'pw_orga' not in text


@pytest.mark.parametrize('variant', sorted(HOSTILE_RAW_DSNS))
async def test_a_downgrade_returned_by_the_broker_never_becomes_a_connection(stack, variant):
    hostile = stack.server.dsn('orga', query=HOSTILE_RAW_DSNS[variant])
    stack.broker.set_mode('org-aaa', f'raw-dsn:{hostile}')
    async with Session(stack, 'orga') as a:
        outcome = await _started_or_refused(a, pipeline(sql_node()))
        if not isinstance(outcome, Exception):
            with pytest.raises(Exception):  # noqa: B017
                await a.query(outcome, WHO_AM_I)

    assert role_sessions(stack.server, 'r_orga') == 0, 'the engine connected with a DSN its policy had to refuse'
    assert [c.tenant for c in stack.broker.calls] == ['org-aaa']


async def test_a_failed_start_for_one_tenant_does_not_disturb_the_other(stack):
    stack.broker.set_mode('org-aaa', 'error500')
    async with Session(stack, 'orga') as a, Session(stack, 'orgb') as b:
        failed = await _started_or_refused(a, pipeline(sql_node()))
        token_b = await b.start(pipeline(sql_node()))
        row_b = await b.query(token_b, WHO_AM_I)

    assert_own_database(row_b, 'orgb')
    if not isinstance(failed, Exception):
        pytest.fail('tenant A started although the broker failed for it')


@pytest.mark.parametrize('quirk', ['org-with-owner', 'raises', 'deny-org'])
async def test_an_authorizer_answer_the_engine_cannot_trust_provisions_nothing(stack, quirk):
    """The engine provisions exactly what an allow approved, and only a well-formed allow.

    An org database has no owner; an authorizer that fails, or denies, is a denial.
    """
    stack.engine.set_quirk(quirk)
    async with Session(stack, 'orga') as a:
        with pytest.raises(Exception):  # noqa: B017
            await a.start(pipeline(sql_node()))

    assert stack.broker.calls == []


async def test_a_session_without_an_organisation_gets_no_database(stack):
    """Missing or inconsistent trusted identity fails closed for private cloud access."""
    async with Session(stack, 'noorg') as nobody:
        with pytest.raises(Exception):  # noqa: B017
            await nobody.start(pipeline(sql_node()))

    assert stack.broker.calls == []


async def test_every_database_decision_is_logged_with_its_outcome_and_correlates_with_the_broker(stack):
    """One server-side line per database per start, and the broker receives the same task id.

    A line carries task, caller, scope, owner and outcome; the broker gets the task id as
    ``X-Request-Id``, so a provisioner log line ties back to the run.
    """
    async with Session(stack, 'orga') as a:
        await a.start(pipeline(sql_node()))  # issued
        issued_calls = list(stack.broker.calls)
        with pytest.raises(Exception):  # noqa: B017
            await a.start(pipeline(sql_node('sql_1'), sql_node('sql_2', scope='team', target='team-bbb')))  # denied
        stack.broker.set_mode('org-aaa', 'error500')
        await _started_or_refused(a, pipeline(sql_node()))  # resolve_failed

    records = stack.engine.db_access_records(at_least=4)
    by_outcome: dict[str, list[dict]] = {}
    for record in records:
        by_outcome.setdefault(record['outcome'], []).append(record)
    assert set(by_outcome) >= {'issued', 'denied', 'aborted', 'resolve_failed'}, records

    assert len(by_outcome['issued']) == 1, records
    (issued,) = by_outcome['issued']
    assert (issued['org'], issued['user'], issued['team'], issued['scope'], issued['owner']) == (
        'org-aaa',
        'user-aaa',
        'team-aaa',
        'org',
        '',
    )
    assert issued['task']
    assert [c.request_id for c in issued_calls] == [issued['task']], 'the broker did not receive the task id'
    (denied,) = by_outcome['denied']
    assert (denied['scope'], denied['org']) == ('team', 'org-aaa')
    assert 'standin_denies_team_database' in denied['reason']
    assert {r['scope'] for r in by_outcome['aborted']} == {'org'}  # the allowed org target was NOT issued
    assert by_outcome['resolve_failed'][0]['scope'] == 'org'
    for record in records:
        assert set(record) == {
            'task', 'org', 'user', 'team', 'run_kind', 'owner_kind', 'scope', 'owner', 'outcome', 'reason'
        }  # fmt: skip


# ---------------------------------------------------------------------------
# 3 + 4. Restart re-authorizes and re-resolves under the task's own identity
# ---------------------------------------------------------------------------


async def test_a_restart_with_a_changed_pipeline_authorizes_and_resolves_again(stack):
    async with Session(stack, 'orga') as a:
        body = pipeline(sql_node())
        token = await a.start(body)
        assert_own_database(await a.query(token, WHO_AM_I), 'orga')
        assert len(stack.broker.calls) == 1 and len(stack.engine.authorizations()) == 1

        changed = {**body, 'components': [body['components'][0], sql_node('sql_1', table='another_table')]}
        await a.client.restart(project_id=body['project_id'], source='webhook_1', pipeline=changed, token=token)

        assert_own_database(await a.query(token, WHO_AM_I), 'orga')

    assert [c.tenant for c in stack.broker.calls] == ['org-aaa', 'org-aaa'], 'the restart reused a stale credential'
    assert [r['org_id'] for r in stack.engine.authorizations()] == ['org-aaa', 'org-aaa']


async def test_a_restart_cannot_add_a_database_the_run_may_not_use(stack):
    async with Session(stack, 'orga') as a:
        body = pipeline(sql_node())
        token = await a.start(body)
        assert len(stack.broker.calls) == 1

        widened = {
            **body,
            'components': [
                body['components'][0],
                sql_node('sql_1'),
                sql_node('sql_2', scope='team', target='team-bbb'),
            ],
        }
        with pytest.raises(Exception):  # noqa: B017
            await a.client.restart(project_id=body['project_id'], source='webhook_1', pipeline=widened, token=token)

    assert len(stack.broker.calls) == 1, 'the denied restart still provisioned a database'
    assert any(not d['allowed'] for d in stack.engine.authorizations())


# ---------------------------------------------------------------------------
# 1. A hosted engine refuses the single-tenant permissive authorizer
# ---------------------------------------------------------------------------


@pytest.fixture
def engine_with_default_authorizer(stack):
    engine = engine_mod.HostedEngine(
        stack.workdir / 'default-authorizer',
        broker_url=stack.broker.url,
        broker_token=BROKER_TOKEN,
        db_ca=stack.server.ca,
        broker_ca=stack.broker_pki.ca,
        standin='inherit-default',
    )
    engine.start()
    yield engine
    engine.stop()


async def test_a_hosted_engine_refuses_the_permissive_default_authorizer(stack, engine_with_default_authorizer):
    """With an account that does not override ``authorize_db_target`` a hosted engine hands out no database.

    The AccountBase default allows the org scope with no membership check and no audit: right for a
    single-tenant open-source engine, a silent fail-open on a multi-tenant one.
    """
    other = SimpleNamespace(**{**stack.__dict__, 'engine': engine_with_default_authorizer})
    async with Session(other, 'orga') as a:
        with pytest.raises(Exception) as refused:  # noqa: B017
            await a.start(pipeline(sql_node()))

        # A pipeline without database nodes is unaffected.
        plain = pipeline(
            {
                'id': 'response_1',
                'provider': 'response',
                'config': {'lanes': []},
                'input': [{'lane': 'text', 'from': 'webhook_1'}],
            }
        )
        await a.start(plain)

    assert stack.broker.calls == [], 'the permissive default allowed a database to be provisioned'
    assert 'authoriz' in str(refused.value).lower()


# ---------------------------------------------------------------------------
# 9 (half). Secrets never appear in what the deployment would log or store
# ---------------------------------------------------------------------------


def _store_text(stack) -> str:
    """Every file the engine persisted (run logs, task logs, status) as text."""
    parts = []
    root = stack.workdir / 'store'
    if root.exists():
        for path in root.rglob('*'):
            if path.is_file():
                parts.append(path.read_bytes().decode('utf-8', errors='replace'))
    return '\n'.join(parts)


async def test_no_database_secret_appears_in_logs_events_traces_or_the_broker_log(stack):
    """Run real DB work, success and failure, with tracing on, then search everything captured.

    Captured: the engine's stdout/stderr (which relays task output), every event the clients
    received, the run-log read back through the API, what the engine persisted (run logs, task
    logs), the trace the run returned, and the fake broker's own request log. None may contain a
    tenant password, a role joined to host:port, a DSN, or the value of ROCKETRIDE_DB_DSNS. The
    NAME of that variable may appear (in reasons); a value never.
    """
    traces = []
    async with Session(stack, 'orga') as a, Session(stack, 'orgb') as b:
        body_a = pipeline(sql_node())
        token_a = await a.start(body_a, args=['--trace=debugOut'], pipelineTraceLevel='full')
        assert_own_database(await a.query(token_a, WHO_AM_I), 'orga')
        token_b = await b.start(pipeline(sql_node()), pipelineTraceLevel='full')
        assert_own_database(await b.query(token_b, WHO_AM_I), 'orgb')
        # A failure with a would-be secret in play.
        stack.broker.set_mode('org-aaa', 'error500')
        await _started_or_refused(a, pipeline(sql_node()))
        stack.broker.set_mode('org-aaa', 'ok')
        # Read the run log back through the API.
        try:
            traces.append(json.dumps(await a.client.log.read(body_a['project_id'], 'webhook_1'), default=str))
        except Exception as e:  # noqa: BLE001 - reading the log is best effort; the files are scanned below
            traces.append(f'log read unavailable: {type(e).__name__}')
        await a.query(token_a, "select 'after-failure' as db, current_user as usr")

    await asyncio.sleep(1.0)  # let the engine flush task logs
    captured = {
        'engine output': stack.engine.output(),
        'client events': '\n'.join(stack.events),
        'run log (API)': '\n'.join(traces),
        'persisted store': _store_text(stack),
        'broker request log': repr(stack.broker.calls),
    }
    secrets = {
        'tenant A password': 'pw_orga',
        'tenant B password': 'pw_orgb',
        'tenant A role at host:port': f'r_orga:pw_orga@{stack.server.host}:{stack.server.port}',
        'role at host:port (A)': f'r_orga@{stack.server.host}:{stack.server.port}',
        'role at host:port (B)': f'r_orgb@{stack.server.host}:{stack.server.port}',
        'A DSN': stack.server.dsn('orga'),
        'B DSN': stack.server.dsn('orgb'),
        'broker token': BROKER_TOKEN,
    }
    for source, text in captured.items():
        for label, secret in secrets.items():
            assert secret not in text, f'{label} found in {source}'
        # The variable's NAME may be mentioned, never with a value.
        for match in re.finditer(r'ROCKETRIDE_DB_DSNS\s*[=:]\s*\S+', text):
            assert match.group(0).rstrip('\'",}') in ('ROCKETRIDE_DB_DSNS=', 'ROCKETRIDE_DB_DSNS:'), (
                f'ROCKETRIDE_DB_DSNS appears with a value in {source}: {match.group(0)[:60]}'
            )
