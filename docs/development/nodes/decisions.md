# Making a node's output routable (`response.decisions`)

A node can record what it decided about an item, so that a later node can act on it. The Gate node reads these records and passes or blocks items. You don't need a Gate to write decisions, and a Gate doesn't need to know which node wrote them. This page is the format and the rules for writing it.

The System One nodes are the first writers (see [System One as a worked example](#system-one-as-a-worked-example)). Any node can be one.

## What `response.decisions` is

`currentObject.response['decisions']` is a dict keyed by the writer's component id (for example `decision_ollama_1` or `anomaly_detector_2`).

- **One group per writer.** A group holds that node's question definitions once, plus one item per thing it decided.
- **Items are append-only.** Nothing is removed or rewritten for the life of the object. An item's position in its group's `items` list is its permanent id.
- **The key appears with the first item.** The same call sets `response['result_types']['decisions'] = 'decisions'`, so the decisions show up in the result under `decisions`.
- **`decisions` is reserved.** The response node rejects a lane named `decisions`.

## The format

This example has two System One groups (one on text, one on chunks) and one anomaly_detector group. Notes on the fields follow the block.

```jsonc
{
"decisions": {
  "decision_ollama_1": {
    "writer": "decision_ollama",
    "model": "nimble",
    "questions": {
      "is_spam": { "kind": "yes_no", "question": "Is this email spam?", "threshold": 0.5, "values": ["yes", "no"] }
    },
    "usage": { "calls": 1, "input_tokens": 412 },
    "items": [
      { "lane": "text", "status": "ok",
        "preview": "Hi Dylan, following up on the invoice we sent…",
        "answers": { "is_spam": { "answer": "no", "confidence": 0.84, "probability": 0.08 } } }
    ]
  },
  "decision_ollama_2": {
    "writer": "decision_ollama",
    "model": "nimble",
    "questions": {
      "topic":    { "kind": "pick_one", "question": "What is this about?", "options": ["billing", "legal", "other"],
                  "values": ["billing", "legal", "other"] },
      "severity": { "kind": "rubric",   "question": "How urgent is it?",  "levels":  ["low", "medium", "high"],
                  "values": ["low", "medium", "high"] }
    },
    "usage": { "calls": 2, "input_tokens": 1630 },
    "items": [
      { "lane": "documents", "status": "ok", "item": { "chunkId": 0 },
        "preview": "Your invoice #4411 is now 30 days overdue…",
        "answers": {
          "topic":    { "answer": "billing", "confidence": 0.82,
                        "probabilities": { "billing": 0.91, "legal": 0.06, "other": 0.03 } },
          "severity": { "answer": "high", "index": 2, "score": 1.87, "confidence": 0.85,
                        "probabilities": { "low": 0.03, "medium": 0.07, "high": 0.9 } } } },
      { "lane": "documents", "status": "ok", "item": { "chunkId": 1 },
        "preview": "Please also see the attached terms, which…",
        "answers": {
          "topic":    { "answer": "uncertain", "best": "legal", "confidence": 0.11,
                        "probabilities": { "billing": 0.38, "legal": 0.44, "other": 0.18 } },
          "severity": { "answer": "low", "index": 0, "score": 0.41, "confidence": 0.62,
                        "probabilities": { "low": 0.66, "medium": 0.27, "high": 0.07 } } } },
      { "lane": "documents", "status": "too_long", "item": { "chunkId": 2 },
        "preview": "APPENDIX A — full transaction log…", "size": { "tokens": 9120, "limit": 8192 } }
    ]
  },
  "anomaly_detector_1": {
    "writer": "anomaly_detector",
    "questions": {
      "is_anomalous": { "kind": "yes_no", "values": ["yes", "no"] },
      "severity":     { "kind": "rubric", "levels": ["normal", "warning", "critical"], "values": ["normal", "warning", "critical"] },
      "score":        { "kind": "number" }
    },
    "items": [
      { "lane": "documents", "status": "ok", "item": { "chunkId": 9 },
        "preview": "reading 9",
        "answers": {
          "is_anomalous": { "answer": "yes" },
          "severity":     { "answer": "critical", "index": 2 },
          "score":        { "answer": 2.9938 } } }
    ]
  }
}
}
```

The `anomaly_detector_1` group shows a writer that isn't System One: it decides on the documents lane with no model. Notes on the fields:

- `writer` is the node type. The key (`decision_ollama_1`) is the component id.
- `usage` is free-form. Numbers in it are added up across writes.
- `preview` is the first 80 characters of the content, so a person reading the result can tell which item a record belongs to.
- `item` says which part of the object the record is about (`chunkId`, `table_index`, `fingerprint`). It is for people to read and for the Gate to match tables. A record with no `item` key describes the whole object.

### Required and optional fields

| Level | Required | Optional |
|---|---|---|
| group | `writer` (the node type); `questions` (each with a `kind`); `items` | `model`; `usage` (any object); per question, `values`, the complete list of answers the writer can record (strings, numbers or booleans; enables the Gate's value check); any other question metadata (`question` text, `threshold`, `options`, `levels`, …) |
| item | `lane`; `status`; `answers` when `status` is `ok` | `preview` (strongly recommended for text content); `item` (`chunkId`, `table_index`, `fingerprint`); `size`; `truncated` |
| answer | `answer`: a string, a finite number or a boolean | `confidence` (0 to 1); `index` (an integer position, used by the numeric operators); `best` (only with `answer: "uncertain"`); anything else, such as System One's `probability`, `probabilities` and `score` |

An `ok` item must answer exactly the questions its group declared, no more and no fewer. An item whose status isn't `ok` must not carry `answers`.

Floats are rounded to 4 decimal places when recorded.

## Standard kinds

`kind` describes the answer for people and for the Gate's canvas panel. **A Gate reads the `answer` value and `index`, never `kind`.** You can add a new kind without changing the Gate.

| kind | `answer` | Notes |
|---|---|---|
| `yes_no` | `"yes"` or `"no"` | System One, anomaly_detector. Always the strings, never booleans |
| `pick_one` | one of the question's `options` | System One |
| `rubric` | one of the question's `levels`, plus `index` | System One, anomaly_detector |
| `number` | a number | anomaly_detector's score; for example also a count |
| `label` | a free string | for example a language code |

Answers to a `yes_no` question are the strings `yes` and `no`, never booleans: a Gate's `equals yes` compares strings.

If your answers have an order (low, medium, high), set `index` to the position. The Gate's `gt`, `gte`, `lt`, `lte` and `between` operators compare `index` when it exists, and the `answer` itself only when it is a number.

## The Gate's value check

When a question header carries `values`, the Gate checks each condition on that question against it the first time it resolves the question, and raises a pipe error if the condition can never match. The check covers `equals`, `not_equals`, `in` and `not_in` (every member of a list), and the numeric operators and `between` for questions whose `values` are all strings (the bound must be a level position from 0 to the last level). `uncertain` is always allowed, and `exists` and `not_exists` are never checked. A writer that declares no `values` is not checked. The check runs even when the item itself was not decided (for example `too_long`). Messages look like:

```
Gate: "Yes" is not an answer "is_spam" can have (so_1 answers: yes, no). Values are case-sensitive.
Gate: gte 5 is out of range for "urgency": its answers are levels 0-2 (so_1: 0=low, 1=medium, 2=high).
```

Values are case-sensitive. Surrounding spaces in a condition value are trimmed first. Declare `values` for any question whose answers come from a closed set.

## Reserved values

These mean the same thing for every writer.

- **`answer: "uncertain"`.** The writer answered, but below its own confidence bar. It may add `best`, the answer it would have given. A Gate treats `uncertain` as an ordinary value: `equals yes` is false and `not_equals yes` is true.
- **`status` other than `"ok"`.** It means "no decision for this item, and here is why". System One uses `"too_long"`. anomaly_detector uses `"unsupported"` for a document it could not score: no metadata, or no usable metric (missing, not a number, or not finite). Another writer might use `"skipped"`. **Every Gate blocks an item with a non-`ok` status**, whatever the rule (including `not_equals`), and logs the status as a warning. Don't put `answers` on such an item.

## Linking an item to its decision

A Gate has to find the record that belongs to the item in front of it.

| Lane | How the item finds its decision |
|---|---|
| text, questions, answers, json, image, audio, video | **Object level.** Write an item with no `item` key. It applies to everything on these lanes. |
| documents | **Pass `doc=`.** `recordDecision` sets `doc.metadata.decision_refs[<component id>] = <item index>`. Several writers each add their own key. |
| table | **Pass `table=`.** `recordDecision` records `item.fingerprint`, the `"sha256:"` plus the SHA-256 of the exact table text as UTF-8, and a per-object `item.table_index`. When no fingerprint matches the table, the Gate falls back to the object-level decision. |

Chunks made from a stamped document inherit `decision_refs` through the usual metadata copy. They resolve to their parent's item. That is intended: a whole-document decision applies to its chunks.

Within one writer's group, a Gate looks for the object-level item (one with no `item` key) in this order: the one whose `lane` matches the incoming item's lane, then the `text` one, then the group's only object-level item. It uses the first tier that has any match. If that tier has more than one item, the Gate raises an error ("`<group>` holds N whole-object decisions that could apply to the <lane> lane") and does not fall through to the next tier.

Separately, if two different writers answer the same question name for the same item, the Gate raises an error ("`<question>` is answered by both `<a>` and `<b>`; rename one"). It never guesses. Use distinct question names across writers on the same path.

Per-item links for image, audio and video streams don't exist yet. Those lanes use the object-level decision.

In v1 the decision writers (System One on the text-based lanes and json, anomaly_detector on the documents lane) record nothing for image, audio or video items, so a Gate on one of those lanes has no decision to read and fails the object. Those lanes are for future writers that record an object-level decision before the item arrives.

## How to write decisions

Every node can record decisions. There's nothing to import and no base class to change. When the node has done its own work, it calls one method it already inherits from `IInstanceBase`, passing the questions it decides and the answers it reached:

```python
self.recordDecision(questions, answers, doc=..., table=..., lane=..., status='ok')
```

- **`questions`** is the node's fixed declaration, the same dict on every call: `{name: {'kind': ..., 'values': [...]}}`. `kind` is `yes_no`, `pick_one`, `rubric`, `number` or your own. Declare `values` (the answers it can give) so a Gate can reject a condition that can never match.
- **`answers`** is `{name: {'answer': ...}}`, with optional `confidence` (0-1) and `index`. An `ok` decision answers exactly the declared questions.
- **What it's about.** Pass exactly one of:
  - `doc=` for one document. Stamps `doc.metadata.decision_refs`, so the doc needs metadata.
  - `table=` for one table. Keyed by its fingerprint.
  - `lane=` for the whole object (`text`, `questions`, `answers`, `json`, ...), optionally with a `preview=`.
- **One whole-object decision per lane per object.** A `lane=` decision is recorded once per lane for each object. `writeText` and similar can be called many times for one object, so a node deciding on text should buffer it and record once from `closing()`. A second whole-object item on the same lane makes a Gate fail with "holds N whole-object decisions".
- **`status`** defaults to `'ok'`. To record "no decision, and why" (`'unsupported'`, `'too_long'`), pass a status and no answers. A Gate blocks an item without an `ok` decision.
- **`model=` and `usage=`** are optional, for model-backed writers. `size=` and `truncated=True` describe a too-long or trimmed input.

It returns the item's index in the node's group. Most nodes don't need it.

The anomaly_detector node is the worked example. It declares its questions once and records one decision per document, next to the metadata it already wrote:

```python
QUESTIONS = {
    'is_anomalous': {'kind': 'yes_no', 'values': ['yes', 'no']},
    'severity': {'kind': 'rubric', 'levels': ['normal', 'warning', 'critical'], 'values': ['normal', 'warning', 'critical']},
    'score': {'kind': 'number'},
}

# in writeDocuments, after the node's own metadata assignments:
self.recordDecision(QUESTIONS, _answers(result), doc=enriched_doc)
```

A document with no metadata can't carry a `decision_refs` stamp, so the node gives it fresh metadata and records `self.recordDecision(QUESTIONS, status='unsupported', doc=enriched_doc)`. A document with metadata but no usable numeric metric is recorded the same way, so it never passes a Gate as a confident `no`. A document with a numeric metric that is still warming up (insufficient data, zero variance) was scored, so it stays `ok`.

Rules:

- **Bad decisions raise in your node.** A malformed call raises `DecisionError` there, not in a Gate later. Let it propagate, and the engine fails the object.
- **A group's questions are fixed by its first write.** Recording again on the same object with different questions raises. The group is your node's component id, so two nodes of the same type never share one.
- **Record during the object.** Record from a lane method, or from `closing()`, which runs before `close()` while `currentObject` is still set. `recordDecision` keeps nothing on the instance, so it works whether or not your node defines `open()`.
- **Don't remove or edit earlier items.** Item positions are the ids that `decision_refs` point to.
- **Let unchanged data forward by default.** Recording a decision doesn't change the data. For lanes you pass on as they came (text, table, questions, answers, json), don't call `self.instance.write*`; the engine forwards the original. For documents, forward your stamped copies with `self.instance.writeDocuments(stamped)` and then `return self.preventDefault()`, so the unstamped originals aren't forwarded as well.
- **Reading decisions** is the Gate's job. If a node must read them, use `ai.common.decision.snapshot(response)` for a plain copy. Never hold on to the live `response['decisions']` view.

## System One as a worked example

The [System One node](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/decision_systemone/README.md) asks typed questions (yes/no, pick-one, rubric) with a System One model. It writes one group per node, one item per text, document, table, question, answer or JSON item it decides, stamps the documents it forwards, and records `too_long` items instead of answering from part of an input. It's one standalone class, the node's `IInstance`. It owns its lanes (buffering text until `closing()`, deciding and stamping each document, tables, questions, answers and JSON), asks its runner about each item, and records every answer with `self.recordDecision`. Its code is in the node folder, `nodes/src/nodes/decision_systemone/`. Read it for a full writer, and read the [Gate node](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/gate/README.md) for the reader.

For how users combine the two, see [Decisions and Gates](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/public/product/guides/decisions-and-gates.md).

## Known v1 limitations

- No design-time Gate dropdowns or typo checks in `validate()` or the canvas. A typo in a Gate's question name or value fails at run time. A value is checked only when the writer declares `values` in its question header.
- No whole-pipeline validation of Gate rules against the writers upstream.
- anomaly_detector decides on the documents lane only. Its text lane still annotates the text and records nothing.
