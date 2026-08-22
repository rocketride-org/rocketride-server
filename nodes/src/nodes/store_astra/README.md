# store_astra

A RocketRide vector store for Astra DB that stores embedded document chunks and retrieves matching content in a pipeline or through an agent tool.

## About Astra DB

Astra DB is a database service with a Data API for application access. This node uses that API to create and query a collection whose vector and lexical search features are enabled. It is a storage and retrieval backend: it does not create embeddings or host a local database.

## What it does

The node writes embedded documents from the `documents` lane to an Astra collection and searches that collection for incoming questions. Semantic questions use the question embedding as the collection's vector sort; keyword questions use Astra's lexical sort. It can also bind `search`, `upsert`, and `delete` to an agent.

Choose it when the data must live behind an Astra Data API endpoint and you want Astra to provide both vector and lexical retrieval. Pick a sibling store instead when your existing collection lives in that sibling's database; this node creates and manages an Astra collection rather than adapting another store's protocol.

The collection is created only on the first write. Its vector dimension comes from those first incoming embeddings, its configured similarity is applied at creation, and lexical search is enabled with Astra's `standard` analyzer. A question or read against a collection that has not been created simply returns no documents.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store pre-embedded document chunks. |
| `questions` | `documents` | Emit matching documents. |
| `questions` | `answers` | Emit matching documents as answers. |
| `questions` | `questions` | Enrich the question with matching documents. |

## As a tool

The configured tool server name is the namespace for the functions below; it defaults to `astra`.

| Function | Description |
| --- | --- |
| `search` | Search the collection for matching documents. |
| `upsert` | Add or update documents in the collection. |
| `delete` | Remove documents by object ID. |

`search` and an `upsert` without a supplied embedding use the node's bound embedding provider. These calls are on the agent tool channel, not the document lanes. Give each Astra node a distinct tool server name when an agent can reach more than one of them.

## Profiles

| Profile | Endpoint | Collection |
| --- | --- | --- |
| Local test server | `http://localhost:8080` | `ROCKETRIDE` |
| Astra DB cloud server *(default)* | Set an API endpoint | `ROCKETRIDE` |

## Configuration

Choose the profile, then provide the endpoint, token, collection, similarity, and retrieval score for the Astra database. The profile supplies the initial connection values; most deployments only need to replace the cloud endpoint and token. Feed an embedding node before this store: an arriving document without an embedding raises an error instead of being stored.

### Endpoint, token, and collection

Set **API Endpoint** to the Astra Data API endpoint and **Application Token** to the token used by `DataAPIClient`. The local profile deliberately starts with a local endpoint and test token, so replace both values when it is not your test server. A bad endpoint or token surfaces when the client uses the API; this node does not make a save-time connection probe.

Set a collection name before ingesting. It must start with a letter or number, and the remaining characters may only be letters, numbers, or underscores; startup rejects any other name. This matters before the first write because that write creates the collection—correct the name rather than expecting a later query to create it.

### Similarity and embedding dimension

The first successful ingest fixes the collection's vector dimension from the incoming embedding, and uses the selected similarity metric. `cosine` is the default; `euclidean` and `dot_product` are the only alternatives accepted by the implementation. Leave the default for ordinary normalized embedding vectors; change it only when the embedding model and the collection's intended metric agree. Reusing a collection with a different embedding length or an incompatible metric is a reason to create a separate collection rather than mix vectors.

### Retrieval score

The generated configuration supplies the requested retrieval score, while the store also has a hard floor: semantic hits below `0.20` are discarded before they reach any output lane. Raise the configured score when loosely related context is polluting answers; lower it when relevant content is absent, while remembering that values below the hard floor cannot restore those results. Keyword search does not carry this vector-similarity filter.

### Profile choice and first write

The cloud profile is the default and begins with empty endpoint and token values, which is the right starting point for an Astra deployment. The local profile is specifically a test-server preset: it uses `http://localhost:8080`, `test-token`, and the `ROCKETRIDE` collection. Select it only when that is the server you intend to reach; it is not a discovery mode for a cloud database.

The first write has two responsibilities: it creates the collection and supplies the vector dimension used for it. Send a small, representative embedded document after configuration rather than letting the first production batch establish an accidental dimension. Reads, deletes, and renders before that first creation are safe but return no stored content.

### Collection lifecycle controls

This store treats `chunkId` 0 as the beginning of a full object. If an ingest batch contains that chunk, the store schedules the object's existing chunks for deletion before inserting the new batch. Use a stable `objectId` across re-ingests to get replacement behavior; changing it creates another independently stored object.

Soft deletion is a separate lifecycle action. It leaves the chunks in Astra and changes `meta.isDeleted`, while a hard removal deletes the matching records. Choose soft deletion when a caller may need to inspect or restore the object; choose hard deletion when its data must no longer be stored.

### Tool Server Name

This is the namespace for agent functions, so the default exposes `astra.search`, `astra.upsert`, and `astra.delete`. Change it when multiple Astra nodes are connected to the same agent to prevent name collisions.

## Authentication

Set **API Endpoint** to the Astra Data API endpoint and **Application Token** to the token passed to the Data API client. The local profile also has endpoint and token values, so replace them when connecting to a different local server. The node passes the configured token directly to the Data API client; it does not offer a second authentication mode.

## Notes

### Search behavior and filters

Keyword search uses Astra's native lexical sort and supports the requested offset and limit. Semantic search uses the question embedding, includes a similarity score, and uses the requested result limit. Both paths apply the standard document filters for node, parent, permissions, object, table, and chunk selection. By default they also require `meta.isDeleted` to be false, so marked-deleted content stays hidden unless a caller explicitly requests it.

The two search modes are selected by the incoming question rather than by a second connection setting. Use a semantic question when the vocabulary may differ from the stored text, and use keyword search when exact words, paging, or the lexical index are more important. A semantic query with no collection returns an empty set; a document with no embedding is rejected at ingestion rather than being converted to keyword-only content.

### Ingestion, replacement, and deletion

The node stores each chunk with a generated `_id`, the content, metadata, and its vector. It collects up to 500 chunks before inserting. If a chunk with `chunkId` 0 arrives, all existing chunks with the same `objectId` are deleted first, so a complete re-ingest replaces that object instead of duplicating it. Near-zero vectors are omitted from the insert batch; the special zero-vector schema control document is adjusted to a tiny non-zero vector.

`markDeleted` and `markActive` update the `meta.isDeleted` flag for all chunks of the supplied object IDs, while `remove` permanently deletes those chunks. Rendering an object fetches its non-deleted chunks, sorts them by `chunkId` in the node, and joins their content because Astra does not guarantee the returned order.

That ordering detail matters when rendering a document whose chunks were written in parallel: do not rely on Astra's natural return order to reproduce the source text. The node makes the ordering decision itself, then calls the render callback with the combined text.

### Tool embedding dependency

Agent `search` needs an embedding for semantic retrieval, and agent `upsert` needs one to write a vector. Supplying an embedding in the tool call avoids that dependency; otherwise bind an embedding provider to the node. Do not assume the pipeline's document lane will supply it to a tool invocation—the two paths are separate.

## Upstream docs

- [Astra DB documentation](https://docs.datastax.com/en/astra-db/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `astra_db.api_endpoint` | `string` | **API Endpoint**<br/>Enter the server API endpoint e.g. <instance-name>.<region>.apps.astra.datastax.com |  |
| `astra_db.application_token` | `string` | **Application Token**<br/>Enter the server API application token |  |
| `astra_db.provider` | `string` |  | const: `"astra_db"` |

## Dependencies

- `astrapy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_astra)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
