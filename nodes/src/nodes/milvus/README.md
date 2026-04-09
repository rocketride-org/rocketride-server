---
title: Milvus
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Milvus - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by Milvus. Stores embedded documents and retrieves them by semantic (vector) similarity search. Supports both self-hosted Milvus and Zilliz Cloud.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field           | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| Host            | Milvus server address (cloud: `<instance>.<region>.zillizcloud.com`)    |
| Port            | Server port                                                             |
| API Key         | Zilliz Cloud API key (cloud profile only)                               |
| Retrieval Score | Minimum similarity threshold: Related, Highly Related, or Most Relevant |
| Collection      | Collection name to store and query documents                            |

## Profiles

| Profile                         | Default host             | Default port |
| ------------------------------- | ------------------------ | ------------ |
| Milvus cloud server _(default)_ | _(your Zilliz endpoint)_ | `443`        |
| Your own Milvus server          | `localhost`              | `19530`      |

## Upstream docs

- [Milvus documentation](https://milvus.io/docs)
- [Zilliz Cloud](https://zilliz.com/)
