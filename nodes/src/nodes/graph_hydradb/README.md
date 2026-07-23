# graph_hydradb

A `database` + `tool` node for [HydraDB](https://hydradb.com) — a managed graph + memory store. It gives agents four tools to store text into HydraDB (with automatic knowledge-graph extraction), recall graph-enriched context by natural-language query, inspect the extracted relations, and read the database's shape.

## What it does

HydraDB retrieves natively on its own servers — there is **no embedding step, no query language, and no LLM translation** in this node. Agents call the tools on demand; nothing flows through data lanes (`lanes: {}`). The node holds an API key + a target `database`/`collection` and issues HydraDB v2 REST calls.

## Tools

| Tool | Inputs | Returns |
|---|---|---|
| `store_memory` | `text` (required), `metadata` (optional) | ingest status + raw response |
| `recall_memory` | `query` (required), `max_results` (optional, ≤100) | ranked, graph-enriched `results` |
| `query_graph` | `source_id` (optional) | entities + relationship triplets |
| `get_schema` | — | `database`, `collections`, and infra readiness flags |

## Setup

1. Create an API key and a database in the HydraDB dashboard.
2. Configure the node:
   - **API Key** — paste it, or leave blank to use the `HYDRA_DB_API_KEY` environment variable.
   - **Database** — your HydraDB database id (required).
   - **Collection** — optional scope within the database (default `default`).
   - **Max results** — default cap for `recall_memory` (default `10`).

The API key is a secure field (never stored as a default) and is cleared from memory on teardown.

## Limits

- **Not a vector/RAG store:** there is no `embedding → store → retrieve` lane path — retrieval is HydraDB-native and happens via the agent tools.
- **`query_graph` is relation inspection, not a query language** — HydraDB has no Cypher/AQL equivalent; you get extracted entities and triplets, optionally scoped to one `source_id`.
- **`get_schema`** reports collections + infra readiness, not a per-field data schema.
- `recall_memory` caps `max_results` at 100.
- v2 scopes by `database` + `collection` (the older `tenant_id` / `sub_tenant_id` names are accepted as deprecated aliases).

## Examples

Agent tool calls:

```jsonc
// store
{ "tool": "store_memory", "args": { "text": "Alex prefers concise answers and dark mode." } }
// recall
{ "tool": "recall_memory", "args": { "query": "What are Alex's UI preferences?", "max_results": 5 } }
// inspect the graph for one source
{ "tool": "query_graph", "args": { "source_id": "doc_12345" } }
// discover collections + readiness
{ "tool": "get_schema", "args": {} }
```

## Upstream docs

- API reference: <https://docs.hydradb.com/api-reference/v2/sdks.md>
- Query: <https://docs.hydradb.com/api-reference/v2/endpoint/query.md>
- Ingest: <https://docs.hydradb.com/api-reference/v2/endpoint/ingest-context.md>
- Context relations: <https://docs.hydradb.com/api-reference/v2/endpoint/source-relations.md>

## Troubleshooting

- **"API key is required"** — set the API Key field or `HYDRA_DB_API_KEY`.
- **`DATABASE_NOT_FOUND`** — the `database` id is wrong or not yet created.
- **Empty `recall_memory` results** — the database may still be provisioning; call `get_schema` and check `infra.ready_for_ingestion`.
- **Requests fail with 401** — the key is invalid or lacks access to the database.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
