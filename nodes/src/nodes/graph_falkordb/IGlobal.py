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

"""FalkorDB graph node — global (shared) connection state.

Thin driver over ``GraphGlobalBase``: it owns the FalkorDB client and the
Redis-protocol specifics (multi-graph selection, ``GRAPH.RO_QUERY``), and
inherits the lifecycle, config parsing, schema caching and LLM query loop
from the base class.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from redis.exceptions import RedisError

from rocketlib import OPEN_MODE, warning

from ai.common.graph import GraphGlobalBase
from ai.common.utils import config_int, parse_bool

from falkordb import FalkorDB

DEFAULT_PORT = 6379
DEFAULT_GRAPH = 'agent'
DEFAULT_TIMEOUT_MS = 30000
DEFAULT_ROW_CAP = 250

# FalkorDB has no db.schema.nodeTypeProperties(), so property names are read
# off one live node per label.
SCHEMA_SAMPLE_SIZE = 1
# Cap on distinct relationship patterns pulled during reflection.
SCHEMA_REL_LIMIT = 100
# Cap on labels sampled during reflection — one query per label, so bound the fan-out.
SCHEMA_LABEL_LIMIT = 200


class IGlobal(GraphGlobalBase):
    """FalkorDB-specific global connection state."""

    client: Optional[FalkorDB] = None

    graph_name: str = DEFAULT_GRAPH
    allow_writes: bool = False
    max_rows: int = 250
    query_timeout_ms: int = DEFAULT_TIMEOUT_MS

    def beginGlobal(self) -> None:
        # Config-mode opens the node for editing only; no server round-trip.
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        super().beginGlobal()

    # ------------------------------------------------------------------
    # Driver hooks
    # ------------------------------------------------------------------

    def _open_driver(self, config: Dict[str, Any]) -> None:
        """Create the FalkorDB client and fail fast on a bad host or credentials."""
        self.graph_name = str(config.get('graph') or DEFAULT_GRAPH).strip() or DEFAULT_GRAPH
        self.allow_writes = parse_bool(config.get('allow_writes'))
        self.max_rows = config_int(config, 'max_rows', DEFAULT_ROW_CAP, min_value=1, max_value=self.max_execute_rows)
        self.query_timeout_ms = config_int(
            config, 'query_timeout_ms', DEFAULT_TIMEOUT_MS, min_value=100, max_value=600000
        )

        self.client = FalkorDB(**self._client_kwargs(config))
        # Round-trip now so a wrong host or password fails at pipeline start
        # rather than on the first tool call.
        self.client.list_graphs()

    def _close_driver(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
            finally:
                self.client = None

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time probe: connect and list graphs, reporting failures as warnings."""
        host = str(config.get('host') or '').strip()
        if not host:
            warning('host is required')
            return

        client = None
        try:
            client = FalkorDB(**self._client_kwargs(config))
            client.list_graphs()
        except RedisError as e:
            warning(f'Could not connect to FalkorDB at {host}: {e}')
        except Exception as e:
            warning(str(e))
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    @property
    def read_row_cap(self) -> int:
        """Node-owner ceiling on rows a natural-language read query returns."""
        return self.max_rows

    def _run_query(self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None) -> List[Dict]:
        """Execute a read-only Cypher query through GRAPH.RO_QUERY.

        Read-only is enforced by the server, not by a regex: ro_query rejects
        write clauses even when a caller skips the client-side check.

        With ``limit`` set the caller wants truncation detection, so return one
        row past it (still bounded by ``max_rows``); with no limit (the lane
        path) fall back to the node's ``max_rows`` cap.
        """
        cap = self.max_rows if limit is None else min(int(limit), self.max_rows) + 1
        result = self.select_graph().ro_query(query, params=params or None, timeout=self.query_timeout_ms)
        return self._rows_as_dicts(result, cap=cap)

    def _run_query_raw(self, query: str) -> Dict[str, Any]:
        """Execute a raw statement with writes allowed (the EXECUTE path)."""
        max_rows = self.max_execute_rows
        result = self.select_graph().query(query, timeout=self.query_timeout_ms)

        rows = self._rows_as_dicts(result, cap=max_rows + 1)
        if len(rows) > max_rows:
            raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')

        # Count writes unconditionally: unlike SQL, a Cypher write commonly also
        # returns rows (CREATE (n) RETURN n), so `rows` being non-empty does not
        # mean nothing was written. _affected_rows is 0 for a pure read anyway.
        return {'rows': rows, 'affected_rows': _affected_rows(result)}

    def _validate_query(self, query: str) -> Tuple[bool, str]:
        """Check syntax with EXPLAIN without running the query."""
        try:
            self.select_graph().explain(query)
            return True, ''
        except RedisError as e:
            return False, str(e)
        except Exception as e:
            return False, str(e)

    def _reflect_schema(self) -> Dict[str, Any]:
        """Reflect labels with their properties, plus the relationship patterns in use."""
        schema: Dict[str, Any] = {'nodes': {}, 'relationships': []}

        try:
            graph = self.select_graph()

            # One sampling query per label, so bound the fan-out on a wide schema.
            for label in self._column(graph, 'CALL db.labels()')[:SCHEMA_LABEL_LIMIT]:
                schema['nodes'][label] = self._sample_properties(graph, label)

            result = graph.ro_query(
                'MATCH (a)-[r]->(b) '
                'RETURN DISTINCT labels(a)[0] AS start, type(r) AS type, labels(b)[0] AS end '
                f'LIMIT {SCHEMA_REL_LIMIT}',
                timeout=self.query_timeout_ms,
            )
            schema['relationships'] = [
                {'type': str(row[1] or ''), 'start': str(row[0] or ''), 'end': str(row[2] or '')}
                for row in (result.result_set or [])
                if row and len(row) >= 3 and row[1]
            ]

        except Exception as e:
            warning(f'FalkorDB schema reflection failed: {e}')

        return schema

    # ------------------------------------------------------------------
    # FalkorDB helpers
    # ------------------------------------------------------------------

    def select_graph(self, name: Optional[str] = None):
        """Return a graph handle by name, defaulting to the configured graph.

        FalkorDB hosts many graphs per server, so tools may target one by name.
        """
        if name is not None and (not isinstance(name, str) or not name.strip()):
            raise ValueError('"graph" must be a non-empty string when provided')
        return self.client.select_graph((name or self.graph_name).strip())

    def list_graphs(self) -> List[str]:
        """List the graph names that exist on this server."""
        return [str(g) for g in (self.client.list_graphs() or [])]

    def _sample_properties(self, graph, label: str) -> List[Tuple[str, str]]:
        """Read property names off one node of ``label``; FalkorDB has no schema catalog."""
        try:
            # The label is interpolated because Cypher has no parameter slot for
            # labels — it comes from db.labels(), never from user input.
            result = graph.ro_query(
                f'MATCH (n:`{label}`) RETURN properties(n) LIMIT {SCHEMA_SAMPLE_SIZE}',
                timeout=self.query_timeout_ms,
            )
            rows = result.result_set or []
            if not rows or not rows[0]:
                return []
            props = rows[0][0] or {}
            return [(str(key), _type_name(value)) for key, value in props.items()]
        except (RedisError, ValueError, TypeError):
            return []

    def _column(self, graph, cypher: str) -> List[str]:
        """Run a single-column procedure call and return its values as strings."""
        result = graph.ro_query(cypher, timeout=self.query_timeout_ms)
        return [str(row[0]) for row in (result.result_set or []) if row]

    @staticmethod
    def _client_kwargs(config: Dict[str, Any]) -> Dict[str, Any]:
        """Build the FalkorDB() kwargs from node config."""
        kwargs: Dict[str, Any] = {
            'host': str(config.get('host') or 'localhost').strip() or 'localhost',
            'port': config_int(config, 'port', DEFAULT_PORT, min_value=1, max_value=65535),
        }
        username = str(config.get('username') or '').strip()
        if username:
            kwargs['username'] = username
        # Do NOT strip the password — whitespace is valid in passwords.
        password = str(config.get('password') or '')
        if password:
            kwargs['password'] = password
        if parse_bool(config.get('tls')):
            kwargs['ssl'] = True
        return kwargs

    @staticmethod
    def _rows_as_dicts(result, *, cap: int) -> List[Dict]:
        """Convert a FalkorDB QueryResult into a capped list of column->value dicts."""
        columns = _header_names(getattr(result, 'header', None))
        rows = (result.result_set or [])[:cap]
        return [
            {(columns[i] if i < len(columns) else f'col{i}'): _serialize_value(cell) for i, cell in enumerate(row)}
            for row in rows
        ]


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _type_name(value: Any) -> str:
    """Map a sampled property value to a schema type name for the LLM prompt."""
    if isinstance(value, bool):
        return 'BOOLEAN'
    if isinstance(value, int):
        return 'INTEGER'
    if isinstance(value, float):
        return 'FLOAT'
    if isinstance(value, str):
        return 'STRING'
    if isinstance(value, (list, tuple)):
        return 'LIST'
    return 'ANY'


