# store_atlas

A RocketRide vector store for MongoDB Atlas that stores embedded document chunks and retrieves matching content in a pipeline or through an agent tool.

## About MongoDB Atlas

MongoDB Atlas is a managed database service. This node stores documents in an Atlas collection, uses MongoDB text search for keyword queries, and creates an Atlas vector search index for embedding queries. It is the Atlas-specific option in the vector-store family, not a general connector for arbitrary MongoDB deployments.

## What it does

The node ingests embedded chunks into a MongoDB Atlas collection and searches them for incoming questions. Semantic questions use an Atlas `$vectorSearch` aggregation; keyword questions use MongoDB full-text search. It also exposes `search`, `upsert`, and `delete` when bound to an agent.

Choose it when your RocketRide store belongs in an Atlas collection and you want both retrieval paths from one node. Use a different store node for a collection hosted by a different database engine; this implementation creates Atlas-specific metadata, text, and vector indexes on first ingest.

An embedding node must run before the document lane. Ingesting a chunk without an embedding fails, while semantic questions likewise require an embedding. The first write creates the collection when needed and sizes the vector search index from that embedding's dimension.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store pre-embedded document chunks. |
| `questions` | `documents` | Emit matching documents. |
| `questions` | `answers` | Emit matching documents as answers. |
| `questions` | `questions` | Enrich the question with matching documents. |

## As a tool

The configured tool server name is the namespace for the functions below; it defaults to `atlas`.

| Function | Description |
| --- | --- |
| `search` | Search the collection for matching documents. |
| `upsert` | Add or update documents in the collection. |
| `delete` | Remove documents by object ID. |

`search` and an `upsert` without a supplied embedding use the node's bound embedding provider. Tool invocations do not flow through the pipeline's embedding lane, so bind that provider when agents should create or search vectors automatically. Choose a distinct tool server name for each Atlas node an agent can access.

## Configuration

Provide the Atlas connection URI, database, collection, similarity, and retrieval score. The node creates the collection and its indexes when it first receives documents. Keep those index choices stable for an existing collection; this implementation checks for an index name but does not rebuild a differently shaped vector index for you.

### Connection URI, database, and collection

The host must be a non-empty MongoDB SRV URI in the form `mongodb+srv://user:password@cluster.example.mongodb.net/?...`, and a non-empty API key value is required when the configuration is saved. The runtime client is constructed from the URI, including its credentials. Use this node only with an Atlas endpoint that supports the indexes it creates; a connection string for some other MongoDB deployment is not an equivalent replacement.

Database names cannot contain `/`, `\\`, spaces, quotes, `$`, `*`, `<`, `>`, `:`, `|`, or `?`, and are at most 64 characters. Collection names cannot start with `system.`, cannot contain `$`, and are at most 120 characters. Correct invalid names before saving: the validation is intended to catch a doomed deployment rather than let the first ingest fail later.

### Vector indexes and similarity

On first ingestion the node creates ordinary metadata indexes, a text index on `content`, and a vector search index named `vector_index`. That vector index takes its dimension from the incoming embeddings. Similarity defaults to `cosine`; `euclidean` and `dotproduct` are the other accepted values. Keep the selected metric and embedding dimension aligned with the vectors you will query; changing either after collection creation calls for a new compatible index or collection.

The implementation logs and continues if Atlas rejects vector-index creation, with a message that it may need to be created in Atlas. If semantic retrieval then fails while keyword retrieval works, inspect the Atlas vector index rather than changing the question text. The node also builds metadata indexes and a text index, so first ingest is doing setup work as well as writing data.

### Retrieval score and result windows

Semantic search requests ten candidates for every requested result and returns the requested limit (25 when none is supplied). It does not support a non-zero offset. Use keyword search when you need offset/limit paging; it uses text score, supports both, and defaults its limit to 25.

The configured score should be tuned for relevance, but it is not the only safeguard: returned semantic scores are normalized and anything below `0.20` is dropped. Raise the score when unrelated chunks reach a prompt; lower it when useful context is missing, but do not expect a setting below the hard floor to return weaker hits. Cosine results are normalized differently from the other supported metrics, another reason not to change the metric casually on an established collection.

### First ingest and index readiness

The first ingest both stores documents and attempts the Atlas setup: ordinary metadata indexes, a `content` text index, and the vector search index. For an established collection, make sure the configured vector-index name and metric describe the index you already operate. The node checks whether that named search index exists; it does not assume that a different existing index is usable.

Atlas may reject creation of the vector index while leaving the collection available. The implementation logs that condition and continues, which can make keyword search appear healthy while semantic search is unavailable. Treat that split result as an index-readiness issue, and create or repair the Atlas vector index before tuning retrieval settings.

### Object replacement and batch sizing

An incoming `chunkId` 0 identifies the start of an object replacement. The node deletes stored chunks for each such `objectId` before inserting the batch, then stores every new chunk with generated `_id`, embedding, text, and metadata. Send complete replacement batches together; sending only a new top-level chunk removes the older object chunks by design.

The implementation flushes an insert batch at 500 documents or when its accumulated object size exceeds the payload limit. That makes large imports incremental without changing retrieval semantics. When diagnosing a partial import, check the source batch and the first chunk's metadata rather than assuming every call is one atomic object write.

### Tool Server Name

This is the namespace for the three agent functions: `atlas.search`, `atlas.upsert`, and `atlas.delete` by default. Change it to avoid collisions between multiple Atlas tool nodes.

## Authentication

Supply the MongoDB SRV URI, including its credentials, as the host value. The save-time check also requires a non-empty API key value; the runtime client is constructed from the configured URI. The node has no separate local or unauthenticated profile.

## Notes

### Filters, lifecycle, and rendering

Both search modes apply filters for node, parent, permissions, object, table, and chunk information. Default filters also require `meta.isDeleted` to be false, so soft-deleted chunks remain stored but do not appear in ordinary searches. `markDeleted` and `markActive` toggle that flag, while `remove` permanently deletes the selected objects.

When a batch includes `chunkId` 0 for an object, the node removes all older chunks for that object before inserting the new batch. This is replacement behavior for a full re-ingest, not an append-only import. Inserts flush at 500 documents or when their accumulated Python object size passes the configured payload limit. Rendering an object rebuilds its text by chunk ID in windows, so it can handle large multi-chunk documents.

Rendering does not query an application-level full-text document. Instead, it fetches matching chunks by object and chunk range, places them into their chunk-ID positions, and joins the available content. Gaps therefore remain gaps rather than shifting later chunks into earlier positions.

### Search-mode selection

Semantic search is appropriate when matching meaning across different wording, but it requires a compatible question embedding and cannot page with a non-zero offset. Keyword search uses the collection's text index and is the better choice for literal terms or page-by-page inspection. Both modes honor the document filters, so a missing result can be caused by metadata selection or soft deletion as well as ranking.

### Agent tool behavior

The agent `search` function performs semantic retrieval and the agent `upsert` function can use a supplied vector or a bound embedding provider. `delete` permanently removes by object ID. Keep the tool server name unique when several Atlas stores are attached to one agent; otherwise the same function names would collide.

## Upstream docs

- [MongoDB Atlas documentation](https://www.mongodb.com/docs/atlas/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `atlas.provider` | `string` |  | const: `"atlas"` |
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-name>.<region>.atlas.io |  |
| `vector.database` |  |  | `"rocketride_db"` |

## Dependencies

- `pymongo`
- `dnspython`
- `pydantic`
- `urllib3`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_atlas)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
