# Decisions metadata

`metadata.decisions` is the contract a node uses to attach typed answers to a
document so that later nodes can act on them. The System One Ask nodes
([`decision_systemone`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/decision_systemone/README.md))
write it, and the Router node reads it to branch.

## For node authors

Any node may write `metadata.decisions.<name>` using the shape below, so that the Router
can branch on it. Follow the rules in [Location](#location): merge into the namespace,
never replace it, and set `source` to your own component id. Keep `answer` a plain string,
number or boolean, because that is the value routes match on.

## Location

```
doc.metadata.decisions: { <name>: Decision }
```

- `DocMetadata` allows extra fields (`extra='allow'`, `packages/client-python/src/rocketride/schema/doc_metadata.py:113`), so no schema change is needed.
- `decisions` is a namespace shared across nodes. Writers **merge** into it and never replace it wholesale.
- If a name already exists, the new value overwrites the old one and the node logs `warning()` naming the node that wrote it first (from `source`).

## `Decision` shape

Common fields:

| Field | Type | Meaning |
|---|---|---|
| `kind` | `'yes_no' \| 'pick_one' \| 'rubric'` | The kind of question |
| `answer` | see per-kind below | **The value routes match on.** Always a string, number or boolean, never an object. |
| `confidence` | float 0..1 | See per-kind. **Not comparable across backends.** |
| `uncertain` | bool | `true` when `confidence < min_confidence` (then `answer` is `'uncertain'`), or when the call failed under `pass_through` (then `answer` is `'error'`, see below). |
| `model` | string | The versioned model id that answered (from the response) |
| `source` | string | The component id of the writing node |

Per-kind fields:

| kind | `answer` | Extra fields | `confidence` |
|---|---|---|---|
| `yes_no` | `'yes'` \| `'no'` \| `'uncertain'` | `probability` = P(yes) | Margin from the threshold, scaled to 0..1 (the pydantic-ai convention): yes = `(p − t)/(1 − t)`, no = `(t − p)/t` |
| `pick_one` | the option `value` \| `'uncertain'` | `probabilities: {value: p}` (all options) | The backend's `confidence` as returned; if it returns none, the probability spread `(top − 1/n)/(1 − 1/n)` for `n` options |
| `rubric` | the **argmax level index** (int) \| `'uncertain'` | `score` (float, expected level), `level` (the argmax level's description), `probabilities: {"0": p, ...}` | The backend's `confidence` as returned; if it returns none, the probability spread `(top − 1/n)/(1 − 1/n)` for `n` options |

`'uncertain'` and `'error'` are **reserved** and can't be used as option values.

## Errors under `pass_through`

When a call fails and `on_error = pass_through`, every question in the node gets:

`{kind, answer: 'error', uncertain: true, confidence: 0, error: '<message>', model: null, source}`

The document is still forwarded, so a Router can send errors to their own branch.

Configuration errors (HTTP 401, 403 and 404) are not covered by `pass_through`: they always
fail the object.

## `answers` lane payload

Decision-only consumers (analytics, API callers) get one `Answer(expectJson=True)` per document:

```json
{ "objectId": "...", "chunkId": 0, "parent": "tickets/123.txt",
  "decisions": { "urgent": { ... }, "team": { ... } },
  "usage": { "input_tokens": 296, "output_tokens": 20 } }
```

`usage` is `null` when the call failed under `pass_through`.

## Related metadata

When the Ask node had to cut a document's text to fit the backend's input limit, it sets
`metadata.decisions_truncated = true` on the forwarded document. This is a sibling of
`decisions`, not an entry inside it. Only the text sent to the model is cut; the document
that continues down the pipeline is complete.

## Example

After an Ask node with two yes/no questions and one pick-one question:

```json
{ "urgent": { "kind": "yes_no", "answer": "yes", "probability": 0.93, "confidence": 0.86, "uncertain": false, "model": "jev-1.13.0", "source": "decision_typesafe_1" },
  "outage": { "kind": "yes_no", "answer": "no",  "probability": 0.21, "confidence": 0.58, "uncertain": false, "model": "jev-1.13.0", "source": "decision_typesafe_1" },
  "team":   { "kind": "pick_one", "answer": "technical", "probabilities": {"billing": 0.08, "technical": 0.9, "sales": 0.02}, "confidence": 0.85, "uncertain": false, "model": "jev-1.13.0", "source": "decision_typesafe_1" } }
```
