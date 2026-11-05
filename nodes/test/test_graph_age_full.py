# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Live connection/transaction lifecycle tests for rocketride_graph (PG16 + AGE 1.5.0).

Concurrency, prepared-statement cleanup, session hygiene, reconnect and
shutdown, against the same disposable database and fixtures as
``test_rocketride_graph_full.py`` (whose ``rr_env`` / ``age_graph`` fixtures
are reused). Synchronisation uses barriers plus server-side ``pg_sleep`` so
the overlapping windows are real, not scheduler luck.

Skips cleanly when the database is unreachable unless ``RR_REQUIRE_DB_TESTS``
is set, in which case the import of the shared module fails the run.

Behind a transaction-mode pooler set ``RR_TEST_AGE_DSN`` to the pooler and
``RR_TEST_AGE_ADMIN_DSN`` to the database itself. Server sessions then belong
to the pooler, so the tests that terminate or count server backends check the
node's own client connections instead.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import types

import pytest

from .test_rocketride_graph_full import ADMIN_DSN, TEST_DSN, _begin, _db_reachable, age_graph, psycopg2, rr_env

# The shared fixtures are requested by name in the tests below; binding them
# here is what registers them with pytest for this module.
_SHARED_FIXTURES = (rr_env, age_graph)

# A pooler sits between the node and the database when the two DSNs differ.
BEHIND_POOLER = ADMIN_DSN != TEST_DSN

pytestmark = pytest.mark.skipif(not _db_reachable(), reason=f'RocketRide AGE test database not reachable at {TEST_DSN}')


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _age():
    return sys.modules['ai.common.graph.age']


def _plan(statements, *, read_only, columns=('v',)):
    """A hand-built plan whose LAST statement produces the result rows."""
    plan = _age().TranslatedQuery(columns=list(columns), has_return=True)
    for stmt in statements:
        plan.statements.append(stmt)
        plan.binds.append(())
    plan.result_index = len(statements) - 1
    plan.read_only = read_only
    return plan


def _set_pool_size(rr_env, monkeypatch, size):
    monkeypatch.setattr(sys.modules[rr_env.iglobal_cls.__module__], 'DEFAULT_POOL_SIZE', size)


def _on_pooled_session(glb, statement):
    """Run SQL on one of the node's own (idle) sessions, outside any plan."""
    pool = getattr(glb, 'pool', None)
    if pool is None:  # pre-pool code: the one shared connection
        with glb.client.cursor() as cur:
            cur.execute(statement)
            row = cur.fetchone()
        glb.client.rollback()
        return row
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(statement)
            row = cur.fetchone()
        conn.rollback()
        return row


def _admin():
    # Direct to the database (never through a pooler under test): it runs
    # server-side inspection and pg_terminate_backend.
    conn = psycopg2.connect(ADMIN_DSN, connect_timeout=5)
    conn.autocommit = True
    return conn


def _run_threads(targets, timeout=30):
    errors = {}
    results = {}

    def wrap(key, fn):
        try:
            results[key] = fn()
        except BaseException as e:  # noqa: BLE001 - reported to the test
            errors[key] = e

    threads = [threading.Thread(target=wrap, args=(k, fn)) for k, fn in targets.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout)
    assert not any(t.is_alive() for t in threads), 'a worker thread hung'
    return results, errors


# ---------------------------------------------------------------------------
# concurrency
# ---------------------------------------------------------------------------


