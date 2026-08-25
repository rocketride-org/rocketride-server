# llm_openai

A RocketRide LLM node that connects OpenAI GPT models to a pipeline.

## What it does

Provides an OpenAI-backed chat LLM for agents and other nodes that need a language model. It can also be wired directly through the `questions` and `answers` lanes. The node uses **langchain-openai** (`ChatOpenAI`) and the **openai** SDK, routing reasoning-capable models through the Responses API while other models use Chat Completions.

## Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Profiles

Default: **GPT-5.2** (`openai-5-2`).

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `openai-5-2` **(default)** | `gpt-5.2` | 400,000 | 128,000 |
| `gpt-5-6-sol` | `gpt-5.6-sol` | 1,050,000 | 128,000 |
| `gpt-5-6-terra` | `gpt-5.6-terra` | 1,050,000 | 128,000 |
| `gpt-5-6-luna` | `gpt-5.6-luna` | 1,050,000 | 128,000 |
| `gpt-5-5` | `gpt-5.5` | 1,050,000 | 128,000 |

<details>
<summary><strong>View 44 more models</strong></summary>

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `custom` | _(user-specified)_ | 16,384 | editable |
| `openai-5-4` | `gpt-5.4` | 1,050,000 | 128,000 |
| `openai-5-4-pro` | `gpt-5.4-pro` | 1,050,000 | 128,000 |
| `openai-5-4-mini` | `gpt-5.4-mini` | 400,000 | 128,000 |
| `openai-5-4-nano` | `gpt-5.4-nano` | 400,000 | 128,000 |
| `openai-4o` | `gpt-4o` | 128,000 | 16,384 |
| `openai-4o-mini` | `gpt-4o-mini` | 128,000 | 16,384 |
| `openai-5` | `gpt-5` | 400,000 | 128,000 |
| `openai-5-1` | `gpt-5.1` | 400,000 | 128,000 |
| `openai-5-mini` | `gpt-5-mini` | 400,000 | 128,000 |
| `openai-5-nano` | `gpt-5-nano` | 400,000 | 128,000 |
| `gpt-3-5-turbo` | `gpt-3.5-turbo` | 16,385 | 4,096 |
| `gpt-3-5-turbo-16k` | `gpt-3.5-turbo-16k` | 16,385 | 4,096 |
| `gpt-4` | `gpt-4` | 8,191 | 4,096 |
| `gpt-4-1` | `gpt-4.1` | 1,047,576 | 32,768 |
| `gpt-4-1-mini` | `gpt-4.1-mini` | 1,047,576 | 32,768 |
| `gpt-4-1-nano` | `gpt-4.1-nano` | 1,047,576 | 32,768 |
| `gpt-4-turbo` | `gpt-4-turbo` | 128,000 | 4,096 |
| `gpt-5-1-chat-latest` | `gpt-5.1-chat-latest` | 16,384 | 16,384 |
| `gpt-5-2-chat-latest` | `gpt-5.2-chat-latest` | 16,384 | 16,384 |
| `gpt-5-3-chat-latest` | `gpt-5.3-chat-latest` | 16,384 | 16,384 |
| `gpt-5-chat-latest` | `gpt-5-chat-latest` | 16,384 | 16,384 |
| `o1` | `o1` | 200,000 | 100,000 |
| `o3` | `o3` | 200,000 | 100,000 |
| `o3-mini` | `o3-mini` | 200,000 | 100,000 |
| `o4-mini` | `o4-mini` | 200,000 | 100,000 |
| `gpt-4-turbo-preview` | `gpt-4-turbo-preview` | 128,000 | 4,096 |
| `gpt-5-1-chat` | `gpt-5.1-chat` | 128,000 | 16,384 |
| `gpt-5-3-chat` **(deprecated)** | `gpt-5.3-chat` | 128,000 | 16,384 |
| `gpt-5-6-luna-pro` | `gpt-5.6-luna-pro` | 1,050,000 | 128,000 |
| `gpt-5-6-sol-pro` | `gpt-5.6-sol-pro` | 1,050,000 | 128,000 |
| `gpt-5-6-terra-pro` | `gpt-5.6-terra-pro` | 1,050,000 | 128,000 |
| `gpt-5-chat` | `gpt-5-chat` | 128,000 | 16,384 |
| `gpt-chat-latest` | `gpt-chat-latest` | 400,000 | 128,000 |
| `gpt-latest` | `gpt-latest` | 1,050,000 | 128,000 |
| `gpt-mini-latest` | `gpt-mini-latest` | 400,000 | 128,000 |
| `gpt-oss-120b` | `gpt-oss-120b` | 131,072 | 131,072 |
| `gpt-oss-120b-free` **(deprecated)** | `gpt-oss-120b:free` | 131,072 | 131,072 |
| `gpt-oss-20b` | `gpt-oss-20b` | 131,072 | 131,072 |
| `gpt-oss-20b-free` | `gpt-oss-20b:free` | 131,072 | 32,768 |
| `gpt-oss-safeguard-20b` | `gpt-oss-safeguard-20b` | 131,072 | 65,536 |
| `o3-mini-high` | `o3-mini-high` | 200,000 | 100,000 |
| `o3-pro` | `o3-pro` | 200,000 | 100,000 |
| `o4-mini-high` | `o4-mini-high` | 200,000 | 100,000 |

</details>

## Configuration

Choose a profile to pin the OpenAI model and token limits; most users only need to select a profile and provide an API key. Preconfigured profiles keep model details fixed, while `custom` exposes the model name and context limit for models not listed here.

### Custom models

For `custom`, enter an OpenAI model ID and a positive context limit. The initial context value is 16,384 tokens; set it to the actual model limit so the pipeline can reject oversized prompts before sending them.

## Authentication

Set `apikey` to an OpenAI API key for every profile (including `custom`). The key is
verified with a live one-word test call during pipeline validation, so a bad key or model
name is reported before the pipeline runs rather than at first invoke.

## Notes

### Reasoning streaming

For models whose configuration carries `capabilities.reasoning`, the node builds a raw
`openai` client alongside the LangChain one and streams answers via the Responses API
with `reasoning: {summary: 'auto'}`. Reasoning-summary deltas are forwarded over the
`thinking` SSE lane while the answer streams normally. Non-reasoning models use plain
LangChain streaming with `temperature: 0` and the profile's output limit.

### Validation and errors

Pipeline validation makes a small live call to verify the API key and model name. Models whose names begin with `gpt-5` are probed with `max_completion_tokens`; older models use `max_tokens`. Rate-limit and connection errors are retryable, while authentication and other API errors fail immediately with a provider-specific message.

### Testing

Automated node tests are declared in `services.json`:

- **Mock group**: runs the `openai-5-2`, `openai-5-4`, `openai-5-4-pro`, `openai-5-4-mini`,
  and `openai-5-4-nano` profiles against a mocked `langchain_openai`; no real API key needed.
  `ROCKETRIDE_MOCK` must point to `nodes/test/mocks`.
- **Real group**: skipped unless `ROCKETRIDE_OPENAI_KEY` is set; calls the live API with
  the `openai-4o-mini` profile.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `model` | `string` | **Model**<br/>OpenAI model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |
| `openai.profile` | `string` | **Model**<br/>LLM model | `"openai-5-2"` |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_openai)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
