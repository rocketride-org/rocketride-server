# rocketride_vector

A RocketRide vector store node that stores embedded document chunks and retrieves
them by keyword or semantic similarity from the managed tenant database. Pick it
over the SQL and graph nodes for retrieval-augmented document search.

## What it does

The node writes documents from the documents lane into a pgvector-backed table,
replacing existing chunks for the same object IDs. Questions can produce
matching documents, answers, or enriched questions through the three configured
question outputs. Use it when retrieval should flow through a pipeline; unlike
the tool-capable sibling stores, this node registers no agent tools or raw-SQL
execution surface.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| documents | — | Stores document chunks in the configured vector table. |
| questions | documents | Returns matching documents. |
| questions | answers | Returns matching documents as answers. |
| questions | questions | Enriches a question with matching documents. |

## Configuration

The single cloud profile provides a table, cosine similarity, a score threshold,
and HNSW index defaults. RocketRide provisions a per-tenant database for its
managed database nodes, and this node resolves it from the signed-in RocketRide
identity instead of a host, user, password, or database name you enter. Bind an
embedding module for semantic search; the embedding dimension is taken from the
first stored document rather than from a configuration field.

### Table

Table defaults to rocketride and is the PostgreSQL table that holds the chunks
and embeddings. Choose a distinct table when separate corpora need separate
retrieval indexes or retention behavior. The node accepts only an unquoted
PostgreSQL identifier: it must start with a letter or underscore, use only
letters, digits, and underscores, and be at most 63 characters. Invalid names
are rejected during configuration validation and at startup.

### Score threshold and similarity metric

Score threshold defaults to 0.5; it is the minimum returned similarity score.
Raise it when loose matches are polluting downstream context, and lower it when
relevant documents are being excluded. Scores are calculated from the
configured metric: cosine uses 1 - distance, L2 uses 1 / (1 + distance), and
inner product negates the returned distance. Regardless of this setting, the
store drops results below its fixed 0.20 minimum similarity floor.

Similarity Metric defaults to cosine; l2 and inner_product are also accepted.
Select the metric that matches the embeddings and expected notion of closeness
before the table is first written, because it chooses the HNSW operator class
used for the index. An unsupported value prevents startup.

### HNSW m and ef_construction

The table's HNSW index is created on first write. HNSW m defaults to 16 and
controls the graph degree; HNSW ef_construction defaults to 64 and controls the
candidate list used while building it. Higher values can improve search quality
at the cost of a more expensive, larger index. Values are clamped to pgvector's
supported ranges (m 2–100 and ef_construction 4–1,000), and ef_construction is
raised to at least twice m. These values do not rebuild an index that already
exists.

## Notes

### Storage and retrieval behavior

The node creates the table on the first write and creates a metric-compatible
HNSW index then. pgvector cannot create that index for embeddings wider than
2,000 dimensions, so the node warns and searches without the index in that
case. Keyword search uses a content LIKE match; semantic search needs an
embedding bound to the question and raises if none is available. Missing tables
produce empty search results rather than an error.

Deleted objects are excluded by default, while document rendering reassembles
stored chunks by chunkId. The store removes all existing chunks for incoming
object IDs before inserting the replacement chunks, preventing duplicate data
for a re-ingested object.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
