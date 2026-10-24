# store_chroma

A RocketRide vector store for Chroma that stores embedded document chunks and retrieves matching content in a pipeline or through an agent tool.

## About Chroma

Chroma is a vector database used here through its HTTP client. This node keeps document text, metadata, and vectors in a Chroma collection and queries that server over the network. It does not run an embedded Chroma database inside RocketRide.

## What it does

The node stores pre-embedded chunks in a Chroma collection and retrieves them by vector similarity or keyword containment for incoming questions. It can also be connected as an agent tool. Choose it when a reachable Chroma server is the store for your pipeline and you need both pipeline lanes and agent access; choose a sibling store when the database you operate is not Chroma.

The node uses the lightweight `chromadb-client` HTTP client and creates the collection on its first write. It requires an embedding on every incoming document, so wire an embedding node ahead of its document lane. It can use a self-managed server or a token-authenticated cloud server, but both are remote HTTP connections.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store pre-embedded document chunks. |
| `questions` | `documents` | Emit matching documents. |
| `questions` | `answers` | Emit matching documents as answers. |
| `questions` | `questions` | Enrich the question with matching documents. |

## As a tool

Pipeline agents address the functions below as `<node id>.<function>`. The configured tool server name (default `chroma`) labels tool-response messages.

| Function | Description |
| --- | --- |
| `search` | Search the collection for matching documents. |
| `objdir` | Lists the distinct parent paths of active documents in the collection as a map of parent path to one object ID each; accepts optional `parent` (exact match), `offset`, and `limit` (default and cap 1000). `offset` and `limit` count documents, not paths: documents that share a parent path appear as one entry, so a page can hold fewer than `limit` entries while more follow. |
| `get` | Returns up to `limit` chunks (default and cap 100) of one document by `object_id`, ordered by chunk ID, with `total`, `has_more`, and `truncated`; an object ID the store does not hold, or one in the trash, returns a failure object. |
| `stats` | Returns the collection's count as this store reports it, `document_count` (null on this store, which does not list documents), the embedding model name, and the vector size. |
| `upsert` | Add or update documents in the collection. |
| `delete` | Remove documents by object ID. |
| `soft_delete` | Moves the documents of a non-empty `object_ids` array to the trash, keeping their chunks; the reply echoes the distinct IDs, and `matched_chunks` is the number of chunks the store matched (0 when none exists). |
| `restore` | Takes the documents of a non-empty `object_ids` array out of the trash; the reply echoes the distinct IDs and the numeric `matched_chunks` count, as for `soft_delete`. A document removed with `delete` cannot be restored. |

`search` and an `upsert` without a supplied embedding use the node's bound embedding provider. These calls are separate from the data lanes, so a pipeline embedding upstream does not by itself provide vectors to a tool call. Agents distinguish multiple Chroma nodes by their pipeline node IDs.

`search` accepts an optional `filter` object honoring only `objectId`, `nodeId` and `parent`; any other key is rejected. `upsert` accepts an optional `metadata` object storing `nodeId`, `parent` and `chunkId`; `nodeId` defaults to `"vectordb_tool"`, `parent` to `"/"`, and `chunkId` to the document's position among the chunks sent for its object ID in the call (0 for the first), and an explicit `chunkId` may not repeat within the call.

## Profiles

Default: **Your own ChromaDB server** (`local`).

| Profile | Connection | Authentication |
| --- | --- | --- |
| Your own ChromaDB server **(default)** | Host and port | None configured by the node |
| ChromaDB Cloud Server | Host and port | Token authentication with the API key |

## Configuration

Start with the local or cloud profile, then provide the host, port, collection, similarity, retrieval score, and—when using cloud—the API key. Most fields can remain at their profile values after the server address is set. The collection's similarity is established when it is first created, so choose it before writing the first documents.

### Connection profile and port

The local profile creates a plain HTTP client; the cloud profile connects over TLS and sends the API key in the `x-chroma-token` header, which suits ChromaDB Cloud or any TLS-protected remote server. ChromaDB Cloud additionally requires `tenant` and `database`; its host is `api.trychroma.com`. Use the cloud profile only when you have the token that Chroma expects; the local profile deliberately supplies no credentials. The implementation removes an `http://` or `https://` prefix and trailing slash from the configured host before connecting, so enter the host once rather than trying to encode a path in it.