def _header_names(header) -> List[str]:
    """Extract column names from a QueryResult header ([type, name] pairs or strings)."""
    names = []
    for entry in header or []:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            names.append(str(entry[1]))
        else:
            names.append(str(entry))
    return names


def _affected_rows(result) -> int:
    """Sum the write counters of a QueryResult (CREATE/DELETE/SET return no rows)."""
    total = 0
    for attr in (
        'nodes_created',
        'nodes_deleted',
        'relationships_created',
        'relationships_deleted',
        'properties_set',
        'properties_removed',
        'labels_added',
        'indices_created',
    ):
        try:
            total += int(getattr(result, attr, 0) or 0)
        except (RedisError, ValueError, TypeError):
            continue
    return total


def _serialize_value(value):
    """Convert FalkorDB result cells (Node/Edge/Path/temporals) to plain JSON-safe data."""
    # Graph entities are duck-typed: falkordb.Node has labels+properties,
    # Edge has relation+src_node/dest_node, Path has nodes()/edges().
    if hasattr(value, 'labels') and hasattr(value, 'properties'):
        return {
            'id': getattr(value, 'id', None),
            'labels': list(value.labels or []),
            'properties': _serialize_value(value.properties),
        }
    if hasattr(value, 'relation') and hasattr(value, 'properties'):
        return {
            'id': getattr(value, 'id', None),
            'type': value.relation,
            'src': getattr(value, 'src_node', None),
            'dst': getattr(value, 'dest_node', None),
            'properties': _serialize_value(value.properties),
        }
    if hasattr(value, 'nodes') and hasattr(value, 'edges') and callable(getattr(value, 'nodes', None)):
        return {
            'nodes': [_serialize_value(n) for n in value.nodes()],
            'edges': [_serialize_value(e) for e in value.edges()],
        }
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
