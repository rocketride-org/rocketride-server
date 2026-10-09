# decision_systemone

A RocketRide pipeline node that asks typed questions (yes/no, pick-one, rubric) about each item with a System One decision model and records the answers on the object at `response.decisions`, where Gate nodes read them.

## About TypeSafe

TypeSafe develops System One decision models such as Jev. Instead of generating
text, these models answer a fixed set of typed questions about a piece of text
and return a probability for each possible answer. The same request format is
served by several other backends, including Ollama.

## What it does

The node makes **one model call per item** (`POST /v1/systemone`) and sends all of its
configured questions in that call. An item is the whole text of an object (buffered until
the object's text ends), each document, each table, the question, or the answer. Several
lanes may be wired on one node, and every lane gets the same questions. The answers are
recorded on the object at `response.decisions`, where a Gate node reads them to pass or
block. Documents are forwarded with `metadata.decision_refs` pointing at their recorded
answers; text, tables, questions and answers are forwarded unchanged. The node never
decides on part of an input. Use it for cheap classification and gating ahead of costly
steps; it does not generate text and is not an agent tool. The recorded format is
described in [Decisions](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/development/nodes/decisions.md); routing on it is done by the Gate node.

## Lanes

| Lane in     | Lane out    | Description                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------- |
| `text`      | `text`      | One item per object: all of its text, decided once when the text ends, then replayed in order |
| `documents` | `documents` | One item per document; forwarded stamped with `metadata.decision_refs`                        |
| `table`     | `table`     | One item per table, recorded under its fingerprint; forwarded unchanged                       |
| `questions` | `questions` | One item per question, with its history, context and documents; forwarded unchanged           |
| `answers`   | `answers`   | One item per answer (its JSON when it is JSON, else its text); forwarded unchanged            |

A document or table with empty content, a document that is not text, and an empty text,
question or answer fail the object with an error that names the node.

## Profiles

System One (custom endpoint) default: **Custom** (`custom`). Ollama default: **Nimble** (`nimble`). TypeSafe Jev and OpenRouter default: **Jev (latest)** (`jev-latest`).

The directory registers four canvas nodes that share one implementation. Each has its own
`custom` profile; the table lists it once.

| Profile                       | Node                          | Model sent to the endpoint                  |
| ----------------------------- | ----------------------------- | ------------------------------------------- |
| `custom` **(default)**        | All four nodes                | _(user-specified)_                          |
| `jev-latest` **(default)**    | TypeSafe Jev, OpenRouter      | `jev-latest` (TypeSafe), `~typesafe/jev-latest` (OpenRouter) |
| `jev-1-13-0`                  | TypeSafe Jev                  | `jev-1.13.0`                                |
| `jev-1-13`                    | OpenRouter (System One)       | `typesafe/jev-1.13`                         |
| `nimble` **(default)**        | Ollama (System One)           | `nimble`                                    |
| `tev1`                        | Ollama (System One)           | `tev1`                                      |

## Configuration

The four nodes differ only in their preset: the server URL, the model names and the
backend limits are pinned by the profile. The questions are configured identically on all
of them. Pick the profile first; on the custom endpoint node, also set the server URL
(`/v1/systemone` is appended unless the URL already ends in `/v1`) and the model name as
the endpoint serves it. The per-backend limits are listed under [Limits by backend](#limits-by-backend).

The question set is checked when the pipeline starts, before any item flows. Validating the
configuration also makes one live yes/no call to the backend and reports a failure as a warning. The
node refuses to start if a name is invalid or duplicated, an option or level count is
outside the backend's limits, or no question is configured.

### Questions

There are three arrays, one per question kind. Every question needs a `name` and a
`question`.

| Array      | Kind       | Recorded `answer`                                             |
| ---------- | ---------- | ------------------------------------------------------------- |
| `yes_no`   | Yes/No     | `yes`, `no` or `uncertain`                                    |
| `pick_one` | Pick-one   | The chosen option value, or `uncertain`                       |
| `rubric`   | Rubric     | The index of the most probable level (integer), or `uncertain` |

- **Name** is the question name; a Gate node refers to it. It must be lowercase letters, digits
  and `_`, start with a letter, and be at most 48 characters. Names must be unique across
  all three arrays, and a node holds at most 64 questions.
- **Question** is sent to the model as the instructions. For a yes/no question, phrase it
  so that a high value means yes. The questions in one call are answered independently and never see each
  other's answers.
- Each question can optionally set **Minimum confidence**.

Write questions about what the document says, and phrase each one so that the answer
you want is the one the model scores. Breaking a judgment into several small questions
and combining the answers in a Gate works better than one broad question.

### Yes/No questions

**Yes means** and **No means** are optional descriptions of what each answer stands for;
leave them empty for a self-explanatory question. **Yes threshold** (default 0.5, strictly
between 0 and 1) is applied by the node, not by the backend: the answer is `yes` when the
reported probability of yes is at least the threshold. Raise it to make `yes` rarer.

### Options

For a pick-one question, enter one option per line as `value | optional description`.
The value is what ends up in `answer` and what a Gate node matches on, so it must be 1 to 64
characters of letters, digits, `_` or `-`. `uncertain` is reserved and cannot be
used as a value. Values must be unique within a question, and the count must be between 2
and the backend's option limit.

```text
billing | Payments, invoices and refunds
bug | Something is broken in the software
account
```

Keep descriptions short and about the situation. Ollama accepts only string descriptions,
so on Ollama nodes an option without a description is sent with its value as the
description.

### Levels

For a rubric question, enter one level description per line, level 0 first. There must be
between 2 and the backend's level limit. Describe a situation rather than a degree:
"Something is broken but there is a workaround" is more useful to the model than
"Moderate". The answer is the integer index of the most probable level; the decision also
carries the expected `score` and the text of the chosen `level`.

```text
Nothing is wrong
Something is broken but there is a workaround
Something is broken and there is no workaround
```

### Minimum confidence

The model returns a confidence with every answer. When it is below the question's
**Minimum confidence** (default 0, so never), the answer is replaced with the string
`uncertain` and `uncertain` is set to `true`, so a Gate node can block it or send it to review. Confidence is computed as follows:

- Yes/No: the margin from the threshold, scaled to 0 to 1. For `yes`, `(p - t) / (1 - t)`;
  for `no`, `(t - p) / t`, where `p` is the probability of yes and `t` the threshold.
- Pick-one and rubric: the confidence the backend returned. If the backend returns none,
  the node uses the spread of the probabilities, `(top - 1/n) / (1 - 1/n)` for `n` options.

Confidence is not comparable across backends. See [Notes](#confidence-does-not-transfer-between-backends).

### Metadata to include

By default the model sees only the document text. This setting applies to the `documents` lane. To also give it metadata, list the keys
(one per line, for example `parent`). The model then receives an object holding the
`content` and each listed key that the document actually has, and questions can refer to
those parts by name. Keys the document does not have are skipped. Included metadata
counts against the backend's input limits.

## Authentication

TypeSafe Jev and OpenRouter need an API key. The custom endpoint takes one only if the
endpoint requires it. Ollama needs none. To keep the key out of the pipeline file, enter an
environment reference in the **API Key** field and set the variable in the environment or
`.env`:

| Node                       | Suggested variable           |
| -------------------------- | ---------------------------- |
| TypeSafe Jev               | `ROCKETRIDE_TYPESAFE_KEY`    |
| OpenRouter (System One)    | `ROCKETRIDE_OPENROUTER_KEY`  |
| System One (custom endpoint) | `ROCKETRIDE_SYSTEMONE_KEY` (optional) |

For example `${ROCKETRIDE_TYPESAFE_KEY}`. The key is sent as a bearer token and is
omitted when the field is empty.

## Notes

### Limits by backend

Limits belong to the model, so each profile carries its own. The node checks the question
set against them at startup and checks each input against the input limit (see [Too long](#too-long)).

| Limit                  | Custom endpoint | TypeSafe Jev, OpenRouter (all profiles) | Ollama `nimble` | Ollama `tev1` | Ollama `custom` |
| ---------------------- | --------------- | --------------------------------------- | --------------- | ------------- | --------------- |
| Options per question   | 26              | 255                                     | 26              | 24            | 26              |
| Levels per rubric      | 26              | 10                                      | 26              | 26            | 26              |
| Questions per node     | 64              | 64                                      | 64              | 64            | 64              |
| Input, in tokens       | 8,000           | 32,000                                  | 8,192           | 2,048         | 8,000           |
| Characters per token   | 4               | 6                                       | 4               | 4             | 4               |
| Request body           | 65,536 bytes    | no cap applied                          | 65,536 bytes    | 65,536 bytes  | 65,536 bytes    |
| Option descriptions    | strings only    | objects allowed                         | strings only    | strings only  | strings only    |

The custom endpoint uses conservative, Ollama-level limits because the node cannot know
what an arbitrary server accepts. Characters per token is the node's own estimate, used
only to decide when an input is too long.

### Too long

The input limit is checked before the call, from characters per token, after reserving about
260 tokens of request overhead and room for the longest question and any included metadata,
and against the request body cap. If the backend still rejects the request as too large
(HTTP 413 or `max_tokens_exceeded`), the input counts as too long. The node never cuts an
input to fit and never sends part of it. What happens depends on the lane:

| Lane                 | When the input is too long                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `text`, `answers`    | The object fails, with a message to split the input first (for example with a preprocessor, then a System One node on the `documents` lane). |
| `documents`, `table` | The item is recorded with status `too_long`, which every Gate blocks, and the node logs a warning. The object continues. |
| `questions`          | History is dropped oldest first, then documents last first, until it fits. The recorded item is marked `truncated` and the node logs a warning. If the question alone does not fit, the object fails. |

### Errors and retries

Calls to the backend are retried up to 5 times with exponential backoff starting at 1 s and
capped at 60 s, honoring `Retry-After` and `retry-after-ms`. Retried responses are 429, 500,
502, 503, 504, 529 and network errors. Any failure to get a valid decision fails the object:
there is no pass-through mode, because a missing decision would otherwise look like a pass.

| Response                         | Meaning                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| 401, 403                         | Configuration error: check the API key.                                     |
| 404                              | Configuration error. On Ollama it usually means the model is not pulled; run `ollama pull <model>`. |
| 400, 422                         | The backend rejected the request.                                           |
| 413, `max_tokens_exceeded`       | The input is too long (see above).                                          |

An answer that is missing, of the wrong type, or out of range also fails the object.

### Confidence does not transfer between backends

Each backend computes `confidence` its own way, and Ollama states that its confidence is
not the chance that the answer is right. A `min_confidence` of 0.8 that works on Jev can reject nearly
everything on Ollama Nimble, or accept too much. Set thresholds per backend and test them on
your own documents; do not copy them when you change the profile.

### Jev's weak spots

TypeSafe documents a few things Jev answers badly. They apply when writing questions:

- **Literal reading.** It answers the question as written, not as meant. Say exactly what
  you want.
- **Maths and dates.** Counting, arithmetic, number formats such as hex colors, and date
  comparisons are unreliable, because dates are read as text. Compute these upstream.
- **First-option bias.** In pick-one questions the first option is favored. Do not rely on
  option order; check the distribution of answers on a sample of your own documents.

A question and its negation need not give probabilities that sum to 1, and a long document
with a lot of irrelevant detail can dilute the answer. Prefer several narrow questions.

### OpenRouter status

The OpenRouter node is shipped, with base URL `https://openrouter.ai/api` and the models
`~typesafe/jev-latest` and `typesafe/jev-1.13`. The endpoint was verified from OpenRouter's
documentation and a route probe that returned 401 without a key. No live call has been made
yet; it is pending an API key. Treat this node as unverified against the live service until
that is done.

### Clef is not offered

Ollama also serves `clef`, which is omitted here: Clef is the vision model and this node is text-only in v1.

### Testing

`services.ollama.json` carries a `test` block that runs a Nimble decision against a
local Ollama and checks that the forwarded document carries a decision reference. It is skipped unless `ROCKETRIDE_SYSTEMONE_OLLAMA` is set.

## Upstream docs

- [Introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe documentation](https://docs.typesafe.ai)
- [Ollama: decision models](https://docs.ollama.com/capabilities/decision)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### System One (custom endpoint) (`services.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `decision.apikey` | `string` | **API Key**<br/>Only needed if the endpoint requires authentication | `""` |
| `decision.levels` | `string` | **Levels**<br/>One per line, level 0 first; describe the situation, not a degree |  |
| `decision.min_confidence` | `number` | **Minimum confidence**<br/>Below this the answer is 'uncertain'. Confidence is not comparable across backends. | `0` |
| `decision.model` | `string` | **Model**<br/>Model name as served by the backend |  |
| `decision.name` | `string` | **Name**<br/>Question name; the Gate refers to it (lowercase, digits, _) |  |
| `decision.no_means` | `string` | **No means** |  |
| `decision.options` | `string` | **Options**<br/>One per line: value \| optional description |  |
| `decision.pick_one` | `array` | **Pick-one questions** |  |
| `decision.question` | `string` | **Question**<br/>Phrase it so a high value means yes |  |
| `decision.rubric` | `array` | **Rubric questions** |  |
| `decision.serverbase` | `string` | **Server URL**<br/>Base URL; /v1/systemone is appended |  |
| `decision.state_metadata` | `string` | **Metadata to include**<br/>Metadata keys (one per line) sent alongside the content, e.g. parent |  |
| `decision.threshold` | `number` | **Yes threshold** | `0.5` |
| `decision.yes_means` | `string` | **Yes means** |  |
| `decision.yes_no` | `array` | **Yes/No questions** |  |
| `decision_systemone.profile` | `string` | **Model** | `"custom"` |

### Ollama (System One) (`services.ollama.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `decision.levels` | `string` | **Levels**<br/>One per line, level 0 first; describe the situation, not a degree |  |
| `decision.min_confidence` | `number` | **Minimum confidence**<br/>Below this the answer is 'uncertain'. Confidence is not comparable across backends. | `0` |
| `decision.model` | `string` | **Model**<br/>Model name as served by the backend |  |
| `decision.name` | `string` | **Name**<br/>Question name; the Gate refers to it (lowercase, digits, _) |  |
| `decision.no_means` | `string` | **No means** |  |
| `decision.options` | `string` | **Options**<br/>One per line: value \| optional description |  |
| `decision.pick_one` | `array` | **Pick-one questions** |  |
| `decision.question` | `string` | **Question**<br/>Phrase it so a high value means yes |  |
| `decision.rubric` | `array` | **Rubric questions** |  |
| `decision.serverbase` | `string` | **Server URL**<br/>Base URL; /v1/systemone is appended |  |
| `decision.state_metadata` | `string` | **Metadata to include**<br/>Metadata keys (one per line) sent alongside the content, e.g. parent |  |
| `decision.threshold` | `number` | **Yes threshold** | `0.5` |
| `decision.yes_means` | `string` | **Yes means** |  |
| `decision.yes_no` | `array` | **Yes/No questions** |  |
| `decision_ollama.profile` | `string` | **Model** | `"nimble"` |

### OpenRouter (System One) (`services.openrouter.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `decision.apikey` | `string` | **API Key** | `""` |
| `decision.levels` | `string` | **Levels**<br/>One per line, level 0 first; describe the situation, not a degree |  |
| `decision.min_confidence` | `number` | **Minimum confidence**<br/>Below this the answer is 'uncertain'. Confidence is not comparable across backends. | `0` |
| `decision.model` | `string` | **Model**<br/>Model name as served by the backend |  |
| `decision.name` | `string` | **Name**<br/>Question name; the Gate refers to it (lowercase, digits, _) |  |
| `decision.no_means` | `string` | **No means** |  |
| `decision.options` | `string` | **Options**<br/>One per line: value \| optional description |  |
| `decision.pick_one` | `array` | **Pick-one questions** |  |
| `decision.question` | `string` | **Question**<br/>Phrase it so a high value means yes |  |
| `decision.rubric` | `array` | **Rubric questions** |  |
| `decision.serverbase` | `string` | **Server URL**<br/>Base URL; /v1/systemone is appended |  |
| `decision.state_metadata` | `string` | **Metadata to include**<br/>Metadata keys (one per line) sent alongside the content, e.g. parent |  |
| `decision.threshold` | `number` | **Yes threshold** | `0.5` |
| `decision.yes_means` | `string` | **Yes means** |  |
| `decision.yes_no` | `array` | **Yes/No questions** |  |
| `decision_openrouter.profile` | `string` | **Model** | `"jev-latest"` |

### TypeSafe Jev (`services.typesafe.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `decision.apikey` | `string` | **API Key** | `""` |
| `decision.levels` | `string` | **Levels**<br/>One per line, level 0 first; describe the situation, not a degree |  |
| `decision.min_confidence` | `number` | **Minimum confidence**<br/>Below this the answer is 'uncertain'. Confidence is not comparable across backends. | `0` |
| `decision.model` | `string` | **Model**<br/>Model name as served by the backend |  |
| `decision.name` | `string` | **Name**<br/>Question name; the Gate refers to it (lowercase, digits, _) |  |
| `decision.no_means` | `string` | **No means** |  |
| `decision.options` | `string` | **Options**<br/>One per line: value \| optional description |  |
| `decision.pick_one` | `array` | **Pick-one questions** |  |
| `decision.question` | `string` | **Question**<br/>Phrase it so a high value means yes |  |
| `decision.rubric` | `array` | **Rubric questions** |  |
| `decision.serverbase` | `string` | **Server URL**<br/>Base URL; /v1/systemone is appended |  |
| `decision.state_metadata` | `string` | **Metadata to include**<br/>Metadata keys (one per line) sent alongside the content, e.g. parent |  |
| `decision.threshold` | `number` | **Yes threshold** | `0.5` |
| `decision.yes_means` | `string` | **Yes means** |  |
| `decision.yes_no` | `array` | **Yes/No questions** |  |
| `decision_typesafe.profile` | `string` | **Model** | `"jev-latest"` |

## Dependencies

- `httpx`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/decision_systemone)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
