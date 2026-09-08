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

1. **Connection** — no host/user/password config; the per-tenant DSN comes
   from the account layer (``ai.common.rocketride_db``), same seam as
   ``rocketride_sql`` / ``rocketride_vector``. The tenant database is
   Postgres + Apache AGE.
2. **Query paths** — Apache AGE cannot run bare Cypher, so ``_run_query``
   (safe), ``_run_query_raw`` (EXECUTE) and ``_validate_query`` all route
   through the Cypher->AGE translation layer (``ai.common.graph.age``).

Session discipline: the cloud endpoint is a transaction-mode pooler, so every
query runs inside one transaction whose settings are ``SET LOCAL`` only (the
translated plan carries them). The safe path additionally makes its
transaction ``READ ONLY`` — server-side write protection, with the base's
``is_cypher_safe`` regex and the layer's semantic firewall as defence-in-depth.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
from psycopg2 import sql

from rocketlib import warning
from ai.common.graph import GraphGlobalBase
from ai.common.graph.age import (
    AgeTranslationError,
    FirewallConfig,
    TranslateMode,
    TranslatedQuery,
    decode_agtype,
    decode_row,
    translate,
)
from ai.common.rocketride_db import resolve_rocketride_dsn

DEFAULT_GRAPH_NAME = 'rocketride'
DEFAULT_MAX_ROWS = 1000
DEFAULT_QUERY_TIMEOUT_MS = 30000

# Reflection fan-out bounds (mirrors graph_falkordb's sampling posture).
SCHEMA_LABEL_LIMIT = 200
SCHEMA_REL_LIMIT = 100

# Same identifier rule the translation layer applies to graph names — labels
# interpolated into Cypher text must conform (see _sample_edge_endpoints).
VALID_LABEL = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


