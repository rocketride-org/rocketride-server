---
title: Astra DB
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Astra DB - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by [DataStax Astra DB](https://docs.datastax.com/en/astra/astra-db-vector/). Stores embedded documents and retrieves them by semantic (vector) or keyword (BM25) search.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field             | Required   | Description                                                                       |
| ----------------- | ---------- | --------------------------------------------------------------------------------- |
| API Endpoint      | cloud only | Astra DB Data API endpoint URL                                                    |
| Application Token | cloud only | Authentication token                                                              |
| Collection        | yes        | Collection name — alphanumeric and underscores, must start with a letter or digit |
| Similarity        | no         | Vector similarity metric: `cosine` _(default)_, `euclidean`, or `dot_product`     |

## Profiles

| Profile           | Description                                      |
| ----------------- | ------------------------------------------------ |
| Cloud _(default)_ | Astra DB cloud — requires API endpoint and token |
| Local             | Local test server at `http://localhost:8080`     |

## Search modes

Both modes are available without extra configuration — the pipeline's question type determines which runs:

- **Semantic** — vector similarity search using the question's embedding
- **Keyword** — BM25 lexical search using the question's text

## Upstream docs

- [DataStax Astra DB](https://docs.datastax.com/en/astra/astra-db-vector/)
