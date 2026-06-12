# llm_mistral

A RocketRide LLM node that connects Mistral AI's chat models to a pipeline.

## What it does

Connects Mistral AI models to your pipeline. Used primarily as an `llm` invoke connection
by agents and other nodes that need an LLM. Can also be used directly via lanes.

Uses the official **`mistralai`** Python SDK (both the 1.x and 2.x import layouts are
supported) and calls the `chat.complete` endpoint. Requests are sent with
`temperature: 0.0` for deterministic responses and no `max_tokens` cap, so the model
decides output length.

Prompts are validated against the model's context window before sending. Token counts are
estimated heuristically (about 1.25 tokens per word, adjusted for punctuation and long
words); no tokenizer round-trip is made. The context limit comes from the selected
profile's `modelTotalTokens`; if not configured, a built-in per-model default is used,
falling back to 32,768 tokens for unknown models.

Failed API calls are retried automatically with exponential backoff (see
[Retries and error handling](#retries-and-error-handling)), and raw provider errors are
rewritten into user-friendly messages.

When you save the node configuration, a minimal validation probe (a one-token `"Hi"`
completion) is sent to verify the API key and model before the pipeline ever runs.
Validation failures surface as warnings with the provider's error detail.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

The node is configured through a single profile selector plus per-profile fields:

| Field              | Type / Default               | Description                                            |
| ------------------ | ----------------------------- | ------------------------------------------------------ |
| `profile`          | string, default `mistral-large` | Which Mistral model preset to use (see profiles below) |
| `apikey`           | string                        | Mistral AI API key (required for every profile)        |
| `modelSource`      | shared `llm.cloud` field      | Model source selector                                  |
| `model`            | string (custom profile only)  | Mistral AI model ID                                    |
| `modelTotalTokens` | number, default `32768` (custom) | Maximum context length in tokens                    |

`model` and `modelTotalTokens` are only editable in the **Custom Model** profile; every
other profile pins them to the values shown in the profiles table below. An explicitly
configured `modelTotalTokens` always overrides the built-in per-model default.

---

## Profiles

Default profile: **Mistral Large 3** (`mistral-large`).

### Flagship

| Profile                     | Model                 | Context |
| --------------------------- | --------------------- | ------- |
| Mistral Large 3 (default)   | `mistral-large-2512`  | 262,144 |
| Mistral Medium 3.1          | `mistral-medium-2508` | 131,072 |
| Mistral Small 3.2           | `mistral-small-2506`  | 131,072 |

### Reasoning

| Profile              | Model                   | Context |
| -------------------- | ----------------------- | ------- |
| Magistral Medium 1.2 | `magistral-medium-2509` | 40,000  |
| Magistral Small 1.2  | `magistral-small-2509`  | 40,960  |

### Code

| Profile             | Model                  | Context |
| ------------------- | ---------------------- | ------- |
| Codestral           | `codestral-2508`       | 256,000 |
| Devstral Medium 1.0 | `devstral-medium-2507` | 128,000 |
| Devstral Small 1.1  | `devstral-small-2507`  | 128,000 |

### Edge

| Profile         | Model                | Context |
| --------------- | -------------------- | ------- |
| Ministral 3 14B | `ministral-14b-2512` | 262,144 |
| Ministral 3 8B  | `ministral-8b-2512`  | 262,144 |
| Ministral 3 3B  | `ministral-3b-2512`  | 131,072 |

**Custom**: specify any Mistral model ID and token limit directly.

### Additional profiles

Beyond the curated set, the node ships presets for dated snapshots, `-latest` aliases, and
specialty models:

| Profile                       | Model                         | Context |
| ----------------------------- | ----------------------------- | ------- |
| `codestral-latest`            | `codestral-latest`            | 8,191   |
| `devstral-2512`               | `devstral-2512`               | 262,144 |
| `devstral-latest`             | `devstral-latest`             | 256,000 |
| `devstral-medium-latest`      | `devstral-medium-latest`      | 256,000 |
| `magistral-medium-latest`     | `magistral-medium-latest`     | 40,000  |
| `magistral-small-latest`      | `magistral-small-latest`      | 40,000  |
| `ministral-14b-latest`        | `ministral-14b-latest`        | 16,384  |
| `ministral-8b-latest`         | `ministral-8b-latest`         | 16,384  |
| `ministral-3b-latest`         | `ministral-3b-latest`         | 16,384  |
| `mistral-large-2411`          | `mistral-large-2411`          | 131,072 |
| `mistral-large-latest`        | `mistral-large-latest`        | 32,000  |
| `mistral-medium-2505`         | `mistral-medium-2505`         | 8,191   |
| `mistral-medium-2604`         | `mistral-medium-2604`         | 16,384  |
| `mistral-medium-3`            | `mistral-medium-3`            | 131,072 |
| `mistral-medium-3-5`          | `mistral-medium-3-5`          | 16,384  |
| `mistral-medium-c21211-r0-75` | `mistral-medium-c21211-r0-75` | 16,384  |
| `mistral-medium-latest`       | `mistral-medium-latest`       | 131,072 |
| `mistral-small-2603`          | `mistral-small-2603`          | 262,144 |
| `mistral-small-latest`        | `mistral-small-latest`        | 131,072 |
| `mistral-tiny-2407`           | `mistral-tiny-2407`           | 16,384  |
| `mistral-tiny-latest`         | `mistral-tiny-latest`         | 16,384  |
| `mistral-vibe-cli-fast`       | `mistral-vibe-cli-fast`       | 16,384  |
| `mistral-vibe-cli-latest`     | `mistral-vibe-cli-latest`     | 16,384  |
| `mistral-vibe-cli-with-tools` | `mistral-vibe-cli-with-tools` | 16,384  |

---

## Retries and error handling

Transient failures (timeouts, network errors, rate limits, HTTP 5xx) are retried with
exponential backoff. Retry budget scales with the model tier:

| Model tier                      | Retries | Base delay |
| ------------------------------- | ------- | ---------- |
| `large` models                  | 3       | 2.0 s      |
| `medium` / `magistral` models   | 2       | 1.5 s      |
| All other (small / edge) models | 2       | 1.0 s      |

Non-retryable errors fail immediately. Whatever the cause, the raw API error is mapped to
a user-friendly message: authentication failures, rate limits, quota/billing issues,
invalid input, model unavailability, server errors, content-policy violations, timeouts,
and network problems each get a specific explanation instead of a stack trace.

---

## Authentication

Provide a Mistral AI API key in the `apikey` field (created in the
[Mistral AI console](https://console.mistral.ai/)). The key is read at startup and never
persisted by the node.

The node detects common key mix-ups at initialization and fails with a specific message:

- Keys starting with `sk-` are rejected as OpenAI keys.
- Keys starting with `AI` are rejected as Google AI / Gemini keys.

---

## Upstream docs

- [Mistral AI documentation](https://docs.mistral.ai/)
- [Mistral AI console](https://console.mistral.ai/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `mistral.profile` | `string` | **Model**<br/>Mistral AI model selection | `"mistral-large"` |
| `model` | `string` | **Model**<br/>Mistral AI model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Maximum context length in tokens |  |

## Dependencies

- `mistralai`
- `mistral-common[sentencepiece]`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_mistral)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
