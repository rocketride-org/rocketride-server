---
title: Reducto
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Reducto - RocketRide Documentation</title>
</head>

## What it does

Parses documents using the Reducto cloud API, extracting clean Markdown text and structured tables. Handles PDFs, images, scanned documents, and mixed-content files.

**Lanes:**

| Lane in | Lane out | Description                               |
| ------- | -------- | ----------------------------------------- |
| `data`  | `text`   | Extracted text as Markdown                |
| `data`  | `table`  | Extracted tables in Markdown table format |

## Configuration

| Field   | Description                        |
| ------- | ---------------------------------- |
| API Key | Reducto API key                    |
| Mode    | `Simple` or `Advanced` (see below) |

### Simple mode

| Field                       | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| Contains Handwritten Text   | Enables Agentic OCR for better handwriting recognition          |
| Contains Non-English Text   | Enables multilingual OCR for non-Germanic languages and Unicode |
| AI Summarize Figures/Images | Generate AI summaries for figures, diagrams, and images         |

### Advanced mode

Exposes the full Reducto API. Enter Python dictionaries into the **Options**, **Advanced Options**, and **Experimental Options** fields. Simple mode settings are ignored when Advanced mode is on.

See the [Reducto parsing configurations documentation](https://docs.reducto.ai/v/legacy/parsing/default-configurations) for available parameters and formatting examples.

## Upstream docs

- [Reducto documentation](https://docs.reducto.ai/overview)
