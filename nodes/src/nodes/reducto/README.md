# reducto

A RocketRide data node that parses documents with the Reducto cloud API, extracting clean Markdown text and structured tables.

## What it does

Sends each incoming document to the Reducto cloud API for parsing and emits results on two output lanes: full extracted text as Markdown and each detected table as a separate Markdown table block. It handles PDFs, images, scanned documents, and mixed-content files.

Uses the **`reductoai` Python SDK**: each document is uploaded with `reducto.upload()` and parsed with `reducto.parse.run()`, where all parsing behavior is expressed through the `enhance` parameter. A fresh Reducto client is created per document parse so concurrent documents are safe.

The node buffers the document byte stream from the incoming tag lane and parses it once the stream ends. Output is only produced for lanes that have a downstream listener. If parsing fails, the error is logged and the node emits nothing for that document (empty text, no tables) rather than raising.

The extracted text is assembled as Markdown from Reducto's block types: `title` blocks become `#` headings, `section_header` blocks become `##` headings, `list_item` blocks become `-` bullets, and `table` blocks appear both inline in the text stream and as separate items on the `table` lane. `figure` blocks are included as plain content or, when AI summarization is enabled, prefixed with `[DIAGRAM/IMAGE SUMMARY]:`.

---

## Configuration

### Lanes

| Lane in | Lane out | Description                               |
|---------|----------|-------------------------------------------|
| `data`  | `text`   | Extracted text as Markdown                |
| `data`  | `table`  | Extracted tables in Markdown table format |

### Fields

| Field | Type | Description |
|---|---|---|
| `api_key` | string | Your Reducto API key |
| `parse_mode` | boolean | Default false. Toggle to use the advanced parse mode, and have access to the full set of options from the Reducto API. |
| `Contains_Handwritten_Text` | boolean | Default false. Enables Agentic OCR mode for better handwriting recognition and small text/table cell corrections. |
| `Contains_Non_English_Text` | boolean | Default false. Enables Multilingual OCR system which can parse non-Germanic languages and unicode symbols. |
| `Summarize_Text` | boolean | Default false. Generate AI summaries for figures, diagrams, and images using vision-language models. |
| `advanced_documentation` | null | In advanced mode, you can use the full set of options from the Reducto API. For each set of options you must use and only include a python dictionary, e.g., {'key': 'value', 'flag': True}. If no information is provided for a set of options, the default values will be used. For more information on what options are available, see the Reducto API documentation at https://docs.reducto.ai/parsing/default-configurations. This page also contains examples of how to format the options fields. (In Advanced mode your configuration from Simple mode will be ignored) |
| `options` | string | Options for the Reducto API |
| `advanced_options` | string | Advanced options for the Reducto API |
| `experimental_options` | string | Experimental options for the Reducto API |

The default profile uses Simple mode (`parse_mode: false`).

### Simple mode

When `parse_mode` is `false`, three optional toggles (all defaulting to `false`) control Reducto enhance options:

| Field                       | Default | Effect when enabled                                                                           |
|-----------------------------|---------|-----------------------------------------------------------------------------------------------|
| `Contains_Handwritten_Text` | `false` | Sets `ocr_mode: "agentic"`: Agentic OCR for better handwriting recognition and small text/table cell corrections. |
| `Contains_Non_English_Text` | `false` | Sets `ocr_system: "multilingual"`: Multilingual OCR for non-Germanic languages and Unicode symbols. |
| `Summarize_Text`            | `false` | Sets `summarize_figures: true`: AI summaries for figures, diagrams, and images using vision-language models. |

Table summarization (`summarize_tables`) is always set to `false` in Simple mode because SDK 0.13.0 does not support it effectively.

### Advanced mode

When `parse_mode` is `true`, the Simple mode toggles are ignored and you get direct access to the Reducto API through three free-text fields:

| Field                  | Description                                                                                  |
|------------------------|----------------------------------------------------------------------------------------------|
| `options`              | Options for the Reducto API.                                                                 |
| `advanced_options`     | Advanced options for the Reducto API.                                                        |
| `experimental_options` | Experimental options for the Reducto API.                                                    |

Each field must contain a **Python dictionary literal**, for example `{'key': 'value', 'flag': True}`. The values are parsed with `ast.literal_eval`, so JSON-only syntax such as `true` or `null` will fail validation. Empty fields are skipped and Reducto's defaults apply. The three dictionaries are merged in order (options, then advanced_options, then experimental_options; later keys override earlier ones) into the single `enhance` parameter passed to `parse.run()`.

See the [Reducto parsing configurations documentation](https://docs.reducto.ai/v/legacy/parsing/default-configurations) for available parameters and formatting examples.

---

## Authentication

Set `api_key` to a valid Reducto API key. Config validation verifies the key by performing a minimal in-memory upload (`ping.txt`, no parsing) against the Reducto API. An invalid key causes validation to fail with the message `Reducto API key validation failed`. Note that validating the config requires network access to Reducto.

---

## Upstream docs

- [Reducto documentation](https://docs.reducto.ai/overview)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `reducto.Contains_Handwritten_Text` | `boolean` | **Contains Handwritten Text**<br/>Enables Agentic OCR mode for better handwriting recognition and small text/table cell corrections. | `false` |
| `reducto.Contains_Non_English_Text` | `boolean` | **Contains Non-English Text**<br/>Enables Multilingual OCR system which can parse non-Germanic languages and unicode symbols. | `false` |
| `reducto.Summarize_Text` | `boolean` | **AI Summarize Figures/Images**<br/>Generate AI summaries for figures, diagrams, and images using vision-language models. | `false` |
| `reducto.advanced_documentation` | `null` | **Advanced Parse Mode - How to**<br/>In advanced mode, you can use the full set of options from the Reducto API. For each set of options you must use and only include a python dictionary, e.g., {'key': 'value', 'flag': True}. If no information is provided for a set of options, the default values will be used. For more information on what options are available, see the Reducto API documentation at https://docs.reducto.ai/parsing/default-configurations. This page also contains examples of how to format the options fields. (In Advanced mode your configuration from Simple mode will be ignored) | `null` |
| `reducto.advanced_options` | `string` | **Advanced Options**<br/>Advanced options for the Reducto API |  |
| `reducto.api_key` | `string` | **API Key**<br/>Your Reducto API key |  |
| `reducto.experimental_options` | `string` | **Experimental Options**<br/>Experimental options for the Reducto API |  |
| `reducto.options` | `string` | **Options**<br/>Options for the Reducto API |  |
| `reducto.parse_mode` | `boolean` | **Advanced Mode**<br/>Toggle to use the advanced parse mode, and have access to the full set of options from the Reducto API. | `false` |

## Dependencies

- `reductoai`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/reducto)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
