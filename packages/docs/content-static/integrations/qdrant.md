---
title: Qdrant
sidebar_position: 6
---

# Qdrant

Qdrant is a vector database for storing and querying embeddings. In RocketRide
it acts as both the retrieval backbone for RAG pipelines and as an agent tool
for semantic search, upserts, and deletions.

## When to use Qdrant

- **RAG** — embed documents, store vectors, retrieve relevant chunks at query
  time.
- **Semantic search** — find the most relevant items across a large corpus based
  on meaning rather than keywords.
- **Hybrid search** — Qdrant supports combining vector similarity with
  full-text keyword scoring in a single query.
- **Agent memory** — an agent can call the Qdrant tools directly to search or
  update the store as part of a reasoning loop.

## Configuration

### Profiles

The `qdrant` node ships with two built-in profiles:

| Profile | Use when |
| --- | --- |
| `cloud` (default) | Qdrant Cloud (`*.qdrant.io`) |
| `self-hosted` | Local Docker or on-premises |

```json
{
  "id": "store_1",
  "provider": "qdrant",
  "config": {
    "profile": "self-hosted",
    "serverName": "localhost",
    "collection": "my-docs"
  }
}
```

For Qdrant Cloud, set `serverName` to your cluster hostname and provide an API
key via the `apikey` field.

### Collection management

The node creates the collection automatically if it does not exist. Vector
dimensions are inferred from the first batch of embeddings — make sure the
embedding model you use in the pipeline is consistent across all runs against
the same collection. Mixing `text-embedding-3-small` and `text-embedding-3-large`
in the same collection will fail because the dimensions differ.

### Validation

On pipeline startup, the node validates the `collection` name (alphanumeric and
hyphens only), the port number, and connectivity. A failed validation prevents
the pipeline from starting.

## Wiring: document ingestion + retrieval

The `qdrant` node has two input roles depending on the lane:

- **`documents` lane** — receives embedded chunks from an embedding node and
  upserts them into the collection.
- **`questions` lane** — receives a query, runs a similarity search, and emits
  the top-K results back as `questions` with context injected (for an LLM to
  consume) or as `documents` (for downstream nodes).

A single `qdrant` node can handle both at the same time:

```json
{
  "id": "store_1",
  "provider": "qdrant",
  "config": { "profile": "self-hosted", "serverName": "localhost", "collection": "docs" },
  "input": [
    { "lane": "documents", "from": "embed_1" },
    { "lane": "questions", "from": "source_1" }
  ]
}
```

New documents are upserted as they arrive. Questions trigger a retrieval
immediately, using whichever vectors are already in the collection.

## Agent tools

When connected to an agent via a control connection, the `qdrant` node exposes
three tools. Tool names are namespaced by the node's `serverName` config (default
`qdrant`), so they appear to the agent as `qdrant.search` etc. Change `serverName`
when running multiple Qdrant nodes in one pipeline so their tool names do not
collide.

| Tool | What it does |
| --- | --- |
| `qdrant.search` | Semantic similarity search over the collection. Returns the top-K chunks with scores and metadata. |
| `qdrant.upsert` | Insert or update a document by ID. The agent provides the text; the node embeds and stores it. |
| `qdrant.delete` | Remove a document from the collection by ID. |

The agent calls these tools in its reasoning loop — useful when the agent needs
to both answer questions and update the knowledge base during the same session.

## Full RAG pipeline example

See the [RAG Pipeline example](/examples/rag-pipeline) for a complete,
annotated `.pipe` file.

## Related

- [`qdrant` node reference](/nodes/qdrant)
- [RAG Pipeline example](/examples/rag-pipeline)
- [Anthropic integration](/integrations/anthropic) — pairing with Anthropic Claude models
- [Concepts: Performance](/concepts/performance) — batching and chunk size tuning