class TestConcurrency:
    def test_concurrent_calls_get_their_own_session_and_settings(self, rr_env, age_graph):
        glb = _begin(rr_env)
        barrier = threading.Barrier(4)

        def call(i):
            def run():
                plan = _plan(
                    [
                        f"SET LOCAL statement_timeout = '{1001 + i}ms'",
                        'SELECT pg_sleep(0.3)',
                        "SELECT pg_backend_pid(), current_setting('transaction_read_only'), "
                        "current_setting('statement_timeout')",
                    ],
                    read_only=(i % 2 == 0),
                    columns=('pid', 'ro', 'timeout'),
                )
                barrier.wait()
                return glb._execute_plan(plan, fetch_cap=1)[0]

            return run

        try:
            results, errors = _run_threads({i: call(i) for i in range(4)})
            assert not errors, errors
            assert len({row[0] for row in results.values()}) == 4, 'concurrent calls shared a session'
            for i, (_pid, read_only, timeout) in results.items():
                assert read_only == ('on' if i % 2 == 0 else 'off')
                assert timeout == f'{1001 + i}ms'
        finally:
            glb.endGlobal()

    def test_failing_call_cannot_reset_a_concurrent_calls_safety_settings(self, rr_env, age_graph):
        glb = _begin(rr_env)
        barrier = threading.Barrier(2)
        failing = _plan(['SELECT pg_sleep(0.15)', 'SELECT 1/0'], read_only=False)
        # Several short statements: on a shared connection the failing call's
        # statements would land between these, inside this transaction.
        reading = _plan(
            [
                "SET LOCAL statement_timeout = '4321ms'",
                *(['SELECT pg_sleep(0.1)'] * 6),
                "SELECT current_setting('transaction_read_only'), current_setting('statement_timeout')",
            ],
            read_only=True,
            columns=('ro', 'timeout'),
        )

        def run_failing():
            barrier.wait()
            return glb._execute_plan(failing, fetch_cap=1)

        def run_reading():
            barrier.wait()
            return glb._execute_plan(reading, fetch_cap=1)[0]

        try:
            results, errors = _run_threads({'fail': run_failing, 'read': run_reading})
            assert isinstance(errors.get('fail'), psycopg2.Error)
            assert 'read' not in errors, errors.get('read')
            assert results['read'] == ('on', '4321ms')
        finally:
            glb.endGlobal()

    def test_read_does_not_see_a_concurrent_uncommitted_write(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        age = _age()
        write = glb._translate("CREATE (:Person {name: 'iso-writer'})", mode=age.TranslateMode.RAW)
        write.statements.append('SELECT pg_sleep(0.8)')
        write.binds.append(())
        write.result_index = len(write.statements) - 1
        started = threading.Event()

        def run_write():
            started.set()
            return glb._execute_plan(write, fetch_cap=1)

        def run_read():
            started.wait(5)
            time.sleep(0.3)  # inside the writer's sleep, before its COMMIT
            return glb._run_query("MATCH (p:Person) WHERE p.name = 'iso-writer' RETURN count(p) AS c")

        try:
            results, errors = _run_threads({'write': run_write, 'read': run_read})
            assert not errors, errors
            assert results['read'] == [{'c': 0}]
            assert glb._run_query("MATCH (p:Person) WHERE p.name = 'iso-writer' RETURN count(p) AS c") == [{'c': 1}]
        finally:
            glb.endGlobal()

    def test_reflection_runs_beside_reads_on_separate_sessions(self, rr_env, age_graph):
        glb = _begin(rr_env)
        barrier = threading.Barrier(3)

        def reflect():
            barrier.wait()
            return glb._reflect_schema()

        def read():
            barrier.wait()
            return glb._run_query('MATCH (p:Person) RETURN count(p) AS c')

        try:
            results, errors = _run_threads({'schema': reflect, 'r1': read, 'r2': read})
            assert not errors, errors
            assert set(results['schema']['nodes']) == {'Person', 'Company'}
            assert results['r1'] == results['r2'] == [{'c': 3}]
        finally:
            glb.endGlobal()

    def test_pool_bounds_open_sessions(self, rr_env, age_graph, monkeypatch):
        _set_pool_size(rr_env, monkeypatch, 2)
        glb = _begin(rr_env)
        barrier = threading.Barrier(5)

        def call():
            barrier.wait()
            return glb._execute_plan(_plan(['SELECT pg_sleep(0.3)', 'SELECT pg_backend_pid()'], read_only=True))[0][0]

        try:
            results, errors = _run_threads({i: call for i in range(5)})
            assert not errors, errors
            assert len(set(results.values())) <= 2
            assert glb.pool.size <= 2
        finally:
            glb.endGlobal()


# ---------------------------------------------------------------------------
# prepared statements, quoting, session hygiene
# ---------------------------------------------------------------------------


class TestSessionHygiene:
    def test_failed_parameterised_call_leaves_no_prepared_statement(self, rr_env, age_graph, monkeypatch):
        _set_pool_size(rr_env, monkeypatch, 1)
        glb = _begin(rr_env)
        try:
            with pytest.raises(Exception, match='division by zero'):
                glb._run_query('MATCH (p:Person) WHERE p.name = $n RETURN p.age / 0 AS boom', params={'n': 'alice'})
            assert _on_pooled_session(glb, 'SELECT count(*) FROM pg_prepared_statements') == (0,)
            # Two consecutive parameterised calls after the failure still work.
            assert glb._run_query('MATCH (p:Person) WHERE p.name = $n RETURN p.age AS age', params={'n': 'bob'}) == [
                {'age': 25}
            ]
            assert glb._run_query(
                'MATCH (p:Person) WHERE p.age > $a RETURN p.name AS n ORDER BY p.name', params={'a': 26}
            ) == [
                {'n': 'alice'},
                {'n': 'carol'},
            ]
            assert _on_pooled_session(glb, 'SELECT count(*) FROM pg_prepared_statements') == (0,)
        finally:
            glb.endGlobal()

    def test_timeout_mid_execute_also_cleans_up(self, rr_env, age_graph, monkeypatch):
        _set_pool_size(rr_env, monkeypatch, 1)
        # A generous deadline, so the follow-up query below cannot hit it on a
        # slow (e.g. emulated) server; the first query needs minutes regardless.
        glb = _begin(rr_env, {'query_timeout_ms': 1500})
        try:
            with pytest.raises(Exception, match='statement timeout'):
                glb._run_query(
                    'UNWIND range(1, $n) AS a UNWIND range(1, $n) AS b WITH a, b WHERE (a * b) % 7 = 3 RETURN count(*) AS c',
                    params={'n': 100_000},
                )
            assert _on_pooled_session(glb, 'SELECT count(*) FROM pg_prepared_statements') == (0,)
            assert glb._run_query('MATCH (p:Person) WHERE p.name = $n RETURN p.age AS age', params={'n': 'carol'}) == [
                {'age': 41}
            ]
        finally:
            glb.endGlobal()

    def test_query_ending_in_the_quote_tag_runs(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            rows = glb._run_query('MATCH (p:Person) RETURN p.name = $rr_cypher', params={'rr_cypher': 'alice'})
            assert sorted(v for row in rows for v in row.values()) == [False, False, True]
        finally:
            glb.endGlobal()

    def test_no_session_state_survives_a_call(self, rr_env, age_graph, monkeypatch):
        _set_pool_size(rr_env, monkeypatch, 1)
        fresh = _admin()
        with fresh.cursor() as cur:
            cur.execute("SELECT current_setting('statement_timeout'), current_setting('search_path')")
            defaults = cur.fetchone()
        fresh.close()
        glb = _begin(rr_env)
        try:
            glb._run_query('MATCH (p:Person) WHERE p.name = $n RETURN p.age AS age', params={'n': 'alice'})
            glb._validate_query('MATCH (p:Person) RETURN p.name')
            state = _on_pooled_session(
                glb,
                "SELECT current_setting('statement_timeout'), current_setting('search_path'), "
                "current_setting('transaction_read_only'), (SELECT count(*) FROM pg_prepared_statements)",
            )
            assert state == (*defaults, 'off', 0)
        finally:
            glb.endGlobal()


# ---------------------------------------------------------------------------
# failure recovery and shutdown
# ---------------------------------------------------------------------------


class TestRecovery:
    def test_idle_connection_dropped_by_server_is_replaced(self, rr_env, age_graph, monkeypatch):
        _set_pool_size(rr_env, monkeypatch, 1)
        glb = _begin(rr_env)
        admin = _admin()
        try:
            if BEHIND_POOLER:
                # The pooler owns server sessions; drop the node's own client
                # connection instead (same failure as from the node's side).
                with glb.pool.connection() as conn:
                    dropped = conn
                dropped.close()
            else:
                (pid,) = _on_pooled_session(glb, 'SELECT pg_backend_pid()')
                with admin.cursor() as cur:
                    cur.execute('SELECT pg_terminate_backend(%s)', (pid,))
                time.sleep(0.2)
            assert glb._run_query('MATCH (p:Person) WHERE p.name = $n RETURN p.age AS age', params={'n': 'alice'}) == [
                {'age': 30}
            ]
            if not BEHIND_POOLER:
                (new_pid,) = _on_pooled_session(glb, 'SELECT pg_backend_pid()')
                assert new_pid != pid
            assert glb.pool.size == 1
        finally:
            admin.close()
            glb.endGlobal()

    def test_restart_with_several_idle_connections_recovers_on_the_first_call(self, rr_env, age_graph, monkeypatch):
        """A database or pooler restart drops every idle session at once; the retry must not take another."""
        if BEHIND_POOLER:
            pytest.skip('NOT RUN: behind a pooler the server cannot drop the node client connections it holds')
        _set_pool_size(rr_env, monkeypatch, 3)
        glb = _begin(rr_env)
        admin = _admin()
        barrier = threading.Barrier(3)

        def warm():
            barrier.wait()
            return glb._execute_plan(_plan(['SELECT pg_sleep(0.3)', 'SELECT pg_backend_pid()'], read_only=True))[0][0]

        try:
            results, errors = _run_threads({i: warm for i in range(3)})
            assert not errors, errors
            pids = sorted(set(results.values()))
            assert len(pids) == 3 and glb.pool.idle == 3
            with admin.cursor() as cur:
                cur.execute('SELECT pg_terminate_backend(pid) FROM unnest(%s::int[]) AS pid', (pids,))
            time.sleep(0.2)
            for _ in range(3):
                assert glb._run_query('MATCH (p:Person) RETURN count(p) AS c') == [{'c': 3}]
        finally:
            admin.close()
            glb.endGlobal()

    @pytest.mark.parametrize('path', ['sql_read', 'reflect_schema'])
    def test_schema_paths_close_the_other_idle_connections_after_a_restart(self, rr_env, age_graph, monkeypatch, path):
        """Plain SQL reads and schema reflection do not retry, so after a restart one call may fail; only one."""
        if BEHIND_POOLER:
            pytest.skip('NOT RUN: behind a pooler the server cannot drop the node client connections it holds')
        _set_pool_size(rr_env, monkeypatch, 3)
        glb = _begin(rr_env)
        admin = _admin()
        barrier = threading.Barrier(3)

        def warm():
            barrier.wait()
            return glb._execute_plan(_plan(['SELECT pg_sleep(0.3)', 'SELECT pg_backend_pid()'], read_only=True))[0][0]

        def call():
            return glb._sql_read('SELECT 1') if path == 'sql_read' else glb._reflect_schema()

        try:
            results, errors = _run_threads({i: warm for i in range(3)})
            assert not errors, errors
            pids = sorted(set(results.values()))
            assert len(pids) == 3 and glb.pool.idle == 3
            with admin.cursor() as cur:
                cur.execute('SELECT pg_terminate_backend(pid) FROM unnest(%s::int[]) AS pid', (pids,))
            time.sleep(0.2)
            with pytest.raises(psycopg2.Error):
                call()
            assert glb.pool.idle == 0, 'the other idle connections died with the restart and must be closed'
            for _ in range(3):
                call()
        finally:
            admin.close()
            glb.endGlobal()

    def test_idle_sessions_are_closed_after_the_idle_timeout(self, rr_env, age_graph, monkeypatch):
        module = sys.modules[rr_env.iglobal_cls.__module__]
        monkeypatch.setattr(module, 'POOL_IDLE_TIMEOUT_S', 0.3)
        glb = _begin(rr_env)
        try:
            assert glb.pool.max_size == module.DEFAULT_POOL_SIZE <= 4
            assert glb.pool.idle_timeout_s == 0.3
            pid = None if BEHIND_POOLER else _on_pooled_session(glb, 'SELECT pg_backend_pid()')[0]
            deadline = time.monotonic() + 5
            while glb.pool.size and time.monotonic() < deadline:
                time.sleep(0.05)
            assert glb.pool.size == 0
            if pid is not None:
                admin = _admin()
                try:
                    deadline = time.monotonic() + 5
                    alive = True
                    while alive and time.monotonic() < deadline:
                        with admin.cursor() as cur:
                            cur.execute('SELECT 1 FROM pg_stat_activity WHERE pid = %s', (pid,))
                            alive = cur.fetchone() is not None
                        time.sleep(0.05)
                    assert not alive
                finally:
                    admin.close()
            # The next call simply opens a new connection.
            assert glb._run_query('MATCH (p:Person) RETURN count(p) AS c') == [{'c': 3}]
        finally:
            glb.endGlobal()

    def test_connection_lost_during_the_main_statement_is_not_retried(self, rr_env, age_graph, monkeypatch):
        _set_pool_size(rr_env, monkeypatch, 1)
        glb = _begin(rr_env)
        admin = _admin()
        try:
            (pid,) = _on_pooled_session(glb, 'SELECT pg_backend_pid()')

            def kill_soon():
                time.sleep(0.4)
                with admin.cursor() as cur:
                    cur.execute('SELECT pg_terminate_backend(%s)', (pid,))

            killer = threading.Thread(target=kill_soon)
            killer.start()
            started = time.monotonic()
            with pytest.raises(psycopg2.OperationalError):
                glb._execute_plan(_plan(['SELECT pg_sleep(2)'], read_only=True))
            elapsed = time.monotonic() - started
            killer.join(5)
            assert elapsed < 1.9, 'the interrupted statement was re-run'
            assert glb._run_query('MATCH (p:Person) RETURN count(p) AS c') == [{'c': 3}]
        finally:
            admin.close()
            glb.endGlobal()

    def test_end_global_closes_every_session(self, rr_env, age_graph, monkeypatch):
        module = sys.modules[rr_env.iglobal_cls.__module__]
        opened = []
        real_open = module._open_connection
        monkeypatch.setattr(module, '_open_connection', lambda dsn: opened.append(real_open(dsn)) or opened[-1])
        glb = _begin(rr_env)
        barrier = threading.Barrier(3)

        def call():
            barrier.wait()
            return glb._execute_plan(_plan(['SELECT pg_sleep(0.2)', 'SELECT pg_backend_pid()'], read_only=True))[0][0]

        results, errors = _run_threads({i: call for i in range(3)})
        assert not errors, errors
        pids = sorted(set(results.values()))
        glb.endGlobal()
        assert opened and all(conn.closed for conn in opened)
        if not BEHIND_POOLER:
            admin = _admin()
            try:
                deadline = time.monotonic() + 5
                alive = pids
                while alive and time.monotonic() < deadline:
                    with admin.cursor() as cur:
                        cur.execute('SELECT pid FROM pg_stat_activity WHERE pid = ANY(%s)', (pids,))
                        alive = [r[0] for r in cur.fetchall()]
                    time.sleep(0.1)
                assert alive == []
            finally:
                admin.close()
        with pytest.raises(Exception):
            glb._run_query('MATCH (p:Person) RETURN count(p) AS c')


# ---------------------------------------------------------------------------
# read_query / execute(shape='graph') through the node's tools
# ---------------------------------------------------------------------------


def _instance(rr_env, glb):
    inst = rr_env.iinstance_cls()
    inst.IGlobal = glb
    return inst


def _graph_tool_error():
    return sys.modules['ai.common.graph.graph_errors'].GraphToolError


def _age_state():
    """Vertex/edge counts and the label catalog of THIS run's graph, read directly.

    Scoped to the test's own graph (other runs may create graphs concurrently);
    the graph must still exist, so a dropped graph also shows up as a change.
    """
    from .test_rocketride_graph_full import GRAPH

    conn = _admin()
    try:
        with conn.cursor() as cur:
            cur.execute('SET search_path = ag_catalog, "$user", public')
            cur.execute(f"SELECT count(*) FROM cypher('{GRAPH}', $$ MATCH (n) RETURN n $$) AS (n agtype)")
            vertices = cur.fetchone()[0]
            cur.execute(f"SELECT count(*) FROM cypher('{GRAPH}', $$ MATCH ()-[r]->() RETURN r $$) AS (r agtype)")
            edges = cur.fetchone()[0]
            cur.execute(
                'SELECT l.name FROM ag_label l JOIN ag_graph g ON l.graph = g.graphid WHERE g.name = %s ORDER BY 1',
                (GRAPH,),
            )
            labels = [r[0] for r in cur.fetchall()]
        return vertices, edges, labels
    finally:
        conn.close()


def _cypher_admin(statement):
    from .test_rocketride_graph_full import GRAPH

    conn = _admin()
    try:
        with conn.cursor() as cur:
            cur.execute('SET search_path = ag_catalog, "$user", public')
            cur.execute(f"SELECT * FROM cypher('{GRAPH}', $$ {statement} $$) AS (v agtype)")
            return cur.fetchall()
    finally:
        conn.close()


AGE_WRITES = [
    "CREATE (:Evil {name: 'x'})",
    "MERGE (:Evil {name: 'x'})",
    "MATCH (p:Person {name: 'alice'}) SET p.evil = true",
    "MATCH (p:Person {name: 'bob'}) DETACH DELETE p",
    'MATCH (p:Person) REMOVE p.age',
    'CALL db.labels()',
]


class TestReadQuery:
    def test_shape_duplicate_columns_and_direction(self, rr_env, age_graph):
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            out = inst.read_query(
                {'cypher': "MATCH (a:Person {name: 'alice'})-[r:KNOWS]->(b) RETURN a, r, b, a.name, a.name"}
            )
            assert out['columns'] == ['a', 'r', 'b', 'a.name', 'a.name']
            a, r, b, n1, n2 = out['rows'][0]
            assert (n1, n2) == ('alice', 'alice')
            assert a['labels'] == ['Person'] and r['type'] == 'KNOWS'
            assert (r['start'], r['end']) == (a['id'], b['id'])
            assert int(a['id']) > 0 and isinstance(a['id'], str)
            path = inst.read_query({'cypher': "MATCH p = (b:Person {name: 'bob'})<-[:KNOWS]-(a) RETURN p"})['rows'][0][
                0
            ]
            assert [n['properties']['name'] for n in path['nodes']] == ['bob', 'alice']
            rel = path['relationships'][0]
            assert (rel['start'], rel['end']) == (path['nodes'][1]['id'], path['nodes'][0]['id'])
        finally:
            glb.endGlobal()

    def test_ids_beyond_2_53_round_trip_as_string_parameters(self, rr_env, age_graph):
        for i in range(36):
            _cypher_admin(f'CREATE (:L{i} {{k: {i}}})')
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            node = inst.read_query({'cypher': 'MATCH (n:L35) RETURN n'})['rows'][0][0]
            assert int(node['id']) > 2**53
            out = inst.read_query(
                {'cypher': 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n.k', 'params': {'id': node['id']}}
            )
            assert out['rows'] == [[35]]
        finally:
            glb.endGlobal()

    @pytest.mark.parametrize('allow_execute', [False, True])
    @pytest.mark.parametrize('statement', AGE_WRITES)
    def test_writes_refused_with_state_unchanged(self, rr_env, age_graph, allow_execute, statement):
        glb = _begin(rr_env, {'allow_execute': allow_execute})
        inst = _instance(rr_env, glb)
        try:
            before = _age_state()
            with pytest.raises(_graph_tool_error()) as err:
                inst.read_query({'cypher': statement})
            assert str(err.value).startswith('Refused: ')
            assert _age_state() == before
        finally:
            glb.endGlobal()

    def test_load_csv_is_refused(self, rr_env, age_graph):
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            with pytest.raises(_graph_tool_error()) as err:
                inst.read_query({'cypher': "LOAD CSV FROM 'https://example.invalid/rr-test.csv' AS r RETURN r"})
            assert str(err.value).startswith('Refused: LOAD CSV is not allowed on the read-only path')
        finally:
            glb.endGlobal()

    def test_result_decode_failure_is_not_reported_as_invalid_cypher(self, rr_env, age_graph, monkeypatch):
        """The statement was valid (and on execute it already ran): only its result could not be decoded."""
        module = sys.modules[rr_env.iglobal_cls.__module__]
        glb = _begin(rr_env, {'allow_execute': True})
        inst = _instance(rr_env, glb)

        def undecodable(value):
            raise _age().AgeTranslationError('Failed to decode agtype value: unexpected token')

        try:
            monkeypatch.setattr(module, 'parse_agtype', undecodable)
            with pytest.raises(_graph_tool_error()) as err:
                inst.read_query({'cypher': 'MATCH (p:Person) RETURN p'})
            headline, _, detail = str(err.value).partition('\n')
            assert headline == 'Query result cannot be represented'
            assert 'unexpected token' in detail
            with pytest.raises(_graph_tool_error()) as err:
                inst.execute({'query': "MATCH (p:Person {name: 'alice'}) SET p.seen = 1 RETURN p", 'shape': 'graph'})
            headline, _, detail = str(err.value).partition('\n')
            assert headline == 'Query result cannot be represented'
            assert 'the statement itself ran' in detail
        finally:
            glb.endGlobal()

    def test_hints_are_raised_before_the_database(self, rr_env, age_graph, monkeypatch):
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        sent = []
        monkeypatch.setattr(glb, '_execute_plan', lambda *a, **kw: sent.append(a))
        try:
            with pytest.raises(_graph_tool_error()) as err:
                inst.read_query({'cypher': "RETURN date('2024-01-01')"})
            headline, _, detail = str(err.value).partition('\n')
            assert headline == 'Not supported on Apache AGE 1.5.0: date()'
            assert 'ISO-8601' in detail
            assert sent == []
        finally:
            glb.endGlobal()

    def test_exact_limit_and_truncation(self, rr_env, age_graph):
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            q = 'MATCH (p:Person) RETURN p.name ORDER BY p.name'
            exact = inst.read_query({'cypher': q, 'limit': 3})
            assert [r[0] for r in exact['rows']] == ['alice', 'bob', 'carol'] and exact['truncated'] is False
            cut = inst.read_query({'cypher': q, 'limit': 2})
            assert len(cut['rows']) == 2 and cut['truncated'] is True and cut['truncated_by'] == 'rows'
        finally:
            glb.endGlobal()

    def test_collect_is_bounded_by_the_element_budget(self, rr_env, age_graph):
        _cypher_admin('UNWIND range(1, 10050) AS i CREATE (:Bulk {i: i})')
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            with pytest.raises(_graph_tool_error(), match='first row holds more than 10,000 graph elements'):
                inst.read_query({'cypher': 'MATCH (n:Bulk) RETURN collect(n)'})
        finally:
            glb.endGlobal()

    def test_server_deadline(self, rr_env, age_graph):
        _cypher_admin('UNWIND range(1, 2000) AS i CREATE (:Bulk {i: i})')
        glb = _begin(rr_env, {'query_timeout_ms': 800})
        inst = _instance(rr_env, glb)
        try:
            with pytest.raises(_graph_tool_error()) as err:
                inst.read_query({'cypher': 'MATCH (a:Bulk), (b:Bulk), (c:Bulk) RETURN count(*)'})
            assert str(err.value).startswith('Query timed out after 800 ms')
        finally:
            glb.endGlobal()

    def test_execute_graph_shape(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        inst = _instance(rr_env, glb)
        try:
            out = inst.execute({'query': "CREATE (n:Person {name: 'dora'}) RETURN n", 'shape': 'graph'})
            assert out['rows'][0][0]['labels'] == ['Person'] and out['affected_rows'] == 1
            assert inst.read_query({'cypher': "MATCH (p:Person {name: 'dora'}) RETURN count(p)"})['rows'] == [[1]]
        finally:
            glb.endGlobal()

    def test_execute_graph_shape_binds_params(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        inst = _instance(rr_env, glb)
        try:
            out = inst.execute(
                {
                    'query': 'CREATE (n:Person {name: $name}) RETURN n.name AS name',
                    'params': {'name': "e've $rr_cypher$"},
                    'shape': 'graph',
                }
            )
            assert out['columns'] == ['name'] and out['rows'] == [["e've $rr_cypher$"]]
            found = inst.read_query(
                {'cypher': 'MATCH (p:Person) WHERE p.name = $n RETURN count(p)', 'params': {'n': "e've $rr_cypher$"}}
            )
            assert found['rows'] == [[1]]
        finally:
            glb.endGlobal()


# The statement Graph Explorer's Connect sends to Apache AGE
# (apps/graph-ui/src/cypher/recipes.ts connectNodes, AGE_CONNECT_MAX_NODES):
# no bound list compares with AGE ids exactly, so each id is its own parameter
# in an OR chain. Through read_query that is one PREPARE whose agtype map holds
# every id, an EXECUTE and a DEALLOCATE inside one transaction. This module
# also runs through the transaction-mode pooler (poolerSuites in
# nodes/scripts/db-lanes/graph.js), where the three must stay on one server session.
AGE_CONNECT_MAX_NODES = 40


def _connect_recipe(ids, rows=2000):
    """connectNodes() for AGE, text for text: the OR chain, i0..iN string ids, the LIMIT and the row limit."""

    def either(v):
        return '(' + ' OR '.join(f'id({v}) = toInteger($i{i})' for i in range(len(ids))) + ')'

    return {
        'cypher': f'MATCH (a)-[r]->(b) WHERE {either("a")} AND {either("b")} RETURN a, r, b LIMIT {rows}',
        'params': {f'i{i}': node_id for i, node_id in enumerate(ids)},
        'limit': rows,
    }


def _connected(inst, ids):
    """(start, type, end) of every relationship Connect returns among ``ids``, and whether it was cut."""
    out = inst.read_query(_connect_recipe(ids))
    return {(row[1]['start'], row[1]['type'], row[1]['end']) for row in out['rows']}, out['truncated']


class TestConnectRecipe:
    def test_or_chain_over_the_most_bound_ids_connect_allows(self, rr_env, age_graph):
        # 36 more nodes in a chain: with the seeded four, 40 nodes and 38 relationships among them.
        _cypher_admin('UNWIND range(1, 36) AS i CREATE (:Link {i: i})')
        _cypher_admin('MATCH (a:Link), (b:Link) WHERE b.i = a.i + 1 CREATE (a)-[:NEXT]->(b)')
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            ids = [row[0]['id'] for row in inst.read_query({'cypher': 'MATCH (n) RETURN n', 'limit': 100})['rows']]
            assert len(ids) == AGE_CONNECT_MAX_NODES
            expected = {
                (r['start'], r['type'], r['end'])
                for (r,) in inst.read_query({'cypher': 'MATCH ()-[r]->() RETURN r', 'limit': 100})['rows']
            }
            assert len(expected) == 38
            recipe = _connect_recipe(ids)

            # The shape that has to survive the pooler: PREPARE ... EXECUTE ... DEALLOCATE, one agtype map.
            plan = glb._translate(recipe['cypher'], params=recipe['params'], limit=2001, mode=_age().TranslateMode.SAFE)
            assert plan.prepared_name and plan.read_only
            assert len(json.loads(plan.binds[plan.result_index][0])) == AGE_CONNECT_MAX_NODES

            def connect():
                return _connected(inst, ids)

            pool = glb.pool
            glb.pool = log = _StatementLog(pool)
            try:
                assert connect() == (expected, False)
            finally:
                glb.pool = pool
            kinds = [s.split()[0] for s in log.statements]
            assert kinds == ['SET', 'SET', 'SET', 'PREPARE', 'SAVEPOINT', 'EXECUTE', 'RELEASE', 'DEALLOCATE'], kinds

            # Again, one after the other and side by side: each call prepares, runs and
            # deallocates its own statement, so pooled server sessions never collect them.
            for _ in range(3):
                assert connect() == (expected, False)
            results, errors = _run_threads({i: connect for i in range(8)})
            assert not errors, errors
            assert all(result == (expected, False) for result in results.values())
            assert _on_pooled_session(glb, 'SELECT count(*) FROM pg_prepared_statements') == (0,)

            # Two of the ids: only the relationship between them.
            (knows,) = inst.read_query(
                {'cypher': "MATCH (:Person {name: 'alice'})-[r:KNOWS]->(:Person {name: 'bob'}) RETURN r"}
            )['rows'][0]
            assert _connected(inst, [knows['start'], knows['end']]) == (
                {(knows['start'], 'KNOWS', knows['end'])},
                False,
            )
        finally:
            glb.endGlobal()


class TestCapabilityProbes:
    """The capability table's REJECT cells hold on the live AGE version.

    Each construct is sent straight to AGE (bypassing the translator) and must
    fail there. If an AGE upgrade starts accepting one, this fails and the
    table needs a reviewed update.
    """

    @pytest.mark.parametrize(
        'statement',
        [
            "RETURN date('2024-01-01')",
            'RETURN time()',
            'RETURN localtime()',
            "RETURN localdatetime('2024-01-01T00:00:00')",
            "RETURN duration('P1D')",
            "RETURN datetime('2024-01-01T00:00:00Z')",
            'MATCH (n) RETURN elementId(n)',
            'RETURN [x IN [1, 2] | x * 2]',
            'RETURN [x IN [1, 2] WHERE x > 1]',
            'MATCH (n) RETURN [(n)-->(m) | m]',
            'MATCH (a:Person), (b:Person) RETURN allShortestPaths((a)-[*..3]-(b))',
            'MATCH (n) WHERE EXISTS { MATCH (n)-->() } RETURN n',
            'MATCH p = shortestPath((a:Person)-[*..3]-(b:Person)) RETURN p',
            'MATCH (n:Person:Company) RETURN n',
        ],
    )
    def test_rejected_construct_fails_on_live_age(self, rr_env, age_graph, statement):
        with pytest.raises(psycopg2.Error):
            _cypher_admin(statement)

    @pytest.mark.parametrize('statement', ['RETURN timestamp()', 'RETURN toString(1)', 'MATCH (n) RETURN keys(n)'])
    def test_supported_construct_runs_on_live_age(self, rr_env, age_graph, statement):
        _cypher_admin(statement)


def _hold_the_only_connection(glb, seconds):
    """Check out the pool's one connection on another thread for ``seconds``; returns that thread."""
    held = threading.Event()

    def hold():
        with glb.pool.connection():
            held.set()
            time.sleep(seconds)

    thread = threading.Thread(target=hold)
    thread.start()
    assert held.wait(5), 'the holder never got the connection'
    return thread


class _StatementLog:
    """Wraps a pool so every SQL text run on its connections is recorded (and still run)."""

    def __init__(self, pool):
        self._pool = pool
        self.statements = []

    def connection(self, **kw):
        import contextlib

        log = self.statements

        class Cursor:
            def __init__(self, cur):
                self._cur = cur

            def __enter__(self):
                self._cur.__enter__()
                return self

            def __exit__(self, *exc):
                return self._cur.__exit__(*exc)

            def execute(self, query, *args):
                log.append(query if isinstance(query, str) else repr(query))
                return self._cur.execute(query, *args)

            def __getattr__(self, name):
                return getattr(self._cur, name)

        class Conn:
            def __init__(self, conn):
                self._conn = conn

            def cursor(self, *a, **k):
                return Cursor(self._conn.cursor(*a, **k))

            def __getattr__(self, name):
                return getattr(self._conn, name)

        @contextlib.contextmanager
        def wrapped():
            with self._pool.connection(**kw) as conn:
                yield Conn(conn)

        return wrapped()

    def __getattr__(self, name):
        return getattr(self._pool, name)


class TestSchemaDeadline:
    """refresh_schema's budget includes the wait for a pooled connection."""

    def test_the_wait_for_a_connection_stops_when_the_budget_runs_out(self, rr_env, age_graph, monkeypatch):
        """The wait is bounded by the budget left, not by the pool's acquire timeout (query timeout + 5 s)."""
        from ai.common.graph.schema import SchemaBuilder

        _set_pool_size(rr_env, monkeypatch, 1)
        glb = _begin(rr_env)
        assert glb.pool.acquire_timeout_s > 5
        holder = _hold_the_only_connection(glb, 2.0)
        log = _StatementLog(glb.pool)
        monkeypatch.setattr(glb, 'pool', log)
        try:
            started = time.monotonic()
            with pytest.raises(TimeoutError):
                glb._reflect_schema_v2(SchemaBuilder(), started + 0.3)
            waited = time.monotonic() - started
            assert waited < 1.5, f'waited {waited:.2f} s for a connection on a 0.3 s budget'
            assert log.statements == [], 'nothing may run once the budget is spent'
        finally:
            holder.join(5)
            monkeypatch.undo()
            assert glb.pool.idle == 1, 'the connection goes back to the pool'
            glb.endGlobal()

    def test_statement_timeout_is_the_budget_left_after_the_wait(self, rr_env, age_graph, monkeypatch):
        import re

        from ai.common.graph.schema import SchemaBuilder

        _set_pool_size(rr_env, monkeypatch, 1)
        glb = _begin(rr_env)
        holder = _hold_the_only_connection(glb, 0.5)
        log = _StatementLog(glb.pool)
        monkeypatch.setattr(glb, 'pool', log)
        try:
            glb._reflect_schema_v2(SchemaBuilder(), time.monotonic() + 3.0)
            (timeout,) = [s for s in log.statements if 'statement_timeout' in s]
            ms = int(re.search(r"'(\d+)ms'", timeout).group(1))
            assert ms <= 2600, f'statement_timeout {ms} ms ignores the ~500 ms spent waiting for the connection'
        finally:
            holder.join(5)
            monkeypatch.undo()
            glb.endGlobal()


def _first_attempt_lost(glb, monkeypatch, seconds):
    """The call's first attempt takes ``seconds``, then finds its connection lost before the main statement.

    Simulated at the ``_run_plan`` seam, so it behaves the same behind the
    pooler (TestRecovery shows that a really dropped connection takes this
    path); the retry runs for real. Returns the start time of each attempt.
    """
    module = sys.modules[type(glb).__module__]
    real_run_plan = glb._run_plan
    attempts = []

    def run_plan(conn, plan, *args, **kwargs):
        attempts.append(time.monotonic())
        if len(attempts) == 1:
            time.sleep(seconds)
            lost = psycopg2.OperationalError('server closed the connection unexpectedly')
            raise module._ConnectionLost(lost, before_main=True)
        return real_run_plan(conn, plan, *args, **kwargs)

    monkeypatch.setattr(glb, '_run_plan', run_plan)
    return attempts


class _TakenBeforeTheRetry:
    """Wraps a pool: just before the retry's checkout (``fresh=True``), another caller takes the only connection."""

    def __init__(self, pool):
        self._pool = pool
        self._done = threading.Event()
        self._holder = None

    def connection(self, **kw):
        if kw.get('fresh') and self._holder is None:
            held = threading.Event()

            def hold():
                with self._pool.connection():
                    held.set()
                    self._done.wait(30)

            self._holder = threading.Thread(target=hold)
            self._holder.start()
            assert held.wait(5), 'the other caller never got the connection'
        return self._pool.connection(**kw)

    def release(self):
        self._done.set()
        if self._holder is not None:
            self._holder.join(10)

    def __getattr__(self, name):
        return getattr(self._pool, name)


def _setting_ms(text):
    """PostgreSQL's display of statement_timeout ('580ms', '1s', '2min') in milliseconds."""
    import re

    number, unit = re.fullmatch(r'(\d+)\s*(ms|s|min)?', text).groups()
    return int(number) * {'ms': 1, 's': 1000, 'min': 60_000}[unit or 'ms']


class TestRetryDeadline:
    """A call retried after a lost connection gets only what is left of its budget.

    The budget is what the first attempt may take: the wait for a connection
    (the query timeout plus POOL_ACQUIRE_GRACE_S) plus the query timeout. With
    a 1-second query timeout and a 2-second grace it is 4 seconds.
    """

    QUERY_TIMEOUT_MS = 1000

    def _begin(self, rr_env, monkeypatch, grace_s=2.0):
        module = sys.modules[rr_env.iglobal_cls.__module__]
        monkeypatch.setattr(module, 'POOL_ACQUIRE_GRACE_S', grace_s)
        _set_pool_size(rr_env, monkeypatch, 1)
        glb = _begin(rr_env, {'query_timeout_ms': self.QUERY_TIMEOUT_MS})
        acquire_s = self.QUERY_TIMEOUT_MS / 1000 + grace_s
        assert glb.pool.acquire_timeout_s == pytest.approx(acquire_s)
        return glb, acquire_s + self.QUERY_TIMEOUT_MS / 1000

    def test_the_retry_waits_for_a_connection_only_until_the_budget_runs_out(self, rr_env, age_graph, monkeypatch):
        """3.5 s of a 4 s budget are gone: the retry waits 0.5 s for a connection, not the 3 s acquire timeout."""
        glb, budget_s = self._begin(rr_env, monkeypatch)
        _first_attempt_lost(glb, monkeypatch, 3.5)
        taken = _TakenBeforeTheRetry(glb.pool)
        monkeypatch.setattr(glb, 'pool', taken)
        try:
            started = time.monotonic()
            with pytest.raises(TimeoutError):
                glb._run_query('MATCH (p:Person) RETURN count(p) AS c')
            elapsed = time.monotonic() - started
            assert elapsed < budget_s + 1.0, f'the call took {elapsed:.2f} s on a {budget_s:g} s budget'
        finally:
            taken.release()
            glb.endGlobal()

    @pytest.mark.parametrize('first_attempt_s, longest_ms', [(0.0, 1000), (3.4, 650)])
    def test_the_retry_statement_gets_what_is_left_of_the_budget(
        self, rr_env, age_graph, monkeypatch, first_attempt_s, longest_ms
    ):
        """The database itself reports the retry's statement timeout; an early retry keeps the whole query timeout."""
        glb, _budget_s = self._begin(rr_env, monkeypatch)
        attempts = _first_attempt_lost(glb, monkeypatch, first_attempt_s)
        # Shaped like a translated plan: its own SET LOCAL statement_timeout, then the main statement.
        plan = _plan(
            [
                f"SET LOCAL statement_timeout = '{self.QUERY_TIMEOUT_MS}ms'",
                "SELECT current_setting('statement_timeout')",
            ],
            read_only=True,
            columns=('timeout',),
        )
        try:
            ((setting,),) = glb._execute_plan(plan, fetch_cap=1)
            assert len(attempts) == 2
            ms = _setting_ms(setting)
            if first_attempt_s == 0:
                assert ms == self.QUERY_TIMEOUT_MS
            else:
                assert 100 <= ms <= longest_ms, f'the retry ran with statement_timeout {setting} with ~0.6 s left'
        finally:
            glb.endGlobal()

    def test_with_nothing_left_the_retry_runs_nothing(self, rr_env, age_graph, monkeypatch):
        glb, budget_s = self._begin(rr_env, monkeypatch, grace_s=0.2)
        attempts = _first_attempt_lost(glb, monkeypatch, budget_s + 0.1)
        log = _StatementLog(glb.pool)
        monkeypatch.setattr(glb, 'pool', log)
        inst = _instance(rr_env, glb)
        try:
            with pytest.raises(_graph_tool_error()) as err:
                inst.read_query({'cypher': 'MATCH (p:Person) RETURN count(p)'})
            headline, _, detail = str(err.value).partition('\n')
            assert headline == f'Query timed out after {round(budget_s * 1000)} ms'
            assert 'no time was left to retry' in detail
            assert len(attempts) == 1, 'the retry ran with no budget left'
            assert log.statements == [], 'nothing may run once the budget is spent'
        finally:
            glb.endGlobal()


class TestSchemaAndDialect:
    def test_refresh_contents_and_estimated_counts(self, rr_env, age_graph):
        from .test_rocketride_graph_full import GRAPH

        _cypher_admin(
            "MATCH (a:Person {name: 'carol'}) CREATE (a)-[:WORKS_AT {since: 2024}]->(:Company {name: 'Beta'})"
        )
        conn = _admin()
        try:
            with conn.cursor() as cur:
                cur.execute(f'ANALYZE "{GRAPH}"."Person"')
                cur.execute(f'ANALYZE "{GRAPH}"."KNOWS"')
        finally:
            conn.close()
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            block = inst.refresh_schema({})['schema']
            labels = {label['name']: label for label in block['labels']}
            assert set(labels) == {'Person', 'Company'}
            assert labels['Person']['count'] == 3 and labels['Person']['count_estimated'] is True
            assert {p['name']: p['types'] for p in labels['Person']['properties']} == {
                'age': ['integer'],
                'name': ['string'],
            }
            rels = {r['type']: r for r in block['relationship_types']}
            assert rels['KNOWS']['endpoints'] == [{'start': 'Person', 'end': 'Person', 'observed': True}]
            assert rels['KNOWS']['properties'] == [{'name': 'since', 'types': ['integer']}]
            assert rels['KNOWS']['count'] == 2 and rels['KNOWS']['count_estimated'] is True
            works = rels['WORKS_AT']
            assert works['endpoints'] == [{'start': 'Person', 'end': 'Company', 'observed': True}]
            assert works['properties'] == [{'name': 'since', 'types': ['integer']}]
            assert block['error'] is None and block['stale'] is False
        finally:
            glb.endGlobal()

    def test_refresh_shows_a_change_made_by_execute(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        inst = _instance(rr_env, glb)
        try:
            inst.execute({'query': "CREATE (:Later {k: 1})-[:LATER_REL {w: 1.5}]->(:Person {name: 'z'})"})
            assert 'Later' not in inst.get_schema({})['labels']
            out = inst.refresh_schema({})
            assert 'Later' in out['labels']
            later = {r['type']: r for r in out['schema']['relationship_types']}['LATER_REL']
            assert later['endpoints'] == [{'start': 'Later', 'end': 'Person', 'observed': True}]
            assert later['properties'] == [{'name': 'w', 'types': ['float']}]
        finally:
            glb.endGlobal()

    def test_refresh_beside_reads_and_an_uncommitted_write(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        inst = _instance(rr_env, glb)
        age = _age()
        write = glb._translate('CREATE (:Uncommitted {k: 1})', mode=age.TranslateMode.RAW)
        write.statements.append('SELECT pg_sleep(1.0)')
        write.binds.append(())
        write.result_index = len(write.statements) - 1
        started = threading.Event()

        def run_write():
            started.set()
            return glb._execute_plan(write, fetch_cap=1)

        def run_refresh():
            started.wait(5)
            time.sleep(0.4)  # inside the writer's transaction, before its COMMIT
            return inst.refresh_schema({})['schema']

        def run_read():
            started.wait(5)
            time.sleep(0.4)
            return inst.read_query({'cypher': 'MATCH (p:Person) RETURN count(p)'})['rows']

        try:
            results, errors = _run_threads({'write': run_write, 'refresh': run_refresh, 'read': run_read})
            assert not errors, errors
            assert 'Uncommitted' not in {label['name'] for label in results['refresh']['labels']}
            assert results['read'] == [[3]]
            assert 'Uncommitted' in inst.refresh_schema({})['labels']  # visible once committed
        finally:
            glb.endGlobal()

    def test_failed_refresh_keeps_the_last_good_schema(self, rr_env, age_graph, monkeypatch):
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            good = inst.get_schema({})['schema']
            monkeypatch.setattr(sys.modules['ai.common.graph.graph_global_base'], 'SCHEMA_REFRESH_BUDGET_MS', 0)
            stale = inst.refresh_schema({})['schema']
            assert stale['stale'] is True and stale['error'] and stale['labels'] == good['labels']
        finally:
            glb.endGlobal()

    def test_dialect_and_prompt(self, rr_env, age_graph):
        glb = _begin(rr_env)
        inst = _instance(rr_env, glb)
        try:
            out = inst.dialect({})
            assert out['engine']['version'] == '1.5.0' and out['capabilities']['shortest_path'] is False
            assert out['read_boundary'] == 'read_only_tx' and out['limits']['statement_timeout_ms'] == 30000
            rules = ' '.join(glb._prompt_rules())
            assert 'Apache AGE 1.5.0' in rules and 'elementId()' in rules and 'at most 10' in rules
        finally:
            glb.endGlobal()


# ---------------------------------------------------------------------------
# The cloud tenant shape: a NOSUPERUSER role on its own database, holding
# the grants the cloud provisioner gives a tenant role, on the default
# 'rocketride' graph the provisioner creates. Every other test here runs as
# the bootstrap superuser, which bypasses all of these grants.
# ---------------------------------------------------------------------------

TENANT_GRAPH = 'rocketride'


def _tenant_grant_statements(graph, role):
    return [
        # Graph schema: the tenant owns the graph schema and its bootstrap tables.
        f'GRANT ALL ON SCHEMA "{graph}" TO "{role}"',
        f'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "{graph}" TO "{role}"',
        f'GRANT ALL ON ALL SEQUENCES IN SCHEMA "{graph}" TO "{role}"',
        f'ALTER SCHEMA "{graph}" OWNER TO "{role}"',
        f'ALTER TABLE "{graph}"._ag_label_vertex OWNER TO "{role}"',
        f'ALTER TABLE "{graph}"._ag_label_edge OWNER TO "{role}"',
        # The public schema, and read/execute access to the AGE catalog.
        f'GRANT ALL ON SCHEMA public TO "{role}"',
        f'GRANT USAGE ON SCHEMA ag_catalog TO "{role}"',
        f'GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO "{role}"',
        f'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ag_catalog TO "{role}"',
        f'GRANT ALL ON ALL SEQUENCES IN SCHEMA ag_catalog TO "{role}"',
    ]


@pytest.fixture(scope='class')
def tenant_db():
    """A disposable tenant database and role, provisioned like the cloud does; dropped afterwards."""
    import uuid

    from urllib.parse import urlsplit, urlunsplit

    suffix = uuid.uuid4().hex[:8]
    database, role, password = f'rr_gx_tenant_{suffix}', f'rr_gx_tenant_{suffix}_rw', f'tenant-{uuid.uuid4().hex}'
    parts = urlsplit(ADMIN_DSN)
    host = parts.netloc.rpartition('@')[2]
    admin = _admin()
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{database}"')
            cur.execute(f'CREATE ROLE "{role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %s', (password,))
            # Database access: closed to PUBLIC, all privileges for the tenant role.
            cur.execute(f'REVOKE CONNECT, TEMPORARY ON DATABASE "{database}" FROM PUBLIC')
            cur.execute(f'GRANT ALL PRIVILEGES ON DATABASE "{database}" TO "{role}"')
        setup = psycopg2.connect(urlunsplit(parts._replace(path=f'/{database}')), connect_timeout=5)
        setup.autocommit = True
        try:
            with setup.cursor() as cur:
                cur.execute('CREATE EXTENSION IF NOT EXISTS age')
                cur.execute('SET search_path = ag_catalog, "$user", public')
                cur.execute('SELECT create_graph(%s)', (TENANT_GRAPH,))
                for statement in _tenant_grant_statements(TENANT_GRAPH, role):
                    cur.execute(statement)
        finally:
            setup.close()
        dsn = urlunsplit(parts._replace(netloc=f'{role}:{password}@{host}', path=f'/{database}'))
        # The tenant seeds its own graph: the grants must also allow writes.
        seed = psycopg2.connect(dsn, connect_timeout=5)
        seed.autocommit = True
        try:
            with seed.cursor() as cur:
                cur.execute('SET search_path = ag_catalog, "$user", public')
                cur.execute(
                    f"SELECT * FROM cypher('{TENANT_GRAPH}', $$ "
                    "CREATE (a:Person {name: 'ada', age: 36})-[:KNOWS {since: 2020}]->(b:Person {name: 'bo', age: 29}), "
                    "(a)-[:WORKS_AT]->(:Company {name: 'Tenant Co'}) $$) AS (v agtype)"
                )
        finally:
            seed.close()
        yield types.SimpleNamespace(dsn=dsn, database=database, role=role)
    finally:
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
            cur.execute(f'DROP ROLE IF EXISTS "{role}"')
        admin.close()


def _begin_as_tenant(rr_env, tenant_db, monkeypatch, config=None):
    """The node as a cloud task runs it: the delivered tenant DSN, the default graph name."""
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': tenant_db.dsn}))
    glb = rr_env.iglobal_cls()
    glb.glb = types.SimpleNamespace(logicalType='rocketride_graph', connConfig=dict(config or {}))
    glb.beginGlobal()
    return glb, _instance(rr_env, glb)


class TestTenantRole:
    def test_the_role_is_not_a_superuser(self, tenant_db):
        conn = psycopg2.connect(tenant_db.dsn, connect_timeout=5)
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user')
                assert cur.fetchone() == (False, False, False)
        finally:
            conn.close()

    def test_read_query(self, rr_env, tenant_db, monkeypatch):
        glb, inst = _begin_as_tenant(rr_env, tenant_db, monkeypatch)
        try:
            assert glb.graph_name == TENANT_GRAPH
            out = inst.read_query(
                {'cypher': 'MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b.name', 'params': None}
            )
            a, r, name = out['rows'][0]
            assert a['properties']['name'] == 'ada' and r['type'] == 'KNOWS' and name == 'bo'
            params = inst.read_query(
                {'cypher': 'MATCH (p:Person) WHERE p.name = $n RETURN p.age', 'params': {'n': 'bo'}, 'limit': 5}
            )
            assert params['rows'] == [[29]] and params['truncated'] is False
        finally:
            glb.endGlobal()

    def test_get_and_refresh_schema(self, rr_env, tenant_db, monkeypatch):
        glb, inst = _begin_as_tenant(rr_env, tenant_db, monkeypatch)
        try:
            assert set(inst.get_schema({})['labels']) == {'Person', 'Company'}
            block = inst.refresh_schema({})['schema']
            assert block['error'] is None and block['stale'] is False
            assert {label['name'] for label in block['labels']} == {'Person', 'Company'}
            rels = {r['type']: r for r in block['relationship_types']}
            assert rels['KNOWS']['endpoints'] == [{'start': 'Person', 'end': 'Person', 'observed': True}]
            assert rels['WORKS_AT']['endpoints'] == [{'start': 'Person', 'end': 'Company', 'observed': True}]
        finally:
            glb.endGlobal()

    def test_dialect(self, rr_env, tenant_db, monkeypatch):
        glb, inst = _begin_as_tenant(rr_env, tenant_db, monkeypatch)
        try:
            out = inst.dialect({})
            assert out['dialect'] == 'age' and out['graph'] == TENANT_GRAPH
            assert out['database'] == tenant_db.database
            assert out['engine']['name'] == 'Apache AGE' and out['engine']['version'] == glb.age_version
            assert out['read_boundary'] == 'read_only_tx'
            assert tenant_db.role not in str(out)
        finally:
            glb.endGlobal()

    def test_read_path_refuses_writes_and_execute_needs_allow_execute(self, rr_env, tenant_db, monkeypatch):
        glb, inst = _begin_as_tenant(rr_env, tenant_db, monkeypatch)
        try:
            with pytest.raises(_graph_tool_error(), match='^Refused: '):
                inst.read_query({'cypher': "CREATE (:Evil {name: 'x'})"})
            with pytest.raises(ValueError, match='execute tool is disabled'):
                inst.execute({'query': "CREATE (:Evil {name: 'x'})", 'shape': 'graph'})
            assert inst.read_query({'cypher': 'MATCH (n:Evil) RETURN count(n)'})['rows'] in ([[0]], [])
        finally:
            glb.endGlobal()

    def test_execute_writes_a_new_label_as_the_tenant(self, rr_env, tenant_db, monkeypatch):
        glb, inst = _begin_as_tenant(rr_env, tenant_db, monkeypatch, {'allow_execute': True})
        try:
            out = inst.execute({'query': "CREATE (n:TenantNote {text: 'hi'}) RETURN n", 'shape': 'graph'})
            assert out['rows'][0][0]['labels'] == ['TenantNote']
            assert 'TenantNote' in inst.refresh_schema({})['labels']
        finally:
            glb.endGlobal()
