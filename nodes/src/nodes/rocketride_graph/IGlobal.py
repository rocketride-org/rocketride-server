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
One transaction per call: every path commits or rolls back before it returns.
Every binding of the control shares the one connection, and a commit ends
whatever transaction is open on it, so each transaction holds the
connection lock from its first statement to its commit or rollback: a
schema lookup can never commit an EXECUTE that is still checking its row cap.

What the control keeps: the tenant connection (``scope`` / ``target``, the
expensive thing) and the AGE version. The graph name, the row cap, the timeout
and the gates are per-call parameters read from the calling instance's
``settings``; the reflected schema is a bounded cache keyed by graph name,
filled on a graph's first use.
"""

import os
import re
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Mapping, Optional, Tuple

from depends import depends

# psycopg2 is imported at module scope, so the requirements are installed before
# that happens. This module is only imported on the run path (config mode
# imports the validator alone), so the install never runs while a user is merely
# opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

import psycopg2
from psycopg2 import sql

from rocketlib import warning
from ai.common.graph import GraphGlobalBase, max_execute_rows
from ai.common.graph.age import (
    CAPABILITY_TABLES,
    DEFAULT_AGE_VERSION,
    AgeTranslationError,
    FirewallConfig,
    TranslateMode,
    TranslatedQuery,
    decode_agtype,
    decode_row,
    translate,
)
from ai.common.rocketride_db import db_target, resolve_rocketride_dsn

from .IValidator import probe_connection

DEFAULT_GRAPH_NAME = 'rocketride'
DEFAULT_MAX_ROWS = 1000
DEFAULT_QUERY_TIMEOUT_MS = 30000

# Reflection fan-out bounds (mirrors graph_falkordb's sampling posture).
SCHEMA_LABEL_LIMIT = 200
SCHEMA_REL_LIMIT = 100

# Same identifier rule the translation layer applies to graph names — labels
# interpolated into Cypher text must conform (see _sample_edge_endpoints).
VALID_LABEL = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


#: The most graph schemas one control keeps. A tenant database holds a handful
#: of graphs; past this the least recently used entry is reflected again on its
#: next use (a cache: losing an entry costs time, never an answer).
SCHEMA_CACHE_LIMIT = 16


# =============================================================================
# The per-call values of this node, read from a call's settings
# =============================================================================


def graph_name(settings: Mapping) -> str:
    """Return the AGE graph this call addresses."""
    return str(settings['graph']).strip()


def max_rows(settings: Mapping) -> int:
    """Return this call's row ceiling for the safe read path (the schema bounds it)."""
    return int(settings['max_rows'])


def query_timeout_ms(settings: Mapping) -> int:
    """Return this call's statement timeout in milliseconds (the schema bounds it)."""
    return int(settings['query_timeout_ms'])


