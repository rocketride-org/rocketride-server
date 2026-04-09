---
title: Exa Search
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Exa Search - RocketRide Documentation</title>
</head>

## What it does

Performs web search using the Exa API. Accepts a question and returns semantic or keyword search results, with optional highlighted excerpts from matching pages.

**Lanes:**

| Lane in     | Lane out  | Description                  |
| ----------- | --------- | ---------------------------- |
| `questions` | `answers` | Search results as answers    |
| `questions` | `text`    | Search results as plain text |

## Configuration

| Field              | Description                                           |
| ------------------ | ----------------------------------------------------- |
| API Key            | Exa API key                                           |
| Search Type        | `Auto`, `Keyword`, or `Neural` (default: Auto)        |
| Number of Results  | How many results to return (1–20, default: 5)         |
| Include Highlights | Return highlighted excerpts from matching pages       |
| Highlight Length   | Max characters per highlight (100–4000, default: 600) |

## Upstream docs

- [Exa documentation](https://docs.exa.ai)
