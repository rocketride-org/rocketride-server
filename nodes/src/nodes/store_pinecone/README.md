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
| `upsert` | Adds or updates a non-empty `documents` array. Each document requires content and an object ID; it can provide an embedding and embedding model or use the bound embedding provider. |
| `delete` | Deletes documents for a non-empty `object_ids` array and returns the deleted count. |

`search` requires a bound embedding provider for semantic similarity search. The three functions return a failure object when their required input or an embedding cannot be obtained.

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

Although the configuration value `score` is read with a default of `0.5`, the semantic-search filtering code reads the separately named `threshhold_search` attribute, whose initial value is `0.0`; therefore the configured score is not applied by this implementation. Do not rely on this setting to suppress weak Pinecone results. If relevance needs stricter filtering, apply a downstream constraint or use a store whose retrieval threshold is enforced until this implementation changes.

### API key

The API key is trimmed before the Pinecone client is created. It is needed both
to open the store and for the save-time probe that lists indexes. Rotate or
replace it when authentication fails rather than changing the collection name;
the probe can also reveal a key that reaches Pinecone but cannot inspect the
chosen index. Keep one key per intended service boundary when the node should
not see every index available to a broader application credential.

### Tool Server Name

The tool-server name defaults to `pinecone` and prefixes the three agent functions. Change it when multiple Pinecone stores are connected to the same agent so their functions do not share a namespace.

## Authentication

Set the API key for the selected Pinecone profile. The runtime creates its client with that key, and the save-time probe uses it to list indexes and check an existing index's deployment mode.

## Notes

### Search and document lifecycle

Semantic search requires an embedding and does not accept a non-zero offset. Keyword search adds a content filter to the metadata filters. Re-ingesting an object deletes its existing chunks before replacement chunks are upserted. The store can mark chunks deleted or active, and its default filters exclude marked-deleted chunks.

The node retrieves semantic results with the requested limit (or 25 when no
limit is supplied). It runs the collection-existence and embedding-model checks
before searching, which makes a missing index or incompatible model fail before
results are returned.

Index creation is intentionally opinionated: the serverless branch supplies an
AWS `us-east-1` specification, while the pod branch supplies one `p1.x1` pod in
`us-east1-gcp`. Those are creation-time defaults in this node, not settings
that alter an existing index. Choose an already compatible index when those
defaults are not appropriate for the intended deployment.

### Rendering and paths

Rendering retrieves an object's chunks in `chunkId` order and sends joined text to the callback in `renderChunkSize` groups. For path listing, the driver requests enough records for the requested offset and limit, then slices the results locally.

Metadata filters include document identity, parent path, permissions, table
information, and deletion state. The driver defaults `isDeleted` to false in
its Pinecone filter, so a soft-deleted source does not appear in normal
retrieval. That makes reactivating or explicitly including deleted material a
separate caller choice rather than an accidental result of broad searching.

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
| `pinecone.serverName` | `string` | **Tool Server Name**<br/>Namespace for agent-facing tool names, e.g. 'pinecone' exposes tools as pinecone.search / pinecone.upsert / pinecone.delete. Change this when running multiple Pinecone nodes in the same pipeline so their tool names do not collide. | `"pinecone"` |

## Dependencies

- `pinecone`
- `pinecone-plugin-assistant`
- `pinecone-plugin-interface`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_pinecone)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
