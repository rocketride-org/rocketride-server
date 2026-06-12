# milvus

A RocketRide store node that persists embedded documents in a Milvus vector database and retrieves them by semantic or keyword similarity search.

## What it does

Stores pre-embedded document chunks in a Milvus collection and answers questions against
them using semantic (vector) or keyword search. Supports both self-hosted Milvus and
Zilliz Cloud. Documents must be run through an embedding node before reaching this node:
ingesting a chunk without an embedding raises an error.

Uses **pymilvus** (`MilvusClient`). The collection is created automatically on first
document ingest if it does not exist, with the vector dimension taken from the incoming
embeddings. Re-ingesting a document replaces it: all existing entities with the same
`objectId` are deleted before the new chunks are upserted in batches (default: 50 chunks
per batch).

Documents removed at the source are soft-deleted by default. A `markDeleted` call flips
the `isDeleted` metadata flag rather than dropping the entities, and searches exclude
soft-deleted documents unless the filter explicitly asks for them. `markActive` reverses
the flag if a document comes back. A hard `remove` deletes the entities outright.

When the node configuration is saved, the engine probes the connection (5-second timeout)
and validates the collection name: 1-255 characters, letters, digits, and underscores
only, starting with a letter or underscore.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | *(none)*    | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

### Fields

| Field | Type | Description |
|---|---|---|
| `profile` | string | Default "cloud". Connect to... |
| `provider` | string | Default "milvus".  |

### Advanced settings

These keys are read from the node config but have no dedicated UI field:

| Key                   | Default      | Description                                                               |
| --------------------- | ------------ | ------------------------------------------------------------------------- |
| `similarity`          | `COSINE`     | Metric type for the vector index. Accepted values: `L2`, `IP`, `COSINE`, `JACCARD`, `HAMMING`, `BM25`. Any other value raises an error at startup. |
| `timeout`             | `60`         | Connection and operation timeout in seconds (minimum 1).                  |
| `bulkInsertBatchSize` | `50`         | Number of chunks per bulk upsert batch (minimum 1).                       |
| `renderChunkSize`     | `33554432`   | Number of chunks fetched per group when rendering a full document.        |

---

## Profiles

| Profile                         | `mode`  | Default host             | Default port | Connection                                |
| ------------------------------- | ------- | ------------------------ | ------------ | ----------------------------------------- |
| Milvus cloud server *(default)* | `cloud` | *(your Zilliz endpoint)* | `443`        | `https://<host>` with `apikey` as token   |
| Your own Milvus server          | `local` | `localhost`              | `19530`      | `http://<host>:<port>`, no token required |

---

## Collection schema & indexing

The auto-created collection has four fields:

| Field     | Type                         | Notes                                                              |
| --------- | ---------------------------- | ------------------------------------------------------------------ |
| `id`      | `INT64`, primary key         | Generated per chunk from the UUID1 timestamp combined with 27 random bits |
| `vector`  | `FLOAT_VECTOR`               | Dimension taken from the first ingested embeddings                 |
| `content` | `VARCHAR` (max length 65535) | The chunk text                                                     |
| `meta`    | `JSON`                       | Chunk metadata used for filtering (`objectId`, `nodeId`, `parent`, `chunkId`, `permissionId`, `isDeleted`, and others) |

Indexes: an `IVF_FLAT` vector index (`nlist: 1024`) using the configured `similarity`
metric, and an `STL_SORT` scalar index on `id`.

---

## Search behavior

**Semantic search** requires the question to carry an embedding (bind the pipeline to an
embedding node) and verifies the embedding model matches the collection. Non-zero result
offsets are not supported and raise an error. The query limit is raised to 25 whenever
the requested limit is 10 or lower.

**Scoring:** with the `COSINE` metric, the raw Milvus distance is rescaled to `[0, 1]`
via `(distance + 1) / 2`, where 1 means most similar. For other metrics a sigmoid of
`distance / -100` is used. Results below the `score` threshold are discarded.

**Keyword search** runs a substring match (`content like '%query%'`) combined with the
same metadata filters as semantic search.

All filter values (object IDs, node IDs, parents, permissions, and the keyword query) are
escaped before interpolation into Milvus filter expressions.

---

## Rendering

Given an `objectId`, the node can rehydrate the complete document text by fetching its
chunks in `chunkId` order, in groups of `renderChunkSize`, and streaming the joined text
to the output callback. Rendering only applies to objects that were vectorized by this
pipeline (objects without a vector batch ID fall through to the next driver).

The store counts **vectors (chunks)**, not documents: the node-reported document count is
the number of entities in the collection.

---

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

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/milvus)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
