---
title: Qdrant
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Qdrant - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by Qdrant. Stores embedded documents and retrieves them by semantic (vector) similarity search. Supports both self-hosted Qdrant and Qdrant Cloud.

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
| Host            | Qdrant server address (cloud: `<instance>.<region>.qdrant.io`)          |
| Port            | Server port (default `6333`)                                            |
| API Key         | Qdrant Cloud API key (cloud profile only)                               |
| Retrieval Score | Minimum similarity threshold: Related, Highly Related, or Most Relevant |
| Collection      | Collection name to store and query documents                            |

## Profiles

| Profile                         | Default host                   | Port   |
| ------------------------------- | ------------------------------ | ------ |
| Qdrant cloud server _(default)_ | _(your Qdrant Cloud endpoint)_ | `6333` |
| Your own Qdrant server          | `localhost`                    | `6333` |

## Upstream docs

- [Qdrant documentation](https://qdrant.tech/documentation/)
