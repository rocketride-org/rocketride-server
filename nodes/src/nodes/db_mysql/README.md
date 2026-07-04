# db_mysql

A RocketRide database node that answers natural-language questions against a MySQL database and inserts structured pipeline data into a MySQL table.

## What it does

The node operates in two roles. As a pipeline node, it receives natural-language questions on the `questions` lane, uses a connected LLM to translate them into SQL, executes the query, and emits results on the `table`, `text`, and `answers` output lanes; it also receives structured data on the `answers` input lane and inserts rows into the configured table. As a tool node, it exposes `get_data`, `get_schema`, and `get_sql` to an agent so the agent can query the database by describing the data it wants.

Connects via SQLAlchemy with the pymysql driver (`mysql+pymysql://` DSN; user, password, and database name are URL-encoded so reserved characters don't break the connection string). The connection pool allows up to 30 concurrent connections (`pool_size=10`, `max_overflow=20`). The full database schema (tables, columns, types, primary keys, and foreign keys) is reflected once at startup and supplied to the LLM as context for every query.

Only `SELECT` statements are permitted for queries; all generated SQL passes a whitelist safety check before execution. Inserts go through the `answers` lane, not through SQL. Saving the node config probes the server with `SELECT 1` (5-second connect timeout) and surfaces the driver error verbatim if the connection fails.

---

## Configuration

### Lanes

| Lane in | Lanes out | Description |
|---------|-----------|-------------|
| `questions` | `table`, `text`, `answers` | Translate question to SQL, execute it. Results go to `text` as a string, to `table` as a markdown table (valid queries only), and to `answers` as a markdown table (or the LLM's text response when the question is not a database query). |
| `answers` | (none) | Parse structured JSON data and insert it into the configured table |

Two special question types are handled on the `questions` lane:

- **`QuestionType.DIALECT`**: emits `{"dialect": "mysql"}` on the `answers` lane so SDK callers can branch on the underlying engine.
- **`QuestionType.EXECUTE`**: runs the question text as raw SQL, bypassing LLM translation and the safety check. Disabled unless `allow_execute` is on; see the "Direct SQL execution" section below.

### Fields

| Field | Type | Description |
|---|---|---|
| `host` | string | Default "localhost". Host name or IP address of the MySQL server |
| `user` | string | Default "root". User to connect to the MySQL server |
| `password` | string | Password to connect to the MySQL server |
| `database` | string | Default "database". Name of database |
| `table` | string | Default "table". Name of table |
| `db_description` | string | Default empty. What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. |
| `max_attempts` | integer | Default 5. Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL |
| `allow_execute` | boolean | Default false. Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. |
| `profile` | string | Default "default".  |

The node has a single `default` profile containing all fields above.

---

## Connections

| Connection | Required | Description |
|------------|----------|-------------|
| `llm` | yes (min 1) | LLM used to craft SQL queries from natural-language questions |

---

## Available tools

When connected to an agent, the node exposes three functions:

| Tool | Description |
|------|-------------|
| `get_data` | Natural language to SQL `SELECT`, executed; returns result rows plus the generated SQL. `limit` defaults to 250 rows, max 25,000. |
| `get_schema` | Returns the database schema: tables, columns, types, primary keys, and foreign keys. Pass a `table` name for a single table, or omit it for the full schema. |
| `get_sql` | Natural language to SQL only: returns the generated `SELECT` statement without executing it |

---

## SQL generation and validation

Generated SQL goes through two gates before execution:

1. **Safety whitelist**: only `SELECT` statements (optionally prefixed by `EXPLAIN`) are allowed. Comments are stripped first so embedded keywords can't fool the check, each statement in a multi-statement string is checked separately, `SELECT ... INTO OUTFILE` / `INTO DUMPFILE` is blocked, and `WITH` (CTE) is deliberately rejected because CTEs can wrap mutations.
2. **`EXPLAIN` validation**: the query is validated by running `EXPLAIN` against the live database without executing it. If `EXPLAIN` rejects the query, the rejected SQL and the database error are fed back to the LLM for a corrected attempt. This repeats up to `max_attempts` times (default 5) before the last result is returned as-is.

If the LLM decides the question is not a database query at all, it answers in plain text instead, and that text is returned on the `text` and `answers` lanes (or in the tool result's `answer` field).

---

## Inserting data

Rows arriving on the `answers` lane are inserted into the configured `table`:

- The table is auto-created on first insert if it doesn't exist, with column types inferred from the data (int, float, datetime, and text detection; short strings become `VARCHAR(255)`, long ones `TEXT`) and an auto-increment `id` primary key prepended. A startup warning is logged when the table is missing.
- Incoming keys are matched to schema columns case-insensitively (`UserName` maps to `username`); schema columns absent from the data are inserted as `NULL`, and keys not in the schema are dropped.
- Lists and dicts are serialised to JSON strings; booleans are stored as `0`/`1`.

---

## Direct SQL execution

When `allow_execute` is `true`, callers sending `QuestionType.EXECUTE` can run raw SQL (reads or writes) with no LLM translation and no safety whitelist. Writes auto-commit; results are emitted on the `text`, `table`, and `answers` lanes, with the `answers` payload containing `rows` and `affected_rows`. `SELECT` results are capped at 25,000 rows (configurable via the `max_execute_rows` config key); exceeding the cap fails the query rather than truncating it.

This is off by default. Leave it off unless a trusted application explicitly needs to issue SQL directly: with it enabled, any pipeline caller that can reach the node can run arbitrary statements against the database.

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
