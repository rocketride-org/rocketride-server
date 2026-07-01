# Landing.ai (Agentic Document Extraction)

Nodes that wrap [Landing.ai](https://landing.ai/)'s **Agentic Document Extraction
(ADE)** API, built on the DPT-2 model. ADE turns documents (PDFs, scans,
invoices, forms, spreadsheets) into reliable structured data.

This package ships two sub-nodes, mirroring how ADE chains:

| Sub-node | Protocol | Input → Output | SDK call |
| --- | --- | --- | --- |
| **Landing.ai Parse** | `landing_ai_parse://` | document (`tags`) → `text` (markdown) + `table` | `client.parse(document=…, model=…)` |
| **Landing.ai Extract** | `landing_ai_extract://` | parsed markdown (`text`) + JSON Schema → `answers` / `documents` | `client.extract(markdown=…, schema=…)` |

Extract runs **downstream of Parse**: ADE Extract consumes the markdown that
Parse produces, not the raw document. A typical pipeline is
`source → Landing.ai Parse → Landing.ai Extract → sink`.

## Configuration

- **API Key** — your ADE key (`ROCKETRIDE_LANDING_AI_KEY`). A free Explore tier grants
  1,000 credits to start.
- **Parse**: model (`dpt-2-latest`) and optional region (`environment`).
- **Extract**: upload a JSON Schema `.json` file describing the fields to pull.
  Supports the ADE `format` and `x-alternativeNames` keywords.

## Layout

Shared code (`landing_ai_base.py`, `requirements.txt`, icon) lives at the package
root; each capability is a sub-package (`parse/`, `extract/`) loaded by the
engine via the `path` field in its `services.<name>.json`. Future ADE
capabilities (Split, Section, Classify) drop in the same way.

SDK: [`landingai-ade`](https://pypi.org/project/landingai-ade/) ·
docs: https://docs.landing.ai/ade/ade-python
