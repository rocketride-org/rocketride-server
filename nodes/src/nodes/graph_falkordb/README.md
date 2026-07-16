# graph_falkordb

A RocketRide graph database node for [FalkorDB](https://www.falkordb.com).

## What it does

Queries a FalkorDB graph in two ways, and you can use either or both:

- **Wired into a pipeline** — connect it to a `questions` lane like any other database. A
  natural-language question is translated to Cypher by the LLM, validated against the live graph
  with `EXPLAIN` (and repaired if the server rejects it), executed, and the result is emitted on
  the `text`, `table` and `answers` lanes.
- **Bound to an agent as a tool** — the agent gets `get_data` (ask in plain language),
  `query` (run Cypher it wrote itself), `get_schema`, `get_query`, `list_graphs` and `dialect`.

It derives from `ai.common.graph.GraphInstanceBase`, the base class shared by every graph
database node: the lane handling, the natural-language-to-Cypher loop and the common tools live
there, so this node only implements what is specific to FalkorDB — the Redis-protocol client,
multi-graph selection, and server-side read-only execution. (`graph_neo4j` derives from the same
base.)

Queries are **read-only by default**: they run through `GRAPH.RO_QUERY`, so the FalkorDB server
itself rejects any write clause (`CREATE`/`MERGE`/`SET`/`DELETE`) — the restriction is enforced
server-side, not by client-side parsing. Turn on **Allow Writes** to let the agent mutate the
graph.

Values always travel as Cypher parameters (`$name`), which FalkorDB treats strictly as data and
never as query text. Node, edge, and path results are serialized to plain JSON-safe objects, and
result sets are capped at **Max Rows** with a `truncated` flag so a broad query cannot flood the
agent's context.

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `host` | string | Default `localhost`. FalkorDB host, e.g. `localhost` or `your-instance.falkordb.cloud`. |
| `port` | integer | Default 6379 (1–65535). FalkorDB port (Redis protocol). |
| `username` | string | Default empty. Username, e.g. `default` for FalkorDB Cloud. Leave empty for no auth. |
| `password` | string | Default empty. Password for the FalkorDB instance. Leave empty for no auth. |
| `tls` | boolean | Default false. Connect with TLS (for FalkorDB Cloud TLS endpoints). |
| `graph` | string | Default `agent`. Graph queried when the agent does not pass one explicitly. |
| `db_description` | string | Default empty. What this graph holds, in your own words. Given to the LLM so it writes better Cypher. |
| `allow_writes` | boolean | Default false. Permit `CREATE`/`MERGE`/`SET`/`DELETE` in `query`. When off, queries run via `GRAPH.RO_QUERY` and the server rejects write clauses. |
| `allow_execute` | boolean | Default false. Enable the `execute` tool, which runs raw Cypher with no LLM translation and no read-only gate. |
| `max_attempts` | integer | Default 5 (1–10). How many times a generated query is repaired and re-validated with `EXPLAIN` before giving up. |
| `max_rows` | integer | Default 250 (1–25000). Upper cap on rows returned to the agent per query. |
| `max_execute_rows` | integer | Default 25000 (1–25000). Upper cap on rows returned by the `execute` tool. |
| `query_timeout_ms` | integer | Default 30000 (100–600000). Server-side timeout for a single query. |

---

## Available tools

| Tool | Description |
|---|---|
| `get_data` | Describe the data you want in plain language; the node writes the Cypher, runs it, and returns rows. |
| `query` | Run a Cypher query you wrote yourself against a graph. |
| `get_query` | Translate a question into Cypher **without** executing it. |
| `get_schema` | Return the graph's node labels with their properties, and the relationship types connecting them. |
| `list_graphs` | List the graph names that exist on this FalkorDB instance. |
| `execute` | Run raw Cypher with writes allowed. Disabled unless `allow_execute` is on. |
| `dialect` | Return `falkordb`, so an SDK caller can tell it is talking to a graph database. |

`get_data`, `get_query`, `get_schema`, `execute` and `dialect` come from the shared graph base
class, so every graph node exposes them identically. `query` and `list_graphs` are specific to
FalkorDB, which hosts many graphs on one server.

### query

| Parameter | Required | Description |
|---|---|---|
| `cypher` | yes | Cypher query. Reference values as `$name` placeholders, never inline data into the query string. |
| `params` | no | Object of values for the `$name` placeholders (injection-safe). |
| `graph` | no | Graph to query. Defaults to the graph configured on the node. |

Returns `columns`, `rows` (nodes/edges serialized to objects, capped at `max_rows`),
`row_count`, and `truncated`. When writes are enabled and a query mutates the graph, non-zero
write counters are returned under `stats`. On failure it returns `error` with empty
`rows`/`columns`, `row_count: 0`, and `truncated: false`.

### list_graphs

No parameters. Returns `graphs` (or `error` on failure).

### get_schema

No parameters. Returns `labels`, `nodes` (each label with its property names and types) and
`relationships` (each type with its start and end labels), reflected from the graph when the
pipeline starts. Useful when a query returns unexpected results or the agent needs to discover
the data model.

---

## Read-only by default

With `allow_writes` off (the default), `query` runs every statement through `GRAPH.RO_QUERY`.
FalkorDB rejects write clauses at the server, so the agent cannot create, merge, set, or delete
no matter what Cypher it sends. Set `allow_writes: true` to switch `query` to the read/write
`GRAPH.QUERY` path; write counters then surface under `stats`. `get_schema` always uses the
read-only path.

---

## Local quickstart

```bash
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest
```

Point the node at `localhost:6379` and ask the agent to `MATCH` away, or to `CREATE` with
**Allow Writes** turned on.

---

## Running the tests

```bash
# Unit tests (mocked FalkorDB client — no server or network needed)
pytest nodes/test/test_graph_falkordb.py -v
```

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_falkordb.allow_writes` | `boolean` | **Allow Writes**<br/>Permit CREATE/MERGE/SET/DELETE. When off, queries run via GRAPH.RO_QUERY and the server rejects write clauses. | `false` |
| `tool_falkordb.graph` | `string` | **Default Graph**<br/>Graph queried when the agent does not pass one explicitly. | `"agent"` |
| `tool_falkordb.host` | `string` | **Host**<br/>FalkorDB host, e.g. localhost or your-instance.falkordb.cloud. | `"localhost"` |
| `tool_falkordb.max_rows` | `integer` | **Max Rows**<br/>Upper cap on rows returned to the agent per query. | `250` |
| `tool_falkordb.password` | `string` | **Password**<br/>Password for the FalkorDB instance. Leave empty for no auth. | `""` |
| `tool_falkordb.port` | `integer` | **Port**<br/>FalkorDB port (Redis protocol). | `6379` |
| `tool_falkordb.query_timeout_ms` | `integer` | **Query Timeout (ms)**<br/>Server-side timeout for a single query. | `30000` |
| `tool_falkordb.tls` | `boolean` | **TLS**<br/>Connect with TLS (FalkorDB Cloud TLS endpoints). | `false` |
| `tool_falkordb.username` | `string` | **Username**<br/>Username, e.g. "default" for FalkorDB Cloud. Leave empty for no auth. | `""` |

## Dependencies

- `falkordb` `>=1.6,<2`
- `redis` `>=7.1,<8`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_falkordb)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
