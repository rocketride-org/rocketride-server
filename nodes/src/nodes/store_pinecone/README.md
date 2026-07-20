# pinecone

A RocketRide vector store node that stores and retrieves embedded documents in a Pinecone index, with agent-callable search, upsert, and delete tools.

## What it does

Stores pre-embedded document chunks in a Pinecone index and retrieves them by semantic (vector) similarity or keyword search. Documents must pass through an embedding node before reaching this node - chunks without an embedding are rejected at write time.

Uses the **Pinecone gRPC SDK** (`PineconeGRPC`) for all data-plane operations and the HTTP client during configuration validation. What RocketRide calls a *collection* maps to a Pinecone **index** (Pinecone's own "collections" feature is not used).

The index is created automatically on first write if it does not yet exist, with the vector dimension taken from the incoming embeddings. Re-ingesting documents whose `objectId` already exists removes the old chunks before writing the new ones, making writes effectively upserts. Vectors are upserted in batches of 50 (well below Pinecone's 100-vector bulk limit) with a 32 MiB payload cap per batch.

The node carries `classType: ["store", "tool"]` and the `invoke` capability. In addition to its data lanes it exposes vector-DB tools to agent nodes in the same pipeline.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | (none)      | Ingest pre-embedded documents into the index                     |
| `questions` | `documents` | Run a search and return matching documents                       |
| `questions` | `answers`   | Run a search and return matching documents as an answer          |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Semantic search requires the incoming question to carry an embedding (bind an embedding node upstream) and returns up to the filter's `limit` (default 25) top matches scored above the configured threshold. Non-zero offsets are not supported for semantic search and raise an error. Keyword search adds a `$contains` metadata filter on document content.

### Fields

| Field | Type | Description |
|---|---|---|
| `collection` | string | Default "rocketride". Enter the name of the collection. Accepted are: Lower case, alphanumeric characters, hyphens |
| `serverName` | string | Default "pinecone". Namespace for agent-facing tool names, e.g. 'pinecone' exposes tools as pinecone.search / pinecone.upsert / pinecone.delete. Change this when running multiple Pinecone nodes in the same pipeline so their tool names do not collide. |
| `profile` | string | Default "pod-based". Connect to... |
| `provider` | string | Default "pinecone".  |

### Collection naming rules

Configuration validation checks all of the following and reports violations together:

- lowercase letters, numbers, and hyphens only
- no leading or trailing hyphen
- no consecutive hyphens (`--`)
- maximum 45 characters

Validation also authenticates with the API key, and if the index already exists it checks that its deployment type matches the selected profile: a serverless index cannot be used with the pod-based profile and vice versa.

---

## Profiles

| Profile                                     | Default | Description                                                                        |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `serverless-dense`                          | yes     | Serverless deployment. New indexes are created in AWS `us-east-1`.                |
| `pod-based`                                 | no      | Pod-based deployment. New indexes are created in `us-east1-gcp` with 1 x `p1.x1` pod. |

The default profile is `serverless-dense`.

---

## Agent tools

When an agent node is wired to this node, the following tools become callable, namespaced by the configured `serverName` (default `pinecone`):

### Search

| Tool              | Description                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinecone.search` | Semantic similarity search. Takes `query` text, optional `top_k` (default 10), and an optional metadata `filter` object. Returns matching documents with content, metadata, and score. |

### Write

| Tool              | Description                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinecone.upsert` | Add or update documents. Each document requires `content` and an `object_id` (used for deduplication). Accepts optional `metadata`, or a pre-computed `embedding` plus `embedding_model` pair to skip automatic embedding computation. |

### Delete

| Tool              | Description                                    |
| ----------------- | ---------------------------------------------- |
| `pinecone.delete` | Delete documents by a list of `object_ids`.    |

The tool path runs on the control plane and does not pass through the pipeline's embedding lanes. The node wires its own query embedder from the pipeline's embedding configuration. `pinecone.search` requires that embedder; if none is configured, the call returns `{"success": false, "error": ...}`. `pinecone.upsert` computes embeddings the same way, or accepts pre-computed vectors per document to skip auto-computation.

---

## Behavior notes

- **Soft delete:** documents can be marked deleted (`isDeleted: true`) rather than physically removed. They are excluded from all search results unless the filter explicitly requests deleted documents. Documents that reappear are automatically marked active again.
- **Metadata updates:** applied per record in batches of 1000, querying only records whose metadata still differs from the target state so the loop converges safely and does not re-process already-updated records.
- **Rendering:** rehydrates a complete document from its chunks in `chunkId` order, streaming the joined text to the output callback in ranges of 32 MiB.
- **Pagination:** Pinecone has no native query offset. Path listing emulates pagination by over-fetching (`offset + limit`) records and slicing client-side.

---

## Authentication

Set `apikey` to your Pinecone API key. The key is used during both config validation (HTTP client) and runtime data operations (gRPC client). There are no additional auth modes - Pinecone uses API-key-only authentication.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `pinecone.collection` | `string` | **Collection**<br/>Enter the name of the collection. Accepted are: Lower case, alphanumeric characters, hyphens | `"rocketride"` |
| `pinecone.profile` | `string` | **Type of Pinecone Connection**<br/>Connect to... | `"pod-based"` |
| `pinecone.provider` | `string` |  | const: `"pinecone"` |
| `pinecone.serverName` | `string` | **Tool Server Name**<br/>Namespace for agent-facing tool names, e.g. 'pinecone' exposes tools as pinecone.search / pinecone.upsert / pinecone.delete. Change this when running multiple Pinecone nodes in the same pipeline so their tool names do not collide. | `"pinecone"` |

## Dependencies

- `pinecone`
- `pinecone-plugin-assistant`
- `pinecone-plugin-interface`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/pinecone)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
