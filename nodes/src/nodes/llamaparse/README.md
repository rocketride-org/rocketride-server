# llamaparse

A RocketRide data node that parses documents with the LlamaParse cloud service and emits the extracted text and tables into the pipeline.

## What it does

Sends incoming documents to the LlamaIndex / LlamaParse cloud API (via the `llama-parse` Python library) and emits the results. Handles PDFs, images, Word documents, Excel spreadsheets, and other formats, with table extraction, layout preservation, and Markdown output. Processing happens in the cloud: a LlamaIndex API key is required, and the run aborts at startup if none is configured.

Tables are extracted two ways: Markdown table patterns (`|`-delimited rows) are detected in the parsed text, and structured items of type `table` returned by the API are converted to Markdown. Both are written to the `table` lane.

A single shared parser instance is guarded by a lock, so documents are parsed one at a time per node. If parsing returns no text, a fallback Markdown notice (file type, size, and a hint that the document may be empty or OCR failed) is written to the `text` lane; on a parsing error, a Markdown error report is written instead, so downstream nodes always receive something.

---

## Configuration

### Lanes

| Lane in | Lane out    | Description                                                       |
| ------- | ----------- | ----------------------------------------------------------------- |
| `data`  | `text`      | Parse document, emit extracted text                               |
| `data`  | `table`     | Parse document, emit extracted tables (Markdown)                  |
| `data`  | `documents` | Parse document, emit full document objects (when listener exists) |

Incoming document objects of type `Document`, `PDF`, or `Image` (base64 `page_content`) are also accepted on the documents lane; the node parses them, re-emits them as `Document` objects containing the parsed text, and suppresses the default pass-through of the original files.

When no file name accompanies the raw bytes, the file type is detected from magic numbers (PDF, DOCX/XLSX, DOC/XLS, JPEG, PNG, GIF, WebP, HTML, XML) and defaults to PDF if unrecognized.

### Fields

| Field | Type | Description |
|---|---|---|
| `use_advanced_config` | boolean | Default false. Check to use advanced JSON configuration instead of simple options. |
| `api_key` | string | Your LlamaIndex API key for LlamaParse service |
| `parse_mode` | string | Default "parse_page_with_lvm". The parse mode to use for chosing complexity of the parse |
| `lvm_model` | string | Default "anthropic-sonnet-4.0". The LVM model to use for parsing when LVM or agentic modes are selected. |
| `use_system_prompt_append` | boolean | Default false. Check to add custom instructions to the system prompt for LlamaParse. |
| `system_prompt_append` | string | Additional instructions to append to the system prompt for LlamaParse. |
| `spreadsheet_extract_sub_tables` | boolean | Default false. Extract sub-tables from spreadsheets for better table parsing. |
| `advanced_config` | string | Default "{
  "parse_mode": "parse_page_with_llm",
  "spreadsheet_extract_sub_tables": false,
  "system_prompt_append": "",
  "lvm_model": "anthropic-sonnet-4.0"
}". Enter configuration options in JSON format. For more information, see: <a href='https://docs.cloud.llamaindex.ai/llamaparse/presets_and_modes/advance_parsing_modes' target='_blank'>LlamaParse Documentation</a> |

  "parse_mode": "parse_page_with_llm",
  "spreadsheet_extract_sub_tables": false,
  "system_prompt_append": "",
  "lvm_model": "anthropic-sonnet-4.0"
}". Enter configuration options in JSON format. For more information, see: <a href='https://docs.cloud.llamaindex.ai/llamaparse/presets_and_modes/advance_parsing_modes' target='_blank'>LlamaParse Documentation</a> |

**Simple mode options** (shown when `use_advanced_config` is off):

| Field                            | Type / default                         | Description                                                |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `parse_mode`                     | string, default `parse_page_with_lvm`  | Parse mode, see parse modes below                          |
| `lvm_model`                      | string, default `anthropic-sonnet-4.0` | Vision model used for LVM and agentic modes                |
| `use_system_prompt_append`       | boolean, default `false`               | Append custom instructions to the parsing system prompt    |
| `system_prompt_append`           | string (textarea)                      | The additional instructions (shown when the toggle is on)  |
| `spreadsheet_extract_sub_tables` | boolean, default `false`               | Extract sub-tables from spreadsheets                       |

**Advanced mode option** (shown when `use_advanced_config` is on):

| Field             | Type / default | Description                                              |
| ----------------- | -------------- | -------------------------------------------------------- |
| `advanced_config` | string (JSON)  | Raw JSON passed to the LlamaParse constructor, see below |

Configuration is validated at save time: invalid JSON in the advanced config, unknown advanced parameters, and a missing API key all produce warnings. At pipeline start, a missing API key, invalid advanced JSON, or an enabled-but-empty advanced config aborts the run with an error before any documents are sent.

---

## Parse modes

| Mode                      | Credits/page | Best for                              |
| ------------------------- | ------------ | ------------------------------------- |
| Cost-effective            | 3            | Text-heavy documents without diagrams |
| Agentic                   | 10           | Documents with diagrams and images    |
| Agentic Plus              | 90           | Complex layouts and multi-page tables |
| Parse with LVM (legacy)   | n/a          | Legacy LVM-based parsing              |

Simple-mode selections map onto LlamaParse API modes:

