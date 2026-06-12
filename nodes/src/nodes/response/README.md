# response

A RocketRide infrastructure node that captures pipeline output and returns it to the requesting client as a structured JSON response.

## What it does

Acts as the terminal node in pipelines triggered via HTTP: it collects everything arriving on its input lanes and writes it into the request's JSON response body, with each lane's data stored under a configurable result key. It handles the response phase of the HTTP request-response cycle, so the client receives all pipeline results in a single standardized JSON object.

When an object finishes processing, the node also copies the object's name, path (the containing directory, with the file name stripped), and metadata (all keys except Tika-derived ones, which are filtered out) into the response. It also records a `result_types` map that ties each result key back to its original lane type.

Data handling per lane:

- **text** - chunks are accumulated (joined with blank lines) and appended as one string per object.
- **table**, **documents**, **questions** - appended as-is; documents and questions are serialized to plain dicts.
- **answers** - appended as parsed JSON when the answer is JSON, otherwise as plain text.
- **image** - streamed chunks are buffered via AVI_ACTION signals (BEGIN / WRITE / END), then the complete image is base64-encoded and appended as `{"mime_type": ..., "image": ...}`.
- **audio**, **video** - the raw bytes are not returned; only tracking metadata is appended: `{"url", "aviAction", "mimeType", "size"}`.

The node has no Python dependencies of its own (`requirements.txt` is empty); it relies on the separately installed AI module for document, question, and answer schemas and for image processing.

---

## Service variants

The same implementation is registered as nine services. The generic **HTTP Results** service (`response://`) accepts all eight lane types and lets you map each lane to its own result key. Eight single-lane variants accept exactly one lane each and expose a single `laneName` field:

| Service title    | Protocol                  | Lane        | Default result key |
|------------------|---------------------------|-------------|--------------------|
| HTTP Results     | `response://`             | all eight   | the lane type name |
| Return Answers   | `response_answers://`     | `answers`   | `answers`          |
| Return Audio     | `response_audio://`       | `audio`     | `audio`            |
| Return Documents | `response_documents://`   | `documents` | `documents`        |
| Return Image     | `response_image://`       | `image`     | `image`            |
| Return Questions | `response_questions://`   | `questions` | `questions`        |
| Return Table     | `response_table://`       | `table`     | `table`            |
| Return Text      | `response_text://`        | `text`      | `text`             |
| Return Video     | `response_video://`       | `video`     | `video`            |

All variants are `classType: infrastructure` and register as a `filter`. The generic `response://` service additionally carries the `internal` capability.

---

## Configuration

### Lanes

All lanes are inputs; the node produces no output lanes.

| Lane in     | Lane out | Description |
|-------------|----------|-------------|
| `text`      | -        | Captured under the configured key |
| `table`     | -        | Captured under the configured key |
| `documents` | -        | Captured under the configured key |
| `questions` | -        | Captured under the configured key |
| `answers`   | -        | Captured under the configured key |
| `audio`     | -        | Captured under the configured key (tracking metadata only, not raw bytes) |
| `video`     | -        | Captured under the configured key (tracking metadata only, not raw bytes) |
| `image`     | -        | Captured under the configured key (base64-encoded) |

### HTTP Results (generic service)

| Field | Type | Description |
|---|---|---|
| `laneId` | string |  |
| `laneName` | string |  |
| `lanes` | array | Each lane maps pipeline data to a custom JSON key in the response. Select the data type (text, documents, answers, etc.) for Lane Name, and enter a custom JSON key name (1-32 characters) for Result Key. |

Multiple lane-to-key mappings can be added to return several outputs in a single response. When no mapping is configured for a lane, its data is stored under the lane type name as the default key.

### Single-lane variants (Return Answers, Return Text, ...)

| Field      | Type / Default                    | Description |
|------------|-----------------------------------|-------------|
| `laneName` | string, defaults to the lane type | The JSON key under which this lane's data appears in the response body (1-32 characters). |

When `laneName` is set at the top level of the node config (the style used by all single-lane variants), it overrides the `lanes` array and every lane type arriving at the node is written under that one key. The per-lane `lanes` mapping only applies when no top-level `laneName` is configured.

---

## Response format

The JSON object returned to the client has the following structure:

```json
{
  "name": "file.pdf",
  "path": "/some/directory",
  "metadata": { "...": "..." },
  "your_key": [ "...data..." ],
  "result_types": { "your_key": "answers" }
}
```

Each configured result key holds an array: one element per result produced for the object. `result_types` maps each configured key back to its original lane type, so clients can identify the kind of data each key contains even when custom key names are used. The `name`, `path`, and `metadata` fields are only present when the processed object carries those attributes; `metadata` excludes all Tika-derived keys.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Return Answers (`services.answers.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"answers"` |

### Return Audio (`services.audio.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"audio"` |

### Return Documents (`services.documents.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"documents"` |

### Return Image (`services.image.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"image"` |

### HTTP Results (`services.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneId` | `string` | **Lane name** |  |
| `laneName` | `string` | **Result key** |  |
| `lanes` | `array` | **Lanes**<br/>Each lane maps pipeline data to a custom JSON key in the response. Select the data type (text, documents, answers, etc.) for Lane Name, and enter a custom JSON key name (1-32 characters) for Result Key. |  |

### Return Questions (`services.questions.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"questions"` |

### Return Table (`services.table.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"table"` |

### Return Text (`services.text.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"text"` |

### Return Video (`services.video.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `laneName` | `string` | **Identifier key within result** | `"video"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/response)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