class IGlobal(GraphGlobalBase):
    """Postgres + Apache AGE global for the RocketRide cloud graph node."""

    client = None
    graph_name: str = DEFAULT_GRAPH_NAME
    max_rows: int = DEFAULT_MAX_ROWS
    query_timeout_ms: int = DEFAULT_QUERY_TIMEOUT_MS
    age_version: str = ''

    # ------------------------------------------------------------------
    # Driver lifecycle
    # ------------------------------------------------------------------

    def _open_driver(self, config: Dict[str, Any]) -> None:
        """Resolve the tenant DSN, connect, and fail fast on a missing graph."""
        self.graph_name = str(config.get('graph') or DEFAULT_GRAPH_NAME).strip()
        self.max_rows = self._config_int(config, 'max_rows', DEFAULT_MAX_ROWS)
        self.query_timeout_ms = self._config_int(config, 'query_timeout_ms', DEFAULT_QUERY_TIMEOUT_MS)

        # The one RocketRide difference: DSN from the account seam, no config.
        dsn = resolve_rocketride_dsn()
        # Bounded connect so an unreachable pooler fails fast (matches the
        # probe's 3s timeout) instead of waiting out the OS TCP timeout.
        self.client = psycopg2.connect(dsn, connect_timeout=3)

        # Fail-fast round-trip: AGE present + the tenant graph exists.
        with self.client.cursor() as cur:
            cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'age'")
            row = cur.fetchone()
            if row is None:
                raise RuntimeError('The tenant database does not have the Apache AGE extension installed')
            self.age_version = row[0]
            cur.execute('SELECT 1 FROM ag_catalog.ag_graph WHERE name = %s', (self.graph_name,))
            graph_exists = cur.fetchone() is not None
        self.client.commit()

        if not graph_exists:
            # OPEN QUESTION (create_graph ownership, see the node README and
            # the design's open-questions): whether the node or the cloud
            # provisioner creates the per-tenant graph is undecided. Until it
            # is, the node refuses to run against a missing graph rather than
            # silently creating one.
            raise RuntimeError(
                f'AGE graph {self.graph_name!r} does not exist in the tenant database. '
                'Graph provisioning ownership is pending; create the graph '
                f"(SELECT create_graph('{self.graph_name}')) or configure an existing one."
            )

    def _close_driver(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = None

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time probe: warn-only (the user is still editing the node)."""
        conn = None
        try:
            dsn = resolve_rocketride_dsn()
            conn = psycopg2.connect(dsn, connect_timeout=3)
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
        except NotImplementedError as e:
            # The OSS account stub: no cloud sign-in available.
            warning(str(e))
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
            age_version=self.age_version or '1.5.0',
            firewall=self._firewall_config(),
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

    def _execute_plan(self, plan: TranslatedQuery, fetch_cap: Optional[int] = None) -> List[Tuple]:
        """Run one translated plan in its own transaction; return raw rows.

        The plan's READ ONLY flag is applied with ``SET TRANSACTION READ
        ONLY`` as the first in-transaction statement (psycopg2 has already
        opened the transaction), giving server-side write protection on the
        safe path.
        """
        self._require_transactional_client()
        rows: List[Tuple] = []
        try:
            with self.client.cursor() as cur:
                if plan.read_only:
                    cur.execute('SET TRANSACTION READ ONLY')
                for i, (stmt, binds) in enumerate(zip(plan.statements, plan.binds)):
                    cur.execute(stmt, binds or None)
                    if i == plan.result_index and cur.description is not None:
                        rows = cur.fetchmany(fetch_cap) if fetch_cap else cur.fetchall()
            self.client.commit()
        except Exception:
            self.client.rollback()
            raise
        return rows

    def _run_query(self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None) -> List[Dict]:
        """Read-only path: translate (safe mode) and run in a READ ONLY txn."""
        cap = self.read_row_cap if limit is None else min(int(limit), self.read_row_cap) + 1
        plan = self._translate(query, params=params, limit=cap, mode=TranslateMode.SAFE)
        raw_rows = self._execute_plan(plan, fetch_cap=cap)
        return [decode_row(plan, row) for row in raw_rows]

    def _run_query_raw(self, query: str) -> Dict[str, Any]:
        """EXECUTE path: translation still applies (AGE can't run bare Cypher);
        only the semantic firewall is skipped, never the resource caps.
        """
        plan = self._translate(query, mode=TranslateMode.RAW)
        max_rows = self.max_execute_rows
        raw_rows = self._execute_plan(plan, fetch_cap=max_rows + 1)
        if len(raw_rows) > max_rows:
            raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')
        rows = [decode_row(plan, row) for row in raw_rows]
        # AGE exposes no write counters (unlike Bolt); affected_rows reports
        # the result-row count — 0 for writes without a RETURN clause.
        return {'rows': rows, 'affected_rows': len(rows)}

    def _validate_query(self, query: str) -> Tuple[bool, str]:
        """EXPLAIN the translated statement without executing it.

        Translation errors (syntax, firewall, capability) surface here too, so
        the LLM repair loop receives the layer's actionable messages.
        """
        try:
            plan = self._translate(query, mode=TranslateMode.SAFE)
        except AgeTranslationError as e:
            return False, str(e)
        # Same precondition as _execute_plan (this method opens an identical
        # READ ONLY + SET LOCAL transaction), folded into this method's
        # return-a-message contract.
        try:
            self._require_transactional_client()
        except RuntimeError as e:
            return False, str(e)
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

    def _reflect_schema(self) -> Dict[str, Any]:
        """Labels from ``ag_catalog.ag_label``; property types by sampling.

        Best-effort by contract: any failure warns and degrades to a partial
        (or empty) schema rather than blocking startup.
        """
        schema: Dict[str, Any] = {'nodes': {}, 'relationships': []}
        if self.client is None:
            return schema

        try:
            with self.client.cursor() as cur:
                cur.execute(
                    'SELECT l.name, l.kind FROM ag_catalog.ag_label l '
                    'JOIN ag_catalog.ag_graph g ON l.graph = g.graphid '
                    "WHERE g.name = %s AND l.name NOT LIKE '\\_ag\\_%%'",
                    (self.graph_name,),
                )
                labels = cur.fetchall()
            self.client.commit()
        except Exception as e:
            self.client.rollback()
            warning(f'rocketride_graph: unable to list graph labels: {e}')
            return schema

        vertex_labels = [name for name, kind in labels if kind == 'v'][:SCHEMA_LABEL_LIMIT]
        edge_labels = [name for name, kind in labels if kind == 'e'][:SCHEMA_REL_LIMIT]

        for label in vertex_labels:
            schema['nodes'][label] = self._sample_properties(label)

        for etype in edge_labels:
            start, end = self._sample_edge_endpoints(etype)
            schema['relationships'].append({'type': etype, 'start': start, 'end': end})

        return schema

    def _sample_properties(self, label: str) -> List[Tuple[str, str]]:
        """One-row property sample from the label's backing table."""
        try:
            with self.client.cursor() as cur:
                cur.execute(sql.SQL('SELECT properties FROM {} LIMIT 1').format(sql.Identifier(self.graph_name, label)))
                row = cur.fetchone()
            self.client.commit()
        except Exception as e:
            self.client.rollback()
            warning(f'rocketride_graph: unable to sample label {label!r}: {e}')
            return []
        if row is None:
            return []
        properties = decode_agtype(row[0]) or {}
        return [(key, type(value).__name__) for key, value in properties.items()]

    def _sample_edge_endpoints(self, etype: str) -> Tuple[str, str]:
        """Start/end labels for one sampled edge of the given type."""
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
            )
            raw = self._execute_plan(plan, fetch_cap=1)
        except Exception as e:
            warning(f'rocketride_graph: unable to sample relationship {etype!r}: {e}')
            return '', ''
        if not raw:
            return '', ''
        row = decode_row(plan, raw[0])
        return str(row.get('s') or ''), str(row.get('e') or '')

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _config_int(config: Dict[str, Any], key: str, default: int) -> int:
        try:
            return max(1, int(config.get(key, default)))
        except (TypeError, ValueError):
            return default
