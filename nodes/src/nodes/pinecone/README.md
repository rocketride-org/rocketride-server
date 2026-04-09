---
title: Pinecone
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Pinecone - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by Pinecone. Stores embedded documents and retrieves them by semantic (vector) similarity search.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the index                     |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field           | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| API Key         | Pinecone API key                                                        |
| Retrieval Score | Minimum similarity threshold: Related, Highly Related, or Most Relevant |
| Collection      | Index name (lowercase, alphanumeric, hyphens)                           |

## Profiles

| Profile                                     | Description           |
| ------------------------------------------- | --------------------- |
| Pinecone Serverless Dense Index _(default)_ | Serverless deployment |
| Pinecone Pod-Based Index                    | Pod-based deployment  |

## Upstream docs

- [Pinecone documentation](https://docs.pinecone.io/)
