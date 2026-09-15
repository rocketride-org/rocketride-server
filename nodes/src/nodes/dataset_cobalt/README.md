# dataset_cobalt

A RocketRide source node that loads an evaluation dataset and emits each item as an individual question into the pipeline.

## What it does

Reads a dataset from a file (JSON, CSV, or JSONL) or from an inline item list, optionally reshapes it (filter, sample, slice), and emits one question per surviving item. Put it at the head of a pipeline to drive batch evaluation and quality testing: each dataset item becomes a question, and the item's reference answer travels alongside as metadata for a downstream evaluator (see `eval_cobalt`).

When the optional **basalt-ai-cobalt** package (`cobalt`) is installed, its `Dataset` class parses files and runs transforms. When it is not — including when installing it fails outright, e.g. on a host with no package index — a pure-Python fallback parses JSON/CSV/JSONL and applies the same transforms, so the node stays functional without the dependency rather than silently yielding an empty dataset. The dependency install is attempted first and a failure is logged as a warning, not raised.

Key behavior to know:

- The incoming template question is **deep-copied** per emitted item, so shared question objects in fan-out pipelines are never mutated.
- **Reference answers are attached as metadata, never as prompt context** — the emitted question carries only the dataset's input text, so the expected answer is not exposed to an LLM downstream.
- Field mapping is None-aware and first-non-null wins: question text is taken from `input`, then `text`, then `question`; the reference from `expected`, then `output`, then `answer`. Any other keys on the item are preserved under metadata. `id` becomes `dataset_id` (synthesized when the row has none — see row identity below), and every emitted item is tagged `cobalt_source: true`.
- **File paths are sandboxed.** A path is rejected if it contains a `..` traversal segment or resolves (after following symlinks) to a location outside the pipeline working directory. This is a security boundary, so an absolute path pointing elsewhere on disk is rejected at runtime.
- **An empty dataset and an unreadable one are different outcomes.** A dataset that is read successfully and holds no rows completes normally with a count of zero. A dataset that cannot be read at all — a missing file, an unsupported extension, bad JSON, a non-object row — raises `DatasetLoadError` so the engine records a failed run. A typo'd **File Path** must not report a successful run that evaluated nothing.
- **Row identity is derived from the row, not minted per scan.** Every row gets one identity, used both as its `dataset_id` metadata and in its scan entry URL (`dataset_cobalt://{ordinal}/{identity}`), so the join key a downstream evaluator correlates on is the same string the engine sees. The identity is the row's own `id` when it has an addressable one — `0` and `False` included — and a deterministic `sha256-…` digest of the row otherwise, so two rows without ids never collapse together. Scanning the same dataset twice produces the same identities, so a consumer can dedup or resume.
- The `{ordinal}/` prefix on the URL is what keeps a dataset that repeats a row verbatim from collapsing those rows into one entry; identical rows share a digest by design.

---

## Lanes

| Lane in   | Lane out    | Description                                         |
| --------- | ----------- | --------------------------------------------------- |
| `_source` | `questions` | One question emitted per (transformed) dataset item |

The node is a source: it produces questions from the configured dataset and does not consume an upstream `questions` lane.

## Profiles

Default: `file`. The **Source Type** dropdown selects the profile, which decides where the items come from and which field the panel then asks for.

| Profile              | Source                                                 |
| -------------------- | ------------------------------------------------------ |
| `file` **(default)** | A JSON, CSV, or JSONL file named by **File Path**       |
| `inline`             | The JSON array pasted into **Inline Items (JSON)**      |

## Configuration

Pick the profile first — it is the only choice that changes which other fields matter. Everything else is optional: leave the transform fields at their defaults and every item in the dataset is emitted, in file order.

### Source Type

`file` reads the dataset off disk and is what a committed golden dataset uses. `inline` carries the items in the pipeline itself, which keeps a small smoke-test dataset next to the pipeline that exercises it and avoids shipping a data file. The panel shows **File Path** or **Inline Items (JSON)** accordingly.

### File Path

Relative to the pipeline working directory. A path containing a `..` traversal segment, or one that resolves (after following symlinks) outside that directory, is rejected at runtime — this is a security boundary, so an absolute path elsewhere on disk is rejected too. `datasets/qa-golden.jsonl` is the shape to write.

JSON files may be a bare array, or an envelope under `items`, `data`, or `rows`. JSONL is one object per line. CSV is read with `DictReader`, so the header row names the fields.

### Inline Items (JSON)

A JSON array of objects, as a string: `[{"input": "What is 2+2?", "expected": "4"}]`. Parsed at runtime, so a syntax error surfaces as a warning and an empty question set rather than a pipeline abort.

Each item's question text is taken from `input`, then `text`, then `question` — first non-null wins; the reference from `expected`, then `output`, then `answer`. Any other keys are preserved as metadata, `id` becomes `dataset_id`, and every item is tagged `cobalt_source: true`.

### Sample Size, Filter Field, Filter Value, Slice Start, Slice End

The transforms, applied in a fixed order: **filter → sample → slice**. Each is skipped when unset, so they compose without surprising each other.

- **Filter Field** / **Filter Value** keep only the items whose field equals the value (string comparison). Both are needed; one alone does nothing.
- **Sample Size** takes that many items at random after filtering. `0` (the default) means take all, and a value larger than the dataset is bounded to its size.
- **Slice Start** / **Slice End** take a 0-based half-open range of what is left. `0` for **Slice End** (the default) means no slicing.

Filtering to one category and then sampling 20 is the usual shape for a quick run against a large dataset; slicing is for reproducibly re-running the same window.

## Notes

### Dependency

The `cobalt` (basalt-ai-cobalt) package is **optional**. Installed, it is used for file parsing and transforms; absent, the node falls back to a pure-Python loader that handles JSON arrays, `{"items"|"data"|"rows": [...]}` envelopes, JSONL (one object per line), and CSV (`DictReader` rows).

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `dataset.file_path` | `string` | **File Path**<br/>Path to the dataset file (JSON, CSV, or JSONL). Must resolve to a location inside the pipeline working directory; paths outside it, or containing '..', are rejected. |  |
| `dataset.filter_field` | `string` | **Filter Field**<br/>Optional field name to filter dataset items on. |  |
| `dataset.filter_value` | `string` | **Filter Value**<br/>Value that the filter field must match. |  |
| `dataset.items` | `string` | **Inline Items (JSON)**<br/>JSON array of dataset items as a string, e.g. [{"input": "...", "expected": "..."}]. Parsed as JSON at runtime. | `"[{\"input\": \"What is 2+2?\", \"expected\": \"4\"}]"` |
| `dataset.sample_size` | `number` | **Sample Size**<br/>Number of random items to sample from the dataset. 0 means use all items. | `0` |
| `dataset.slice_end` | `number` | **Slice End**<br/>End index for slicing the dataset. 0 means no slicing. | `0` |
| `dataset.slice_start` | `number` | **Slice Start**<br/>Start index for slicing the dataset (0-based). | `0` |
| `dataset.source_type` | `string` | **Source Type**<br/>Where to load the dataset from: file (JSON/CSV/JSONL) or inline items. | `"file"` |

## Dependencies

- `basalt-ai-cobalt` `>=0.1.0,<1.0.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/dataset_cobalt)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
