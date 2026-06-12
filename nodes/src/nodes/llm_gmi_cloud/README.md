# llm_gmi_cloud

A RocketRide LLM node that connects GMI Cloud-hosted models to a pipeline through GMI Cloud's OpenAI-compatible API.

## What it does

Connects GMI Cloud-hosted models to your pipeline via an OpenAI-compatible API. GMI Cloud
runs 100+ open-weight and proxied proprietary models on H100/H200 infrastructure. Used
primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can
also be used directly via lanes.

Built on **langchain-openai's `ChatOpenAI`** client pointed at the GMI Cloud endpoint,
with `temperature` fixed at `0`. Rate-limit and connection errors are treated as
retryable; authentication and other API errors are mapped to friendly messages
(e.g. `Invalid API key.`).

Two safety behaviors are enforced on the endpoint URL: it must use **HTTPS**, and the
hostname must be `gmi-serving.com` or a subdomain of it (an SSRF guard on user-supplied
endpoints). This is checked both at save time and when the pipeline starts. An API key is
required at pipeline start; the shared endpoint `https://api.gmi-serving.com/v1` is used
when no endpoint URL is configured.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

| Field | Type | Description |
|---|---|---|
| `model` | string | GMI Cloud model identifier. Use org/model-name for open-weight models (e.g. deepseek-ai/DeepSeek-R1, Qwen/Qwen3-32B-FP8) or provider/model-name for proxied models (e.g. openai/gpt-4o, anthropic/claude-sonnet-4.5, google/gemini-3-flash-preview). Full list: https://www.gmicloud.ai/models |
| `modelTotalTokens` | number | Total Tokens |
| `serverbase` | string | Your GMI Cloud deployment endpoint URL. Deploy the model at console.gmicloud.ai, then paste the provided endpoint URL here. |
| `profile` | string | Default "deepseek-v3". GMI Cloud LLM model |

The **custom** profile additionally exposes the raw model fields:

| Field              | Type/Default                                     | Description                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`            | string                                           | GMI Cloud model identifier: `org/model-name` for open-weight models (e.g. `deepseek-ai/DeepSeek-R1`) or `provider/model-name` for proxied models (e.g. `openai/gpt-4o`). Full list: https://www.gmicloud.ai/models |
| `modelTotalTokens` | number, default `16384`                          | Total token (context) limit for the model                                                                                                                                                                              |
| `serverbase`       | string, default `https://api.gmi-serving.com/v1` | Endpoint URL                                                                                                                                                                                                            |

---

## Model tiers

GMI Cloud has three tiers:

**Shared (always-on)**, available immediately at the shared endpoint, API key only:

| Profile                 | Model                                  | Context |
| ----------------------- | -------------------------------------- | ------- |
| DeepSeek V3 _(default)_ | `deepseek-ai/DeepSeek-V3-0324`         | 163,840 |
| DeepSeek V3.2           | `deepseek-ai/DeepSeek-V3.2`            | 163,840 |
| DeepSeek R1             | `deepseek-ai/DeepSeek-R1`              | 131,072 |
| DeepSeek Prover V2      | `deepseek-ai/DeepSeek-Prover-V2-671B`  | 131,072 |
| GPT-5.2                 | `openai/gpt-5.2`                       | 128,000 |
| GPT-5.1                 | `openai/gpt-5.1`                       | 128,000 |
| GPT-5                   | `openai/gpt-5`                         | 128,000 |
| GPT-4o                  | `openai/gpt-4o`                        | 128,000 |
| Claude Opus 4.5         | `anthropic/claude-opus-4.5`            | 200,000 |
| Claude Sonnet 4.5       | `anthropic/claude-sonnet-4.5`          | 200,000 |
| Gemini 3.1 Pro          | `google/gemini-3.1-pro-preview`        | 128,000 |
| Gemini 3 Flash          | `google/gemini-3-flash-preview`        | 128,000 |
| Gemini 3.1 Flash Lite   | `google/gemini-3.1-flash-lite-preview` | 128,000 |

**Deploy-on-demand**: deploy first at [console.gmicloud.ai](https://console.gmicloud.ai), then paste the provided endpoint URL into the **Endpoint URL** field:

| Profile                  | Model                                               | Context   |
| ------------------------ | --------------------------------------------------- | --------- |
| Llama 4 Scout            | `meta-llama/Llama-4-Scout-17B-16E-Instruct`         | 1,048,576 |
| Llama 4 Maverick         | `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 1,048,576 |
| Qwen3 235B               | `Qwen/Qwen3-235B-A22B-FP8`                          | 131,072   |
| Qwen3 32B                | `Qwen/Qwen3-32B-FP8`                                | 131,072   |
| Qwen3 30B                | `Qwen/Qwen3-30B-A3B`                                | 131,072   |
| Qwen3 Coder 480B         | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8`           | 131,072   |
| DeepSeek R1 Distill 32B  | `deepseek-ai/DeepSeek-R1-Distill-Qwen-32B`          | 131,072   |
| DeepSeek R1 Distill 1.5B | `deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B`         | 131,072   |

**Custom**: specify any GMI Cloud model ID, token limit, and endpoint URL directly.

---

## Save-time validation

When the node configuration is saved, it is validated against the live API:

- Validation is skipped when the model or API key is not set yet, or (for
  deploy-on-demand profiles) when the endpoint URL has not been entered yet.
- The endpoint URL is checked for HTTPS and the `gmi-serving.com` domain.
- If the model name looks like a vision/multimodal model (contains `vl`, `vision`,
  `visual`, or `multimodal`), a warning is raised suggesting a vision node instead, and
  the API probe is skipped, since vision models may reject text-only requests.
- Otherwise a 1-token chat request probes the API to confirm both the API key and the
  model's existence. An HTTP 429 (rate limit) during the probe means the key was accepted
  and is treated as valid. Other API errors surface as warnings with the HTTP status,
  provider error type, and message.

---

## Authentication

Provide your GMI Cloud API key in the **API Key** field. For shared-tier models that is
all that is required. For deploy-on-demand models (Llama, Qwen, the R1 Distills), deploy
the model in the [GMI Cloud console](https://console.gmicloud.ai) first, then paste the
unique endpoint URL it gives you into the **Endpoint URL** field.

---

## Upstream docs

- [GMI Cloud model catalogue](https://www.gmicloud.ai/models)
- [GMI Cloud console](https://console.gmicloud.ai)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `gmi_cloud.profile` | `string` | **Model**<br/>GMI Cloud LLM model | `"deepseek-v3"` |
| `gmi_cloud.serverbase` | `string` | **Endpoint URL**<br/>Your GMI Cloud deployment endpoint URL. Deploy the model at console.gmicloud.ai, then paste the provided endpoint URL here. |  |
| `model` | `string` | **Model**<br/>GMI Cloud model identifier. Use org/model-name for open-weight models (e.g. deepseek-ai/DeepSeek-R1, Qwen/Qwen3-32B-FP8) or provider/model-name for proxied models (e.g. openai/gpt-4o, anthropic/claude-sonnet-4.5, google/gemini-3-flash-preview). Full list: https://www.gmicloud.ai/models |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_gmi_cloud)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
