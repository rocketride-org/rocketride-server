# graph_falkordb

A RocketRide graph node that translates questions or agent calls into Cypher for FalkorDB; choose it when a FalkorDB graph is the data source rather than an ArangoDB database.

## About FalkorDB

FalkorDB is a graph database that uses Cypher queries and the Redis protocol. A server can host multiple named graphs, which this node can list and select.

## What it does

The node uses the required LLM connection to translate natural-language questions to Cypher, validates the result with `EXPLAIN`, and returns graph data through a pipeline or tools. It also provides a direct Cypher tool for callers that already have a query. Choose it over `graph_arango` for FalkorDB and Cypher; normal queries use the server’s read-only operation until writes are explicitly enabled.

## Connections

| Connection | Required | Description |
|---|---|---|
| `llm` | yes | LLM used to craft Cypher from a question. |

## Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `questions` | `table` | Emits a table result. |
| `questions` | `text` | Emits a text result. |
| `questions` | `answers` | Emits the answer result. |

## As a tool

The registered tool names are the bare method names below (an agent catalog namespaces them by the pipeline component id, not by the services.json `prefix`). It registers its FalkorDB-specific tools plus the inherited graph-tool surface.

| Function | Description |
|---|---|
| `get_data` | Requires a non-empty `question`; optional `limit` is clamped to the graph row cap (`max_rows`, kept below the server's `RESULTSET_SIZE`). Returns sanitized rows, generated query, applied limit, and truncation state; generation/execution failure returns `error`, `valid: false`, and no rows. |
| `get_schema` | Takes no meaningful arguments and returns reflected `labels`, node properties, and relationships, plus the version 2 `schema` block. |
| `refresh_schema` | Takes no arguments; re-reads the schema of the configured graph now and returns it like `get_schema`. |
| `get_query` | Requires a non-empty `question`, with optional `limit`; returns validated read-only Cypher and `valid: true`, or an `error`/off-topic `answer` with `valid: false`. |
| `read_query` | Requires non-empty `cypher`; accepts object `params` and integer `limit` (default 1,000, capped by `max_rows`, the server's `RESULTSET_SIZE` and 25,000). Always runs `GRAPH.RO_QUERY` on the configured graph, whatever `allow_writes` or `allow_execute` say, with the query timeout clamped to the server's `TIMEOUT_MAX`, and refuses `LOAD CSV`: it reads the graph only. Returns `{columns, rows, row_limit, truncated, truncated_by, element_limit, elements, value_limit, values}` in the shared graph result shape; failures raise an error whose first line is a headline (`Refused: …`, `Query timed out after N ms`, `Invalid read_query input: …`, `Query result cannot be represented`, `Query failed`) and whose remaining lines are the detail, the server's message where there is one. |
| `execute` | Requires raw `query` and runs it without LLM translation or the `read_query` statement rules (so `LOAD CSV` runs here); accepts an optional object `params` for `$name` placeholders; it raises an error unless `allow_execute` is enabled. In the default shape a read whose result exceeds the execute row cap (`max_execute_rows`, kept below the server's `RESULTSET_SIZE`) fails, and a write whose result exceeds it is already saved, so it returns the capped rows with `truncated: true`; a reply that reaches the server's `RESULTSET_SIZE` counts as over the cap. With `shape: "graph"` it returns the `read_query` shape plus `affected_rows`, cut at that cap and reported as `truncated_by: "rows"`. |
| `dialect` | Takes no meaningful arguments and returns `{dialect: "falkordb"}` plus the engine version, graph, capabilities, limits and read boundary. |
| `query` | Requires non-empty `cypher`; accepts optional object `params` and optional `graph`. Returns columns, serialized rows (at most `max_rows`, kept below the server's `RESULTSET_SIZE`), count, and truncation state; Redis failures return `error` with empty rows. With `allow_writes` off it runs `GRAPH.RO_QUERY`, so the server rejects writes; with `allow_writes` on it runs `GRAPH.QUERY` with the statement as written. |
| `list_graphs` | Takes no arguments and returns graph names, or `error` with an empty graph list on a Redis failure. |

In the `read_query` shape, node and relationship ids are FalkorDB's integer ids
as decimal strings (`WHERE id(n) = toInteger($id)`); they are live handles, not
durable keys, and node and relationship ids are separate counters. Labels are
sorted, relationship `start`/`end` keep the stored direction and paths keep
traversal order. Dates, local times and durations are tagged temporals (a
duration is its exact stored length, written as days and time). Datetimes are
reported in UTC. Points come back as plain `{latitude, longitude}` maps because
the client library does not keep the point type, and vectors as number lists.
A response stops at 10,000 graph elements or 500,000 values.

FalkorDB refuses a result that names the same column twice, so `read_query`
columns are always distinct here.

`read_query` also refuses, as `Invalid read_query input`, two kinds of code
text before the server is called: a number that runs straight into a letter, an
underscore or a `.` (the range `1..3` is fine), and a `/* … */` comment whose
text holds a `/` (use a `//` comment for text such as a URL).

`get_schema` and `refresh_schema` return the legacy `{labels, nodes,
relationships}` keys plus a `schema` block (version 2): labels and
relationship types with every observed property type (string, integer, float,
boolean, list, map, temporal, point), relationship endpoint label pairs seen on
sampled data, counts, and `sampled`, `truncated`, `refreshed_at`, `source`,
`stale`, `error` and `capable`. The schema is read at start and again on
`refresh_schema`, bounded to 200 labels, 100 relationship types and 100
sampled rows each, within a 60-second budget. A refresh is all-or-nothing:
if it fails or times out, the previous schema stays in place, marked `stale`
with the `error`; a schema that never loaded has `refreshed_at: null` and an
`error`, never an empty graph. Property types in the legacy keys now use the
same vocabulary (`string`, `integer`, ...) instead of engine type names.

`dialect` returns `dialect` plus `engine` (name, version, edition), `database`,
`graph`, `allow_execute`, `capabilities`, `limits` (default and maximum rows,
element and value budgets, statement timeout, server result cap; the default
is what `read_query` returns without a `limit`, 1,000 capped by the maximum) and
`read_boundary`/`read_boundary_verified`. It never includes hosts, users or
credentials.
On FalkorDB the schema comes from `db.labels()` and `db.relationshipTypes()`,
exact counts, and sampled properties and endpoints, every query a
`GRAPH.RO_QUERY` bounded by the statement timeout and what is left of the
refresh budget; a timeout fails the refresh instead of producing an empty
relationship list. `read_boundary` is `ro_command`. The natural-language tools
tell the model it is writing FalkorDB OpenCypher run as `GRAPH.RO_QUERY`.

`RESULTSET_SIZE` truncates a reply silently on the server, so the node reads it
(and `TIMEOUT_MAX`) with `GRAPH.CONFIG GET` at start and keeps every row cap one
row below it. `read_query`, `get_data`, `query` and `execute` with `shape:
"graph"` report a reply cut at their cap as truncated (`truncated_by: "rows"` in
the `read_query` shape). The questions lane is capped the same way but reports
no truncation: its lanes carry only text and tables. `execute` in its default
shape reads `RESULTSET_SIZE` again on every call and treats a reply that reaches it as over the cap; a read over
the cap fails, while a write over it is already saved (FalkorDB does not roll it back), so it returns its rows cut at
the cap with `truncated: true` and no error, and is never retried. Use `shape: "graph"` to get the first rows of
either as a `read_query` envelope.
Every query the node runs carries the query timeout clamped to `TIMEOUT_MAX`,
since the server refuses a larger one. `GRAPH.EXPLAIN` (the generated-query
check) and the start-up `GRAPH.CONFIG GET` and `MODULE LIST` calls run no query
and carry none.
Where `GRAPH.CONFIG` is not permitted the node assumes no server limit and says
so in a warning. The client buffers each whole reply, so the server's
`RESULTSET_SIZE` and the timeout are what bound server work and memory.

## Profiles

Default: **Manual configuration (host and port)** (`default`).

| Profile | Model | Context |
|---|---|---|
| `default` *(default)* | Manual configuration | Uses host and port fields. |
| `url` | FalkorDB URL | Uses the supplied connection string. |

## Configuration

Select Manual configuration for host and port fields, or the URL profile for a connection string. Both profiles include graph, LLM context, query safety, result caps, and timeout settings; begin with the defaults and adjust only for the actual graph and workload.

### Connection and credentials

The manual profile passes host, port, optional username/password, and TLS to the FalkorDB client. The URL profile requires a `falkor://`, `falkors://`, `redis://`, `rediss://`, or `unix://` URL. If a Password field is set with a URL, the node removes an embedded password and uses the field value, so the two cannot silently disagree.

### Graph description and retries

`graph` selects the named graph when a tool caller does not supply one, defaulting to `agent` when left blank. Unless `allow_writes` or `allow_execute` is on, the node checks at save time and at pipeline start that this graph actually exists on the server, since FalkorDB otherwise accepts a query against a missing graph and only fails later, on the first result, with a Redis-level error that gives no hint the graph itself was the problem. With a write path enabled, no such check runs, since FalkorDB creates a graph lazily on its first write. `db_description` is supplied to the LLM when it writes Cypher; add labels, relationships, and domain language when generation targets the wrong shape. `max_attempts` defaults to five and controls how often a rejected `EXPLAIN` result is repaired.

### Write access, row caps, and timeout

`allow_writes` defaults to false, using `GRAPH.RO_QUERY` so the server rejects write clauses. Enable it only for a trusted workload; direct `query` then uses `GRAPH.QUERY` and can return write statistics. `max_rows` caps the results of `get_data`, the questions lane, `query` and `read_query`; all but the questions lane mark a cut result as truncated. `max_execute_rows` caps what `execute` returns. FalkorDB saves a statement before it returns and cannot roll it back, so the cap applies to the reply: in the default shape a read over the cap fails, while a write over it returns the first rows with `truncated: true` and no error, because retrying a saved write would store it twice. With `shape: "graph"` the result is cut at the cap and reported as truncated, for reads and writes alike. Both caps stay one row below the server's `RESULTSET_SIZE`. `query_timeout_ms` bounds every server query, clamped to the server's `TIMEOUT_MAX`.

FalkorDB's own `RESULTSET_SIZE` setting (10,000 in the official Docker image) cuts a larger reply without saying so, and the caps are applied after the client has read the whole reply, so they do not limit what one query loads into worker memory. The two execute shapes learn that limit differently. The default shape reads `RESULTSET_SIZE` on every call (`GRAPH.CONFIG SET` changes it while the server runs) and treats a reply that reaches it as over the cap, since a complete reply of exactly that size looks the same. `shape: "graph"`, `read_query`, `get_data`, `query` and the questions lane use the value read once at pipeline start (`limits.server_result_cap` in `dialect`), so a limit changed while the pipeline runs is not seen by them until it restarts.

## Authentication

Manual connections can omit credentials or provide the configured username and password. URL connections may carry credentials, but the separate Password field takes precedence when present. The node probes the connection at startup, so malformed connection settings, an unavailable server, or (in read-only mode) a configured graph that does not exist all fail before a tool call, rather than surfacing as a Redis error on the first query.

## Notes

### Result representation

The direct query tool serializes graph nodes, relationships, paths, maps, lists, and temporal values into JSON-safe values. It returns no more than the configured row cap, allowing agents to recognize broad results through the `truncated` flag.

### Agents

An LLM agent wired to this node gets every tool listed under **As a tool** in
its tool catalog, `read_query` and `refresh_schema` included. With
`read_query` the agent runs Cypher it writes itself (read-only, up to 1,000
rows by default, capped by `max_rows`, which is 250 by default, within the
element and value budgets); `refresh_schema` re-reads the
schema each time it is called (refreshes of one node run one at a time, with
no cooldown). Say in the agent's instructions which tools it should prefer,
for example `get_data` for questions in plain language.

### Result size

The `read_query` budgets count values, not bytes: a string counts as one value
whatever its length. A result of 1,000 rows whose nodes each carry
100 KB of text is about 100 MB of JSON, which the engine builds in memory; the
Python SDK closes its connection above 250 MB. When nodes hold large text,
return the properties you need (`RETURN n.title` rather than `n`) or cut them
with `substring()`.

### Write counts

`affected_rows` (from `execute`, both shapes) is the sum of FalkorDB's write
statistics for the statement: nodes and relationships created and deleted,
properties set and removed, labels added and indices created. It counts
changes, not rows, and a read reports 0.

### How long a call can take

Each `read_query`, `execute` or `query` call is one command bounded by the
server's own timeout (the node's query timeout, clamped to the server's
`TIMEOUT_MAX`) and is never retried, so it ends within the
`statement_timeout_ms` that `dialect` reports plus the network round trip.
`get_data` and the questions lane run one such command once the LLM has
written the query and `EXPLAIN` has accepted it; the LLM calls are not
bounded by this timeout. `refresh_schema` waits up to 65 seconds
for another refresh of the same node to finish, then runs within its
60-second budget.

## Upstream docs

- [FalkorDB documentation](https://docs.falkordb.com/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `graph_falkordb.allow_execute` | `boolean` | **Allow Execute**<br/>Enable the execute tool, which runs raw Cypher with no LLM translation and no read-only gate. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. | `false` |
| `graph_falkordb.allow_writes` | `boolean` | **Allow Writes**<br/>Permit CREATE/MERGE/SET/DELETE in the query tool. When off, queries run via GRAPH.RO_QUERY and the server itself rejects write clauses. | `false` |
| `graph_falkordb.db_description` | `string` | **Graph Description**<br/>What is this graph used for? Describe its content and domain, this helps the LLM generate more accurate Cypher queries. | `""` |
| `graph_falkordb.graph` | `string` | **Default Graph**<br/>A FalkorDB server hosts many graphs. This is the one queried when the caller does not name another. | `"agent"` |
| `graph_falkordb.host` | `string` | **Host**<br/>FalkorDB host, e.g. localhost or your-instance.falkordb.cloud. | `"localhost"` |
| `graph_falkordb.max_attempts` | `integer` | **Max Validation Attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated Cypher query. | `5` |
| `graph_falkordb.max_execute_rows` | `integer` | **Max Execute Rows**<br/>Upper cap on rows returned by the execute tool, kept one row below the server's RESULTSET_SIZE. In the default shape a read over the cap fails, and a write over it is already saved, so it returns the first rows flagged as truncated. With shape "graph" the result is cut at the cap and reported as truncated. | `25000` |
| `graph_falkordb.max_rows` | `integer` | **Max Rows**<br/>Upper cap on rows returned by get_data, the questions lane, query and read_query. Results beyond it are cut; get_data, query and read_query flag them as truncated (the questions lane does not report it). It is kept one row below the server's RESULTSET_SIZE. | `250` |
| `graph_falkordb.password` | `string` | **Password**<br/>Password for the FalkorDB instance. Stored encrypted. When set it is the one used, replacing any password embedded in the FalkorDB URL. Leave empty for no auth, or to use the one the URL already carries. | `""` |
| `graph_falkordb.port` | `integer` | **Port**<br/>FalkorDB port (Redis protocol). FalkorDB Cloud assigns a per-instance port. | `6379` |
| `graph_falkordb.profile` | `string` | **Connection**<br/>How this node connects to FalkorDB | `"default"` |
| `graph_falkordb.query_timeout_ms` | `integer` | **Query Timeout (ms)**<br/>Server-side timeout for every query the node sends, clamped to the server's TIMEOUT_MAX. | `30000` |
| `graph_falkordb.tls` | `boolean` | **TLS**<br/>Connect with TLS. Required by FalkorDB Cloud TLS endpoints. | `false` |
| `graph_falkordb.url` | `string` | **FalkorDB URL**<br/>Connection string as shown in the FalkorDB Cloud console, e.g. falkor://falkordb@r-xxxx.instance-yyyy.cloud:53939. Use falkors:// for TLS. The URL may carry credentials, so it is stored encrypted; the password can also be left out of it and typed in the Password field below, which then replaces whatever the URL embeds. | `""` |
| `graph_falkordb.username` | `string` | **Username**<br/>Username, e.g. "default" for FalkorDB Cloud. Leave empty for no auth. | `""` |

## Dependencies

- `falkordb` `>=1.6.1,<2` (1.7.0 is the version the live suites are validated against)
- `redis` `>=7.1,<8`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/graph_falkordb)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
