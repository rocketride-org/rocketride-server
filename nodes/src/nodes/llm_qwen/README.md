# llm_qwen

A RocketRide LLM node that connects Alibaba Cloud Qwen models to a pipeline via the DashScope API.

## What it does

Provides Qwen chat completions to the pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM, and can also be used directly via lanes.

Uses **LangChain's `ChatOpenAI`** client pointed at DashScope's OpenAI-compatible endpoint. The endpoint is resolved at startup from the `base_url` field if set, otherwise from the `region` field. Temperature is fixed at `0`, and `max_tokens` is taken from the profile's `modelOutputTokens`.

When the node configuration is validated, the node performs a live 1-token test request against the API to verify the key, model, and region actually work. Failures surface as configuration warnings with the provider's error message.

## Lanes

| Lane in     | Lane out  | Description                                          |
|-------------|-----------|------------------------------------------------------|
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Profiles

Default: **Qwen Flash (latest)** (`qwen-flash`).

The visible `(latest)` stable aliases always resolve to DashScope's current snapshot for their tier, so they do not go stale as new generations ship — prefer these unless you need to pin a specific release, which the first four collapsed profiles do.

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `qwen-flash` **(default)** | `qwen-flash` | 131,072 | 4,096 |
| `qwen-plus` | `qwen-plus` | 1,000,000 | 32,768 |
| `qwen-max` | `qwen-max` | 32,768 | 8,192 |
| `qwen-turbo` | `qwen-turbo` | 131,072 | 8,192 |

<details>
<summary><strong>View 8 more models</strong></summary>

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `qwen3-7-max` | `qwen3.7-max` | 1,000,000 | 65,536 |
| `qwen3-7-plus` | `qwen3.7-plus` | 1,000,000 | 65,536 |
| `qwen3-6-flash` | `qwen3.6-flash` | 1,000,000 | 65,536 |
| `qwen-plus-2025-07-28` | `qwen-plus-2025-07-28` | 1,000,000 | 32,768 |
| `qwen-2-5-72b-instruct` | `qwen-2.5-72b-instruct` | 32,768 | 16,384 |
| `qwen-2-5-7b-instruct` | `qwen-2.5-7b-instruct` | 32,768 | 32,768 |
| `qwen-2-5-coder-32b-instruct` | `qwen-2.5-coder-32b-instruct` | 32,768 | 32,768 |
| `qwen-plus-2025-07-28-thinking` | `qwen-plus-2025-07-28:thinking` | 1,000,000 | 32,768 |

</details>

The last four collapsed profiles are **deprecated**: they remain selectable so saved pipelines keep loading, but DashScope rejects their model IDs. They were introduced by OpenRouter fallback discovery in the model sync and carry OpenRouter/HuggingFace IDs rather than DashScope ones (e.g. DashScope uses `qwen2.5-72b-instruct`, not `qwen-2.5-72b-instruct`, and has no `:thinking` model variants — reasoning is controlled with the `enable_thinking` request parameter instead). Migrate to a live profile above.

## Configuration

Choose a profile to set the Qwen model and token limits, then select the DashScope region that issued your API key. Profiles keep the model and token values fixed while exposing the API key, region, and model-source settings.

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

Setting `base_url` overrides this table entirely, which is how you reach a DashScope host Alibaba Cloud serves outside the three above — another Alibaba Cloud region, for instance. It is available on every live profile, including `custom`; the deprecated profiles above do not expose it. Leave it empty to use the regional endpoint.

### Error handling

Provider exceptions are mapped to friendly messages instead of raw stack traces:

- Authentication failures surface as "Invalid DashScope API key."
- Rate-limit errors surface as "Rate limit exceeded. Please try again later."
- Connection failures surface as "Failed to connect to the DashScope API."
- Other DashScope API errors surface as "An error occurred with the DashScope API."

Rate-limit and connection errors are classified as retryable by the shared chat base; authentication and generic API errors are not retried.

### Keeping the model list current

Profiles are maintained by the model sync tool, see [tools/sync_models](https://github.com/rocketride-org/rocketride-server/tree/develop/tools/sync_models):

```bash
python tools/sync_models/src/sync_models.py --provider llm_qwen --enable-discovery --apply
```

Discovery — adding profiles — requires `ROCKETRIDE_QWEN_KEY`. Without it the command above still runs, but only enriches profiles that already exist: OpenRouter and LiteLLM can supply token counts, and neither may add a profile unless you also pass `--allow-fallback-discovery`. Avoid that flag here — it lets OpenRouter contribute the HuggingFace-style IDs DashScope does not accept, which is what the deprecated profiles above are. The stable aliases are listed in `protected_profiles` so a non-authoritative source cannot deprecate them.

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
