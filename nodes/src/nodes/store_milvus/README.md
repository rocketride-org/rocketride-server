# store_milvus

A RocketRide vector-store node that stores embedded document chunks in Milvus and retrieves them by semantic or keyword search. Use it when a pipeline or agent needs a Milvus-backed document store.

## About Milvus

Milvus is a vector database for storing embeddings and finding similar vectors.
It is designed for vector-search workloads and supports structured fields alongside
vector data. Use it when your team has chosen Milvus as the place to operate its
retrieval data, whether the service is self-managed or hosted.

## What it does

The node accepts embedded documents on its `documents` lane and can retrieve matching documents for incoming questions. It also exposes the same store to an agent as tools. The collection is created when documents are first added, and incoming chunks without embeddings are rejected. Pick it over the other vector-store nodes when Milvus is the database already available to the workload, or when its collection and index model is the model your operators need to manage.

At creation, the driver makes an `id` scalar index and an `IVF_FLAT` vector index with `nlist` 1024. It stores the document content and metadata with the vector, so metadata filters and keyword retrieval can operate over the same collection.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store embedded document chunks. |
| `questions` | `documents` | Return matching documents. |
| `questions` | `answers` | Return matching documents as answers. |
| `questions` | `questions` | Enrich questions with matching documents. |

## As a tool

The configured tool-server name defaults to `milvus`.

| Function | Description |
| --- | --- |
| `search` | Searches the store for a non-empty `query`; accepts optional `top_k` and metadata `filter`, and returns matching content, metadata, and scores. |
| `upsert` | Adds or updates a non-empty `documents` array. Each document requires content and an object ID; it can provide an embedding and embedding model or use the bound embedding provider. |
| `delete` | Deletes documents for a non-empty `object_ids` array and returns the deleted count. |

`search` requires a bound embedding provider for semantic similarity search. The three functions return a failure object when their required input or an embedding cannot be obtained.

## Profiles

Default: **Milvus cloud server** (`cloud`).

| Profile | Default host | Default port |
| --- | --- | --- |
| Milvus cloud server **(default)** | Empty | `443` |
| Your own Milvus server | `localhost` | `19530` |

## Configuration

Choose the cloud or local profile first, then configure the host, port, and collection. The profile controls how the runtime forms the connection: cloud mode uses HTTPS and the token, while local mode uses HTTP with the configured host and port. Most installations only need to name the destination collection and replace the cloud endpoint or the local defaults.

### Host, port, and API key

The driver trims whitespace, removes a leading `http://` or `https://`, and removes
trailing slashes from the host you enter. For cloud mode it always constructs an
HTTPS URI and supplies the trimmed API key as the Milvus token; for local mode it
constructs an HTTP URI from host and port without a token. Use the cloud profile
only for an endpoint that accepts that HTTPS/token connection. A connection error
at startup usually means that the selected profile does not match the endpoint,
or that the host was entered with an incompatible port.

### Collection

The collection is the destination for stored chunks. The save-time probe accepts names from 1 to 255 characters that begin with a letter or underscore and then use only letters, digits, or underscores. A collection is created when the first documents are added, using their vector size. Change it to isolate a corpus or embedding space; changing it points this node at a different store, rather than partitioning data within the old one. A save warning about the name means the collection will not start successfully until it follows the identifier rule.

### Similarity and retrieval score

The runtime accepts `L2`, `IP`, `COSINE`, `JACCARD`, `HAMMING`, or `BM25` as the similarity setting, defaulting to `COSINE`; another value stops initialization. It builds the vector index using this metric, so select the metric that matches the embeddings already in the collection before writing its first data. Changing it later does not rebuild an existing index.

The retrieval score defaults to `0.5` and filters converted result scores. For cosine results the driver converts the returned distance to `(distance + 1) / 2`; for other metrics it applies a sigmoid conversion. Raise the score when retrieved context is noisy or unrelated; lower it when the expected source material is absent. The tradeoff is recall versus the amount of weak context passed downstream, and a threshold can only be meaningful with the same metric used to create the collection.

### Write batch size and timeout

The driver uses a 60-second connection timeout and writes chunks in batches of
50 by default. These settings are read from the node configuration even though
most deployments can leave them alone. Increase a batch size only when a larger
write has been demonstrated to be reliable for the endpoint; reduce it when
bulk writes fail partway through or the service cannot absorb the requested
load. Increase the timeout for a slow but healthy remote service, rather than
using it to mask a host, port, or authentication mismatch.

### Tool Server Name

The tool-server name defaults to `milvus` and prefixes the three agent functions. Change it when multiple Milvus stores are connected to the same agent so their functions do not share a namespace.

## Authentication

For a cloud profile, provide the API key; the runtime passes it as the Milvus token. The local profile connects with the configured host and port without a token.

## Notes

### Search and document lifecycle

Semantic search requires an embedding and does not accept a non-zero offset. Keyword search uses the same metadata filters as retrieval. Re-ingesting an object deletes its existing chunks before the replacement chunks are inserted. The store can mark chunks deleted or active, and its default filters exclude marked-deleted chunks.

Milvus inserts chunks in batches of 50. A semantic search against an existing
collection also checks the embedding model before querying, so a model or vector
dimension mismatch is surfaced instead of silently mixing incompatible vectors.

The store maps metadata such as node, parent, object, permission, table, and
deletion state into Milvus filter expressions. Searches exclude soft-deleted
chunks unless a caller explicitly requests deleted content. This is useful when
one collection holds multiple sources: use the normal metadata filters to scope
retrieval instead of creating a collection per source unless you need hard data
separation.

### Rendering

Rendering retrieves an object's chunks in `chunkId` order and sends joined text to the callback in `renderChunkSize` groups. The node's document count is a count of stored vectors (chunks).

## Upstream docs

- [Milvus documentation](https://milvus.io/docs)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `milvus.profile` | `string` | **Type of Milvus host**<br/>Connect to... | `"cloud"` |
| `milvus.provider` | `string` |  | const: `"milvus"` |
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-name>.<region>.zillizcloud.com |  |
| `vector.cloud.port` |  |  | `443` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` |  |  | `19530` |

## Dependencies

- `environs`
- `marshmallow`
- `grpcio`
- `milvus-lite` `; platform_system != "Windows"`
- `pandas`
- `protobuf`
- `ujson`
- `pymilvus`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_milvus)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
