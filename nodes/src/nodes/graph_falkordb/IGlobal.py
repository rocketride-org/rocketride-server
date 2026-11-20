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

import time

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import redis
from redis.exceptions import RedisError

from rocketlib import OPEN_MODE, debug, warning

from ai.common.graph import GraphGlobalBase
from ai.common.graph.adapters import falkordb_adapter
from ai.common.graph.graph_global_base import READ_QUERY_HARD_CAP
from ai.common.graph.schema import SCHEMA_LABEL_LIMIT, SCHEMA_REL_TYPE_LIMIT, SCHEMA_SAMPLE_SIZE
from ai.common.utils import config_int, parse_bool

from falkordb import FalkorDB

DEFAULT_PORT = 6379
DEFAULT_GRAPH = 'agent'
# Schemes falkordb-py accepts: falkor(s):// are its own aliases for redis(s)://.
URL_SCHEMES = ('falkor://', 'falkors://', 'redis://', 'rediss://', 'unix://')
DEFAULT_TIMEOUT_MS = 30000
DEFAULT_ROW_CAP = 250
# Statistics lines that describe how a statement ran, not what it changed.
# FalkorDB 6 adds "Graph version" to every reply, reads included.
RUN_STATS = ('cached execution', 'internal execution time', 'graph version')


