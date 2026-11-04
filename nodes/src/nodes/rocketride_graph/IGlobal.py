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

"""RocketRide cloud graph global state.

Mirrors ``graph_neo4j`` on :class:`GraphGlobalBase`, with two differences:

1. **Connection** — no host/user/password config; the DSN is the one the
   task engine delivered for the node's scope / target
   (``ai.common.rocketride_db``), same seam as ``rocketride_sql`` /
   ``rocketride_vector``. The tenant database is Postgres + Apache AGE.
2. **Query paths** — Apache AGE cannot run bare Cypher, so ``_run_query``
   (safe), ``_run_query_raw`` (EXECUTE) and ``_validate_query`` all route
   through the Cypher->AGE translation layer (``ai.common.graph.age``).

Session discipline: the cloud endpoint is a transaction-mode pooler, so every
query runs inside one transaction whose settings are ``SET LOCAL`` only (the
translated plan carries them). The safe path additionally makes its
transaction ``READ ONLY`` — server-side write protection, with the base's
``is_cypher_safe`` regex and the layer's semantic firewall as defence-in-depth.
Each call owns its connection for that transaction (a bounded pool hands
connections out exclusively), so parallel tool calls never share one; nothing
is left on the session afterwards (no session SETs, prepared statements are
deallocated even when the query fails).
"""

import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import psycopg2
from psycopg2 import errors as pg_errors
from psycopg2 import sql
from psycopg2.extensions import TRANSACTION_STATUS_IDLE

from rocketlib import warning
from ai.common.graph import GraphGlobalBase
from ai.common.graph.adapters import age_adapter
from ai.common.graph.age import (
    CAPABILITY_TABLES,
    DEFAULT_AGE_VERSION,
    AgeFirewallRejected,
    AgeTranslationError,
    AgeUnsupportedFeature,
    FirewallConfig,
    TranslateMode,
    TranslatedQuery,
    decode_row,
    parse_agtype,
    translate,
)
from ai.common.graph.connection_pool import ConnectionPool, PoolClosed, PoolTimeout
from ai.common.graph.schema import SCHEMA_LABEL_LIMIT, SCHEMA_REL_TYPE_LIMIT, SCHEMA_SAMPLE_SIZE
from ai.common.rocketride_db import DsnNotDelivered, db_target, resolve_rocketride_dsn

DEFAULT_GRAPH_NAME = 'rocketride'
DEFAULT_MAX_ROWS = 1000
DEFAULT_QUERY_TIMEOUT_MS = 30000

# Connections a node may hold. Tool calls run on up to 64 worker threads per
# task; past this many concurrent calls, callers queue for a free connection
# (bounded by the statement timeout plus a grace period) instead of opening an
# unbounded number of client connections to the tenant database's pooler,
# whose client-connection limit every tenant shares. A connection idle for
# POOL_IDLE_TIMEOUT_S is closed, so an idle pipeline holds none.
DEFAULT_POOL_SIZE = 4
POOL_IDLE_TIMEOUT_S = 60.0
POOL_ACQUIRE_GRACE_S = 5.0
CONNECT_TIMEOUT_S = 3

# Savepoint that brackets a prepared EXECUTE, so a failed EXECUTE can be
# rolled back to a point where DEALLOCATE still runs in the same transaction.
_EXEC_SAVEPOINT = 'rr_exec'


class _ConnectionLost(Exception):
    """The session died mid-call. ``before_main`` = nothing user-visible ran yet."""

    def __init__(self, original: BaseException, *, before_main: bool) -> None:
        super().__init__(str(original))
        self.original = original
        self.before_main = before_main


class ResultDecodeError(ValueError):
    """A result value the database returned could not be decoded (the statement itself was valid)."""


class QueryBudgetExhausted(TimeoutError):
    """The connection was lost before the statement ran, and the call had no time left to retry it."""

    def __init__(self, budget_ms: int) -> None:
        super().__init__(
            'query budget exhausted: the connection was lost before the statement ran, '
            'and no time was left to retry it on a new connection'
        )
        self.budget_ms = budget_ms


def _decoded(raw_rows, *, ran: bool = False):
    """Parse each agtype cell, reporting a failure as a result problem, not as invalid Cypher."""
    for row in raw_rows:
        try:
            yield [parse_agtype(v) for v in row]
        except AgeTranslationError as e:
            raise ResultDecodeError(f'{e} (the statement itself ran)' if ran else str(e)) from e


