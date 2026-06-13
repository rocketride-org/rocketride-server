# db_postgres

A RocketRide database node that answers natural-language questions against a PostgreSQL database and inserts structured pipeline data into tables.

## What it does

Plays two roles in a pipeline. As a pipeline node, it receives natural-language questions on the `questions` lane, asks a connected LLM to translate them into SQL, executes the query, and emits the results; it also accepts structured data on the `answers` lane and inserts it into the configured table. As a tool node, agents call it directly through three functions: `get_data`, `get_schema`, and `get_sql`.

Uses SQLAlchemy with the psycopg2 driver (`psycopg2-binary`). The connection string is built as `postgresql+psycopg2://user:password@host/database`; user, password, and database are URL-encoded so reserved characters (`@`, `/`, `#`, `:`) are safe, and the host may carry an explicit port (e.g. `localhost:5433`).

Safety defaults: only `SELECT` statements are permitted for queries (whitelist check, see SQL safety below), generated SQL is validated with `EXPLAIN` against the live database before execution, and raw SQL execution (`QuestionType.EXECUTE`) is disabled by default via `allow_execute`.

The same implementation also ships as a Supabase preset (`services.supabase.json`, protocol `db_supabase://`): Supabase is managed Postgres, so it is a branded configuration, not separate code.

---

## Connections

| Connection | Required | Description                                    |
| ---------- | -------- | ---------------------------------------------- |
| `llm`      | yes      | LLM used to generate SQL from natural language |

---

## Configuration

### Lanes

| Lane in     | Lane out | Description                                                    |
| ----------- | -------- | -------------------------------------------------------------- |
| `questions` | `table`  | Translate question to SQL, execute, return as a markdown table |
| `questions` | `text`   | Translate question to SQL, execute, return as text             |
| `questions` | `answers`| Translate question to SQL, execute, return as answers          |
| `answers`   | (none)   | Parse structured rows and insert into the table                |

If the LLM decides a question is not a database query, its text response is emitted instead of query results.

Two special question types are handled on the `questions` lane:

- **`QuestionType.DIALECT`**: emits `{"dialect": "postgres"}` on the `answers` lane so SDK callers can branch on the underlying engine.
- **`QuestionType.EXECUTE`**: runs the question text as raw SQL (read or write, no LLM, no safety check). Gated by `allow_execute`; when disabled the request is logged and dropped. `SELECT` results are capped at 25,000 rows; write statements report `affected_rows`.

### Fields

| Field | Type | Description |
|---|---|---|
| `host` | string | Default "localhost". Host name or IP address of the PostgreSQL server, optionally including a port (e.g. localhost:5433) |
| `user` | string | Default "postgres". User to connect to the PostgreSQL server |
| `password` | string | Password to connect to the PostgreSQL server |
| `database` | string | Default "postgres". Name of database |
| `table` | string | Default "table". Name of table |
| `db_description` | string | Default empty. What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. |
| `max_attempts` | integer | Default 5. Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL |
| `allow_execute` | boolean | Default false. Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. |
| `profile` | string | Default "default".  |

The single `default` profile presets `database` to `postgres`.

---

## Available tools

When connected to an agent, the node exposes three functions (named under the configured server prefix, default `postgres`):

| Tool         | Description                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `get_data`   | Natural language to SQL, executes it, returns rows plus the generated SQL (default 250 rows, max 25,000 via `limit`) |
| `get_schema` | Returns tables, columns, types, primary keys, and foreign keys, for the full database or one table                |
| `get_sql`    | Natural language to SQL only, no execution                                                                        |

`get_data` and `get_sql` return `valid: false` with an `error` (unsafe SQL) or an `answer` (the question was not a database query) when no executable query is produced.

---

## SQL safety & validation

Generated SQL passes two gates before execution:

1. **Whitelist check**: only statements beginning with `SELECT` (optionally prefixed by `EXPLAIN`) are allowed; everything else is rejected. Comments are stripped first so comment-based bypasses are neutralised, every statement in a multi-statement input is checked, `SELECT ... INTO OUTFILE/DUMPFILE` is blocked, and `WITH` (CTE) is deliberately excluded because PostgreSQL accepts CTE-into-mutation (e.g. `WITH x AS (...) DELETE ...`).
2. **`EXPLAIN` validation**: the query is validated against the live database. If `EXPLAIN` rejects it, the rejected SQL and the database error are fed back to the LLM for a corrected query, up to `max_attempts` times (default 5).

Insert operations never go through SQL generation; they use the `answers` lane.

---

## Data insertion

Rows arriving on the `answers` lane are inserted into the configured `table`:

- The table is auto-created from the shape of the first batch if it does not exist (column types inferred from the data).
- Incoming keys are matched to columns case-insensitively (`UserName` maps to `username`); schema columns missing from the data are inserted as `NULL`.
- Lists and dicts are serialised as JSON strings; booleans are stored as `0`/`1`.
- Each batch is inserted in a single transaction: on failure it is rolled back and the error re-raised.

---

## Supabase preset

`services.supabase.json` registers the same node as Supabase (`db_supabase://`, prefix `supabase`). The connection is encrypted over TLS. Operational notes:

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
| `postgresdb.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
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
| `postgresdb.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
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
