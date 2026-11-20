# graph_neo4j

A RocketRide graph and tool node that uses a connected LLM to answer
natural-language questions against a Neo4j graph database. Pick it for
knowledge-graph retrieval when Cypher generation and graph-schema awareness are
more useful than a native memory-store search.

## About Neo4j

Neo4j is a graph database accessed here through its Python driver and Bolt
connection protocol. Its data model represents nodes and the relationships
between them, which this node reflects for use in generated Cypher queries.

## What it does

On the `questions` lane, the node gives a connected LLM the reflected graph
schema and turns the question into a read-only Cypher query. It can emit query
results on `table`, `text`, and `answers`, and it exposes the same graph access
to agents as tools. Choose it over `graph_hydradb` when you need questions
translated to Cypher for an existing Neo4j graph; HydraDB instead offers native
memory operations and no data lanes.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used to generate Cypher from natural-language questions. |

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `table` | Emit executed query results as a Markdown table. |
| `questions` | `text` | Emit the result as text. |
| `questions` | `answers` | Emit executed results as a Markdown table, or an LLM reply when no graph query is produced. |

For regular questions, the LLM generates and validates Cypher before the node
runs it. A `DIALECT` question emits `{"dialect": "neo4j"}` on `answers`.
An `EXECUTE` question is handled separately and runs its text as raw Cypher
only when **Allow direct query execution** is enabled.

## As a tool

The registered tool names are the bare method names below (an agent catalog
namespaces them by the pipeline component id, not by the services.json
`prefix`). There is no configurable tool-server-name field.

| Function | Description |
| --- | --- |
| `get_data` | Turn a natural-language request into a read-only Cypher query, run it, and return rows. |
| `get_schema` | Return the reflected labels, properties, and relationship types. |
| `refresh_schema` | Re-read the schema now and return it like `get_schema`. |
| `get_query` | Return generated read-only Cypher without executing it. |
| `read_query` | Run Cypher you wrote, read-only, and return positional rows in the shared graph result shape. |
| `execute` | Run raw Cypher only when direct execution is enabled. |
| `dialect` | Return `{"dialect": "neo4j"}` plus the engine version and edition, database, capabilities, limits and read boundary. |
| `get_cypher` | Deprecated compatibility alias for `get_query`; it also includes the statement under `cypher`. |

`get_data`, `get_query`, and `get_cypher` require a non-empty `question` and
accept an optional integer `limit`; absent or invalid limits resolve to 250 and
the maximum is 25,000. `get_data` returns `{valid, rows, query, row_limit,
truncated}` on success. Failed validation or execution returns `valid: false`
with `error`; a non-graph question returns `valid: false` with an `answer`
instead of rows.

`get_schema` accepts an optional `label`; an unknown label returns an `error`,
otherwise the response includes `{database, labels, nodes, relationships}`.
`execute` requires a non-empty raw `query`, accepts an optional object `params`
whose values bind to `$name` placeholders, and returns `{rows, affected_rows}`;
it raises an error while direct execution is disabled. With `shape: "graph"`
it returns the `read_query` result shape plus `affected_rows` instead.

`read_query` takes `{cypher, params?, limit?}`: one statement, values bound as
`$name` parameters (ids as strings: `WHERE elementId(n) = $id`), and a row
limit that defaults to 1,000 and is capped by the node (at most 25,000). It
returns `{columns, rows, row_limit, truncated, truncated_by, element_limit,
elements, value_limit, values}`. Rows are positional. Nodes, relationships and
paths carry their `elementId` as `id` (a live handle, not a durable key), sorted
labels, stored relationship direction and traversal-ordered paths. Temporal
values keep nanoseconds and named zones, points keep their SRID, integers
beyond 2^53 and NaN/Infinity are tagged as text, and byte arrays are reported
as base64 (size only above 64 KiB). A response stops at 10,000 graph elements
or 500,000 values (`truncated_by` says which limit applied). It is read-only
whatever `allow_execute` says: write, administration and `USE` clauses and any
`CALL` outside `db.labels`, `db.relationshipTypes`, `db.propertyKeys`,
`db.schema.nodeTypeProperties`, `db.schema.relTypeProperties` and
`db.schema.visualization` are refused before the query is sent, and so, as
invalid input, is a number written straight against a letter, an underscore or
a `.`, or a `/* … */` comment whose text holds a `/`; it then runs
in a READ-mode transaction with a 30-second server-side deadline. Failures
raise an error whose first line is a short headline (`Refused: …`,
`Query timed out after 30000 ms`, `Invalid read_query input: …`,
`Query result cannot be represented` (a value the database returned does not
fit the result shape) or `Query failed`) and whose remaining lines are the
detail, the database's own message where there is one.

