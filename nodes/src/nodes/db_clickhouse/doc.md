---
title: ClickHouse
date: 2026-06-01
sidebar_position: 1
---

## What it does

ClickHouse node with two roles: pipeline node (natural-language queries via lanes) and tool node (agents call it directly). Connects over the native TCP protocol (default port 9000) via `clickhouse-driver`. This is a **query / read** node — it does not expose a pipeline ingestion (insert) lane (see [Ingestion](#ingestion)).

## Connections

| Connection | Required | Description                                    |
| ---------- | -------- | ---------------------------------------------- |
| `llm`      | yes      | LLM used to generate SQL from natural language |

## As a pipeline node

**Lanes:**

| Lane in     | Lane out  | Description                                           |
| ----------- | --------- | ----------------------------------------------------- |
| `questions` | `table`   | Translate question → SQL → execute, return as table   |
| `questions` | `text`    | Translate question → SQL → execute, return as text    |
| `questions` | `answers` | Translate question → SQL → execute, return as answers |

## As a tool

When connected to an agent, exposes three functions under the configured server name (default: `clickhouse`):

| Function                | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `clickhouse.get_data`   | Natural language → SQL → execute, returns rows (default 250, max 25 000) |
| `clickhouse.get_schema` | Returns tables, columns, types, and primary keys                         |
| `clickhouse.get_sql`    | Natural language → SQL only — no execution                               |

Only `SELECT` is permitted for queries.

## Configuration

| Field                   | Default     | Description                                                                          |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------ |
| Database Description    | —           | Plain-language description of the database, used to guide SQL generation             |
| Host                    | `localhost` | ClickHouse server address, optionally `host:port` (native protocol, defaults to 9000) |
| User                    | `default`   | Database username                                                                    |
| Password                | —           | Database password (empty for the stock `default` user)                              |
| Database                | `default`   | Database name                                                                        |
| Use TLS                 | `false`     | Connect over TLS. Turn ON for **ClickHouse Cloud** (assumes native TLS port 9440 when the host has no explicit port). ClickHouse-only — not present on the MySQL/PostgreSQL nodes |
| Table                   | `table`     | Target table name                                                                    |
| Max Validation Attempts | `5`         | Retry limit for EXPLAIN-based SQL validation (range 1–20)                            |
| Allow direct execution  | `false`     | Permit raw `QuestionType.EXECUTE` SQL without LLM translation or safety checks       |

## SQL validation

Generated SQL is validated by running `EXPLAIN` against the live database. If validation fails, the error is fed back to the LLM for a corrected query. This repeats up to **Max Validation Attempts** times before the node raises an error.

## ClickHouse Cloud

To connect to a ClickHouse Cloud service:

1. In the Cloud console, open your service → **Connect** and copy the **native** endpoint host (e.g. `abc123.us-east-1.aws.clickhouse.cloud`) and the `default` user password.
2. Configure the node with: **Host** = that hostname (no port needed — TLS port 9440 is assumed), **User** = `default`, **Password** = your service password, **Use TLS** = ON.
3. Make sure your machine's IP is allowed under the service's **IP Access List** (or set it to "Anywhere" for testing).

## Ingestion

Unlike the MySQL/PostgreSQL nodes, this node intentionally does **not** expose the ingestion/input `answers` lane (used for pipeline inserts). This removes only that input lane — **not** the `questions → answers` output lane used for querying, which still works. The shared auto-create-table helper builds tables with an auto-increment integer primary key and no table engine — neither of which exists in ClickHouse (tables require an explicit engine such as `MergeTree`) — so the inherited insert/auto-create path cannot work here. Create your tables in ClickHouse directly, and use this node for querying. (A ClickHouse-correct ingestion path can be added later as a separate feature.)

## Notes

- ClickHouse is column-oriented and has no foreign keys; the reflected schema therefore exposes columns and (best-effort) primary keys but no FK relationships.
- The node is **read-only by default**: the natural-language path only ever runs `SELECT`. Raw SQL (`QuestionType.EXECUTE`) is gated behind the **Allow direct execution** toggle and is intended only for trusted callers.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

- **Class type** — database, tool
- **Capabilities** — noremote, invoke
- **Protocol** — `db_clickhouse://`

**Data lanes**

- `questions` → `table`, `text`, `answers`

**Profiles**

- `default`

**Configuration sections**

- **ClickHouse** — `clickhouse.profile`

**Schema**

- **ClickHouse host** (`clickhouse.host`) — `string`, default `localhost`. Host name or IP address of the ClickHouse server, optionally including a native-protocol port (e.g. localhost:9440). Defaults to port 9000 when none is given.
- **User** (`clickhouse.user`) — `string`, default `default`. User to connect to the ClickHouse server
- **Password** (`clickhouse.password`) — `string`. Password to connect to the ClickHouse server
- **Database name** (`clickhouse.database`) — `string`, default `default`. Name of database
- **Use TLS** (`clickhouse.tls`) — `boolean`, default `false`. Connect over TLS. Required for managed services such as ClickHouse Cloud (native TLS port 9440 is assumed when the host has no explicit port). Leave OFF for a plaintext local server on port 9000. ClickHouse-specific — MySQL/PostgreSQL nodes do not expose this.
- **Table name** (`clickhouse.table`) — `string`, default `table`. Name of table
- **Database description** (`clickhouse.db_description`) — `string`. What is this database used for? Describe its content and purpose — this helps the LLM generate more accurate queries.
- **Max validation attempts** (`clickhouse.max_attempts`) — `integer`, default `5`. Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated SQL
- **Allow direct query execution** (`clickhouse.allow_execute`) — `boolean`, default `false`. Permit QuestionType.EXECUTE callers to run raw SQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue SQL directly.
- `clickhouse.profile` — `string`, default `default`

### Dependencies

- `clickhouse-sqlalchemy` `==0.3.2`
- `clickhouse-driver` `==0.2.9`

### Classes

**`IGlobal.py` — `IGlobal(DatabaseGlobalBase)`**

ClickHouse-specific global state.

**`IInstance.py` — `IInstance(DatabaseInstanceBase)`**

ClickHouse-specific instance.

### Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> GitHub/db_clickhouse](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_clickhouse)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
