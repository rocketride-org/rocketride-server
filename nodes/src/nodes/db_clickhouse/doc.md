---
title: ClickHouse
date: 2026-06-01
sidebar_position: 1
---

## What it does

ClickHouse node with two roles: pipeline node (natural-language queries via lanes) and tool node (agents call it directly). Connects over the native TCP protocol (default port 9000) via `clickhouse-driver`. This is a **query / read** node, it does not expose a pipeline ingestion (insert) lane (see [Ingestion](#ingestion)).

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
| `clickhouse.get_sql`    | Natural language → SQL only, no execution                               |

Only `SELECT` is permitted for queries.

## Configuration

| Field                   | Default     | Description                                                                          |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------ |
| Database Description    | -           | Plain-language description of the database, used to guide SQL generation             |
| Host                    | `localhost` | ClickHouse server address, optionally `host:port` (native protocol, defaults to 9000) |
| User                    | `default`   | Database username                                                                    |
| Password                | -           | Database password (empty for the stock `default` user)                              |
| Database                | `default`   | Database name                                                                        |
| Use TLS                 | `false`     | Connect over TLS. Turn ON for **ClickHouse Cloud** (assumes native TLS port 9440 when the host has no explicit port). ClickHouse-only, not present on the MySQL/PostgreSQL nodes |
| Table                   | `table`     | Target table name                                                                    |
| Max Validation Attempts | `5`         | Retry limit for EXPLAIN-based SQL validation (range 1–20)                            |
| Allow direct execution  | `false`     | Permit raw `QuestionType.EXECUTE` SQL without LLM translation or safety checks       |

## SQL validation

Generated SQL is validated by running `EXPLAIN` against the live database. If validation fails, the error is fed back to the LLM for a corrected query. This repeats up to **Max Validation Attempts** times before the node raises an error.

## ClickHouse Cloud

To connect to a ClickHouse Cloud service:

1. In the Cloud console, open your service → **Connect** and copy the **native** endpoint host (e.g. `abc123.us-east-1.aws.clickhouse.cloud`) and the `default` user password.
2. Configure the node with: **Host** = that hostname (no port needed, TLS port 9440 is assumed), **User** = `default`, **Password** = your service password, **Use TLS** = ON.
3. Make sure your machine's IP is allowed under the service's **IP Access List** (or set it to "Anywhere" for testing).

## Ingestion

Unlike the MySQL/PostgreSQL nodes, this node intentionally does **not** expose the ingestion/input `answers` lane (used for pipeline inserts). This removes only that input lane, **not** the `questions → answers` output lane used for querying, which still works. The shared auto-create-table helper builds tables with an auto-increment integer primary key and no table engine, neither of which exists in ClickHouse (tables require an explicit engine such as `MergeTree`), so the inherited insert/auto-create path cannot work here. Create your tables in ClickHouse directly, and use this node for querying. (A ClickHouse-correct ingestion path can be added later as a separate feature.)

## Notes

- ClickHouse is column-oriented and has no foreign keys; the reflected schema therefore exposes columns and (best-effort) primary keys but no FK relationships.
- The node is **read-only by default**: the natural-language path only ever runs `SELECT`. Raw SQL (`QuestionType.EXECUTE`) is gated behind the **Allow direct execution** toggle and is intended only for trusted callers.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

| Property | Value |
| --- | --- |
| Class type | database, tool |
| Capabilities | noremote, invoke |
| Protocol | `db_clickhouse://` |

**Data lanes**

| Input | Produces |
| --- | --- |
| `questions` | `table`, `text`, `answers` |

**Profiles**

| Profile | Title | Model |
| --- | --- | --- |
| `default` |  |  |

**Configuration sections**

| Section | Fields |
| --- | --- |
| ClickHouse | `clickhouse.profile` |
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
