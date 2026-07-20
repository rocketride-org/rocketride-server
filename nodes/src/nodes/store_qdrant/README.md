# qdrant

A RocketRide vector store node backed by Qdrant, for storing embedded documents and retrieving them by semantic or keyword search.

## What it does

Stores pre-embedded document chunks in a Qdrant collection and retrieves them by semantic (vector) similarity or full-text keyword search. Works with both self-hosted Qdrant and Qdrant Cloud. The node is also a tool node (`classType: ["store", "tool"]` with the `invoke` capability), so agents in the same pipeline can call its `search`, `upsert`, and `delete` tools directly.

Uses the official **`qdrant_client`** Python SDK over REST (`prefer_grpc=False`, 60-second timeout). If the configured host has no scheme, `http://` is prepended automatically.

Documents must be run through an embedding node before reaching this node: the store does not compute embeddings on the data lane and raises an error if a chunk arrives without one.

The collection is created automatically on first write, including payload indexes on `meta.nodeId`, `meta.objectId`, `meta.parent`, `meta.permissionId`, `meta.isDeleted`, `meta.isTable`, and a full-text index on `content` (word tokenizer, lowercase, token length 2-15). Writing chunk 0 of an object first deletes all existing points with the same `objectId`, so re-ingesting a document replaces it rather than duplicating it. Upserts are batched: a flush happens every 500 points or when the accumulated payload exceeds the payload limit (32 MiB by default).

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
| `serverName` | string | Default "qdrant". Namespace for agent-facing tool names, e.g. 'qdrant' exposes tools as qdrant.search / qdrant.upsert / qdrant.delete. Change this when running multiple Qdrant nodes in the same pipeline so their tool names do not collide. |
| `profile` | string | Default "cloud". Connect to... |
| `provider` | string | Default "qdrant".  |

### Profiles

| Profile                         | Default host                   | Default port |
| ------------------------------- | ------------------------------ | ------------ |
| Qdrant cloud server _(default)_ | _(your Qdrant Cloud endpoint)_ | `6333`       |
| Your own Qdrant server          | `localhost`                    | `6333`       |

### Save-time validation

When the configuration is saved, the node validates it with a fast read-only probe (`get_collections`, 10-second timeout):

- The collection name must match `^[A-Za-z0-9._-]{1,255}$`: no `/` or spaces.
- Port `0` is rejected explicitly.
- Scheme is inferred when the host has none: `http` for `localhost` or `127.*`, `https` for `*.qdrant.io` hosts or port `443`.
- Qdrant Cloud with a wrong port does not return an HTTP status: the probe simply times out after 10 seconds and surfaces a timeout warning.

---

## Agent tools

Tools are exposed under the configured `serverName` namespace (default `qdrant`).

### `search`

Semantic similarity search over the collection.

| Argument | Type    | Description                                                               |
| -------- | ------- | ------------------------------------------------------------------------- |
| `query`  | string  | Required. The search query text.                                          |
| `top_k`  | integer | Maximum results to return (default 10, capped at 100).                    |
| `filter` | object  | Optional metadata filter; supports `objectId`, `nodeId`, and `parent` keys. |

Requires an embedding provider bound to the node (the embedding sub-block in the configuration). If semantic search fails, the tool falls back to keyword search. Returns `{"results": [{content, score, metadata}], "total": n}` on success or `{"success": false, "error": "..."}` on failure.

### `upsert`

Add or update documents in the collection.

Each item in the `documents` array requires `content` and `object_id` (used for deduplication) and may include `metadata`, plus optional pre-computed `embedding` and `embedding_model` to skip automatic embedding. Without a pre-computed vector the node's bound embedding provider is used; if none is configured the call fails. Returns `{"success": true, "count": n, "skipped": n}`.

### `delete`

Delete documents by ID.

Takes a required `object_ids` string array and removes all points whose `meta.objectId` matches. Returns `{"success": true, "deleted_count": n}`.

---

## Scoring and relevance

Raw Qdrant scores are rescaled to `[0, 1]` before filtering. For `Cosine` similarity the rescaling is `(score + 1) / 2`; for other metrics a sigmoid is applied. Results below a hard floor of `0.20` are always dropped as noise, and the configured retrieval `score` threshold is applied on top of that in the rescaled space (applied by the base store, not passed to Qdrant as `score_threshold`).

The similarity metric defaults to `Cosine`; `Euclid`, `Dot`, and `Manhattan` are also accepted. Any other value raises a configuration error at startup. Semantic search uses exact search (`SearchParams(exact=True)`) and does not support a non-zero result offset; keyword search and plain filtered gets use Qdrant scroll and do support offsets.

Deletion of source files is handled as a soft delete: chunks are marked `meta.isDeleted: true` and excluded from all searches by default. They are only returned when the filter explicitly asks for deleted documents. A document that reappears is marked active again.

---

## Authentication

Self-hosted Qdrant typically needs no credentials: leave `apikey` empty. For Qdrant Cloud, set `host` to your instance endpoint (`<instance>.<region>.qdrant.io`) and provide the cluster API key in `apikey`. The key is passed as the `api_key` argument of the Qdrant client.

---

## Notes

- Qdrant's full-text tokenizer does not support all languages out of the box. Chinese, Japanese, and Korean are not enabled in the default Qdrant build and require building Qdrant from source with the `--features multiling-chinese,multiling-japanese,multiling-korean` flags. This only affects keyword search over the `content` payload; semantic search uses the embeddings you provide and is unaffected.
- Rendering a full document rehydrates all of its chunks in `chunkId` order, fetching them in batches of up to 32 MiB and joining them, so out-of-order storage is handled transparently.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `qdrant.profile` | `string` | **Type of Qdrant host**<br/>Connect to... | `"cloud"` |
| `qdrant.provider` | `string` |  | const: `"qdrant"` |
| `qdrant.serverName` | `string` | **Tool Server Name**<br/>Namespace for agent-facing tool names, e.g. 'qdrant' exposes tools as qdrant.search / qdrant.upsert / qdrant.delete. Change this when running multiple Qdrant nodes in the same pipeline so their tool names do not collide. | `"qdrant"` |
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-name>.<region>.qdrant.io |  |
| `vector.cloud.port` |  |  | `6333` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` |  |  | `6333` |

## Dependencies

- `grpcio`
- `grpcio-tools`
- `portalocker`
- `pydantic`
- `urllib3`
- `httpx`
- `qdrant_client`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/qdrant)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
