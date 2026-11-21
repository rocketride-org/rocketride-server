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

The IGlobal keeps what is expensive and the same for every call of the control:
the driver and the reflected schema (a cache). Everything a caller may set per
call (the description, the gates, the row caps, the retry budget) is a
parameter: the instance reads it from ``self.settings`` and hands that view to
the query hooks below, so one control serves calls with different values
without rebuilding anything (plan 4.1 rule 4).

A concrete node implements the abstract hooks below and nothing else. See
``nodes/src/nodes/graph_falkordb/IGlobal.py`` for a worked example.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Mapping, Optional, Tuple

from rocketlib import IGlobalBase, debug, warning

from ai.common.utils import config_int, parse_bool

DEFAULT_MAX_EXECUTE_ROWS = 25000
DEFAULT_MAX_VALIDATION_ATTEMPTS = 5


# =============================================================================
# The per-call values every graph node shares, read from a call's settings
# =============================================================================


def graph_description(settings: Mapping) -> str:
    """Return the user-written description of what this graph holds, for the LLM prompt.

    Args:
        settings: The call's settings (``IInstance.settings``).

    Returns:
        str: The description, or an empty string.
    """
    return str(settings.get('db_description') or '')


def max_validation_attempts(settings: Mapping) -> int:
    """Return how many times this call may re-ask the LLM after a rejected query.

    Args:
        settings: The call's settings (``IInstance.settings``).

    Returns:
        int: Between 1 and 10.
    """
    return config_int(settings, 'max_attempts', DEFAULT_MAX_VALIDATION_ATTEMPTS, min_value=1, max_value=10)


def allow_execute(settings: Mapping) -> bool:
    """Return whether this call may run raw statements.

    EXECUTE bypasses LLM translation and the read-only gate, so it is opt-in.

    Args:
        settings: The call's settings (``IInstance.settings``).

    Returns:
        bool: True when the EXECUTE path is on.
    """
    return parse_bool(settings.get('allow_execute'))


def max_execute_rows(settings: Mapping) -> int:
    """Return the row ceiling of this call's EXECUTE path.

    Args:
        settings: The call's settings (``IInstance.settings``).

    Returns:
        int: Between 1 and ``DEFAULT_MAX_EXECUTE_ROWS``.
    """
    return config_int(
        settings, 'max_execute_rows', DEFAULT_MAX_EXECUTE_ROWS, min_value=1, max_value=DEFAULT_MAX_EXECUTE_ROWS
    )


class GraphGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any graph database node."""

    # Cached graph schema, in the shape the LLM prompt expects:
    #   {'nodes': {label: [(property, type), ...]},
    #    'relationships': [{'type': ..., 'start': ..., 'end': ...}, ...]}
    graph_schema: Dict[str, Any]

    # True when the control has ONE graph, fixed by its config, so beginGlobal
    # reflects it once. A driver whose graph is a per-call parameter sets False
    # and serves ``schema_for`` from its own bounded cache keyed by graph name.
    reflect_at_start: bool = True
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

    @abstractmethod
    def _reflect_schema(self, graph: Optional[str] = None) -> Dict[str, Any]:
        """Return the graph schema: node labels with properties, and relationships.

        ``graph`` names the graph to reflect on a driver whose graph is a
        per-call parameter; it is None on a driver with one graph per control.

        Shape:
            {'nodes': {'Person': [('name', 'STRING'), ...]},
             'relationships': [{'type': 'KNOWS', 'start': 'Person', 'end': 'Person'}]}

        Reflection is best-effort: return whatever the engine exposes and warn on
        failure rather than raising — a missing schema degrades the generated
        query, it does not break the node.
        """

    @abstractmethod
    def _run_query(
        self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None, *, settings: Mapping
    ) -> List[Dict]:
        """Execute a read-only query and return rows as plain JSON-safe dicts.

        ``settings`` is the calling instance's ``self.settings``: the driver
        reads its per-call values (row cap, timeout, graph) from it.

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
        driver applies its own default cap (``read_row_cap(settings)``).
        """

    @abstractmethod
    def _run_query_raw(self, query: str, *, settings: Mapping) -> Dict[str, Any]:
        """Execute a raw statement with no safety gate (the EXECUTE path).

        Returns ``{'rows': [...], 'affected_rows': N}``, mirroring the SQL side.
        Only reachable when the call's settings carry ``allow_execute``. The
        statement runs in ONE transaction that ends before this returns
        (commit on success, rollback on error): nothing stays open between
        calls, since the next call may land on another replica (plan 4.1
        rule 3). Must return
        at most ``max_execute_rows(settings)`` rows. A driver whose client streams the
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
    def _validate_query(self, query: str, *, settings: Mapping) -> Tuple[bool, str]:
        """Check a generated query without executing it (EXPLAIN).

        ``settings`` is the calling instance's ``self.settings``.

        Returns ``(True, '')`` when the engine accepts it, or ``(False, error)``.
        The error string is fed back to the LLM so it can repair its own query.
        """

    # ------------------------------------------------------------------
    # Driver-tunable defaults
    # ------------------------------------------------------------------

    def read_row_cap(self, settings: Mapping) -> int:
        """Hard ceiling on rows a natural-language read query of this call may return.

        Drivers with their own row-cap key (FalkorDB's ``max_rows``) override
        this to expose that cap, so ``get_data`` can clamp the caller's ``limit``
        to it and report ``truncated`` honestly. The default lets any limit the
        base already clamped through unchanged.

        Args:
            settings: The calling instance's ``self.settings``.

        Returns:
            int: The row ceiling.
        """
        return max_execute_rows(settings)

    def schema_for(self, settings: Mapping) -> Dict[str, Any]:
        """Return the cached schema of the graph this call addresses.

        The default serves the one graph the control's config names, reflected
        in ``beginGlobal``. A driver whose graph is a parameter overrides this
        with a bounded cache keyed by graph name.

        Args:
            settings: The calling instance's ``self.settings``.

        Returns:
            Dict[str, Any]: ``{'nodes': {...}, 'relationships': [...]}``.
        """
        return self.graph_schema

    # ------------------------------------------------------------------
    # Lifecycle — identical across graph engines
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Open the driver and cache the graph schema.

        Only the control's config is read here: every parameter (description,
        gates, caps, budgets) is per call and reaches the hooks as ``settings``.
        """
        self.graph_schema = {'nodes': {}, 'relationships': []}

        # Step 1: open the driver on the control's config
        self._open_driver(self.config)

        # Step 2: a driver whose graph is per call reflects on first use instead
        if not self.reflect_at_start:
            debug(f'{self.config.node.provider}: connected; the schema is reflected per graph on first use')
            return

        # Reflection is a convenience for the LLM prompt, not a prerequisite for a
        # working connection — a driver bug here must not take down a live node.
        try:
            self.graph_schema = self._reflect_schema()
        except Exception as e:
            warning(f'{self.config.node.provider}: schema reflection failed, continuing without it: {e}')
            self.graph_schema = {'nodes': {}, 'relationships': []}
        labels = len(self.graph_schema.get('nodes', {}))
        rels = len(self.graph_schema.get('relationships', []))
        debug(f'{self.config.node.provider}: connected; schema has {labels} label(s), {rels} relationship type(s)')

    def endGlobal(self) -> None:
        """Close the driver, swallowing teardown errors."""
        try:
            self._close_driver()
        except Exception as e:
            warning(f'{self.config.node.provider}: error closing driver: {e}')

    def validateConfig(self) -> None:
        """Save-time validation: probe the server so the user sees errors immediately."""
        try:
            # The stored values, parameters included: a save-time probe checks
            # what the form holds, which no call has overridden yet.
            self._probe_connection(self._resolved())
        except Exception as e:
            warning(str(e))