- **Cost-effective**: `parse_page_with_llm`
- **Agentic** and **Agentic Plus**: `parse_page_with_agent`, with the selected LVM model as `vendor_multimodal_model_name`
- **Parse with LVM (legacy)**: `parse_page_with_lvm`, with the selected LVM model, any additional instructions (`system_prompt_append`, only applied in this mode when **Use Additional Instructions** is on), and `page_error_tolerance` fixed at `0.05`

---

## LVM models

Available when using LVM legacy, Agentic, or Agentic Plus modes:

| Model                            | Value                  |
| -------------------------------- | ---------------------- |
| Anthropic Sonnet 4.0 (default)   | `anthropic-sonnet-4.0` |
| Anthropic Sonnet 3.5             | `anthropic-sonnet-3.5` |
| GPT-4o                           | `gpt-4o`               |
| GPT-4o Mini                      | `gpt-4o-mini`          |

---

## Advanced configuration (JSON mode)

When **Advanced Configuration** is enabled, supply a raw JSON object instead of the simple options. The keys are merged directly into the LlamaParse constructor arguments (any `api_key` key in the JSON is ignored; the API key field always wins). Recognized parameters:

| Key                              | Type    | Description |
| -------------------------------- | ------- | ----------- |
| `parse_mode`                     | string  | API-level parse mode passed directly to LlamaIndex. Accepted values: `parse_page_with_llm` (cost-effective text parsing), `parse_page_with_agent` (agentic/diagram-aware parsing), `parse_page_with_lvm` (legacy LVM-based parsing). Note: simple-mode aliases (`agentic`, `agentic_plus`, `cost_effective`) are not valid here; they are only mapped in simple mode. |
| `system_prompt_append`           | string  | Text appended to the parsing system prompt. In advanced mode, this is honored directly from the JSON payload regardless of simple-mode toggles. In simple mode, only applied in LVM legacy mode (`parse_page_with_lvm`) when **Use Additional Instructions** is on. |
| `spreadsheet_extract_sub_tables` | boolean | Extract sub-tables embedded within spreadsheet cells. Corresponds to the **Extract Sub Tables** toggle in simple mode. |
| `vendor_multimodal_model_name`   | string  | Vision model used for LVM and agentic modes (e.g. `anthropic-sonnet-4.0`). |
| `page_error_tolerance`           | number  | Fraction of pages allowed to fail before the job is aborted (default `0.05` in LVM legacy mode). |
| `verbose`                        | boolean | LlamaParse client verbosity (the node sets `false` by default). |

> Advanced mode bypasses all simple-mode settings. Unknown keys produce a warning at save time but do not abort execution.

---

## Timeouts and large files

The cloud call runs in an isolated thread with its own event loop (LlamaParse uses asyncio internally and can otherwise raise "Event loop is closed" errors). The per-document timeout scales with file size:

| File size    | Timeout    |
| ------------ | ---------- |
| up to 100 MB | 5 minutes  |
| 100-500 MB   | 10 minutes |
| over 500 MB  | 15 minutes |

For files over 50 MB, the LlamaParse job timeout is also raised to at least 10 minutes. If the call times out, the node returns an empty result with the timeout recorded in the parsing metadata and the pipeline continues; it does not hang the run.

---

## Authentication

Obtain a LlamaIndex API key from [cloud.llamaindex.ai](https://cloud.llamaindex.ai) and paste it into the **API Key** field. The field is stored securely (marked `secure: true` in the node config). The key is required; the node aborts at startup if it is absent.

---

## Upstream docs

- [LlamaParse documentation](https://docs.cloud.llamaindex.ai/llamaparse/getting_started)
- [Advanced parsing modes](https://docs.cloud.llamaindex.ai/llamaparse/presets_and_modes/advance_parsing_modes)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `llamaparse.advanced_config` | `string` | **Advanced Configuration (JSON)**<br/>Enter configuration options in JSON format. For more information, see: <a href='https://docs.cloud.llamaindex.ai/llamaparse/presets_and_modes/advance_parsing_modes' target='_blank'>LlamaParse Documentation</a> | `"{\n  \"parse_mode\": \"parse_page_with_llm\",\n  \"spreadsheet_extract_sub_tables\": false,\n  \"system_prompt_append\": \"\",\n  \"lvm_model\": \"anthropic-sonnet-4.0\"\n}"` |
| `llamaparse.api_key` | `string` | **API Key**<br/>Your LlamaIndex API key for LlamaParse service |  |
| `llamaparse.lvm_model` | `string` | **LVM Model**<br/>The LVM model to use for parsing when LVM or agentic modes are selected. | `"anthropic-sonnet-4.0"` |
| `llamaparse.parse_mode` | `string` | **Parse Mode**<br/>The parse mode to use for chosing complexity of the parse | `"parse_page_with_lvm"` |
| `llamaparse.spreadsheet_extract_sub_tables` | `boolean` | **Extract Sub Tables**<br/>Extract sub-tables from spreadsheets for better table parsing. | `false` |
| `llamaparse.system_prompt_append` | `string` | **Additional Instructions**<br/>Additional instructions to append to the system prompt for LlamaParse. |  |
| `llamaparse.use_advanced_config` | `boolean` | **Advanced Configuration**<br/>Check to use advanced JSON configuration instead of simple options. | `false` |
| `llamaparse.use_system_prompt_append` | `boolean` | **Use Additional Instructions**<br/>Check to add custom instructions to the system prompt for LlamaParse. | `false` |

## Dependencies

- `llama-parse`
- `llama-index-core`
- `llama-cloud`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llamaparse)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
