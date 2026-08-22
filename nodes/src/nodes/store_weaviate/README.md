# store_weaviate

A RocketRide vector-store node that stores embedded document chunks in Weaviate and retrieves them by semantic or keyword search. Use it when a pipeline or agent needs a Weaviate-backed document store.

## About Weaviate

Weaviate is a vector database for storing data with embeddings and structured
properties. It supports vector search and filtered retrieval over collections.
Use it when a team has selected Weaviate for its retrieval data and wants a
RocketRide pipeline or agent to use the same collection.

## What it does

The node accepts embedded documents on its `documents` lane and can retrieve matching documents for incoming questions. It also exposes the store to an agent as tools. A collection is created when documents are first added, and incoming chunks without embeddings are rejected. Pick it over the sibling vector stores when Weaviate is the database the workload already operates, including when the node should use Weaviate's local REST and gRPC connection or its cloud connection.

The driver creates the collection without a vectorizer and gives it an HNSW vector index. It stores document content and metadata as collection properties, allowing semantic or keyword retrieval with the same metadata filters.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store embedded document chunks. |
| `questions` | `documents` | Return matching documents. |
| `questions` | `answers` | Return matching documents as answers. |
| `questions` | `questions` | Enrich questions with matching documents. |

## As a tool

The configured tool-server name defaults to `weaviate`.

| Function | Description |
| --- | --- |
| `search` | Searches the store for a non-empty `query`; accepts optional `top_k` and metadata `filter`, and returns matching content, metadata, and scores. |
| `upsert` | Adds or updates a non-empty `documents` array. Each document requires content and an object ID; it can provide an embedding and embedding model or use the bound embedding provider. |
| `delete` | Deletes documents for a non-empty `object_ids` array and returns the deleted count. |

`search` requires a bound embedding provider for semantic similarity search. The three functions return a failure object when their required input or an embedding cannot be obtained.

## Profiles

| Profile | Default host | Default port |
| --- | --- | --- |
| Weaviate cloud server *(default)* | Empty | `443` |
| Your own Weaviate server | `localhost` | `8080` |

## Configuration

Choose the cloud or local profile, then configure the host and collection. The cloud profile connects to the configured cluster URL; the local profile also uses the configured gRPC port, which defaults to `50051`. The profile changes the connection method, so decide which service you are connecting to before adjusting search settings.

### Host, ports, and API key

The runtime trims whitespace, strips a leading `http://` or `https://`, and
removes trailing slashes from the entered host. Cloud mode calls the cloud
connection with the API key. Local mode passes the configured REST and gRPC
ports, and uses the API key only when one is supplied. Use the local profile for
a service that exposes both local endpoints; a startup or validation failure can
mean the selected profile does not match the service, or that the local gRPC
port is unavailable.

### Collection

The collection is the destination for stored chunks and is created with no vectorizer and an HNSW vector index when first needed. The save-time probe requires a name that begins with an uppercase letter and then contains only letters, digits, or underscores. Change it to isolate a corpus or embedding space; it directs the node to a different collection rather than creating a logical partition. A name that begins lowercase or contains punctuation stops configuration before the pipeline starts.

### Similarity and retrieval score

The runtime accepts `cosine`, `dot`, `l2-squared`, `hamming`, or `manhattan` as the similarity setting, defaulting to `cosine`; another value stops initialization. It passes the selected value to the HNSW index when it creates a collection, so make the choice match the embedding space before the first ingest. Changing the setting does not recreate an existing collection's index.

The retrieval score defaults to `0.5`, while the conversion code also drops results below a hard `0.20` before returning them. Raise the configured threshold if weak documents crowd the context; lower it when expected material is omitted, remembering that nothing below `0.20` can be returned. Cosine scores are converted as `(distance + 1) / 2`; the other supported metrics use a sigmoid conversion, so threshold values are not directly comparable after a metric change.

### Connection timeouts

The client uses separate initialization, query, and insert timeouts of 30, 60,
and 120 seconds. They are fixed by this node's implementation, so a slow
connection cannot be tuned from this panel. If only large writes time out while
queries work, reduce the ingest workload or investigate the service path; if
all operations time out, start with the selected profile, host, ports, and API
key instead of treating it as a retrieval-score problem.

### Tool Server Name

The tool-server name defaults to `weaviate` and prefixes the three agent functions. Change it when multiple Weaviate stores are connected to the same agent so their functions do not share a namespace.

## Authentication

For a cloud profile, provide the API key; the runtime uses it for the cloud connection. For a local profile, the key is optional: an empty key connects without credentials, while a supplied key is used for local authentication.

## Notes

### Search and document lifecycle

Semantic search requires an embedding and does not accept a non-zero offset. Keyword search matches content with the metadata filters. Re-ingesting an object deletes its existing chunks before replacement chunks are added. The store can mark chunks deleted or active, and its default filters exclude marked-deleted chunks.

Before semantic search, the driver checks that the collection is compatible with
the query's embedding model. The collection's batch import reports an error if
any objects failed to import, instead of silently treating a partial write as a
successful ingest.

Filters cover node, parent, permissions, object IDs, chunks, table fields, and
the deletion flag. Normal queries add `isDeleted = false`, so marked-deleted
content is hidden unless a caller requests it. This lets a shared collection be
scoped at query time without using collection names as routine access filters.

### Rendering

Rendering retrieves an object's chunks in `chunkId` order and sends joined text to the callback in `renderChunkSize` groups. The node's document count is a count of stored vectors (chunks).

When an object is re-ingested, the driver deletes its existing objects before
adding replacements through Weaviate's dynamic batch API. A batch with failed
objects raises an error after the batch ends. Keep the original source
available for a retry, since the replacement behavior is not an all-or-nothing
transaction across the prior objects and the new batch.

## Upstream docs

- [Weaviate documentation](https://docs.weaviate.io/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-name>.weaviate.cloud |  |
| `vector.cloud.port` |  |  | `443` |
| `vector.local.grpc_port` |  |  | `50051` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` |  |  | `8080` |
| `weaviate.profile` | `string` | **Type of Weaviate host**<br/>Connect to... | `"local"` |
| `weaviate.provider` | `string` |  | const: `"weaviate"` |

## Dependencies

- `authlib`
- `grpcio`
- `grpcio-health-checking`
- `grpcio-tools`
- `httpx`
- `pydantic`
- `requests`
- `validators`
- `weaviate-client`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_weaviate)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
