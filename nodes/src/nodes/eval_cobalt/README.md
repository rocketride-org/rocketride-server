# eval_cobalt

A RocketRide filter node that scores answers flowing through the pipeline and emits the evaluation result alongside the original answer.

## What it does

Sits on the `answers` lane and grades each answer with a configurable evaluator, then forwards the answer together with a machine-readable score. Use it as a quality gate for LLM/RAG pipelines: every answer is scored against a reference (or judged standalone) and gets a pass/fail verdict against a threshold.

Six evaluator types are available:

- **similarity** — semantic similarity against the expected answer. Uses cobalt's similarity evaluator when **basalt-ai-cobalt** (`cobalt`) is installed; otherwise falls back to a deterministic Jaccard word-overlap score.
- **llm_judge** — an LLM (e.g. GPT-4, Claude) scores the answer against criteria. Requires both an API key and the `cobalt` package; without either it returns a zero score with a reason.
- **custom** — a user-supplied Python callable `(output, expected) -> score`/dict resolved from config or the pipeline bag.
- **relevance** — deterministic keyword-overlap + length-ratio heuristic (no dependencies).
- **grounding** — deterministic sentence-level check that the output's content words appear in the provided context (no dependencies).
- **format** — deterministic structural check that the output matches an expected shape (prose, list, code, json).

Key behavior to know:

- The answer is **deep-copied** before evaluation, so shared answer objects in fan-out pipelines are never mutated.
- **This node emits two answers per input** on the `answers` lane: the original answer unchanged, followed by a synthetic JSON score answer. Downstream consumers that assume a 1:1 answer count, or single-answer output sinks, must account for the doubling. See [Output](#output).
- Before scoring a JSON answer, reserved reference keys (`expected`, `context`, `reference`) are stripped from the payload so the evaluator never grades text that already contains the reference. The strip is **shallow (top-level keys only) and applies to dict-shaped JSON answers**; references nested in sub-objects or carried in plain text are not removed.
- The configured pass threshold is **clamped to [0.0, 1.0]** at construction, and every computed score is clamped to the same range per result, so an out-of-range config value can never produce a nonsensical verdict.
- For grounding mode, the `expected` argument is treated as the source context. Candidate context is resolved from metadata/answer context first, then falls back to the reference/expected answer as a last resort.
- **The reference is read from the answer's `metadata`**, so every node between the dataset and this one must carry metadata forward. When nothing resolves, `similarity`, `relevance`, and `grounding` score 0.0 with a debug log rather than an error — a pipeline scoring uniformly 0.0 usually means the reference never arrived, not that the answers were wrong.
- Evaluator failures are contained: any evaluator exception is caught and turned into a zero-score result with a reason, never an aborted pipeline.

---

## Configuration

### Lanes

| Lane in   | Lane out  | Description                                                        |
|-----------|-----------|--------------------------------------------------------------------|
| `answers` | `answers` | Forwards the original answer, then emits a JSON score answer      |

### Output

The score answer is a JSON `Answer` with these keys:

| Key | Type | Description |
|---|---|---|
| `cobalt_score` | number | Evaluation score, 0.0–1.0 |
| `cobalt_passed` | boolean | `true` when `score >= threshold` |
| `cobalt_evaluator` | string | Which evaluator produced the score (`semantic`, `llm_judge`, `custom`, `relevance`, `grounding`, `format`) |
| `cobalt_reasoning` | string | Human-readable explanation |

### Fields

| Field | Type | Description |
|---|---|---|
| `eval_type` | string | The evaluation strategy to run |
| `threshold` | number | Default 0.7. Minimum score (0.0–1.0) to pass; clamped to range |
| `model` | string | LLM model for judge mode (e.g. gpt-4, claude-3) |
| `criteria` | string | Criteria prompt for the LLM judge |
| `apikey` | string | LLM provider API key (secure/password field) for judge mode |
| `expected_format` | string | Default "prose". Structure to validate against: prose, list, code, json |
| `keyword_weight` | number | Default 0.7. Weight on keyword-overlap in relevance scoring |
| `length_weight` | number | Default 0.3. Weight on length-ratio in relevance scoring |
| `profile` | string | Default "similarity". Evaluator profile |

### Profiles

The **Evaluator** dropdown selects a preconfigured profile, each setting a sensible default threshold and exposing only the relevant fields:

| Profile      | Evaluator   | Default threshold | Extra fields exposed                     |
|--------------|-------------|-------------------|-------------------------------------------|
| `similarity` | Similarity  | 0.7               | —                                         |
| `llm_judge`  | LLM Judge   | 0.7               | `model`, `criteria`, `apikey`             |
| `custom`     | Custom      | 0.7               | —                                         |
| `relevance`  | Relevance   | 0.5               | `keyword_weight`, `length_weight`         |
| `grounding`  | Grounding   | 0.5               | —                                         |
| `format`     | Format      | 0.5               | `expected_format`                         |

---

## Dependency

The `cobalt` (basalt-ai-cobalt) package is **optional**. It is required for LLM-judge mode and preferred for similarity mode. When it is absent, similarity falls back to Jaccard word-overlap and the `relevance`, `grounding`, and `format` evaluators run unchanged (they are pure-Python and need no dependency).

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `apikey` | `string` | **API key**<br/>LLM provider API key for judge evaluation |  |
| `criteria` | `string` | **Evaluation criteria**<br/>Criteria prompt for the LLM judge to evaluate against |  |
| `eval_type` | `string` | **Evaluator type**<br/>The type of evaluation to perform on LLM outputs |  |
| `expected_format` | `string` | **Expected format**<br/>Structural format to validate the output against | `"prose"` |
| `keyword_weight` | `number` | **Keyword weight**<br/>Weight applied to keyword-overlap relevance scoring | `0.7` |
| `length_weight` | `number` | **Length weight**<br/>Weight applied to length-ratio relevance scoring | `0.3` |
| `model` | `string` | **Judge model**<br/>LLM model to use for judge evaluation (e.g. gpt-4, claude-3) |  |
| `profile` | `string` | **Evaluator**<br/>Cobalt evaluator profile | `"similarity"` |
| `threshold` | `number` | **Pass threshold**<br/>Minimum score (0.0 - 1.0) for an evaluation to pass | `0.7` |

## Dependencies

- `basalt-ai-cobalt` `>=0.1.0,<1.0.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/eval_cobalt)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
