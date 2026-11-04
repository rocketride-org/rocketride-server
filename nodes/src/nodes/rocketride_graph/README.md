# rocketride_graph

A RocketRide graph database node for natural-language Cypher queries against
the Apache AGE graph in a managed RocketRide database: your organization's, your
team's or your own (see Database). Pick it over rocketride_sql when
relationships and traversals are the data model.

## What it does

The node accepts questions, asks its required LLM to generate read-only Cypher,
translates it to Apache AGE SQL, and returns rows as a table, text, or answer.
It also exposes graph discovery and query functions to an agent. Use it for
graph labels, relationships, and multi-hop traversal; use rocketride_sql for
relational SQL or rocketride_vector for embedding-backed document retrieval.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| llm | yes | Produces Cypher from a natural-language question. |

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| questions | table | Returns an executed graph-query result as a Markdown table. |
| questions | text | Returns the graph-query result as text. |
| questions | answers | Returns the graph-query result on the answers lane. |

## As a tool

The inherited graph functions are registered under the bare names below; this
node defines no configurable server-name prefix. Inputs are JSON objects.

| Function | Description |
| --- | --- |
| get_data | Converts required natural-language question to a safe read-only Cypher query and returns rows; limit is optional. |
| get_schema | Returns the discovered labels, sampled node properties, and relationships, plus the version 2 schema block. |
| refresh_schema | Re-reads the schema now and returns it like get_schema. |
| get_query | Converts required natural-language question to read-only Cypher without executing it; limit is optional. |
| read_query | Runs required `cypher` you wrote, read-only, with optional `params` and `limit`, and returns positional rows in the shared graph result shape. |
| execute | Runs required raw Cypher query when direct execution is enabled; optional params binds `$name` values (for example `{"rows": [...]}` for `UNWIND $rows`), which need no escaping and do not count toward the 10,000-character query limit (params JSON is capped at 8 MiB). The statement may also be sent as sql, the key client.database.query uses; session_id and row_mode 'array' are refused, because graph nodes have no transactions and return row objects. If the result has more rows than the execute row limit, the call fails and nothing is saved; with shape "graph" the result is cut at that limit and marked truncated instead, and what the statement wrote stands. Remove repeated keys first, on both AGE versions: on 1.5.0, `UNWIND $rows ... MERGE` creates duplicates when rows repeat a key; on 1.6.0, rows that repeat a key keep only one write. |
| dialect | Returns {"dialect": "age"} plus the AGE version, database and graph names, capabilities, limits and read boundary. |

get_data defaults to the shared read limit, then clamps the requested limit to
the configured Max read rows ceiling. A successful result contains
{valid, rows, query, row_limit, truncated}. Generation, validation, or
execution failure returns {valid: false, error, query, rows: []}; a non-graph
question may instead carry an LLM answer with valid: false.

get_query returns {query, valid: true} only after its safe-query checks.
execute bypasses the read-only gate but still passes Cypher through the AGE
translation and resource limits; it raises if direct execution is disabled or
the input is invalid, and otherwise returns {rows, affected_rows}.
With shape "graph" it returns the read_query shape plus affected_rows (the
number of result rows, as AGE reports no write counters).

read_query takes {cypher, params?, limit?}. The limit defaults to 1,000 and is
capped by Max read rows (at most 25,000); it is applied as an outer SQL LIMIT
so the database stops early. It always uses the safe translation path and a
READ ONLY transaction with the query timeout, whatever allow_execute says.
A number written straight against a letter, an underscore or a `.`, or a
`/* … */` comment whose text holds a `/`, is refused as invalid input before
translation.
It returns {columns, rows, row_limit, truncated, truncated_by, element_limit,
elements, value_limit, values}. Rows are positional, so a result that names
the same column twice keeps both. Graph ids are AGE's 64-bit graphids as
decimal strings (they pass 2^53 from about the 32nd label); look nodes up with
WHERE id(n) = toInteger($id). Paths keep traversal order and relationships
their stored direction; integers beyond 2^53, NaN, Infinity and exact
numerics are tagged as text. A response stops at 10,000 graph elements or
500,000 values. Failures raise an error whose first line is a headline:
"Refused: …" for a write, `LOAD CSV` (read_query reads the graph only) or a
firewall rule, "Not supported on Apache AGE
1.5.0: <construct>" followed by what to write instead (for example for
date(), duration(), elementId(), list or pattern comprehensions,
allShortestPaths and EXISTS subqueries, which AGE 1.5.0 cannot run),
"Invalid Cypher for Apache AGE" for any other statement the translator
cannot read (a syntax error, for example), "Query timed out after N ms",
"Invalid read_query input: …", "Query result cannot be represented" (the
statement was valid, and on execute it ran, but a value it returned could
not be decoded), "Database busy: no connection became free in time" (see
**How long a call can take**), "The graph node is
shutting down" (a call that arrives while the pipeline stops) or "Query
failed"; the remaining lines are the detail.

