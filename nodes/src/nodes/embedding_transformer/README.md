---
title: Transformer Embedding
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Transformer Embedding - RocketRide Documentation</title>
</head>

## What it does

Generates text embeddings using local sentence-transformer models. Runs on the model server — no API key required. GPU-accelerated when available.

**Lanes:**

| Lane in     | Lane out    | Description                                           |
| ----------- | ----------- | ----------------------------------------------------- |
| `documents` | `documents` | Embed document chunks, attach vector to each document |
| `questions` | `questions` | Embed a question for vector similarity lookup         |

The `questions` lane is used when querying a vector store — the store expects an embedded question to compare against stored document vectors.

## Configuration

| Field | Description                          |
| ----- | ------------------------------------ |
| Model | Embedding model (see profiles below) |

**Custom model options** (shown when Custom is selected):

| Field               | Description                                       |
| ------------------- | ------------------------------------------------- |
| Model name          | Any Hugging Face sentence-transformer model       |
| Truncate dimensions | Reduce embedding size (0 = model default)         |
| Document prefix     | Prefix prepended to document text before encoding |
| Query prefix        | Prefix prepended to query text before encoding    |

## Profiles

| Profile            | Model                                              | Notes                         |
| ------------------ | -------------------------------------------------- | ----------------------------- |
| miniLM _(default)_ | `sentence-transformers/multi-qa-MiniLM-L6-cos-v1`  | General use, good performance |
| miniAll            | `sentence-transformers/all-MiniLM-L6-v2`           | General use alternative       |
| mpnet              | `sentence-transformers/multi-qa-mpnet-base-cos-v1` | Higher quality                |
| Custom             | _(user-specified)_                                 | Any Hugging Face model        |
