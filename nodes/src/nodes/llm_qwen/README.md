# llm_qwen

A RocketRide LLM node that connects Alibaba Cloud Qwen models to a pipeline via the DashScope API.

## What it does

Provides Qwen chat completions to the pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM, and can also be used directly via lanes.

Uses **LangChain's `ChatOpenAI`** client pointed at DashScope's OpenAI-compatible endpoint. The regional endpoint is resolved from the `region` field at startup. Temperature is fixed at `0`, and `max_tokens` is taken from the profile's `modelOutputTokens`.

When the node configuration is validated, the node performs a live 1-token test request against the API to verify the key, model, and region actually work. Failures surface as configuration warnings with the provider's error message.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
|-------------|-----------|------------------------------------------------------|
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

The main setting is the **profile** (model selection, default `qwen-flash`). Each profile exposes the API key, region, and model-source fields. The `custom` profile additionally exposes the model name and context length.

| Field              | Type / Default      | Description                                                              |
|--------------------|---------------------|--------------------------------------------------------------------------|
| `profile`          | enum, `qwen-flash`  | Qwen AI model selection (see profiles below, or `custom`)                |
| `apikey`           | string              | DashScope API key. Must start with `sk-`.                                |
| `region`           | enum, `us`          | DashScope regional endpoint: `us`, `intl`, or `cn` (see regions below)   |
| `model`            | string              | Qwen model name (custom profile only)                                    |
| `modelTotalTokens` | number              | Maximum context length in tokens (custom profile only, must be > 0)      |

---

## Profiles

| Profile                         | Model                           | Context tokens | Output tokens |
|---------------------------------|---------------------------------|----------------|---------------|
| Qwen Flash *(default)*          | `qwen-flash`                    | 131,072        | 4,096         |
| Qwen Plus                       | `qwen-plus`                     | 1,000,000      | 32,768        |
| Qwen2.5 72B Instruct            | `qwen-2.5-72b-instruct`         | 32,768         | 16,384        |
| Qwen2.5 7B Instruct             | `qwen-2.5-7b-instruct`          | 32,768         | 32,768        |
| Qwen2.5 Coder 32B Instruct      | `qwen-2.5-coder-32b-instruct`   | 32,768         | 4,096         |
| Qwen-Max                        | `qwen-max`                      | 32,768         | 8,192         |
| Qwen Plus 0728                  | `qwen-plus-2025-07-28`          | 1,000,000      | 32,768        |
| Qwen Plus 0728 (thinking)       | `qwen-plus-2025-07-28:thinking` | 1,000,000      | 32,768        |
| Qwen-Turbo                      | `qwen-turbo`                    | 131,072        | 8,192         |

Choose `custom` to set the model name and context length manually.

---

## Regions

`region` selects the DashScope regional endpoint used for all API calls:

| Value  | Region          | Endpoint                                                  |
|--------|-----------------|-----------------------------------------------------------|
| `us`   | US (Virginia)   | `https://dashscope-us.aliyuncs.com/compatible-mode/v1`   |
| `intl` | Singapore       | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `cn`   | China (Beijing) | `https://dashscope.aliyuncs.com/compatible-mode/v1`       |

The default is `us`. An unrecognised value falls back to the US endpoint.

Note: DashScope API keys are not interchangeable between regions. A key issued for one region will fail authentication against another region's endpoint.

---

## Authentication

Provide a DashScope API key in `apikey`. The key must start with `sk-`; anything else is rejected before any request is made. Make sure the key was issued for the region you select.

---

## Error handling

Provider exceptions are mapped to friendly messages instead of raw stack traces:

- Authentication failures surface as "Invalid DashScope API key."
- Rate-limit errors surface as "Rate limit exceeded. Please try again later."
- Connection failures surface as "Failed to connect to the DashScope API."
- Other DashScope API errors surface as "An error occurred with the DashScope API."

Rate-limit and connection errors are classified as retryable by the shared chat base; authentication and generic API errors are not retried.

---

## Upstream docs

- [DashScope API reference](https://help.aliyun.com/zh/dashscope/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `model` | `string` | **Model**<br/>Qwen model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Maximum context length in tokens |  |
| `qwen.profile` | `string` | **Model**<br/>Qwen AI model selection | `"qwen-flash"` |
| `qwen.region` | `string` | **Region**<br/>DashScope regional endpoint. API keys are not interchangeable between regions. | `"us"` |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_qwen)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
