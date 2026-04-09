---
title: LlamaParse
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>LlamaParse - RocketRide Documentation</title>
</head>

## What it does

Parses documents using the LlamaIndex cloud API. Handles PDFs, images, Word, Excel, and other formats. Extracts text and tables, including markdown tables found in structured output.

**Lanes:**

| Lane in | Lane out | Description                           |
| ------- | -------- | ------------------------------------- |
| `data`  | `text`   | Parse document, emit extracted text   |
| `data`  | `table`  | Parse document, emit extracted tables |

Requires a LlamaIndex API key. Processing happens in the cloud.

## Configuration

| Field                  | Required | Description                                                |
| ---------------------- | -------- | ---------------------------------------------------------- |
| API Key                | yes      | LlamaIndex cloud API key                                   |
| Advanced Configuration | no       | Toggle to supply raw JSON config instead of simple options |

**Simple mode options:**

| Field                       | Default                   | Description                                             |
| --------------------------- | ------------------------- | ------------------------------------------------------- |
| Parse Mode                  | `Parse with LVM (Legacy)` | See parse modes below                                   |
| LVM Model                   | `Anthropic Sonnet 4.0`    | Vision model used for LVM and agentic modes             |
| Use Additional Instructions | off                       | Append custom instructions to the parsing system prompt |
| Extract Sub Tables          | off                       | Extract sub-tables from spreadsheets                    |

## Parse modes

| Mode                      | Credits/page | Best for                              |
| ------------------------- | ------------ | ------------------------------------- |
| Cost-effective            | 3            | Text-heavy documents without diagrams |
| Agentic                   | 10           | Documents with diagrams and images    |
| Agentic Plus              | 90           | Complex layouts and multi-page tables |
| Parse with LVM _(legacy)_ | —            | Legacy LVM-based parsing              |

## LVM models

Available when using LVM legacy, Agentic, or Agentic Plus modes:

| Model                            | Notes |
| -------------------------------- | ----- |
| Anthropic Sonnet 4.0 _(default)_ |       |
| Anthropic Sonnet 3.5             |       |
| GPT-4o                           |       |
| GPT-4o Mini                      |       |

## Upstream docs

- [LlamaParse documentation](https://docs.cloud.llamaindex.ai/llamaparse/getting_started)
