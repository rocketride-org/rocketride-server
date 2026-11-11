# llm_openai

A RocketRide LLM node that connects OpenAI GPT models to a pipeline.

## What it does

Provides an OpenAI-backed chat LLM for agents and other nodes that need a language model. It can also be wired directly through the `questions` and `answers` lanes. The node uses **langchain-openai** (`ChatOpenAI`) and the **openai** SDK, routing reasoning-capable models through the Responses API while other models use Chat Completions.

## Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

Choose a model from the **Model** selector to pin the OpenAI model id and token limits;
most users only need to select a model and provide an API key. The default is
**GPT-5.2** (`gpt-5.2`). Listed models keep their details fixed, while **Custom model**
exposes the model id, context limit and output limit for models not listed here.

### Models

| Model | Model id | Context tokens | Output tokens |
| ----- | -------- | -------------- | ------------- |
| GPT-5.2 **(default)** | `gpt-5.2` | 400,000 | 128,000 |
| GPT-5.4 | `gpt-5.4` | 1,050,000 | 128,000 |
| GPT-5.4 Pro | `gpt-5.4-pro` | 1,050,000 | 128,000 |
| GPT-5.4-mini | `gpt-5.4-mini` | 400,000 | 128,000 |
| GPT-5.4-nano | `gpt-5.4-nano` | 400,000 | 128,000 |
| GPT-4o | `gpt-4o` | 128,000 | 16,384 |
| GPT-4o-mini | `gpt-4o-mini` | 128,000 | 16,384 |
| GPT-5 | `gpt-5` | 400,000 | 128,000 |
| GPT-5.1 | `gpt-5.1` | 400,000 | 128,000 |
| GPT-5-mini | `gpt-5-mini` | 400,000 | 128,000 |
| GPT-5-nano | `gpt-5-nano` | 400,000 | 128,000 |
| OpenAI: GPT-3.5 Turbo | `gpt-3.5-turbo` | 16,385 | 4,096 |
| OpenAI: GPT-3.5 Turbo 16k | `gpt-3.5-turbo-16k` | 16,385 | 4,096 |
| OpenAI: GPT-4 | `gpt-4` | 8,191 | 4,096 |
| OpenAI: GPT-4.1 | `gpt-4.1` | 1,047,576 | 32,768 |
| OpenAI: GPT-4.1 Mini | `gpt-4.1-mini` | 1,047,576 | 32,768 |
| OpenAI: GPT-4.1 Nano | `gpt-4.1-nano` | 1,047,576 | 32,768 |
| OpenAI: GPT-4 Turbo | `gpt-4-turbo` | 128,000 | 4,096 |
| GPT-5.1 Chat Latest | `gpt-5.1-chat-latest` | 128,000 | 16,384 |
| GPT-5.2 Chat Latest | `gpt-5.2-chat-latest` | 128,000 | 16,384 |
| GPT-5.3 Chat Latest | `gpt-5.3-chat-latest` | 128,000 | 16,384 |
| GPT-5 Chat Latest | `gpt-5-chat-latest` | 128,000 | 16,384 |
| OpenAI: o1 | `o1` | 200,000 | 100,000 |
| OpenAI: o3 | `o3` | 200,000 | 100,000 |
| OpenAI: o3 Mini | `o3-mini` | 200,000 | 100,000 |
| OpenAI: o4 Mini | `o4-mini` | 200,000 | 100,000 |
| OpenAI: GPT-5.5 | `gpt-5.5` | 1,050,000 | 128,000 |
| OpenAI: GPT-4 Turbo Preview | `gpt-4-turbo-preview` | 128,000 | 4,096 |
| OpenAI: GPT-5.6 Luna | `gpt-5.6-luna` | 1,050,000 | 128,000 |
| OpenAI: GPT-5.6 Luna Pro | `gpt-5.6-luna-pro` | 1,050,000 | 128,000 |
| OpenAI: GPT-5.6 Sol | `gpt-5.6-sol` | 1,050,000 | 128,000 |
| OpenAI: GPT-5.6 Sol Pro | `gpt-5.6-sol-pro` | 1,050,000 | 128,000 |
| OpenAI: GPT-5.6 Terra | `gpt-5.6-terra` | 1,050,000 | 128,000 |
| OpenAI: GPT-5.6 Terra Pro | `gpt-5.6-terra-pro` | 1,050,000 | 128,000 |
| OpenAI: GPT Chat Latest | `gpt-chat-latest` | 400,000 | 128,000 |
| OpenAI GPT Latest | `gpt-latest` | 1,050,000 | 128,000 |
| OpenAI GPT Mini Latest | `gpt-mini-latest` | 400,000 | 128,000 |
| OpenAI: gpt-oss-120b | `gpt-oss-120b` | 131,072 | 117,964 |
| OpenAI: gpt-oss-20b | `gpt-oss-20b` | 131,072 | 117,964 |
| OpenAI: gpt-oss-safeguard-20b | `gpt-oss-safeguard-20b` | 131,072 | 65,536 |
| OpenAI: o3 Mini High | `o3-mini-high` | 200,000 | 100,000 |
| OpenAI: o3 Pro | `o3-pro` | 200,000 | 100,000 |
| OpenAI: o4 Mini High | `o4-mini-high` | 200,000 | 100,000 |
| OpenAI: GPT-5.2 Chat | `gpt-5.2-chat` | 128,000 | 32,000 |
| OpenAI: GPT-6 Astra | `gpt-6-astra` | 1,050,000 | 128,000 |
| OpenAI: GPT-6 Astra Pro | `gpt-6-astra-pro` | 1,050,000 | 128,000 |
| Custom model | _(user-specified)_ | editable | editable |

