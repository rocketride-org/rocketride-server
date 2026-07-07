---
title: PostgreSQL
sidebar_position: 5
---

# PostgreSQL

The `db_postgres` node translates natural-language questions into SQL queries
and executes them against a PostgreSQL database. It also supports writing
pipeline output back to a table, and can be used as an agent tool for dynamic
data access.

The same node ships a Supabase preset that uses
identical logic with Supabase-appropriate defaults.

## When to use PostgreSQL

- **Structured data Q&A** — let users ask questions in plain English and get
  answers from a relational database without writing SQL.
- **Data insertion** — write pipeline output (extracted fields, classified
  records, generated content) back to a table.
- **Agent data access** — give an agent the ability to query or update a
  database as part of a reasoning loop.

## Configuration

```json
{
  "id": "db_1",
  "provider": "db_postgres",
  "config": {
    "host": "localhost",
    "user": "postgres",
    "password": "${POSTGRES_PASSWORD}",
    "database": "mydb",
    "table": "reports",
    "db_description": "A table of quarterly sales reports with columns: id, quarter, revenue, region.",
    "profile": "default"
  },
  "input": [
    { "lane": "questions", "from": "llm_1" }
  ]
}
```

### Key configuration fields

| Field | Purpose |
| --- | --- |
| `host` | PostgreSQL host (hostname or IP). |
| `user` / `password` | Database credentials. Use `${ENV_VAR}` for the password. |
| `database` | Target database name. |
| `table` | Default table for queries and inserts. |
| `db_description` | Plain-English description of the table schema. Helps the LLM generate accurate SQL. The more specific, the better. |
| `allow_execute` | `false` by default. Set to `true` to allow `INSERT`, `UPDATE`, `DELETE`. Without this, only `SELECT` is permitted. |
| `max_attempts` | How many times the node retries a failed SQL generation. Default 3. |

### Safety

By default, only `SELECT` statements are permitted. The node validates
generated SQL using `EXPLAIN` before execution — if the query is syntactically
invalid, the LLM is asked to fix it (up to `max_attempts` times). Comment
stripping and `INTO` blocking prevent basic injection attempts.

Set `allow_execute: true` only when the pipeline genuinely needs to write data.
Keep it `false` for read-only Q&A use cases.

## Wiring: natural-language Q&A

Connect the node to receive questions from an LLM or directly from a source:

```json
{
  "nodes": [
    { "id": "source_1", "provider": "webhook" },
    {
      "id": "llm_1",
      "provider": "llm_openai",
      "config": { "profile": "openai-4o", "apikey": "${OPENAI_API_KEY}" },
      "input": [{ "lane": "questions", "from": "source_1" }]
    },
    {
      "id": "db_1",
      "provider": "db_postgres",
      "config": {
        "host": "localhost",
        "user": "postgres",
        "password": "${POSTGRES_PASSWORD}",
        "database": "sales",
        "table": "orders",
        "db_description": "Orders table: id (int), customer (text), amount (numeric), created_at (timestamp)."
      },
      "input": [{ "lane": "questions", "from": "llm_1" }]
    },
    {
      "id": "target_1",
      "provider": "response",
      "input": [{ "lane": "answers", "from": "db_1" }]
    }
  ]
}
```

Ask a question:

```bash
curl -X POST http://localhost:5567/task/data \
  -H "Authorization: Bearer <auth-key>" \
  -H "Content-Type: text/plain" \
  -d "What were the top 5 orders by amount last month?"
```

The node generates SQL, validates it, executes it, and returns the results as a
formatted answer.

## Agent tools

When connected to an agent via a control connection, `db_postgres` exposes three
tools:

| Tool | What it does |
| --- | --- |
| `get_data` | Translates a natural-language question to SQL and returns results. |
| `get_schema` | Returns the schema of the configured table. Useful for the agent to understand structure before querying. |
| `get_sql` | Returns the generated SQL without executing it. Useful for debugging or agent reasoning. |

## Supabase

The `db_postgres/supabase` variant uses the same implementation with
Supabase-appropriate defaults (port 5432, SSL required). Configure it with your
Supabase connection string details:

```json
{
  "id": "db_1",
  "provider": "db_postgres/supabase",
  "config": {
    "host": "<project>.supabase.co",
    "user": "postgres",
    "password": "${SUPABASE_DB_PASSWORD}",
    "database": "postgres",
    "table": "documents"
  }
}
```

## Related

- [`db_postgres` node reference](/nodes/db_postgres)
- [Document Extraction example](/examples/document-extraction) — writing extracted fields to a database
- [Concepts: Security Model](/concepts/security-model) — credential management