class IGlobal(GraphGlobalBase):
    """FalkorDB-specific global connection state."""

    supports_execute_params = True

    client: Optional[FalkorDB] = None

    graph_name: str = DEFAULT_GRAPH
    allow_writes: bool = False
    max_rows: int = 250
    query_timeout_ms: int = DEFAULT_TIMEOUT_MS
    # Server limits read at start (None = unknown, e.g. GRAPH.CONFIG not permitted).
    # RESULTSET_SIZE truncates replies silently; TIMEOUT_MAX rejects larger
    # per-query timeouts. Every query the node runs honours both (see
    # statement_timeout_ms and _below_server_cap). GRAPH.EXPLAIN (the
    # generated-query check) and the start-up MODULE LIST / GRAPH.CONFIG GET
    # calls carry no per-query timeout: they run no query.
    server_result_cap: Optional[int] = None
    server_timeout_max_ms: Optional[int] = None
    server_version: Optional[str] = None

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
        self._read_server_limits()
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
                _close_client(self.client)
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
                    _close_client(client)
                except Exception:
                    pass

    @property
    def read_row_cap(self) -> int:
        """Node-owner ceiling on rows a read returns (get_data, the lane, query), kept below RESULTSET_SIZE."""
        return self._below_server_cap(self.max_rows)

    def _run_query(self, query: str, params: Optional[Dict] = None, limit: Optional[int] = None) -> List[Dict]:
        """Execute a read-only Cypher query through GRAPH.RO_QUERY.

        Read-only is enforced by the server, not by a regex: ro_query rejects
        write clauses even when a caller skips the client-side check.

        With ``limit`` set the caller wants truncation detection, so return one
        row past it (still bounded by ``read_row_cap``); with no limit (the lane
        path) fall back to the ``read_row_cap`` ceiling.
        """
        cap = self.read_row_cap if limit is None else min(int(limit), self.read_row_cap) + 1
        result = self.select_graph().ro_query(query, params=params or None, timeout=self.statement_timeout_ms)
        return self._rows_as_dicts(result, cap=cap)

    def _run_query_raw(self, query: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute a raw statement with writes allowed (the EXECUTE path).

        FalkorDB saves a statement before it returns and has no rollback, so a
        write is already stored when the row cap is checked. A result is over
        the cap when it passes ``max_execute_rows``, or when it reaches the
        server's ``RESULTSET_SIZE``: the server cuts a reply there without
        saying so. A read over the cap raises. A write over it returns the
        rows it has, at most ``max_execute_rows``, with ``'truncated': True``:
        an error there would make the caller retry a saved write and store it
        twice.

        Args:
            query (str): The raw Cypher statement.
            params (Optional[Dict[str, Any]]): Values for ``$name`` placeholders,
                bound through the client's ``CYPHER`` header.

        Returns:
            Dict[str, Any]: ``{'rows': [...], 'affected_rows': int}``, plus
            ``'truncated': True`` for a write over the cap.

        Raises:
            ValueError: A read result is over the cap.
        """
        max_rows = self.max_execute_rows
        server_cap = self._server_reply_cap()
        result = self.select_graph().query(query, params=params or None, timeout=self.statement_timeout_ms)

        rows = self._rows_as_dicts(result, cap=max_rows + 1)
        # Count writes unconditionally: unlike SQL, a Cypher write commonly also
        # returns rows (CREATE (n) RETURN n), so `rows` being non-empty does not
        # mean nothing was written. _affected_rows is 0 for a pure read anyway.
        affected = _affected_rows(result)
        if len(rows) > max_rows:
            read_error = f'EXECUTE query exceeded max_execute_rows={max_rows}'
            write_note = f'EXECUTE result cut to max_execute_rows={max_rows}; the statement is saved'
        elif server_cap is not None and len(result.result_set or []) >= server_cap:
            # A reply of exactly RESULTSET_SIZE rows reads the same whether it is complete or cut.
            read_error = (
                f'EXECUTE query reached the server RESULTSET_SIZE={server_cap}, so its result may be cut; '
                'add LIMIT or raise RESULTSET_SIZE'
            )
            write_note = f'EXECUTE result reached the server RESULTSET_SIZE={server_cap}; the statement is saved'
        else:
            return {'rows': rows, 'affected_rows': affected}

        if not _wrote(result):
            raise ValueError(read_error)

        warning(write_note)
        return {'rows': rows[:max_rows], 'affected_rows': affected, 'truncated': True}

    # ------------------------------------------------------------------
    # read_query / execute(shape='graph')
    # ------------------------------------------------------------------

    def _read_server_limits(self) -> None:
        """Best effort: learn RESULTSET_SIZE and TIMEOUT_MAX so limits stay honest, and the module version."""
        self.server_result_cap = self._config_value('RESULTSET_SIZE')
        self.server_timeout_max_ms = self._config_value('TIMEOUT_MAX')
        self.server_version = None
        try:
            for module in self.client.connection.execute_command('MODULE', 'LIST') or []:
                fields = dict(zip(module[0::2], module[1::2]))
                name = fields.get('name', fields.get(b'name'))
                if name in ('graph', b'graph'):
                    ver = int(fields.get('ver', fields.get(b'ver')))
                    self.server_version = f'{ver // 10000}.{ver // 100 % 100}.{ver % 100}'
        except Exception:  # descriptive only; MODULE LIST may be disabled on managed services
            self.server_version = None

    def _config_value(self, name: str) -> Optional[int]:
        try:
            reply = self.client.connection.execute_command('GRAPH.CONFIG', 'GET', name)
        except Exception as e:  # managed services may refuse GRAPH.CONFIG
            warning(f'FalkorDB: could not read {name} ({e}); assuming no server limit')
            return None
        try:
            value = int(reply[1])
        except (TypeError, ValueError, IndexError):
            return None
        # FalkorDB uses 0 (TIMEOUT_MAX) or a negative number (RESULTSET_SIZE) for "unlimited".
        return value if value > 0 else None

    @property
    def statement_timeout_ms(self) -> int:
        """Per-query timeout actually sent: the node's, clamped to the server's TIMEOUT_MAX."""
        if self.server_timeout_max_ms:
            return max(1, min(self.query_timeout_ms, self.server_timeout_max_ms))
        return self.query_timeout_ms

    def _below_server_cap(self, cap: int) -> int:
        """``cap``, kept below the server's RESULTSET_SIZE so the +1 sentinel row can arrive.

        The server cuts every reply (GRAPH.QUERY and GRAPH.RO_QUERY alike) at
        RESULTSET_SIZE without any marker; one row under it, a reply the
        server cut reads as truncated (or, for legacy execute, as over the cap).
        """
        if self.server_result_cap:
            cap = min(int(cap), self.server_result_cap - 1)
        return max(1, int(cap))

    @property
    def read_query_cap(self) -> int:
        """Node cap (at most 25,000), kept below the server's RESULTSET_SIZE."""
        return self._below_server_cap(min(self.max_rows, READ_QUERY_HARD_CAP))

    @property
    def execute_graph_cap(self) -> int:
        """max_execute_rows, kept below RESULTSET_SIZE (execute in either shape)."""
        return self._below_server_cap(self.max_execute_rows)

    def _graph_adapter(self):
        return falkordb_adapter()

    def _read_query_rows(self, cypher, params, fetch_limit, consume):
        """Always GRAPH.RO_QUERY, whatever allow_writes says; the server refuses writes.

        The client buffers the whole reply before returning, so the row bound
        that limits server work and memory is the server's RESULTSET_SIZE and
        the timeout; slicing below only limits what is serialized.
        """
        result = self.select_graph().ro_query(cypher, params=params or None, timeout=self.statement_timeout_ms)
        columns = _header_names(getattr(result, 'header', None))
        return consume(columns, iter((result.result_set or [])[:fetch_limit]))

    def _raw_query_rows(self, cypher, fetch_limit, consume, params=None):
        result = self.select_graph().query(cypher, params=params or None, timeout=self.statement_timeout_ms)
        columns = _header_names(getattr(result, 'header', None))
        return consume(columns, iter((result.result_set or [])[:fetch_limit])), _affected_rows(result)

    def _describe_error(self, exc):
        if not isinstance(exc, RedisError):
            return None
        detail = str(exc).strip()
        lowered = detail.lower()
        if 'timed out' in lowered:
            return f'Query timed out after {self.statement_timeout_ms} ms', detail
        if 'read-only queries' in lowered or 'ro_query' in lowered:
            return 'Refused: read_query is read-only; this statement writes', detail
        return 'Query failed', detail

    def _validate_query(self, query: str) -> Tuple[bool, str]:
        """Check syntax with EXPLAIN without running the query."""
        try:
            self.select_graph().explain(query)
            return True, ''
        except RedisError as e:
            return False, str(e)
        except Exception as e:
            return False, str(e)

    def _reflect_schema_v2(self, builder, deadline):
        """Labels and relationship types, exact counts, sampled properties and endpoints.

        Every query is a GRAPH.RO_QUERY whose timeout is the smaller of the
        statement timeout and what is left of the refresh budget; a timeout or
        any error fails the whole refresh (never a silently empty list).
        """
        graph = self.select_graph()

        def run(cypher: str):
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                raise TimeoutError('schema refresh budget exhausted')
            return graph.ro_query(cypher, timeout=max(1, min(self.statement_timeout_ms, remaining_ms))).result_set or []

        labels = sorted(str(row[0]) for row in run('CALL db.labels()') if row)
        if len(labels) > SCHEMA_LABEL_LIMIT:
            builder.truncated = True
            labels = labels[:SCHEMA_LABEL_LIMIT]
        for label in labels:
            if '`' in label:
                # FalkorDB cannot quote a back-quote inside an identifier.
                builder.label(label)
                builder.truncated = True
                continue
            builder.label(label, count=run(f'MATCH (n:`{label}`) RETURN count(n)')[0][0])
            for row in run(f'MATCH (n:`{label}`) WITH n LIMIT {SCHEMA_SAMPLE_SIZE} RETURN properties(n)'):
                builder.sample_label_properties(label, row[0])

        rels = sorted(str(row[0]) for row in run('CALL db.relationshipTypes()') if row)
        if len(rels) > SCHEMA_REL_TYPE_LIMIT:
            builder.truncated = True
            rels = rels[:SCHEMA_REL_TYPE_LIMIT]
        for rel in rels:
            if '`' in rel:
                builder.rel_type(rel)
                builder.truncated = True
                continue
            builder.rel_type(rel, count=run(f'MATCH ()-[r:`{rel}`]->() RETURN count(r)')[0][0])
            for start_labels, end_labels, props in run(
                f'MATCH (a)-[r:`{rel}`]->(b) WITH a, r, b LIMIT {SCHEMA_SAMPLE_SIZE} '
                'RETURN labels(a), labels(b), properties(r)'
            ):
                for start in start_labels or ['']:
                    for end in end_labels or ['']:
                        builder.endpoint(rel, start, end, observed=True)
                builder.sample_rel_properties(rel, props)

    def _engine_identity(self):
        return {
            'engine': {'name': 'FalkorDB', 'version': self.server_version, 'edition': None},
            'database': None,
            'graph': self.graph_name,
            'read_boundary': 'ro_command',
            'read_boundary_verified': False,
            'shortest_path': True,
            'server_result_cap': self.server_result_cap,
        }

    def _prompt_rules(self):
        return [
            f'The database is FalkorDB{" " + self.server_version if self.server_version else ""}; write OpenCypher.',
            'Queries run as GRAPH.RO_QUERY: only read clauses (MATCH, OPTIONAL MATCH, WITH, UNWIND, RETURN).',
            'Refer to nodes by id(n); compare with toInteger($id) when the id is a string.',
        ]

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

    def _server_reply_cap(self) -> Optional[int]:
        """Return the server's ``RESULTSET_SIZE``, the row count it cuts every reply to.

        Read on every call rather than once at connect, because
        ``GRAPH.CONFIG SET`` changes it while the server runs.

        Returns:
            Optional[int]: The limit, or None when the server sets none (``-1``)
            or the value cannot be read (for example, an ACL that denies
            ``GRAPH.CONFIG``).
        """
        try:
            size = int(self.client.config_get('RESULTSET_SIZE'))
        except (RedisError, TypeError, ValueError) as e:
            debug(f'FalkorDB RESULTSET_SIZE is unreadable, so a reply the server cuts is not detected: {e}')
            return None
        return size if size > 0 else None

    @classmethod
    def _connect(cls, config: Dict[str, Any]) -> FalkorDB:
        """Open a client from whichever profile is configured: URL or host/port."""
        url = _connection_url(config)
        if not url:
            return FalkorDB(**cls._client_kwargs(config))

        # Do NOT strip the password — whitespace is valid in passwords.
        password = str(config.get('password') or '')
        if not password:
            return _client_from_url(url)

        # A filled-in password field is the one that counts, so drop whatever the
        # URL embeds: redis-py would otherwise prefer the URL and ignore the field.
        return _client_from_url(_url_without_password(url), password=password)

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


def _header_names(header) -> List[str]:
    """Extract column names from a QueryResult header ([type, name] pairs or strings)."""
    names = []
    for entry in header or []:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            names.append(str(entry[1]))
        else:
            names.append(str(entry))
    return names


def _client_from_url(url: str, **kwargs: Any) -> FalkorDB:
    """Open a client from a URL without ``FalkorDB.from_url``'s temporary client.

    ``FalkorDB.from_url`` builds a throwaway ``redis.Redis`` that owns the
    connection pool, then gives the same pool to the client it returns. The
    throwaway is garbage collected soon after (a reference cycle can keep it for
    a while), and its ``__del__`` disconnects the pool, which is now the live
    client's: a reply being read at that moment dies with
    ``'NoneType' object has no attribute 'readline'``. The collector runs most
    readily while a large reply is being parsed, because parsing allocates a lot.
    Here the owner is kept, on the client, until ``_close_client`` closes it.

    Args:
        url (str): The connection URL (``falkor://``, ``redis://`` and the TLS forms).
        **kwargs (Any): Passed to ``redis.Redis.from_url`` (for example ``password``).

    Returns:
        FalkorDB: The client; close it with ``_close_client``.
    """
    if url.startswith('falkor://'):
        url = 'redis://' + url[len('falkor://') :]
    elif url.startswith('falkors://'):
        url = 'rediss://' + url[len('falkors://') :]
    owner = redis.Redis.from_url(url, decode_responses=True, **kwargs)
    client = FalkorDB(connection_pool=owner.connection_pool)
    client._rr_pool_owner = owner
    return client


def _close_client(client: FalkorDB) -> None:
    """Close a client and the pool its URL-built owner holds (best effort, as the client's own close is)."""
    try:
        client.close()
    finally:
        owner = getattr(client, '_rr_pool_owner', None)
        if owner is not None:
            try:
                owner.close()
            except RedisError:
                pass


def _wrote(result) -> bool:
    """Tell whether a QueryResult reports any change to the graph.

    Reads every statistics line of the reply, so a write counter missing from
    _affected_rows (for example, one a newer server adds) still counts as a
    write. Only the RUN_STATS lines are skipped. A line it cannot read counts as
    a change: taking a write for a read would raise, and the caller's retry
    would store the write twice.

    Args:
        result: A falkordb QueryResult.

    Returns:
        bool: True when some line reports a non-zero change. Falls back to
        _affected_rows when the client exposes no raw statistics lines.
    """
    lines = getattr(result, '_raw_stats', None)
    if not isinstance(lines, (list, tuple)):
        return _affected_rows(result) > 0
    for line in lines:
        text = line.decode('utf-8', 'replace') if isinstance(line, bytes) else str(line)
        name, _, value = text.partition(':')
        if any(stat in name.lower() for stat in RUN_STATS):
            continue
        try:
            if float(value.split()[0]) != 0:
                return True
        except (IndexError, ValueError):
            return True
    return False


def _affected_rows(result) -> int:
    """Sum the write counters of a QueryResult (CREATE/DELETE/SET return no rows).

    This is the ``affected_rows`` number the caller sees. Whether the statement
    wrote at all is decided by _wrote, which also counts lines this list lacks.
    """
    total = 0
    for attr in (
        'nodes_created',
        'nodes_deleted',
        'relationships_created',
        'relationships_deleted',
        'properties_set',
        'properties_removed',
        'labels_added',
        'labels_removed',
        'indices_created',
        'indices_deleted',
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
