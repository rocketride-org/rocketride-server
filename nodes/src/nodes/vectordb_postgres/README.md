---
title: PostgreSQL Vector Store
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>PostgreSQL Vector Store - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by PostgreSQL with the pgvector extension. Stores embedded documents and retrieves them by semantic similarity search. Use this when you want vector storage inside an existing PostgreSQL database rather than a dedicated vector database.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the table                     |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field             | Description                                           |
| ----------------- | ----------------------------------------------------- |
| Host              | PostgreSQL server hostname or IP                      |
| Port              | Server port (default `5432`)                          |
| User              | Database user                                         |
| Password          | Database password                                     |
| Database          | Database name (default `postgres`)                    |
| Table             | Table name for vector storage                         |
| Retrieval Score   | Minimum similarity threshold (default `0.5`)          |
| Similarity Metric | `cosine`, `l2`, or `inner_product` (default `cosine`) |

## Profiles

| Profile           | Description                   |
| ----------------- | ----------------------------- |
| Local _(default)_ | Self-hosted PostgreSQL server |

## Requirements

The pgvector extension must be installed in the target PostgreSQL database before connecting.

## Upstream docs

- [pgvector documentation](https://github.com/pgvector/pgvector)
