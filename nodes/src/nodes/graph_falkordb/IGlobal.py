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
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from redis.exceptions import RedisError

from rocketlib import OPEN_MODE, warning

from ai.common.graph import GraphGlobalBase
from ai.common.graph.age.analysis import analyze
from ai.common.graph.age.errors import AgeTranslationError
from ai.common.utils import config_int, parse_bool

from falkordb import FalkorDB

DEFAULT_PORT = 6379
DEFAULT_GRAPH = 'agent'
# Schemes falkordb-py accepts: falkor(s):// are its own aliases for redis(s)://.
URL_SCHEMES = ('falkor://', 'falkors://', 'redis://', 'rediss://', 'unix://')
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

    # execute binds $name values; graph.query forwards them as a CYPHER header.
    supports_execute_params = True

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
        """Create the FalkorDB client and fail fast on a bad host, credentials, or graph name."""
        self.graph_name = _resolve_graph_name(config)
        self.allow_writes = parse_bool(config.get('allow_writes'))
        self.max_rows = config_int(config, 'max_rows', DEFAULT_ROW_CAP, min_value=1, max_value=self.max_execute_rows)
        self.query_timeout_ms = config_int(
            config, 'query_timeout_ms', DEFAULT_TIMEOUT_MS, min_value=100, max_value=600000
        )

        self.client = self._connect(config)
        # Round-trip now so a wrong host or password fails at pipeline start
        # rather than on the first tool call. FalkorDB has no per-database
        # session open to piggyback a "does this graph exist" check on (unlike
        # Neo4j's session(database=...)), so check list_graphs() by hand:
        # select_graph() on a missing name always succeeds and only fails
        # later, on the first real query, with a cryptic "ERR Invalid graph
        # operation on empty key" (#2155).
        #
        # Only when neither write path is enabled: FalkorDB creates a graph
        # lazily on its first write, so a write-capable node may legitimately
        # be pointed at a graph that does not exist yet. A read-only node can
        # never create one, so a missing graph there can only ever be a
        # misconfiguration -- exactly this issue's silent fallback to the
        # unrelated default graph "agent".
        if not self.allow_writes and not parse_bool(config.get('allow_execute')):
            graphs = [str(g) for g in (self.client.list_graphs() or [])]
            if self.graph_name not in graphs:
                available = ', '.join(graphs) or 'none'
                raise Exception(
                    f'FalkorDB graph "{self.graph_name}" does not exist on this server '
                    f'(available: {available}). Set "Default Graph" to an existing graph name.'
                )

    def _close_driver(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
            finally:
                self.client = None

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time probe: connect, and warn if a read-only node's graph does not exist.

        Only warns for a node with neither write path enabled: FalkorDB
        creates a graph lazily on its first write, so a write-capable node
        may legitimately be pointed at a graph that does not exist yet, and
        a warning there would just be noise. A read-only node can never
        create one, so this is the save-time half of the same check
        _open_driver raises on -- catching the silent fallback to the
        unrelated default graph "agent" (#2155) before the pipeline runs.
        """
        try:
            target = _connection_url(config)
        except ValueError as e:
            warning(str(e))
            return

        if not target:
            target = str(config.get('host') or '').strip()
            if not target:
                warning('host is required')
                return

        write_capable = parse_bool(config.get('allow_writes')) or parse_bool(config.get('allow_execute'))

        client = None
        try:
            client = self._connect(config)
            graphs = [str(g) for g in (client.list_graphs() or [])]
            graph_name = _resolve_graph_name(config)
            if not write_capable and graph_name not in graphs:
                available = ', '.join(graphs) or 'none'
                warning(
                    f'FalkorDB graph "{graph_name}" was not found on {_redact(target)} '
                    f'(available: {available}). Queries will fail until this graph exists.'
                )
        except RedisError as e:
            warning(f'Could not connect to FalkorDB at {_redact(target)}: {e}')
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

    def _run_query_raw(self, query: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute a raw statement with writes allowed (the EXECUTE path).

        A successful ``GRAPH.QUERY`` is already committed when it returns, so an
        over-limit result has to fail inside that one statement. The wrapper
        below does that; a failed query rolls the write back.

        ``params`` binds ``$name`` values through the client's CYPHER header.
        """
        max_rows = self.max_execute_rows
        statement = self._capped_execute_statement(query, params, max_rows)
        try:
            result = self.select_graph().query(statement, params=params or None, timeout=self.query_timeout_ms)
        except RedisError as e:
            if _is_execute_cap_error(e):
                raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}') from e
            # The wrapper's first line is `CALL {`. A server without subqueries
            # rejects that line; the user's statement starts on the next line.
            if _GUARD_CALL in statement and _is_subquery_unsupported(e):
                raise ValueError(
                    'EXECUTE query was not run because this FalkorDB server does not support '
                    'CALL {} subqueries. The row cap needs FalkorDB 4.0 or newer.'
                ) from e
            raise

        # Backstop for a statement whose in-query guard was skipped. The server
        # enforces the cap when the guard runs; this only fires when it did not.
        rows = self._rows_as_dicts(result, cap=max_rows + 1)
        if len(rows) > max_rows:
            raise ValueError(f'EXECUTE query exceeded max_execute_rows={max_rows}')

        # Count writes unconditionally: unlike SQL, a Cypher write commonly also
        # returns rows (CREATE (n) RETURN n), so `rows` being non-empty does not
        # mean nothing was written. _affected_rows is 0 for a pure read anyway.
        return {'rows': rows, 'affected_rows': _affected_rows(result)}

    def _capped_execute_statement(self, query: str, params: Optional[Dict[str, Any]], max_rows: int) -> str:
        """Statement to send: unchanged for a pure write, wrapped when it returns named columns.

        ``RETURN *`` and a column that would hide the guard raise before ``query()``,
        so nothing is written.
        """
        statement = _strip_statement(query)
        try:
            facts = analyze(statement)
        except AgeTranslationError:
            # The openCypher grammar is not a gate. EXPLAIN, which does not run
            # the write, decides whether this FalkorDB command returns rows.
            return self._unparsed_execute_statement(statement, params, max_rows)

        if facts.returns_star:
            raise ValueError('EXECUTE query was not run: name the returned columns')
        if not facts.return_columns:
            return statement
        columns = [column.display_name for column in facts.return_columns]
        return _guarded_statement(statement, max_rows, columns)

    def _unparsed_execute_statement(self, statement: str, params: Optional[Dict[str, Any]], max_rows: int) -> str:
        """Statement to send when the openCypher grammar does not recognize it.

        No Project operator means no rows, so index creation, ``FOREACH``, and
        other non-returning commands go out unchanged. A Project operator's
        children are the result columns, and that statement gets the same cap.
        """
        try:
            plan = self.select_graph().explain(statement, params=params or None)
        except RedisError:
            return statement
        columns = _structured_columns(plan)
        if not columns:
            return statement
        return _guarded_statement(statement, max_rows, columns)

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

    @classmethod
    def _connect(cls, config: Dict[str, Any]) -> FalkorDB:
        """Open a client from whichever profile is configured: URL or host/port."""
        url = _connection_url(config)
        if not url:
            return FalkorDB(**cls._client_kwargs(config))

        # Do NOT strip the password — whitespace is valid in passwords.
        password = str(config.get('password') or '')
        if not password:
            return FalkorDB.from_url(url)

        # A filled-in password field is the one that counts, so drop whatever the
        # URL embeds: redis-py would otherwise prefer the URL and ignore the field.
        return FalkorDB.from_url(_url_without_password(url), password=password)

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


def _resolve_graph_name(config: Dict[str, Any]) -> str:
    """Read 'graph' from config, falling back to DEFAULT_GRAPH when absent or blank.

    Single source for the fallback both _open_driver and _probe_connection
    apply, so the graph they check for existence is always the one that will
    actually be selected at query time.
    """
    return str(config.get('graph') or DEFAULT_GRAPH).strip() or DEFAULT_GRAPH


def _connection_url(config: Dict[str, Any]) -> str:
    """Return the validated connection URL, or '' when the node uses host/port.

    The URL profile sets ``mode`` to ``url``; an empty URL there is a
    misconfiguration rather than a fallback to localhost.
    """
    url = str(config.get('url') or '').strip()
    if not url:
        if str(config.get('mode') or '').strip().lower() == 'url':
            raise ValueError('FalkorDB URL is required, e.g. falkor://user:password@host:6379')
        return ''
    if not url.startswith(URL_SCHEMES):
        raise ValueError(
            f'Unsupported FalkorDB URL scheme in "{_redact(url)}": expected one of {", ".join(URL_SCHEMES)}'
        )
    return url


def _url_without_password(url: str) -> str:
    """Return the URL with any embedded password removed, username kept.

    Covers both places a URL can carry one: the authority (``user:pass@host``)
    and the ``password=`` query parameter that ``unix://`` URLs use.
    """
    parts = urlsplit(url)

    # Split the authority by hand rather than through parts.username, which
    # unquotes percent-escapes that must survive into the rebuilt URL.
    netloc = parts.netloc
    if '@' in netloc:
        credentials, _, host = netloc.rpartition('@')
        user = credentials.split(':', 1)[0]
        netloc = f'{user}@{host}' if user else host

    query = parts.query
    if query:
        query = urlencode([(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k != 'password'])

    rebuilt = urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))
    # urlunsplit drops the '//' when the authority is empty, turning a unix:///path
    # socket URL into unix:/path. Put it back so the scheme still parses.
    if not netloc and url.startswith(f'{parts.scheme}://'):
        rebuilt = f'{parts.scheme}://{rebuilt[len(parts.scheme) + 1 :]}'
    return rebuilt


