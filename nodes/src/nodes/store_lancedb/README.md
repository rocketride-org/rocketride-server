# store_lancedb

A RocketRide vector store node backed by LanceDB, an embedded store whose tables are plain files in a local directory or on object storage, for storing embedded documents and retrieving them by semantic, keyword or hybrid search with no server to run.

## About LanceDB

LanceDB is an open-source, embedded vector database built on the Lance
columnar format. It runs inside the application instead of as a separate
server, keeps its tables as files on local disk or on S3, GCS and Azure Blob
storage, and offers vector, full-text and hybrid search.

## What it does

Stores pre-embedded document chunks in a LanceDB table and retrieves them by semantic (vector) similarity, full-text keyword search, or a hybrid of both. The node is also a tool node (`classType: ["store", "tool"]` with the `invoke` capability), so agents in the same pipeline can call its `search`, `upsert`, `delete`, `objdir`, `get` and `stats` tools directly.

Uses the official **`lancedb`** Python library in process. There is nothing to deploy: point the node at a directory, or at an `s3://`, `gs://` or `az://` uri, and the table is created there on first write.

Documents must be run through an embedding node before reaching this node: the store does not compute embeddings on the data lane and raises an error if a chunk arrives without one.

Each chunk is one row: the text, the vector, the full chunk metadata as JSON, and copies of the fields the filters use (`objectId`, chunk number, `nodeId`, parent path, `permissionId`, `isTable`, `tableId`, deleted flag). Writing chunk 0 of an object first deletes every row with the same `objectId`, so re-ingesting a document replaces it, including any tail chunks a shorter new version no longer has. A write that contains chunk 0 writes all of its rows in one merge; writes without chunk 0 go in batches of 1,000 rows.

## Example pipelines

**End-to-end RAG pipeline**

`webhook → parse → preprocessor_langchain → embedding_transformer → store_lancedb`

`chat → embedding_transformer → store_lancedb → prompt → llm_openai → response_answers`

Documents are parsed, chunked, embedded, and stored in a LanceDB table.
Chat questions use the same embedding and LanceDB retrieval path before the
prompt and LLM produce an answer.

**RAG index on object storage**

`webhook → parse → preprocessor_langchain → embedding_transformer → store_lancedb`

With the object storage profile the same pipeline keeps its index in a
bucket, so several engines can be pointed at one index and nothing has to be
operated besides the bucket.

**Agent with searchable memory**

An agent with this node connected as a tool: it calls `search` for context
when it decides it needs it, and `upsert`s new facts as it works, a knowledge
base the agent reads and writes on demand instead of retrieval running on
every question.

## Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the table                     |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

## As a tool

Tools are exposed under the configured `serverName` namespace (default `lancedb`). `Expose as tools` turns the whole tool surface on or off, and `Allow writes through tools` gates `upsert` and `delete`; the data lanes are not affected by either.

### `search`

Semantic similarity search over the table.

| Argument | Type    | Description                                                                 |
| -------- | ------- | --------------------------------------------------------------------------- |
| `query`  | string  | Required. The search query text.                                            |
| `top_k`  | integer | Maximum results to return (default 10, capped at 100).                      |
| `filter` | object  | Optional metadata filter; supports `objectId`, `nodeId`, and `parent` keys. |

Requires an embedding provider bound to the node (the embedding sub-block in the configuration). If semantic search fails, the tool falls back to keyword search. Returns `{"results": [{content, score, metadata}], "total": n}` on success or `{"success": false, "error": "..."}` on failure.

### `upsert`

Add or update documents in the table.

Each item in the `documents` array requires `content` and `object_id` (used for deduplication) and may include `metadata`, plus optional pre-computed `embedding` and `embedding_model` to skip automatic embedding. Without a pre-computed vector the node's bound embedding provider is used; if none is configured the call fails. Returns `{"success": true, "count": n, "skipped": n}`.

### `delete`

Delete documents by ID.

Takes a required `object_ids` string array and removes every row whose `objectId` matches. Returns `{"success": true, "deleted_count": n}`.

### `objdir`, `get` and `stats`

`objdir` lists the stored document paths, `get` returns one document's chunks in order, and `stats` reports how many chunks the table holds.

## Profiles

Default: **Local directory** (`local`).

