# vectorizer

Chunks incoming text and tables, embeds them, and writes the resulting documents to the configured store.

## What it does

The vectorizer is an internal (`capabilities: ["internal"]`) step in the ingestion path. As text and tables flow through, it:

1. Checks whether the current object is flagged for vectorization (`FLAGS.VECTORIZE`).
2. Splits the text into chunks using the configured preprocessor.
3. Builds per-chunk document metadata (chunk id, table id, permission id, etc.).
4. Computes embeddings for the chunks via the embedding component.
5. Persists the chunks — either directly to the store (instance mode) or by writing them downstream to the endpoint store driver (transform mode).

On retrieval (`renderObject`), it pulls previously vectorized content back out of the store and feeds it to the text writer.

**Lanes:** none. `lanes` is empty (`{}`), `classType` is empty, and there are no user-facing config fields — the engine wires this one up for you rather than you placing it by hand.

## Setup

Nothing to configure. No profiles, no config fields, no credentials; it leans on the embedding and store components set up elsewhere in the pipeline.