def _redact(target: str) -> str:
    """Strip credentials from a URL before it reaches a log line.

    Masks both places a URL carries a password: the ``user:password@host``
    authority and the ``password=`` query that ``unix://`` URLs use.
    """
    scheme, sep, rest = target.partition('://')
    if not sep:
        return target

    authority, question, query = rest.partition('?')
    credentials, at, host = authority.rpartition('@')
    if at and credentials:
        authority = f'***@{host}'

    if query:
        params = parse_qsl(query, keep_blank_values=True)
        if any(k == 'password' for k, _ in params):
            # safe='*' keeps the mask readable instead of percent-escaping it.
            query = urlencode([(k, '***' if k == 'password' else v) for k, v in params], safe='*')

    return f'{scheme}://{authority}{question}{query}'


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


# Names the row-cap wrapper binds. A user column with one of these names would
# hide the guard, so execute refuses it before running the write.
_GUARD_NAMES = frozenset({'_rr_rows', '_rr_d', '_rr_row'})


def _strip_statement(query: str) -> str:
    """Drop surrounding space and a trailing semicolon so the text can sit in CALL."""
    statement = query.strip()
    while statement.endswith(';'):
        statement = statement[:-1].rstrip()
    return statement


def _quote_name(name: str) -> str:
    """Backtick a result column so `n.id` and odd names stay one identifier."""
    return '`' + name.replace('`', '``') + '`'


