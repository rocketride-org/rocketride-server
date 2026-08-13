# rocketride_sql

A RocketRide-managed database node that answers natural-language questions against your own provisioned RocketRide cloud database and inserts structured pipeline data into tables — with **zero database setup**.

## What it does

The same two roles as the generic `db_postgres` node. As a pipeline node, it receives natural-language questions on the `questions` lane, asks a connected LLM to translate them into SQL, executes the query, and emits the results; it also accepts structured data on the `answers` lane and inserts it into the configured table. As a tool node, agents call it directly through `get_data`, `get_schema`, `get_sql`, `execute`, and `dialect`.

The defining difference: **there are no connection fields**. Instead of host/user/password, the node resolves a ready per-tenant DSN from the account layer (`Account.resolve_db_dsn(client_id)`), keyed by the authenticated connection identity. The RocketRide cloud provisions one database per tenant; the same database backs `rocketride_sql`, `rocketride_vector`, and `rocketride_graph`, so raw SQL over the vector tables also goes through this node.

Requires signing into RocketRide cloud. On the open-source build without a cloud identity the node fails at start with `RocketRide cloud DB nodes require signing into RocketRide cloud`.

Safety defaults match `db_postgres`: only `SELECT` statements are permitted for LLM-generated queries, generated SQL is validated with `EXPLAIN` before execution, and raw SQL execution (`QuestionType.EXECUTE`) is disabled by default via `allow_execute`. Isolation for raw execution comes from the database-per-tenant boundary, not query inspection.

---

## Connections

| Connection | Required | Description                                    |
| ---------- | -------- | ---------------------------------------------- |
| `llm`      | yes      | LLM used to generate SQL from natural language |

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                                    |
| ----------- | --------- | -------------------------------------------------------------- |
| `questions` | `table`   | Translate question to SQL, execute, return as a markdown table |
| `questions` | `text`    | Translate question to SQL, execute, return as text             |
| `questions` | `answers` | Translate question to SQL, execute, return as answers          |
| `answers`   | (none)    | Parse structured rows and insert into the table                |

Two special question types are handled on the `questions` lane:

- **`QuestionType.DIALECT`**: emits `{"dialect": "postgres"}` on the `answers` lane so SDK callers can branch on the underlying engine.
- **`QuestionType.EXECUTE`**: runs the question text as raw SQL (read or write, no LLM, no safety check). Gated by `allow_execute`; when disabled the request is logged and dropped. `SELECT` results are capped at 25,000 rows; write statements report `affected_rows`.

### Fields

| Field | Type | Description |
|---|---|---|
| `table` | string | Default "table". Name of the table to read from or write to |
| `db_description` | string | Default empty. What is this database used for? Helps the LLM generate more accurate queries. |
| `max_attempts` | integer | Default 5. Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL |
| `allow_execute` | boolean | Default false. Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. |

There are intentionally no `host` / `user` / `password` / `database` fields — the connection is resolved from your signed-in RocketRide identity.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
