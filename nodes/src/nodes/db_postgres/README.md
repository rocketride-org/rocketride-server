# db_postgres

A RocketRide database node that answers natural-language questions against a PostgreSQL database and inserts structured pipeline data into tables.

## What it does

Plays two roles in a pipeline. As a pipeline node, it receives natural-language questions on the `questions` lane, asks a connected LLM to translate them into SQL, executes the query, and emits the results; it also accepts structured data on the `answers` lane and inserts it into the configured table. As a tool node, agents call it directly through nine functions: five that are always available (`get_data`, `get_schema`, `refresh_schema`, `get_sql`, `dialect`) and four raw-SQL ones gated behind `allow_execute` (`execute`, `begin`, `commit`, `rollback`).

Uses SQLAlchemy with the psycopg2 driver (`psycopg2-binary`). The connection string is built as `postgresql+psycopg2://user:password@host/database`; user, password, and database are URL-encoded so reserved characters (`@`, `/`, `#`, `:`) are safe, and the host may carry an explicit port (e.g. `localhost:5433`).

Safety defaults: only `SELECT` statements are permitted for queries (whitelist check, see Notes), generated SQL is validated with `EXPLAIN` against the live database before execution, and raw SQL execution is disabled by default via `allow_execute`.

The same implementation also ships as a Supabase preset (`services.supabase.json`, protocol `db_supabase://`): Supabase is managed Postgres, so it is a branded configuration, not separate code.

## Example pipelines

**Chat with your database**

`chat → db_postgres → response_answers + response_table`

<div align="center">

