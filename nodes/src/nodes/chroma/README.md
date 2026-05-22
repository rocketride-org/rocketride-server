---
title: Chroma
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Chroma - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by [ChromaDB](https://www.trychroma.com/). Stores embedded documents and retrieves them by semantic (vector) similarity search.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field      | Required   | Description                                  |
| ---------- | ---------- | -------------------------------------------- |
| Host       | yes        | ChromaDB server address                      |
| Port       | yes        | ChromaDB server port                         |
| Collection | yes        | Collection name to store and query documents |
| API Key    | cloud only | Authentication token for ChromaDB Cloud      |

## Profiles

| Profile           | Default port | Description                                |
| ----------------- | ------------ | ------------------------------------------ |
| Local _(default)_ | `8330`       | Your own ChromaDB server                   |
| Cloud             | `443`        | ChromaDB Cloud — requires host and API key |

## Upstream docs

- [ChromaDB documentation](https://docs.trychroma.com/)
