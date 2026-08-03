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

The node connects in one of two ways, picked with the **Connection** selector — the same choice
the FalkorDB Browser offers between *Manual Configuration* and *FalkorDB URL*:

- **Manual configuration (host and port)** — profile `default`. Fill in `host`, `port`,
  `username`, `password` and `tls` yourself.
- **FalkorDB URL (connection string)** — profile `url`. Paste the connection string from the
  FalkorDB Cloud console, e.g.
  `falkor://falkordb@r-6jissuruar.instance-ytljliglb.us-east-1.aws.cloud:53939`. Schemes
  accepted: `falkor://`, `falkors://` (TLS), `redis://`, `rediss://`, `unix://`. The password may
  be embedded (`falkor://user:password@host:port`) or left out of the URL and typed into
  `password`, which keeps the secret in the node's encrypted field instead of in the URL. When
  `password` is filled in it is the one used: any password the URL embeds is stripped before the
  connection is opened, so the two can never silently disagree.

Every other setting below is available in both profiles. Pipelines saved before the URL profile
existed keep working unchanged: they already use the `default` profile.

### Connection fields

| Field | Profile | Type | Description |
|---|---|---|---|
| `host` | manual | string | Default `localhost`. FalkorDB host, e.g. `localhost` or `your-instance.falkordb.cloud`. |
| `port` | manual | integer | Default 6379 (1–65535). FalkorDB port (Redis protocol). |
| `username` | manual | string | Default empty. Username, e.g. `default` for FalkorDB Cloud. Leave empty for no auth. |
| `tls` | manual | boolean | Default false. Connect with TLS (for FalkorDB Cloud TLS endpoints). |
| `url` | url | string | Connection string, e.g. `falkor://user@host:6379`. Required in this profile. |
| `password` | both | string | Default empty. Stored encrypted. When set it replaces any password embedded in the URL. Leave empty for no auth, or to use the one the URL carries. |

### Shared fields

| Field | Type | Description |
|---|---|---|
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

Point the node at `localhost:6379` (manual profile) or at `falkor://localhost:6379` (URL
profile) and ask the agent to `MATCH` away, or to `CREATE` with **Allow Writes** turned on.

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
| `graph_falkordb.allow_execute` | `boolean` | **Allow Execute**<br/>Enable the execute tool, which runs raw Cypher with no LLM translation and no read-only gate. Leave OFF unless a trusted application explicitly needs to issue Cypher directly. | `false` |
| `graph_falkordb.allow_writes` | `boolean` | **Allow Writes**<br/>Permit CREATE/MERGE/SET/DELETE in the query tool. When off, queries run via GRAPH.RO_QUERY and the server itself rejects write clauses. | `false` |
| `graph_falkordb.db_description` | `string` | **Graph Description**<br/>What is this graph used for? Describe its content and domain, this helps the LLM generate more accurate Cypher queries. | `""` |
| `graph_falkordb.graph` | `string` | **Default Graph**<br/>A FalkorDB server hosts many graphs. This is the one queried when the caller does not name another. | `"agent"` |
| `graph_falkordb.host` | `string` | **Host**<br/>FalkorDB host, e.g. localhost or your-instance.falkordb.cloud. | `"localhost"` |
| `graph_falkordb.max_attempts` | `integer` | **Max Validation Attempts**<br/>Maximum number of times to re-ask the LLM if EXPLAIN rejects the generated Cypher query. | `5` |
| `graph_falkordb.max_execute_rows` | `integer` | **Max Execute Rows**<br/>Upper cap on rows returned by the execute tool. The query fails if exceeded, so one statement cannot exhaust worker memory. | `25000` |
| `graph_falkordb.max_rows` | `integer` | **Max Rows**<br/>Upper cap on rows returned per query. Results beyond it are cut and flagged as truncated. | `250` |
| `graph_falkordb.password` | `string` | **Password**<br/>Password for the FalkorDB instance. Stored encrypted. When set it is the one used, replacing any password embedded in the FalkorDB URL. Leave empty for no auth, or to use the one the URL already carries. | `""` |
| `graph_falkordb.port` | `integer` | **Port**<br/>FalkorDB port (Redis protocol). FalkorDB Cloud assigns a per-instance port. | `6379` |
| `graph_falkordb.profile` | `string` | **Connection**<br/>How this node connects to FalkorDB | `"default"` |
| `graph_falkordb.query_timeout_ms` | `integer` | **Query Timeout (ms)**<br/>Server-side timeout for a single query. | `30000` |
| `graph_falkordb.tls` | `boolean` | **TLS**<br/>Connect with TLS. Required by FalkorDB Cloud TLS endpoints. | `false` |
| `graph_falkordb.url` | `string` | **FalkorDB URL**<br/>Connection string as shown in the FalkorDB Cloud console, e.g. falkor://falkordb@r-xxxx.instance-yyyy.cloud:53939. Use falkors:// for TLS. The URL may carry credentials, so it is stored encrypted; the password can also be left out of it and typed in the Password field below, which then replaces whatever the URL embeds. | `""` |
| `graph_falkordb.username` | `string` | **Username**<br/>Username, e.g. "default" for FalkorDB Cloud. Leave empty for no auth. | `""` |

## Dependencies

- `falkordb` `>=1.6,<2`
- `redis` `>=7.1,<8`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/graph_falkordb)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
