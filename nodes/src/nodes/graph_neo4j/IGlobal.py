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

import re
import time

from itertools import islice
from typing import Any, Dict, List, Optional, Tuple

import neo4j
from neo4j.exceptions import Neo4jError, ServiceUnavailable

from rocketlib import error, warning

from ai.common.graph import GraphGlobalBase, is_cypher_safe, strip_cypher_literals
from ai.common.graph.adapters import neo4j_adapter
from ai.common.graph.cypher_safety import NEO4J_READ_PROCEDURES, check_read_only_cypher
from ai.common.graph.schema import SCHEMA_LABEL_LIMIT, SCHEMA_REL_TYPE_LIMIT, SCHEMA_SAMPLE_SIZE

# Privileges a browsing identity may hold and still be read-only. Anything
# else GRANTED (writes, schema/name management, administration, boosted
# execution, or a privilege this list does not know) means the role is not a
# verified read-only boundary. Procedures and functions run with the caller's
# own privileges unless boosted, so 'execute' cannot write for a reader. 'load'
# (granted to PUBLIC by default) lets LOAD CSV read external files; it never
# writes the graph, and read_query refuses LOAD CSV regardless.
READ_ONLY_PRIVILEGES = frozenset(
    {'access', 'traverse', 'read', 'match', 'show_index', 'show_constraint', 'execute', 'execute_function', 'load'}
)

DEFAULT_URI = 'neo4j://localhost:7687'
DEFAULT_DATABASE = 'neo4j'

# Statements Neo4j runs only in an auto-commit transaction: batched subqueries
# (``CALL { ... } IN [n] [CONCURRENT] TRANSACTIONS``) and Neo4j 4's
# ``USING PERIODIC COMMIT``.
_AUTO_COMMIT_ONLY = re.compile(
    r'\}\s*IN\s+(?:(?:\S+\s+)?CONCURRENT\s+)?TRANSACTIONS\b|\bUSING\s+PERIODIC\s+COMMIT\b',
    re.IGNORECASE,
)


