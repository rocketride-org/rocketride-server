---
title: Aparavi AQL
sidebar_position: 2
---

# Aparavi AQL

The `aparavi_aql` node lets an AI agent query the Aparavi data-governance
platform in plain English using AQL (Aparavi Query Language). It translates
natural-language questions into AQL `SELECT` statements, runs them against the
Aparavi REST API, and returns file-metadata rows from the Aparavi **STORE**
table. The agent never needs to know AQL or the schema — it just asks a
question.

This is a pure tool node: it defines no pipeline lanes and is used only through
its agent-callable tools.

## When to use Aparavi AQL

- **Data discovery** — let an agent find files by type, size, age, owner,
  classification, or tag across an Aparavi-indexed estate.
- **Governance Q&A** — answer questions about storage cost, duplicates,
  classifications, and permissions without writing queries.
- **Agent workflows** — combine Aparavi lookups with other tools in a reasoning
  loop.

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | `""` | Base URL of the Aparavi server, e.g. `https://aparavi.example.com`. |
| `user` | string | `""` | Aparavi login username. |
| `password` | string | | Aparavi login password. |
| `db_description` | string | `""` | What the data is used for — improves AQL accuracy. |

The node ships a single `default` profile. Execution goes over HTTP
(`POST /server/api/v3/database/query`) with HTTP Basic Auth, a 30-second
timeout, and a default row limit of 250. Timestamp columns returned in
milliseconds are normalized to seconds.

## Connections

| Connection | Min | Description |
| --- | --- | --- |
| `llm` | 1 | LLM used to generate AQL queries from natural language. |

## Safety

Every generated query is checked before it touches the network. Only a single
`SELECT` is allowed; multi-statement input is rejected, and the keywords
`INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `EXEC`, and
`EXECUTE` are blocked anywhere in the query. A failed safety check returns an
error immediately. If generation or execution fails, the node makes up to 3
attempts, feeding the failed AQL and the server's error message back to the LLM
to correct it.

## Agent tools

| Tool | What it does |
| --- | --- |
| `get_data` | Translate a natural-language question to AQL, run the safety check, execute against Aparavi, and return rows. The primary tool. |
| `get_aql` | Convert a question to an AQL `SELECT` without executing it. Use only when the user explicitly wants to see the query. |
| `get_schema` | Fallback only — returns the fixed column schema for the STORE table. Not to be called preemptively. |

## AQL at a glance

`STORE` is the only table (no JOINs). Query structure:

```
SELECT cols FROM STORE [WHERE cond] [WHICH CONTAIN 'term'] [GROUP BY col] [HAVING cond] [ORDER BY col ASC|DESC] [LIMIT n]
```

`LIMIT 250` is added unless the user specifies otherwise. Size units (`10 MB`,
`5 GB`, `100 KB`), date functions (`NOW()`, `TODAY()`, `YEAR()`, `MONTH()`,
`DAY()`), aggregates, string functions, `CAST`, and `CASE WHEN` are supported.
DATE columns are compared in epoch seconds.

```sql
-- "Find all PDF files larger than 10 MB"
SELECT name, parentPath, size, modifyTime FROM STORE WHERE extension = 'pdf' AND size > 10 MB LIMIT 250

-- "Count files by extension"
SELECT extension, COUNT(*) AS "count" FROM STORE GROUP BY extension ORDER BY "count" DESC LIMIT 250

-- "Files modified in the last 7 days"
SELECT name, parentPath, size, modifyTime FROM STORE WHERE modifyTime > NOW() - (7 * 86400) LIMIT 250
```

The STORE schema is fixed (roughly 100 columns covering identity, file
attributes, timestamps, document/email metadata, cost and storage metrics,
tags, classifications, ownership, and status flags) and injected into the LLM
prompt with AQL syntax rules and few-shot examples.

## Authentication

The node authenticates with HTTP Basic Auth using the configured `user` and
`password` on every API request. Credentials are held in memory for the lifetime
of the pipeline and released when it ends.

## Related

- [`aparavi_aql` node reference](/nodes/aparavi_aql)
- [PostgreSQL integration](/integrations/postgres) — natural-language SQL over a relational database
- [Concepts: Agents & Tools](/concepts/agents-tools-skills)