# FalkorDB's parse_time_string reports `Invalid time string: <input>` when the
# argument is not a time. `_rr_execute_cap` takes that path: it has no colon
# and is not all digits. The Python client drops errCtx, so the cap check
# matches this substring and leaves every other server error alone.
# https://github.com/FalkorDB/FalkorDB/blob/master/graph/src/runtime/functions/temporal.rs
_CAP_ERROR = 'Invalid time string: _rr_execute_cap'
# Present only in a statement this module wrapped, so a user's own CALL is not
# mistaken for a server that lacks subqueries.
_GUARD_CALL = 'WHERE localtime(_rr_d) IS NOT NULL'


def _wrap_capped_query(statement: str, max_rows: int, columns: List[str]) -> str:
    """One atomic query that errors, and therefore rolls back, when too many rows return.

    ``collect([col, ...])`` keeps null cells. ``collect(col)`` would drop them and
    under-count. Both CASE branches are plain strings, so eager evaluation cannot
    fail them. ``localtime`` then rejects only the over-cap token, and the client
    reports that token. The call sits in WHERE so a planner cannot drop it.
    """
    quoted = [_quote_name(name) for name in columns]
    indented = []
    for line in statement.splitlines():
        if line:
            indented.append(f'  {line}')
        else:
            indented.append('')
    body = '\n'.join(indented)
    projected = ', '.join(f'_rr_row[{index}] AS {name}' for index, name in enumerate(quoted))
    return (
        'CALL {\n'
        f'{body}\n'
        '}\n'
        f'WITH * LIMIT {max_rows + 1}\n'
        f'WITH collect([{", ".join(quoted)}]) AS _rr_rows\n'
        f"WITH _rr_rows, CASE WHEN size(_rr_rows) > {max_rows} THEN '_rr_execute_cap' ELSE '00:00:00' END AS _rr_d\n"
        'WHERE localtime(_rr_d) IS NOT NULL\n'
        'UNWIND _rr_rows AS _rr_row\n'
        f'RETURN {projected}'
    )