get_schema and refresh_schema return the legacy {labels, nodes,
relationships} keys plus a schema block (version 2): labels and
relationship types with every observed property type (string, integer, float,
boolean, list, map, temporal, point), relationship endpoint label pairs seen on
sampled data, counts, and sampled, truncated, refreshed_at, source,
stale, error and capable. The schema is read at start and again on
refresh_schema, bounded to 200 labels, 100 relationship types and 100
sampled rows each, within a 60-second budget. A refresh is all-or-nothing:
if it fails or times out, the previous schema stays in place, marked stale
with the error; a schema that never loaded has refreshed_at: null and an
error, never an empty graph. Property types in the legacy keys now use the
same vocabulary (string, integer, ...) instead of engine type names.

dialect returns dialect plus engine (name, version, edition), database,
graph, allow_execute, capabilities, limits (default and maximum rows,
element and value budgets, statement timeout, server result cap) and
read_boundary/read_boundary_verified. It never includes hosts, users or
credentials.
On AGE the schema is read in one REPEATABLE READ, READ ONLY transaction bounded
by the refresh budget: labels from the AGE catalog, counts estimated from the
PostgreSQL planner statistics (count_estimated: true, absent before the table
was ever analyzed), sampled properties, and relationship endpoints taken from
the label id inside each graph id. read_boundary is read_only_tx. The
natural-language tools tell the model it is writing for Apache AGE 1.5.0 and
list the constructs it cannot use.

The translator also guards AGE gaps that would otherwise return wrong data
without an error, with rules for the AGE version the database reports (1.5.0 or
1.6.0; any other version gets the 1.5.0 rules). An empty-list test such as
`x IN []` is rewritten to `false`, its standard Cypher value.

After a MERGE, SET, REMOVE and DELETE are checked. AGE 1.5.0 applies them only
to the first node or edge a MERGE creates in a statement, so they are rejected
unless they change a variable bound before that MERGE, or the node of a
single-node MERGE that starts the query; for a bulk upsert, run the MERGE, then
the SET as a separate execute call, for example
`UNWIND $rows AS row MATCH (n:Item {id: row.id}) SET n.name = row.name`.
AGE 1.6.0 applies them to every entity a MERGE creates, so the one-call form
`UNWIND $rows AS row MERGE (n:Item {id: row.id}) SET n.name = row.name` works.
It is still rejected when one MERGE-created entity would be written from several
rows, for example a node with a fixed key such as `{name: 'acme'}` that every row
reaches, because AGE keeps only one of those writes.

On both versions, keep keys unique within one call: when two rows reach the same
node or edge, AGE keeps only one of their writes. Properties written inside the
MERGE pattern are stored, but MERGE matches on them: with different values it
creates a second node or edge.

## Configuration

The single built-in profile supplies the default graph name. The node uses the
managed database chosen under Database (Organization by default); the RocketRide
server authorizes it for the run and delivers its connection at task start. There
is no host, user, password, DSN or database name to enter, and no such key in the
node configuration can point it at another database. Start with the defaults,
then tune the graph context and read limits around the size and shape of the
graph your LLM must query.

### Graph name and graph description

