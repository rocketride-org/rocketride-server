---
title: LlamaParse
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>LlamaParse - RocketRide Documentation</title>
</head>

## What it does

Parses documents using the LlamaIndex cloud API. Handles PDFs, images, Word, Excel, and other formats. Extracts text and tables, including Markdown tables found in structured output.

**Lanes:**

| Lane in | Lane out | Description                           |
| ------- | -------- | ------------------------------------- |
| `tags`  | `text`   | Parse document, emit extracted text   |
| `tags`  | `table`  | Parse document, emit extracted tables |

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

## Advanced configuration (JSON mode)

When **Advanced Configuration** is enabled, supply a raw JSON object instead of the simple options. The following parameters are supported:

| Key                              | Type    | Description                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse_mode`                     | string  | LlamaParse parse mode passed directly to the API. Accepted values: `parse_page_with_llm` (cost-effective text parsing), `parse_page_with_agent` (agentic/agentic-plus diagram-aware parsing), `parse_page_with_lvm` (legacy LVM-based parsing), `agentic`, `agentic_plus`, `cost_effective` |
| `system_prompt_append`           | string  | Text appended to the parsing system prompt. Only applied in LVM legacy mode (`parse_page_with_lvm`) when the **Use Additional Instructions** toggle is on in simple mode.                                                                                                                   |
| `spreadsheet_extract_sub_tables` | boolean | Extract sub-tables embedded within spreadsheet cells. Corresponds to the **Extract Sub Tables** toggle in simple mode.                                                                                                                                                                      |
| `vendor_multimodal_model_name`   | string  | Vision model used for LVM and agentic modes (e.g. `anthropic-sonnet-4-0`).                                                                                                                                                                                                                  |
| `page_error_tolerance`           | number  | Fraction of pages allowed to fail before the job is aborted (default `0.05` in LVM legacy mode).                                                                                                                                                                                            |

> Advanced mode bypasses all simple-mode settings. Unknown keys will produce a warning but will not abort execution.

## Upstream docs

- [LlamaParse documentation](https://docs.cloud.llamaindex.ai/llamaparse/getting_started)
