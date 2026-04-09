---
title: Summarization
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Summarization - RocketRide Documentation</title>
</head>

## What it does

Splits incoming text into chunks and uses an LLM to extract a summary, key points, and named entities from each chunk. Outputs results as plain text or structured documents.

**Lanes:**

| Lane in | Lane out    | Description                               |
| ------- | ----------- | ----------------------------------------- |
| `text`  | `text`      | Summarized output as plain text           |
| `text`  | `documents` | Summarized output as structured documents |

## Connections

| Channel | Required    | Description                                              |
| ------- | ----------- | -------------------------------------------------------- |
| `llm`   | yes (min 1) | LLM used to generate summaries, key points, and entities |

## Configuration

| Field                         | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| Number of chunks to summarize | How many chunks to process after the document is split (default: 2) |
| Words per summary             | Word limit per summary — set to `0` to disable (default: 1500)      |
| Words per key point           | Word limit per key point — set to `0` to disable (default: 250)     |
| Entities to extract           | Max named entities to extract — set to `0` to disable (default: 25) |
