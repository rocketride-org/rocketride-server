---
title: Image Embedding
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Image Embedding - RocketRide Documentation</title>
</head>

## What it does

Generates vector embeddings from images using local vision models. Runs on the model server — no API key required. GPU-accelerated when available.

**Lanes:**

| Lane in     | Lane out    | Description                              |
| ----------- | ----------- | ---------------------------------------- |
| `documents` | `documents` | Embed images carried in document objects |
| `image`     | `documents` | Embed raw image data                     |

Output documents have an `embedding` vector attached, ready for ingestion into a vector store.

## Configuration

| Field | Description                                 |
| ----- | ------------------------------------------- |
| Model | Embedding model to use (see profiles below) |

## Profiles

| Profile                  | Model                          | Notes                                 |
| ------------------------ | ------------------------------ | ------------------------------------- |
| OpenAI 16×16 _(default)_ | `openai/clip-vit-base-patch16` | Good performance, lower memory        |
| OpenAI 32×32             | `openai/clip-vit-base-patch32` | Lower performance, better recognition |
| Google 16×16             | `google/vit-base-patch16-224`  | Fast, accurate, general-purpose       |
| Custom                   | _(user-specified)_             | Any Hugging Face vision model         |
