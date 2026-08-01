# extract_facts

The extraction brain — a RocketRide filter node that reads document context together with a parsed table, extracts a user-defined set of fields, and runs a validator pass that double-checks the values on disagreement before emitting fully-qualified facts with provenance.

## What it does

Accumulates the document and table context for an object across all of its chunks, then runs a two-pass LLM extraction when the object closes:

1. **Extraction pass** — builds a prompt listing every configured field (name, type, optional default) and instructs the connected LLM (with `expectJson: true`) to read the source and emit **one object per logical record** — a single-entity document (e.g. one invoice) yields exactly one object carrying all target fields; a table yields one object per data row. Tables are fenced with `[TABLE <id>]` markers and read row by row. Every record must include a `_provenance` object (`page`, `table_id`, `row`, `col`, `source_text`, `confidence`).
2. **Validator pass** — a second prompt against the *same* LLM invoke lane. It re-reads the source at the location each fact cites, reconciles disagreements (correcting the value, fixing the cited cell, or dropping unsupported facts), and returns the reconciled list with a `_validation` annotation. If validation is disabled the extraction pass is emitted directly.

Incoming chunks are buffered (via `preventDefault`) and never passed downstream; only the reconciled facts are emitted when the object closes. Fields with an empty name or type are skipped at pipeline start with a warning. Accumulated context is reset for every new object, so state never leaks between objects.

No third-party Python dependencies (requirements.txt is empty).

---

## Connections

| Connection | Required    | Description                                      |
| ---------- | ----------- | ------------------------------------------------ |
| `llm`      | yes (min 1) | LLM used for both the extraction and validator passes |

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                              |
| ----------- | ----------- | ------------------------------------------------------- |
| `table`     | `answers`   | Extract facts from a table, emit as JSON                |
| `table`     | `documents` | Extract facts from a table, emit one document per fact  |
| `documents` | `answers`   | Extract facts using document context, emit as JSON      |
| `documents` | `documents` | Extract facts using document context, one doc per fact  |

On close, the `answers` lane (if connected) receives one JSON answer containing the full list of reconciled records. The `documents` lane (if connected) receives one document per record, with the record serialized as JSON in the document content.

### Fields

The node takes a list of target fields to extract (`fields`, 1-32 entries). Each entry has:

| Field    | Type   | Description                                          |
| -------- | ------ | ---------------------------------------------------- |
| `column` | string | Default "field". Name of the target fact field      |
| `type`   | string | Default "text". Expected data type                  |
| `defval` | string | Default empty. Value used when the fact isn't found |

**Supported types:** `text` (Text), `decimal` (Number), `int` (Integer), `date` (Date), `time` (Time), `datetime` (DateTime), `timestamp` (Timestamp), `binary` (Binary), `json` (JSON), `html` (HTML), `url` (URL), `email` (Email), `phone` (Phone), `ipv4` (IPv4), `ipv6` (IPv6), `uuid` (UUID), `guid` (GUID)

Two toggles control behaviour:

| Toggle                | Default | Description                                                          |
| --------------------- | ------- | -------------------------------------------------------------------- |
| `validate`            | `true`  | Run the second validator prompt pass that reconciles disagreements   |
| `include_provenance`  | `true`  | Attach the `_provenance` block to every emitted fact                 |

A single configuration profile exists (`default`); it carries the field list and toggles above. The profile selector field (`facts.profile`) is hidden in the UI.

### Provenance

Each emitted record carries a `_provenance` object alongside the configured fields:

| Provenance key | Description                                                          |
| -------------- | ------------------------------------------------------------------- |
| `page`         | Source page the record was read from                                |
| `table_id`     | Identifier of the source table                                      |
| `row`          | Source row index of the record within the table                     |
| `col`          | Column index only when the whole record is a single cell; else null |
| `source_text`  | Verbatim snippet or row text the record was drawn from              |
| `confidence`   | Extractor/validator confidence for the reconciled record            |

Provenance is filled on a **best-effort** basis by the model from the text it is given: any field it cannot determine (for example a `page` when the input has no page markers, or `row`/`col` for a free-text record) is returned as `null`.

---

## Behaviour

The LLM infers field values even when the source does not use the exact field names, reasoning about what each field likely contains from the surrounding context. When a `table` lane feeds the node, the extractor is told to read it row by row and turn each data row into one record so it can cite the originating row in provenance; `documents` lane input routes table documents (`metadata.isTable`) to the table buffer and everything else to the free-text buffer, emitting an inline `[Page N]` marker with each chunk that carries page metadata so the extractor can cite the page in provenance. The validator pass gives the model a second, adversarial look at its own output before anything is emitted, keeping the value it can best justify from the source.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `facts.column` | `string` | **Field**<br/>Name of the target fact field | `"field"` |
| `facts.defval` | `string` | **Default Value** | `""` |
| `facts.fields` | `array` |  |  |
| `facts.include_provenance` | `boolean` | **Include Provenance**<br/>Auto-attach provenance (page, table id, row, column, source text, confidence) to every emitted fact. | `true` |
| `facts.profile` | `string` |  | `"default"` |
| `facts.type` | `string` | **Type** | `"text"` |
| `facts.validate` | `boolean` | **Validate**<br/>Run a second validator prompt pass that double-checks extracted facts and reconciles on disagreement. | `true` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/extract_facts)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
