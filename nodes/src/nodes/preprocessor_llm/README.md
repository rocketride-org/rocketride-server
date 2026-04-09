---
title: LLM Preprocessor
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>LLM Preprocessor - RocketRide Documentation</title>
</head>

## What it does

Splits text into semantically coherent chunks using an LLM to detect context boundaries. Unlike rule-based splitters, the LLM preserves meaning across chunk boundaries. Requires an LLM connection.

**Lanes:**

| Lane in | Lane out    | Description                                                      |
| ------- | ----------- | ---------------------------------------------------------------- |
| `text`  | `documents` | Split text into semantically chunked documents                   |
| `table` | `documents` | Split table content into documents with table metadata preserved |

## Connections

| Channel | Required    | Description                                |
| ------- | ----------- | ------------------------------------------ |
| `llm`   | yes (min 1) | LLM used to analyze and chunk the document |

## Configuration

| Field                      | Description                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Number of tokens per chunk | Target chunk size — should match your embedding model's input limit (default `384`) |
