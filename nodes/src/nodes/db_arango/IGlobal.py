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

"""
Global (connection-level) state for the ArangoDB database node.

Manages the python-arango client lifecycle, multi-model schema reflection, query
execution, and query validation. All ArangoDB-specific knowledge lives here —
IInstance calls these methods without knowing the underlying driver.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from arango import ArangoClient
from arango.exceptions import ArangoError, ServerConnectionError

from rocketlib import IGlobalBase, debug, error, warning
from ai.common.config import Config

from .utils import _is_aql_safe, _plan_is_modification

DEFAULT_MAX_EXECUTE_ROWS = 25000

# Map ArangoDB's numeric collection type codes to readable names.
_COLLECTION_TYPE_EDGE = 3


class IGlobal(IGlobalBase):
    """ArangoDB-specific global connection state."""

    QUERY_MAX_RUNTIME: float = 30.0  # Maximum seconds an AQL query may run before being aborted.
    QUERY_MEMORY_LIMIT: int = 1024 * 1024 * 1024  # Per-query memory ceiling in bytes (0 = unlimited).
    SCHEMA_SAMPLE_LIMIT: int = 25  # Documents sampled per collection to infer fields.

    # python-arango client + database handle — opened in beginGlobal, closed in endGlobal.
    client: Optional[ArangoClient] = None
    db: Optional[Any] = None

    # Cached multi-model schema:
    #   {'collections': {name: {'type': 'document'|'edge', 'fields': [(field, type), ...]}},
    #    'graphs': [...], 'views': [...]}
    graph_schema: Dict[str, Any]

    # Unprefixed config values set during beginGlobal.
    endpoint: str = ''
    database: str = '_system'
    db_description: str = ''
    max_validation_attempts: int = 5
    allow_execute: bool = False
    max_execute_rows: int = DEFAULT_MAX_EXECUTE_ROWS

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Open the ArangoDB client, verify connectivity, and cache the schema."""
        self.graph_schema = {'collections': {}, 'graphs': [], 'views': []}
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.endpoint = config.get('endpoint', 'http://localhost:8529').strip()
        self.database = config.get('database', '_system').strip() or '_system'
        self.db_description = config.get('db_description', '')

        try:
            # Clamp to the services.json bounds [1, 20]: non-UI configs (pipe JSON,
            # SDK) bypass the schema, so enforce the limit at runtime too.
            self.max_validation_attempts = max(1, min(20, int(config.get('max_attempts', 5))))
        except (ValueError, TypeError):
            self.max_validation_attempts = 5

        # EXECUTE path is opt-in: a caller passing QuestionType.EXECUTE bypasses
        # the LLM translation + _is_aql_safe gate, so the node owner must
        # explicitly enable the capability. Strings like 'false' / '0' must not
        # be truthy here, so don't use bool() directly.
        allow_execute = config.get('allow_execute', False)
        if isinstance(allow_execute, str):
            self.allow_execute = allow_execute.strip().lower() in {'1', 'true', 'yes', 'on'}
        else:
            self.allow_execute = bool(allow_execute)

        try:
            # Clamp to the services.json bounds [1, 1_000_000] (see note above).
            self.max_execute_rows = max(
                1, min(1_000_000, int(config.get('max_execute_rows', DEFAULT_MAX_EXECUTE_ROWS)))
            )
        except (TypeError, ValueError):
            self.max_execute_rows = DEFAULT_MAX_EXECUTE_ROWS

        try:
            self.client = ArangoClient(hosts=self.endpoint)
            # verify=True pings the server and authenticates, raising on failure.
            self.db = self._open_database(self.client, config, verify=True)
            # Probe the configured database explicitly so a wrong name or missing
            # permissions fail fast rather than mid-pipeline.
            self.db.aql.execute('RETURN 1')
        except (ServerConnectionError, ArangoError) as e:
            error(f'ArangoDB connection failed: {e}')
            raise

        self.graph_schema = self._reflect_schema()
        debug(f'ArangoDB connected: {self.endpoint}, database={self.database}')

    def endGlobal(self) -> None:
        """Close the ArangoDB client and release the connection."""
        if self.client is not None:
            try:
                self.client.close()
            except Exception as e:
                warning(f'Error closing ArangoDB client: {e}')
            finally:
                self.client = None
                self.db = None

    # ------------------------------------------------------------------
    # Public helpers used by IInstance
    # ------------------------------------------------------------------

    def _run_query(
        self, aql: str, bind_vars: Optional[Dict] = None, *, max_runtime: float = QUERY_MAX_RUNTIME
    ) -> List[Dict]:
        """Execute a read-only AQL query and return rows as a list of plain dicts.

        Args:
            aql (str): The AQL query to execute.
            bind_vars (Optional[Dict]): Bind parameters for the query.
            max_runtime (float): Maximum seconds the query may run before being aborted.

        Returns:
            List[Dict]: Result rows (already plain JSON values from python-arango).

        Raises:
            arango.exceptions.ArangoError: If the driver reports a query error.
        """
        # Defence-in-depth backstop. The cheap keyword scan can't tell a write
        # CLAUSE from a collection/attribute NAMED like a write keyword, so on a
        # hit defer to the precise EXPLAIN-plan gate before refusing — a read is
        # never blocked just because it references such a name. (The authoritative
        # gate is _validate_query, also applied during generation in IInstance.)
        if not _is_aql_safe(aql):
            ok, reason = self._validate_query(aql)
            if not ok:
                raise ValueError(f'Refusing to execute unsafe (write) AQL statement: {reason}')

        cursor = self.db.aql.execute(
            aql,
            bind_vars=bind_vars or None,
            max_runtime=max_runtime,
            memory_limit=self.QUERY_MEMORY_LIMIT,
        )
        # Result cap: stop at max_execute_rows so a missing or oversized LIMIT can
        # never stream an unbounded result back through the pipeline.
        max_rows = self.max_execute_rows
        rows: List[Dict] = []
        for doc in cursor:
            if len(rows) >= max_rows:
                warning(f'Result truncated to max_execute_rows={max_rows}')
                break
            rows.append(doc)
        return rows

    def _run_query_raw(self, aql: str, *, max_runtime: float = QUERY_MAX_RUNTIME) -> Dict[str, Any]:
        """Execute a raw AQL statement without the ``_is_aql_safe`` gate.

        Used by the EXECUTE path where the caller has accepted the risk of running
        write AQL directly. Returns ``{'rows': [...], 'affected_rows': N}`` to mirror
        the SQL ``_executeRawQuery`` shape — ``affected_rows`` is derived from the
        cursor statistics when no rows are returned (e.g. INSERT without RETURN).

        Raises:
            arango.exceptions.ArangoError: Caught at the IInstance handler per precedent.
        """
        max_rows = self.max_execute_rows
        cursor = self.db.aql.execute(aql, count=False, max_runtime=max_runtime, memory_limit=self.QUERY_MEMORY_LIMIT)
        rows: List[Dict] = []
        for doc in cursor:
            # Check before appending (mirrors _run_query) so we never hold an extra row.
            if len(rows) >= max_rows:
                raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')
            rows.append(doc)
        affected = _affected_rows(cursor)
        return {'rows': rows, 'affected_rows': 0 if rows else affected}

    def _validate_query(self, aql: str) -> Tuple[bool, str]:
        """Validate an AQL statement with EXPLAIN — syntax *and* read-only enforcement.

        EXPLAIN both checks syntax (raises on a malformed query) and returns the
        execution plan. Inspecting the plan for data-modification nodes is the
        primary read-only gate. Returns (True, '') for a valid read-only query, or
        (False, error_message) on a syntax error or a write query.
        """
        try:
            plan = self.db.aql.explain(aql)
        except ArangoError as e:
            return False, str(e)
        except Exception as e:
            return False, str(e)
        if _plan_is_modification(plan):
            return False, 'Query performs data modification; this node is read-only.'
        return True, ''

    def validateConfig(self) -> None:
        """Test connectivity with a trivial read query; safe to call at save-time.

        Surfaces driver error messages via ``warning()`` so the user sees exactly
        what went wrong (wrong password, unreachable host, bad database name).
        """
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        endpoint = config.get('endpoint', 'http://localhost:8529').strip()

        client = None
        try:
            client = ArangoClient(hosts=endpoint)
            db = self._open_database(client, config, verify=True)
            db.aql.execute('RETURN 1')
        except ServerConnectionError as e:
            warning(f'Could not connect to ArangoDB at {endpoint}: {e}')
            return
        except ArangoError as e:
            warning(str(e))
            return
        except Exception as e:
            warning(str(e))
            return
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Schema reflection
    # ------------------------------------------------------------------

    def _reflect_schema(self) -> Dict[str, Any]:
        """Reflect collections (document/edge), sampled fields, indexes, graphs, and views."""
        schema: Dict[str, Any] = {'collections': {}, 'graphs': [], 'views': []}

        try:
            collections = self.db.collections()
        except ArangoError as e:
            warning(f'ArangoDB schema reflection failed: {e}')
            return schema

        for coll in collections:
            name = coll.get('name', '')
            # Skip ArangoDB's internal/system collections (names start with '_').
            if not name or coll.get('system') or name.startswith('_'):
                continue
            ctype = 'edge' if _is_edge_collection(coll) else 'document'
            schema['collections'][name] = {
                'type': ctype,
                'fields': self._sample_fields(name),
                'indexed_fields': self._reflect_indexes(name),
            }

        schema['graphs'] = self._reflect_graphs()
        schema['views'] = self._reflect_views()
        return schema

    def _sample_fields(self, name: str) -> List[Tuple[str, str]]:
        """Sample documents from a collection to infer its top-level fields and types."""
        fields: Dict[str, str] = {}
        try:
            cursor = self.db.collection(name).find({}, limit=self.SCHEMA_SAMPLE_LIMIT)
            for doc in cursor:
                if not isinstance(doc, dict):
                    continue
                for key, value in doc.items():
                    if key not in fields:
                        fields[key] = _json_type(value)
        except ArangoError as e:
            warning(f'Field sampling failed for collection {name}: {e}')
        return [(key, fields[key]) for key in fields]

    def _reflect_indexes(self, name: str) -> List[str]:
        """Return the indexed field names for a collection (the primary index is skipped)."""
        indexed: List[str] = []
        try:
            for idx in self.db.collection(name).indexes():
                if not isinstance(idx, dict) or idx.get('type') == 'primary':
                    continue
                for field in idx.get('fields') or []:
                    if isinstance(field, str) and field not in indexed:
                        indexed.append(field)
        except ArangoError as e:
            warning(f'Index reflection failed for collection {name}: {e}')
        return indexed

    def _reflect_graphs(self) -> List[Dict[str, Any]]:
        """Reflect named graphs and their edge definitions (from -> edge -> to)."""
        graphs: List[Dict[str, Any]] = []
        try:
            for graph in self.db.graphs():
                edge_defs = []
                raw_defs = graph.get('edge_definitions') or graph.get('edgeDefinitions') or []
                for ed in raw_defs:
                    edge_defs.append(
                        {
                            'edge': ed.get('edge_collection') or ed.get('collection') or '',
                            'from': list(ed.get('from_vertex_collections') or ed.get('from') or []),
                            'to': list(ed.get('to_vertex_collections') or ed.get('to') or []),
                        }
                    )
                graphs.append({'name': graph.get('name', ''), 'edge_definitions': edge_defs})
        except ArangoError as e:
            warning(f'Graph reflection failed: {e}')
        return graphs

    def _reflect_views(self) -> List[Dict[str, str]]:
        """Reflect ArangoSearch views (name + type)."""
        views: List[Dict[str, str]] = []
        try:
            for view in self.db.views():
                views.append({'name': view.get('name', ''), 'type': view.get('type', '')})
        except ArangoError as e:
            warning(f'View reflection failed: {e}')
        return views

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _open_database(client: ArangoClient, config: Dict[str, Any], *, verify: bool = False) -> Any:
        """Open a database handle, honouring the ``auth_method`` field.

        ``'token'`` → JWT user-token auth, anything else (default ``'userpass'``)
        → username/password. ``verify=True`` pings the server and authenticates,
        raising ``ServerConnectionError`` on failure.
        """
        database = config.get('database', '_system').strip() or '_system'
        auth_method = config.get('auth_method', 'userpass').strip()
        if auth_method == 'token':
            return client.db(database, user_token=config.get('token', ''), verify=verify)
        user = config.get('user', 'root').strip() or 'root'
        password = config.get('password', '')
        return client.db(database, username=user, password=password, verify=verify)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _is_edge_collection(coll: Dict[str, Any]) -> bool:
    """Return True when a collection-info dict describes an edge collection.

    python-arango may report ``type`` as the string ``'edge'`` or the numeric
    ArangoDB code ``3`` depending on version — handle both.
    """
    ctype = coll.get('type')
    if isinstance(ctype, str):
        return ctype.lower() == 'edge'
    return ctype == _COLLECTION_TYPE_EDGE


def _json_type(value: Any) -> str:
    """Map a Python/JSON value to a short type label for the schema description."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'bool'
    if isinstance(value, int):
        return 'int'
    if isinstance(value, float):
        return 'double'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, (list, tuple)):
        return 'array'
    if isinstance(value, dict):
        return 'object'
    return 'any'


def _affected_rows(cursor: Any) -> int:
    """Best-effort count of documents written by a query, from cursor statistics.

    python-arango exposes the write count as ``modified`` in ``Cursor.statistics()``
    (the ArangoDB ``writesExecuted`` figure, renamed by the driver); older or raw
    response shapes are accepted as fallbacks.
    """
    try:
        stats = cursor.statistics() or {}
    except Exception:
        return 0
    return int(stats.get('modified') or stats.get('writes_executed') or stats.get('writesExecuted') or 0)
