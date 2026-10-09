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

This example has two System One groups (one on text, one on chunks) and one writer that isn't System One. Notes on the fields follow the block.

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
    "questions": { "anomaly_score": { "kind": "number" } },
    "items": [
      { "lane": "table", "status": "ok", "item": { "table_index": 0, "fingerprint": "sha256:9f2c…" },
        "preview": "| Date | Amount | Status |…",
        "answers": { "anomaly_score": { "answer": 0.93 } } }
    ]
  }
}
}
```

The `anomaly_detector_1` group is an illustration of a writer that isn't System One. No such node exists yet. Notes on the fields:

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
| `yes_no` | `"yes"` or `"no"` | System One |
| `pick_one` | one of the question's `options` | System One |
| `rubric` | one of the question's `levels`, plus `index` | System One |
| `number` | a number | for example an anomaly score or a count |
| `label` | a free string | for example a language code |

If your answers have an order (low, medium, high), set `index` to the position. The Gate's `gt`, `gte`, `lt`, `lte` and `between` operators compare `index` when it exists, and the `answer` itself only when it is a number.

## Reserved values

These mean the same thing for every writer.

- **`answer: "uncertain"`.** The writer answered, but below its own confidence bar. It may add `best`, the answer it would have given. A Gate treats `uncertain` as an ordinary value: `equals yes` is false and `not_equals yes` is true.
- **`status` other than `"ok"`.** It means "no decision for this item, and here is why". System One uses `"too_long"`. Another writer might use `"skipped"` or `"unsupported"`. **Every Gate blocks an item with a non-`ok` status**, whatever the rule (including `not_equals`), and logs the status as a warning. Don't put `answers` on such an item.

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

Import from `ai.common.decision`. It has no dependency on System One or on `rocketlib`.

```python
from ai.common.decision import fingerprint, preview, record

QUESTIONS = {'anomaly_score': {'kind': 'number'}}


def writeTable(self, table: str):
    """Record one anomaly score for ``table``, then forward the table unchanged."""
    # Look the path up fresh on every write. Don't keep the response between calls.
    record(
        self.instance.currentObject.response,
        group_id,                          # your component id, e.g. 'anomaly_detector_1'
        writer='anomaly_detector',         # your node type
        questions=QUESTIONS,
        item={
            'lane': 'table',
            'status': 'ok',
            'item': {'table_index': table_index, 'fingerprint': fingerprint(table)},
            'preview': preview(table),
            'answers': {'anomaly_score': {'answer': score(table)}},
        },
    )
    # Don't call self.instance.writeTable(). The engine forwards the table by default.
```

For documents, record the item, then stamp the copy you forward (`from ai.common.decision import record, stamp`):

```python
index = record(self.instance.currentObject.response, group_id, writer=WRITER,
               questions=QUESTIONS, item=item)
stamp(doc_copy, group_id, index)
```

`record` returns the item's index in its group.

Rules:

- **`record` validates and raises.** A bad item raises `DecisionError` in your node, so you find the bug there and not in a Gate later. Let it propagate. The engine fails the object.
- **A group's questions are fixed by its first write.** Writing again with different questions, or a different `writer`, to the same group id raises.
- **Look the path up fresh on every write.** `response['decisions']` is a live view onto the stored value. Never hold on to it, or to anything under it, across writes or across objects. `record` already does this. If you read decisions yourself, call `snapshot(response)` for a plain copy (it returns `None` when nothing is recorded).
- **Don't remove or edit earlier items.** Item positions are ids that `decision_refs` points to.
- **Let unchanged data forward by default.** Writing a decision doesn't change the data. For lanes you pass on as they came (text, table, questions, answers), don't call `self.instance.write*`; the engine forwards the original. For documents, forward your stamped copies with `self.instance.writeDocuments(stamped)` and then `return self.preventDefault()`, so the unstamped originals aren't forwarded as well.
- **Use your own component id as the group id** (the `id` of `self.instance.pipeType`), so two nodes of the same type don't share a group.

## System One as a worked example

The [System One node](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/decision_systemone/README.md) asks typed questions (yes/no, pick-one, rubric) with a System One model. It writes one group per node, one item per text, document, table, question or answer it decides, stamps the documents it forwards, and records `too_long` items instead of answering from part of an input. Its code is in `packages/ai/src/ai/common/systemone/`. Read it for a full writer, and read the [Gate node](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/gate/README.md) for the reader.

For how users combine the two, see [Decisions and Gates](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/public/product/guides/decisions-and-gates.md).
