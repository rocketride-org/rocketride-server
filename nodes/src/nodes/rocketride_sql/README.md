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
| refresh_schema | Re-reads the schema from the database and returns it with a refreshed_at timestamp. |
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
value rather than throwing; it serves the snapshot the node currently holds —
the reflection taken at start-up, replaced by each refresh_schema call — so
refresh_schema is what sees DDL run since the last reflection. refresh_schema
takes no arguments and returns the re-reflected schema in the same {database,
tables} shape get_schema returns, plus a refreshed_at UTC ISO-8601 timestamp
recording when that reflection completed. Alongside replacing that
database-wide cache it invalidates the configured table's cached column map
rather than rebuilding it there: the map is reflected afresh on the next
answers-lane insert, which is how that insert picks up added or dropped
columns instead of continuing against the start-up shape.

get_sql returns {sql, valid: true} only for safe generated SQL; unsafe SQL
returns {error, sql, valid: false}. execute, begin, commit, and rollback raise
for invalid input, an unknown or expired transaction, or when direct execution
is disabled. A successful raw execution returns {rows, affected_rows}; begin
returns {session_id} and transaction completion returns {ok: true}. A failed
execute raises "SQL execution failed:" followed by the database's own primary
message, identically with and without a session_id. What is removed is the
tail: SQLAlchemy's [SQL: ...] / [parameters: ...] echo, PostgreSQL's LINE n:
quotation of the statement, and its DETAIL, HINT and CONTEXT blocks. The
primary sentence itself is passed through as PostgreSQL wrote it, so it can
name a value the statement carried or touched — including one an
INSERT ... SELECT or a CAST read from another table. That is deliberate:
reaching this tool at all requires direct execution to be enabled, and a
caller who has it can read the same data with a SELECT. The full text stays
in the server log.

## Configuration

There is one built-in profile and no connection panel. RocketRide provisions a
per-tenant database for its managed database nodes, and this node resolves it
from the signed-in RocketRide identity instead of a host, user, password, or
database name you enter. Configure the table and the context supplied to the
LLM; leave direct execution disabled unless a trusted caller needs it.

### Table name and database description

Table name defaults to table and is the target used for structured answers-lane
inserts. Incoming keys are matched to columns case-insensitively, and a column
the row does not carry is inserted as NULL unless the database fills it in
itself: a generated primary key or a column with a DEFAULT is left out of the
statement so PostgreSQL supplies the value rather than receiving an explicit
NULL. A generated primary key supplied as null counts as not carried, since the
sender on this lane is an upstream node that may emit every schema key; a null
on any other column is inserted as NULL as given. A primary key PostgreSQL does
not generate that a row omits is rejected before anything runs.

Database description is empty by default and is included as context when the
node asks the LLM to write SQL. Change it when the database or table
has domain-specific meanings that a column name alone cannot convey; a concise
description helps the LLM choose relevant tables and predicates without
changing the actual schema.

### Max validation attempts

The node defaults to five LLM attempts when EXPLAIN rejects generated SQL.
Raise it when a complex, well-described schema produces repairable SQL errors;
lower it when fast failure matters more than another LLM round trip. It affects
only the natural-language path, not raw execute calls.

### Allow direct query execution

This setting is off by default. When enabled, the execute, begin, commit, and
rollback tools can run raw SQL without LLM translation or SQL safety checks.
Enable it only for a trusted application that needs write statements or
explicit transactions; otherwise keep it off so those tools fail rather than
executing input. It does not change the questions lane, which only ever runs
LLM-generated, safety-checked SELECT statements.

## Limitations

This node is marked noremote and depends on a signed-in RocketRide identity to
resolve the per-tenant DSN. It cannot start where that cloud identity is not
available; DSN resolution is deliberately not replaced by host or credential
fields. LLM-generated queries are limited to the safe SQL path, while raw SQL
is unavailable until direct execution is explicitly enabled.

## Notes

### Query paths

The node inherits PostgreSQL schema reflection and its structured query surface.
The questions lane does not dispatch on Question.type: every question takes the
same translate-then-execute path, so there is no dialect or raw-SQL branch on
the lane. The dialect and execute tool functions are how those are reached.
With direct execution disabled, execute fails the call rather than running;
when enabled, raw SELECT results are bounded by the shared execution-row
maximum, while writes report affected_rows.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
