---
title: MongoDB Atlas
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>MongoDB Atlas - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by [MongoDB Atlas](https://www.mongodb.com/products/platform/atlas-vector-search). Stores embedded documents and retrieves them by semantic (vector) or keyword (text) search using Atlas Vector Search indexes.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field      | Required | Default         | Description                                        |
| ---------- | -------- | --------------- | -------------------------------------------------- |
| Host       | yes      | —               | MongoDB Atlas connection URI (`mongodb+srv://...`) |
| API Key    | yes      | —               | Atlas API key                                      |
| Database   | yes      | `rocketride_db` | Database name                                      |
| Collection | yes      | —               | Collection name                                    |
| Score      | no       | `0.5`           | Minimum similarity score threshold                 |
| Similarity | no       | `cosine`        | `cosine`, `euclidean`, or `dotproduct`             |

## Requirements

Requires a MongoDB Atlas **M10+** cluster or **serverless** instance — vector search indexes are not available on free-tier (M0) clusters. Vector and text search indexes are created automatically on first use.

## Search modes

- **Semantic** — Atlas Vector Search using the question's embedding (`$vectorSearch` aggregation)
- **Keyword** — MongoDB full-text search using the question's text (`$text`)

## Upstream docs

- [MongoDB Atlas Vector Search](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/)
