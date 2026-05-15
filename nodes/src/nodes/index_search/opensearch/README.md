---
title: OpenSearch
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>OpenSearch - RocketRide Documentation</title>
</head>

## What it does

OpenSearch node with two modes: **Index** (BM25 full-text search) and **Vector Store** (kNN semantic search). Switch between modes with the Store Mode toggle — no pipeline rewiring needed.

**Lanes:**

| Lane in     | Lane out    | Description                                            |
| ----------- | ----------- | ------------------------------------------------------ |
| `text`      | —           | Ingest raw text (index mode only)                      |
| `documents` | —           | Ingest pre-embedded documents (vector store mode only) |
| `questions` | `text`      | Search and return matching text                        |
| `questions` | `documents` | Search and return matching documents                   |
| `questions` | `answers`   | Search and return matching documents as answers        |

Documents must be run through an embedding node before reaching this node (vector store mode only).

## Configuration

| Field               | Required    | Description                                                       |
| ------------------- | ----------- | ----------------------------------------------------------------- |
| Host                | yes         | OpenSearch server URL (e.g. `http://localhost:9200`)              |
| Collection          | yes         | Index name (lowercase, max 255 chars)                             |
| Use basic auth      | no          | Enable username/password authentication                           |
| Username            | auth only   | Basic auth username (default `admin`)                             |
| Password            | auth only   | Basic auth password                                               |
| Store Mode          | yes         | `Index` (BM25 text search) or `Vector Store` (kNN)                |
| Embedding Dimension | vector only | Must match the dimension of your embedding model                  |
| Retrieval Score     | vector only | Minimum similarity score to include a result (0–1, default `0.5`) |

## Index mode — search options

| Field                      | Default | Description                                                |
| -------------------------- | ------- | ---------------------------------------------------------- |
| Match Operator             | `or`    | `or` — any term, `and` — all terms, `exact` — phrase match |
| Slop                       | `0`     | Words allowed between terms in exact phrase match          |
| Return contextual snippets | off     | Highlight matching passages in results                     |
| Snippet size               | `250`   | Max characters per highlight snippet                       |

## Upstream docs

- [OpenSearch documentation](https://opensearch.org/docs/latest/)
