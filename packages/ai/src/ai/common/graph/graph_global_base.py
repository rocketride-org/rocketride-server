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

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple

from rocketlib import IGlobalBase, debug, warning

from ai.common.config import Config
from ai.common.utils import config_int, parse_bool

DEFAULT_MAX_EXECUTE_ROWS = 25000
DEFAULT_MAX_VALIDATION_ATTEMPTS = 5


class GraphGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any graph database node."""

    # Cached graph schema, in the shape the LLM prompt expects:
    #   {'nodes': {label: [(property, type), ...]},
    #    'relationships': [{'type': ..., 'start': ..., 'end': ...}, ...]}
    graph_schema: Dict[str, Any]

    # Common config, resolved in beginGlobal and read by GraphInstanceBase.
    db_description: str = ''
    max_validation_attempts: int = DEFAULT_MAX_VALIDATION_ATTEMPTS
    allow_execute: bool = False
    max_execute_rows: int = DEFAULT_MAX_EXECUTE_ROWS

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

    @abstractmethod
    def _reflect_schema(self) -> Dict[str, Any]:
        """Return the graph schema: node labels with properties, and relationships.

        Shape:
            {'nodes': {'Person': [('name', 'STRING'), ...]},
             'relationships': [{'type': 'KNOWS', 'start': 'Person', 'end': 'Person'}]}

        Reflection is best-effort: return whatever the engine exposes and warn on
        failure rather than raising — a missing schema degrades the generated
        query, it does not break the node.
        """

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
        Only reachable when the node owner sets ``allow_execute``. Must cap rows
        at ``max_execute_rows`` so one query cannot exhaust worker memory.
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
        self.graph_schema = {'nodes': {}, 'relationships': []}

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
