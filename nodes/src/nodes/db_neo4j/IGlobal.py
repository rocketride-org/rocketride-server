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
Global (connection-level) state for the Neo4J database node.

Manages the neo4j driver lifecycle, graph schema reflection, query execution,
and query validation.  All Neo4J-specific knowledge lives here — IInstance
calls these methods without knowing the underlying driver.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import neo4j
from neo4j.exceptions import Neo4jError, ServiceUnavailable

from rocketlib import IGlobalBase, debug, error, warning
from ai.common.config import Config

from .utils import _is_cypher_safe


class IGlobal(IGlobalBase):
    """Neo4J-specific global connection state."""

    QUERY_TIMEOUT: float = 30.0  # Maximum seconds a Cypher query may run before being aborted.

    # neo4j.Driver instance — opened in beginGlobal, closed in endGlobal.
    driver: Optional[neo4j.Driver] = None

    # Cached graph schema: {'nodes': {label: [(prop, type), ...]},
    #                        'relationships': [{type, start, end}, ...]}
    graph_schema: Dict[str, Any]

    # Unprefixed config values set during beginGlobal.
    uri: str = ''
    database: str = 'neo4j'
    # label: str = 'Row'
    db_description: str = ''
    max_validation_attempts: int = 5
    enable_run_cypher: bool = False
    allow_destructive: bool = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Open the Neo4J driver, verify connectivity, and cache the graph schema."""
        self.graph_schema = {}
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.uri = config.get('uri', 'neo4j://localhost:7687').strip()
        self.database = config.get('database', 'neo4j').strip() or 'neo4j'
        # self.label = config.get('label', 'Row').strip() or 'Row'
        self.db_description = config.get('db_description', '')

        try:
            self.max_validation_attempts = int(config.get('max_attempts', 5))
        except (ValueError, TypeError):
            self.max_validation_attempts = 5

        self.enable_run_cypher = bool(config.get('enableRunCypher', False))
        self.allow_destructive = bool(config.get('allowDestructive', False))

        auth = self._build_auth(config)

        try:
            self.driver = neo4j.GraphDatabase.driver(self.uri, auth=auth)
            # Verify DBMS connectivity and authentication.
            self.driver.verify_connectivity()
            # verify_connectivity() uses the home database — probe the configured
            # database explicitly so a wrong name or missing permissions fail fast.
            with self.driver.session(database=self.database) as session:
                session.run('RETURN 1').consume()
        except (ServiceUnavailable, Neo4jError) as e:
            error(f'Neo4J connection failed: {e}')
            raise

        self.graph_schema = self._reflect_schema()
        debug(f'Neo4J connected: {self.uri}, database={self.database}')

    def endGlobal(self) -> None:
        """Close the Neo4J driver and release the connection."""
        if self.driver is not None:
            try:
                self.driver.close()
            except Exception as e:
                warning(f'Error closing Neo4J driver: {e}')
            finally:
                self.driver = None

    # ------------------------------------------------------------------
    # Public helpers used by IInstance and the driver
    # ------------------------------------------------------------------

    def _run_query(self, cypher: str, params: Optional[Dict] = None, *, timeout: float = QUERY_TIMEOUT) -> List[Dict]:
        """Execute a read-only Cypher query and return rows as a list of plain dicts.

        Args:
            cypher (str): The Cypher query to execute.
            params (Optional[Dict]): Query parameters to bind into the Cypher statement.
            timeout (float): Maximum seconds the query may run before being aborted.
                Defaults to ``QUERY_TIMEOUT``.

        Returns:
            List[Dict]: Result rows, each serialised to a plain Python dict.

        Raises:
            neo4j.exceptions.Neo4jError: If the driver reports a query or connection error.
        """
        if params is None:
            params = {}

        # Defence-in-depth: block writes even if the caller skips the safety check.
        if not _is_cypher_safe(cypher):
            raise ValueError('Refusing to execute unsafe (write/admin) Cypher statement')

        with self.driver.session(database=self.database) as session:
            result = session.run(neo4j.Query(cypher, timeout=timeout), params)
            return [_record_to_dict(record) for record in result]

    def _run_write_query(self, cypher: str, params: Optional[Dict] = None, *, timeout: float = QUERY_TIMEOUT) -> List[Dict]:
        """Execute a write Cypher query (CREATE, MERGE, etc.) and return result rows.

        Unlike ``_run_query`` this method does **not** enforce the read-only safety
        check, allowing mutations such as CREATE, MERGE, SET, and DELETE.

        Uses ``session.execute_write()`` to ensure proper routing in Neo4j
        cluster deployments (causal cluster, Aura).

        Args:
            cypher (str): The Cypher statement to execute (may contain write clauses).
            params (Optional[Dict]): Query parameters to bind into the Cypher statement.
            timeout (float): Maximum seconds the query may run before being aborted.
                Defaults to ``QUERY_TIMEOUT``.

        Returns:
            List[Dict]: Result rows, each serialised to a plain Python dict.

        Raises:
            neo4j.exceptions.Neo4jError: If the driver reports a query or connection error.
        """
        if params is None:
            params = {}

        def _write_tx(tx: Any) -> List[Dict]:
            result = tx.run(neo4j.Query(cypher, timeout=timeout), params)
            return [_record_to_dict(record) for record in result]

        with self.driver.session(database=self.database) as session:
            return session.execute_write(_write_tx)

    def _validate_query(self, cypher: str) -> Tuple[bool, str]:
        """Run EXPLAIN on a Cypher statement to check syntax without executing it.

        Returns (True, '') on success or (False, error_message) on failure.
        """
        try:
            with self.driver.session(database=self.database) as session:
                session.run(f'EXPLAIN {cypher}').consume()
            return True, ''
        except Neo4jError as e:
            return False, str(e.message or e)
        except Exception as e:
            return False, str(e)

    def validateConfig(self) -> None:
        """Test connectivity with a trivial read query; safe to call at save-time.

        Surfaces driver error messages via ``warning()`` so the user sees exactly
        what went wrong (wrong password, unreachable host, etc.).
        """
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        uri = config.get('uri', 'neo4j://localhost:7687').strip()
        database = config.get('database', 'neo4j').strip() or 'neo4j'
        auth = self._build_auth(config)

        tmp_driver = None
        try:
            tmp_driver = neo4j.GraphDatabase.driver(uri, auth=auth, connection_timeout=5)
            tmp_driver.verify_connectivity()
            with tmp_driver.session(database=database) as session:
                session.run('RETURN 1').consume()
        except neo4j.exceptions.AuthError as e:
            warning(f'Authentication failed: {e}')
            return
        except ServiceUnavailable as e:
            warning(f'Could not connect to Neo4J at {uri}: {e}')
            return
        except Neo4jError as e:
            warning(str(e.message or e))
            return
        except Exception as e:
            warning(str(e))
            return
        finally:
            if tmp_driver is not None:
                try:
                    tmp_driver.close()
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Schema reflection
    # ------------------------------------------------------------------

    def _reflect_schema(self) -> Dict[str, Any]:
        """Reflect node labels, properties, and relationship types from Neo4J."""
        schema: Dict[str, Any] = {'nodes': {}, 'relationships': []}

        try:
            with self.driver.session(database=self.database) as session:
                # Node labels and their properties.
                node_props: Dict[str, List[Tuple[str, str]]] = {}
                try:
                    result = session.run('CALL db.schema.nodeTypeProperties()')
                    for record in result:
                        raw_label = record.get('nodeType', '')
                        label = raw_label.lstrip(':') if raw_label else ''
                        prop = record.get('propertyName') or ''
                        types = record.get('propertyTypes') or []
                        prop_type = types[0] if types else 'ANY'
                        if label:
                            if label not in node_props:
                                node_props[label] = []
                            if prop:
                                node_props[label].append((prop, prop_type))
                except Neo4jError:
                    # Fall back to just listing labels without properties.
                    try:
                        result = session.run('CALL db.labels()')
                        for record in result:
                            label = record.get('label') or ''
                            if label:
                                node_props[label] = []
                    except Neo4jError:
                        pass

                schema['nodes'] = node_props

                # Relationship types with start/end labels from schema visualization.
                try:
                    result = session.run('CALL db.schema.visualization()')
                    rels = []
                    for record in result:
                        for rel in record.get('relationships') or []:
                            # neo4j.graph.Relationship exposes metadata as attributes,
                            # not dict keys — rel.get('type') returns None.
                            rel_type = getattr(rel, 'type', None) or ''
                            start_node = getattr(rel, 'start_node', None)
                            end_node = getattr(rel, 'end_node', None)
                            start_label = _first_label(start_node)
                            end_label = _first_label(end_node)
                            if rel_type:
                                rels.append(
                                    {
                                        'type': rel_type,
                                        'start': start_label,
                                        'end': end_label,
                                    }
                                )
                    schema['relationships'] = rels
                except Neo4jError:
                    # Fall back to listing relationship types without endpoints.
                    try:
                        result = session.run('CALL db.relationshipTypes()')
                        schema['relationships'] = [{'type': r.get('relationshipType', ''), 'start': '', 'end': ''} for r in result if r.get('relationshipType')]
                    except Neo4jError:
                        pass

        except Exception as e:
            warning(f'Neo4J schema reflection failed: {e}')

        return schema

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_auth(config: Dict[str, Any]) -> Any:
        """Build a neo4j auth tuple or bearer-token auth from config.

        Respects the ``auth_method`` field: ``'token'`` → bearer auth,
        anything else (default ``'userpass'``) → username/password.

        Args:
            config (Dict[str, Any]): Unprefixed node config dict.

        Returns:
            Any: A ``neo4j.bearer_auth`` token or a ``(user, password)`` tuple.
        """
        auth_method = config.get('auth_method', 'userpass').strip()
        if auth_method == 'token':
            return neo4j.bearer_auth(config.get('token', ''))
        user = config.get('user', 'neo4j').strip() or 'neo4j'
        password = config.get('password', '')
        return (user, password)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _record_to_dict(record: neo4j.Record) -> Dict[str, Any]:
    """Convert a neo4j Record to a plain dict, serialising graph objects."""
    return {key: _serialize_value(record[key]) for key in record.keys()}


def _serialize_value(value: Any) -> Any:
    """Recursively convert Neo4J-specific types to JSON-serializable values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _serialize_value(v) for k, v in value.items()}
    # neo4j.graph.Node
    if hasattr(value, 'labels') and hasattr(value, 'items'):
        return {'_labels': list(value.labels), **{k: _serialize_value(v) for k, v in value.items()}}
    # neo4j.graph.Relationship
    if hasattr(value, 'type') and hasattr(value, 'items') and hasattr(value, 'start_node'):
        return {'_type': value.type, **{k: _serialize_value(v) for k, v in value.items()}}
    # neo4j.graph.Path
    if hasattr(value, 'nodes') and hasattr(value, 'relationships'):
        return {
            'nodes': [_serialize_value(n) for n in value.nodes],
            'relationships': [_serialize_value(r) for r in value.relationships],
        }
    # neo4j temporal types (DateTime, Date, Time, Duration)
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    if hasattr(value, '__str__'):
        return str(value)
    return value


def _first_label(node: Any) -> str:
    """Extract the first label from a neo4j Node object, or '' if unavailable."""
    if node is None:
        return ''
    if hasattr(node, 'labels'):
        labels = list(node.labels)
        return labels[0] if labels else ''
    return ''
