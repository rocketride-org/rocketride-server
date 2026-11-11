# llm_qwen

A RocketRide LLM node that connects Alibaba Cloud Qwen models to a pipeline via the DashScope API.

## What it does

Provides Qwen chat completions to the pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM, and can also be used directly via lanes.

Uses **LangChain's `ChatOpenAI`** client pointed at DashScope's OpenAI-compatible endpoint. The endpoint is resolved at startup from the `base_url` field if set, otherwise from the `region` field. Temperature is fixed at `0`, and `max_tokens` is taken from the selected model's output token limit (`modelOutputTokens`).

When the node configuration is validated, the node performs a live 1-token test request against the API to verify the key, model, and region actually work. Failures surface as configuration warnings with the provider's error message.

## Lanes

| Lane in     | Lane out  | Description                                          |
|-------------|-----------|------------------------------------------------------|
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

Choose a model from the **Model** selector to set the Qwen model id and token limits,
then select the DashScope region that issued your API key. Each listed model keeps its
model id and token values fixed, while the API key, region, and base URL override apply
to every model. The default is **Qwen Flash (latest)** (`qwen-flash`).

### Models

The `(latest)` stable aliases always resolve to DashScope's current snapshot for their tier, so they do not go stale as new generations ship — prefer these unless you need to pin a specific release.

| Model | Model id | Context tokens | Output tokens |
| ----- | -------- | -------------- | ------------- |
| Qwen Flash (latest) **(default)** | `qwen-flash` | 131,072 | 4,096 |
| Qwen3.7 Max | `qwen3.7-max` | 1,000,000 | 131,072 |
| Qwen3.7 Plus | `qwen3.7-plus` | 1,000,000 | 131,072 |
| Qwen3.6 Flash | `qwen3.6-flash` | 1,000,000 | 65,536 |
| Qwen Max (latest) | `qwen-max` | 32,768 | 8,192 |
| Qwen Plus (latest) | `qwen-plus` | 1,000,000 | 32,768 |
| Qwen Turbo (latest) | `qwen-turbo` | 131,072 | 8,192 |
| Qwen Plus 0728 | `qwen-plus-2025-07-28` | 1,000,000 | 32,768 |
| Qwen: Qwen3 14B | `qwen3-14b` | 131,072 | 16,384 |
| Qwen: Qwen3 235B A22B | `qwen3-235b-a22b` | 131,072 | 8,192 |
| Qwen: Qwen3 235B A22B Instruct 2507 | `qwen3-235b-a22b-2507` | 262,144 | 16,384 |
| Qwen: Qwen3 235B A22B Thinking 2507 | `qwen3-235b-a22b-thinking-2507` | 131,072 | 117,964 |
| Qwen: Qwen3 30B A3B | `qwen3-30b-a3b` | 131,072 | 16,384 |
| Qwen: Qwen3 30B A3B Instruct 2507 | `qwen3-30b-a3b-instruct-2507` | 262,144 | 32,000 |
| Qwen: Qwen3 30B A3B Thinking 2507 | `qwen3-30b-a3b-thinking-2507` | 81,920 | 32,768 |
| Qwen: Qwen3 32B | `qwen3-32b` | 131,072 | 16,384 |
| Qwen: Qwen3.5-122B-A10B | `qwen3.5-122b-a10b` | 262,144 | 81,920 |
| Qwen: Qwen3.5-27B | `qwen3.5-27b` | 262,144 | 65,536 |
| Qwen: Qwen3.5-35B-A3B | `qwen3.5-35b-a3b` | 262,144 | 16,384 |
| Qwen: Qwen3.5 397B A17B | `qwen3.5-397b-a17b` | 262,144 | 65,536 |
| Qwen: Qwen3.5-9B | `qwen3.5-9b` | 262,144 | 235,929 |
| Qwen: Qwen3.5-Flash | `qwen3.5-flash-02-23` | 1,000,000 | 65,536 |
| Qwen: Qwen3.5 Plus 2026-02-15 | `qwen3.5-plus-02-15` | 1,000,000 | 65,536 |
| Qwen: Qwen3.5 Plus 2026-04-20 | `qwen3.5-plus-20260420` | 1,000,000 | 65,536 |
| Qwen: Qwen3.6 27B | `qwen3.6-27b` | 262,144 | 65,536 |
| Qwen: Qwen3.6 35B A3B | `qwen3.6-35b-a3b` | 262,144 | 235,929 |
| Qwen: Qwen3.6 Max Preview | `qwen3.6-max-preview` | 262,144 | 65,536 |
| Qwen: Qwen3.6 Plus | `qwen3.6-plus` | 1,000,000 | 65,536 |
| Qwen: Qwen3.7 Flash | `qwen3.7-flash` | 1,000,000 | 65,536 |
| Qwen: Qwen3.8 2.4T A95B | `qwen3.8-2.4t-a95b` | 1,048,576 | 262,144 |
| Qwen: Qwen3.8 27B | `qwen3.8-27b` | 1,000,000 | 131,072 |
| Qwen: Qwen3.8 Flash | `qwen3.8-flash` | 1,000,000 | 131,072 |
| Qwen: Qwen3.8 Max (0902) | `qwen3.8-max-0902` | 1,000,000 | 131,072 |
| Qwen: Qwen3 8B | `qwen3-8b` | 131,072 | 8,192 |
| Qwen: Qwen3 Coder 480B A35B | `qwen3-coder` | 262,144 | 65,536 |
| Qwen: Qwen3 Coder 30B A3B Instruct | `qwen3-coder-30b-a3b-instruct` | 262,144 | 235,929 |
| Qwen: Qwen3 Coder Flash | `qwen3-coder-flash` | 1,000,000 | 65,536 |
| Qwen: Qwen3 Coder Next | `qwen3-coder-next` | 262,144 | 235,929 |
| Qwen: Qwen3 Coder Plus | `qwen3-coder-plus` | 1,000,000 | 65,536 |
| Qwen: Qwen3 Max | `qwen3-max` | 262,144 | 65,536 |
| Qwen: Qwen3 Max Thinking | `qwen3-max-thinking` | 262,144 | 65,536 |
| Qwen: Qwen3 Next 80B A3B Instruct | `qwen3-next-80b-a3b-instruct` | 262,144 | 235,929 |
| Qwen: Qwen3 Next 80B A3B Thinking | `qwen3-next-80b-a3b-thinking` | 262,144 | 235,929 |
| Custom model | _(user-specified)_ | editable | editable |

