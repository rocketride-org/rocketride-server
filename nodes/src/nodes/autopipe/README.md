---
title: Parse/Process/Embed
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Parse/Process/Embed - RocketRide Documentation</title>
</head>

:::note
This is an **internal node**. It is wired automatically by the pipeline engine — most users will not add it manually.
:::

## What it does

Meta-node that dynamically assembles a processing stack at pipeline build time based on the current operation mode. Rather than processing data itself, it inspects the task configuration and inserts the appropriate filter nodes automatically.

**Lanes:** none

## What gets inserted

| Mode                     | Filters inserted                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `INDEX`                  | vector store → indexer                                                                             |
| `INSTANCE`               | parse → _(OCR if enabled)_ → _(indexer if enabled)_ → _(preprocessor)_ → _(embedding)_ → _(store)_ |
| `TRANSFORM`              | parse → _(OCR if enabled)_ → _(preprocessor)_ → _(embedding)_ → _(store)_                          |
| `CONFIG`, `SOURCE_INDEX` | nothing                                                                                            |

## Configuration

| Field     | Description                                                            |
| --------- | ---------------------------------------------------------------------- |
| Remote    | Remote processing target                                               |
| Embedding | Embedding model to use _(default: MiniLM via `embedding_transformer`)_ |
| Store     | Vector store to write to _(default: Qdrant local)_                     |

Preprocessor defaults to LangChain with the default chunking profile.
