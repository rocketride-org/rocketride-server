# database

The Supabase Database service of the `supabase` node: ask a Supabase project's Postgres database questions in plain English, run SQL, and insert pipeline rows into a table. Pick it when the data you want to query lives in a Supabase project.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Every Supabase project has its own Postgres database, reached through a connection pooler called Supavisor.

## What it does

This is the PostgreSQL database node (`db_postgres`) registered for Supabase, with nothing added: the same code, the same nine tools and the same lanes. As a pipeline node it turns questions on the `questions` lane into SQL with a connected LLM, runs them read-only and returns the rows, and it inserts structured rows that arrive on the `answers` lane into the configured table. As an agent tool it offers the same functions as `db_postgres`. It was a preset in the `db_postgres` folder before; the protocol (`db_supabase://`) and every setting are unchanged, so saved pipelines keep working.

## Connections

| Connection | Required | Description |
|---|---|---|
| `llm` | no | LLM that writes SQL from a natural-language question; not needed for `execute` (raw SQL). |

## Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `questions` | `table` | Translate the question to SQL, run it, return a markdown table |
| `questions` | `text` | Translate the question to SQL, run it, return text |
| `questions` | `answers` | Translate the question to SQL, run it, return answers |
| `answers` | — | Insert the structured rows into the configured table |

## As a tool

Nine functions, exactly those of `db_postgres` (its README has the full contract, including the error and session rules). Tool names are the bare method names; an agent sees them as `<component-id>.<function>`.

| Function | Description |
|---|---|
| `get_data` | Natural language to a read-only SQL query; runs it and returns the rows plus the SQL (default 250 rows, `limit` up to 25,000). |
| `get_schema` | Tables, columns, types, primary and foreign keys, for the whole database or one table. |
| `refresh_schema` | Re-reads the schema from the database and returns it with a `refreshed_at` timestamp. |
| `get_sql` | Natural language to SQL only, nothing is run. |
| `dialect` | Returns `{"dialect": "postgres"}`. |
| `execute` | Runs a raw SQL statement as written (optional `params`, `session_id`, `row_mode`). Only with **Allow direct query execution** on. |
| `begin` | Opens a transaction and returns a `session_id`. Only with **Allow direct query execution** on. |
| `commit` | Commits a session. Only with **Allow direct query execution** on. |
| `rollback` | Rolls a session back. Only with **Allow direct query execution** on. |

There is no Supabase access level on this service: **Allow direct query execution** is its only guard, as before. Raw SQL runs as the database user you configure, which on Supabase is usually the project's `postgres` user.

## Configuration

Fill in the pooler connection from the Supabase dashboard and leave the rest at the defaults; the database name is preset to `postgres`.

### Supabase host

Use the Supavisor pooler from the dashboard's **Connect** panel, with the port: `aws-0-<region>.pooler.supabase.com:5432` (session mode) or `:6543` (transaction mode). It works over IPv4. The direct connection (`db.<project-ref>.supabase.co:5432`) is IPv6-only and fails to resolve on networks without IPv6.

### User

For the pooler the user must include the project ref: `postgres.<project-ref>`. Without the suffix the pooler answers `no tenant identifier`. For the direct connection it is just `postgres`.

### Database description

A plain description of what the database holds, added to the LLM prompt when it writes SQL. A specific description ("orders and customers of the EU web shop; `orders.status` is pending, shipped or returned") makes generated queries much more accurate.

### Allow direct query execution

Off by default. Turns on `execute`, `begin`, `commit` and `rollback`, which run SQL without the LLM, without the SELECT-only check and outside the read-only transaction. Leave it off unless a trusted application needs raw SQL.

## Authentication

The database password is in the Supabase dashboard under Project Settings -> Database. This service does not use the project's API keys.

## Limitations

Declared `noremote`: it runs on the local engine host only, not as remote execution. The engine host needs a network path to the Supabase pooler.

## Notes

### Moved from db_postgres

This service used to be `db_postgres/services.supabase.json`. It now lives in `supabase/services.database.json` with the same protocol, lanes, LLM connection and `postgresdb.*` fields, names and defaults. Its `path` is still `nodes.db_postgres`: the code is `db_postgres`'s own `IGlobal` and `IInstance`, with no wrapper.

### TLS

The connection string is the same as `db_postgres` builds (`postgresql+psycopg2://user:password@host/database`), without an `sslmode`. The driver's default (`prefer`) uses TLS when the server offers it, which the Supabase pooler does, but it does not refuse a connection without TLS. Supabase Vector and Supabase Cron always require TLS.

## Upstream docs

- [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supavisor connection pooler](https://supabase.com/docs/guides/database/supavisor)
