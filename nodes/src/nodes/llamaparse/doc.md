---
title: LlamaParse
date: 2026-04-08
sidebar_position: 1
---

## What it does

Parses documents using the LlamaIndex cloud API. Handles PDFs, images, Word, Excel, and other formats. Extracts text and tables, including Markdown tables found in structured output.

**Lanes:**

| Lane in | Lane out    | Description                                                       |
| ------- | ----------- | ----------------------------------------------------------------- |
| `data`  | `text`      | Parse document, emit extracted text                               |
| `data`  | `table`     | Parse document, emit extracted tables                             |
| `data`  | `documents` | Parse document, emit full document objects (when listener exists) |

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

| Key                              | Type    | Description                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse_mode`                     | string  | API-level parse mode passed directly to LlamaIndex. Accepted values: `parse_page_with_llm` (cost-effective text parsing), `parse_page_with_agent` (agentic/diagram-aware parsing), `parse_page_with_lvm` (legacy LVM-based parsing). Note: simple-mode aliases (`agentic`, `agentic_plus`, `cost_effective`) are not valid here — they are only mapped in simple mode. |
| `system_prompt_append`           | string  | Text appended to the parsing system prompt. In advanced mode, this is honored directly from the JSON payload regardless of simple-mode toggles. In simple mode, only applied in LVM legacy mode (`parse_page_with_lvm`) when **Use Additional Instructions** is on.                                                                                                    |
| `spreadsheet_extract_sub_tables` | boolean | Extract sub-tables embedded within spreadsheet cells. Corresponds to the **Extract Sub Tables** toggle in simple mode.                                                                                                                                                                                                                                                 |
| `vendor_multimodal_model_name`   | string  | Vision model used for LVM and agentic modes (e.g. `anthropic-sonnet-4-0`).                                                                                                                                                                                                                                                                                             |
| `page_error_tolerance`           | number  | Fraction of pages allowed to fail before the job is aborted (default `0.05` in LVM legacy mode).                                                                                                                                                                                                                                                                       |

> Advanced mode bypasses all simple-mode settings. Unknown keys will produce a warning but will not abort execution.

## Upstream docs

- [LlamaParse documentation](https://docs.cloud.llamaindex.ai/llamaparse/getting_started)

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

- **Class type** — data
- **Capabilities** — gpu
- **Protocol** — `llamaparse://`

**Data lanes**

- `tags` → `text`, `table`

**Profiles**

- `default`

**Configuration sections**

- **LlamaParse** — `llamaparse.default`

**Schema**

- **Advanced Configuration** (`llamaparse.use_advanced_config`) — `boolean`, default `false`. Check to use advanced JSON configuration instead of simple options.
- **API Key** (`llamaparse.api_key`) — `string`. Your LlamaIndex API key for LlamaParse service
- **Parse Mode** (`llamaparse.parse_mode`) — `string`, default `parse_page_with_lvm`. The parse mode to use for chosing complexity of the parse
- **LVM Model** (`llamaparse.lvm_model`) — `string`, default `anthropic-sonnet-4.0`. The LVM model to use for parsing when LVM or agentic modes are selected.
- **Use Additional Instructions** (`llamaparse.use_system_prompt_append`) — `boolean`, default `false`. Check to add custom instructions to the system prompt for LlamaParse.
- **Additional Instructions** (`llamaparse.system_prompt_append`) — `string`. Additional instructions to append to the system prompt for LlamaParse.
- **Extract Sub Tables** (`llamaparse.spreadsheet_extract_sub_tables`) — `boolean`, default `false`. Extract sub-tables from spreadsheets for better table parsing.
- **Advanced Configuration (JSON)** (`llamaparse.advanced_config`) — `string`, default `{   "parse_mode": "parse_page_with_llm",   "spreadsheet_extract_sub_tables": false,   "system_prompt_append": "",   "lvm_model": "anthropic-sonnet-4.0" }`. Enter configuration options in JSON format. For more information, see: &lt;a href='https://docs.cloud.llamaindex.ai/llamaparse/presets_and_modes/advance_parsing_modes' target='_blank'&gt;LlamaParse Documentation&lt;/a&gt;

### Dependencies

- `llama-parse`
- `llama-index-core`
- `llama-cloud`

### Classes

**`IGlobal.py` — `IGlobal(IGlobalBase)`**

- `validateConfig(self)` — Validate LlamaParse configuration at save-time.
- `beginGlobal(self)`
- `endGlobal(self)`

**`IInstance.py` — `IInstance(IInstanceBase)`**

- `open(self, object: Entry)` — Call from engLib, process object startup.
- `close(self)` — Call from engLib, process object complete.
- `writeTag(self, tag)` — Process data tags from the tag lane.
- `extract_tables_from_text(self, text: str)` — Extract tables from parsed text and write them to the table lane.
- `extract_tables_from_structured_data(self, structured_data: list)` — Extract tables from structured data and write them to the table lane.
- `writeText(self, text: str)` — Call from engLib, process text.
- `writeTable(self, table: str)` — Call from engLib, process table data.
- `writeDocuments(self, documents: List[Doc])` — Call from engLib, process document objects.

### Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> GitHub/llamaparse](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llamaparse)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
