# =============================================================================
# RocketRide Engine
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

"""Abstract IGlobal layer shared by every graph database node.

Graph engines differ in transport (Bolt, Redis protocol, HTTP) and in whether
they can refuse writes server-side, but they share a lifecycle: open a driver,
prove the connection works, reflect the schema, and hand a small query surface
to the IInstance layer. That lifecycle lives here; the transport lives in the
driver.

A concrete node implements the abstract hooks below and nothing else. See
``nodes/src/nodes/graph_falkordb/IGlobal.py`` for a worked example.
"""

from __future__ import annotations

import copy
import threading
import time

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from rocketlib import IGlobalBase, debug, warning

from ai.common.config import Config
from ai.common.utils import config_int, parse_bool

from .graph_errors import GraphToolError, driver_detail
from .schema import SCHEMA_REFRESH_BUDGET_MS, SchemaBuilder, empty_block, legacy_from_block

DEFAULT_MAX_EXECUTE_ROWS = 25000
DEFAULT_MAX_VALIDATION_ATTEMPTS = 5
# read_query: default page and the absolute ceiling ("All" in the app means the
# node's own cap, never unlimited).
DEFAULT_READ_QUERY_LIMIT = 1000
READ_QUERY_HARD_CAP = 25000
DEFAULT_STATEMENT_TIMEOUT_MS = 30000

# consume(columns, rows) -> envelope; rows yields positional driver rows.
RowConsumer = Callable[[List[str], Iterable[Sequence[Any]]], Dict[str, Any]]


class GraphGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any graph database node."""

    # Published schema state: (v2 block or None, legacy dict). Replaced as one
    # tuple so readers never see a v2 block and a legacy dict from different
    # refreshes. See the graph_schema / schema_snapshot properties.
    _schema_state: Tuple[Optional[Dict[str, Any]], Dict[str, Any]] = (None, {'nodes': {}, 'relationships': []})
    _schema_lock: Optional[threading.Lock] = None

    # Common config, resolved in beginGlobal and read by GraphInstanceBase.
    db_description: str = ''
    max_validation_attempts: int = DEFAULT_MAX_VALIDATION_ATTEMPTS
    allow_execute: bool = False
    max_execute_rows: int = DEFAULT_MAX_EXECUTE_ROWS
    # True when _run_query_raw accepts a ``params`` keyword: the execute tool
    # then binds ``$name`` values instead of refusing them.
    supports_execute_params: bool = False

    # ------------------------------------------------------------------
    # Abstract interface — every graph driver must implement these
    # ------------------------------------------------------------------

    @abstractmethod
    def _open_driver(self, config: Dict[str, Any]) -> None:
        """Open the client/driver and fail fast if the server is unreachable.

        Must raise on bad host, credentials or database name, so a broken
        connection surfaces at pipeline start rather than on the first query.
        """

    @abstractmethod
    def _close_driver(self) -> None:
        """Close the client/driver. Called once at pipeline teardown."""

    @abstractmethod
    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time connectivity probe. Report problems with ``warning()``.

        Must not raise: this runs while the user is still editing the node, so
        a wrong password should produce a readable warning, not a stack trace.
        """

    def _reflect_schema(self) -> Dict[str, Any]:
        """Return the legacy graph schema the LLM prompt uses.

        Shape:
            {'nodes': {'Person': [('name', 'string'), ...]},
             'relationships': [{'type': 'KNOWS', 'start': 'Person', 'end': 'Person'}]}

        Drivers implement :meth:`_reflect_schema_v2`; this derives the legacy
        shape from it. A driver without v2 reflection overrides this instead.
        """
        builder = SchemaBuilder()
        self._reflect_schema_v2(builder, time.monotonic() + SCHEMA_REFRESH_BUDGET_MS / 1000.0)
        return legacy_from_block(builder.block(source='refresh'))

    def _reflect_schema_v2(self, builder: SchemaBuilder, deadline: float) -> None:
        """Fill ``builder`` with labels, relationship types, endpoints and property types.

        Every query must be bounded (server-side deadline no later than
        ``deadline``, a ``time.monotonic()`` value) and the work must be bounded
        (label/type/sample limits; set ``builder.truncated`` when a limit cut
        the listing). Raise on ANY failure or timeout: the caller keeps the
        last good snapshot rather than publishing part of a schema.
        """
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Schema snapshot (get_schema / refresh_schema)
    # ------------------------------------------------------------------

    @property
    def graph_schema(self) -> Dict[str, Any]:
        """Legacy schema (LLM prompt, legacy get_schema keys) of the published snapshot."""
        return self._schema_state[1]

    @graph_schema.setter
    def graph_schema(self, value: Dict[str, Any]) -> None:
        self._schema_state = (self._schema_state[0], value)

    @property
    def schema_snapshot(self) -> Optional[Dict[str, Any]]:
        """A private copy of the published schema v2 block (None before the first reflection)."""
        block = self._schema_state[0]
        return copy.deepcopy(block) if block is not None else None

    @property
    def supports_schema_v2(self) -> bool:
        return type(self)._reflect_schema_v2 is not GraphGlobalBase._reflect_schema_v2

    def refresh_schema_snapshot(self, source: str = 'refresh') -> Dict[str, Any]:
        """Reflect the schema and publish it all-or-nothing; return the published block.

        Refreshes on one node are serialized. On failure (including a timeout)
        the previous snapshot stays published, marked ``stale`` with the error;
        if there never was one, an empty block carries the error, so a failed
        read is never presented as an empty graph.
        """
        if self._schema_lock is None:
            self._schema_lock = threading.Lock()
        budget_s = SCHEMA_REFRESH_BUDGET_MS / 1000.0
        if not self._schema_lock.acquire(timeout=budget_s + 5):
            raise GraphToolError('Schema refresh is busy', 'Another refresh of this node did not finish in time.')
        try:
            if not self.supports_schema_v2:
                block = empty_block(source=source, error=None, capable=False)
                self._schema_state = (block, self._schema_state[1])
                return copy.deepcopy(block)
            builder = SchemaBuilder()
            try:
                self._reflect_schema_v2(builder, time.monotonic() + budget_s)
                block = builder.block(source=source)
                self._schema_state = (block, legacy_from_block(block))
            except Exception as e:
                message = self._schema_error_text(e)
                previous = self._schema_state[0]
                if previous is not None and previous.get('refreshed_at'):
                    block = {**previous, 'stale': True, 'error': message}
                else:
                    block = empty_block(source=source, error=message)
                self._schema_state = (block, self._schema_state[1])
                node = getattr(getattr(self, 'glb', None), 'logicalType', 'graph node')
                warning(f'{node}: schema refresh failed: {message.splitlines()[0]}')
            return copy.deepcopy(block)
        finally:
            self._schema_lock.release()

    def _schema_error_text(self, exc: BaseException) -> str:
        if isinstance(exc, GraphToolError):
            return str(exc)
        described = None
        try:
            described = self._describe_error(exc)
        except Exception:
            described = None
        headline, detail = described or ('Schema refresh failed', driver_detail(exc))
        if headline == 'Query failed':
            headline = 'Schema refresh failed'
        return headline + (f'\n{detail}' if detail else '')

    def _prompt_rules(self) -> List[str]:
        """Engine/version-specific rules for the natural-language query prompt."""
        return []

    # ------------------------------------------------------------------
    # Identity for the dialect tool / connection card
    # ------------------------------------------------------------------

    def _engine_identity(self) -> Dict[str, Any]:
        """Safe, credential-free identity: engine name/version/edition, database, graph, read boundary.

        Never include hosts, URIs, users, DSNs or anything resolved from secrets.
        """
        return {
            'engine': {'name': '', 'version': None, 'edition': None},
            'database': None,
            'graph': None,
            'read_boundary': 'read_only_tx',
            'read_boundary_verified': False,
            'shortest_path': True,
            'server_result_cap': None,
        }

    @abstractmethod
    def _run_query(self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None) -> List[Dict]:
        """Execute a read-only query and return rows as plain JSON-safe dicts.

        Implementations MUST refuse writes. Prefer the engine's own read-only
        execution path over the ``is_cypher_safe`` regex, which is only
        defence-in-depth. FalkorDB's ``GRAPH.RO_QUERY`` is the implemented
        example; a Neo4j driver on this base should open sessions in READ access
        mode rather than lean on the regex.

        ``params`` carries bound values for ``$name`` placeholders — user data
        must never be interpolated into the query string.

        ``limit`` is the effective row limit the caller will slice against.
        When it is set, the implementation MUST return at most ``limit + 1``
        rows, so the caller can tell a full page apart from a truncated one
        (``len(rows) > limit``). When it is None (the pipeline-lane path), the
        driver applies its own default cap (``read_row_cap``).
        """

    @abstractmethod
    def _run_query_raw(self, query: str) -> Dict[str, Any]:
        """Execute a raw statement with no safety gate (the EXECUTE path).

        Returns ``{'rows': [...], 'affected_rows': N}``, mirroring the SQL side.
        Only reachable when the node owner sets ``allow_execute``. Must return
        at most ``max_execute_rows`` rows. A driver whose client streams the
        reply stops reading past the cap, which also bounds worker memory; a
        client that parses the whole reply first can only cut it afterwards,
        so there the cap bounds the result, not memory. On an
        engine with transactions, check the cap before commit, so a statement
        over it saves nothing and a retry cannot duplicate its writes. A
        statement the engine commits in batches on its own is outside that
        guarantee. On an engine with no rollback, a write over the cap is
        already saved: return the capped rows with ``'truncated': True`` rather
        than raise, so the caller does not retry it.

        A driver that sets ``supports_execute_params`` also accepts
        ``params: Optional[Dict]`` — bound values for ``$name`` placeholders.
        """

    @abstractmethod
    def _validate_query(self, query: str) -> Tuple[bool, str]:
        """Check a generated query without executing it (EXPLAIN).

        Returns ``(True, '')`` when the engine accepts it, or ``(False, error)``.
        The error string is fed back to the LLM so it can repair its own query.
        """

    # ------------------------------------------------------------------
    # Driver-tunable defaults
    # ------------------------------------------------------------------

    def _graph_description(self, config: Dict[str, Any]) -> str:
        """User-written description of what this graph holds, for the LLM prompt."""
        return str(config.get('db_description') or '')

    @property
    def read_query_cap(self) -> int:
        """Largest row limit ``read_query`` honours on this node (owner cap, hard ceiling 25,000)."""
        return max(1, min(int(self.read_row_cap), READ_QUERY_HARD_CAP))

    @property
    def execute_graph_cap(self) -> int:
        """Row limit ``execute(shape='graph')`` applies (``max_execute_rows`` unless the server cuts sooner)."""
        return max(1, int(self.max_execute_rows))

    @property
    def statement_timeout_ms(self) -> int:
        """Server-side deadline applied to every query the node runs for a caller.

        read_query, execute in either shape, get_data, the questions lane and
        any driver-specific query tool; ``dialect`` reports it (schema
        refreshes run within their own budget instead). A driver whose server
        caps per-query timeouts (FalkorDB's TIMEOUT_MAX) returns the clamped
        value and must send that on every one of those paths.
        """
        return DEFAULT_STATEMENT_TIMEOUT_MS

    # ------------------------------------------------------------------
    # read_query / execute(shape='graph') hooks — the three Cypher drivers
    # implement these; an engine without them reports that read_query is
    # not available rather than falling back to a writable path.
    # ------------------------------------------------------------------

    def _read_query_rows(
        self,
        cypher: str,
        params: Optional[Dict[str, Any]],
        fetch_limit: int,
        consume: RowConsumer,
    ) -> Dict[str, Any]:
        """Run ``cypher`` READ-ONLY and hand at most ``fetch_limit`` positional rows to ``consume``.

        Must be read-only whatever ``allow_execute`` (or a driver's own write
        flag) says, enforced by the engine where it can be (a read-only command,
        a read-only transaction or role), with lexical checks only as defence in
        depth. Must apply the server-side statement deadline. ``consume`` may be
        called more than once if the driver retries a read transaction.
        """
        raise NotImplementedError(f'{type(self).__name__} does not support read_query')

    def _raw_query_rows(self, cypher: str, fetch_limit: int, consume: RowConsumer) -> Tuple[Dict[str, Any], int]:
        """execute(shape='graph'): run ``cypher`` as written; return ``(consume(...), affected_rows)``.

        A driver that sets ``supports_execute_params`` also accepts
        ``params: Optional[Dict]`` here, as in :meth:`_run_query_raw`.
        """
        raise NotImplementedError(f'{type(self).__name__} does not support execute with shape "graph"')

    def _graph_adapter(self):
        """The :mod:`ai.common.graph.adapters` adapter for this driver's values."""
        return None

    def _describe_error(self, exc: BaseException) -> Optional[Tuple[str, str]]:
        """Map a driver exception to ``(headline, detail)``; None = generic 'Query failed'."""
        return None

    @property
    def read_row_cap(self) -> int:
        """Hard ceiling on rows a natural-language read query may return.

        Drivers with their own row-cap config (FalkorDB's ``max_rows``) override
        this to expose that cap, so ``get_data`` can clamp the caller's ``limit``
        to it and report ``truncated`` honestly. The default lets any limit the
        base already clamped through unchanged.
        """
        return self.max_execute_rows

    # ------------------------------------------------------------------
    # Lifecycle — identical across graph engines
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Resolve config, open the driver, and cache the graph schema."""
        self._schema_state = (None, {'nodes': {}, 'relationships': []})
        self._schema_lock = threading.Lock()

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.db_description = self._graph_description(config)
        self.max_validation_attempts = config_int(
            config,
            'max_attempts',
            DEFAULT_MAX_VALIDATION_ATTEMPTS,
            min_value=1,
            max_value=10,
        )
        # EXECUTE bypasses LLM translation and the read-only gate, so it is
        # opt-in per node.
        self.allow_execute = parse_bool(config.get('allow_execute'))
        self.max_execute_rows = config_int(
            config,
            'max_execute_rows',
            DEFAULT_MAX_EXECUTE_ROWS,
            min_value=1,
            max_value=DEFAULT_MAX_EXECUTE_ROWS,
        )

        self._open_driver(config)

        # Reflection is a convenience for the LLM prompt, not a prerequisite for a
        # working connection — a driver bug here must not take down a live node.
        # A failure is recorded in the snapshot (error, never "empty graph").
        if self.supports_schema_v2:
            self.refresh_schema_snapshot(source='startup')
        else:
            try:
                self.graph_schema = self._reflect_schema()
            except Exception as e:
                warning(f'{self.glb.logicalType}: schema reflection failed, continuing without it: {e}')
                self.graph_schema = {'nodes': {}, 'relationships': []}
        labels = len(self.graph_schema.get('nodes', {}))
        rels = len(self.graph_schema.get('relationships', []))
        debug(f'{self.glb.logicalType}: connected; schema has {labels} label(s), {rels} relationship type(s)')

    def endGlobal(self) -> None:
        """Close the driver, swallowing teardown errors."""
        try:
            self._close_driver()
        except Exception as e:
            warning(f'{self.glb.logicalType}: error closing driver: {e}')

    def validateConfig(self) -> None:
        """Save-time validation: probe the server so the user sees errors immediately."""
        try:
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self._probe_connection(config)
        except Exception as e:
            warning(str(e))
