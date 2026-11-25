---
title: Document Extraction
sidebar_position: 3
description: Read files from the local file system, parse them into structured text, extract specific fields, and return structured JSON in a RocketRide pipeline.
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
  "project_id": "extraction-example",
  "source": "source_1",
  "components": [
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
      "config": {},
      "input": [
        { "lane": "tags", "from": "source_1" }
      ]
    },
    {
      "id": "extract_1",
      "provider": "extract_data",
      "config": {
        "profile": "default",
        "fields": [
          { "column": "invoice_number", "type": "text", "defval": "" },
          { "column": "total_amount",   "type": "text", "defval": "" },
          { "column": "due_date",       "type": "date", "defval": "" },
          { "column": "vendor_name",    "type": "text", "defval": "" }
        ]
      },
      "input": [
        { "lane": "text", "from": "parser_1" }
      ]
    },
    {
      "id": "llm_1",
      "provider": "llm_openai",
      "config": {
        "profile": "openai-4o-mini",
        "apikey": "${ROCKETRIDE_OPENAI_API_KEY}"
      },
      "control": [
        { "classType": "llm", "from": "extract_1" }
      ]
    },
    {
      "id": "target_1",
      "provider": "response_answers",
      "config": {},
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
| `llm_1` | `llm_openai` | Answers `extract_1`'s extraction prompts over the `llm` invoke channel. |
| `target_1` | `response_answers` | Returns the extracted JSON for each file that is sent to the pipeline (the dropper page below shows it). |

## Start the pipeline

Put some PDF invoices in `/data/invoices`, then:

```bash
# The key the CLI sends. Replace rr_local with the key your engine requires (its
# RR_APIKEY). A local engine started without a key accepts any non-empty value.
export ROCKETRIDE_APIKEY=rr_local
export ROCKETRIDE_OPENAI_API_KEY=sk-...

rocketride start --pipeline ./extract.pipe
```

`start` prints the run's token and exits; the pipeline keeps running on the engine:

```text
Starting pipeline from ./extract.pipe...
Pipeline started.
Token: =control/1234abcd...
Stop it with: rocketride stop --token =control/1234abcd...
```

The engine scans the directory and processes each file through the pipeline.
This pipeline sends no reply: `start` exits after it prints the token, and no
request is made, so nothing comes back to you. To see each file's JSON, use the
`dropper` variant below: its page shows each file's result.
`rocketride upload` only reports whether each file was uploaded. The extracted
JSON for each file has this shape:

```json
{
  "invoice_number": "INV-2024-0042",
  "total_amount": "1,250.00 USD",
  "due_date": "2024-02-15",
  "vendor_name": "Acme Supplies Ltd."
}
```

In a reply, this object is inside the `answers` array of the result, as
`"answers": [[ { ... } ]]`.

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

The run you started earlier still reads the `filesys` source: editing the file
does not change it. Save the file, stop that run with the command `start`
printed, and start the pipeline again:

```bash
rocketride stop --token <the token start printed>
rocketride start --pipeline ./extract.pipe
```

`start` does not print an address. You drop files in the Playground, the
platform app `rocketride.playground`: open it from the dropper node in the
Builder (**Open in Playground**), or by a signed-in deep link on the engine's
own address:

```text
http://localhost:5565/?appid=rocketride.playground&pipe=rocketride.extraction-example.source_1
```

The `pipe` value is the run's address, `developerId.pipelineId.source`: the
pipeline's `project_id` and source, under your developer id (`rocketride` on a
local engine). Drop files there to see each file's result.

The link carries no credential: whoever opens it signs in, so it is safe to
pass on. The token `start` prints is not part of it.

## Next steps

- Add a [`db_postgres`](/nodes/db_postgres) node after `extract_1` to write the
  extracted fields directly to a database table.
- Add an [`anonymize`](/nodes/anonymize) node before `extract_1` to strip PII
  before it reaches the LLM.
- See the [`db_postgres` node reference](/nodes/db_postgres) for writing
  extracted data to a database.
