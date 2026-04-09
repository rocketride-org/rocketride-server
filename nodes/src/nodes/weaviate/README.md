---
title: Weaviate
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Weaviate - RocketRide Documentation</title>
</head>

## What it does

Vector store node backed by Weaviate. Stores embedded documents and retrieves them by semantic similarity search. Supports both self-hosted Weaviate and Weaviate Cloud.

**Lanes:**

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | —           | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node.

## Configuration

| Field           | Description                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Host            | Weaviate server address (e.g., `your-instance.weaviate.cloud` for cloud or `localhost` for self-hosted) |
| Port            | REST port (default `8080` for local, `443` for cloud)                                                   |
| gRPC Port       | gRPC port for local deployments (default `50051`)                                                       |
| API Key         | Weaviate Cloud API key (cloud profile only)                                                             |
| Retrieval Score | Minimum similarity threshold (default `0.5`)                                                            |
| Collection      | Collection name — must start with an uppercase letter                                                   |

## Profiles

| Profile                           | Default host                     | Port   |
| --------------------------------- | -------------------------------- | ------ |
| Weaviate cloud server _(default)_ | _(your Weaviate Cloud endpoint)_ | `443`  |
| Your own Weaviate server          | `localhost`                      | `8080` |

## Upstream docs

- [Weaviate documentation](https://weaviate.io/developers/weaviate)
