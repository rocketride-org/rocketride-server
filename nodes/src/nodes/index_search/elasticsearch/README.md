---
title: Elasticsearch
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Elasticsearch - RocketRide Documentation</title>
</head>

## What it does

Elasticsearch node with two modes: **Index** (BM25 full-text search) and **Vector Store** (semantic/kNN search). Switch between modes with the Store Mode toggle — no pipeline rewiring needed.

**Lanes:**

| Lane in     | Lane out    | Description                                                  |
| ----------- | ----------- | ------------------------------------------------------------ |
| `text`      | —           | Ingest raw text (index mode only)                            |
| `documents` | —           | Ingest pre-embedded documents (vector store mode only)       |
| `questions` | `text`      | Search and return matching text                              |
| `questions` | `documents` | Search and return matching documents                         |
| `questions` | `answers`   | Search and return matching documents as answers              |
| `questions` | `questions` | Enrich question with matching documents for downstream nodes |

Documents must be run through an embedding node before reaching this node (vector store mode only).

## Profiles

| Profile                  | Default port | Description                                   |
| ------------------------ | ------------ | --------------------------------------------- |
| Self-managed _(default)_ | `9200`       | Your own Elasticsearch instance               |
| Elastic Cloud Hosted     | `9243`       | Hosted deployment — requires host and API key |
| Elastic Cloud Serverless | `443`        | Serverless — requires host and API key        |

## Configuration

| Field      | Required   | Description                                             |
| ---------- | ---------- | ------------------------------------------------------- |
| Host       | yes        | Elasticsearch server address                            |
| Port       | yes        | Elasticsearch server port                               |
| API Key    | cloud only | Authentication token                                    |
| Index Name | yes        | Elasticsearch index (lowercase, max 255 chars)          |
| Store Mode | yes        | `Index` (BM25 text search) or `Vector Store` (semantic) |

## Index mode — search options

| Field                      | Default | Description                                                |
| -------------------------- | ------- | ---------------------------------------------------------- |
| Match Operator             | `or`    | `or` — any term, `and` — all terms, `exact` — phrase match |
| Slop                       | `0`     | Words allowed between terms in exact phrase match          |
| Return contextual snippets | off     | Highlight matching passages in results                     |
| Snippet size               | `250`   | Max characters per highlight snippet                       |

## Upstream docs

- [Elasticsearch documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html)
- [Elastic Cloud](https://www.elastic.co/cloud)
