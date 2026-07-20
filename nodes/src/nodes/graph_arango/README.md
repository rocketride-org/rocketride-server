# db_arango

A RocketRide database and tool node that answers natural-language questions against an ArangoDB multi-model database by translating them to read-only AQL with a connected LLM.

## What it does

Connects to ArangoDB over HTTP using the official **python-arango** driver and plays two roles. As a **pipeline node**, it receives natural-language questions on the `questions` lane, asks the connected LLM to generate an AQL query, executes it against the database, and emits results downstream on `table`, `text`, and `answers`. As a **tool node**, it exposes `get_data`, `get_schema`, and `get_aql` directly to an agent. Because ArangoDB is multi-model, the same node serves document retrieval, graph traversal, and ArangoSearch — designed for document and graph-based RAG workflows.

The schema is reflected once at pipeline start and included in every LLM prompt so AQL is generated against the real structure: user **collections** (classified as `document` or `edge`) with sampled fields and indexed fields, **named graphs** with their edge definitions (`from → edge → to`), and **ArangoSearch views**.

The node is **read-only by design**. Every generated query is validated with ArangoDB's `EXPLAIN`, and the resulting execution plan is inspected for data-modification nodes (`InsertNode`, `UpdateNode`, `ReplaceNode`, `RemoveNode`, `UpsertNode`) — this plan-level check is the **authoritative** read-only gate. A coarse keyword scan (`INSERT`, `UPDATE`, `REPLACE`, `REMOVE`, `UPSERT`; string literals and comments stripped) runs as a defence-in-depth backstop at execution time; because a write keyword can also be a collection or attribute name, on a match it defers to the same `EXPLAIN`-plan check before refusing, so a legitimate read is never blocked. Queries are bounded by a runtime limit, a per-query memory limit, and a maximum result-row cap. The only escape hatch is the opt-in `QuestionType.EXECUTE` path, gated by `allow_execute`, which is **off by default**.

---

## Connections

| Connection | Required | Description |
|------------|----------|-------------|
| `llm` | yes (min 1) | LLM used to generate AQL from natural language |

---

## Configuration

### Lanes

| Lane in | Lanes out | Description |
|---------|-----------|-------------|
| `questions` | `table`, `text`, `answers` | Translate question to AQL, execute, emit results on each connected lane |

For a normal question, results are emitted as a Markdown table on `table` and `answers`, and as plain text on `text`. If the LLM judges the question unrelated to the database, its text reply is forwarded in place of a query result.

Two special question types are handled on the `questions` lane:

- **`QuestionType.DIALECT`**: emits `{"dialect": "arango"}` on the `answers` lane so SDK callers can detect they are talking to ArangoDB.
- **`QuestionType.EXECUTE`**: treats the question text as raw AQL and runs it without LLM translation or the read-only safety check. Requires `allow_execute: true`; otherwise the request is silently rejected with a warning. Results are capped at `max_execute_rows` (the query fails if exceeded), and when a write returns no rows the emitted JSON reports `affected_rows` derived from the cursor statistics.

---

## Available tools

When connected to an agent, the node exposes three functions namespaced under the node's prefix (e.g. `arango.get_data`):

| Tool | Description |
|---|---|
| `get_data` | Accepts a natural-language description of the data you want, converts it to a safe read-only AQL query, executes it against the ArangoDB database, and returns the result rows. Works across documents and graphs. No schema lookup or AQL knowledge required. |
| `get_schema` | Returns the multi-model schema: collections (document and edge) with sampled fields, indexed fields, named graphs with edge definitions, and ArangoSearch views. Optional `collection` argument filters to a single collection. Intended for recovery when `get_data` fails or returns unexpected results. |
| `get_aql` | Translates a natural-language question to a read-only AQL query without executing it. Returns `{aql, valid: true}` on success, an `error` key if the generated AQL is unsafe, or an `answer` text reply when the question is not a database query. Use only when the caller explicitly needs to see the AQL. |

---

## AQL generation and validation

Each generated query goes through a validate-and-retry loop:

1. The LLM is prompted with the question, the reflected multi-model schema, the optional database description, and strict instructions: only read operations (`FOR`, `FILTER`, `SORT`, `LIMIT`, `LET`, `COLLECT`, `RETURN`, and graph traversals) are permitted, and a `LIMIT` clause must bound the query.
2. The generated AQL is validated with `EXPLAIN` against the live database. `EXPLAIN` both verifies syntax and yields the execution plan, which is inspected for data-modification nodes — this is the authoritative read-only gate, so a write query is rejected while a read that merely references a field or collection named like a write keyword is accepted. Any syntax error or modification rejection is fed back to the LLM together with the failing query, and the LLM retries up to `max_attempts` times (default 5, range 1-20).

As defence-in-depth, a coarse keyword scan (`_is_aql_safe`) also runs at execution time inside `_run_query`; because a write keyword can double as a collection or attribute name, on a match it defers to the same `EXPLAIN`-plan check before refusing — so an unsafe statement is still blocked even if a caller bypasses the generation path, while a legitimate read is not. Reads are additionally bounded by a 30-second runtime limit, a 1 GiB per-query memory limit, and the `max_execute_rows` result cap.

ArangoDB returns JSON-native documents, so result rows are emitted as-is with no special serialisation.

---

## Authentication

### Username and password

Set `auth_method: userpass` (the default), then provide `user` and `password`. A blank username falls back to `root`.

### Bearer / JWT token

Set `auth_method: token` and provide `token`. The node passes it as a python-arango user token. Use this for token-based setups such as ArangoGraph cloud.

Connectivity and authentication are verified at pipeline start (`verify=True` plus an explicit `RETURN 1` probe of the configured database), so a wrong database name or missing permissions fail fast rather than mid-pipeline. Self-host, Docker, and ArangoGraph cloud (HTTPS/TLS) endpoints are all supported via the `endpoint` field.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `arangodb.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw AQL without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue AQL directly. | `false` |
| `arangodb.auth_method` | `string` | **Authentication** | `"userpass"` |
| `arangodb.database` | `string` | **Database name**<br/>Name of the ArangoDB database to query. '_system' is the built-in default — point this at your application database. | `"_system"` |
| `arangodb.db_description` | `string` | **Database description**<br/>What is this database used for? Describe its collections, graphs and domain — this helps the LLM generate more accurate AQL queries. | `""` |
| `arangodb.endpoint` | `string` | **Connection endpoint**<br/>HTTP(S) endpoint for the ArangoDB server. Use http://host:8529 for self-host/Docker, or https://<id>.arangodb.cloud:8529 for ArangoGraph cloud (TLS). | `"http://localhost:8529"` |
| `arangodb.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated AQL query | `5` |
| `arangodb.max_execute_rows` | `integer` | **Max result rows**<br/>Maximum number of rows returned by a query. Also caps the raw EXECUTE path; a query that exceeds it fails rather than streaming unbounded results. | `25000` |
| `arangodb.password` | `string` | **Password**<br/>Password to authenticate with the ArangoDB instance. |  |
| `arangodb.profile` | `string` |  | `"default"` |
| `arangodb.token` | `string` | **Bearer token**<br/>JWT bearer token for token-based authentication (e.g. ArangoGraph cloud). |  |
| `arangodb.user` | `string` | **User**<br/>Username to authenticate with ArangoDB. Defaults to 'root'. | `"root"` |

## Dependencies

- `python-arango`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_arango)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