![The PostgreSQL node on the canvas answering questions from chat, with an LLM connected](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>

`llm_anthropic` is wired to `llm`. Natural-language questions arrive from
chat; PostgreSQL returns conversational answers and tabular results on the
two response lanes.

**Structured extraction into a table**

`webhook → ocr → extract_data → db_postgres`

Scanned documents are OCR'd, `extract_data` structures the fields, and the
rows arrive on this node's `answers` lane — the table is auto-created on
first insert.

**Agent with database access**

An agent (e.g. `agent_deepagent`) with this node connected as a tool. The
agent calls `get_schema` to learn the shape of the data, then `get_data` to
answer questions — with the SELECT-only whitelist keeping it read-safe.

## Connections

| Connection | Required | Description                                    |
| ---------- | -------- | ---------------------------------------------- |
| `llm`      | yes      | LLM used to generate SQL from natural language |

## Lanes

| Lane in     | Lane out | Description                                                    |
| ----------- | -------- | -------------------------------------------------------------- |
| `questions` | `table`  | Translate question to SQL, execute, return as a markdown table |
| `questions` | `text`   | Translate question to SQL, execute, return as text             |
| `questions` | `answers`| Translate question to SQL, execute, return as answers          |
| `answers`   | —        | Parse structured rows and insert into the table                |

If the LLM decides a question is not a database query, its text response is emitted instead of query results.

The `questions` lane has one behaviour: every question takes the natural-language path above, and only SQL the LLM generates for a question it judges to be a database query is executed — when it reports the question is not one (`isValid: false`), the prose answer is emitted and nothing runs against the database. The lane does not branch on `Question.type` — there is no dialect or raw-SQL path on the lane, so a `QuestionType.DIALECT` or `QuestionType.EXECUTE` question is handled exactly like any other natural-language question. (The graph node `graph_neo4j` *does* dispatch on those two types; this node never has.) Reach the dialect and raw-SQL behaviours through the `dialect` and `execute` tool functions below instead.

## As a tool

When connected to an agent, the node exposes nine functions: the five below, plus the four raw-SQL functions in **Raw SQL and transactions**. The registered tool names are the bare method names below; the services.json `prefix` is a URL/path prefix and never appears in a tool name. An agent catalog namespaces each tool by the pipeline component id (for example `<component-id>.get_data`).

| Tool         | Description                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `get_data`   | Natural language to SQL, executes it, returns rows plus the generated SQL (default 250 rows, max 25,000 via `limit`) |
| `get_schema` | Returns tables, columns, types, primary keys, and foreign keys, for the full database or one table                |
| `refresh_schema` | Re-reads the schema from the database and returns it, plus a `refreshed_at` UTC timestamp                     |
| `get_sql`    | Natural language to SQL only, no execution                                                                        |
| `dialect`    | Takes no arguments; returns `{"dialect": "postgres"}` so a caller can branch on the underlying engine              |

`get_data` and `get_sql` return `valid: false` with an `error` (unsafe SQL) or an `answer` (the question was not a database query) when no executable query is produced.

`get_schema` serves the snapshot the node currently holds — the reflection taken at start-up, replaced by each `refresh_schema` call — so a table created or altered since the last reflection is invisible to it until the next one. `refresh_schema` takes no arguments and re-reflects the database, updating both caches the node keeps, but not in the same way: it *replaces* the database-wide schema that the natural-language path describes to the LLM, and it *rebuilds* the configured table's column map that the `answers` lane builds its INSERTs from, out of the same walk rather than with a second reflection. That is when a column added by DDL starts being populated instead of dropped as unknown. A configured table the walk did not find leaves that map empty, and the next insert reflects the table itself if it has come back. If the database refuses the reflection — a revoked grant, a lock timeout, a table dropped mid-walk — the call fails with `Schema refresh failed:` followed by the database's own message (for a table that disappeared mid-walk, the name of that table) and leaves both cached schemas exactly as they were.

### Raw SQL and transactions

Four more tool functions run raw SQL and explicit transactions. All four are gated on the node's **Allow direct query execution** setting (`allow_execute`); with it off, each call fails with an error rather than running. That gate is the node's only raw-SQL switch: it does not change what the `questions` lane does, because the lane never runs raw SQL in the first place.

| Tool       | Input                     | Returns                    | Description                                                                                                   |
| ---------- | ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `execute`  | `{"sql": "<statement>"}`, optional `params` (positional `$1..$n`), `session_id` and `row_mode` (`object` or `array`) | `{"rows": [...], "affected_rows": N}` | Runs the statement as written — no LLM translation and no SELECT-only check. Without a `session_id` it runs on a fresh auto-commit connection, and a `SELECT` over the row cap (25,000 by default) fails and rolls back rather than returning a truncated result; inside a session that overflowing statement stays pending in the open transaction until the client rolls it back. A failed statement raises `SQL execution failed:` followed by PostgreSQL's own primary message (see the error contract below). |
| `begin`    | _(none)_                  | `{"session_id": "<id>"}`   | Opens a new transaction and reserves a dedicated connection for it. Returns a `session_id` that callers must thread through subsequent `execute`, `commit`, and `rollback` calls. |
| `commit`   | `{"session_id": "<id>"}` | `{"ok": true}`             | Commits all statements made on the given session, releases the held connection back to the pool, and removes the session entry. Errors if an earlier statement aborted the transaction (see below). |
| `rollback` | `{"session_id": "<id>"}` | `{"ok": true}`             | Discards all statements made on the given session, releases the held connection, and removes the session entry. |

A failed `execute` raises `SQL execution failed:` followed by PostgreSQL's own primary message, identically with and without a `session_id`. What is removed is the tail: SQLAlchemy's `[SQL: ...]` / `[parameters: ...]` echo, PostgreSQL's `LINE n:` quotation of the statement, and its DETAIL, HINT and CONTEXT blocks. The primary sentence itself is passed through as PostgreSQL wrote it, so it can name a value the statement carried or touched — `invalid input syntax for type integer: "..."` names the offending value even when an `INSERT ... SELECT` or a `CAST` read it from another table. That is deliberate rather than overlooked: reaching this tool at all requires **Allow direct query execution**, and a caller who has that can read the same data with a `SELECT`, so the error channel grants no access a query would not. The full text stays in the server log.

To run a statement inside an open transaction, pass the `session_id` returned by `begin` as the `session_id` field of an `execute` tool call. Statements without a `session_id` run on a fresh auto-commit connection and are not part of any transaction. The `execute` tool also accepts an optional `row_mode` field: `'object'` (default) returns rows as objects keyed by column name; `'array'` returns rows as positional arrays (column order preserved, duplicate column names kept) — the shape ORM drivers such as Drizzle require.

A failed statement leaves the session open so the caller can recover with `rollback`, or `rollback to savepoint` for nested transactions. Postgres, however, marks the whole transaction aborted: a later `COMMIT` silently degrades to `ROLLBACK` and reports success while discarding the write. The node therefore refuses that commit — it rolls the session back and returns an error instead of `{"ok": true}`, so a discarded write is never reported as committed.

Sessions are server-scoped: the `session_id` is only valid on the node instance that issued it. Idle sessions are reaped automatically after a configurable timeout; the engine also closes all sessions when the pipeline is torn down.

The Python SDK exposes these as `client.database.begin_transaction()`, `client.database.commit()`, and `client.database.rollback()`. The TypeScript SDK exposes them as `client.database.beginTransaction()`, `client.database.commit()`, and `client.database.rollback()`.

To run a statement **inside** an open session from the SDK, pass the `session_id` (and any positional `$1..$n` `params`) to the database query method — Python `client.database.query(token=..., sql=..., session_id=..., params=[...])`, TypeScript `client.database.query({ token, sql, sessionId, params })`. Parameters are bound server-side. A `query(...)` call without a `session_id` runs on a fresh auto-commit connection and is not part of any transaction.

## Configuration

Connection settings (host, user, password, database, table) plus three fields
that shape query behavior, detailed below. The single `default` profile presets
`database` to `postgres`.

### Database description

Free-text description of what the database contains and what it is used for,
included in the prompt when the LLM generates SQL. This is the highest-leverage
field on the node: a specific description ("orders and customers for the EU
webshop; `orders.status` is an enum of pending/shipped/returned") measurably
improves query accuracy, while a blank one leaves the LLM guessing from column
names alone. Update it when the schema's meaning changes, not just its shape.

### Max validation attempts

How many times the node re-asks the LLM after `EXPLAIN` rejects the generated
SQL (default 5). Raise it for complex schemas where first attempts often fail;
lower it to fail fast in latency-sensitive pipelines. Each retry feeds the
database error back to the LLM, so attempts are not blind retries.

### Allow direct query execution

Gates the raw-SQL tool functions (`execute`, `begin`, `commit`, `rollback`).
Off by default — leave it off unless a trusted application explicitly needs to
issue SQL directly, because enabled callers bypass both the LLM translation
and the SELECT-only safety check.

## Limitations

Declared `noremote`: this node runs on the local engine host only and is not
available for remote execution. It needs a direct network path to the
PostgreSQL server it queries.

## Notes

### SQL safety & validation

Generated SQL passes two gates before execution:

1. **Whitelist check**: only statements beginning with `SELECT` (optionally prefixed by `EXPLAIN`) are allowed; everything else is rejected. Comments are stripped first so comment-based bypasses are neutralised, every statement in a multi-statement input is checked, `SELECT ... INTO OUTFILE/DUMPFILE` is blocked, and `WITH` (CTE) is deliberately excluded because PostgreSQL accepts CTE-into-mutation (e.g. `WITH x AS (...) DELETE ...`).
2. **`EXPLAIN` validation**: the query is validated against the live database. If `EXPLAIN` rejects it, the rejected SQL and the database error are fed back to the LLM for a corrected query, up to `max_attempts` times (default 5).

Insert operations never go through SQL generation; they use the `answers` lane.

### Data insertion

Rows arriving on the `answers` lane are inserted into the configured `table`:

- The table is auto-created from the shape of the first batch if it does not exist (column types inferred from the data).
- Incoming keys are matched to columns case-insensitively (`UserName` maps to `username`); a schema column the data does not carry is inserted as `NULL`.
- Unless the database fills it in itself: a generated primary key (`SERIAL`, `IDENTITY`) or a column with a `DEFAULT` is left out of the statement when the row does not carry it, so PostgreSQL supplies the value instead of receiving an explicit `NULL` — which it would reject for a `NOT NULL` column and would use in place of the default elsewhere.
- A `null` supplied for any column the database fills in itself — a generated primary key, a `DEFAULT`, an identity — counts as not carried, because the sender on this lane is an upstream node that may emit every schema key with `null` for the ones it has no value for. A `null` on a column with nothing behind it is inserted as `NULL` as given. (The `execute` tool is unaffected: a statement you write binds your `NULL`.)
- A primary key PostgreSQL is not known to generate (a composite key, a text key with no default) that a row omits is left out of the statement too, and PostgreSQL decides. The node does not refuse the row: "generates it itself" is read from reflected metadata, which does not describe triggers, so a `uuid`/`CHAR(36)` key filled by a `BEFORE INSERT` trigger is indistinguishable from a key nobody supplies — omitting the column is what lets the trigger run. Where nothing fills it in, PostgreSQL rejects the row with `null value in column "..." violates not-null constraint` and the whole batch is rolled back. (SQLAlchemy emits a Python `SAWarning` — once per column per process under the default filter — for a statement that leaves a primary key unbound; it is expected here.)
- Lists and dicts are serialised as JSON strings; booleans are stored as `0`/`1`.
- Each batch is inserted in a single transaction: on failure every row of it is rolled back and the error is raised as `Insert into "<table>" failed:` followed by PostgreSQL's own primary message, with the statement echo stripped exactly as for `execute`. On the `answers` lane the error is logged, not returned, so check the server log when rows do not appear.

### Supabase preset

`services.supabase.json` registers the same node as Supabase (`db_supabase://`); its tools carry the same bare names. The connection is encrypted over TLS. Operational notes:

- **Use the Supavisor pooler** from the Supabase dashboard (Connect button): `aws-0-<region>.pooler.supabase.com:6543` (transaction) or `:5432` (session). It works over IPv4.
- The **direct connection** (`db.<project-ref>.supabase.co:5432`) is IPv6-only and will fail to resolve on networks without IPv6.
- For the pooler, the user must include your project ref: `postgres.<project-ref>`. Without the suffix the pooler returns `no tenant identifier`. For the direct connection it is just `postgres`.
- The database password comes from your Supabase project (Project Settings -> Database); the database name defaults to `postgres`.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### PostgreSQL (`services.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `postgresdb.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit the execute, begin, commit, and rollback tool functions to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
| `postgresdb.database` | `string` | **Database name**<br/>Name of database | `"postgres"` |
| `postgresdb.db_description` | `string` | **Database description**<br/>What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `postgresdb.host` | `string` | **PostgreSQL host**<br/>Host name or IP address of the PostgreSQL server, optionally including a port (e.g. localhost:5433) | `"localhost"` |
| `postgresdb.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL | `5` |
| `postgresdb.password` | `string` | **Password**<br/>Password to connect to the PostgreSQL server |  |
| `postgresdb.profile` | `string` |  | `"default"` |
| `postgresdb.table` | `string` | **Table name**<br/>Name of table | `"table"` |
| `postgresdb.user` | `string` | **User**<br/>User to connect to the PostgreSQL server | `"postgres"` |

### Supabase (`services.supabase.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `postgresdb.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit the execute, begin, commit, and rollback tool functions to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
| `postgresdb.database` | `string` | **Database name**<br/>Name of database (Supabase default is 'postgres') | `"postgres"` |
| `postgresdb.db_description` | `string` | **Database description**<br/>What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `postgresdb.host` | `string` | **Supabase host**<br/>From the Supabase dashboard (Connect button), including the port. Recommended: the Supavisor pooler (works over IPv4) -> aws-0-<region>.pooler.supabase.com:6543 (transaction) or :5432 (session). The Direct connection (db.<project-ref>.supabase.co:5432) is IPv6-only and will fail to resolve on networks without IPv6. |  |
| `postgresdb.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL | `5` |
| `postgresdb.password` | `string` | **Password**<br/>Database password from your Supabase project (Project Settings -> Database) |  |
| `postgresdb.profile` | `string` |  | `"default"` |
| `postgresdb.table` | `string` | **Table name**<br/>Name of table | `"table"` |
| `postgresdb.user` | `string` | **User**<br/>Database user. For the pooler (recommended) it MUST include your project ref: postgres.<project-ref>, without the .<project-ref> suffix the pooler returns 'no tenant identifier'. For the direct connection it is just: postgres | `"postgres"` |

## Dependencies

- `psycopg2-binary` `==2.9.12`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_postgres)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