Graph name defaults to rocketride, the graph every RocketRide database comes
with (see Database), and must name an existing AGE graph; startup fails instead
of creating a missing graph (the error says how to create one with
`SELECT create_graph(...)`). Graph description is empty by
default and becomes LLM context, so describe labels, relationship meaning, and
domain vocabulary when those are not obvious from reflected schema. Change the
graph name when the tenant database contains multiple AGE graphs; update the
description with it so generated Cypher targets the right model.

### Validation attempts and read rows

The node retries failed Cypher validation up to five times by default. Raise
Max validation attempts (at most 10) for a complex schema where the returned validation error
is likely to let the LLM repair its query, or lower it to fail faster. The
runtime applies 1–10: a value above 10 saved by an earlier version of the form,
or set in a pipeline file, still runs as 10. Max read
rows defaults to 1,000 and is an owner-controlled cap for the questions lane,
get_data and read_query (and so for Graph Explorer, whose "All" asks for this
cap); increase it only when agents truly need larger result sets, since
results beyond the cap are intentionally truncated.

### Query timeout

Query timeout (ms) defaults to 30,000 and is applied inside each query's
transaction. Reduce it to protect an interactive pipeline from expensive
traversals; increase it only for known queries that legitimately need more
time. It works with the row cap: one limits execution time and the other limits
returned data.

### Allow direct query execution

This setting is off by default. Turning it on permits raw Cypher through the
execute tool and QuestionType.EXECUTE; those calls skip LLM translation and the
safe read-only gate. They still use the AGE translator and its resource
controls. Enable it only for trusted callers that require writes or raw Cypher.

### Database

Database picks which RocketRide cloud database the node uses. It defaults to
Organization, so existing pipelines keep using the database they already had.

- **Organization**: the database shared by everyone in the organization the
  pipeline runs in. Data from before this choice existed lives here.
- **Team**: the database of the run's team. A run from the builder uses your
  current dev team and needs run rights (task.control) on it; a deployed
  pipeline uses the team it is billed to.
- **Personal**: your own database in this organization. It works only when you
  are the person running the pipeline: builder runs, store apps you run, and
  pipelines you deploy for yourself (@me). A pipeline deployed for a team has
  no person behind it, so it fails at start with an error that says so.
  Organization admins can reach members' personal databases, and that access
  is logged.

Each choice is a separate database. Switching does not move or copy data, and
a database you have not used yet is created empty on the first run that needs
it. Every database, new ones included, comes with a graph named rocketride, so the
default Graph name works in each.

A pipeline exposed through a public link (a chat, dropper, webhook, Discord or
Telegram source) runs as you, so visitors' requests use your team or personal
database, not their own.

Access is checked when the run starts. If the run may not use the chosen
database, it does not start, and the error says which database and why. A
self-hosted engine supports only Organization; Team and Personal fail at start
because they need RocketRide cloud. Access is approved for the whole run, not
each node: every node in a run can reach every database the run was approved
for.

## Limitations

This node runs on the RocketRide engine host and does not support remote
execution. The RocketRide server resolves the connection to the node's chosen
database at task start; on a server without a RocketRide cloud
database (for example, a local or self-hosted engine with no database broker) the
task fails at start with a message that says so; use a connection-configured
node such as graph_neo4j or graph_falkordb there. On RocketRide Cloud, missing
broker configuration is a server configuration error: contact the server
operator to restore it and retry. The tenant database must
already have Apache AGE installed and contain the configured graph. Read paths are
intentionally read-only; raw execution remains disabled until explicitly
enabled.

## Notes

### Translation and schema discovery

Apache AGE cannot execute bare Cypher. Every query path is translated, and the
safe path runs in a server-side read-only transaction with a semantic firewall,
the base Cypher safety check, and a transaction-local statement timeout.
Schema reflection lists AGE labels, samples node and relationship properties,
and records every observed endpoint label pair. A failure is recorded in the
schema block (the last good schema is kept, marked stale) rather than
blocking the node.

### Connections and concurrency

