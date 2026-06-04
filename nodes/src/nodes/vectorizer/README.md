# vectorizer

Internal node that chunks incoming text and tables, computes embeddings, and writes the resulting documents to the configured store.

## What it does

The vectorizer is an internal (`capabilities: ["internal"]`) processing node in the ingestion path. As text and tables flow through it, it:

1. Checks whether the current object is flagged for vectorization (`FLAGS.VECTORIZE`).
2. Splits the text into chunks using the configured preprocessor.
3. Builds per-chunk document metadata (chunk id, table id, permission id, etc.).
4. Computes embeddings for the chunks via the embedding component.
5. Persists the chunks — either directly to the store (instance mode) or by writing them downstream to the endpoint store driver (transform mode).

On retrieval (`renderObject`), it reads previously vectorized content back out of the store and feeds it to the text writer.

**Lanes:** none. `lanes` is empty (`{}`), `classType` is empty, and the node has no user-facing configuration fields — it is wired internally by the engine rather than placed manually in a pipeline.

## Setup

No configuration. This node has no profiles, no config fields, and no external credentials; it relies on the embedding and store components configured elsewhere in the pipeline.
