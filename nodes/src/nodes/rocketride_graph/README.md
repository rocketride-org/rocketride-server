# rocketride_graph

A RocketRide graph database node for natural-language Cypher queries against
the Apache AGE graph in the signed-in tenant's managed database. Pick it over
rocketride_sql when relationships and traversals are the data model.

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
| get_schema | Returns the discovered labels, sampled node properties, and relationships. |
| get_query | Converts required natural-language question to read-only Cypher without executing it; limit is optional. |
| execute | Runs required raw Cypher query when direct execution is enabled. |
| dialect | Returns {"dialect": "age"}. |

get_data defaults to the shared read limit, then clamps the requested limit to
the configured Max read rows ceiling. A successful result contains
{valid, rows, query, row_limit, truncated}. Generation, validation, or
execution failure returns {valid: false, error, query, rows: []}; a non-graph
question may instead carry an LLM answer with valid: false.

get_query returns {query, valid: true} only after its safe-query checks.
execute bypasses the read-only gate but still passes Cypher through the AGE
translation and resource limits; it raises if direct execution is disabled or
the input is invalid, and otherwise returns {rows, affected_rows}.

## Configuration

The single built-in profile supplies the default graph name. RocketRide
provisions a per-tenant database for its managed database nodes, and this node
resolves it from the signed-in RocketRide identity instead of a host, user,
password, or database name you enter. Start with the defaults, then tune the
graph context and read limits around the size and shape of the graph your LLM
must query.

### Graph name and graph description

Graph name defaults to rocketride and must name an existing AGE graph; startup
fails instead of creating a missing graph. Graph description is empty by
default and becomes LLM context, so describe labels, relationship meaning, and
domain vocabulary when those are not obvious from reflected schema. Change the
graph name when the tenant database contains multiple AGE graphs; update the
description with it so generated Cypher targets the right model.

### Validation attempts and read rows

The node retries failed Cypher validation up to five times by default. Raise
Max validation attempts for a complex schema where the returned validation error
is likely to let the LLM repair its query, or lower it to fail faster. Max read
rows defaults to 1,000 and is an owner-controlled cap for both the questions
lane and get_data; increase it only when agents truly need larger result sets,
since results beyond the cap are intentionally truncated.

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

## Limitations

This node runs on the RocketRide engine host and does not support remote
execution. The engine host must have access to the signed-in RocketRide
identity used to resolve the tenant DSN. The tenant database must already have
Apache AGE installed and contain the configured graph. Read paths are
intentionally read-only; raw execution remains disabled until explicitly
enabled.

## Notes

### Translation and schema discovery

Apache AGE cannot execute bare Cypher. Every query path is translated, and the
safe path runs in a server-side read-only transaction with a semantic firewall,
the base Cypher safety check, and a transaction-local statement timeout.
Schema reflection is best effort: it lists AGE labels, samples node properties,
and samples relationship endpoints; an individual reflection failure warns and
returns partial rather than blocking all schema output.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `rocketridegraph.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw Cypher without LLM translation or read-only safety checks. Resource limits still apply. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. | `false` |
| `rocketridegraph.db_description` | `string` | **Graph description**<br/>What is this graph used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `rocketridegraph.graph` | `string` | **Graph name**<br/>Name of the AGE graph to query in your RocketRide cloud database | `"rocketride"` |
| `rocketridegraph.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if validation rejects the generated Cypher | `5` |
| `rocketridegraph.max_rows` | `integer` | **Max read rows**<br/>Row ceiling for read queries on the questions lane and get_data tool | `1000` |
| `rocketridegraph.profile` | `string` |  | `"default"` |
| `rocketridegraph.query_timeout_ms` | `integer` | **Query timeout (ms)**<br/>Per-query statement timeout applied inside each query's transaction | `30000` |

## Dependencies

- `psycopg2-binary` `==2.9.12`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/rocketride_graph)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
