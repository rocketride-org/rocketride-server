# store_pinecone

A RocketRide vector-store node that stores embedded document chunks in a Pinecone index and retrieves them by semantic or keyword search. Use it when a pipeline or agent needs a Pinecone-backed document store.

## About Pinecone

Pinecone is a managed vector database for applications that search embedding
data. It organizes vectors into indexes and supports vector queries with
metadata filters. Use it when Pinecone is the service your application uses for
retrieval and you want RocketRide to store and query the same index.

## What it does

The node accepts embedded documents on its `documents` lane and can retrieve matching documents for incoming questions. It also exposes the store to an agent as tools. It creates a Pinecone index when documents are first added, and rejects incoming chunks without embeddings. Pick it over a self-managed store when the retrieval corpus belongs in a Pinecone index and its selected deployment mode is already part of the intended Pinecone setup.

The driver treats its Collection setting as the Pinecone index name. When it has to create that index, the supplied embeddings determine its dimension and the selected similarity setting determines its metric.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store embedded document chunks. |
| `questions` | `documents` | Return matching documents. |
| `questions` | `answers` | Return matching documents as answers. |
| `questions` | `questions` | Enrich questions with matching documents. |

## As a tool

The configured tool-server name defaults to `pinecone`.

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

Default: **Pinecone Serverless Dense Index** (`serverless-dense`).

| Profile | Deployment mode | Context |
| --- | --- | --- |
| Pinecone Pod-Based Index | `pod-based` | Creates a pod-based index. |
| Pinecone Serverless Dense Index **(default)** | `serverless-dense` | Creates a serverless index. |

## Configuration

Choose the profile that matches the target index, then provide the API key and collection name. New indexes use the selected profile; an existing index is checked against it during the save-time probe. The profile selection matters at creation time, while the key and collection select which existing Pinecone resource this node connects to.

### Index profile

`Pinecone Serverless Dense Index` is the default profile and creates an index
with the driver's serverless specification; `Pinecone Pod-Based Index` uses its
pod-based specification. Select the one that matches an index you already have,
or the kind of index you intend the node to create. The save-time probe compares
an existing index's specification with the selected profile and warns if they do
not agree; change the profile rather than assuming the node can change the
existing index's deployment type.

### Collection

The collection is the Pinecone index name and defaults to `rocketride`. Validation requires lowercase letters, numbers, and hyphens only; it rejects leading or trailing hyphens, consecutive hyphens, and names over 45 characters. Choose a name that identifies the one index this node will use. Change it to direct the node to a different Pinecone index, not to split a corpus inside one index. A validation warning flags a name that cannot be used by the configured service.

### Similarity and retrieval score

The runtime accepts `cosine`, `euclidean`, or `dotproduct` as the similarity setting, defaulting to `cosine`; another value stops initialization. This value becomes the metric when the driver creates an index, so make it agree with the embedding data and leave an existing index's metric alone. Choosing the wrong metric changes ranking and can make good matches appear weak.

The retrieval score (`score`, default `0.5`) filters results on the `questions` lane. The driver itself only drops matches below a floor of `0.0`, so the agent `search` function returns the weaker matches that the `questions` lane filters out. Scores are Pinecone's raw values: cosine similarity between `-1` and `1`, the dot product, or the squared euclidean distance. With `euclidean` a lower score is closer, so a retrieval score keeps the distant results rather than the near ones; prefer `cosine` or `dotproduct` when you rely on the threshold.

### API key

The API key is trimmed before the Pinecone client is created. It is needed both
to open the store and for the save-time probe that lists indexes. Rotate or
replace it when authentication fails rather than changing the collection name;
the probe can also reveal a key that reaches Pinecone but cannot inspect the
chosen index. Keep one key per intended service boundary when the node should
not see every index available to a broader application credential.

### Tool Server Name

The tool-server name defaults to `pinecone` and labels this store in tool-response messages. Pipeline agents address all eight functions listed above by node ID, for example `<node id>.search` or `<node id>.restore`; changing this label does not change those addresses.

### Write switches

Allow document management from tool calls (`allow_writes`) is off by default.
Turn it on in the pipeline whose Tools source should be able to remove
documents from the index, or add them with the `upsert` tool, through tool
calls, for example the pipeline the Vector Explorer manages. Even when it is
on, such a write is accepted only from a Tools source of the pipeline,
addressed to this node; calls from the pipeline's chat or ingest sources are
refused. Documents the pipeline's own lanes write are not affected by this
switch.

The switch does not apply to an agent in this pipeline: its `upsert` and
`delete` calls work as they always have.

