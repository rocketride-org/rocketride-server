# vectordb_postgres

A RocketRide store node that keeps document embeddings in PostgreSQL with the pgvector extension and retrieves them by semantic or keyword search.

## What it does

Stores embedded document chunks in a regular PostgreSQL table with a pgvector `vector` column, then serves retrieval queries against it. Use this when you want vector storage inside an existing PostgreSQL database rather than a dedicated vector database.

Uses **psycopg2** and the **pgvector** Python adapter (`register_vector`). The pgvector extension must already be installed in the target database, the node verifies this at config time by probing `SELECT NULL::vector`.

Key behavior to know:

- **The table is created automatically** (`CREATE TABLE IF NOT EXISTS`) on first ingest, with the vector dimension taken from the incoming embeddings.
- **Re-ingesting a document replaces it**: before inserting chunks, all existing rows with the same `objectId` are deleted, so updates do not accumulate duplicates.
- **Documents must be embedded upstream.** Semantic search raises an error if the question carries no embedding, bind an embedding node before this one.
- **A hard minimum similarity floor of `0.20`** is applied to semantic results in addition to the configurable retrieval score; matches below it are always dropped.
- Soft-deleted rows (`isDeleted = true`) are excluded from search results by default.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | -           | Ingest pre-embedded documents into the table                     |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

### Fields

| Field             | Type / Default                          | Description                                            |
| ----------------- | --------------------------------------- | ------------------------------------------------------ |
| Host              | string                                   | Host name or IP address of the PostgreSQL server       |
| Port              | number · `5432`                          | Port number of the PostgreSQL server                   |
| User              | string · `postgres`                      | User to connect to the PostgreSQL server               |
| Password          | string (secure)                          | Password to connect to the PostgreSQL server           |
| Database          | string · `postgres`                      | Name of the database                                   |
| Table             | string · `rocketride`                    | Name of the table to store vectors                     |
| Retrieval Score   | number · `0.5`                           | Minimum similarity threshold for returned matches      |
| Similarity Metric | enum · `cosine`                          | `cosine`, `l2`, or `inner_product`                     |

### Table name rules

The table name must be a valid unquoted PostgreSQL identifier: start with a letter or
underscore, contain only letters, digits, and underscores, and be at most 63 characters.
Anything else (spaces, dashes, dots, quotes) is rejected at config validation and at
startup. This is enforced deliberately, because the table name is interpolated into SQL.

### Similarity metrics and scoring

The metric selects the pgvector distance operator and how raw distance is converted to a
0–1-style score:

| Metric          | Operator | Score formula      |
| --------------- | -------- | ------------------ |
| `cosine`        | `<=>`    | `1 - distance`     |
| `l2`            | `<->`    | `1 / (1 + distance)` |
| `inner_product` | `<#>`    | `-distance`        |

The metric must match how the table was populated, switching metrics on an existing
table changes ranking semantics without re-embedding anything.

---

## Profiles

| Profile           | Description                   |
| ----------------- | ----------------------------- |
| Local _(default)_ | Your own PostgreSQL server    |

---

## Table schema

The auto-created table has these columns:

`id` (bigserial primary key), `content`, `objectId`, `nodeId`, `parent`, `permissionId`,
`isDeleted`, `chunkId`, `isTable`, `tableId`, `vectorSize`, `modelName`, and
`embedding vector(N)` where `N` is the embedding dimension of the first ingested batch.

---

## Requirements

The pgvector extension must be installed in the target PostgreSQL database before
connecting (`CREATE EXTENSION vector;`). Config validation connects with a 3-second
timeout, runs `SELECT 1`, and casts `NULL::vector`, a clear provider error is surfaced
if the extension is missing or the connection fails.

---

## Upstream docs

- [pgvector documentation](https://github.com/pgvector/pgvector)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `postgres.profile` | `string` | **Type of PostgreSQL host**<br/>Connect to... | `"local"` |
| `postgres.provider` | `string` |  | const: `"postgres"` |
| `vector.collection` | `string` | **Table**<br/>Name of the table to store vectors. | `"rocketride"` |
| `vector.local.database` | `string` | **Database**<br/>Name of the database | `"postgres"` |
| `vector.local.host` |  | **Host**<br/>Host name or IP address of the PostgreSQL server | `"your-postgres-host.example.com"` |
| `vector.local.password` | `string` | **Password**<br/>Password to connect to the PostgreSQL server |  |
| `vector.local.port` |  | **Port**<br/>Port number of the PostgreSQL server | `5432` |
| `vector.local.user` | `string` | **User**<br/>User to connect to the PostgreSQL server | `"postgres"` |
| `vector.similarity` | `string` | **Similarity Metric**<br/>The similarity metric to use for vector search | `"cosine"` |

## Dependencies

- `psycopg2-binary`
- `pgvector`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/vectordb_postgres)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
