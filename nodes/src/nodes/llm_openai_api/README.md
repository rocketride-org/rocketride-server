# llm_openai_api

A RocketRide LLM node that connects any OpenAI-compatible API endpoint to a pipeline.

## What it does

Connects any OpenAI-compatible API endpoint to your pipeline. Use this node for
providers that implement the OpenAI API spec (Featherless, Together, Groq, Ollama,
LM Studio, and others) but do not have a dedicated RocketRide node. Used primarily as an
`llm` invoke connection by agents and other nodes that need an LLM, but can also be used
directly via lanes.

Built on **langchain-openai** (`ChatOpenAI`) over the official **openai** SDK. The chat
client sends `temperature: 0` for deterministic output unless the node sets another value
(see Temperature under Configuration), and `max_tokens` is set
from the shared LLM base's output-token budget (default 4096, minimum 1024). When
`base_url` is empty, the SDK falls back to the default OpenAI endpoint.

When the node configuration is saved, it validates the settings by sending a 1-token `"Hi"`
completion request to the configured endpoint (10-second timeout) and surfaces any provider
error (bad key, unknown model, unreachable URL) as a warning with the provider's status code
and message, truncated to 500 characters.

## Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

The generic endpoint has no model list: set `model` to the provider's exact model id,
then set its context limit, output limit, API key and base URL. Choose the Nebius preset
when using Token Factory; it offers a **Model** selector whose listed models pin the model
id and context limit.

The model, its token limits and the temperature are per-call parameters: a pipeline can expose them in its `parameters` map, and each call then sends its own values to the same running node, which builds its client once from the key and base URL and binds the call's values onto each request. A caller may choose the model and its limits; an LLM may not, through a tool call, though it may set the temperature.

### Generic OpenAI-compatible endpoints

Set `base_url` to the provider's OpenAI-compatible API root and `model` to its exact
model identifier. When `base_url` is empty, the OpenAI SDK uses its default endpoint.
Use a positive `modelTotalTokens` value that matches the selected model; it starts at
32,768 tokens. Leave `modelOutputTokens` empty to keep the 4,096-token default.

### Temperature

`temperature` (0 to 2, default 0) is sent with every request.

Some models run only at their own default and reject any other value: newer Claude
models (Opus 4.7 and 4.8, and the Claude 5 models), OpenAI's reasoning models such as
`o3`, and a gateway deployment in front of one, where the node only sees the deployment
name. When the endpoint answers HTTP 400 or 422 and names `temperature`, the node sends
the same request once more without a temperature. If that request goes through, the node
writes a warning and leaves the temperature out of that model's requests for the rest of
the run, so the model runs at its own default; the first request of such a run is
therefore refused once. A call that names another model still sends that model its
temperature. If the second request is refused as well, the node keeps its value and
reports that second refusal, which names what the endpoint still does not accept. This
retry does not send a request again for any other refusal.

The Nebius preset does not show the field. It sends 0 and recovers the same way.

### Nebius preset

`services.nebius.json` registers **Nebius** (`llm_nebius://`) as a branded preset of
this node. It uses the same Python implementation, and its base URL defaults to
`https://api.tokenfactory.nebius.com/v1/`. The default model is **Llama 3.3 70B
Instruct** (`meta-llama/Llama-3.3-70B-Instruct`).

#### Models

| Model | Model id | Context tokens | Output tokens |
| ----- | -------- | -------------- | ------------- |
| Llama 3.3 70B Instruct **(default)** | `meta-llama/Llama-3.3-70B-Instruct` | 131,072 | — |
| Qwen3 235B | `Qwen/Qwen3-235B-A22B` | 131,072 | — |
| DeepSeek V3 | `deepseek-ai/DeepSeek-V3` | 131,072 | — |
| Custom model | _(user-specified)_ | editable | editable |

The listed Nebius models pin no output limit, so the 4,096-token default applies.
Select **Custom model** to enter another Token Factory model id, its context limit
(131,072 tokens unless changed), and an output limit (4,096 tokens unless changed).

## Authentication

For the generic endpoint, provide the API key expected by the configured endpoint; the
key is optional there. The Nebius preset requires a key, and its schema declares the
field env-backed by `ROCKETRIDE_NEBIUS_KEY`: enter the key itself, or the placeholder
`${ROCKETRIDE_NEBIUS_KEY}` to take it from that account variable when the pipeline
runs. Defining the variable does not fill an empty field.

## Notes

### Error handling and retries

Provider errors are mapped to friendly messages and classified for retry:

| Provider exception    | Retried | Surfaced as                                     |
|-----------------------|---------|-------------------------------------------------|
| `AuthenticationError` | no      | `Invalid API key.`                              |
| Any other `APIError`  | no      | `An error occurred with the API.`               |

`RateLimitError` and `APIConnectionError` are subclasses of `APIError` in the openai
SDK, and the node checks `APIError` first, so rate-limit and connection errors are not
retried and surface as `An error occurred with the API.` Anything else falls through to
the shared LLM base's default retry and mapping logic.

### Testing

`services.json` includes a `test` block that runs model `custom` against a local test
server with a mocked `langchain_openai`, so no real API key is required.
`RR_MOCK` must point to `nodes/test/mocks`.

`nodes/test/llm_openai_api/test_openai_api_temperature.py` runs the real driver and the
real `langchain-openai` client against a local HTTP server that refuses a temperature the
way OpenAI, Anthropic and LiteLLM do, and checks the request bodies. It needs no key.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### OpenAI-Compatible API (`services.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `base_url` | `string` | **Base URL**<br/>API base URL (e.g. https://api.featherless.ai/v1) |  |
| `model` | `string` | **Model**<br/>Model name (e.g. zai-org/GLM-5, meta-llama/Llama-3-70b) |  |
| `modelOutputTokens` | `integer` | **Output Tokens**<br/>Most tokens the model may write in one reply (at least 1,024). Leave it empty to keep the node's default. Reasoning models count their thinking against this limit: set it well above the reply you expect, or they can spend it all thinking and return nothing. It cannot exceed Tokens; a larger value is lowered to it. |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |
| `openai_api.profile` | `string` | **Model**<br/>Profile selection | `"custom"` |
| `temperature` | `number` | **Temperature**<br/>Sampling temperature: 0 is generally more deterministic, higher values increase variety. Some models run only at their own default and reject any other value (newer Claude models, OpenAI's reasoning models, and gateways in front of them). The node then sends the request again without a temperature and, if that goes through, warns and leaves it out of that model's requests for the rest of the run. | `0` |

### Nebius (`services.nebius.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `base_url` | `string` | **Base URL**<br/>OpenAI-compatible base URL. Defaults to Nebius Token Factory. |  |
| `model` | `string` | **Model**<br/>Nebius Token Factory model id (e.g. meta-llama/Llama-3.3-70B-Instruct). Full list: https://tokenfactory.nebius.com/models |  |
| `modelOutputTokens` | `integer` | **Output Tokens**<br/>Most tokens the model may write in one reply (at least 1,024). Leave it empty to keep the node's default. Reasoning models count their thinking against this limit: set it well above the reply you expect, or they can spend it all thinking and return nothing. It cannot exceed Tokens; a larger value is lowered to it. |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |
| `openai_api.profile` | `string` | **Model**<br/>Nebius Token Factory model | `"llama-3-3-70b"` |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_openai_api)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
