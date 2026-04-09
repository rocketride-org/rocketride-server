---
title: PostgreSQL
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>PostgreSQL - RocketRide Documentation</title>
</head>

## What it does

PostgreSQL node with two roles: pipeline node (natural-language queries via lanes) and tool node (agents call it directly).

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
| `answers`   | —         | Parse structured data and insert into table           |

Auto-creates the target table on first insert if it doesn't exist.

## As a tool

When connected to an agent, exposes three functions under the configured server name (default: `postgres`):

| Function              | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `postgres.get_data`   | Natural language → SQL → execute, returns rows (default 250, max 25 000) |
| `postgres.get_schema` | Returns tables, columns, types, primary keys, and foreign keys           |
| `postgres.get_sql`    | Natural language → SQL only — no execution                               |

Only `SELECT` is permitted for queries. Insert operations use the `answers` lane.

## Configuration

| Field                   | Default     | Description                                                                     |
| ----------------------- | ----------- | ------------------------------------------------------------------------------- |
| Database Description    | —           | Plain-language description of the database, used to guide SQL generation        |
| Host                    | `localhost` | PostgreSQL server address; include port for non-default (e.g. `localhost:5433`) |
| User                    | `postgres`  | Database username                                                               |
| Password                | —           | Database password                                                               |
| Database                | `postgres`  | Database name                                                                   |
| Table                   | `table`     | Target table name                                                               |
| Max Validation Attempts | `5`         | Retry limit for EXPLAIN-based SQL validation (range 1–20)                       |

## SQL validation

Generated SQL is validated by running `EXPLAIN` against the live database. If validation fails, the error is fed back to the LLM for a corrected query. This repeats up to **Max Validation Attempts** times before the node raises an error.
