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

| Property | Value |
| --- | --- |
| Class type | data |
| Capabilities | gpu |
| Protocol | `llamaparse://` |

**Data lanes**

| Input | Produces |
| --- | --- |
| `tags` | `text`, `table` |

**Profiles**

| Profile | Title | Model |
| --- | --- | --- |
| `default` |  |  |

**Configuration sections**

| Section | Fields |
| --- | --- |
| LlamaParse | `llamaparse.default` |

**Schema fields**

| Field | Type | Title / Description | Const / Default |
| --- | --- | --- | --- |
| `llamaparse.use_advanced_config` | boolean | Advanced Configuration | default `false` |
| `llamaparse.api_key` | string | API Key |  |
| `llamaparse.parse_mode` | string | Parse Mode | default `parse_page_with_lvm` |
| `llamaparse.lvm_model` | string | LVM Model | default `anthropic-sonnet-4.0` |
| `llamaparse.use_system_prompt_append` | boolean | Use Additional Instructions | default `false` |
| `llamaparse.system_prompt_append` | string | Additional Instructions |  |
| `llamaparse.spreadsheet_extract_sub_tables` | boolean | Extract Sub Tables | default `false` |
| `llamaparse.advanced_config` | string | Advanced Configuration (JSON) | default `{   "parse_mode": "parse_page_with_llm",   "spreadsheet_extract_sub_tables": false,   "system_prompt_append": "",   "lvm_model": "anthropic-sonnet-4.0" }` |

**Dependencies**

`llama-parse`, `llama-index-core`, `llama-cloud`

**Classes**

`IGlobal` — extends `IGlobalBase` (`IGlobal.py`)

| Method | Summary |
| --- | --- |
| `validateConfig(self)` | Validate LlamaParse configuration at save-time. |
| `beginGlobal(self)` |  |
| `endGlobal(self)` |  |

`IInstance` — extends `IInstanceBase` (`IInstance.py`)

| Method | Summary |
| --- | --- |
| `open(self, object: Entry)` | Call from engLib, process object startup. |
| `close(self)` | Call from engLib, process object complete. |
| `writeTag(self, tag)` | Process data tags from the tag lane. |
| `extract_tables_from_text(self, text: str)` | Extract tables from parsed text and write them to the table lane. |
| `extract_tables_from_structured_data(self, structured_data: list)` | Extract tables from structured data and write them to the table lane. |
| `writeText(self, text: str)` | Call from engLib, process text. |
| `writeTable(self, table: str)` | Call from engLib, process table data. |
| `writeDocuments(self, documents: List[Doc])` | Call from engLib, process document objects. |

`Parser` — extends `ReaderBase` (`parser.py`)

| Method | Summary |
| --- | --- |
| `__init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any])` | Initialize the LlamaParse parser with the given provider, connection configuration, and bag. |
| `read(self, file) -> str` | Read and parse document data using LlamaParse. |
| `parse(self, file_data: bytes, file_name: Optional[str]) -> dict[str, Any]` | Parse document data using LlamaParse. |

**Source**

[`nodes/src/nodes/llamaparse`](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llamaparse)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