Neo4j refuses a result that names the same column twice, so `read_query`
columns are always distinct here (rows stay positional all the same).

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
element and value budgets, statement timeout, server result cap) and
`read_boundary`/`read_boundary_verified`. It never includes hosts, users or
credentials.
On Neo4j the schema comes from `db.labels()` and `db.relationshipTypes()` (raw
names, so `get_schema` with `label` matches the label as stored), exact counts
from the count store, and properties and endpoints sampled in one read
transaction whose server-side timeout is the refresh budget. `read_boundary` is
`database_role` with `read_boundary_verified: true` only when the server is
Enterprise and the node's own privileges (`SHOW USER PRIVILEGES`) grant
nothing beyond reading; otherwise it is `read_session`. The natural-language
tools tell the model it is writing Neo4j Cypher for the server's version and
which procedures it may call. `dialect` accepts no
meaningful arguments. Generation failures return an error rather than an
executable query, and `get_cypher` preserves those outcomes while adding
`cypher` when a query is available.

## Configuration

Start with a working Bolt URI and authentication method, then describe the
graph so the LLM has useful domain context. The generated schema below lists
the fields; these settings control connection validation, generated-query
quality, and the intentionally restricted direct-execution path.

### Connection URI and database

**Connection URI** defaults to `neo4j://localhost:7687`; use the `neo4j://` or
`bolt://` forms for plaintext connections and the `neo4j+s://` or `bolt+s://`
forms for TLS. **Database name** defaults to `neo4j`. Change either to point at
the instance and database containing the graph the node should query. At
startup and when saving configuration, the driver verifies connectivity and
runs `RETURN 1` against that specific database, so a wrong database name or
missing access surfaces before the first question.

### Graph description

**Graph description** is appended to the LLM's query-generation context, along
with the reflected labels, property types, and relationships. Leave it empty
when the schema is self-explanatory; add a concise description of the graph's
domain when labels alone would be ambiguous. This helps the LLM choose the
correct interpretation, but it cannot replace a connection that exposes the
actual schema.

### Max validation attempts

**Max validation attempts** controls how many times a rejected generated query
is repaired after Neo4j rejects it under `EXPLAIN`. The setting defaults to 5
and accepts 1–10, the range the runtime applies: a value above 10 saved by an
earlier version of this form, or set in a pipeline file, still runs as 10.
Increase it only if valid requests routinely
need additional repair attempts, since each retry calls the LLM and delays the
answer. When all attempts fail, the node returns the database error rather than
running the last rejected query.

### Allow direct query execution

**Allow direct query execution** is off by default. Keep it off for normal
agent and lane traffic: generated reads pass the Cypher safety gate and use a
READ access-mode session. Turn it on only for a trusted caller that must issue
raw Cypher through `execute` or `QuestionType.EXECUTE`, because that path skips
both LLM translation and the read-only gate and can write to the database.
Raw execution is still limited to 25,000 returned rows. In the default shape,
exceeding that limit raises an error and rolls the statement back, so nothing
is saved and a retry is safe; with `shape: "graph"` the result is cut at 25,000
rows and reported as truncated (`truncated_by: "rows"`), and what the statement
wrote stands. Batched statements are the exception: `CALL { ... } IN
TRANSACTIONS` and, on Neo4j 4, `USING PERIODIC COMMIT`. Neo4j commits each
batch as it runs, so a retry after the error can repeat writes; keep what these
statements return under the limit.

## Authentication

Choose **Username & Password** (the default) to send the configured user and
password to the driver; a blank user resolves to `neo4j`. Choose **Bearer
Token** to use the configured token through `neo4j.bearer_auth`. The save-time
probe reports authentication, connectivity, and Neo4j errors as warnings;
pipeline startup then fails fast if the configured server or database cannot
be verified.

## Limitations

The `noremote` capability pins this node to the local worker because it holds a
database client and credentials. `read_query` refuses write, administration
and `USE` clauses and any `CALL` outside a short list of read-only schema
procedures, then runs in a READ access-mode transaction; the ordinary
graph-query flow uses a client-side best-effort blacklist for selected write
and administrative clauses and Neo4j READ access mode. None of these is a
guaranteed read-only boundary: READ
access controls routing, not permissions, and a statement check cannot know
every mutating function a server may have installed. **The boundary is the
database user**: for browsing, connect with an identity whose Neo4j role can
only read (for example the built-in `reader` role, Neo4j Enterprise or Aura;
Community Edition has no roles). This was tested against Neo4j 5.26
Enterprise with the built-in `reader` role: the database refused `CREATE`,
`MERGE`, `SET`, `REMOVE`, `DELETE` and `CALL db.createLabel(...)` even with the
node's own checks and READ mode removed, and `dialect` reported
`read_boundary: "database_role"` with `read_boundary_verified: true` only for
that user. Enabling direct execution grants trusted
callers an explicit write-capable escape hatch, and it cannot write through a
read-only identity: to offer both browsing and writing, configure two nodes,
one with a read-only identity and one with a write identity and **Allow direct
query execution** on.