def _guarded_statement(statement: str, max_rows: int, columns: List[str]) -> str:
    """Wrap ``statement`` so too many rows fail inside the query, or refuse a guard name."""
    reserved = _GUARD_NAMES.intersection(columns)
    if reserved:
        names = ', '.join(sorted(reserved))
        raise ValueError(f'EXECUTE query was not run because a result column uses a reserved name ({names})')
    return _wrap_capped_query(statement, max_rows, columns)


def _is_execute_cap_error(exc: BaseException) -> bool:
    """True when FalkorDB failed the row-cap guard, not the user's statement.

    The client surfaces ``Invalid time string: _rr_execute_cap`` and omits the
    failing expression. A division by zero, or ``localtime`` of any other value,
    stays a driver error.
    """
    return _CAP_ERROR in str(exc)


def _is_subquery_unsupported(exc: BaseException) -> bool:
    """True when the server rejected the wrapper's first line, not the user's text.

    FalkorDB reports ``Invalid input ... (line: 1, column: ...)``. The wrapper
    owns line 1 (``CALL {``); the user's statement is indented beneath it.
    """
    text = str(exc)
    if 'Invalid input' not in text:
        return False
    return 'line: 1' in text or 'line 1,' in text


def _structured_columns(plan: Any) -> Optional[List[str]]:
    """Result column names from the client's EXPLAIN tree.

    ``[]`` means the plan has no Project operator, so the statement returns no
    named columns and can be sent unchanged. ``None`` means the value is not a
    parsed tree. Column names are the Project node's children; the producer
    sits under the last column, so it is not itself a column.
    """
    root = getattr(plan, 'structured_plan', None)
    if root is None:
        return None
    project = _find_named(root, 'Project')
    if project is None:
        return []
    columns = []
    for child in getattr(project, 'children', []) or []:
        # An operator carries arguments (`Node By Label Scan | (n)`). A column does not.
        if getattr(child, 'args', None):
            continue
        name = getattr(child, 'name', None)
        if name:
            columns.append(str(name))
    return columns


def _find_named(op: Any, name: str) -> Any:
    """First operation named ``name`` in an EXPLAIN tree, or None."""
    if getattr(op, 'name', None) == name:
        return op
    for child in getattr(op, 'children', []) or []:
        found = _find_named(child, name)
        if found is not None:
            return found
    return None


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