Ports may be literal integers, numeric strings, or interpolated environment values. A whole-number value in the TCP range is used; a boolean, fractional value, unresolved placeholder, non-numeric value, or out-of-range value silently falls back to `8000`. This is useful for an environment placeholder, but it can also send a cloud connection to the wrong port: if a connection unexpectedly targets `8000`, check the resolved value first.

### Collection and similarity

The collection is created on first write with the selected similarity in its `hnsw:space` metadata. `cosine` is the default; `l2` and `ip` are the only other accepted values. Keep that setting aligned with your embedding model, and do not expect changing it later to rewrite an existing collection's index. Use a separate collection if the new model needs a different vector shape or distance metric.

Semantic retrieval needs a question embedding and does not support a non-zero offset. Use keyword search when you need paged text matching: it uses Chroma's document-contains filter and supports offset and limit. Semantic scores are converted from Chroma distances and hits below `0.20` are always discarded. Raise the requested score when marginal chunks are harming a prompt; lower it for recall, knowing the hard floor still applies.

### Retrieval score and document filters

The retrieval score controls which semantic hits are emitted after distance conversion. It affects semantic questions only, not keyword containment. Default filters exclude records with `isDeleted` metadata set to true, while records without that key are treated as active. The same filter conversion supports node, parent, object, table, chunk range, and permission constraints, so prefer filters over copying data into many collections merely to narrow a query.

### Top K

**Top K** (`top_k`) sets how many candidate chunks Chroma fetches for a semantic or keyword question before score filtering. It overrides the caller's request limit in both directions rather than only widening it: on the data lane that limit is 25, so `50` doubles the candidate pool while `20` shrinks it. Leave it unset to use the caller's limit as-is. The `chroma.search` tool sets its own `top_k` (default 10, maximum 100), and whole-object fetches are unaffected.

Valid values are `1` to `1000`, written as an integer (`50`) or an integer string (`"50"`). The string form exists because environment interpolation always resolves to a string, so a `${ROCKETRIDE_TOP_K}` placeholder validates; a placeholder still unresolved at run time falls back to the caller's limit rather than failing the node, the same way `port` falls back to its default. Any other non-integer value, or an integer outside that range, is rejected when the node starts instead of being silently clamped, so a mistyped value surfaces immediately rather than quietly changing how many documents you retrieve.

To widen the pool for a reranker or for hard, specific questions, pick a value comfortably above the caller's limit, for example `50`, and place a `rerank_cohere` node after this one to reorder the candidates and keep a small, high-relevance set. A complete example is at [`examples/rag-rerank-pipeline.pipe`](../../../../examples/rag-rerank-pipeline.pipe).

### Profile choice and collection creation

Use **Your own ChromaDB server** when you control a reachable server and do not need token authentication. Use **ChromaDB Cloud Server** when that server expects the configured API key. The profile determines how the HTTP client is constructed, so switching profiles is not just a different display label for the same connection.

The first document write calls Chroma's get-or-create collection operation and attaches the chosen `hnsw:space` metadata. Make the similarity decision before the first write. If you need to move an existing collection to a different distance metric, create and migrate to a new collection instead of expecting this node to alter the existing index.

### Document lane and tool embeddings

Every document-lane chunk needs an embedding; the store raises an error when it is absent. A semantic question needs an embedding too, while keyword containment works from the question text. This is intentionally different from an agent `upsert`, which can ask the node's bound embedding provider to create a missing vector.

Use the bound provider for an agent that must add or search information without manually supplying embeddings. If an agent tool fails for a vector-related reason while document-lane storage succeeds, inspect that binding and the tool payload before changing Chroma configuration.

### Tool Server Name

The name defaults to `chroma` and labels this store in tool-response messages. Pipeline agents address all eight functions listed above by node ID, for example `<node id>.search` or `<node id>.restore`; changing this label does not change those addresses.

