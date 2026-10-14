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
      "is_spam": { "kind": "yes_no", "question": "Is this email spam?", "threshold": 0.5 }
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
      "topic":    { "kind": "pick_one", "question": "What is this about?", "options": ["billing", "legal", "other"] },
      "severity": { "kind": "rubric",   "question": "How urgent is it?",  "levels":  ["low", "medium", "high"] }
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
| group | `writer` (the node type); `questions` (each with a `kind`); `items` | `model`; `usage` (any object); any question metadata (`question` text, `threshold`, `options`, `levels`, …) |
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

## Reserved values

These mean the same thing for every writer.

- **`answer: "uncertain"`.** The writer answered, but below its own confidence bar. It may add `best`, the answer it would have given. A Gate treats `uncertain` as an ordinary value: `equals yes` is false and `not_equals yes` is true.
- **`status` other than `"ok"`.** It means "no decision for this item, and here is why". System One uses `"too_long"`. anomaly_detector uses `"unsupported"` for a document it could not score: no metadata, or no usable metric (missing, not a number, or not finite). Another writer might use `"skipped"`. **Every Gate blocks an item with a non-`ok` status**, whatever the rule (including `not_equals`), and logs the status as a warning. Don't put `answers` on such an item.

## Linking an item to its decision

A Gate has to find the record that belongs to the item in front of it.

| Lane | How the item finds its decision |
|---|---|
| text, questions, answers, json, image, audio, video | **Object level.** Write an item with no `item` key. It applies to everything on these lanes. |
| documents | **Stamp the document.** `stamp(doc, group_id, index)` sets `doc.metadata.decision_refs = {"<component id>": <item index>}`. Several writers each add their own key. |
| table | **Fingerprint.** Put `fingerprint(table)` in `item` as `fingerprint`, and a running `table_index`. The fingerprint is `"sha256:"` plus the SHA-256 of the table string as UTF-8. When no fingerprint matches the table, the Gate falls back to the object-level decision. |

Chunks made from a stamped document inherit `decision_refs` through the usual metadata copy. They resolve to their parent's item. That is intended: a whole-document decision applies to its chunks.

Within one writer's group, a Gate looks for the object-level item (one with no `item` key) in this order: the one whose `lane` matches the incoming item's lane, then the `text` one, then the group's only object-level item. It uses the first tier that has any match. If that tier has more than one item, the Gate raises an error ("`<group>` holds N whole-object decisions that could apply to the <lane> lane") and does not fall through to the next tier.

Separately, if two different writers answer the same question name for the same item, the Gate raises an error ("`<question>` is answered by both `<a>` and `<b>`; rename one"). It never guesses. Use distinct question names across writers on the same path.

Per-item links for image, audio and video streams don't exist yet. Those lanes use the object-level decision.

In v1 the only decision writer (System One) reads text-based lanes, so a Gate on an image, audio, video or json lane has no decision to read and fails the object. Those lanes are for future writers that record an object-level decision before the item arrives.

## How to write decisions

Import from `ai.common.decision`. It has no dependency on System One or on `rocketlib`. There are two ways in.

### An existing node: `DecisionRecorder`

Use this when the node already makes a judgement and you want it to be routable without changing the node's shape. Build one recorder in `open()`, and call it where the node already judges. It owns the contract: group id, writer type, the questions header, stamping and fingerprints.

| Method | Use it for |
|---|---|
| `record_document(doc, answers, usage=None)` | One document. Stamps `doc.metadata.decision_refs`. The doc needs metadata. |
| `record_object(lane, answers, preview=None, usage=None, extra=None)` | One whole-object decision (text, questions, answers). |
| `record_table(table, answers, usage=None)` | One table, keyed by its fingerprint with a running `table_index`. |
| `record_status(lane, status, doc=None, table=None, preview=None, size=None, extra=None)` | "No decision, and why" (`too_long`, `unsupported`). Linked to `doc` or `table` when given. |

Each returns the item's index in its group.

The anomaly_detector node is the worked example. It declares its questions once, builds the recorder in `open()`, and records one decision per document next to the metadata it already wrote:

```python
QUESTIONS = {
    'is_anomalous': {'kind': 'yes_no', 'values': ['yes', 'no']},
    'severity': {'kind': 'rubric', 'levels': ['normal', 'warning', 'critical'], 'values': ['normal', 'warning', 'critical']},
    'score': {'kind': 'number'},
}


def open(self, obj):
    """Initialize instance for a new object: a fresh decision recorder."""
    self.decisions = DecisionRecorder(self, QUESTIONS)


# in writeDocuments, after the node's own metadata assignments:
self.decisions.record_document(enriched_doc, _answers(result))
```

