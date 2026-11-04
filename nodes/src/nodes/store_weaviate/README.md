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
| `objdir` | Lists the distinct parent paths of active documents in the collection as a map of parent path to one object ID each; accepts optional `parent` (exact match), `offset`, and `limit` (default and cap 1000). `offset` and `limit` count documents, not paths: documents that share a parent path appear as one entry, so a page can hold fewer than `limit` entries while more follow. |
| `get` | Returns up to `limit` chunks (default and cap 100) of one document by `object_id`, ordered by chunk ID, with `total`, `has_more`, and `truncated`; an object ID the store does not hold, or one in the trash, returns a failure object. |
| `stats` | Returns the collection's count as this store reports it, `document_count` (null on this store, which does not list documents), the embedding model name, and the vector size. |
| `upsert` | Adds or updates a non-empty `documents` array. Each document requires content and an object ID; it can provide an embedding and embedding model or use the bound embedding provider. |
| `delete` | Deletes documents for a non-empty `object_ids` array and returns the deleted count. |
| `list_documents` | Lists the documents one by one with their path and chunk count, in pages ordered by path; pass `next_cursor` for the next page. `deleted: 'deleted'` (or `true`) lists the trash, and `parent` keeps one exact path. |
| `soft_delete` | Moves the documents of a non-empty `object_ids` array to the trash: their chunks stay stored but leave search, `objdir`, `get` and the listing until `restore`. Returns `moved_chunks`, the chunks it moved, and `matched_chunks`, the chunk rows the store holds for those IDs. |
| `restore` | Takes the documents of a non-empty `object_ids` array out of the trash; a document not in it is left as it is. |

`search` requires a bound embedding provider for semantic similarity search. The functions return a failure object when their required input or an embedding cannot be obtained; `get` answers an unknown object ID the same way.

`search` accepts an optional `filter` object honoring only `objectId`, `nodeId` and `parent`; any other key is rejected. `upsert` accepts an optional `metadata` object storing `nodeId`, `parent` and `chunkId`; `nodeId` defaults to `"vectordb_tool"`, `parent` to `"/"`, and `chunkId` to the document's position among the chunks sent for its object ID in the call (0 for the first), and an explicit `chunkId` may not repeat within the call.

## Profiles

Default: **Your own Weaviate server** (`local`).

| Profile | Default host | Default port |
| --- | --- | --- |
| Your own Weaviate server **(default)** | `localhost` | `8080` |
| Weaviate cloud server | Empty | `443` |

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

The retrieval score defaults to `0.5`, while the conversion code also drops results below a floor of `0.20` before returning them. Raise the configured threshold if weak documents crowd the context; lower it when expected material is omitted, remembering that nothing below `0.20` can be returned. Scores are higher for closer results on every metric: cosine distance is converted as `(2 - distance) / 2` (an identical vector scores `1.0`), `dot` reports the dot product, and `l2-squared`, `hamming` and `manhattan` use `1 / (1 + distance)`. Threshold values are therefore not directly comparable after a metric change. Collections searched by an earlier release scored cosine results as `(distance + 1) / 2`, which ranked the farthest results first; thresholds tuned against those scores need retuning.

### Connection timeouts

The client uses separate initialization, query, and insert timeouts of 30, 60,
and 120 seconds. They are fixed by this node's implementation, so a slow
connection cannot be tuned from this panel. If only large writes time out while
queries work, reduce the ingest workload or investigate the service path; if
all operations time out, start with the selected profile, host, ports, and API
key instead of treating it as a retrieval-score problem.

### Tool Server Name

The tool-server name defaults to `weaviate` and labels this store in tool-response messages. Pipeline agents address all eight functions listed above by node ID, for example `<node id>.search` or `<node id>.restore`; changing this label does not change those addresses.

### Write switches

Allow document management from tool calls (`allow_writes`) is off by default.
Turn it on in the pipeline whose Tools source should be able to remove
documents from the collection, or add them with the `upsert` tool, through
tool calls, for example the pipeline the Vector Explorer manages. Even when it
is on, such a write is accepted only from a Tools source of the pipeline,
addressed to this node; calls from the pipeline's chat or ingest sources are
refused. Documents the pipeline's own lanes write are not affected by this
switch.

The switch does not apply to an agent in this pipeline: its `upsert` and
`delete` calls work as they always have.

## Authentication

For a cloud profile, provide the API key; the runtime uses it for the cloud connection. For a local profile, the key is optional: an empty key connects without credentials, while a supplied key is used for local authentication.

## Notes

### Search and document lifecycle

Semantic search requires an embedding and does not accept a non-zero offset. Keyword search matches the question text against the stored content with the metadata filters. A write that holds an object's chunk 0 starts a new version of the object and deletes its existing chunks first; later writes of the same object (embedding nodes send long documents in several batches) add to it. Each chunk is stored under an id derived from its object id and chunk number, so writing the same chunk again replaces it. The file size, modification time and ingest time are stored with each chunk when the pipeline provides them. Paged reads honour their offset. The store can mark chunks deleted or active, and its default filters exclude marked-deleted chunks.

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

When an object is re-ingested from its chunk 0, the driver deletes its existing
objects before adding replacements through Weaviate's dynamic batch API. A batch
with failed objects raises an error after the batch ends. Keep the original
source available for a retry, since the replacement behavior is not an
all-or-nothing transaction across the prior objects and the new batch.

### Vector Explorer

The Vector Explorer app supports Weaviate as **experimental**: its explorer functions are tested against an in-memory stand-in for the Weaviate client, not against a live server. What the app sees on Weaviate:

- The document list pages through each document's chunk 0 by offset, in storage order (the app sorts what it has loaded), with chunk counts grouped by object id. A document whose chunk 0 is missing is not listed but is still counted in the statistics, so the list's total (documents with a chunk 0) can be lower than the statistics' document count. A document whose chunk 0 is in the trash but a later chunk is live (moved to the trash while it was still being uploaded) is listed after the others, from a read of up to 1,000 documents of the trash (the list says so when the trash holds more). Weaviate does not page past 10,000 results, so a longer list ends there with a note.
- New collections declare the file size, modification time and ingest time of each chunk (`size`, `modifyTime` and `ingestedAt`). On a collection created by an earlier release, Weaviate's auto-schema types them on the first write (the ingest time as a date, the numbers as decimals); the app still shows them as they were written.
- Chunk and document counts honour the active, deleted and all views (any other view is refused as invalid input); the collection's control record is never counted or listed, and its embedding model and dimension are reported from it.
- Samples for the embedding map are taken in object-id order, and the neighbour graph is computed on the node, not by Weaviate.
- Removing a document reports the number of chunks it removed.
- When Weaviate fails (unreachable, or a request it rejects), the explorer, the store's tools and the pipeline's writes report `Weaviate <operation> failed: <error class> (code N)`, for reads, writes, marks, renders and the collection checks alike. The client's own message, which can name the server, is not passed on. An error raised by the node's own code is reported as it is.

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
| `weaviate.serverName` | `string` | **Tool Server Name**<br/>Label for this store in tool-response messages (for example, a refused write names weaviate.delete). Pipeline agents address the available functions as node-id.function; apps use the function name and node ID. Changing this label does not change those addresses. See the node README for the available functions and their tool-exposure and write-permission settings. | `"weaviate"` |

## Dependencies

- `authlib`
- `grpcio`
- `grpcio-health-checking`
- `grpcio-tools`
- `httpx`
- `pydantic`
- `requests`
- `validators`
- `weaviate-client` `>=4.20.0`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/nihalnihalani/rocketride-server/tree/develop/nodes/src/nodes/store_weaviate)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