## Authentication

The cloud profile passes **API Key** to Chroma's token-authentication client. The local profile constructs the HTTP client without those authentication settings. A failed connection reports the host and port and points to connectivity, credentials, or an incompatible server as possible causes.

## Notes

### Server compatibility

When the server reports a version, this node requires Chroma 0.6 or later. An unparseable or unavailable version does not block connection, but an identified older server is rejected with an upgrade message. This protects against an older server failing later with a confusing client compatibility error.

### Ingestion, replacement, and rendering

Every ingested chunk needs an embedding. Inserts are batched and flush at 500 chunks or when the accumulated payload exceeds the configured limit. A chunk with `chunkId` 0 causes older chunks with the same `objectId` to be deleted before the new chunks are upserted, so a re-ingest replaces an object rather than adding a second copy. Chroma record IDs are generated UUIDs; use `objectId` and `chunkId` as the stable application identifiers.

Soft deletion marks the metadata and hides a document from default search; hard deletion removes it. Rendering reconstructs an object in chunk-ID order and reads it in configured windows, tolerating gaps in the sequence. That makes the render path appropriate for a large stored document, not a guarantee that all chunks are contiguous.

The node gives each Chroma record a fresh UUID, even when an object is being re-ingested. The stable identifiers for lifecycle operations are therefore the metadata `objectId` and `chunkId`, not an internal Chroma record ID. Keep those metadata values consistent across imports to make replacement, filters, and rendering predictable.

### Search result interpretation

Chroma reports distances, which the node converts to the score carried by a returned document. The conversion differs for cosine versus `l2` or `ip`, so a numeric threshold has meaning only alongside the selected similarity. Compare retrieval-score behavior within one collection and metric; do not treat the same threshold as equivalent after changing metrics.

When semantic results are unexpectedly empty, verify the query embedding, the collection metric, the `isDeleted` filter, and the `0.20` hard floor in that order. When keyword results are unexpectedly empty, verify the search text and document containment rather than the vector score.

### Agent tool dependency

Agent semantic search and automatic tool upserts require the node's bound embedding provider unless the tool request supplies an embedding itself. If a tool returns an embedding-related error while the pipeline path works, check the tool binding rather than the Chroma host configuration.

## Upstream docs

- [Chroma documentation](https://docs.trychroma.com/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `chroma.database` | `string` | **Database**<br/>Chroma Cloud database name (required for Chroma Cloud, optional for self-hosted multi-tenant servers) | `""` |
| `chroma.profile` | `string` | **Type of chroma host**<br/>Connect to... | `"local"` |
| `chroma.provider` | `string` |  | const: `"chroma"` |
| `chroma.serverName` | `string` | **Tool Server Name**<br/>Label for this store in tool-response messages (for example, a refused write names chroma.delete). Pipeline agents address the available functions as node-id.function; apps use the function name and node ID. Changing this label does not change those addresses. See the node README for the available functions and their tool-exposure and write-permission settings. | `"chroma"` |
| `chroma.ssl` | `boolean` | **Use TLS**<br/>Connect over HTTPS. Required for Chroma Cloud, which serves HTTPS only. Turn it off for a self-hosted server reached over plain HTTP. | `true` |
| `chroma.tenant` | `string` | **Tenant**<br/>Chroma Cloud tenant id (required for Chroma Cloud, optional for self-hosted multi-tenant servers) | `""` |
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-url> |  |
| `vector.cloud.port` | `number,string` | Port number. Enter a plain integer such as 443, or an env-var placeholder like ${ROCKETRIDE_CHROMA_PORT}. Placeholders resolve to a string at run time, so this field accepts both a number and a string; the node coerces the value to an integer before connecting, so either form works. | `"443"` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` | `number,string` | Port number. Enter a plain integer such as 8000, or an env-var placeholder like ${ROCKETRIDE_CHROMA_PORT}. Placeholders resolve to a string at run time, so this field accepts both a number and a string; the node coerces the value to an integer before connecting, so either form works. | `"8000"` |

## Dependencies

- `chromadb-client`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_chroma)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
