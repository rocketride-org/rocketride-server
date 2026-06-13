# db_clickhouse

A RocketRide database node that answers natural-language questions against a ClickHouse database by translating them into SQL with an LLM.

## What it does

Plays two roles: a pipeline node (natural-language questions arrive on a lane, results leave as a table, text, or structured answers) and a tool node (an agent calls `get_data`, `get_schema`, or `get_sql` directly).

Connects over ClickHouse's native TCP protocol (default port 9000) using **clickhouse-sqlalchemy** with the **clickhouse-driver** backend (`clickhouse+native://` DSN). Generated SQL is validated with `EXPLAIN` against the live database before execution; if validation fails the error is fed back to the LLM for a corrected query, repeating up to `max_attempts` times.

The node is read-only by default: the natural-language path only ever runs `SELECT`. Raw SQL execution (`QuestionType.EXECUTE`) is gated behind the `allow_execute` toggle, which is off by default and intended only for trusted callers. This is also a query/read node: it does not expose a pipeline ingestion (insert) lane (see [Ingestion](#ingestion)).

---

## Connections

| Connection | Required    | Description                                     |
|------------|-------------|-------------------------------------------------|
| `llm`      | yes (min 1) | LLM used to generate SQL from natural language  |

---

## Available tools

When connected to an agent, the node exposes three functions:

| Tool         | Description                                                                    |
|--------------|--------------------------------------------------------------------------------|
| `get_data`   | Natural language to SQL, executes it, returns rows (default 250, max 25 000)  |
| `get_schema` | Returns tables, columns, types, and primary keys                               |
| `get_sql`    | Natural language to SQL only, no execution                                     |

Only `SELECT` is permitted for generated queries.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                            |
|-------------|-----------|--------------------------------------------------------|
| `questions` | `table`   | Translate question to SQL, execute, return as table    |
| `questions` | `text`    | Translate question to SQL, execute, return as text     |
| `questions` | `answers` | Translate question to SQL, execute, return as answers  |

### Fields

| Field | Type | Description |
|---|---|---|
| `host` | string | Default "localhost". Host name or IP address of the ClickHouse server, optionally including a native-protocol port (e.g. localhost:9440). Defaults to port 9000 when none is given. |
| `user` | string | Default "default". User to connect to the ClickHouse server |
| `password` | string | Password to connect to the ClickHouse server |
| `database` | string | Default "default". Name of database |
| `tls` | boolean | Default false. Connect over TLS. Required for managed services such as ClickHouse Cloud (native TLS port 9440 is assumed when the host has no explicit port). Leave OFF for a plaintext local server on port 9000. ClickHouse-specific, MySQL/PostgreSQL nodes do not expose this. |
| `table` | string | Default "table". Name of table |
| `db_description` | string | Default empty. What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. |
| `max_attempts` | integer | Default 5. Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL |
| `allow_execute` | boolean | Default false. Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. |
| `profile` | string | Default "default".  |

The node ships a single `default` profile that pre-sets `database: default`.

---

## SQL validation

Generated SQL is validated by running `EXPLAIN` against the live database. If validation fails, the error is fed back to the LLM for a corrected query. This repeats up to `max_attempts` times before the node raises an error. The retry limit is clamped to 1-20 regardless of the value stored in config.

---

## ClickHouse Cloud

To connect to a ClickHouse Cloud service:

1. In the Cloud console, open your service, choose **Connect**, and copy the **native** endpoint host (e.g. `abc123.us-east-1.aws.clickhouse.cloud`) and the `default` user password.
2. Configure the node with: `host` = that hostname (no port needed, TLS port 9440 is assumed), `user` = `default`, `password` = your service password, `tls` = ON.
3. Make sure your machine's IP is allowed under the service's **IP Access List** (or set it to "Anywhere" for testing).

---

## Ingestion

Unlike the MySQL/PostgreSQL nodes, this node intentionally does not expose the ingestion/input `answers` lane (used for pipeline inserts). This removes only that input lane, not the `questions` to `answers` output lane used for querying, which still works. The shared auto-create-table helper builds tables with an auto-increment integer primary key and no table engine, neither of which exists in ClickHouse (tables require an explicit engine such as `MergeTree`), so the inherited insert/auto-create path cannot work here. Create your tables in ClickHouse directly, and use this node for querying. A ClickHouse-correct ingestion path can be added later as a separate feature.

---

## Notes

- ClickHouse is column-oriented and has no foreign keys; the reflected schema therefore exposes columns and (best-effort) primary keys but no FK relationships.
- The `tls` config field is distinct from clickhouse-driver's `?secure=true` DSN parameter (which the node sets on the wire when TLS is enabled) and from the field-level `"secure": true` attribute on the password field, which only marks the value as a masked secret.
- `user`, `password`, and `database` are URL-encoded when building the connection string, so reserved characters (`@`, `/`, `#`, `:`) in credentials are safe.
- Bracketed IPv6 literals (e.g. `[::1]`) are supported in `host`; a port is only detected when a `:` follows the closing `]`.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `clickhouse.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly. | `false` |
| `clickhouse.database` | `string` | **Database name**<br/>Name of database | `"default"` |
| `clickhouse.db_description` | `string` | **Database description**<br/>What is this database used for? Describe its content and purpose, this helps the LLM generate more accurate queries. | `""` |
| `clickhouse.host` | `string` | **ClickHouse host**<br/>Host name or IP address of the ClickHouse server, optionally including a native-protocol port (e.g. localhost:9440). Defaults to port 9000 when none is given. | `"localhost"` |
| `clickhouse.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL | `5` |
| `clickhouse.password` | `string` | **Password**<br/>Password to connect to the ClickHouse server |  |
| `clickhouse.profile` | `string` |  | `"default"` |
| `clickhouse.table` | `string` | **Table name**<br/>Name of table | `"table"` |
| `clickhouse.tls` | `boolean` | **Use TLS**<br/>Connect over TLS. Required for managed services such as ClickHouse Cloud (native TLS port 9440 is assumed when the host has no explicit port). Leave OFF for a plaintext local server on port 9000. ClickHouse-specific, MySQL/PostgreSQL nodes do not expose this. | `false` |
| `clickhouse.user` | `string` | **User**<br/>User to connect to the ClickHouse server | `"default"` |

## Dependencies

- `clickhouse-sqlalchemy` `==0.3.2`
- `clickhouse-driver` `==0.2.9`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_clickhouse)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
