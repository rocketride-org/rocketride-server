# graph_hydradb

A RocketRide graph database and tool node for storing text as HydraDB memories
and recalling graph-enriched context. Pick it when an agent needs native memory
storage and retrieval rather than an embedding-backed data lane or Cypher queries.

## About HydraDB

HydraDB is a managed graph and memory store. This node uses its REST API to
ingest memories, retrieve context, inspect extracted relationships, and report
database readiness. HydraDB performs the knowledge-graph extraction and native
retrieval behind those operations.

## What it does

This is a tool-only node: it has no data lanes, so an agent calls it on demand.
`store_memory` sends text for memory ingestion, while `recall_memory` performs
HydraDB-native search over memories and knowledge. Choose it over graph query
nodes such as `graph_neo4j` when you want HydraDB's managed memory operations
instead of LLM-generated Cypher; it does not require an embedding input or an
LLM connection.

## As a tool

The functions are registered under the `hydradb` service prefix: for example,
`hydradb.store_memory`. There is no configurable tool-server-name field.

| Function | Description |
| --- | --- |
| `hydradb.store_memory` | Store text as a memory and return the ingest response. |
| `hydradb.recall_memory` | Search knowledge and memories by natural-language query and return ranked, graph-enriched results. |
| `hydradb.query_graph` | Inspect extracted entities and relationship triplets; it is not a free-form graph-query interface. |
| `hydradb.get_schema` | Return collection IDs and infrastructure-readiness information for the configured database. |

`store_memory` requires a non-empty `text` string and accepts an optional
object `metadata`; it returns `{status: "ok", result}` when the ingest request
returns. `recall_memory` requires a non-empty `query`; optional `max_results`
uses the node setting when omitted and is clamped from 1 through 100. It returns
`{results, result}`, where `result` is the raw query response.

`query_graph` accepts an optional non-empty `source_id` string, which limits the
relations inspection to that ingested source; it returns `{relations, result}`.
`get_schema` takes an empty object (or no argument) and returns `{database,
collections, infra, result}`. Invalid argument shapes or missing required text
raise validation errors, and transport or non-success API responses raise a
HydraDB request error rather than looking like empty retrieval results.

## Configuration

Set the API key and database first, then normally keep the default collection
and result limit. The generated schema below is the field reference; the
settings here determine the database and collection scope used by every tool
call.

### API Key and Database

The API key is required to use the service. Enter it in **API Key**, or leave
that field blank to use `HYDRA_DB_API_KEY`; the node trims either value and
clears its in-memory copy during teardown. **Database** is also required and is
sent with every request, so choose the database that contains the memories the
agent should be allowed to access. Saving a configuration with either value
missing issues a warning rather than attempting a network probe.

### Collection

**Collection** partitions memory operations inside the chosen database and
defaults to `default`; a blank value also resolves to `default`. Change it to
isolate separate users or workspaces that share a HydraDB database. The value
is applied consistently to ingestion, recall, and relation inspection, so a
memory stored in one collection is not retrieved by this node configured for
another.

### Max results

**Max results** is the default result count for `recall_memory`, with a default
of 10 and an effective range of 1–100. Raise it when an agent needs a broader
set of possible context, accepting a larger result payload; lower it when the
agent needs only the most relevant context. A per-call `max_results` overrides
this default but is subject to the same clamp.

## Authentication

Provide a HydraDB API key in **API Key**, or make `HYDRA_DB_API_KEY` available
to the worker running the node. The client sends it as a Bearer authorization
header and does not include request headers or bodies in its request-error
messages.

## Limitations

The `noremote` capability pins this node to the local worker because it holds a
client and credentials. It calls HydraDB's REST API rather than exposing a
pipeline data lane, and it cannot run arbitrary graph queries: `query_graph`
only returns the extracted relations, optionally for one source.

## Notes

### Ingestion and retrieval behavior

Memory ingestion uses the `/context/ingest` endpoint with `type=memory`,
`infer=true`, and `upsert=true`; HydraDB is therefore asked to extract
knowledge-graph information and to replace a memory with the same content.
Recall searches both knowledge and memories with the configured collection,
using HydraDB's `hybrid` query mode, `fast` mode, and graph context. The node
does not calculate embeddings or translate requests into a query language.

### Readiness and result shapes

`get_schema` combines the database collection list with the infrastructure
status response, so it is useful for confirming that the backing layers are
ready before relying on ingestion. `recall_memory` accepts a result list from
the first available `chunks`, `results`, or `data` field in the service
response; an unfamiliar response shape therefore produces an empty `results`
list while still returning the raw response under `result`.

## Upstream docs

- [HydraDB API reference](https://docs.hydradb.com/api-reference/v2/sdks.md)
- [HydraDB query API](https://docs.hydradb.com/api-reference/v2/endpoint/query.md)
- [HydraDB context ingest API](https://docs.hydradb.com/api-reference/v2/endpoint/ingest-context.md)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `hydradb.api_key` | `string` | **API Key**<br/>HydraDB API key. Falls back to the HYDRA_DB_API_KEY environment variable if left blank. |  |
| `hydradb.collection` | `string` | **Collection**<br/>Collection scope within the database (per-user/workspace partition for memories). | `"default"` |
| `hydradb.database` | `string` | **Database**<br/>HydraDB database - the space that stores your context. Create one in the HydraDB dashboard. |  |
| `hydradb.max_results` | `integer` | **Max results**<br/>Default maximum number of results returned by recall_memory. | `10` |
| `hydradb.profile` | `string` |  | `"default"` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/graph_hydradb)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
