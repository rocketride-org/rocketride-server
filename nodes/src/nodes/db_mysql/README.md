# db_mysql

A RocketRide database node for asking natural-language questions of MySQL and
inserting structured answers into a MySQL table. Choose it when your pipeline
needs both MySQL query tools and an `answers`-lane destination for rows.

## About MySQL

MySQL is the database product this node connects to. This implementation uses
SQLAlchemy with the PyMySQL driver to connect and reflect MySQL table schemas.

## What it does

On the `questions` lane, the node gives a connected LLM its startup-reflected
schema and optional database description, validates generated `SELECT` queries
with `EXPLAIN`, and emits results as a table, text, or answer. On the `answers`
lane, it inserts structured rows into the configured table, creating that table
from the first incoming data shape when necessary. It is also an agent tool
node, making it a better fit than a pipeline-only SQL destination when an agent
must decide what to retrieve or needs gated raw SQL.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used to craft SQL queries from questions |

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `answers` | — | Insert structured answer data into the configured table. |
| `questions` | `table` | Send query results as a Markdown table. |
| `questions` | `text` | Send the result as text. |
| `questions` | `answers` | Send the result as an answer. |

## As a tool

The registered tool names are bare method names; this node declares no
configurable server-name prefix.

| Function | Description |
| --- | --- |
| `get_data` | Generate a safe `SELECT` from a question and execute it. |
| `get_schema` | Return the schema reflected when the node started. |
| `get_sql` | Generate a safe `SELECT` without executing it. |
| `execute` | Run raw SQL, bypassing LLM translation and the safety check. |
| `begin` | Open a transaction and return its session ID. |
| `commit` | Commit and close a transaction session. |
| `rollback` | Roll back and close a transaction session. |
| `dialect` | Return `{ "dialect": "mysql" }`. |

`get_data` and `get_sql` require a non-empty `question`; `get_data` accepts an
optional `limit`, defaulting to 250 and clamped to 1–25,000. `get_schema`
accepts an optional `table`; an unknown table returns an `error` field, while
omitting it returns all reflected tables. `get_data` returns `{valid, rows,
sql, row_limit}` on success; a non-database question returns `{valid: false,
answer}`, and a query execution failure returns `{valid: false, error, sql,
rows: []}`.

`execute` requires non-empty `sql` and optionally accepts a transaction
`session_id` plus positional values for `$1`, `$2`, and so on. It returns
`{rows, affected_rows}`. `begin` takes no arguments and returns `{session_id}`;
`commit` and `rollback` require that ID and return `{ok: true}`. These four
write-capable operations fail when **Allow direct query execution** is off;
unknown or expired session IDs also fail. Invalid tool input raises an error.

## Configuration

Start with the default connection values, then set the database endpoint and
target table. The generated schema below is the complete field reference;
describe the data well and leave direct execution disabled unless a trusted
caller truly needs it.

### Database description

This text is added to every LLM SQL-generation request alongside the reflected
schema. Describe the data's purpose, meanings, and conventions when names
alone are ambiguous—for example, explain whether `amount` is a gross or net
value. Change it when queries choose the wrong interpretation; it does not
replace the actual table and column information collected at startup.

### Connection and target table

Set the host, user, password, database, and table to the MySQL server and
target table. User, password, and database are URL-encoded before the PyMySQL
DSN is built, so reserved characters in those values are safe. The node
reflects the complete database for query context at startup, then separately
checks the target table: if it is absent, it warns and waits to create it from
the first incoming `answers` data.

### Max validation attempts

The default of five gives the LLM several chances to repair a query rejected by
`EXPLAIN`. Lower it when fast failure matters more than recovery; raise it for
complex schemas that need another correction cycle. The configuration field
allows 1–20, while the runtime accepts any positive configured number and
falls back to five for an invalid value. After the final rejected attempt it
returns the last generated result, so retries improve generated SQL but do not
guarantee that a subsequent execution will succeed.

### Allow direct query execution

Leave this off by default. When on, the `execute`, `begin`, `commit`, and
`rollback` tools can bypass LLM translation and the generated-query safety
check. A raw call without a session uses a transaction that commits on success;
use `begin` followed by `execute` with its session ID when several statements
must share a transaction. Enable it only for trusted callers that need writes
or dialect-specific SQL; use `get_data` for ordinary read-only retrieval.

## Limitations

This node declares the `noremote` capability, so it cannot run in a remote
execution environment. It requires network reachability to the MySQL server
from the environment where the pipeline runs.

## Notes

### Generated-query safety

For LLM-generated SQL, the node only accepts `SELECT`, optionally preceded by
`EXPLAIN`. It strips comments, checks every semicolon-separated statement, and
rejects CTEs plus `SELECT ... INTO OUTFILE` or `INTO DUMPFILE`. It validates
each safe candidate with `EXPLAIN` and feeds database errors to the LLM for the
next attempt. If the LLM decides a question is not a database query, its text
answer is emitted instead of executing SQL.

### Inserting answers

Incoming JSON rows are matched to the target schema case-insensitively; missing
schema columns become `NULL`, and unknown incoming keys are ignored. Lists and
dictionaries are serialized as JSON strings and booleans as `0` or `1`. For a
new table, the node adds an auto-increment `id` primary key and infers integer,
float, datetime, or text columns; short text becomes `VARCHAR(255)` and longer
text becomes `TEXT`.

### Connection checks and transactions

Saving configuration probes the server with `SELECT 1` using a five-second
connect timeout and reports the driver error when it cannot connect. The
runtime connection pool allows 30 concurrent connections. It retains at most
20 transaction sessions by default, rolls idle ones back after five minutes,
and rolls all open sessions back when the pipeline closes.

## Upstream docs

- [MySQL documentation](https://dev.mysql.com/doc/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `mysql.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
| `mysql.database` | `string` | **Database name**<br/>Name of database | `"database"` |
| `mysql.db_description` | `string` | **Database description**<br/>What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `mysql.host` | `string` | **MySQL host**<br/>Host name or IP address of the MySQL server | `"localhost"` |
| `mysql.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL | `5` |
| `mysql.password` | `string` | **Password**<br/>Password to connect to the MySQL server |  |
| `mysql.profile` | `string` |  | `"default"` |
| `mysql.table` | `string` | **Table name**<br/>Name of table | `"table"` |
| `mysql.user` | `string` | **User**<br/>User to connect to the MySQL server | `"root"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_mysql)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
