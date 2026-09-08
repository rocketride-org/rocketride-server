# rocketride_vector

A RocketRide-managed vector store backed by PostgreSQL + pgvector in your own provisioned RocketRide cloud database — with **zero database setup** and a real vector index from the first write.

## What it does

Mirrors the generic `vectordb_postgres` store node: accepts documents (with embeddings from a bound `vectorizer`) on the `documents` lane, upserts them into a pgvector table, and serves keyword and semantic search on the `questions` lane.

Two differences from the generic node:

1. **No connection fields.** Instead of host/user/password, the node resolves a ready per-tenant DSN from the account layer (`Account.resolve_db_dsn(client_id)`), keyed by the authenticated connection identity. Requires signing into RocketRide cloud; on the open-source build without a cloud identity the node fails at start with `RocketRide cloud DB nodes require signing into RocketRide cloud`.
2. **Default HNSW index.** The generic node creates no index, so every semantic search is a sequential scan. This node creates an HNSW index over the embedding column when the table is first created. The operator class is derived from the `similarity` config so Postgres actually uses the index (`cosine → vector_cosine_ops`, `l2 → vector_l2_ops`, `inner_product → vector_ip_ops`), with build parameters `m = 16`, `ef_construction = 64` (overridable). pgvector's HNSW supports at most 2000 dimensions; for wider vectors the index is skipped with a warning and search falls back to a sequential scan.

There is **no direct-execute path** — vector stores are structured (search/upsert), and raw SQL over the vector tables is covered by `rocketride_sql` (same tenant database).

Embeddings come from the separate `vectorizer` binding — not in-node.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                          |
| ----------- | ----------- | ---------------------------------------------------- |
| `documents` | (none)      | Upsert document chunks into the vector table         |
| `questions` | `documents` | Keyword / semantic search, results emitted as documents |

### Fields

| Field | Type | Description |
|---|---|---|
| `collection` | string | Default "rocketride". Name of the table to store vectors |
| `score` | number | Default 0.5. Minimum similarity score for a document to be returned |
| `similarity` | string | Default "cosine". One of `cosine`, `l2`, `inner_product`. Also selects the HNSW index operator class |
| `hnsw_m` | integer | Default 16. HNSW graph degree used when the index is first created |
| `hnsw_ef_construction` | integer | Default 64. HNSW build-time candidate list size used when the index is first created |

There are intentionally no `host` / `port` / `user` / `password` / `database` fields — the connection is resolved from your signed-in RocketRide identity. The vector dimension is not configured; it is derived from the first document's embedding at write time.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