class IGlobal(GraphGlobalBase):
    """Neo4J-specific global connection state."""

    QUERY_TIMEOUT: float = 30.0  # Maximum seconds a Cypher query may run before being aborted.

    supports_execute_params = True

    driver: Optional[neo4j.Driver] = None

    uri: str = ''
    database: str = DEFAULT_DATABASE
    server_version: Optional[str] = None
    server_edition: Optional[str] = None
    role_verified_read_only: bool = False

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
        self._read_server_identity()

    def _read_server_identity(self) -> None:
        """Server version/edition, and whether this identity's role is verifiably read-only."""
        self.server_version, self.server_edition, self.role_verified_read_only = None, None, False
        try:
            with self.driver.session(database=self.database, default_access_mode=neo4j.READ_ACCESS) as session:
                rec = session.run(
                    neo4j.Query(
                        'CALL dbms.components() YIELD name, versions, edition RETURN versions, edition', timeout=10
                    )
                ).single()
                if rec is not None:
                    versions = rec['versions'] or []
                    self.server_version = str(versions[0]) if versions else None
                    self.server_edition = str(rec['edition'] or '').lower() or None
                if self.server_edition == 'enterprise':
                    rows = session.run(
                        neo4j.Query('SHOW USER PRIVILEGES YIELD access, action RETURN access, action', timeout=10)
                    ).data()
                    self.role_verified_read_only = role_is_read_only(rows)
        except Exception as e:  # identity is descriptive; never fail the node over it
            warning(f'Neo4J: could not read server identity or privileges: {e}')

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

    def _run_query_raw(self, query: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute a raw statement with no safety gate (the EXECUTE path).

        The statement runs in an explicit transaction that commits only after
        the row cap is checked, so a result over ``max_execute_rows`` is rolled
        back and a retry cannot duplicate the write. Batched statements run in
        auto-commit, the only mode Neo4j allows for them; each batch commits on
        its own, so the cap cannot undo them.

        ``params`` binds ``$name`` values as Bolt parameters.
        """
        with self.driver.session(database=self.database) as session:
            if _needs_auto_commit(query):
                return self._read_execute_result(
                    session.run(neo4j.Query(query, timeout=self.QUERY_TIMEOUT), params or {})
                )
            # Leaving the block commits; an exception inside it, the row cap's included, rolls back.
            with session.begin_transaction(timeout=self.QUERY_TIMEOUT) as tx:
                return self._read_execute_result(tx.run(query, params or {}))

    def _read_execute_result(self, result: neo4j.Result) -> Dict[str, Any]:
        """Collect an EXECUTE result as ``{'rows', 'affected_rows'}``; raise past ``max_execute_rows``."""
        max_rows = self.max_execute_rows
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

    # ------------------------------------------------------------------
    # read_query / execute(shape='graph')
    # ------------------------------------------------------------------

    @property
    def statement_timeout_ms(self) -> int:
        return int(self.QUERY_TIMEOUT * 1000)

    def _graph_adapter(self):
        return neo4j_adapter()

    def _read_query_rows(self, cypher, params, fetch_limit, consume):
        """Read-only Cypher for read_query.

        Layers, outermost first: a token-level check that refuses writes,
        administration, USE and any CALL outside the read-only procedure
        allowlist; a READ-mode managed transaction; a server-side transaction
        deadline. None of these is the security boundary on Neo4j: that is a
        read-only database role (see the node README). READ mode is routing,
        not access control, by the driver's own documentation, even though a
        single instance does refuse writes in it.
        """
        check_read_only_cypher(cypher, allowed_procedures=NEO4J_READ_PROCEDURES)

        def work(tx):
            result = tx.run(cypher, params or {})
            columns = list(result.keys())
            # Stream: stop pulling records once the caller has enough.
            return consume(columns, (record.values() for record in islice(result, fetch_limit)))

        with self.driver.session(
            database=self.database,
            default_access_mode=neo4j.READ_ACCESS,
            fetch_size=max(1, min(fetch_limit, 1000)),
        ) as session:
            return session.execute_read(neo4j.unit_of_work(timeout=self.QUERY_TIMEOUT)(work))

    def _raw_query_rows(self, cypher, fetch_limit, consume, params=None):
        """execute(shape='graph'): run as written in one write transaction (never retried).

        ``params`` binds ``$name`` values as Bolt parameters, as in ``_run_query_raw``.
        """
        with self.driver.session(database=self.database) as session:
            result = session.run(neo4j.Query(cypher, timeout=self.QUERY_TIMEOUT), params or {})
            envelope = consume(list(result.keys()), (record.values() for record in islice(result, fetch_limit)))
            counters = result.consume().counters
            affected = (
                counters.nodes_created
                + counters.nodes_deleted
                + counters.relationships_created
                + counters.relationships_deleted
                + counters.properties_set
                + counters.labels_added
                + counters.labels_removed
            )
            return envelope, affected

    # ------------------------------------------------------------------
    # Schema v2, identity, prompt rules
    # ------------------------------------------------------------------

    def _reflect_schema_v2(self, builder, deadline):
        """Labels and relationship types with counts (count store) and sampled properties/endpoints.

        Everything runs in ONE read transaction whose server-side timeout is
        the remaining refresh budget, so the whole refresh is bounded by the
        server, not just each statement. Label and type names come from the
        procedures' raw values (never back-quoted display strings) and are
        quoted as identifiers when sampled.
        """
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('schema refresh budget exhausted')

        def work(tx):
            labels = [r['label'] for r in tx.run('CALL db.labels() YIELD label RETURN label ORDER BY label')]
            if len(labels) > SCHEMA_LABEL_LIMIT:
                builder.truncated = True
                labels = labels[:SCHEMA_LABEL_LIMIT]
            for label in labels:
                q = _quote(label)
                builder.label(label, count=tx.run(f'MATCH (n:{q}) RETURN count(n) AS c').single()['c'])
                for rec in tx.run(f'MATCH (n:{q}) WITH n LIMIT {SCHEMA_SAMPLE_SIZE} RETURN properties(n) AS p'):
                    builder.sample_label_properties(label, rec['p'])
            rels = [
                r['relationshipType']
                for r in tx.run(
                    'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType'
                )
            ]
            if len(rels) > SCHEMA_REL_TYPE_LIMIT:
                builder.truncated = True
                rels = rels[:SCHEMA_REL_TYPE_LIMIT]
            for rel in rels:
                q = _quote(rel)
                builder.rel_type(rel, count=tx.run(f'MATCH ()-[r:{q}]->() RETURN count(r) AS c').single()['c'])
                for rec in tx.run(
                    f'MATCH (a)-[r:{q}]->(b) WITH a, r, b LIMIT {SCHEMA_SAMPLE_SIZE} '
                    'RETURN labels(a) AS s, labels(b) AS e, properties(r) AS p'
                ):
                    for start in rec['s'] or ['']:
                        for end in rec['e'] or ['']:
                            builder.endpoint(rel, start, end, observed=True)
                    builder.sample_rel_properties(rel, rec['p'])

        with self.driver.session(database=self.database, default_access_mode=neo4j.READ_ACCESS) as session:
            session.execute_read(neo4j.unit_of_work(timeout=remaining)(work))

    def _engine_identity(self):
        verified = bool(self.role_verified_read_only)
        return {
            'engine': {'name': 'Neo4j', 'version': self.server_version, 'edition': self.server_edition},
            'database': self.database,
            'graph': None,
            'read_boundary': 'database_role' if verified else 'read_session',
            'read_boundary_verified': verified,
            'shortest_path': True,
            'server_result_cap': None,
        }

    def _prompt_rules(self):
        version = self.server_version or '5'
        return [
            f'The database is Neo4j {version}; write Neo4j Cypher.',
            'Only MATCH, OPTIONAL MATCH, WITH, UNWIND, RETURN, ORDER BY, SKIP and LIMIT; no write or admin clauses.',
            'The only procedures you may CALL are db.labels(), db.relationshipTypes(), db.propertyKeys(), '
            'db.schema.nodeTypeProperties(), db.schema.relTypeProperties() and db.schema.visualization().',
            'Refer to nodes by elementId(n) (a string), never by id(n).',
        ]

    def _describe_error(self, exc):
        if not isinstance(exc, Neo4jError):
            return None
        code = str(getattr(exc, 'code', '') or '')
        detail = str(getattr(exc, 'message', None) or exc).strip()
        if 'TransactionTimedOut' in code:
            return f'Query timed out after {self.statement_timeout_ms} ms', detail
        if code.endswith('Statement.AccessMode'):
            return 'Refused: the database refused a write on the read-only path', detail
        if code.startswith('Neo.ClientError.Security.'):
            return 'Refused: the database user may not run this statement', detail
        return 'Query failed', detail

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


def _needs_auto_commit(query: str) -> bool:
    """Return True for a statement Neo4j refuses to run inside an explicit transaction."""
    return bool(_AUTO_COMMIT_ONLY.search(strip_cypher_literals(query)))


def _quote(name: str) -> str:
    """Neo4j identifier quoting: back-quotes, with embedded back-quotes doubled."""
    return '`' + str(name).replace('`', '``') + '`'


def role_is_read_only(privileges: List[Dict[str, Any]]) -> bool:
    """True when every GRANTED privilege of the current user is a read privilege.

    ``privileges`` are rows of ``SHOW USER PRIVILEGES YIELD access, action``.
    An empty list is not proof of anything, so it is not read-only-verified.
    """
    granted = [str(p.get('action', '')).lower() for p in privileges if str(p.get('access', '')).upper() == 'GRANTED']
    return bool(granted) and all(action in READ_ONLY_PRIVILEGES for action in granted)


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
