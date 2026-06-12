# llm_anthropic

A RocketRide LLM node that connects Anthropic's Claude models to your pipeline.

## What it does

Connects Anthropic's Claude models to your pipeline. Used primarily as an `llm`
invoke connection by agents, vector stores, database nodes, and other nodes that
need an LLM (`classType: ["llm"]`, capability `invoke`). Can also be used directly
in a pipeline via lanes.

Built on **langchain-anthropic** (`ChatAnthropic`) with the **anthropic** SDK used
directly for save-time validation. The configured `modelOutputTokens` is passed to
the model as `max_tokens`. Token counts for budgeting are estimated at roughly
4 characters per token.

When the selected model is flagged as reasoning-capable, the node enables
extended thinking automatically and streams the model's reasoning over the
`thinking` SSE lane; see "Extended thinking" below.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                           |
| ----------- | --------- | ----------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer  |

### Fields

| Field              | Type / Default               | Description                                                                                          |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `profile`          | enum, `claude-sonnet-4-6`    | Which Claude model to use (see Profiles below)                                                       |
| `apikey`           | string                       | Anthropic API key. Must start with `sk-ant` (e.g. `sk-ant-...` or `sk-ant-api03-...`)               |
| `modelSource`      | string                       | Where the model definition comes from (`manual` or `openrouter`)                                     |
| `model`            | string (custom profile only) | Anthropic model ID, used only when `profile` is `custom`                                             |
| `modelTotalTokens` | number (custom profile only) | Total context tokens for the custom profile; must be greater than 0                                  |

The model ID and token limits for named profiles are fixed by the profile. Only the
`custom` profile exposes `model` and `modelTotalTokens` directly.

---

## Profiles

Default profile: **Claude Sonnet 4.6**.

| Profile                        | Model ID            | Context tokens     | Output tokens |
| ------------------------------ | ------------------- | ------------------ | ------------- |
| Claude Sonnet 4.6 _(default)_  | `claude-sonnet-4-6` | 1,000,000          | 128,000       |
| Claude Opus 4.7                | `claude-opus-4-7`   | 1,000,000          | 128,000       |
| Claude Opus 4.6                | `claude-opus-4-6`   | 1,000,000          | 128,000       |
| Claude Sonnet 4.5              | `claude-sonnet-4-5` | 1,000,000          | 64,000        |
| Claude Opus 4.5                | `claude-opus-4-5`   | 200,000            | 64,000        |
| Claude Haiku 4.5               | `claude-haiku-4-5`  | 200,000            | 64,000        |
| Custom                         | _(user-specified)_  | 200,000 (editable) | _(none set)_  |

---

## Extended thinking

Whether thinking is requested is driven by the model's `capabilities.reasoning`
flag in the node configuration (stamped from OpenRouter model sync). When set,
the node builds provider-correct thinking parameters based on the model name.
Routing prefixes such as `openrouter/anthropic/` are stripped before matching.

| Model                                  | Thinking parameters sent                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any Haiku model                        | None. Haiku has no extended thinking; sending parameters would return a 400.                                                                                                                                                                  |
| `claude-opus-4-7` / `claude-opus-4-8` | `thinking: {type: "adaptive", display: "summarized"}` (adaptive thinking)                                                                                                                                                                    |
| Other Claude models                    | `thinking: {type: "enabled", budget_tokens: N}` plus the `interleaved-thinking-2025-05-14` beta header, where `N` is half the output-token limit (minimum 2,048, always below `max_tokens`). Skipped entirely if the output window is too small for a valid budget. |

When thinking is actually enabled, responses are streamed through the native
Anthropic Messages API handler (`ai.common.llm_native_stream`, provider
`anthropic`) so that thinking deltas (which LangChain drops) are preserved and
forwarded on the `thinking` SSE lane. Non-reasoning models stay on the default
LangChain streaming path.

---

## Authentication

Provide an Anthropic API key in the `apikey` field. The key is validated at
startup: it must be non-empty and start with `sk-ant` (covers both standard
`sk-ant-...` and newer `sk-ant-api03-...` formats). If the key fails this check,
the node raises `Invalid Anthropic API key format, please check your API key.`
The key is read at construction time and not stored by the node.

---

## Save-time validation

When the node configuration is saved, a lightweight validation pass runs before
the first pipeline execution:

- Checks that `modelTotalTokens` (custom profile) is greater than 0.
- Sends a minimal one-token probe request (`max_tokens: 1`) to the configured
  model using the configured key.

Any failure (bad key, unknown model, rate limit, network error) is surfaced as a
concise single-line warning in the form `Error <status>: <type> - <message>`,
extracted from the API's structured error payload when available. Network or SDK
errors that carry no structured payload fall back to the raw exception message,
collapsed to a single line.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `anthropic.profile` | `string` | **Model**<br/>LLM model | `"claude-sonnet-4-6"` |
| `model` | `string` | **Model**<br/>Anthropic model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |

## Dependencies

- `langchain-anthropic`
- `anthropic`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_anthropic)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
