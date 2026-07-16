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

"""Neo4J graph node — global (shared) connection state.

Thin driver over ``GraphGlobalBase``: it owns the Bolt driver and the Neo4J
schema procedures, and inherits the lifecycle, config parsing, schema caching
and LLM query loop from the base class.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import neo4j
from neo4j.exceptions import Neo4jError, ServiceUnavailable

from rocketlib import error, warning

from ai.common.graph import GraphGlobalBase, is_cypher_safe

DEFAULT_URI = 'neo4j://localhost:7687'
DEFAULT_DATABASE = 'neo4j'


class IGlobal(GraphGlobalBase):
    """Neo4J-specific global connection state."""

    QUERY_TIMEOUT: float = 30.0  # Maximum seconds a Cypher query may run before being aborted.

    driver: Optional[neo4j.Driver] = None

    uri: str = ''
    database: str = DEFAULT_DATABASE

    # ------------------------------------------------------------------
    # Driver hooks
    # ------------------------------------------------------------------

    def _open_driver(self, config: Dict[str, Any]) -> None:
        """Open the Bolt driver and verify both the DBMS and the target database."""
        self.uri = str(config.get('uri') or DEFAULT_URI).strip() or DEFAULT_URI
        self.database = str(config.get('database') or DEFAULT_DATABASE).strip() or DEFAULT_DATABASE

        try:
            self.driver = neo4j.GraphDatabase.driver(self.uri, auth=self._build_auth(config))
            self.driver.verify_connectivity()
            # verify_connectivity() only checks the home database — probe the
            # configured one so a wrong name or missing permission fails fast.
            with self.driver.session(database=self.database) as session:
                session.run('RETURN 1').consume()
        except (ServiceUnavailable, Neo4jError) as e:
            error(f'Neo4J connection failed: {e}')
            raise

    def _close_driver(self) -> None:
        if self.driver is not None:
            try:
                self.driver.close()
            finally:
                self.driver = None

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time probe: connect and run RETURN 1, reporting failures as warnings."""
        uri = str(config.get('uri') or DEFAULT_URI).strip() or DEFAULT_URI
        database = str(config.get('database') or DEFAULT_DATABASE).strip() or DEFAULT_DATABASE

        tmp_driver = None
        try:
            tmp_driver = neo4j.GraphDatabase.driver(uri, auth=self._build_auth(config), connection_timeout=5)
            tmp_driver.verify_connectivity()
            with tmp_driver.session(database=database) as session:
                session.run('RETURN 1').consume()
        except neo4j.exceptions.AuthError as e:
            warning(f'Authentication failed: {e}')
        except ServiceUnavailable as e:
            warning(f'Could not connect to Neo4J at {uri}: {e}')
        except Neo4jError as e:
            warning(str(e.message or e))
        except Exception as e:
            warning(str(e))
        finally:
            if tmp_driver is not None:
                try:
                    tmp_driver.close()
                except Exception:
                    pass

    def _run_query(self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None) -> List[Dict]:
        """Execute a read-only Cypher query and return rows as plain dicts.

        Unlike FalkorDB's GRAPH.RO_QUERY, Bolt has no server-side read-only
        execution mode for a standalone instance: READ access only guarantees
        routing to a replica in a cluster. The is_cypher_safe gate is therefore
        the primary defence here, not just defence-in-depth.

        With ``limit`` set the caller wants truncation detection, so return one
        row past it (still bounded by ``read_row_cap``); with no limit (the lane
        path) fall back to the ``read_row_cap`` ceiling.
        """
        if not is_cypher_safe(query):
            raise ValueError('Refusing to execute unsafe (write/admin) Cypher statement')

        cap = self.read_row_cap if limit is None else min(int(limit), self.read_row_cap) + 1
        with self.driver.session(
            database=self.database,
            default_access_mode=neo4j.READ_ACCESS,
        ) as session:
            result = session.run(neo4j.Query(query, timeout=self.QUERY_TIMEOUT), params or {})
            return [_record_to_dict(record) for _, record in zip(range(cap), result)]

    def _run_query_raw(self, query: str) -> Dict[str, Any]:
        """Execute a raw statement with no safety gate (the EXECUTE path)."""
        max_rows = self.max_execute_rows
        with self.driver.session(database=self.database) as session:
            result = session.run(neo4j.Query(query, timeout=self.QUERY_TIMEOUT))
            rows = [_record_to_dict(record) for _, record in zip(range(max_rows + 1), result)]
            if len(rows) > max_rows:
                raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')

            counters = result.consume().counters
            # Count writes unconditionally: a Cypher write commonly also returns rows
            # (CREATE (n) RETURN n), so a non-empty result set does not mean nothing
            # changed. The counters are 0 for a pure read anyway.
            affected = (
                counters.nodes_created
                + counters.nodes_deleted
                + counters.relationships_created
                + counters.relationships_deleted
                + counters.properties_set
                + counters.labels_added
                + counters.labels_removed
            )
            return {'rows': rows, 'affected_rows': affected}

    def _validate_query(self, query: str) -> Tuple[bool, str]:
        """Run EXPLAIN to check syntax without executing the query."""
        try:
            with self.driver.session(database=self.database) as session:
                session.run(f'EXPLAIN {query}').consume()
            return True, ''
        except Neo4jError as e:
            return False, str(e.message or e)
        except Exception as e:
            return False, str(e)

    def _reflect_schema(self) -> Dict[str, Any]:
        """Reflect node labels, their properties, and relationship types."""
        schema: Dict[str, Any] = {'nodes': {}, 'relationships': []}

        try:
            with self.driver.session(database=self.database) as session:
                schema['nodes'] = self._reflect_nodes(session)
                schema['relationships'] = self._reflect_relationships(session)
        except Exception as e:
            warning(f'Neo4J schema reflection failed: {e}')

        return schema

    # ------------------------------------------------------------------
    # Neo4J helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _reflect_nodes(session) -> Dict[str, List[Tuple[str, str]]]:
        """Read labels and their property types, falling back to bare labels."""
        node_props: Dict[str, List[Tuple[str, str]]] = {}
        try:
            for record in session.run('CALL db.schema.nodeTypeProperties()'):
                raw_label = record.get('nodeType', '')
                label = raw_label.lstrip(':') if raw_label else ''
                if not label:
                    continue
                node_props.setdefault(label, [])
                prop = record.get('propertyName') or ''
                if prop:
                    types = record.get('propertyTypes') or []
                    node_props[label].append((prop, types[0] if types else 'ANY'))
        except Neo4jError:
            try:
                for record in session.run('CALL db.labels()'):
                    label = record.get('label') or ''
                    if label:
                        node_props[label] = []
            except Neo4jError:
                pass
        return node_props

    @staticmethod
    def _reflect_relationships(session) -> List[Dict[str, str]]:
        """Read relationship types with endpoints, falling back to bare types."""
        try:
            rels = []
            for record in session.run('CALL db.schema.visualization()'):
                for rel in record.get('relationships') or []:
                    # neo4j.graph.Relationship exposes metadata as attributes,
                    # not dict keys — rel.get('type') returns None.
                    rel_type = getattr(rel, 'type', None) or ''
                    if rel_type:
                        rels.append(
                            {
                                'type': rel_type,
                                'start': _first_label(getattr(rel, 'start_node', None)),
                                'end': _first_label(getattr(rel, 'end_node', None)),
                            }
                        )
            return rels
        except Neo4jError:
            try:
                return [
                    {'type': r.get('relationshipType', ''), 'start': '', 'end': ''}
                    for r in session.run('CALL db.relationshipTypes()')
                    if r.get('relationshipType')
                ]
            except Neo4jError:
                return []

    @staticmethod
    def _build_auth(config: Dict[str, Any]) -> Any:
        """Build a bearer token or (user, password) tuple from the auth_method field."""
        auth_method = str(config.get('auth_method') or 'userpass').strip()
        if auth_method == 'token':
            return neo4j.bearer_auth(config.get('token', ''))
        user = str(config.get('user') or 'neo4j').strip() or 'neo4j'
        return (user, config.get('password', ''))


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
    return str(value)


def _first_label(node: Any) -> str:
    """Extract the first label from a neo4j Node object, or '' if unavailable."""
    if node is None or not hasattr(node, 'labels'):
        return ''
    labels = list(node.labels)
    return labels[0] if labels else ''
