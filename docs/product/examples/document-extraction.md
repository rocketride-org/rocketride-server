---
title: Document Extraction
sidebar_position: 3
---

# Document Extraction

Read files from the local file system, parse them into structured text, extract
specific fields, and return structured JSON. This pattern works well for invoice
processing, contract review, report summarisation, and any batch document
workflow.

## The pipeline

Save this as `extract.pipe`:

```json
{
  "nodes": [
    {
      "id": "source_1",
      "provider": "filesys",
      "config": {
        "include": [
          { "path": "/data/invoices" }
        ]
      }
    },
    {
      "id": "parser_1",
      "provider": "parse",
      "input": [
        { "lane": "tags", "from": "source_1" }
      ]
    },
    {
      "id": "extract_1",
      "provider": "extract_data",
      "config": {
        "profile": "default",
        "apikey": "${OPENAI_API_KEY}",
        "fields": [
          { "name": "invoice_number", "description": "The invoice or reference number" },
          { "name": "total_amount",   "description": "The total amount due including tax" },
          { "name": "due_date",       "description": "The payment due date in ISO 8601 format" },
          { "name": "vendor_name",    "description": "The name of the vendor or supplier" }
        ]
      },
      "input": [
        { "lane": "text", "from": "parser_1" }
      ]
    },
    {
      "id": "target_1",
      "provider": "response",
      "input": [
        { "lane": "answers", "from": "extract_1" }
      ]
    }
  ]
}
```

## What each node does

| Node | Provider | Role |
| --- | --- | --- |
| `source_1` | `filesys` | Scans `/data/invoices` and emits each file as a tagged object on the `tags` lane. |
| `parser_1` | `parse` | Converts each file (PDF, Word, image, etc.) into clean text on the `text` lane. |
| `extract_1` | `extract_data` | Uses an LLM to pull the four named fields out of each document and emits the result as structured JSON on the `answers` lane. |
| `target_1` | `response` | Returns the extracted JSON to the caller. |

## Start the pipeline

Put some PDF invoices in `/data/invoices`, then:

```bash
export OPENAI_API_KEY=sk-...

rocketride start --pipeline ./extract.pipe
```

The engine scans the directory, processes each file through the pipeline, and
streams the extracted JSON:

```json
{
  "invoice_number": "INV-2024-0042",
  "total_amount": "1,250.00 USD",
  "due_date": "2024-02-15",
  "vendor_name": "Acme Supplies Ltd."
}
```

## Upload files on demand

Swap the `filesys` source for a `webhook` source to process files as they
arrive rather than scanning a directory:

```json
{ "id": "source_1", "provider": "webhook" }
```

Then upload files via the CLI:

```bash
rocketride upload --pipeline ./extract.pipe ./invoice-001.pdf ./invoice-002.pdf
```

Or via the Drag & Drop UI by using the `dropper` provider:

```json
{ "id": "source_1", "provider": "dropper" }
```

The engine prints a browser URL where you can drop files and see results in
JSON, text, and table tabs.

## Next steps

- Add a [`db_postgres`](/nodes/db_postgres) node after `extract_1` to write the
  extracted fields directly to a database table.
- Add an [`anonymize`](/nodes/anonymize) node before `extract_1` to strip PII
  before it reaches the LLM.
- See the [PostgreSQL integration guide](/integrations/postgres) for writing
  extracted data to a database.
