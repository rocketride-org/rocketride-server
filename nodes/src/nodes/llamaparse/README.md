# llamaparse

A RocketRide data node that sends documents to LlamaParse and writes flattened Markdown text and extracted tables into the pipeline; use it for readable content, not audit-grade source provenance.

## About LlamaParse

LlamaParse is a document-parsing service used to turn files into text and
structured document content. This node uses its Python client to parse the
document bytes supplied by a RocketRide pipeline and to return the resulting
text and table data.

## What it does

The node processes incoming document data on `tags` and emits parsed Markdown
on `text` plus tables on `table`. It isolates each LlamaParse request in a
separate thread and event loop, which is useful where the surrounding runtime
already has event-loop state. Choose it when flattened Markdown is the desired
downstream format; use a structure-preserving parser when later review needs
page boundaries, coordinates, or the original table-cell grid.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `tags` | `text` | Parsed document text, flattened to Markdown. |
| `tags` | `table` | Table content detected in the parsed result. |

## Configuration

Start with an API key and the default simple configuration. Simple mode builds
the LlamaParse constructor arguments from the visible controls; advanced mode
instead parses the supplied JSON and merges its entries into those arguments.

### Advanced Configuration

Enable **Advanced Configuration** only when the simple controls cannot express
the parsing options you need. Its value must be valid JSON and must not set
`api_key`, which the node ignores when merging the advanced object. Save-time
validation only warns about unknown keys or invalid JSON, but startup aborts
when advanced mode has no configuration or when JSON cannot be parsed. A good
value is an object containing only the constructor options you intend to
override, such as `{"parse_mode": "parse_page_with_llm"}`.

### Parse Mode and LVM Model

The default **Parse Mode**, `parse_page_with_lvm`, passes that mode to the
client, optionally passes **LVM Model** as `vendor_multimodal_model_name`, and
sets a page-error tolerance of `0.05`. The `agentic` and `agentic_plus` choices
both select `parse_page_with_agent` and can use the same LVM model setting.

The displayed `cost_effective (LLM)` value does not match the code path that
checks for `cost_effective`; as written, choosing it supplies no parse-mode
argument. Keep the default or use an agentic choice when a specific mode must
be sent. The LVM model is not used by the cost-effective path.

### Additional Instructions and spreadsheet tables

**Additional Instructions** are passed only for the legacy
`parse_page_with_lvm` path, when non-blank; use them for parser guidance that
belongs with that mode. **Extract Sub Tables** defaults to off and, when on,
passes `spreadsheet_extract_sub_tables=True` to LlamaParse. Enable it only for
spreadsheets whose nested tables need separate parsing; it has no special
handling in the node beyond forwarding that setting.

## Authentication

Set **API Key** to the LlamaParse service key. Missing keys generate a
save-time warning and cause startup to raise before a parser is created.

## Requirements

The service metadata declares the `gpu` capability. The node itself creates a
LlamaParse client and sends document bytes to it; it does not download or run a
local model. A working network connection to the service and its Python
dependency are therefore required by this implementation.

## Notes

### Scale-header preservation

Financial statements declare their magnitude in a caption above the table ("(In millions)", "$ in thousands", "amounts in millions of USD"). If that caption is separated from its table by downstream chunking or an LLM step, every figure reads as raw units and is silently 1,000x, 1,000,000x, or 1,000,000,000x off. Nothing downstream catches it, because a wrong-by-1e6 number looks exactly like a right one.

To keep that loss visible, the parser post-processes the extracted Markdown:

- **Detects scale captions** the parser already emitted ("(in millions)", "in thousands, except per share amounts", "(₹ in crore)", ...) and normalizes each to a unit, a numeric factor, and an optional currency. Prose uses of the same words ("millions of users", "billions served", "hundreds of thousands of dollars") are not treated as captions.
- **Welds a marker to the table.** When a caption is in scope for a *numeric* table (same page/section, no page break between them), a normalized line is injected directly above the table, for example `> Scale: amounts in millions (x1,000,000)`. A later chunker or LLM cannot separate the scale from its figures. A caption is only welded onto a table that actually looks numeric, so a caption sitting over a prose or roster table is never mis-attached.
- **Flags a missing scale, when the context is financial.** When a numeric table has no caption in scope *and* the document shows a financial signal (a caption detected elsewhere, or a currency marking in the table itself), a warning line is injected above it: `> [scale?] Scale not detected for this table. Figures may be in thousands, millions, or billions. Verify against the source.` The warning errs toward caution: a visible warning is far cheaper than a silent 1e6 error. Plain numeric tables with no financial signal (inventory counts, server metrics, sports standings) are left untouched, so ordinary documents pay nothing for this feature. The markers are plain ASCII, so they survive a cp1252 console without an encoding error.

The welded markers travel in-band with the text and table lanes, so they are the durable downstream signal: whatever chunks or summarizes the output carries the scale (or the warning) with the figures.

For observability, the same results are also recorded in `parsing_metadata` (debug-logged by the instance; not currently re-emitted onto a lane):

- `detected_scales`: list of `{phrase, unit, factor, currency}` for each caption found.
- `scale_warnings`: per-table `{table_index, status, ...}` where `status` is `scale_detected`, `scale_missing`, `not_financial`, or `already_annotated` (the table already carried one of our markers and was left as-is).

Annotation is idempotent (re-running does not double-inject; the injected markers are not themselves read back as captions) and never blocks parsing: any failure falls back to the untouched text.

**Out of scope.** Recovering a caption that LlamaParse dropped from the source entirely is not handled here. That needs an independent source-text extraction and belongs to the audit-grade **`datalab_parse`** node. This node makes an *emitted-but-separable* scale un-loseable and flags its *absence*; it does not re-parse the source.

---


### Flattened output and failures

The node concatenates the returned document text and reads tables from either
`structured_data` or `items` metadata. It does not retain page boundaries,
bounding boxes, or a table HTML cell grid. Parsing errors, absent input, and
import errors return empty text and structured data rather than an exception.

For files over 50 MiB the isolated call raises the parser timeout settings to
at least 600 seconds. The worker waits up to 300 seconds for smaller files,
600 seconds above 100 MiB, and 900 seconds above 500 MiB; a timed-out worker
returns an empty result with error metadata while its daemon thread is left to
finish.

## Upstream docs

- [LlamaParse documentation](https://developers.llamaindex.ai/llamaparse/parse/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `llamaparse.advanced_config` | `string` | **Advanced Configuration (JSON)**<br/>Enter configuration options in JSON format. For more information, see: <a href='https://developers.llamaindex.ai/llamaparse/parse/v1/presets_and_modes/advance_parsing_modes/' target='_blank'>LlamaParse Documentation</a> | `"{\n  \"parse_mode\": \"parse_page_with_llm\",\n  \"spreadsheet_extract_sub_tables\": false,\n  \"system_prompt_append\": \"\",\n  \"lvm_model\": \"anthropic-sonnet-4.0\"\n}"` |
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
