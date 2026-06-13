# db_neo4j

A RocketRide database and tool node that answers natural-language questions against a Neo4J graph database by translating them to Cypher with a connected LLM.

## What it does

Connects to a Neo4J instance over the Bolt protocol using the official **neo4j Python driver** and plays two roles. As a **pipeline node**, it receives natural-language questions on the `questions` lane, asks the connected LLM to generate a Cypher query, executes it against the graph, and emits results downstream on `table`, `text`, and `answers`. As a **tool node**, it exposes `get_data`, `get_schema`, and `get_cypher` directly to an agent. Designed for knowledge graph retrieval, entity linking, and graph-based RAG workflows.

The graph schema (node labels with property types, and relationship types with their start/end labels) is reflected once at pipeline start using `db.schema.nodeTypeProperties()` and `db.schema.visualization()` (falling back to `db.labels()` and `db.relationshipTypes()` on older servers) and included in every LLM prompt so Cypher is generated against the real graph structure.

The node is **read-only by design**: every generated or supplied Cypher statement must pass a safety check that rejects write and admin clauses (`CREATE`, `MERGE`, `DELETE`, `DETACH DELETE`, `SET`, `REMOVE`, `DROP`, `FOREACH`, `LOAD CSV`, and mutating `apoc` procedures), with comments stripped before checking. Queries time out after 30 seconds. The only escape hatch is the opt-in `QuestionType.EXECUTE` path, gated by `allow_execute`, which is **off by default**.

---

## Connections

| Connection | Required | Description |
|------------|----------|-------------|
| `llm` | yes (min 1) | LLM used to generate Cypher from natural language |

---

## Configuration

### Lanes

| Lane in | Lanes out | Description |
|---------|-----------|-------------|
| `questions` | `table`, `text`, `answers` | Translate question to Cypher, execute, emit results on each connected lane |

For a normal question, results are emitted as a markdown table on `table` and `answers`, and as plain text on `text`. If the LLM judges the question unrelated to the graph, its text reply is forwarded in place of a query result.

Two special question types are handled on the `questions` lane:

- **`QuestionType.DIALECT`**: emits `{"dialect": "neo4j"}` on the `answers` lane so SDK callers can detect they are talking to a graph database rather than a relational one.
- **`QuestionType.EXECUTE`**: treats the question text as raw Cypher and runs it without LLM translation or the read-only safety check. Requires `allow_execute: true`; otherwise the request is silently rejected with a warning. Results are capped at 25,000 rows (the query fails if exceeded), and when a write returns no rows the emitted JSON reports `affected_rows` derived from the result summary counters (nodes/relationships created or deleted, properties set).

### Fields

| Field | Type | Description |
|---|---|---|
| `uri` | string | Default "neo4j://localhost:7687". Bolt URI for the Neo4J instance. Use neo4j:// or bolt:// for plaintext, neo4j+s:// or bolt+s:// for TLS (e.g. Neo4J Aura cloud) |
| `auth_method` | string | Default "userpass".  |
| `user` | string | Default "neo4j". Username to authenticate with the Neo4J instance. |
| `password` | string | Password to authenticate with the Neo4J instance. |
| `token` | string | Bearer token for token-based authentication (e.g. Neo4J Aura cloud). |
| `database` | string | Default "neo4j". Name of the Neo4J database to connect to. Use 'neo4j' for the default database. |
| `db_description` | string | Default empty. What is this graph used for? Describe its content and domain, this helps the LLM generate more accurate Cypher queries. |
| `max_attempts` | integer | Default 5. Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated Cypher query |
| `allow_execute` | boolean | Default false. Permit QuestionType.EXECUTE callers to run raw Cypher without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. |
| `profile` | string | Default "default".  |

The default profile sets `database: neo4j`. Saving the node config runs a connectivity probe (`RETURN 1` against the configured database) and surfaces driver errors (wrong password, unreachable host, bad database name) as warnings before the pipeline starts.

---

## Available tools

When connected to an agent, the node exposes three functions namespaced under the node's prefix (e.g. `neo4j.get_data`):

### Data retrieval