| Profile                                     | Default location                          |
| ------------------------------------------- | ----------------------------------------- |
| Local directory **(default)**               | `./lancedb` under the engine data directory |
| Object storage (S3, GCS, Azure Blob)        | _(your bucket uri)_                       |

## Configuration

Pick where the tables live, name the table, and choose the distance metric.
Most deployments only touch the location and the table name.

### Location

For the local profile, a relative directory is placed under the engine's data
directory and may not climb out of it with `..`; an absolute path is used as
given. For the object storage profile, give a uri such as `s3://my-bucket/rag`;
the profile refuses an empty or local uri.

### Distance and search mode

`cosine` suits most embedding models; `l2` and `dot` are also available. The
metric is used for every search and for the vector index, so changing it on a
table that already has an index needs a new table. `Semantic search` set to
hybrid answers semantic questions with vector search fused with full-text
search on the question text; keyword questions always use full-text search.

### Index after rows and optimize after writes

Below `Index after rows` (default 50,000) tables are searched exactly. Once a
table reaches it, an IVF_HNSW_SQ index is built and searches re-rank the top
candidates on the raw vectors, which keeps results close to the exact ones. `Optimize after writes`
(default 1,000) compacts the table and refreshes its indexes on that cadence.
`0` turns either one off.

### Tool Server Name

Prefix for the tool names agents see: `lancedb` exposes `lancedb.search`,
`lancedb.upsert`, `lancedb.delete`. Change it when running multiple LanceDB
nodes in the same pipeline so their tool names do not collide and the agent
can tell the stores apart.

## Authentication

A local directory needs no credentials. For object storage, either set the standard environment variables of the cloud (`AWS_*`, `GOOGLE_*`, `AZURE_*`) on the engine, or put the settings in `Storage options` as a JSON object, for example `{"region": "us-east-1", "aws_access_key_id": "...", "aws_secret_access_key": "..."}`, or `{"endpoint": "http://localhost:9000", "allow_http": "true"}` for an S3 compatible server such as MinIO. The JSON is passed to LanceDB as `storage_options` and is stored as a secure field.

## Limitations

- **Not available on RocketRide Cloud** (`nosaas`): a local directory there does not survive a restart, so the node runs on self-hosted engines only.
- **One engine per local directory, and verify object-storage concurrency.** LanceDB does not document concurrent writers on one local directory, so treat a directory as owned by a single engine process. Sharing a table between engines needs object storage whose commits are atomic and conditional; S3-compatible providers vary, so verify that before pointing several engines at one index.
- **Reads catch up within 5 seconds.** A pipeline that has a table open checks for writes from other pipelines at most every 5 seconds, so a new or deleted document can take that long to show up in its searches.
- **Filesystem access.** The local profile writes under the engine data directory, or under the absolute path the node owner configures.

## Notes

### Scoring and relevance

Vector distances are rescaled to `[0, 1]` before filtering: cosine and dot distances map through `1 - distance / 2`, and squared L2 distances through `1 / (1 + distance)`. Results below a hard floor of `0.20` are always dropped as noise, and the configured retrieval `score` threshold is applied on top of that by the base store. Keyword hits are scored against the best hit of the same search, so the top match scores `1.0`. In hybrid mode each hit keeps the better of its vector score and its keyword score, so a strong keyword match is not dropped for being far away in vector space.

### Deletion and maintenance

Deletion of source files is a soft delete: chunks are marked deleted and excluded from all searches by default, and only returned when the filter explicitly asks for deleted documents. A document that reappears is marked active again. Removing a document deletes its rows; LanceDB reclaims the space when the table is optimized.

### Save-time validation

LanceDB is embedded, so there is no server to probe. When the configuration is saved the node checks the location, the table name (`^[A-Za-z0-9._-]{1,255}$`), the storage options JSON and the numeric settings, and reports any problem as a warning.

### Testing

`nodes/test/store_lancedb/` runs against a real LanceDB in a temporary directory, with no mocks and no Docker. Object storage is tested only when `ROCKETRIDE_LANCEDB_TEST_URI` names a bucket uri (and `ROCKETRIDE_LANCEDB_TEST_STORAGE_OPTIONS` its storage options, when the environment variables are not enough).

## Upstream docs

- [LanceDB documentation](https://docs.lancedb.com)
- [`lancedb` on PyPI](https://pypi.org/project/lancedb/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