Neo4j's default `PUBLIC` role grants the `LOAD` privilege, so a read-only
identity used with **Allow direct query execution** on can still run
`LOAD CSV` through `execute`. That reads server-side or remote files; it never
writes the graph. `read_query` refuses `LOAD CSV` regardless. Operators who
want the identity to have no file or URL access should run
`REVOKE LOAD ON ALL DATA FROM PUBLIC`. The privilege self-check behind
`read_boundary_verified` treats `LOAD` as non-writing, so it does not stop a
reader identity from counting as verified.

## Notes

### Schema reflection and query generation

At startup, and on `refresh_schema`, the node reads labels and relationship
types with `db.labels()` and `db.relationshipTypes()` and samples properties
and endpoints (see **As a tool**). Reflection failure only warns and records the
error in the schema block, so the connection can continue but the LLM has less
structure to ground its Cypher generation.

The LLM is instructed to generate queries only from the reflected schema;
generated output is checked for unsafe clauses after comments are removed and
validated with `EXPLAIN`. The safety
gate rejects `CREATE`, `MERGE`, `DELETE`, `SET`, `DROP`, and other write or
admin clauses including mutating `apoc` procedures. The actual read query has a
30-second timeout and the implementation returns one row beyond the requested
limit to report `truncated` correctly.

### Result serialization

`get_data` and the default `execute` keep their established format: nodes
include `_labels`, relationships include `_type`, paths become
`{nodes, relationships}`, and temporal values use their ISO representation.
`read_query` and `execute` with `shape: "graph"` use the shared graph result
shape described under **As a tool**, which keeps ids, endpoints, direction,
points, durations and large integers that the established format loses.
Tested with the `neo4j` Python driver 6.3.1 against Neo4j 5.26 Community;
Neo4j 5 is the minimum (`elementId`). For raw execution, `affected_rows`
counts the changes in the Neo4j result summary (see **Write counts**).

### Agents

An LLM agent wired to this node gets every tool listed under **As a tool** in
its tool catalog, `read_query` and `refresh_schema` included. With
`read_query` the agent runs Cypher it writes itself (read-only, 1,000 rows by
default, within the element and value budgets); `refresh_schema` re-reads the
schema each time it is called (refreshes of one node run one at a time, with
no cooldown). Say in the agent's instructions which tools it should prefer,
for example `get_data` for questions in plain language.

### Result size

The `read_query` budgets count values, not bytes: a string counts as one value
whatever its length (byte arrays above 64 KiB are reported by size only). A result of 1,000 rows whose nodes each carry
100 KB of text is about 100 MB of JSON, which the engine builds in memory; the
Python SDK closes its connection above 250 MB. When nodes hold large text,
return the properties you need (`RETURN n.title` rather than `n`) or cut them
with `substring()`.

### Write counts

`affected_rows` (from `execute`, both shapes) is the sum of the write counters
in the Neo4j result summary: nodes and relationships created and deleted,
properties set, labels added and removed. It counts changes, not rows:
`CREATE (n:Note {a: 1, b: 2})` reports 4 (one node, two properties, one
label), and a read reports 0.

### How long a call can take

`read_query` runs in a managed read transaction with a 30-second server-side
deadline per attempt, and the driver retries transient failures (such as a
cluster leader change) within its own retry window, 30 seconds by default. A
call can therefore take longer than the `statement_timeout_ms` that `dialect`
reports. `refresh_schema` waits up to 65 seconds for another refresh of the
same node to finish, then runs within its 60-second budget. A client that
stops waiting earlier only stops waiting: the database ends the transaction
at its own deadline.

## Upstream docs

- [Neo4j Python driver documentation](https://neo4j.com/docs/python-manual/)
- [Cypher manual](https://neo4j.com/docs/cypher-manual/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `graph_neo4j.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw Cypher without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. | `false` |
| `graph_neo4j.auth_method` | `string` | **Authentication** | `"userpass"` |
| `graph_neo4j.database` | `string` | **Database name**<br/>Name of the Neo4J database to connect to. Use 'neo4j' for the default database. | `"neo4j"` |
| `graph_neo4j.db_description` | `string` | **Graph description**<br/>What is this graph used for? Describe its content and domain, this helps the LLM generate more accurate Cypher queries. | `""` |
| `graph_neo4j.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated Cypher query | `5` |
| `graph_neo4j.password` | `string` | **Password**<br/>Password to authenticate with the Neo4J instance. |  |
| `graph_neo4j.profile` | `string` |  | `"default"` |
| `graph_neo4j.token` | `string` | **Bearer token**<br/>Bearer token for token-based authentication (e.g. Neo4J Aura cloud). |  |
| `graph_neo4j.uri` | `string` | **Connection URI**<br/>Bolt URI for the Neo4J instance. Use neo4j:// or bolt:// for plaintext, neo4j+s:// or bolt+s:// for TLS (e.g. Neo4J Aura cloud) | `"neo4j://localhost:7687"` |
| `graph_neo4j.user` | `string` | **User**<br/>Username to authenticate with the Neo4J instance. | `"neo4j"` |

## Dependencies

- `neo4j` `==6.3.1`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/graph_neo4j)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