| Tool | Description |
|---|---|---|
| `get_data` | Accepts a natural-language description of the graph data you want, converts it to a safe Cypher MATCH query, executes it against the Neo4J graph database, and returns the result rows. No schema lookup or Cypher knowledge required, just describe what you need. Results may be large, consider using peek or store. |
| `get_schema` | Returns the Neo4J graph schema: node labels with their properties and types, and relationship types with their start and end node labels. Do NOT call this preemptively, only use when get_data fails or returns unexpected results. |
| `get_cypher` | Accepts a natural-language description and returns the equivalent Cypher MATCH statement without executing it. Only use when the user explicitly asks to see the Cypher, for actual data retrieval, use get_data instead. |

### Schema inspection

| Tool | Description |
|------|-------------|
| `get_schema` | Returns the cached graph schema: node labels with `{property, type}` lists and `{type, start, end}` relationship descriptors, plus the database name. Optional `label` argument filters to a single node label and its relationships. Intended for recovery when `get_data` fails or returns unexpected results; agents are instructed not to call it preemptively. |

### Cypher generation

| Tool | Description |
|------|-------------|
| `get_cypher` | Translates a natural-language question to a Cypher `MATCH` statement without executing it. Returns `{cypher, valid: true}` on success, an `error` key if the generated Cypher is unsafe, or an `answer` text reply when the question is not a graph query. Use only when the caller explicitly needs to see the Cypher; for data retrieval use `get_data` instead. |

---

## Cypher generation and validation

Each generated query goes through a validate-and-retry loop:

1. The LLM is prompted with the question, the reflected graph schema, the optional graph description, and strict instructions: only `MATCH`, `OPTIONAL MATCH`, `WITH`, `WHERE`, `RETURN`, `ORDER BY`, `SKIP`, and `LIMIT` are permitted, and a `LIMIT` clause must terminate the query.
2. The generated Cypher is checked by the read-only safety filter (`_is_cypher_safe`).
3. If the safety check passes, the query is validated with `EXPLAIN` against the live database. Any syntax error is fed back to the LLM together with the failing query, and the LLM retries up to `max_attempts` times (default 5, range 1-20).

As defence-in-depth, the safety filter also runs at execution time inside `_run_query`, so an unsafe statement is refused even if a caller bypasses the generation path.

Result values are serialised to plain JSON: graph nodes gain a `_labels` key, relationships a `_type` key, paths become `{nodes, relationships}`, and Neo4J temporal types are ISO-formatted.

---

## Authentication

### Username and password

Set `auth_method: userpass` (the default), then provide `user` and `password`. A blank username falls back to `neo4j`.

### Bearer token

Set `auth_method: token` and provide `token`. The node passes it as Neo4J bearer auth (`neo4j.bearer_auth`). Use this for token-based setups such as Neo4J Aura cloud.

Connectivity and authentication are verified at pipeline start with `verify_connectivity()` plus an explicit `RETURN 1` probe of the configured database, so a wrong database name or missing permissions fail fast rather than mid-pipeline.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `neo4jdb.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit QuestionType.EXECUTE callers to run raw Cypher without LLM translation or safety checks. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. | `false` |
| `neo4jdb.auth_method` | `string` | **Authentication** | `"userpass"` |
| `neo4jdb.database` | `string` | **Database name**<br/>Name of the Neo4J database to connect to. Use 'neo4j' for the default database. | `"neo4j"` |
| `neo4jdb.db_description` | `string` | **Graph description**<br/>What is this graph used for? Describe its content and domain, this helps the LLM generate more accurate Cypher queries. | `""` |
| `neo4jdb.max_attempts` | `integer` | **Max validation attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated Cypher query | `5` |
| `neo4jdb.password` | `string` | **Password**<br/>Password to authenticate with the Neo4J instance. |  |
| `neo4jdb.profile` | `string` |  | `"default"` |
| `neo4jdb.token` | `string` | **Bearer token**<br/>Bearer token for token-based authentication (e.g. Neo4J Aura cloud). |  |
| `neo4jdb.uri` | `string` | **Connection URI**<br/>Bolt URI for the Neo4J instance. Use neo4j:// or bolt:// for plaintext, neo4j+s:// or bolt+s:// for TLS (e.g. Neo4J Aura cloud) | `"neo4j://localhost:7687"` |
| `neo4jdb.user` | `string` | **User**<br/>Username to authenticate with the Neo4J instance. | `"neo4j"` |

## Dependencies

- `neo4j`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_neo4j)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