def _open_connection(dsn: str):
    conn = psycopg2.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)
    # READ ONLY and SET LOCAL statement_timeout only apply inside a
    # transaction; psycopg2 opens one implicitly on the first execute only
    # while autocommit is off. Make the precondition explicit.
    conn.autocommit = False
    return conn


def _reset_connection(conn) -> None:
    """Return a connection to idle-with-no-transaction, or raise."""
    conn.rollback()
    if conn.get_transaction_status() != TRANSACTION_STATUS_IDLE:
        raise RuntimeError('connection did not return to idle after rollback')


def _connection_usable(conn) -> bool:
    return conn.closed == 0 and not conn.autocommit


def _close_connection(conn) -> None:
    conn.close()


class IGlobal(GraphGlobalBase):
    """Postgres + Apache AGE global for the RocketRide cloud graph node.

    Every database call checks a connection out of :attr:`pool` exclusively and
    runs in its own transaction, so concurrent tool calls never share a
    transaction (and so never share, or lose, each other's READ ONLY and
    statement-timeout settings).
    """

    pool: Optional[ConnectionPool] = None
    graph_name: str = DEFAULT_GRAPH_NAME
    max_rows: int = DEFAULT_MAX_ROWS
    query_timeout_ms: int = DEFAULT_QUERY_TIMEOUT_MS
    age_version: str = ''
    database_name: Optional[str] = None
    supports_execute_params = True

    # ------------------------------------------------------------------
    # Driver lifecycle
    # ------------------------------------------------------------------

    def _open_driver(self, config: Dict[str, Any]) -> None:
        """Read the delivered DSN, open the pool, and fail fast on a missing graph."""
        self.graph_name = str(config.get('graph') or DEFAULT_GRAPH_NAME).strip()
        self.max_rows = self._config_int(config, 'max_rows', DEFAULT_MAX_ROWS)
        self.query_timeout_ms = self._config_int(config, 'query_timeout_ms', DEFAULT_QUERY_TIMEOUT_MS)

        # The one RocketRide difference: the delivered DSN, no connection config.
        dsn = resolve_rocketride_dsn(*db_target(config))
        pool = ConnectionPool(
            lambda: _open_connection(dsn),
            max_size=DEFAULT_POOL_SIZE,
            acquire_timeout_s=self.query_timeout_ms / 1000.0 + POOL_ACQUIRE_GRACE_S,
            reset=_reset_connection,
            is_usable=_connection_usable,
            close=_close_connection,
            idle_timeout_s=POOL_IDLE_TIMEOUT_S,
        )

        try:
            # Fail-fast round-trip: AGE present + the tenant graph exists.
            rows = self._sql_read(
                "SELECT extversion FROM pg_extension WHERE extname = 'age'",
                pool=pool,
            )
            if not rows:
                raise RuntimeError('The tenant database does not have the Apache AGE extension installed')
            self.age_version = rows[0][0]
            if self.age_version not in CAPABILITY_TABLES:
                warning(
                    f'rocketride_graph: no Cypher rules for Apache AGE {self.age_version}; '
                    f'using the strict AGE {DEFAULT_AGE_VERSION} rules'
                )
            graph_exists = bool(
                self._sql_read('SELECT 1 FROM ag_catalog.ag_graph WHERE name = %s', (self.graph_name,), pool=pool)
            )
            # The database's own name is safe identity for the connection card
            # (unlike the DSN, which carries host and credentials).
            self.database_name = self._sql_read('SELECT current_database()', pool=pool)[0][0]
        except BaseException:
            pool.close()
            raise

        if not graph_exists:
            pool.close()
            # The provisioner creates the default graph in every tenant
            # database. Any other name must already exist: the node never
            # creates a graph itself.
            raise RuntimeError(
                f'AGE graph {self.graph_name!r} does not exist in the tenant database. '
                f'Every RocketRide database comes with the {DEFAULT_GRAPH_NAME!r} graph; use it, '
                f"or create this one first (SELECT create_graph('{self.graph_name}'))."
            )
        self.pool = pool

    def _close_driver(self) -> None:
        pool, self.pool = self.pool, None
        if pool is not None:
            pool.close()

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time probe: warn-only (the user is still editing the node).

        Outside a task no DSN is delivered, so only scope / target are
        checked: connectivity is checked when the pipeline runs.
        """
        conn = None
        try:
            dsn = resolve_rocketride_dsn(*db_target(config))
            conn = psycopg2.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
                cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'age'")
                if cur.fetchone() is None:
                    warning('The tenant database does not have the Apache AGE extension installed')
                    return
                graph = str(config.get('graph') or DEFAULT_GRAPH_NAME).strip()
                cur.execute('SELECT 1 FROM ag_catalog.ag_graph WHERE name = %s', (graph,))
                if cur.fetchone() is None:
                    warning(f'AGE graph {graph!r} does not exist yet in the tenant database')
        except DsnNotDelivered:
            return
        except Exception as e:
            warning(str(e).strip().splitlines()[0] if str(e).strip() else repr(e))
        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Query paths — everything routes through the translation layer
    # ------------------------------------------------------------------

    @property
    def read_row_cap(self) -> int:
        """Node-owner row ceiling for the safe read path."""
        return self.max_rows

    def _firewall_config(self) -> FirewallConfig:
        return FirewallConfig(statement_timeout_ms=self.query_timeout_ms)

    def _translate(
        self,
        query: str,
        params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        mode: TranslateMode = TranslateMode.SAFE,
    ) -> TranslatedQuery:
        return translate(
            query,
            params=params,
            limit=limit,
            mode=mode,
            graph_name=self.graph_name,
            age_version=self.age_version or DEFAULT_AGE_VERSION,
            firewall=self._firewall_config(),
        )

    def _require_pool(self) -> ConnectionPool:
        if self.pool is None:
            raise RuntimeError('Database connection is not initialized')
        return self.pool

    def _execute_plan(
        self,
        plan: TranslatedQuery,
        fetch_cap: Optional[int] = None,
        *,
        explain: bool = False,
        max_rows: Optional[int] = None,
    ) -> List[Tuple]:
        """Run one translated plan in its own transaction on its own connection.

        A connection that turns out to be dead before the plan's main
        statement was sent (e.g. dropped while idle in the pool) is discarded
        and the plan is retried once on a newly opened connection: nothing
        ran, so the retry is safe even for a write. The retry never reuses an
        idle connection, and closes them all: a database or pooler restart
        drops every idle session at once. A failure at or after the main
        statement is never retried — whether it ran is unknown.

        The retry gets only what is left of the call's budget, which is what
        the first attempt may take: its wait for a connection (the pool's
        acquire timeout) plus the query timeout. Its wait for a connection
        stops when the budget runs out (PoolTimeout), its statement timeout is
        the budget left once it has a connection (never more than the query
        timeout), and with nothing left it runs nothing and raises
        :class:`QueryBudgetExhausted`.
        """
        pool = self._require_pool()
        budget_s = pool.acquire_timeout_s + self.query_timeout_ms / 1000.0
        deadline = time.monotonic() + budget_s
        wait_s: Optional[float] = None
        for attempt in (1, 2):
            if attempt > 1:
                wait_s = deadline - time.monotonic()
                if wait_s <= 0:
                    raise QueryBudgetExhausted(round(budget_s * 1000))
            with pool.connection(fresh=attempt > 1, timeout_s=wait_s) as conn:
                statement_timeout_ms = None
                if attempt > 1:
                    left_ms = int((deadline - time.monotonic()) * 1000)
                    if left_ms <= 0:
                        raise QueryBudgetExhausted(round(budget_s * 1000))
                    statement_timeout_ms = min(int(self.query_timeout_ms), left_ms)
                try:
                    return self._run_plan(
                        conn,
                        plan,
                        fetch_cap,
                        explain=explain,
                        statement_timeout_ms=statement_timeout_ms,
                        max_rows=max_rows,
                    )
                except _ConnectionLost as lost:
                    pool.discard(conn)
                    if lost.before_main and attempt == 1:
                        continue
                    raise lost.original from None
        raise AssertionError('unreachable')  # pragma: no cover

    def _run_plan(
        self,
        conn,
        plan: TranslatedQuery,
        fetch_cap: Optional[int],
        *,
        explain: bool,
        statement_timeout_ms: Optional[int] = None,
        max_rows: Optional[int] = None,
    ) -> List[Tuple]:
        """Execute ``plan`` on an exclusively owned connection; commit or roll back.

        Transaction shape (psycopg2 opens it on the first execute)::

            SET TRANSACTION READ ONLY            -- safe path; must come first
            SET LOCAL search_path / statement_timeout
            [PREPARE p ...; SAVEPOINT rr_exec]   -- params path
            <main statement>                     -- or EXPLAIN <main statement>
            [RELEASE SAVEPOINT rr_exec; DEALLOCATE p]
            COMMIT                               -- ROLLBACK when explaining

        PostgreSQL keeps a prepared statement after ROLLBACK, so if the main
        statement fails after PREPARE the transaction is rolled back to the
        savepoint and the statement is deallocated before the final ROLLBACK —
        all inside one transaction, which stays on one server session even
        behind a transaction-mode pooler.

        ``statement_timeout_ms`` (a retry's budget left) is set with one more
        ``SET LOCAL statement_timeout`` just before the main statement, so it
        replaces the plan's own.

        ``max_rows`` is a row ceiling checked before commit: more rows than
        that raise ``ValueError`` and roll the transaction back, so an
        over-limit write saves nothing and a retry cannot duplicate it.
        """
        if conn.autocommit:
            raise RuntimeError(
                'rocketride_graph requires autocommit=False: READ ONLY and SET LOCAL '
                'statement_timeout only apply inside a transaction'
            )
        prepare_index = plan.result_index - 1 if plan.prepared_name else None
        rows: List[Tuple] = []
        main_sent = False
        prepared = False
        savepoint = False
        try:
            with conn.cursor() as cur:
                if plan.read_only:
                    cur.execute('SET TRANSACTION READ ONLY')
                for i, (stmt, binds) in enumerate(zip(plan.statements, plan.binds)):
                    if i == plan.result_index:
                        if statement_timeout_ms is not None:
                            cur.execute(f"SET LOCAL statement_timeout = '{max(1, int(statement_timeout_ms))}ms'")
                        if prepared:
                            cur.execute(f'SAVEPOINT {_EXEC_SAVEPOINT}')
                            savepoint = True
                        main_sent = True
                        cur.execute(('EXPLAIN ' + stmt) if explain else stmt, binds or None)
                        if not explain and cur.description is not None:
                            rows = cur.fetchmany(fetch_cap) if fetch_cap else cur.fetchall()
                        if savepoint:
                            cur.execute(f'RELEASE SAVEPOINT {_EXEC_SAVEPOINT}')
                            savepoint = False
                        continue
                    cur.execute(stmt, binds or None)
                    if i == prepare_index:
                        prepared = True
                    elif prepared and i > plan.result_index:
                        # The plan's own DEALLOCATE ran.
                        prepared = False
            # Checked after the plan's DEALLOCATE has run, but before commit, so
            # a write whose result exceeds the cap is rolled back, not half-reported.
            if max_rows is not None and len(rows) > max_rows:
                raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')
            if explain or plan.read_only:
                # Nothing to keep; ending a read with ROLLBACK is equivalent and
                # also covers EXPLAIN, which must never commit anything.
                conn.rollback()
            else:
                conn.commit()
            return rows
        except Exception as exc:
            if conn.closed:
                raise _ConnectionLost(exc, before_main=not main_sent) from exc
            self._abort_transaction(conn, plan, prepared=prepared, savepoint=savepoint)
            raise

    def _abort_transaction(self, conn, plan: TranslatedQuery, *, prepared: bool, savepoint: bool) -> None:
        """Roll back after a failure, deallocating a leftover prepared statement first."""
        if prepared and plan.prepared_name:
            try:
                with conn.cursor() as cur:
                    if savepoint:
                        cur.execute(f'ROLLBACK TO SAVEPOINT {_EXEC_SAVEPOINT}')
                        cur.execute(f'DEALLOCATE {plan.prepared_name}')
                    else:
                        # Failed between PREPARE and the savepoint, or after the
                        # savepoint was released: the transaction is aborted and
                        # cannot DEALLOCATE. Closing the session is the only
                        # sure cleanup, so let the pool drop this connection.
                        raise RuntimeError('cannot deallocate inside an aborted transaction')
            except Exception:
                self._require_pool().discard(conn)
        try:
            conn.rollback()
        except Exception:
            self._require_pool().discard(conn)

    def _sql_read(
        self,
        statement: str,
        params: Sequence[Any] = (),
        *,
        pool: Optional[ConnectionPool] = None,
    ) -> List[Tuple]:
        """Run one plain SQL read in its own READ ONLY, time-bounded transaction."""
        pool = pool or self._require_pool()
        with pool.connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute('SET TRANSACTION READ ONLY')
                    cur.execute(f"SET LOCAL statement_timeout = '{max(1, int(self.query_timeout_ms))}ms'")
                    cur.execute(statement, tuple(params) or None)
                    rows = cur.fetchall() if cur.description is not None else []
                conn.rollback()
                return rows
            except Exception:
                if conn.closed:
                    # No retry here, but a restart dropped the idle sessions
                    # too: the next calls must not take one of them.
                    pool.discard(conn)
                    pool.close_idle()
                raise

    def _run_query(self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None) -> List[Dict]:
        """Read-only path: translate (safe mode) and run in a READ ONLY txn."""
        cap = self.read_row_cap if limit is None else min(int(limit), self.read_row_cap) + 1
        plan = self._translate(query, params=params, limit=cap, mode=TranslateMode.SAFE)
        raw_rows = self._execute_plan(plan, fetch_cap=cap)
        return [decode_row(plan, row) for row in raw_rows]

    def _run_query_raw(self, query: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """EXECUTE path: translation still applies (AGE can't run bare Cypher);
        only the semantic firewall is skipped, never the resource caps.

        ``params`` binds ``$name`` values through the plan's prepared
        statement, so they skip the parser and the query-length cap (they
        have their own size cap, ``max_params_bytes``).
        """
        plan = self._translate(query, params=params, mode=TranslateMode.RAW)
        max_rows = self.max_execute_rows
        raw_rows = self._execute_plan(plan, fetch_cap=max_rows + 1, max_rows=max_rows)
        rows = [decode_row(plan, row) for row in raw_rows]
        # AGE exposes no write counters (unlike Bolt); affected_rows reports
        # the result-row count — 0 for writes without a RETURN clause.
        return {'rows': rows, 'affected_rows': len(rows)}

    # ------------------------------------------------------------------
    # read_query / execute(shape='graph')
    # ------------------------------------------------------------------

    @property
    def statement_timeout_ms(self) -> int:
        return int(self.query_timeout_ms)

    def _graph_adapter(self):
        return age_adapter()

    def _read_query_rows(self, cypher, params, fetch_limit, consume):
        """Safe-mode translation (firewall) in a READ ONLY transaction with SET LOCAL statement_timeout.

        The translator wraps the statement in an outer SQL LIMIT of
        ``fetch_limit`` (the caller's limit + 1), so the database stops early.
        Rows stay positional, so duplicate column names survive.
        """
        plan = self._translate(cypher, params=params, limit=fetch_limit, mode=TranslateMode.SAFE)
        raw_rows = self._execute_plan(plan, fetch_cap=fetch_limit)
        return consume(self._plan_columns(plan), _decoded(raw_rows))

    def _raw_query_rows(self, cypher, fetch_limit, consume, params=None):
        """execute(shape='graph'): ``params`` bind through the plan's prepared statement, as in ``_run_query_raw``."""
        plan = self._translate(cypher, params=params, mode=TranslateMode.RAW)
        raw_rows = self._execute_plan(plan, fetch_cap=fetch_limit)
        rows = list(_decoded(raw_rows, ran=True))
        # AGE exposes no write counters; like the legacy path, report result rows.
        return consume(self._plan_columns(plan), iter(rows)), len(rows)

    @staticmethod
    def _plan_columns(plan: TranslatedQuery) -> List[str]:
        # A statement without RETURN yields no rows; its synthesized column is ours, not the user's.
        return list(plan.columns) if plan.has_return else []

    def _describe_error(self, exc):
        version = self.age_version or DEFAULT_AGE_VERSION
        if isinstance(exc, AgeUnsupportedFeature):
            return f'Not supported on Apache AGE {version}: {exc.construct}', exc.detail
        if isinstance(exc, AgeFirewallRejected):
            return f'Refused: {_firewall_headline(exc)}', str(exc)
        if isinstance(exc, AgeTranslationError):
            return 'Invalid Cypher for Apache AGE', str(exc)
        if isinstance(exc, ResultDecodeError):
            return 'Query result cannot be represented', str(exc)
        if isinstance(exc, PoolTimeout):
            return 'Database busy: no connection became free in time', str(exc)
        if isinstance(exc, QueryBudgetExhausted):
            return f'Query timed out after {exc.budget_ms} ms', f'{exc}; try again.'
        if isinstance(exc, PoolClosed):
            return 'The graph node is shutting down', str(exc)
        if isinstance(exc, pg_errors.QueryCanceled):
            return f'Query timed out after {self.statement_timeout_ms} ms', _pg_detail(exc)
        if isinstance(exc, pg_errors.ReadOnlySqlTransaction):
            return 'Refused: the database refused a write on the read-only path', _pg_detail(exc)
        if isinstance(exc, psycopg2.Error):
            return 'Query failed', _pg_detail(exc)
        return None

    def _validate_query(self, query: str) -> Tuple[bool, str]:
        """EXPLAIN the translated statement without executing it.

        Translation errors (syntax, firewall, capability) surface here too, so
        the LLM repair loop receives the layer's actionable messages.
        """
        try:
            plan = self._translate(query, mode=TranslateMode.SAFE)
        except AgeTranslationError as e:
            return False, str(e)
        try:
            self._execute_plan(plan, explain=True)
            return True, ''
        except Exception as e:
            return False, str(e)

    # ------------------------------------------------------------------
    # Schema reflection — AGE catalog + bounded sampling (schema v2)
    # ------------------------------------------------------------------

    def _reflect_schema_v2(self, builder, deadline):
        """Labels from the AGE catalog in id order, estimated counts, sampled properties and endpoints.

        One pooled connection, one REPEATABLE READ, READ ONLY transaction whose
        SET LOCAL statement_timeout is the remaining refresh budget: every
        sample sees the same database state and the whole refresh is bounded
        by the server. Counts come from pg_class.reltuples (planner
        estimates, never a scan). Edge endpoints come from the label id that
        AGE encodes in the top 16 bits of every graphid, so no join or
        Cypher text is assembled from label names. The wait for a pool slot
        stops when the budget runs out (PoolTimeout), and the budget left is
        measured again once the connection is acquired, so that wait counts
        against it.
        """
        remaining_s = deadline - time.monotonic()
        if remaining_s <= 0:
            raise TimeoutError('schema refresh budget exhausted')
        pool = self._require_pool()
        with pool.connection(timeout_s=remaining_s) as conn:
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                raise TimeoutError('schema refresh budget exhausted')
            try:
                with conn.cursor() as cur:
                    cur.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                    cur.execute(f"SET LOCAL statement_timeout = '{max(1, remaining_ms)}ms'")
                    cur.execute(
                        'SELECT l.id, l.name, l.kind, c.reltuples FROM ag_catalog.ag_label l '
                        'JOIN ag_catalog.ag_graph g ON l.graph = g.graphid '
                        'JOIN pg_catalog.pg_class c ON c.oid = l.relation '
                        'WHERE g.name = %s ORDER BY l.id',
                        (self.graph_name,),
                    )
                    catalog = cur.fetchall()
                    # Label id -> name, the default (unlabelled) labels as ''.
                    names = {int(lid): ('' if name.startswith('_ag_label_') else name) for lid, name, _k, _r in catalog}
                    vertices = [
                        (name, tuples)
                        for _id, name, kind, tuples in catalog
                        if kind == 'v' and not name.startswith('_ag_')
                    ]
                    edges = [
                        (name, tuples)
                        for _id, name, kind, tuples in catalog
                        if kind == 'e' and not name.startswith('_ag_')
                    ]
                    if len(vertices) > SCHEMA_LABEL_LIMIT or len(edges) > SCHEMA_REL_TYPE_LIMIT:
                        builder.truncated = True
                    for name, tuples in vertices[:SCHEMA_LABEL_LIMIT]:
                        builder.label(name, **_estimate(tuples))
                        cur.execute(
                            sql.SQL('SELECT properties FROM ONLY {} LIMIT %s').format(
                                sql.Identifier(self.graph_name, name)
                            ),
                            (SCHEMA_SAMPLE_SIZE,),
                        )
                        for (props,) in cur.fetchall():
                            builder.sample_label_properties(name, parse_agtype(props))
                    for name, tuples in edges[:SCHEMA_REL_TYPE_LIMIT]:
                        builder.rel_type(name, **_estimate(tuples))
                        cur.execute(
                            sql.SQL('SELECT start_id::text, end_id::text, properties FROM ONLY {} LIMIT %s').format(
                                sql.Identifier(self.graph_name, name)
                            ),
                            (SCHEMA_SAMPLE_SIZE,),
                        )
                        for start_id, end_id, props in cur.fetchall():
                            builder.endpoint(
                                name,
                                names.get(int(start_id) >> 48, ''),
                                names.get(int(end_id) >> 48, ''),
                                observed=True,
                            )
                            builder.sample_rel_properties(name, parse_agtype(props))
                conn.rollback()
            except Exception:
                if conn.closed:
                    pool.discard(conn)
                    pool.close_idle()
                raise

    def _engine_identity(self):
        return {
            'engine': {'name': 'Apache AGE', 'version': self.age_version or None, 'edition': None},
            'database': self.database_name,
            'graph': self.graph_name,
            'read_boundary': 'read_only_tx',
            'read_boundary_verified': False,
            'shortest_path': False,
            'server_result_cap': None,
        }

    def _prompt_rules(self):
        version = self.age_version or DEFAULT_AGE_VERSION
        return [
            f'The database is PostgreSQL with Apache AGE {version}, which runs a SUBSET of Cypher.',
            'Read only: MATCH, OPTIONAL MATCH, WITH, UNWIND, RETURN, ORDER BY, SKIP, LIMIT. Never CALL.',
            'List every result column explicitly (no RETURN *); ORDER BY an expression, not a RETURN alias.',
            'One label per node, inside the pattern: (n:Label). No WHERE n:Label and no (n:A:B).',
            'Not available: datetime(), date(), time(), localtime(), localdatetime(), duration(), elementId(), '
            'list or pattern comprehensions, EXISTS { } subqueries, exists(), =~, shortestPath(), allShortestPaths().',
            'Variable-length relationships need an upper bound of at most 10, e.g. -[*1..3]->.',
            'Refer to nodes by id(n); compare with toInteger($id) when the id is a string.',
            'Never qualify a function with a schema name.',
        ]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _config_int(config: Dict[str, Any], key: str, default: int) -> int:
        try:
            return max(1, int(config.get(key, default)))
        except (TypeError, ValueError):
            return default


_FIREWALL_HEADLINES = {
    'write_clause': 'read_query is read-only; this statement writes',
    'procedure_call': 'CALL is not allowed on the read-only path',
    'unbounded_var_length': 'variable-length patterns need an upper bound',
    'max_var_length_depth': 'variable-length pattern is too deep',
    'invalid_var_length_range': 'invalid variable-length range',
    'max_query_length': 'query is too long',
    'max_nesting_depth': 'expression is nested too deeply',
}


def _firewall_headline(exc: AgeFirewallRejected) -> str:
    rule = getattr(exc, 'rule', '')
    headline = _FIREWALL_HEADLINES.get(rule, 'the statement is not allowed on the read-only path')
    if rule == 'write_clause':
        # 'Query rejected by firewall (write_clause): CREATE, SET not allowed ...'
        clauses = str(exc).partition('): ')[2].partition(' not allowed')[0]
        if clauses:
            headline += f' ({clauses})'
    return headline


def _pg_detail(exc: BaseException) -> str:
    text = (getattr(exc, 'pgerror', None) or str(exc)).strip()
    if text.startswith('ERROR:'):
        text = text[len('ERROR:') :].strip()
    return '\n'.join(text.splitlines()[:6])


def _estimate(reltuples: Any) -> Dict[str, Any]:
    """pg_class.reltuples as a schema count: an estimate, or nothing if never analyzed."""
    try:
        value = float(reltuples)
    except (TypeError, ValueError):
        return {}
    if value < 0:
        return {}
    return {'count': int(value), 'estimated': True}