### Custom model

Select **Custom model** to enter a DashScope model id exactly as DashScope names it
(for example `qwen2.5-72b-instruct`), its total context length in tokens, and its
output token limit (at least 1,024). The custom defaults are 131,072 total tokens and
4,096 output tokens; set both to the actual limits of the model you select.

## Authentication

Provide a DashScope API key in `apikey`. The key must start with `sk-`; anything else is rejected before any request is made. Make sure the key was issued for the region you select.

## Notes

### Regions

`region` selects the DashScope regional endpoint used for all API calls:

| Value  | Region          | Endpoint                                                  |
|--------|-----------------|-----------------------------------------------------------|
| `us`   | US (Virginia)   | `https://dashscope-us.aliyuncs.com/compatible-mode/v1`   |
| `intl` | Singapore       | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `cn`   | China (Beijing) | `https://dashscope.aliyuncs.com/compatible-mode/v1`       |

The default is `us`. An unrecognised value falls back to the US endpoint. DashScope API keys are region-specific, so a key issued for one endpoint will fail against another.

Setting `base_url` overrides this table entirely, which is how you reach a DashScope host Alibaba Cloud serves outside the three above — another Alibaba Cloud region, for instance. It applies to every model, including **Custom model**. Leave it empty to use the regional endpoint.

### Error handling

Provider exceptions are mapped to friendly messages instead of raw stack traces:

- Authentication failures surface as "Invalid DashScope API key."
- Every other DashScope API error surfaces as "An error occurred with the DashScope API."
  This includes rate-limit and connection errors: the OpenAI SDK's `RateLimitError` and
  `APIConnectionError` are subclasses of `APIError`, which the node checks first, so
  their dedicated messages ("Rate limit exceeded. Please try again later." and "Failed
  to connect to the DashScope API.") are never reached.

For the same reason no DashScope API error is retried by the shared chat base. The
provider's raw message is still reported as a warning before it is mapped.

---

## Upstream docs

- [DashScope API reference](https://help.aliyun.com/zh/dashscope/)
- [Alibaba Cloud Model Studio models](https://www.alibabacloud.com/help/en/model-studio/models)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `model` | `string` | **Model**<br/>Qwen model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Maximum context length in tokens |  |
| `qwen.base_url` | `string` | **Base URL override**<br/>Optional. Overrides the endpoint selected by Region. Leave empty to use the regional endpoint. Set this to reach a DashScope host other than the three listed above, for example another Alibaba Cloud region. | `""` |
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
