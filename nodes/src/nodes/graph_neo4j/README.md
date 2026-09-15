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

The functions are registered under the `neo4j` service prefix: for example,
`neo4j.get_data`. There is no configurable tool-server-name field.

| Function | Description |
| --- | --- |
| `neo4j.get_data` | Turn a natural-language request into a read-only Cypher query, run it, and return rows. |
| `neo4j.get_schema` | Return the reflected labels, properties, and relationship types. |
| `neo4j.get_query` | Return generated read-only Cypher without executing it. |
| `neo4j.execute` | Run raw Cypher only when direct execution is enabled. |
| `neo4j.dialect` | Return `{"dialect": "neo4j"}`. |
| `neo4j.get_cypher` | Deprecated compatibility alias for `get_query`; it also includes the statement under `cypher`. |

`get_data`, `get_query`, and `get_cypher` require a non-empty `question` and
accept an optional integer `limit`; absent or invalid limits resolve to 250 and
the maximum is 25,000. `get_data` returns `{valid, rows, query, row_limit,
truncated}` on success. Failed validation or execution returns `valid: false`
with `error`; a non-graph question returns `valid: false` with an `answer`
instead of rows.

`get_schema` accepts an optional `label`; an unknown label returns an `error`,
otherwise the response includes `{database, labels, nodes, relationships}`.
`execute` requires a non-empty raw `query` and returns `{rows, affected_rows}`;
it raises an error while direct execution is disabled. `dialect` accepts no
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
is repaired after Neo4j rejects it under `EXPLAIN`. The setting defaults to 5;
the runtime clamps it to 1–10. Increase it only if valid requests routinely
need additional repair attempts, since each retry calls the LLM and delays the
answer. When all attempts fail, the node returns the database error rather than
running the last rejected query.

### Allow direct query execution

**Allow direct query execution** is off by default. Keep it off for normal
agent and lane traffic: generated reads pass the Cypher safety gate and use a
READ access-mode session. Turn it on only for a trusted caller that must issue
raw Cypher through `execute` or `QuestionType.EXECUTE`, because that path skips
both LLM translation and the read-only gate and can write to the database.
Raw execution is still limited to 25,000 returned rows; exceeding that limit
raises an error.

## Authentication

Choose **Username & Password** (the default) to send the configured user and
password to the driver; a blank user resolves to `neo4j`. Choose **Bearer
Token** to use the configured token through `neo4j.bearer_auth`. The save-time
probe reports authentication, connectivity, and Neo4j errors as warnings;
pipeline startup then fails fast if the configured server or database cannot
be verified.

## Limitations

The `noremote` capability pins this node to the local worker because it holds a
database client and credentials. The ordinary graph-query flow uses a
client-side best-effort blacklist for selected write and administrative clauses
and Neo4j READ access mode. Neither is a guaranteed read-only boundary: READ
access controls routing, and the blacklist cannot cover every mutating procedure.
Enabling direct execution grants trusted callers an explicit write-capable escape
hatch.

## Notes

### Schema reflection and query generation

At startup, the node reflects node labels and property types through
`db.schema.nodeTypeProperties()` and relationship information through
`db.schema.visualization()`. On servers where those procedures fail, it falls
back to `db.labels()` and `db.relationshipTypes()`. Reflection failure only
warns and leaves an empty schema cache, so the connection can continue but the
LLM has less structure to ground its Cypher generation.

The LLM is instructed to generate queries only from the reflected schema;
generated output is checked for unsafe clauses after comments are removed and
validated with `EXPLAIN`. The safety
gate rejects `CREATE`, `MERGE`, `DELETE`, `SET`, `DROP`, and other write or
admin clauses including mutating `apoc` procedures. The actual read query has a
30-second timeout and the implementation returns one row beyond the requested
limit to report `truncated` correctly.

### Result serialization

Returned graph values are made JSON-safe: nodes include `_labels`,
relationships include `_type`, paths become `{nodes, relationships}`, and
temporal values use their ISO representation. For raw execution, `affected_rows`
counts created or deleted nodes and relationships, changed properties, and
label changes reported by the Neo4j result summary.

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

- `neo4j`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/graph_neo4j)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
