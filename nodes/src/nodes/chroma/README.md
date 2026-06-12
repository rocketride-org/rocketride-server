# chroma

A RocketRide vector store node backed by ChromaDB that ingests pre-embedded documents, answers questions via semantic or keyword search, and exposes search/upsert/delete as agent-callable tools.

## What it does

Stores pre-embedded document chunks in a ChromaDB collection and retrieves them against incoming questions by semantic (vector) or keyword search. The node is registered with `classType: ["store", "tool"]` and the `invoke` capability, so an agent in the same pipeline can also call it directly as a tool (for example `chroma.search`, `chroma.upsert`, `chroma.delete`).

Uses the **`chromadb-client`** package (the lightweight HTTP client only, not the full embedded database) and connects via `chromadb.HttpClient`. A ChromaDB server (self-hosted or ChromaDB Cloud) must therefore be reachable at the configured host and port.

Documents must pass through an embedding node before reaching this node; chunks without an embedding are rejected with an error. The collection is created on first write via `get_or_create_collection`, with the configured similarity metric stored as `hnsw:space`. Soft deletes are supported: documents can be marked `isDeleted` in metadata and are then excluded from search results unless the filter explicitly requests deleted records.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | (none)      | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

### Fields

| Field | Type | Description |
|---|---|---|
| `serverName` | string | Default "chroma". Namespace for agent-facing tool names, e.g. 'chroma' exposes tools as chroma.search / chroma.upsert / chroma.delete. Change this when running multiple Chroma nodes in the same pipeline so their tool names do not collide. |
| `profile` | string | Default "cloud". Connect to... |
| `provider` | string |  |

---

## Profiles

| Profile | Description                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------ |
| `local` | Your own ChromaDB server. Connects with plain `HttpClient(host, port)`, no authentication.             |
| `cloud` | ChromaDB Cloud. Requires `host` and `apikey`; authenticates using ChromaDB's `TokenAuthClientProvider`. |

---

## Agent tools

When wired to an agent, the node exposes three tools via `VectorStoreToolMixin`. Each tool is named `<serverName>.<tool>` (defaults: `chroma.search`, `chroma.upsert`, `chroma.delete`).

| Tool     | Key inputs                                                                                                                            | Description                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `search` | `query` (required); `top_k` (default 10, max 100); `filter` (optional dict, keys `objectId`/`nodeId`/`parent` are honored)           | Semantic search over stored documents; returns content, metadata, and score per result. Falls back to keyword search if semantic search fails. |
| `upsert` | `documents` array, each with `content` and `object_id`; optional `metadata`, `embedding`, and `embedding_model`                      | Add or update documents. Embeddings are computed automatically via the bound embedding provider, or pre-computed vectors can be supplied. |
| `delete` | `object_ids` (non-empty string array)                                                                                                 | Hard-delete documents by object ID. Returns `deleted_count`.                                                             |

Tool calls run on the control plane and do not flow through the pipeline's embedding lanes. Semantic search in the `search` tool and automatic embedding in `upsert` require an embedding provider bound to the node (the `all.embedding` block in its parameters). Without one, those calls return `{"success": false, "error": ...}`.

---

## Search behavior

- **Semantic search** requires the question to carry an embedding; it raises an error otherwise. Non-zero result offsets are not supported in semantic search.
- **Keyword search** uses ChromaDB's `$contains` document filter and supports offset/limit paging.
- Raw distances are normalized to scores: cosine distances map to `(distance + 1) / 2`; `l2`/`ip` distances pass through a sigmoid. Results scoring below **0.20** are always dropped before they leave the node, regardless of the `score` threshold.
- Filters on `nodeId`, `parent`, `objectId`, `tableId`, `chunkId` ranges, and permissions are translated to ChromaDB `where` clauses. Documents marked deleted are excluded with `$ne: true`, so records that never had an `isDeleted` key still match (they are treated as active).

---

## Ingestion behavior

- Chunks are upserted in batches, flushed every **500 chunks** or when the accumulated payload exceeds `payloadLimit` (32 MiB by default).
- When a chunk with `chunkId: 0` arrives, all existing chunks sharing the same `objectId` are deleted first, so re-ingesting a document replaces it rather than duplicating it.
- Each stored chunk receives a fresh UUID as its ChromaDB record id; `objectId` and `chunkId` in metadata are the stable application-level identifiers.
- Rendering a full document re-assembles chunks in `chunkId` order, fetching `renderChunkSize` chunks per round trip and tolerating gaps in the sequence.

---

## Authentication

### Local profile

No authentication is required. The node connects with `chromadb.HttpClient(host, port)`.

### Cloud profile

Set `profile` to `cloud`, provide the ChromaDB Cloud `host` and your `apikey`. The node authenticates using `chromadb.auth.token_authn.TokenAuthClientProvider` configured via ChromaDB's `Settings` object.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `chroma.profile` | `string` | **Type of chroma host**<br/>Connect to... | `"cloud"` |
| `chroma.provider` | `string` |  | const: `"chroma"` |
| `chroma.serverName` | `string` | **Tool Server Name**<br/>Namespace for agent-facing tool names, e.g. 'chroma' exposes tools as chroma.search / chroma.upsert / chroma.delete. Change this when running multiple Chroma nodes in the same pipeline so their tool names do not collide. | `"chroma"` |
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-url> |  |
| `vector.cloud.port` |  |  | `443` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` |  |  | `8330` |

## Dependencies

- `chromadb-client`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/chroma)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
