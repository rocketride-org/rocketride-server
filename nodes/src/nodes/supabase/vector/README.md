# vector

The Supabase Vector service of the `supabase` node: a vector store in a Supabase project's Postgres database, using the pgvector extension. Pick it when your pipeline's embeddings should live next to your app data in Supabase.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Its Postgres includes pgvector, an extension that stores embeddings in a `vector` column and finds the nearest ones by cosine, Euclidean or inner-product distance.

## What it does

This is the PostgreSQL vector store (`store_postgres`) on a Supabase project: the same table layout, inserts, keyword and semantic search and listing. In a pipeline it stores embedded chunks that arrive on the `documents` lane and answers questions with the closest chunks. As an agent tool it offers the same functions as `store_postgres`. Two things differ: it connects to the project's pooler with the shared pooler fields and always requires TLS, and its **Access level** decides what the agent may change: adding and replacing documents at `write`, deleting, soft deleting and restoring at `admin`.

## Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `documents` | — | Store embedded document chunks. |
| `questions` | `documents` | Return matching documents. |
| `questions` | `answers` | Return matching documents as answers. |
| `questions` | `questions` | Enrich questions with matching documents. |

## As a tool

The functions are `store_postgres`'s; an agent sees them as `<component-id>.<function>`, and refusal messages name them `supabase_vector.<function>`.

| Function | Description |
|---|---|
| `search` | Search for a non-empty `query`, with optional `top_k` and metadata `filter`; returns matching content, metadata and scores. Needs `read`. |
| `get` | Up to `limit` chunks (default and cap 100) of one document by `object_id`, with `total`, `has_more` and `truncated`. Needs `read`. |
| `objdir` | Distinct parent paths, each with one object ID; optional `parent`, `offset`, `limit` (default and cap 1000). Needs `read`. |
| `list_documents` | Documents one by one with `object_id`, `parent`, `chunk_count`; optional `parent`, `deleted`, `offset`, `limit` (default 100, cap 1000). Needs `read`. |
| `stats` | Row count, active document count, embedding model name and vector size. Needs `read`. |
| `upsert` | Add or replace a non-empty `documents` array (content and object ID each; embedding optional when an embedder is bound). Needs `write`. |
| `delete` | Delete the chunks of a non-empty `object_ids` array for good. Needs `admin`. |
| `soft_delete` | Move the documents of `object_ids` to the trash, keeping their chunks. Needs `admin`. |
| `restore` | Take the documents of `object_ids` out of the trash. Needs `admin`. |

A function above the node's level is not offered to the agent at all, and a direct call returns `success: false` with a message naming the level to set. At `write`, `get` on a soft-deleted document still says to restore it, although `restore` needs `admin` (that message is `store_postgres`'s). Failures come back as `{"success": false, "error": ...}`, the shape every vector store tool uses.

## Configuration

Paste the **Session pooler** details from the dashboard's Connect panel, pick a table name, and leave the score and metric at their defaults unless your embedding model needs another metric.

### Pooler host

`aws-0-<region>.pooler.supabase.com`, optionally with `:port` (5432 when none is given). The connection always uses TLS (`sslmode=require`) and SCRAM password authentication (`require_auth=scram-sha-256`), so the password is never sent in clear text, even to a server that pretends to be the pooler. The server certificate is not checked against a CA (`verify-full` is not used). The direct host `db.<project-ref>.supabase.co` is IPv6-only.

### Database user

For the pooler it must include the project ref: `postgres.<project-ref>`.

### Table

The table that holds the vectors, created on the first write when it does not exist. It must be a plain PostgreSQL name (a letter or `_` first, then letters, digits or `_`, at most 63 characters); anything else stops start-up.

### Access level

`read` (default): only the read functions. `write`: also `upsert`. `upsert` replaces a stored document whose object ID it names (a batch holding chunk 0 deletes all of that document's stored chunks first, `store_postgres`'s rule), so `write` can overwrite the content of any stored document. `admin`: also `delete`, `soft_delete` and `restore`; `admin` is needed only for those three. Chunks arriving on the `documents` lane are stored at every level: that is pipeline wiring, not an agent call.

## Authentication

The database password is in the Supabase dashboard under Project Settings -> Database. This service does not use the project's API keys.

## Notes

### Turning on pgvector

The `vector` extension must be on (Database -> Extensions -> vector). Saving the node checks it and says so when it is missing.

### Why not store_postgres directly

`store_postgres` has separate host and port fields and connects without an `sslmode`. Supabase Vector reuses its store and only replaces the constructor and the save-time check, so it can split `host:port` and require TLS; `store_postgres` itself is unchanged.

## Upstream docs

- [pgvector on Supabase](https://supabase.com/docs/guides/database/extensions/pgvector)
- [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