A document with no metadata cannot carry a `decision_refs` stamp, so the node gives it fresh metadata and records it with `record_status('documents', 'unsupported', doc=...)`.
A document with metadata but no usable numeric metric is recorded the same way, so it never passes a Gate as a confident `no`. A document with a numeric metric that is still warming up (insufficient data, zero variance) was scored, so it stays `ok`.

### A node whose only job is to decide: `DecisionWriterBase`

Use this when the node's whole purpose is to decide, as System One's is. The base owns the lane plumbing: it buffers text and decides once at `closing`, decides and stamps each document, records tables, questions and answers, records `too_long` instead of answering from part of an input, and forwards the data unchanged. You implement two methods:

```python
from ai.common.decision.writer import Decided, DecisionWriterBase, TooLong


class IInstance(DecisionWriterBase):
    def questions(self) -> dict:
        return {'is_long': {'kind': 'yes_no', 'values': ['yes', 'no']}}

    def decide(self, state, lane):
        if len(str(state)) > 100_000:
            return TooLong({'bytes': len(str(state)), 'limit': 100_000})
        return Decided({'is_long': {'answer': 'yes' if len(str(state)) > 500 else 'no'}})
```

`decide` returns `Decided(answers, usage=None)` or `TooLong(size)`. Raise for any other failure; it stops the object. Optional hooks, each with a sensible default:

- `model()`: the model name recorded on the group.
- `oversize(state)`: the measured size when `state` is over your limits, checked before `decide`.
- `document_state(doc)`: the state to decide on for a document; raise `ValueError` to reject it.
- `question_state(question)`: `(state, truncated_size_or_None)` for a question; raise `ValueError` to reject it.
- `too_long_message(lane, size)`: the error for a whole-object input that is too long.
- `size_text(size)`: how a size reads in messages.

The recorder is available as `self.decisions` for anything the lanes don't cover. `ai.common.decision.writer` imports `rocketlib`, so import it only from node code.

### Writing the contract directly

Both of the above call `record`. You can call it yourself when neither fits:

```python
from ai.common.decision import fingerprint, preview, record, stamp

index = record(self.instance.currentObject.response, group_id, writer='my_node',
               questions=QUESTIONS, item=item)
stamp(doc_copy, group_id, index)   # documents only
```

`record` returns the item's index in its group.

Rules:

- **`record` validates and raises.** A bad item raises `DecisionError` in your node, so you find the bug there and not in a Gate later. Let it propagate. The engine fails the object.
- **A group's questions are fixed by its first write.** Writing again with different questions, or a different `writer`, to the same group id raises.
- **Look the path up fresh on every write.** `response['decisions']` is a live view onto the stored value. Never hold on to it, or to anything under it, across writes or across objects. `record` already does this. If you read decisions yourself, call `snapshot(response)` for a plain copy (it returns `None` when nothing is recorded).
- **Don't remove or edit earlier items.** Item positions are ids that `decision_refs` points to.
- **Let unchanged data forward by default.** Writing a decision doesn't change the data. For lanes you pass on as they came (text, table, questions, answers), don't call `self.instance.write*`; the engine forwards the original. For documents, forward your stamped copies with `self.instance.writeDocuments(stamped)` and then `return self.preventDefault()`, so the unstamped originals aren't forwarded as well.
- **Use your own component id as the group id** (the `id` of `self.instance.pipeType`), so two nodes of the same type don't share a group. The recorder does this for you.

## System One as a worked example

The [System One node](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/decision_systemone/README.md) asks typed questions (yes/no, pick-one, rubric) with a System One model. It writes one group per node, one item per text, document, table, question or answer it decides, stamps the documents it forwards, and records `too_long` items instead of answering from part of an input. It subclasses `DecisionWriterBase` and overrides `questions`, `model`, `decide`, `oversize`, `document_state` (type and empty checks, the runner's state), `question_state` (fitting history and documents to the model) and `too_long_message`; the lanes themselves are the base's. Its code is in `packages/ai/src/ai/common/systemone/`. Read it for a full writer, and read the [Gate node](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/gate/README.md) for the reader.

For how users combine the two, see [Decisions and Gates](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/public/product/guides/decisions-and-gates.md).

## Known v1 limitations

- No design-time Gate dropdowns or typo checks in `validate()` or the canvas. A typo in a Gate's question name or value fails at run time (see `values` in a question header, which later work uses for this).
- No whole-pipeline validation of Gate rules against the writers upstream.
- anomaly_detector decides on the documents lane only. Its text lane still annotates the text and records nothing.