### Custom models

For **Custom model**, enter an OpenAI model id and a positive context limit. The initial context value is 16,384 tokens; set it to the actual model limit so the pipeline can reject oversized prompts before sending them. The output limit (`modelOutputTokens`) defaults to 128,000 tokens and cannot exceed the context limit, so a larger value is lowered to it; set it to your model's limit, keeping in mind that reasoning models count their thinking against it.

## Authentication

Set `apikey` to an OpenAI API key for every model (including **Custom model**). The key is
verified with a live one-word test call during pipeline validation, so a bad key or model
name is reported before the pipeline runs rather than at first invoke.

## Notes

### Reasoning streaming

For models whose selector entry pins `reasoning`, the node builds a raw
`openai` client alongside the LangChain one and streams answers via the Responses API
with `reasoning: {summary: 'auto'}`. Reasoning-summary deltas are forwarded over the
`thinking` SSE lane while the answer streams normally. Non-reasoning models use plain
LangChain streaming with the model's output limit. `temperature` is configurable on
every model (range `0`-`2`, default `0`, which is generally more deterministic than
higher values, though OpenAI does not guarantee identical output for identical input);
reasoning models ignore it, because OpenAI's Responses API controls sampling separately.

### Validation and errors

Pipeline validation makes a small live call to verify the API key and model name. Models whose names begin with `gpt-5` are probed with `max_completion_tokens`; older models use `max_tokens`. Authentication errors fail immediately with `Invalid API key.`, and every other openai API error fails immediately with `An error occurred with the OpenAI API.` That includes rate-limit and connection errors: `RateLimitError` and `APIConnectionError` are subclasses of `APIError` in the openai SDK, and the node checks `APIError` first, so neither is retried.

### Testing

Automated node tests are declared in `services.json`:

- **Mock group**: runs the `gpt-5.2`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, and
  `gpt-5.4-nano` models against a mocked `langchain_openai`; no real API key needed.
  `ROCKETRIDE_MOCK` must point to `nodes/test/mocks`.
- **Real group**: skipped unless `ROCKETRIDE_OPENAI_KEY` is set; calls the live API with
  the `gpt-4o-mini` model.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `model` | `string` | **Model**<br/>OpenAI model |  |
| `modelOutputTokens` | `integer` | **Output Tokens**<br/>Most tokens the model may write in one reply (at least 1,024). Leave it empty to keep the node's default. Reasoning models count their thinking against this limit: set it well above the reply you expect, or they can spend it all thinking and return nothing. It cannot exceed Tokens; a larger value is lowered to it. |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |
| `openai.profile` | `string` | **Model**<br/>LLM model | `"openai-5-2"` |
| `temperature` | `number` | **Temperature**<br/>Sampling temperature for non-reasoning models: 0 is generally more deterministic, higher values increase variety. Ignored for reasoning models (o1, o3, GPT-5 reasoning variants, ...), which OpenAI's Responses API controls separately. | `0` |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_openai)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