Each tool call checks a database connection out of a small per-node pool
(up to 4 connections) for its own use and runs in its own transaction, so
parallel calls never share a transaction or each other's read-only and
statement-timeout settings. When all 4 are busy, further calls wait up to the
query timeout plus 5 seconds for one to free up. Every setting is
transaction-local, and parameterised queries deallocate their prepared
statement even when the query fails, so nothing is left on the database
session afterwards. A connection the server dropped while idle is replaced and
the call retried once, before any of the query has run, on a newly opened
connection; the retry also closes the node's other idle connections, since a
database or pooler restart drops them all at once. A connection lost while a
query runs is reported, never re-run. Schema reads (`refresh_schema` and the
startup checks) are not retried: the one call that finds its connection
dropped fails, and it closes the other idle connections so the next call
opens a new one. The pool closes with the pipeline.

Capacity: each running rocketride_graph node holds at most 4 client
connections to the tenant database's pooler, and closes a connection once it
has been idle for 60 seconds (within 5 seconds after that), so an idle
pipeline holds none. Plan the pooler's
client-connection limit for 4 connections per concurrently busy graph node
(plus those of rocketride_sql and rocketride_vector nodes in the same
pipelines).

The node works through a transaction-mode connection pooler such as
PgBouncer: it keeps no state on a database session between transactions and
never runs a session-level `LOAD 'age'`, so the tenant database must preload
Apache AGE (`shared_preload_libraries`). The node's live test suites pass both
directly against PostgreSQL 16 with Apache AGE 1.5.0 and through PgBouncer
1.26 in transaction mode.

### Agents

An LLM agent wired to this node gets every tool listed under **As a tool** in
its tool catalog, `read_query` and `refresh_schema` included. With
`read_query` the agent runs Cypher it writes itself (read-only, up to 1,000
rows by default, capped by Max read rows, within the element and value
budgets); `refresh_schema` re-reads the
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

Apache AGE reports no write counters, so `affected_rows` (from `execute`,
both shapes) is the number of result rows the statement returned:
`CREATE (n:Note)` reports 0 although it wrote, and `CREATE (n:Note) RETURN n`
reports 1. Do not present it as a count of changes.

### How long a call can take

A call first waits for a free pooled connection (up to the query timeout plus
5 seconds, then it fails with `Database busy`), opens one if none is idle
(3-second connect timeout), then runs its statement with the query timeout. If
the connection turns out to have been dropped while idle, the call starts over
once on a new connection, within what is left of the time its first attempt
was allowed (the wait for a connection plus the query timeout): the second
attempt waits for a free connection only that long (then `Database busy`), its
statement timeout is the time left, and with no time left it runs nothing and
fails with `Query timed out after N ms`, where N is that whole allowance. One
`read_query` therefore takes at most about twice the query timeout plus 5
seconds (65 seconds with the default 30-second timeout; opening a new
connection can add a few seconds), longer than the `statement_timeout_ms` that
`dialect` reports. `refresh_schema` waits up
to 65 seconds for another refresh of the same node, then gets a connection and
runs within its 60-second budget; the wait for the connection counts against
that budget and stops when it runs out, so the refresh itself takes at most
about 60 seconds (opening a new connection can add a few seconds; a refresh
whose budget runs out fails as a timeout and keeps the previous schema, marked
stale). A client that stops waiting earlier
only stops waiting: the database ends the statement at its own timeout.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `rocketridegraph.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw Cypher without LLM translation or read-only safety checks. Resource limits still apply. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. | `false` |
| `rocketridegraph.db_description` | `string` | **Graph description**<br/>What is this graph used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `rocketridegraph.graph` | `string` | **Graph name**<br/>Name of the AGE graph to query in your RocketRide cloud database | `"rocketride"` |
| `rocketridegraph.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if validation rejects the generated Cypher | `5` |
| `rocketridegraph.max_rows` | `integer` | **Max read rows**<br/>Row ceiling for read queries: the questions lane, get_data and read_query (Graph Explorer's All asks for this cap). Results beyond it are cut; get_data and read_query report them as truncated (the questions lane does not). | `1000` |
| `rocketridegraph.profile` | `string` |  | `"default"` |
| `rocketridegraph.query_timeout_ms` | `integer` | **Query timeout (ms)**<br/>Per-query statement timeout applied inside each query's transaction | `30000` |

## Dependencies

- `psycopg2-binary` `==2.9.12`
- `antlr4-python3-runtime` `==4.13.2`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/rocketride_graph)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
