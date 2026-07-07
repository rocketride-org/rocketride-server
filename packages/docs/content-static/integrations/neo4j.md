---
title: Neo4j
sidebar_position: 4
---

# Neo4j

The `db_neo4j` node answers natural-language questions against a Neo4j graph
database by translating them to Cypher with a connected LLM. It plays two roles:
a **pipeline node** that takes questions on the `questions` lane and emits
results downstream, and an **agent tool** that exposes graph retrieval directly
to a reasoning loop. Built for knowledge-graph retrieval, entity linking, and
graph-based RAG.

## When to use Neo4j

- **Graph RAG** — retrieve connected entities and relationships as context for
  an LLM instead of flat document chunks.
- **Knowledge-graph Q&A** — ask questions in plain English; the node generates
  and runs Cypher against the real graph schema.
- **Entity linking / traversal** — follow relationships across labels without
  hand-writing queries.
- **Agent memory** — an agent calls the node's tools to query the graph during
  a session.

## Read-only by design

Every generated or supplied Cypher statement passes a safety check that rejects
write and admin clauses (`CREATE`, `MERGE`, `DELETE`, `DETACH DELETE`, `SET`,
`REMOVE`, `DROP`, `FOREACH`, `LOAD CSV`, and mutating `apoc` procedures), with
comments stripped before checking. Queries time out after 30 seconds. The only
escape hatch is the opt-in `QuestionType.EXECUTE` path, gated by `allow_execute`
which is **off by default**.

## Configuration

The node connects over the Bolt protocol with the official neo4j Python driver.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `uri` | string | `neo4j://localhost:7687` | Bolt URI. Use `neo4j://`/`bolt://` for plaintext, `neo4j+s://`/`bolt+s://` for TLS (e.g. Neo4j Aura). |
| `auth_method` | string | `userpass` | `userpass` or `token`. |
| `user` | string | `neo4j` | Username for `userpass` auth. |
| `password` | string | | Password for `userpass` auth. |
| `token` | string | | Bearer token for `token` auth (e.g. Neo4j Aura). |
| `database` | string | `neo4j` | Database to connect to. |
| `db_description` | string | `""` | What the graph is used for — improves Cypher accuracy. |
| `max_attempts` | integer | `5` | Retries if `EXPLAIN` rejects generated Cypher (1–20). |
| `allow_execute` | boolean | `false` | Permit raw Cypher via `QuestionType.EXECUTE`, bypassing translation and safety checks. |

```json
{
  "id": "graph_1",
  "provider": "neo4jdb",
  "config": {
    "uri": "neo4j+s://your-instance.databases.neo4j.io",
    "auth_method": "userpass",
    "user": "neo4j",
    "database": "neo4j",
    "db_description": "Movie graph: People, Movies, and ACTED_IN / DIRECTED relationships."
  }
}
```

Saving the config runs a connectivity probe (`RETURN 1` against the configured
database) and surfaces driver errors (wrong password, unreachable host, bad
database name) as warnings before the pipeline starts.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes (min 1) | LLM used to generate Cypher from natural language. |

## Lanes

| Lane in | Lanes out | Description |
| --- | --- | --- |
| `questions` | `table`, `text`, `answers` | Translate question to Cypher, execute, emit results on each connected lane. |

Normal questions emit a markdown table on `table` and `answers`, and plain text
on `text`. If the LLM judges a question unrelated to the graph, its text reply is
forwarded in place of a query result.

## Cypher generation and validation

Each query goes through a validate-and-retry loop:

1. The LLM is prompted with the question, the reflected graph schema, the
   optional graph description, and strict rules — only `MATCH`, `OPTIONAL
   MATCH`, `WITH`, `WHERE`, `RETURN`, `ORDER BY`, `SKIP`, and `LIMIT` are
   allowed, and a `LIMIT` must terminate the query.
2. The Cypher passes the read-only safety filter.
3. It is validated with `EXPLAIN` against the live database. Syntax errors are
   fed back to the LLM, which retries up to `max_attempts` times.

The schema (node labels with property types, and relationship types with their
start/end labels) is reflected once at pipeline start and included in every
prompt so Cypher is generated against the real structure.

## Agent tools

When connected to an agent, the node exposes three functions under the node's
prefix (e.g. `neo4j.get_data`):

| Tool | What it does |
| --- | --- |
| `get_data` | Describe the graph data you want in plain English; the node generates a safe Cypher `MATCH`, executes it, and returns the rows. |
| `get_schema` | Returns the cached graph schema (labels, properties, relationships). Recovery only — not to be called preemptively. |
| `get_cypher` | Translates a question to a Cypher `MATCH` without executing it. Use only when the caller explicitly wants to see the query. |

## Authentication

- **Username and password** — set `auth_method: userpass`, then `user` and
  `password`. A blank username falls back to `neo4j`.
- **Bearer token** — set `auth_method: token` and provide `token` (passed as
  `neo4j.bearer_auth`). Use for token-based setups such as Neo4j Aura.

Connectivity and auth are verified at pipeline start with `verify_connectivity()`
plus a `RETURN 1` probe, so a wrong database name or missing permissions fail
fast rather than mid-pipeline.

## Related

- [`db_neo4j` node reference](/nodes/db_neo4j)
- [Qdrant integration](/integrations/qdrant) — vector retrieval for RAG
- [Concepts: Agents & Tools](/concepts/agents-tools-skills)
