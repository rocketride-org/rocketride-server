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
# The engine's key. Replace rr_local with the key your engine was started with.
# For a local engine started without a key, any non-empty value works.
export ROCKETRIDE_APIKEY=rr_local
export ROCKETRIDE_OPENAI_API_KEY=sk-...

rocketride start --pipeline ./extract.pipe
```

`start` prints a task token and exits; the pipeline keeps running on the engine:

```text
Starting pipeline from ./extract.pipe...
Pipeline started.
Token: <task-token>
Stop it with: rocketride stop --token <task-token>
```

The engine scans the directory and processes each file through the pipeline.
This pipeline sends no reply: `start` exits after it prints the token, and no
request is made, so nothing comes back to you. To see each file's JSON, use the
`dropper` variant below: its page shows the result in the Answers and JSON tabs.
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

`start` does not print an address. The page is on the engine port, at
`http://localhost:5565/dropper?auth=<task token>`, where the task token is the
one `start` prints. The engine key does not work for uploads: the page opens
with it, but dropped files fail because it does not identify the task. Drop
files there and see results in JSON, text, and table tabs.

The task token is private, so do not share this link. A link for other people
must use the public key (`pk_...`) that the dropper node publishes; the VS Code
extension shows it.

## Next steps

- Add a [`db_postgres`](/nodes/db_postgres) node after `extract_1` to write the
  extracted fields directly to a database table.
- Add an [`anonymize`](/nodes/anonymize) node before `extract_1` to strip PII
  before it reaches the LLM.
- See the [`db_postgres` node reference](/nodes/db_postgres) for writing
  extracted data to a database.