## Authentication

Set the API key for the selected Pinecone profile. The runtime creates its client with that key, and the save-time probe uses it to list indexes and check an existing index's deployment mode.

## Notes

### Search and document lifecycle

Semantic search requires an embedding and does not accept a non-zero offset. Keyword search is not supported: Pinecone dense indexes have no text matching, and a keyword request fails with a message saying so. A write that holds an object's chunk 0 starts a new version of the object and deletes its existing chunks first; later writes of the same object (embedding nodes send long documents in several batches) add to it. Each chunk is stored under an id derived from its object id and chunk number, so writing the same chunk again replaces it. Unset metadata fields are left out, because Pinecone rejects null metadata values; the file size, modification time and ingest time are stored when the pipeline provides them. The store can mark chunks deleted or active, and its default filters exclude marked-deleted chunks.

The node retrieves semantic results with the requested limit (or 25 when no
limit is supplied), at most 1,000, the most Pinecone returns with metadata.
Reads by filter honour their offset and limit: up to 1,000 rows come from one
query, and longer reads page through Pinecone's metadata fetch on serverless
indexes (a pod-based index stops at 1,000). It runs the collection-existence and embedding-model checks
before searching, which makes a missing index or incompatible model fail before
results are returned.

Index creation is intentionally opinionated: the serverless branch supplies an
AWS `us-east-1` specification, while the pod branch supplies one `p1.x1` pod in
`us-east1-gcp`. Those are creation-time defaults in this node, not settings
that alter an existing index. Choose an already compatible index when those
defaults are not appropriate for the intended deployment.

### Rendering and paths

Rendering retrieves an object's chunks in `chunkId` order and sends joined text to the callback in groups of at most 1,000 chunks. Path listing returns live documents only (never the collection's control record or deleted documents), applying the requested offset and limit.

Metadata filters include document identity, parent path, permissions, table
information, and deletion state. The driver defaults `isDeleted` to false in
its Pinecone filter, so a soft-deleted source does not appear in normal
retrieval. That makes reactivating or explicitly including deleted material a
separate caller choice rather than an accidental result of broad searching. A
caller that includes deleted material receives deleted and live chunks alike,
as on the other stores.

### Vector Explorer

The Vector Explorer app supports Pinecone as **experimental**: its explorer functions are tested against an in-memory stand-in for the Pinecone client, not against Pinecone. What the app sees on Pinecone:

- Pinecone cannot count with a filter, so the statistics show no document or chunk counts, the document list shows no chunk counts, and removing a document does not report how many chunks it removed.
- The document list pages through each document's chunk 0 with Pinecone's metadata fetch, in storage order (the app sorts what it has loaded). A pod-based index has no metadata fetch: it lists the first 1,000 documents only. A document whose chunk 0 is in the trash but a later chunk is live (moved to the trash while it was still being uploaded) is listed after the others, from a read of up to 1,000 documents of the trash (the list says so when the trash holds more). Lists, chunk pages and samples take the active, deleted and all views; any other view is refused as invalid input.
- Samples for the embedding map are taken in storage order on serverless indexes; a pod-based index cannot provide them. The neighbour graph is computed on the node.
- Keyword search is reported as unsupported, and the scores shown are Pinecone's raw values.
- When Pinecone fails (unreachable, or a request it rejects), the explorer, the store's tools and the pipeline's writes report `Pinecone <operation> failed: <error class> (code N)`, for reads, writes, marks, renders and the collection checks alike. The client's own message, which can name the server, is not passed on. An error raised by the node's own code is reported as it is.

## Upstream docs

- [Pinecone documentation](https://docs.pinecone.io/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `pinecone.collection` | `string` | **Collection**<br/>Enter the name of the collection. Accepted are: Lower case, alphanumeric characters, hyphens | `"rocketride"` |
| `pinecone.profile` | `string` | **Type of Pinecone Connection**<br/>Connect to... | `"pod-based"` |
| `pinecone.provider` | `string` |  | const: `"pinecone"` |
| `pinecone.serverName` | `string` | **Tool Server Name**<br/>Label for this store in tool-response messages (for example, a refused write names pinecone.delete). Pipeline agents address the available functions as node-id.function; apps use the function name and node ID. Changing this label does not change those addresses. See the node README for the available functions and their tool-exposure and write-permission settings. | `"pinecone"` |

## Dependencies

- `pinecone`
- `pinecone-plugin-assistant`
- `pinecone-plugin-interface`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/nihalnihalani/rocketride-server/tree/develop/nodes/src/nodes/store_pinecone)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
