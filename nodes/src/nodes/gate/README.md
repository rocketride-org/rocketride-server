# gate

A RocketRide pipeline node that passes or blocks each item on its wire according to the decisions a node upstream, such as a System One node, recorded on the object at `response.decisions`.

## What it does

The Gate reads `response.decisions` and evaluates its rule against the answers recorded there. It checks documents one by one and tables by their fingerprint. Everything else (text, questions, answers, json, image, audio, video) is checked against the decision for the whole object. A passing item is forwarded unchanged on the same lane; a failing item is dropped. `open`, `closing` and `close` always continue; only data writes are filtered. The Gate never calls a model and does not depend on System One: it works with any node that records decisions in the [Decisions](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/development/nodes/decisions.md) format. Put one Gate on each branch, with the rule for that branch.

## Example pipelines

**Drop spam, then keep only billing and refund chunks**

`parse → system_one (is_spam) → gate (is_spam equals no) → preprocessor → system_one (topic) → gate (topic is one of billing, refund) → response`

The first System One node classifies the whole text, and the first Gate passes it only when `is_spam` is `no`. The preprocessor splits the text into documents, a second System One node classifies each one as `billing`, `refund`, `legal` or `other`, and the second Gate forwards only the documents whose `topic` is `billing` or `refund`. A second Gate with `is_spam equals yes` on another branch from the first System One node handles the other side.

## Lanes

| Lane in     | Lane out    | Description                                                              |
| ----------- | ----------- | ------------------------------------------------------------------------ |
| `text`      | `text`      | Passed or blocked by the decision for the whole object                   |
| `documents` | `documents` | Each document is checked; those that pass are forwarded as one list      |
| `table`     | `table`     | Checked by the table's fingerprint, else by the decision for the object  |
| `questions` | `questions` | Passed or blocked by the decision for the whole object                   |
| `answers`   | `answers`   | Passed or blocked by the decision for the whole object                   |
| `json`      | `json`      | Passed or blocked by the decision for the whole object                   |
| `image`     | `image`     | Every call of the stream is checked, so the whole stream passes or is blocked |
| `audio`     | `audio`     | Every call of the stream is checked, so the whole stream passes or is blocked |
| `video`     | `video`     | Every call of the stream is checked, so the whole stream passes or is blocked |

## Configuration

Choose whether **all** or **any** of the conditions must hold, then list the conditions. Each condition names a question, an operator and, for most operators, a value. The question name is the one configured on the node that answers it (for example `is_spam` on a System One node). The Gate checks only the shape of the rule when the pipeline starts, not what is upstream.

### Conditions

A rule needs at least one condition. Values typed in the panel are text; when the recorded answer is a number or a boolean, the Gate converts the value to that type before comparing (`0.8` becomes the number 0.8, `true` the boolean). A value that cannot be converted makes the comparison false, except for the numeric operators (`>`, `≥`, `<`, `≤`, between), where the rule is rejected at startup.

### Operators

| Operator              | Value                                      | True when                                                |
| --------------------- | ------------------------------------------ | -------------------------------------------------------- |
| equals, does not equal | one value                                 | the answer equals the value, or does not                 |
| is one of, is none of | comma-separated list                       | the answer is in the list, or is not                     |
| `>`, `≥`, `<`, `≤`    | a number                                   | the comparison holds (see below)                         |
| between (inclusive)   | `low, high`                                | low ≤ the answer ≤ high                                  |
| is answered           | none                                       | the question has an answer that is not `uncertain`       |
| is uncertain          | none                                       | the answer is `uncertain`                                |

`equals` and `is one of` compare the recorded `answer` itself, so a rubric label is matched by its text. The numeric operators compare the answer's `index` when it has one (a rubric position), otherwise the `answer` when that is a number; for `uncertain` or a text label they are false.

`uncertain` is an ordinary answer value: `equals yes` is false for an uncertain answer, and `not_equals yes` is true. That is what lets `not_equals` act as "otherwise" (see [Limitations](#limitations)).

## Notes

### Limitations

- There is no "otherwise" branch and no invert. To handle the other side, add a second Gate with the opposite rule, usually with `does not equal`.
- A decision that is missing fails the object with an error that names the question, the lane and a preview of the item. The same happens when the object has no `response.decisions`.
- An item recorded with a status other than `ok`, such as `too_long`, is blocked by every Gate whatever the rule (including `does not equal` and `is uncertain`), and the Gate logs a warning that names the status.
- **The Gate must sit downstream of the node that answers its questions, on the same path.** Branches that run in parallel execute in an order the canvas does not show, so a Gate on a sibling branch can run before the decision exists and fail with a missing-decision error.
- A Gate on media or json can only use decisions recorded before the item arrives. A System One node decides on text when the object's text ends, so a decision on text is available to a media or json Gate only if it was recorded before that item reaches the Gate.

### Lanes and handles

The node declares all nine lanes as inputs and as outputs, so the canvas shows up to nine handles on each side and any lane can be connected; each lane goes out on the same lane it came in on. A single "any" handle is planned.

A document is checked by its own recorded answers when it carries `metadata.decision_refs` (a System One node stamps this on the documents it forwards). A document without its own reference, such as a chunk made after the decision, uses the decision for the whole object.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `gate.conditions` | `array` | **Conditions** |  |
| `gate.match` | `string` | **Pass when** | `"all"` |
| `gate.op` | `string` | **Operator** | `"equals"` |
| `gate.question` | `string` | **Question**<br/>Question name as configured on the node that answers it, e.g. is_spam |  |
| `gate.value` | `string` | **Value**<br/>One value; a comma-separated list for 'is one of'; 'low, high' for between; empty for answered/uncertain |  |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/gate)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
