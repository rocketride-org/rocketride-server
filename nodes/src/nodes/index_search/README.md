# index_search

Store your documents and search them back: by keyword (BM25) or by meaning (vectors). Backed by Elasticsearch or OpenSearch.

## What it does

One node, two service variants, **Elasticsearch** and **OpenSearch**, that ingest documents and retrieve them at query time. Each variant runs in one of two modes, set by the **Store Mode** toggle:

- **Index mode**: classic BM25 full-text search over the index, with configurable match operator (`or`, `and`, `exact` phrase) and optional contextual snippet highlighting.
- **Vector store mode**: semantic similarity search over embedded documents, with a minimum retrieval score threshold.

Elasticsearch covers self-managed, Elastic Cloud Hosted, and Elastic Cloud Serverless deployments. OpenSearch covers self-managed OpenSearch.

**Lanes:**

| Lane in     | Lane out                                | Description                                                       |
| ----------- | --------------------------------------- | ---------------------------------------------------------------- |
| `documents` | -                                       | Ingest documents into the index/collection                       |
| `text`      | -                                       | Ingest raw text                                                  |
| `questions` | `text`, `documents`, `answers`, `questions` | Search and return matches as text, documents, an answer, or enrich the question for downstream nodes |

(The OpenSearch variant produces `text`, `answers`, `documents` from `questions`.) In vector store mode, run documents through an embedding node before they reach this one.

## Setup

| Variant       | Connection                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Elasticsearch | Self-managed: `localhost:9200`. Cloud Hosted / Serverless require a host URL and an **API Key**.    |
| OpenSearch    | Host URL (default `http://localhost:9200`), optional basic auth (username / password).              |

## Configuration

| Field                     | Default        | Description                                                                                  |
| ------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Deployment Type / Host    | self-managed   | Elasticsearch deployment profile, or OpenSearch host URL                                      |
| Index Name / Collection   | `rocketride`   | Name of the index / collection (lowercase)                                                    |
| Store Mode                | varies         | Toggle between index (BM25 text search) and vector store (semantic search)                     |
| Match Operator            | `or`           | How query terms are matched: `or` (any), `and` (all), `exact` (phrase). `exact` adds **Slop**  |
| Return contextual snippets| `false`        | Use the unified highlighter to return snippets around matches (configurable snippet size)      |
| Retrieval Score           | `0.5`          | Minimum similarity threshold in vector store mode (0.0–1.0)                                     |
| Embedding Dimension       | `768`          | Dimension of embedding vectors (OpenSearch vector store mode)                                  |
| API Key                   | *(empty)*      | Elastic Cloud API key (Cloud Hosted / Serverless profiles)                                     |
