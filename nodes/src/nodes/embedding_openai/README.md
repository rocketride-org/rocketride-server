---
title: OpenAI Embedding
date: 2026-04-08
sidebar_position: 1
---

## What it does

Generates text embeddings using OpenAI's embedding API. Requires an OpenAI API key.

**Lanes:**

| Lane in     | Lane out    | Description                                         |
| ----------- | ----------- | --------------------------------------------------- |
| `documents` | `documents` | Embed document text, attach vector to each document |

Output documents have an `embedding` vector attached, ready for ingestion into a vector store.

## Configuration

| Field   | Description                          |
| ------- | ------------------------------------ |
| Model   | Embedding model (see profiles below) |
| API Key | OpenAI API key                       |

## Profiles

| Profile                | Model                    | Context                     |
| ---------------------- | ------------------------ | --------------------------- |
| Text Small _(default)_ | `text-embedding-3-small` | Efficient, good performance |
| Text Large             | `text-embedding-3-large` | Higher accuracy             |
| Text Ada               | `text-embedding-ada-002` | Legacy model                |

All models support up to 8,191 tokens per input.

## Upstream docs

- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
