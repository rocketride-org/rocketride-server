# store_postgres

A RocketRide vector-store node that stores embedded document chunks in PostgreSQL with pgvector and retrieves them by semantic or keyword search. Use it when a pipeline or agent needs vector retrieval in a PostgreSQL database.

## About PostgreSQL

PostgreSQL is a relational database that stores structured data and supports SQL
queries. The pgvector extension adds a vector data type and vector-distance
operators to PostgreSQL. This combination is useful when vector retrieval should
live beside the relational data and operational practices a team already uses.

## What it does

The node accepts embedded documents on its `documents` lane and can retrieve matching documents for incoming questions. It also exposes the store to an agent as tools. The target table is created when documents are first added, and semantic retrieval requires question embeddings. Pick it over a dedicated vector database when the corpus should remain in a PostgreSQL database and the operator can provide pgvector there.

The created table contains content, document metadata, the embedding, its model name, and its vector size. That makes one table the store for both vector retrieval and keyword lookup, while the configured database retains PostgreSQL's normal connection and access controls.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | — | Store embedded document chunks. |
| `questions` | `documents` | Return matching documents. |
| `questions` | `answers` | Return matching documents as answers. |
| `questions` | `questions` | Enrich questions with matching documents. |

## As a tool

The configured tool-server name defaults to `postgres`.

| Function | Description |
| --- | --- |
| `search` | Searches the store for a non-empty `query`; accepts optional `top_k` and metadata `filter`, and returns matching content, metadata, and scores. |
| `upsert` | Adds or updates a non-empty `documents` array. Each document requires content and an object ID; it can provide an embedding and embedding model or use the bound embedding provider. |
| `delete` | Deletes documents for a non-empty `object_ids` array and returns the deleted count. |

`search` requires a bound embedding provider for semantic similarity search. The three functions return a failure object when their required input or an embedding cannot be obtained.

## Configuration

Enter the PostgreSQL connection details and choose the table that will hold the chunks. The local profile supplies the initial values, including a retrieval score of `0.5` and `cosine` similarity. Start by confirming that these credentials reach a database where the `vector` type is available; the save-time probe opens a short-lived connection, runs `SELECT 1`, and tests that type before this node is used in a pipeline.

### Connection and database

Host, port, user, password, and database are passed directly to the PostgreSQL
client. Use a dedicated database or role when you want the retrieval corpus to
have separate ownership from other application tables. Connection or permission
errors during the save-time probe point to these fields; an error about the
`vector` type means pgvector is not available in the selected database.

### Table

The Table field names the table used for vectors; its default is `rocketride`. It must be a valid unquoted PostgreSQL identifier: at most 63 characters, starting with a letter or underscore, and thereafter containing only letters, digits, or underscores. The driver also accepts the legacy `collection` key, but the panel uses Table.

Change the table when a corpus needs its own physical store. The runtime uses the
name in its SQL statements and does not quote it, which is why punctuation,
spaces, and a leading digit are rejected instead of being escaped. A valid new
name produces a new table at first ingest; it does not migrate rows from the
old table.

### Similarity Metric

Choose `cosine`, `l2`, or `inner_product`; the runtime maps them to PostgreSQL's vector-distance operators and rejects any other value. Use the setting that matches how the vectors are meant to be compared, because it determines ranking for semantic searches. `cosine` maps to `<=>`, `l2` to `<->`, and `inner_product` to `<#>`.

The retrieval score defaults to `0.5`, and the driver always removes results
whose converted score is below its hard `0.20` floor. Raise the configured
threshold to give downstream prompts fewer, more selective documents; lower it
when relevant documents are missing. The conversion differs by metric—cosine
uses `1 - distance`, L2 uses `1 / (1 + distance)`, and inner product negates
the returned distance—so do not carry a score threshold across a metric change
without retesting the retrieval quality.

### Retrieval and embedding compatibility

The first write creates the table with a vector column sized for its incoming
embedding. Later semantic searches check the requested embedding model against
the existing collection before executing. Keep documents produced by compatible
embedding configurations in the same table; a model or vector-size mismatch is
a sign to create or select a separate table, rather than to treat the failure
as an ordinary relevance-tuning issue.

### Tool Server Name

The tool-server name defaults to `postgres` and prefixes the three agent functions. Change it when multiple PostgreSQL stores are connected to the same agent so their functions do not share a namespace.

## Authentication

Provide the configured PostgreSQL host, port, user, password, and database. The save-time probe opens a PostgreSQL connection with those values and verifies that the database supports the `vector` type.

## Notes

### Search and document lifecycle

Semantic search requires an embedding. Keyword search performs a `LIKE` match on content with the metadata filters. Re-ingesting an object deletes its existing rows before replacement chunks are inserted. The store can mark chunks deleted or active, and its default filters exclude marked-deleted chunks.

Semantic search orders by the chosen pgvector distance operator and checks that
the stored embedding model is compatible before searching. Unlike the other
paths, it cannot take a non-zero result offset. This matters for callers that
try to paginate semantic results: use a limit or a separate retrieval strategy
instead of expecting SQL-style offset pagination.

The metadata filters are translated to SQL predicates for node, parent,
permissions, object IDs, chunk IDs, table data, and deletion state. Normal
searches exclude marked-deleted rows. Use those filters to narrow one shared
table to an eligible corpus; changing the table name is for an independently
managed store, not the routine way to restrict a query.

### Rendering

Rendering retrieves an object's chunks in `chunkId` order and sends joined text to the callback in `renderChunkSize` groups. The node's document count is a count of rows in the table.

The runtime removes an object's existing rows and commits that deletion before
it inserts the replacement chunks. Retain a source of truth that can be
ingested again: if a replacement write fails, the previous rows have already
been removed rather than preserved as a fallback copy.

## Upstream docs

- [PostgreSQL documentation](https://www.postgresql.org/docs/)
- [pgvector documentation](https://github.com/pgvector/pgvector)

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

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_postgres)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