class IGlobal(GraphGlobalBase):
    """Postgres + Apache AGE global for the RocketRide cloud graph node."""

    client = None
    age_version: str = ''
    supports_execute_params = True
    # The graph is a per-call parameter: nothing to reflect before a call names one.
    reflect_at_start = False

    # Bounded cache: graph name -> reflected schema, least recently used last
    # out. Built in _open_driver, dropped in _close_driver.
    _schemas: Optional[OrderedDict] = None
    _schema_lock: Optional[threading.Lock] = None

    # Held for the whole of each transaction on the shared connection (its
    # first statement to its commit or rollback). Taken after _schema_lock,
    # never before it, and never nested.
    _conn_lock: Optional[threading.Lock] = None

    # ------------------------------------------------------------------
    # Driver lifecycle
    # ------------------------------------------------------------------

    def _open_driver(self, config: Mapping) -> None:
        """Read the delivered DSN, connect, and fail fast on a database without AGE.

        Only ``scope`` and ``target`` are read: a different value is a
        different tenant database, hence a different control. Whether a graph
        exists is checked when a call first names it (``schema_for``).
        """
        self._schemas = OrderedDict()
        self._schema_lock = threading.Lock()
        self._conn_lock = threading.Lock()

        # The one RocketRide difference: the delivered DSN, no connection config.
        dsn = resolve_rocketride_dsn(*db_target(config))

        # Bounded connect so an unreachable pooler fails fast (matches the
        # probe's 3s timeout) instead of waiting out the OS TCP timeout.
        self.client = psycopg2.connect(dsn, connect_timeout=3)

        # Fail-fast round-trip: AGE present.
        with self.client.cursor() as cur:
            cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'age'")
            row = cur.fetchone()
            if row is None:
                raise RuntimeError('The tenant database does not have the Apache AGE extension installed')
            self.age_version = row[0]
            if self.age_version not in CAPABILITY_TABLES:
                warning(
                    f'rocketride_graph: no Cypher rules for Apache AGE {self.age_version}; '
                    f'using the strict AGE {DEFAULT_AGE_VERSION} rules'
                )
        self.client.commit()

    def _close_driver(self) -> None:
        self._schemas = None
        if self.client is not None:
            self.client.close()
            self.client = None

    def _probe_connection(self, config: Mapping) -> None:
        """Save-time probe; the one copy lives beside the validator."""
        probe_connection(config)

    # ------------------------------------------------------------------
    # The schema cache: one entry per graph a call has named
    # ------------------------------------------------------------------

    def schema_for(self, settings: Mapping) -> Dict[str, Any]:
        """Return the schema of the graph this call addresses, reflecting it on first use.

        The first use of a name checks that the graph exists and reflects it
        (up to 1 + SCHEMA_LABEL_LIMIT + SCHEMA_REL_LIMIT single-row queries);
        every later call of any binding reads the cached entry. A missing graph
        is not cached: it may be created before the next call.

        Args:
            settings: The calling instance's ``self.settings``.

        Returns:
            Dict[str, Any]: ``{'nodes': {...}, 'relationships': [...]}``.

        Raises:
            RuntimeError: The graph does not exist in the tenant database.
        """
        name = graph_name(settings)
        with self._schema_lock:
            # Step 1: a graph already reflected is served from the cache
            cached = self._schemas.get(name)
            if cached is not None:
                self._schemas.move_to_end(name)
                return cached

            # Step 2: the node never creates a graph, so a missing one is an error
            self._require_graph(name)

            # Step 3: reflection is a convenience for the LLM prompt, never a prerequisite
            try:
                schema = self._reflect_schema(name)
            except Exception as e:
                warning(f'rocketride_graph: schema reflection failed, continuing without it: {e}')
                schema = {'nodes': {}, 'relationships': []}

            # Step 4: keep it, dropping the least recently used entry past the bound
            self._schemas[name] = schema
            while len(self._schemas) > SCHEMA_CACHE_LIMIT:
                self._schemas.popitem(last=False)
            return schema

    def _require_graph(self, name: str) -> None:
        """Raise when the tenant database has no AGE graph called ``name``."""
        with self._conn_lock:
            try:
                with self.client.cursor() as cur:
                    cur.execute('SELECT 1 FROM ag_catalog.ag_graph WHERE name = %s', (name,))
                    graph_exists = cur.fetchone() is not None
                self.client.commit()
            except Exception:
                self.client.rollback()
                raise
        if not graph_exists:
            # The provisioner creates the default graph in every tenant
            # database. Any other name must already exist: the node never
            # creates a graph itself.
            raise RuntimeError(
                f'AGE graph {name!r} does not exist in the tenant database. '
                f'Every RocketRide database comes with the {DEFAULT_GRAPH_NAME!r} graph; use it, '
                f"or create this one first (SELECT create_graph('{name}'))."
            )

    # ------------------------------------------------------------------
    # Query paths — everything routes through the translation layer
    # ------------------------------------------------------------------

    def read_row_cap(self, settings: Mapping) -> int:
        """Row ceiling of this call's safe read path (its ``max_rows``)."""
        return max_rows(settings)

    def _translate(
        self,
        query: str,
        params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        mode: TranslateMode = TranslateMode.SAFE,
        *,
        graph: str,
        timeout_ms: int,
    ) -> TranslatedQuery:
        """Translate Cypher for ``graph``, with ``timeout_ms`` as the plan's statement timeout."""
        return translate(
            query,
            params=params,
            limit=limit,
            mode=mode,
            graph_name=graph,
            age_version=self.age_version or DEFAULT_AGE_VERSION,
            firewall=FirewallConfig(statement_timeout_ms=timeout_ms),
        )

    def _require_transactional_client(self) -> None:
        """Shared precondition for every transaction-opening path.

        Both server-side controls (``SET TRANSACTION READ ONLY`` and the
        plan's ``SET LOCAL statement_timeout``) are silent no-ops outside a
        transaction. They hold because psycopg2 opens one implicitly on the
        first execute — which requires autocommit off. Assert the
        precondition so a future change fails loudly instead of quietly
        dropping the write protection and the timeout cap.
        """
        if self.client is None:
            raise RuntimeError('Database connection is not initialized')
        if self.client.autocommit:
            raise RuntimeError(
                'rocketride_graph requires autocommit=False: READ ONLY and SET LOCAL '
                'statement_timeout only apply inside a transaction'
            )

    def _execute_plan(
        self, plan: TranslatedQuery, fetch_cap: Optional[int] = None, max_rows: Optional[int] = None
    ) -> List[Tuple]:
        """Run one translated plan in its own transaction; return raw rows.

        The plan's READ ONLY flag is applied with ``SET TRANSACTION READ
        ONLY`` as the first in-transaction statement (psycopg2 has already
        opened the transaction), giving server-side write protection on the
        safe path.

        Args:
            plan (TranslatedQuery): The statements to run, in order.
            fetch_cap (Optional[int]): Most rows to fetch from the result statement.
            max_rows (Optional[int]): Row ceiling checked BEFORE commit, so a
                write whose result exceeds it is rolled back, not half-reported.

        Returns:
            List[Tuple]: Raw rows of the statement at ``plan.result_index``.

        Raises:
            ValueError: More than ``max_rows`` rows came back (nothing is committed).
        """
        self._require_transactional_client()
        rows: List[Tuple] = []
        # The whole transaction under the connection lock: no other binding
        # may commit or roll it back before the row cap below is checked.
        with self._conn_lock:
            try:
                with self.client.cursor() as cur:
                    if plan.read_only:
                        cur.execute('SET TRANSACTION READ ONLY')
                    for i, (stmt, binds) in enumerate(zip(plan.statements, plan.binds)):
                        if i == plan.result_index and plan.prepared_name:
                            self._execute_prepared(cur, plan.prepared_name, stmt, binds)
                        else:
                            cur.execute(stmt, binds or None)
                        if i == plan.result_index and cur.description is not None:
                            rows = cur.fetchmany(fetch_cap) if fetch_cap else cur.fetchall()
                # Checked after the plan's DEALLOCATE has run, but before commit.
                if max_rows is not None and len(rows) > max_rows:
                    raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')
                self.client.commit()
            except Exception:
                self.client.rollback()
                raise
        return rows

    @staticmethod
    def _execute_prepared(cur, name: str, stmt: str, binds: Tuple) -> None:
        """Run a plan's EXECUTE, freeing its prepared statement if it fails.

        A prepared statement is a session object that survives ROLLBACK, and
        the plan's own DEALLOCATE never runs after a failed EXECUTE. It is
        freed here, inside the same transaction: under a transaction pooler
        the next transaction may run on another backend.

        Args:
            cur: Open psycopg2 cursor inside the plan's transaction.
            name (str): The prepared statement name (generated by the emitter).
            stmt (str): The ``EXECUTE`` statement.
            binds (Tuple): Its bind values.
        """
        cur.execute('SAVEPOINT rr_age_execute')
        try:
            cur.execute(stmt, binds or None)
        except Exception:
            cur.execute('ROLLBACK TO SAVEPOINT rr_age_execute')
            cur.execute(f'DEALLOCATE {name}')
            raise

    def _run_query(
        self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None, *, settings: Mapping
    ) -> List[Dict]:
        """Read-only path: translate (safe mode) and run in a READ ONLY txn."""
        row_cap = max_rows(settings)
        cap = row_cap if limit is None else min(int(limit), row_cap) + 1
        plan = self._translate(
            query,
            params=params,
            limit=cap,
            mode=TranslateMode.SAFE,
            graph=graph_name(settings),
            timeout_ms=query_timeout_ms(settings),
        )
        raw_rows = self._execute_plan(plan, fetch_cap=cap)
        return [decode_row(plan, row) for row in raw_rows]

    def _run_query_raw(
        self, query: str, params: Optional[Dict[str, Any]] = None, *, settings: Mapping
    ) -> Dict[str, Any]:
        """EXECUTE path: translation still applies (AGE can't run bare Cypher);
        only the semantic firewall is skipped, never the resource caps.

        ``params`` binds ``$name`` values through the plan's prepared
        statement, so they skip the parser and the query-length cap (they
        have their own size cap, ``max_params_bytes``). ``settings`` is the
        calling instance's ``self.settings``.
        """
        plan = self._translate(
            query,
            params=params,
            mode=TranslateMode.RAW,
            graph=graph_name(settings),
            timeout_ms=query_timeout_ms(settings),
        )
        row_cap = max_execute_rows(settings)
        raw_rows = self._execute_plan(plan, fetch_cap=row_cap + 1, max_rows=row_cap)
        rows = [decode_row(plan, row) for row in raw_rows]
        # AGE exposes no write counters (unlike Bolt); affected_rows reports
        # the result-row count — 0 for writes without a RETURN clause.
        return {'rows': rows, 'affected_rows': len(rows)}

    def _validate_query(self, query: str, *, settings: Mapping) -> Tuple[bool, str]:
        """EXPLAIN the translated statement without executing it.

        Translation errors (syntax, firewall, capability) surface here too, so
        the LLM repair loop receives the layer's actionable messages.
        """
        try:
            plan = self._translate(
                query,
                mode=TranslateMode.SAFE,
                graph=graph_name(settings),
                timeout_ms=query_timeout_ms(settings),
            )
        except AgeTranslationError as e:
            return False, str(e)

        # Same precondition as _execute_plan (this method opens an identical
        # READ ONLY + SET LOCAL transaction), folded into this method's
        # return-a-message contract.
        try:
            self._require_transactional_client()
        except RuntimeError as e:
            return False, str(e)
        with self._conn_lock:
            try:
                with self.client.cursor() as cur:
                    cur.execute('SET TRANSACTION READ ONLY')
                    for i, (stmt, binds) in enumerate(zip(plan.statements, plan.binds)):
                        if i == plan.result_index:
                            cur.execute('EXPLAIN ' + stmt, binds or None)
                            break
                        cur.execute(stmt, binds or None)
                self.client.rollback()
                return True, ''
            except Exception as e:
                self.client.rollback()
                return False, str(e)

    # ------------------------------------------------------------------
    # Schema reflection — AGE catalog + bounded sampling
    # ------------------------------------------------------------------

    def _reflect_schema(self, graph: Optional[str] = None) -> Dict[str, Any]:
        """Labels of ``graph`` from ``ag_catalog.ag_label``; property types by sampling.

        Best-effort by contract: any failure warns and degrades to a partial
        (or empty) schema rather than blocking startup.
        """
        schema: Dict[str, Any] = {'nodes': {}, 'relationships': []}
        if self.client is None:
            return schema

        try:
            with self._conn_lock:
                try:
                    with self.client.cursor() as cur:
                        cur.execute(
                            'SELECT l.name, l.kind FROM ag_catalog.ag_label l '
                            'JOIN ag_catalog.ag_graph g ON l.graph = g.graphid '
                            "WHERE g.name = %s AND l.name NOT LIKE '\\_ag\\_%%'",
                            (graph,),
                        )
                        labels = cur.fetchall()
                    self.client.commit()
                except Exception:
                    self.client.rollback()
                    raise
        except Exception as e:
            warning(f'rocketride_graph: unable to list graph labels: {e}')
            return schema

        vertex_labels = [name for name, kind in labels if kind == 'v'][:SCHEMA_LABEL_LIMIT]
        edge_labels = [name for name, kind in labels if kind == 'e'][:SCHEMA_REL_LIMIT]

        for label in vertex_labels:
            schema['nodes'][label] = self._sample_properties(graph, label)

        for etype in edge_labels:
            start, end = self._sample_edge_endpoints(graph, etype)
            schema['relationships'].append({'type': etype, 'start': start, 'end': end})

        return schema

    def _sample_properties(self, graph: str, label: str) -> List[Tuple[str, str]]:
        """One-row property sample from the label's backing table in ``graph``."""
        try:
            with self._conn_lock:
                try:
                    with self.client.cursor() as cur:
                        cur.execute(sql.SQL('SELECT properties FROM {} LIMIT 1').format(sql.Identifier(graph, label)))
                        row = cur.fetchone()
                    self.client.commit()
                except Exception:
                    self.client.rollback()
                    raise
        except Exception as e:
            warning(f'rocketride_graph: unable to sample label {label!r}: {e}')
            return []
        if row is None:
            return []
        properties = decode_agtype(row[0]) or {}
        return [(key, type(value).__name__) for key, value in properties.items()]

    def _sample_edge_endpoints(self, graph: str, etype: str) -> Tuple[str, str]:
        """Start/end labels for one sampled edge of the given type in ``graph``."""
        # The one Cypher string the node assembles itself, so hold the label
        # to the same identifier rule the layer applies to graph names: AGE
        # allows backtick-quoted labels with arbitrary characters, and those
        # must not be spliced into query text.
        if not VALID_LABEL.fullmatch(etype or ''):
            warning(f'rocketride_graph: skipping relationship sample for non-identifier label {etype!r}')
            return '', ''
        try:
            plan = self._translate(
                f'MATCH (a)-[r:{etype}]->(b) RETURN label(a) AS s, label(b) AS e',
                limit=1,
                mode=TranslateMode.SAFE,
                graph=graph,
                # Reflection is the node's own query: the default timeout, not a caller's
                timeout_ms=DEFAULT_QUERY_TIMEOUT_MS,
            )
            raw = self._execute_plan(plan, fetch_cap=1)
        except Exception as e:
            warning(f'rocketride_graph: unable to sample relationship {etype!r}: {e}')
            return '', ''
        if not raw:
            return '', ''
        row = decode_row(plan, raw[0])
        return str(row.get('s') or ''), str(row.get('e') or '')
