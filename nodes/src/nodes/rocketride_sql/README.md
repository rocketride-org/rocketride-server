# rocketride_sql

A RocketRide database node for asking natural-language questions of, and writing
structured pipeline data to, the relational database provisioned for the signed-in
RocketRide tenant. Pick it instead of a connection-configured PostgreSQL node when
the data belongs in that managed tenant database.

## What it does

On the questions lane, the node asks its connected LLM to produce a SQL query,
validates a safe query with EXPLAIN, and returns the result as a table, text, or
answer. On the answers lane, it inserts structured rows into the configured
table. Use it for relational queries and writes against the tenant database;
rocketride_vector is the sibling for document embeddings and rocketride_graph is
the sibling for Cypher graph queries.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| llm | yes | Produces SQL from a natural-language question. |

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| answers | — | Inserts structured pipeline rows into the configured table. |
| questions | table | Returns an executed query result as a Markdown table. |
| questions | text | Returns the query result as text. |
| questions | answers | Returns the query result on the answers lane. |

## As a tool

The inherited database functions are registered under the bare names below; this
node defines no configurable server-name prefix. Input must be a JSON object
unless a function explicitly permits an empty object.

| Function | Description |
| --- | --- |
| get_data | Converts a required natural-language question into safe SQL, executes it, and returns rows. |
| get_schema | Returns reflected tables, columns, primary keys, and foreign keys; table is optional. |
| get_sql | Converts a required question into SQL without executing it. |
| execute | Runs required raw SQL, with optional positional params and a transaction session_id. |
| begin | Opens a raw-SQL transaction and returns its session_id. |
| commit | Commits the required session_id. |
| rollback | Rolls back the required session_id. |
| dialect | Returns {"dialect": "postgres"}. |

get_data returns {valid, rows, sql, row_limit} for a successful query. A
generation or execution problem returns valid: false with error, SQL, or an LLM
answer as applicable. It defaults to 250 rows; a supplied limit is clamped to
the shared maximum. get_schema reports an unknown requested table as an error
value rather than throwing.

get_sql returns {sql, valid: true} only for safe generated SQL; unsafe SQL
returns {error, sql, valid: false}. execute, begin, commit, and rollback raise
for invalid input, an unknown or expired transaction, or when direct execution
is disabled. A successful raw execution returns {rows, affected_rows}; begin
returns {session_id} and transaction completion returns {ok: true}.

## Configuration

There is one built-in profile and no connection panel. RocketRide provisions a
per-tenant database for its managed database nodes, and this node resolves it
from the signed-in RocketRide identity instead of a host, user, password, or
database name you enter. Configure the table and the context supplied to the
LLM; leave direct execution disabled unless a trusted caller needs it.

### Table name and database description

Table name defaults to table and is the target used for structured answers-lane
inserts. Database description is empty by default and is included as context
when the node asks the LLM to write SQL. Change it when the database or table
has domain-specific meanings that a column name alone cannot convey; a concise
description helps the LLM choose relevant tables and predicates without
changing the actual schema.

### Max validation attempts

The node defaults to five LLM attempts when EXPLAIN rejects generated SQL.
Raise it when a complex, well-described schema produces repairable SQL errors;
lower it when fast failure matters more than another LLM round trip. It affects
only the natural-language path, not raw execute calls.

### Allow direct query execution

This setting is off by default. When enabled, QuestionType.EXECUTE on the
questions lane and the execute, begin, commit, and rollback tools can run raw
SQL without LLM translation or SQL safety checks. Enable it only for a trusted
application that needs write statements or explicit transactions; otherwise
keep it off so those entry points fail rather than executing input.

## Limitations

This node is marked noremote and depends on a signed-in RocketRide identity to
resolve the per-tenant DSN. It cannot start where that cloud identity is not
available; DSN resolution is deliberately not replaced by host or credential
fields. LLM-generated queries are limited to the safe SQL path, while raw SQL
is unavailable until direct execution is explicitly enabled.

## Notes

### Query paths

The node inherits PostgreSQL schema reflection and its structured query surface.
For QuestionType.DIALECT, the questions lane emits the PostgreSQL dialect on
answers. For QuestionType.EXECUTE, a disabled direct-execution setting logs and
drops the request; successful raw SELECT results are bounded by the shared
execution-row maximum, while writes report affected_rows.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `rocketridesql.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
| `rocketridesql.db_description` | `string` | **Database description**<br/>What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `rocketridesql.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL | `5` |
| `rocketridesql.profile` | `string` |  | `"default"` |
| `rocketridesql.table` | `string` | **Table name**<br/>Name of the table to read from or write to in your RocketRide cloud database | `"table"` |

## Dependencies

- `psycopg2-binary` `==2.9.12`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/rocketride_sql)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
